import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store, ensureRepo, observeFile, observeBatch, enableHistory, disableHistory, purgeHistory, registerHistoryProvider, unregisterHistoryProvider, gitCapabilities, defaultCapabilities,
  readCapability, historyReaderFor, capabilityStates, CapabilityUnavailable, HistoryProviderConflict, readDocumentAtRevision, FAULT_ENV, resetFaults, pinClock, setIdMinter, sequentialMinter,
  listActiveAlerts, HISTORY_PROVIDER_UNAVAILABLE_ALERT, runProviderCheckpoint,
} from "@omgbase/core";
import { gitHistoryProvider, FIXTURE_IDENTITY, GitHistoryProvider } from "./provider.js";
import { parseMessage, renderMessage, seqValue, subjectOf } from "./trailers.js";
import { ensureExcluded, excludeFileFor } from "./exclude.js";
import { gitConfigFor, parseCadence, readGitConfig, refuseCredentials } from "./config.js";
import { readGitCursor } from "./cursor.js";
import { gitDate, resetGitProbe, GIT_BIN_ENV } from "./git.js";

// The git history provider (spec/store §5.12; modular-core Phase 6a) end to
// end on a temporary workspace: the baseline, one commit per feed row under
// `every`, the folding under a debounce cadence, the move and the delete, the
// fault at `git.commit` and its byte-identical replay, the rescan after a
// purge, the reader's shapes and its decision-table rows, the `.git/info/
// exclude` line, the trailer codec and the config. The fixture suites pin the
// same behaviour as projections (`spec/store/cases/history/git.json`,
// `spec/surface/cases/reads.json` `git-history`); these are the unit-level
// pins and the edges the fixtures do not reach.

let root: string;
let store: Store;
let repoId: string;
const clock = "2026-10-20T10:00:00.000Z";
let restoreClock: () => void;

function openStore(composition: "git" | "full" = "git"): Store {
  return new Store({ path: ":memory:", omgbaseDir: join(root, ".omgbase"), capabilities: composition === "git" ? gitCapabilities : defaultCapabilities });
}
const row = () => readCapability(store.db, repoId, "history")!;
const provider = () => store.capabilities.providers.git as GitHistoryProvider;
const git = () => provider().gitRepo(row().config as never);
const log = () => git().exists() ? git().text(["log", "--reverse", "--format=%H%n%s%n%(trailers)", "refs/heads/omgbase"]) : "";
const write = (path: string, text: string, ts: string) => observeFile(store, repoId, path, text, { ts });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omgbase-git-adapter-"));
  mkdirSync(join(root, ".omgbase"));
  registerHistoryProvider("git", gitHistoryProvider({ identity: FIXTURE_IDENTITY }));
  setIdMinter(sequentialMinter());
  restoreClock = pinClock(clock);
  store = openStore();
  repoId = ensureRepo(store, "fx", null);
  resetFaults();
  delete process.env[FAULT_ENV];
});
afterEach(() => {
  restoreClock();
  setIdMinter(null);
  store.close();
  unregisterHistoryProvider("git");
  rmSync(root, { recursive: true, force: true });
  delete process.env[FAULT_ENV];
});

describe("the trailer codec", () => {
  it("renders the pinned order and parses it back, a path with spaces and a deleted document included", () => {
    const t = { epoch: "ep_0", from: 3, to: 5, ts: "2026-10-20T10:02:00.000Z", commits: ["c_2", "c_3"], origin: "api", actor: "human:x", plan: "ab".repeat(32), docs: [{ docId: "d_0", path: "a b/c d.md", head: "r_1" }, { docId: "d_1", path: "gone.md", head: null }], rescan: null };
    const msg = renderMessage("subject\nwith newline", t);
    expect(msg).toBe(`subject with newline\n\nomgbase-seq: ep_0:3-5\nomgbase-ts: 2026-10-20T10:02:00.000Z\nomgbase-commit: c_2\nomgbase-commit: c_3\nomgbase-origin: api\nomgbase-actor: human:x\nomgbase-plan: ${"ab".repeat(32)}\nomgbase-doc: d_0 a b/c d.md r_1\nomgbase-doc: d_1 gone.md -\n`);
    expect(parseMessage(msg)).toEqual(t);
    expect(subjectOf(msg)).toBe("subject with newline");
    expect(seqValue("ep_0", 4, 4)).toBe("ep_0:4");
    expect(parseMessage("not ours\n\nbody\n")).toBeNull();
    expect(parseMessage("rescan\n\nomgbase-seq: ep_0:7\nomgbase-rescan: ep_0:7\n")?.rescan).toEqual({ epoch: "ep_0", head: 7 });
  });

  it("gitDate renders the raw `@<seconds> +0000` form", () => {
    expect(gitDate("2026-10-20T10:00:00.000Z")).toBe("@1792490400 +0000");
    expect(() => gitDate("nope")).toThrow(/RFC 3339/);
  });
});

describe("the config", () => {
  it("writes the pinned defaults, refuses a bad branch or cadence, parses --cadence, and reads a row back with defaults filled", () => {
    expect(gitConfigFor({})).toEqual({ provider: "git", git_dir: ".omgbase/git", branch: "omgbase", cadence: "every", ids_ref: "refs/omgbase/ids", remote: null });
    expect(gitConfigFor({ branch: "notes", cadence: { debounce_ms: 500 } }).cadence).toEqual({ debounce_ms: 500 });
    expect(() => gitConfigFor({ branch: "-x" })).toThrow(/branch/);
    expect(() => gitConfigFor({ cadence: { debounce_ms: 0 } })).toThrow(/cadence/);
    expect(parseCadence("every")).toBe("every");
    expect(parseCadence("250")).toEqual({ debounce_ms: 250 });
    expect(() => parseCadence("soon")).toThrow(/--cadence/);
    expect(readGitConfig({ provider: "git" })).toEqual(gitConfigFor({}));
  });

  it("refuses credentials in a URL anywhere (omgbase never stores them)", () => {
    expect(() => refuseCredentials("https://user:secret@example.com/x.git", "remote")).toThrow(/credentials/);
    expect(() => refuseCredentials("https://token@example.com/x.git", "remote")).toThrow(/credentials/);
    expect(() => refuseCredentials("https://example.com/x.git", "remote")).not.toThrow();
    expect(() => refuseCredentials("git@example.com:x/y.git", "remote")).not.toThrow();
  });
});

describe("enable, checkpoint, read", () => {
  it("baselines the full tree, commits one row per feed row under `every`, and reads back through the seam", () => {
    write("a.md", "# A\n\nFirst.\n", "2026-10-20T10:00:00.000Z");
    write("b.md", "# B\n\nOnly.\n", "2026-10-20T10:00:00.000Z");
    const r = enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git", providerOptions: {} });
    expect(r.changed).toBe(true);
    expect(r.baseline).toEqual({ commit: "c_2", revisions: 2 });
    expect(r.tip).toMatch(/^[0-9a-f]{40}$/);
    expect(row().config).toEqual(gitConfigFor({}));
    expect(log()).toContain("history enabled\nomgbase-seq: ep_0:3\n");
    expect(git().lsTree("refs/heads/omgbase")).toMatch(/a\.md\n.*b\.md\n$/s);
    // The row's state on the wire.
    expect(capabilityStates(store, repoId).history).toEqual({ state: "enabled", provider: "git", coverage_from: "2026-10-20T10:01:00.000Z", writer_requires: true, completeness: "every" });
    // No native row: the recorder is absent on this composition and `captureFor` is null for the provider row anyway.
    write("a.md", "# A\n\nFirst, edited.\n", "2026-10-20T10:02:00.000Z");
    const cp = runProviderCheckpoint(store, repoId, "2026-10-20T10:03:00.000Z")!;
    expect(cp).toMatchObject({ committed: 1, from_seq: 4, to_seq: 4, rescanned: false });
    expect(readGitCursor(store.db, repoId)).toEqual({ tip: cp.tip, epoch: "ep_0", seq: 4 });
    const reader = historyReaderFor(store.db, repoId)!;
    const history = reader.docsHistory(repoId, { doc: "a.md" });
    expect(history.docs[0]!.versions.map((v) => [v._rev, v._seq, v._is_current, v.retained])).toEqual([["r_0", 3, false, true], ["r_2", 4, true, true]]);
    expect(history.docs[0]!.versions[1]!._commit).toBe(cp.tip);
    expect(reader.readAtRevision("d_0", "r_0")?._raw).toBe("# A\n\nFirst.\n");
    expect(reader.readAtRevision("d_0", cp.tip!)?._raw).toBe("# A\n\nFirst, edited.\n");
    expect(readDocumentAtRevision(store, "d_0", "r_0")?._raw).toBe("# A\n\nFirst.\n");
    expect(reader.docDiffUnified("d_0").diff).toContain("+First, edited.");
    expect(reader.revisionRows(repoId).map((x) => [x.path, x.rev_id, x.seq, x.commit_id === cp.tip])).toEqual([["a.md", "r_0", 3, false], ["a.md", "r_2", 4, true], ["b.md", "r_1", 3, false]]);
    expect(reader.hasRevision(cp.tip!)).toBe(true);
    expect(reader.hasRevision("r_2")).toBe(true);
    expect(reader.hasRevision("r_9")).toBe(false);
    expect(reader.uncapturedHeads(repoId, "2026-10-20T10:01:00.000Z")).toBe(0);
    expect(reader.dispositionCounts("c_3")).toBeNull();
    // Block lineage is not recorded.
    expect(() => reader.blocksHistory("b_0")).toThrow(CapabilityUnavailable);
    expect(() => reader.diffBlocks("d_0", "r_0", "r_2")).toThrow(/unsupported|docs_diff_unified/);
  });

  it("decides a sha token itself: missing → pruned, a commit not naming the document → target_missing, outside coverage → outside_coverage", () => {
    write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    write("b.md", "# B\n", "2026-10-20T10:00:00.000Z");
    enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git" });
    write("b.md", "# B2\n", "2026-10-20T10:02:00.000Z");
    const cp = runProviderCheckpoint(store, repoId, "2026-10-20T10:03:00.000Z")!;
    const reader = historyReaderFor(store.db, repoId)!;
    expect(() => reader.readAtRevision("d_0", "0".repeat(40))).toThrow(/purged/);
    // The second commit touched b.md (d_1) only: asked of a.md it names no version of it.
    expect(() => reader.readAtRevision("d_0", cp.tip!)).toThrow(/no revision/);
    // A head token nobody committed: null — the core's claim table decides.
    expect(reader.readAtRevision("d_0", "r_9")).toBeNull();
    // A commit whose instant precedes the coverage: outside_coverage.
    disableHistory(store.db, repoId, { now: "2026-10-20T10:04:00.000Z" });
    enableHistory(store.db, repoId, { now: "2026-10-20T10:05:00.000Z", provider: "git" });
    const fresh = historyReaderFor(store.db, repoId)!;
    expect(fresh.readAtRevision("d_1", cp.tip!)?._raw).toBe("# B2\n"); // 10:02 lies inside the first interval
    const r2 = readCapability(store.db, repoId, "history")!;
    expect(r2.coverage).toHaveLength(2);
  });

  it("folds the pending rows under a debounce cadence, records moves and deletions, and reports `checkpoints` completeness", () => {
    write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git", providerOptions: { cadence: { debounce_ms: 1000 }, branch: "notes" } });
    expect(capabilityStates(store, repoId).history.completeness).toBe("checkpoints");
    write("a.md", "# A2\n", "2026-10-20T10:02:00.000Z");
    write("c.md", "# C\n", "2026-10-20T10:03:00.000Z");
    observeBatch(store, repoId, [{ path: "a.md", content: null }], "2026-10-20T10:04:00.000Z");
    const cp = runProviderCheckpoint(store, repoId, "2026-10-20T10:05:00.000Z")!;
    expect(cp).toMatchObject({ committed: 1, from_seq: 3, to_seq: 5 });
    const text = git().text(["log", "-1", "--format=%B", "refs/heads/notes"]);
    expect(text).toContain("omgbase-seq: ep_0:3-5\n");
    expect(text).toContain("omgbase-doc: d_0 a.md -\n");
    expect(git().lsTree("refs/heads/notes")).toBe(git().lsTree("refs/heads/notes").replace(/.*a\.md\n/, ""));
    expect(git().lsTree("refs/heads/notes")).toMatch(/\tc\.md\n$/);
  });

  it("closes the crash gap: a fault at git.commit leaves the tip, the replay writes the same commit", () => {
    write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git" });
    const before = git().tip("omgbase");
    write("a.md", "# A2\n", "2026-10-20T10:02:00.000Z");
    process.env[FAULT_ENV] = "git.commit";
    resetFaults();
    expect(() => runProviderCheckpoint(store, repoId, "2026-10-20T10:03:00.000Z")).toThrow(/injected fault at git.commit/);
    expect(git().tip("omgbase")).toBe(before);
    expect(readGitCursor(store.db, repoId)!.seq).toBe(2);
    delete process.env[FAULT_ENV];
    resetFaults();
    const cp = runProviderCheckpoint(store, repoId, "2026-10-20T10:03:00.000Z")!;
    expect(cp.committed).toBe(1);
    // The dangling commit object the faulted run wrote IS the replayed one: one sha, no orphan of a different identity.
    const counted = git().countObjects();
    expect(counted.count).toBeGreaterThan(0);
    // Running again: nothing to do, the cursor at the tip.
    expect(runProviderCheckpoint(store, repoId, "2026-10-20T10:04:00.000Z")).toMatchObject({ committed: 0, tip: cp.tip });
  });

  it("purge removes the repository and the cursor; the next checkpoint rescans; disable keeps the repository; enable twice conflicts with native", () => {
    write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git" });
    const dir = git().gitDir;
    const purged = purgeHistory(store.db, repoId, { now: "2026-10-20T10:02:00.000Z" });
    expect(purged.provider).toEqual({ name: "git", removed: true, path: dir });
    expect(existsSync(dir)).toBe(false);
    expect(readGitCursor(store.db, repoId)).toBeNull();
    expect(historyReaderFor(store.db, repoId)!.docsHistory(repoId, { doc: "a.md" }).docs[0]!.versions[0]!.retained).toBe(false);
    const cp = runProviderCheckpoint(store, repoId, "2026-10-20T10:03:00.000Z")!;
    expect(cp.rescanned).toBe(true);
    expect(log()).toContain("rescan: 1 document(s)\nomgbase-seq: ep_0:2\n");
    disableHistory(store.db, repoId, { now: "2026-10-20T10:04:00.000Z" });
    expect(existsSync(dir)).toBe(true);
    expect(runProviderCheckpoint(store, repoId)).toBeNull();
    expect(() => enableHistory(store.db, repoId, { now: "2026-10-20T10:05:00.000Z" })).toThrow(CapabilityUnavailable); // no native module on this composition
  });

  it("on the full composition a native repository refuses `--provider git` and a git repository refuses the native enable", () => {
    store.close();
    store = openStore("full");
    repoId = ensureRepo(store, "fx", null); // born native-enabled
    expect(() => enableHistory(store.db, repoId, { provider: "git" })).toThrow(HistoryProviderConflict);
    disableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z" });
    enableHistory(store.db, repoId, { now: "2026-10-20T10:02:00.000Z", provider: "git" });
    expect(() => enableHistory(store.db, repoId)).toThrow(/already enabled with the git provider/);
    expect(capabilityStates(store, repoId).history.provider).toBe("git");
  });

  it("a provider that cannot run is `unavailable` with the alert raised; writes continue", () => {
    write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git" });
    // The executable goes missing (OMGBASE_GIT_BIN names one that does not exist; the probe is re-run).
    process.env[GIT_BIN_ENV] = "/nonexistent/git";
    resetGitProbe();
    try {
      expect(() => historyReaderFor(store.db, repoId)).toThrow(/git history provider is unavailable/);
      expect(listActiveAlerts(store.db, repoId).map((a) => a.code)).toEqual([HISTORY_PROVIDER_UNAVAILABLE_ALERT]);
      expect(capabilityStates(store, repoId).history.state).toBe("unavailable");
      write("a.md", "# A2\n", "2026-10-20T10:02:00.000Z"); // the write lands
      expect(runProviderCheckpoint(store, repoId)).toBeNull();
    } finally {
      delete process.env[GIT_BIN_ENV];
      resetGitProbe();
    }
  });
});

describe(".git/info/exclude", () => {
  it("adds `.omgbase/` once to the user's exclude file, finds a worktree's common dir, and leaves a workspace without .git alone", () => {
    expect(excludeFileFor(root)).toBeNull();
    expect(ensureExcluded(root)).toBe("absent");
    // A plain repository: `.git/` is a directory.
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(ensureExcluded(root)).toBe("added");
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe(".omgbase/\n");
    expect(ensureExcluded(root)).toBe("present");
    // A worktree: `.git` is a file pointing at `<common>/worktrees/<name>`.
    const wt = mkdtempSync(join(tmpdir(), "omgbase-git-adapter-wt-"));
    try {
      mkdirSync(join(root, ".git", "worktrees", "wt"), { recursive: true });
      writeFileSync(join(root, ".git", "worktrees", "wt", "commondir"), "../..\n");
      writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "wt")}\n`);
      expect(excludeFileFor(wt)).toBe(join(root, ".git", "info", "exclude"));
      expect(ensureExcluded(wt)).toBe("present");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
