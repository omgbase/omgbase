import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./core/store/store.js";
import { ensureRepo } from "./core/attach.js";
import { observeFile } from "./sync/observe.js";
import { apply } from "./mutate/apply.js";
import { recoverRepo } from "./sync/recovery.js";
import { listPending, materializePending } from "./mutate/materialize.js";
import { FsDocStore } from "./mutate/doc-store.js";
import { listActiveAlerts, MATERIALIZATION_FAILED_ALERT } from "./core/store/alerts.js";
import { CAPTURE_FAILED_ALERT } from "./core/store/manifest.js";
import { CaptureFailed } from "./core/capabilities/errors.js";
import { FAULT_ENV, FAULT_SITES, InjectedFault, armedFault, faultPasses, resetFaults } from "./core/fault.js";

// Fault injection outside the fixture runners (modular-core Phase 5a; the plan's
// §8 acceptance matrix — recovery, optional history). `OMGBASE_FAULT=<site>[:<nth>]`
// arms one of the five named sites (`core/fault.ts`; spec/store §9.7); a write is
// driven through each and the matrix outcome asserted: ROLLED BACK (nothing
// minted, the request fails, a retry lands), RECOVERABLE (the rows are durable,
// the file is owed, `recoverRepo` replays it and is then a no-op), ALERT RAISED
// (`capture_failed`, `materialization_failed`), RETRIED (the next pass clears).
// Every site is spelled identically by the Rust twin.

const ORIGIN = { actor: "agent:fault-test" };

let root: string;
let store: Store;
let repoId: string;
let bodyId: string;
const count = (table: string): number => (store.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
const raw = (): string => (store.db.prepare("SELECT raw FROM blocks WHERE block_id = ?").get(bodyId) as { raw: string }).raw;
const alerts = (): string[] => listActiveAlerts(store.db, repoId).map((a) => a.code);
const arm = (spec: string): void => { process.env[FAULT_ENV] = spec; resetFaults(); };
const disarm = (): void => { delete process.env[FAULT_ENV]; resetFaults(); };
const hashOf = (): string => (store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ?").get(bodyId) as { h: string }).h;
const edit = (markdown: string) => apply(store, { repoId, rootPath: root, ops: [{ op: "update", block: bodyId, markdown, expect: { content_hash: hashOf() } }], origin: ORIGIN });
const NO_RECORDER = (() => { const s = new Store({ path: ":memory:" }); const none = s.capabilities.history === null; s.close(); return none; })();

beforeEach(() => {
  disarm();
  root = mkdtempSync(join(tmpdir(), "omgbase-fault-"));
  store = new Store({ path: join(root, ".omgbase", "omgbase.db") });
  repoId = ensureRepo(store, "fx", root);
  writeFileSync(join(root, "a.md"), "# A\n\nBody.\n");
  observeFile(store, repoId, "a.md", "# A\n\nBody.\n");
  bodyId = (store.db.prepare("SELECT block_id FROM blocks WHERE type = 'paragraph'").get() as { block_id: string }).block_id;
});
afterEach(() => {
  disarm();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the hook (OMGBASE_FAULT)", () => {
  it("parses <site>[:<nth>], refuses an unknown site or a bad count, and is unarmed when unset", () => {
    expect(armedFault({})).toBeNull();
    expect(armedFault({ [FAULT_ENV]: "feed.append" })).toEqual({ site: "feed.append", nth: 1 });
    expect(armedFault({ [FAULT_ENV]: "materialize.after-write:3" })).toEqual({ site: "materialize.after-write", nth: 3 });
    expect(() => armedFault({ [FAULT_ENV]: "recorder" })).toThrow(/unknown fault site "recorder"; the sites are recorder.capture, feed.append, commit.after-commit, materialize.before-write, materialize.after-write/);
    expect(() => armedFault({ [FAULT_ENV]: "feed.append:0" })).toThrow(/positive integer/);
    expect(FAULT_SITES).toHaveLength(5);
  });

  it("the nth pass throws, the passes before it do not, and the message is pinned", () => {
    arm("feed.append:2");
    const first = edit("First edit.");
    expect(first.committed).toBe(true);
    expect(faultPasses("feed.append")).toBe(1);
    let caught: unknown;
    try { edit("Second edit."); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InjectedFault);
    expect((caught as InjectedFault).message).toBe("injected fault at feed.append (pass 2)");
    expect(raw()).toBe("First edit.");
  });
});

describe("feed.append — inside the commit transaction", () => {
  it("rolls the whole request back: nothing minted, no row, no file, no alert; the retry lands", () => {
    const feed = count("feed");
    const claims = count("id_claims");
    arm("feed.append");
    expect(() => edit("Changed.")).toThrow(InjectedFault);
    expect(count("feed")).toBe(feed);
    expect(count("id_claims")).toBe(claims);
    expect(raw()).toBe("Body.");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nBody.\n");
    expect(listPending(store.db, repoId)).toEqual([]);
    expect(alerts()).toEqual([]);
    disarm();
    expect(edit("Changed.").committed).toBe(true);
    expect(raw()).toBe("Changed.");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nChanged.\n");
  });
});

describe("recorder.capture — a recorder throw (spec/store §5.4 step 15, resolution 18)", () => {
  it.skipIf(NO_RECORDER)("rolls the member back as CaptureFailed, raises capture_failed, and the next capture of the path clears it", () => {
    const feed = count("feed");
    arm("recorder.capture");
    let caught: unknown;
    try { edit("Changed."); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CaptureFailed);
    expect((caught as CaptureFailed).message).toMatch(/injected fault at recorder.capture \(pass 1\)/);
    expect(count("feed")).toBe(feed);
    expect(raw()).toBe("Body.");
    expect(alerts()).toEqual([CAPTURE_FAILED_ALERT]);
    const detail = listActiveAlerts(store.db, repoId)[0]!.detail as { path?: string; reason: string };
    expect(detail.reason).toMatch(/injected fault at recorder.capture/);
    disarm();
    expect(edit("Changed.").committed).toBe(true);
    expect(alerts()).toEqual([]);
    expect(count("feed")).toBe(feed + 1);
  });
});

describe("commit.after-commit — the rows are durable, the files are owed", () => {
  it("the request fails after COMMIT; the pending row survives; recoverRepo replays it and is then a no-op", () => {
    const feed = count("feed");
    arm("commit.after-commit");
    expect(() => edit("Changed.")).toThrow(InjectedFault);
    expect(count("feed")).toBe(feed + 1);
    expect(raw()).toBe("Changed.");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nBody.\n");
    expect(listPending(store.db, repoId).map((r) => [r.path, r.kind])).toEqual([["a.md", "write"]]);
    disarm();
    const first = recoverRepo(store, repoId, root);
    expect(first).toEqual({ materialized: ["a.md"], healed: [], missing: [] });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nChanged.\n");
    expect(listPending(store.db, repoId)).toEqual([]);
    expect(recoverRepo(store, repoId, root)).toEqual({ materialized: [], healed: [], missing: [] });
    expect(alerts()).toEqual([]);
  });
});

describe("materialize.before-write — the materializer fails before touching the disk", () => {
  it("the api path: committed, the file owed, the row kept; the replay recovers", () => {
    arm("materialize.before-write");
    expect(() => edit("Changed.")).toThrow(InjectedFault);
    expect(raw()).toBe("Changed.");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nBody.\n");
    expect(listPending(store.db, repoId)).toHaveLength(1);
    disarm();
    expect(recoverRepo(store, repoId, root)).toEqual({ materialized: ["a.md"], healed: [], missing: [] });
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nChanged.\n");
  });

  it("the replay path: materializePending raises materialization_failed and keeps the row; a passing replay clears it", () => {
    arm("commit.after-commit");
    expect(() => edit("Changed.")).toThrow(InjectedFault);
    arm("materialize.before-write");
    expect(() => materializePending(store, repoId, new FsDocStore(root))).toThrow(InjectedFault);
    expect(alerts()).toContain(MATERIALIZATION_FAILED_ALERT);
    expect(listPending(store.db, repoId)).toHaveLength(1);
    disarm();
    expect(materializePending(store, repoId, new FsDocStore(root))).toEqual(["a.md"]);
    expect(alerts()).toEqual([]);
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nChanged.\n");
  });
});

describe("materialize.after-write — the file landed, its row did not go", () => {
  it("the file holds the new bytes while the row stays; the replay finds them as recorded and clears the row without rewriting", () => {
    arm("materialize.after-write");
    expect(() => edit("Changed.")).toThrow(InjectedFault);
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("# A\n\nChanged.\n");
    expect(listPending(store.db, repoId)).toHaveLength(1);
    disarm();
    expect(recoverRepo(store, repoId, root)).toEqual({ materialized: ["a.md"], healed: [], missing: [] });
    expect(listPending(store.db, repoId)).toEqual([]);
    expect(recoverRepo(store, repoId, root)).toEqual({ materialized: [], healed: [], missing: [] });
  });
});
