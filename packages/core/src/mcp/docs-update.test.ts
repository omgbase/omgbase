import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { buildServer } from "./server.js";

// spec/surface §4 (4.0): `docs_update { _id?, _path?, content, reason? }` is sugar
// for `apply { effects: [set content] }` and returns the Receipt; the plan-only
// call is `plan` over the same effect, whose `preview.identity[<doc>]` carries
// the whole-document planner's annotations (the 3.x `{ opset, plan }` result).

let store: Store; let repoId: string; let client: Client; let dir: string;

async function connect(): Promise<void> {
  const server = buildServer({ store, repoId, rootPath: dir });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
}
function call(name: string, args: Record<string, unknown>): Promise<{ payload: unknown; isError: boolean }> {
  return client.callTool({ name, arguments: args }).then((r) => {
    const res = r as { content: { text: string }[]; isError?: boolean };
    return { payload: JSON.parse(res.content[0]!.text), isError: res.isError ?? false };
  });
}

const DOC = "# Risks\n\nStable identity is a genuinely hard engineering problem here.\n\nA second paragraph with its own separate content to keep.\n";
const EDITED = "# Risks\n\nStable identity is a genuinely hard engineering problem indeed.\n\nA second paragraph with its own separate content to keep.\n";
const setContent = (content: string) => [{ op: "set", target: { kind: "document", _path: "notes.md" }, field: "content", value: content }];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-update-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
  writeFileSync(join(dir, "notes.md"), DOC);
  processCheckpoint(store, repoId, dir, [{ path: "notes.md" }]);
  await connect();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("MCP docs_update (set-content sugar, 4.0)", () => {
  it("plan { set content } is the inspectable plan: preview.identity carries the opset's annotations, nothing is written", async () => {
    const { payload, isError } = await call("plan", { effects: setContent(EDITED) });
    expect(isError).toBe(false);
    const p = payload as { effects: { target: { _id: string } }[]; opset: { ops: unknown[] }; preview: { identity: Record<string, { matcher_v: string; summary: { updated: number; preserved: number }; ops: { op_index: number; disposition: string; blocks: string[] }[]; diagnostics: string[] }> } };
    const docId = p.effects[0]!.target._id;
    const identity = p.preview.identity[docId]!;
    expect(identity.matcher_v).toMatch(/^m/);
    expect(identity.summary.updated).toBe(1);
    expect(identity.ops.map((o) => o.disposition)).toEqual(["edited"]);
    expect(identity.ops[0]!.op_index).toBe(0);
    expect(p.opset.ops).toHaveLength(1);
    expect(identity.diagnostics).toEqual([]);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(DOC);
  });

  it("docs_update commits as one api commit and returns the Receipt, preserving the untouched paragraph's id", async () => {
    const kept = (store.db.prepare("SELECT block_id FROM blocks WHERE text LIKE 'A second paragraph%'").get() as { block_id: string }).block_id;
    const { payload, isError } = await call("docs_update", { _path: "notes.md", content: EDITED, reason: "refine risks intro" });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ plan_id: expect.stringMatching(/^[0-9a-f]{64}$/), commit: expect.stringMatching(/^c_/), revisions: [{ _path: "/notes.md" }], new_ids: {}, committed: true });
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(EDITED);
    const keptAfter = (store.db.prepare("SELECT block_id FROM blocks WHERE text LIKE 'A second paragraph%'").get() as { block_id: string }).block_id;
    expect(keptAfter).toBe(kept);
    const commit = store.db.prepare("SELECT reason, actor, ops FROM commits WHERE origin = 'api'").get() as { reason: string; actor: string; ops: string };
    expect(commit.reason).toBe("refine risks intro");
    expect(commit.actor).toBe("agent:mcp");
    expect(commit.ops).toMatch(/"field":"content"/);
  });

  it("content that already equals the document is a plan with nothing to do: no commit, committed: true", async () => {
    const { payload, isError } = await call("docs_update", { _path: "notes.md", content: DOC });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ commit: null, revisions: [], new_ids: {}, committed: true });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("dry_run is no longer an argument; a missing document is doc_missing; non-convergent content is plan_not_convergent", async () => {
    const missing = await call("docs_update", { _path: "nope.md", content: "x" });
    expect(missing.payload).toMatchObject({ error: "doc_missing" });
    const nc = await call("docs_update", { _path: "notes.md", content: "\n" + DOC });
    expect(nc.payload).toMatchObject({ error: "plan_not_convergent" });
    expect((nc.payload as { data: Record<string, unknown> }).data.effect_index).toBeUndefined();
  });

  // The complaint this flags (§11.2): `content` is the COMPLETE document,
  // frontmatter fence included — a caller who forgets the fence silently
  // clears whatever frontmatter the document currently has. Advisory, not a
  // refusal: the commit still succeeds (a deliberate clear is sometimes the
  // intent), but `frontmatter_dropped` names it on both `plan` and the
  // committing Receipt, before or at commit time.
  describe("frontmatter_dropped advisory (4.2)", () => {
    const FM_DOC = "---\nstatus: active\n---\n\n# Risks\n\nBody text.\n";
    const NO_FENCE = "# Risks\n\nBody text, rewritten with no frontmatter.\n";
    const setFmContent = (content: string) => [{ op: "set", target: { kind: "document", _path: "fm.md" }, field: "content", value: content }];

    beforeEach(() => {
      writeFileSync(join(dir, "fm.md"), FM_DOC);
      processCheckpoint(store, repoId, dir, [{ path: "fm.md" }]);
    });

    it("plan surfaces preview.frontmatter_dropped { effect_index, _id, _path } when the new content has no fence and the document's current frontmatter is non-empty", async () => {
      const { payload, isError } = await call("plan", { effects: setFmContent(NO_FENCE) });
      expect(isError).toBe(false);
      const p = payload as { effects: { target: { _id: string } }[]; preview: { frontmatter_dropped: { effect_index: number; _id: string; _path: string }[] } };
      const docId = p.effects[0]!.target._id;
      expect(p.preview.frontmatter_dropped).toEqual([{ effect_index: 0, _id: docId, _path: "/fm.md" }]);
      expect(readFileSync(join(dir, "fm.md"), "utf8")).toBe(FM_DOC);
    });

    it("apply/docs_update still COMMITS the frontmatter-dropping write (advisory, not a refusal) and carries frontmatter_dropped on the Receipt", async () => {
      const { payload, isError } = await call("docs_update", { _path: "fm.md", content: NO_FENCE });
      expect(isError).toBe(false);
      const r = payload as { committed: true; frontmatter_dropped: { effect_index: number; _id: string; _path: string }[]; revisions: { _id: string }[] };
      expect(r.committed).toBe(true);
      expect(r.frontmatter_dropped).toEqual([{ effect_index: 0, _id: r.revisions[0]!._id, _path: "/fm.md" }]);
      expect(readFileSync(join(dir, "fm.md"), "utf8")).toBe(NO_FENCE);
    });

    it("no advisory when the new content keeps a fence, or when the document had no frontmatter to begin with", async () => {
      const refenced = "---\nstatus: closed\n---\n\n# Risks\n\nBody text, refenced.\n";
      const { payload: kept } = await call("plan", { effects: setFmContent(refenced) });
      expect((kept as { preview: { frontmatter_dropped?: unknown[] } }).preview.frontmatter_dropped ?? []).toEqual([]);
      const { payload: noFmPlan } = await call("plan", { effects: setContent(EDITED) });
      expect((noFmPlan as { preview: { frontmatter_dropped?: unknown[] } }).preview.frontmatter_dropped ?? []).toEqual([]);
    });
  });
});
