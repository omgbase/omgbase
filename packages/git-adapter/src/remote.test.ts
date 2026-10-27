import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store, ensureRepo, observeBatch, observeFile, enableHistory, registerHistoryProvider, unregisterHistoryProvider, gitCapabilities,
  readCapability, pinClock, setIdMinter, sequentialMinter, listActiveAlerts, providerConfigOf, runProviderCheckpoint, runProviderRemoteSync, EngineError, capabilityStates, reconstructContent,
  type HistoryVaultSink,
} from "@omgbase/core";
import { gitHistoryProvider, FIXTURE_IDENTITY, GitHistoryProvider } from "./provider.js";
import { GitRepo, EMPTY_TREE } from "./git.js";
import { readGitCursor } from "./cursor.js";
import { parseMessage } from "./trailers.js";
import { GIT_MERGE_CONFLICT_ALERT, GIT_REMOTE_DIVERGED_ALERT, GIT_REMOTE_FORKED_ALERT, sidecarPath, tsSegment } from "./remote.js";
import { createCheckpointScheduler } from "./scheduler.js";
import { idsPath } from "./ids.js";

// The remote half (spec/store §5.12 "The remote binding" … "Divergence", 17.6;
// modular-core Phase 6b) end to end against a SECOND bare repository under the
// temp dir as the remote (a local path URL — no network): the binding, push and
// the remote's log equal to ours, fetch of a remote-side commit written through
// the vault sink (`observeBatch` here — the source boundary), the clean
// three-way merge, the conflict with its sidecar and alert and the resolve, the
// rewritten remote and each of the four remediations, the ids ref written and
// carried, the rejected push, the no-op rule after a fetch, the sweep's steps 7
// and 8, and the scheduler under fake timers.

let root: string;
let remoteDir: string;
let store: Store;
let repoId: string;
let restoreClock: () => void;
const REMOTE_IDENTITY = { name: "remote", email: "remote@fixture" };

const row = () => readCapability(store.db, repoId, "history")!;
const config = () => providerConfigOf(row());
const provider = () => store.capabilities.providers.git as GitHistoryProvider;
const git = () => provider().gitRepo(config());
const remote = () => new GitRepo(remoteDir);
const write = (path: string, text: string, ts: string) => observeFile(store, repoId, path, text, { ts });
const logOf = (repo: GitRepo, ref = "refs/heads/omgbase") => repo.ref(ref) === null ? "" : repo.text(["log", "--reverse", "--format=%H%n%s%n%(trailers)", ref]);
const sink: HistoryVaultSink = {
  apply(changes, ts) {
    observeBatch(store, repoId, changes.map((c) => ({ path: c.path, content: c.content === null ? null : c.content.toString("utf8") })), ts);
  },
};
const checkpoint = (ts: string) => runProviderCheckpoint(store, repoId, ts)!;
const alerts = () => listActiveAlerts(store.db, repoId);
const reconstruct = (docId: string): string | null => reconstructContent(store.db, docId);

/** A commit on the REMOTE made by "someone else" under the determinism env: `files` (null = remove) over the remote's current tip (or `parent`). */
function remoteCommit(files: Record<string, string | null>, ts: string, message = "remote edit", parent: string | null | "detached" = null): string {
  const r = remote();
  r.init("omgbase");
  const base = parent === "detached" ? null : parent ?? r.tip("omgbase");
  const adds = Object.entries(files).filter(([, c]) => c !== null).map(([path, c]) => ({ path, blob: r.writeBlob(c!) }));
  const removes = Object.entries(files).filter(([, c]) => c === null).map(([p]) => p);
  const tree = r.buildTree(base === null ? null : r.treeOf(base), adds, removes);
  const sha = r.commitTree(tree, base, `${message}\n`, { author: REMOTE_IDENTITY, committer: REMOTE_IDENTITY, ts });
  r.run(["update-ref", "refs/heads/omgbase", sha]);
  return sha;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omgbase-git-remote-"));
  mkdirSync(join(root, ".omgbase"));
  remoteDir = join(root, "remote.git");
  new GitRepo(remoteDir).init("omgbase"); // the second bare repository: the remote (a local path, no network)
  registerHistoryProvider("git", gitHistoryProvider({ identity: FIXTURE_IDENTITY }));
  setIdMinter(sequentialMinter());
  restoreClock = pinClock("2026-10-20T10:00:00.000Z");
  store = new Store({ path: ":memory:", omgbaseDir: join(root, ".omgbase"), capabilities: gitCapabilities });
  repoId = ensureRepo(store, "fx", null);
  write("a.md", "# A\n\nFirst.\n", "2026-10-20T10:00:00.000Z");
  write("b.md", "# B\n\nOnly.\n", "2026-10-20T10:00:00.000Z");
  enableHistory(store.db, repoId, { now: "2026-10-20T10:01:00.000Z", provider: "git" });
});
afterEach(() => {
  restoreClock();
  setIdMinter(null);
  store.close();
  unregisterHistoryProvider("git");
  rmSync(root, { recursive: true, force: true });
});

const bind = (opts: Record<string, string> = {}) => provider().remoteSet(repoId, config(), { url: remoteDir, ...opts }, "2026-10-20T10:01:30.000Z");

describe("the binding", () => {
  it("set writes the row's remote and the git remote; status is unknown before any push; unset removes both; credentials are refused", () => {
    const c = bind();
    expect(c.remote).toEqual({ name: "origin", url: remoteDir, branch: "omgbase", push: "off", fetch: "off" });
    expect(row().config.remote).toEqual(c.remote);
    expect(row().state).toBe("enabled");
    expect(git().remotes()).toEqual(["origin"]);
    expect(provider().remoteStatus(repoId, config())).toEqual({ remote: "origin", branch: "omgbase", local_tip: git().tip("omgbase"), remote_tip: null, pushed_through: null, state: "unknown" });
    expect(capabilityStates(store, repoId).history.remote).toEqual({ name: "origin", branch: "omgbase", state: "unknown", pushed_through: null });
    expect(() => bind({ url: "https://user:pw@example.com/x.git" })).toThrow(/credentials/);
    expect(() => bind({ push: "always" })).toThrow(/--push must be one of/);
    expect(() => bind({ name: "-x" })).toThrow(/remote name/);
    bind({ name: "backup", branch: "notes", push: "on-checkpoint", fetch: "periodic" });
    expect(git().remotes()).toEqual(["backup"]);
    expect(row().config.remote).toEqual({ name: "backup", url: remoteDir, branch: "notes", push: "on-checkpoint", fetch: "periodic" });
    provider().remoteUnset(repoId, config(), "2026-10-20T10:02:00.000Z");
    expect(row().config.remote).toBeNull();
    expect(git().remotes()).toEqual([]);
    expect(capabilityStates(store, repoId).history.remote).toBeNull();
    expect(() => provider().push(repoId, config())).toThrow(/no remote is bound/);
  });
});

describe("push", () => {
  it("pushes the branch and the ids ref; the remote's log equals ours; pushed_through is the tip's seq; a second push has nothing to do", () => {
    bind();
    const r = provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    expect(r).toEqual({ pushed: true, tip: git().tip("omgbase"), pushed_through: 3, ids: "pushed" });
    expect(logOf(remote())).toBe(logOf(git()));
    expect(remote().ref("refs/omgbase/ids")).toBe(git().ref("refs/omgbase/ids"));
    expect(provider().remoteStatus(repoId, config()).state).toBe("in-sync");
    expect(readGitCursor(store.db, repoId)!.pushed).toEqual({ tip: git().tip("omgbase"), seq: 3 });
    expect(provider().push(repoId, config(), "2026-10-20T10:02:30.000Z").pushed).toBe(false);
    // A local write: ahead; the checkpoint under `on-checkpoint` pushes by itself and reports it on the receipt.
    bind({ push: "on-checkpoint" });
    write("a.md", "# A\n\nFirst, edited.\n", "2026-10-20T10:03:00.000Z");
    expect(provider().remoteStatus(repoId, config()).state).toBe("in-sync"); // the tip has not moved yet
    const cp = checkpoint("2026-10-20T10:04:00.000Z");
    expect(cp.committed).toBe(1);
    expect(cp.push).toEqual({ pushed: true, tip: cp.tip, pushed_through: 4, ids: "pushed" });
    expect(logOf(remote())).toBe(logOf(git()));
    // A fresh clone of both refs lists the id map of a document.
    const shown = remote().text(["show", `refs/omgbase/ids:${idsPath("d_0")}`]);
    const map = JSON.parse(shown) as { doc: string; head: string; blocks: { id: string; parent: string | null; ordinal: number; hash: string }[] };
    expect(map.doc).toBe("d_0");
    expect(map.head).toBe("r_2");
    // The edit replaced the paragraph: the heading kept b_0, the new paragraph is b_4 (the ids the reconcile minted).
    expect(map.blocks.map((b) => [b.id, b.parent, b.ordinal])).toEqual([["b_0", null, 0], ["b_4", null, 1]]);
    expect(shown).toBe(`{"blocks":[${map.blocks.map((b) => `{"hash":"${b.hash}","id":"${b.id}","ordinal":${b.ordinal},"parent":null}`).join(",")}],"doc":"d_0","head":"r_2"}\n`);
    const idsLog = logOf(git(), "refs/omgbase/ids");
    expect(idsLog).toContain("ids: 2 document(s)\nomgbase-seq: ep_0:3\n");
    expect(idsLog).toContain(`omgbase-content: ${cp.tip}\n`);
  });

  it("a rejected push raises git_remote_diverged (no old tip: fetch merges it) and throws it; the push lands after the fetch", () => {
    bind();
    provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    remoteCommit({ "c.md": "# C\n\nFrom the remote.\n" }, "2026-10-20T10:02:30.000Z");
    write("a.md", "# A\n\nFirst, edited.\n", "2026-10-20T10:03:00.000Z");
    checkpoint("2026-10-20T10:03:30.000Z");
    let thrown: unknown;
    try { provider().push(repoId, config(), "2026-10-20T10:04:00.000Z"); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(EngineError);
    expect((thrown as EngineError).code).toBe("git_remote_diverged");
    expect((thrown as EngineError).retriable).toBe(true);
    const a = alerts();
    expect(a.map((x) => [x.code, x.severity])).toEqual([[GIT_REMOTE_DIVERGED_ALERT, "warning"]]);
    expect(a[0]!.detail).toEqual({ remote: "origin", branch: "omgbase", local_tip: git().tip("omgbase"), remote_tip: remote().tip("omgbase") });
    expect(a[0]!.message).toMatch(/was rejected: the remote is at [0-9a-f]{40}, which does not descend from/);
    expect(provider().remoteStatus(repoId, config()).state).toBe("diverged");
    // Not paused: fetch merges the remote's commit, then the push lands and the alert is gone.
    const f = provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    expect(f.state).toBe("merged");
    expect(f.applied).toEqual(["c.md"]);
    expect(alerts()).toEqual([]);
    expect(provider().push(repoId, config(), "2026-10-20T10:06:00.000Z").pushed).toBe(true);
    expect(logOf(remote())).toBe(logOf(git()));
  });
});

describe("fetch", () => {
  it("fast-forwards: the remote's commit enters the vault through the sink, the branch follows, the worker then commits nothing for it (the no-op rule) and the ids ref records the new head", () => {
    bind();
    provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    const rc = remoteCommit({ "a.md": "# A\n\nEdited on the remote.\n", "c.md": "# C\n\nNew on the remote.\n" }, "2026-10-20T10:02:30.000Z");
    const f = provider().fetch(repoId, config(), sink, "2026-10-20T10:03:00.000Z");
    expect(f).toEqual({ state: "fast-forward", remote_tip: rc, tip: rc, applied: ["a.md", "c.md"], conflicts: [] });
    expect(git().tip("omgbase")).toBe(rc);
    expect(reconstruct("d_0")).toBe("# A\n\nEdited on the remote.\n");
    expect(store.db.prepare("SELECT path FROM docs WHERE repo_id = ? AND deleted_at IS NULL ORDER BY path").all(repoId)).toEqual([{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }]);
    // The cursor row names the foreign tip at the position before the ingest; the worker finds the rows already in the tree.
    expect(readGitCursor(store.db, repoId)!.tip).toBe(rc);
    const cp = checkpoint("2026-10-20T10:04:00.000Z");
    // Two members in the inbound batch = two feed rows (4, 5); both fold into no commit.
    expect(cp).toMatchObject({ committed: 0, from_seq: 4, to_seq: 5, tip: rc, rescanned: false });
    expect(git().tip("omgbase")).toBe(rc);
    expect(readGitCursor(store.db, repoId)!.seq).toBe(5);
    // The identities of the new heads are recorded on the ids ref all the same.
    const ids = git().treeEntries("refs/omgbase/ids");
    expect([...ids.keys()].sort()).toEqual([idsPath("d_0"), idsPath("d_1"), idsPath("d_2")]);
    const idsTip = parseMessage(git().message(git().ref("refs/omgbase/ids")!))!;
    expect(idsTip.content).toBe(rc);
    expect(idsTip.to).toBe(5);
    expect(provider().remoteStatus(repoId, config()).state).toBe("in-sync");
    // Running the worker again: idle, nothing moves.
    expect(checkpoint("2026-10-20T10:05:00.000Z")).toMatchObject({ committed: 0, tip: rc });
    expect(provider().fetch(repoId, config(), sink, "2026-10-20T10:06:00.000Z").state).toBe("nothing");
  });

  it("merges when both sides moved: the remote's changes enter the vault, one merge commit with omgbase-merge; the same blob on both sides is no conflict", () => {
    bind();
    provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    const rc = remoteCommit({ "c.md": "# C\n\nFrom the remote.\n", "b.md": "# B\n\nSame edit.\n" }, "2026-10-20T10:02:30.000Z");
    write("a.md", "# A\n\nEdited here.\n", "2026-10-20T10:03:00.000Z");
    write("b.md", "# B\n\nSame edit.\n", "2026-10-20T10:03:10.000Z");
    const before = checkpoint("2026-10-20T10:03:30.000Z").tip!;
    const f = provider().fetch(repoId, config(), sink, "2026-10-20T10:04:00.000Z");
    expect(f.state).toBe("merged");
    expect(f.applied).toEqual(["c.md"]);
    expect(f.conflicts).toEqual([]);
    const merged = git().tip("omgbase")!;
    expect(f.tip).toBe(merged);
    expect(git().parentsOf(merged)).toEqual([before, rc]);
    const t = parseMessage(git().message(merged))!;
    expect(t.merge).toBe(rc);
    expect(git().message(merged).startsWith("merge origin/omgbase\n\n")).toBe(true);
    expect(git().treeEntries(merged).size).toBe(3);
    expect(reconstruct("d_1")).toBe("# B\n\nSame edit.\n");
    expect(provider().remoteStatus(repoId, config()).state).toBe("ahead");
    const cp = checkpoint("2026-10-20T10:05:00.000Z");
    expect(cp.committed).toBe(0); // c.md's row was already in the merge tree
    expect(provider().push(repoId, config(), "2026-10-20T10:06:00.000Z").pushed).toBe(true);
    expect(remote().tip("omgbase")).toBe(merged);
  });

  it("surfaces a conflict: both versions kept — the remote's as <stem>.remote-<short>.md — the alert raised, no merge commit until resolve --theirs completes it", () => {
    bind();
    provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    const rc = remoteCommit({ "a.md": "# A\n\nTheirs.\n" }, "2026-10-20T10:02:30.000Z");
    write("a.md", "# A\n\nOurs.\n", "2026-10-20T10:03:00.000Z");
    const ours = checkpoint("2026-10-20T10:03:30.000Z").tip!;
    const f = provider().fetch(repoId, config(), sink, "2026-10-20T10:04:00.000Z");
    const side = sidecarPath("a.md", "remote", rc);
    expect(side).toBe(`a.remote-${rc.slice(0, 7)}.md`);
    expect(f).toEqual({ state: "conflict", remote_tip: rc, tip: ours, applied: [side], conflicts: ["a.md"] });
    expect(reconstruct("d_0")).toBe("# A\n\nOurs.\n");
    expect(store.db.prepare("SELECT path FROM docs WHERE repo_id = ? AND deleted_at IS NULL ORDER BY path").all(repoId)).toEqual([{ path: "a.md" }, { path: side }, { path: "b.md" }]);
    const a = alerts();
    expect(a.map((x) => x.code)).toEqual([GIT_MERGE_CONFLICT_ALERT]);
    expect(a[0]!.detail).toEqual({ remote: "origin", branch: "omgbase", remote_tip: rc, paths: ["a.md"], base: git().mergeBase(ours, rc) });
    expect(a[0]!.message).toBe(`the merge of origin/omgbase at ${rc} left 1 conflict(s): a.md — both versions are in the vault; settle each with omg history remote resolve <path> --ours|--theirs`);
    expect(git().tip("omgbase")).toBe(ours);
    // A second fetch and a push wait for the resolution (both refuse with the conflict, never with a rejected push).
    expect(() => provider().fetch(repoId, config(), sink, "2026-10-20T10:04:30.000Z")).toThrow(/left 1 conflict/);
    expect(() => provider().push(repoId, config(), "2026-10-20T10:04:40.000Z")).toThrow(/left 1 conflict/);
    // The sidecar is a document of the vault: the worker commits it (and nothing else).
    const cp = checkpoint("2026-10-20T10:05:00.000Z");
    expect(cp.committed).toBe(1);
    expect(git().treeEntries(cp.tip!).has(side)).toBe(true);
    // --theirs: the remote's bytes take the path, the sidecar leaves, the merge commit is written over the resolution.
    const r = provider().resolve(repoId, config(), sink, "a.md", "theirs", "2026-10-20T10:06:00.000Z");
    expect(r.remaining).toEqual([]);
    expect(r.merged).toBe(git().tip("omgbase"));
    expect(git().parentsOf(r.merged!)[1]).toBe(rc);
    expect(reconstruct("d_0")).toBe("# A\n\nTheirs.\n");
    expect(git().treeEntries(r.merged!).has(side)).toBe(false);
    expect(git().blob(git().treeEntries(r.merged!).get("a.md")!).toString()).toBe("# A\n\nTheirs.\n");
    expect(alerts()).toEqual([]);
    expect(() => provider().resolve(repoId, config(), sink, "a.md", "ours")).toThrow(/no merge conflict is pending/);
    expect(provider().push(repoId, config(), "2026-10-20T10:07:00.000Z").pushed).toBe(true);
    expect(remote().tip("omgbase")).toBe(r.merged);
  });

  it("resolve --ours keeps our bytes and drops the sidecar", () => {
    bind();
    provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    const rc = remoteCommit({ "a.md": "# A\n\nTheirs.\n" }, "2026-10-20T10:02:30.000Z");
    write("a.md", "# A\n\nOurs.\n", "2026-10-20T10:03:00.000Z");
    checkpoint("2026-10-20T10:03:30.000Z");
    provider().fetch(repoId, config(), sink, "2026-10-20T10:04:00.000Z");
    const r = provider().resolve(repoId, config(), sink, "a.md", "ours", "2026-10-20T10:05:00.000Z");
    expect(r.merged).not.toBeNull();
    expect(reconstruct("d_0")).toBe("# A\n\nOurs.\n");
    expect(git().treeEntries(r.merged!).has(sidecarPath("a.md", "remote", rc))).toBe(false);
    expect(git().blob(git().treeEntries(r.merged!).get("a.md")!).toString()).toBe("# A\n\nOurs.\n");
    expect(alerts()).toEqual([]);
  });
});

describe("divergence", () => {
  /** Push, let the remote gain a commit we fetch, then REWRITE the remote: its new tip replaces that commit (a rebase/force-push); we also have an unpushed checkpoint. */
  function rewriteRemote(): { old: string; rewritten: string; local: string } {
    bind();
    provider().push(repoId, config(), "2026-10-20T10:02:00.000Z");
    const old = remoteCommit({ "c.md": "# C\n\nFirst remote version.\n" }, "2026-10-20T10:02:30.000Z");
    expect(provider().fetch(repoId, config(), sink, "2026-10-20T10:03:00.000Z").state).toBe("fast-forward");
    checkpoint("2026-10-20T10:03:10.000Z");
    provider().push(repoId, config(), "2026-10-20T10:03:20.000Z");
    // The remote rewrites: `c.md` committed differently on top of the commit BEFORE old (old's parent).
    const parent = remote().parentsOf(old)[0]!;
    const rewritten = remoteCommit({ "c.md": "# C\n\nRewritten remote version.\n", "d.md": "# D\n\nAlso new.\n" }, "2026-10-20T10:03:30.000Z", "remote rewrite", parent);
    // Our unpushed checkpoint.
    write("a.md", "# A\n\nEdited here.\n", "2026-10-20T10:04:00.000Z");
    const local = checkpoint("2026-10-20T10:04:30.000Z").tip!;
    return { old, rewritten, local };
  }

  it("fetch detects the rewrite: git_remote_diverged with the old tip, push and fetch paused, checkpoints continue; reconcile refuses without the alert", () => {
    const { old, rewritten, local } = rewriteRemote();
    expect(() => provider().reconcile(repoId, config(), sink, "merge")).toThrow(/not diverged/);
    const f = provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    expect(f).toEqual({ state: "diverged", remote_tip: rewritten, old_remote_tip: old, tip: local, applied: [], conflicts: [] });
    const a = alerts();
    expect(a.map((x) => x.code)).toEqual([GIT_REMOTE_DIVERGED_ALERT]);
    expect(a[0]!.detail).toEqual({ remote: "origin", branch: "omgbase", local_tip: local, remote_tip: rewritten, old_remote_tip: old });
    expect(a[0]!.message).toBe(`the remote origin/omgbase was rewritten: its tip ${rewritten} does not descend from the last known ${old} — push and fetch are paused while checkpoints continue locally; choose omg history remote reconcile --rebase | --merge | --adopt | --fork`);
    expect(git().ref("refs/omgbase/diverged/origin")).toBe(old);
    expect(() => provider().push(repoId, config(), "2026-10-20T10:05:10.000Z")).toThrow(/was rewritten/);
    expect(() => provider().fetch(repoId, config(), sink, "2026-10-20T10:05:20.000Z")).toThrow(/was rewritten/);
    expect(provider().remoteStatus(repoId, config()).state).toBe("diverged");
    expect(runProviderRemoteSync(store, repoId, sink, "2026-10-20T10:05:30.000Z")).toEqual({ pushed: null, fetched: null, paused: true });
    write("b.md", "# B\n\nStill writing.\n", "2026-10-20T10:06:00.000Z");
    expect(checkpoint("2026-10-20T10:06:30.000Z").committed).toBe(1);
    expect(remote().tip("omgbase")).toBe(rewritten); // never force-pushed
  });

  it("--rebase replays our unpushed checkpoints onto the new remote head with the trailers preserved, backs the old tip up, rebases the ids ref, and clears the alert", () => {
    const { old, rewritten, local } = rewriteRemote();
    provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    const oursBefore = git().revList(old, local);
    const idsBefore = git().ref("refs/omgbase/ids")!;
    const r = provider().reconcile(repoId, config(), sink, "rebase", "2026-10-20T10:07:00.000Z");
    expect(r.mode).toBe("rebase");
    expect(r.rewritten).toBe(oursBefore.length);
    expect(r.backup).toBe(local);
    expect(git().ref(`refs/omgbase/backup/${tsSegment("2026-10-20T10:07:00.000Z")}`)).toBe(local);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toEqual(["c.md", "d.md"]); // the remote's changes since the old tip, into the vault
    const tip = git().tip("omgbase")!;
    expect(tip).toBe(r.tip);
    expect(git().isAncestor(rewritten, tip)).toBe(true);
    expect(git().isAncestor(old, tip)).toBe(false);
    const replayed = git().revList(rewritten, tip);
    expect(replayed.length).toBe(oursBefore.length);
    // The same messages — trailers preserved — on the rewritten commits.
    expect(replayed.map((c) => git().message(c))).toEqual(oursBefore.map((c) => git().message(c)));
    expect(git().blob(git().treeEntries(tip).get("c.md")!).toString()).toBe("# C\n\nRewritten remote version.\n");
    expect(git().blob(git().treeEntries(tip).get("a.md")!).toString()).toBe("# A\n\nEdited here.\n");
    expect(reconstruct("d_2")).toBe("# C\n\nRewritten remote version.\n");
    expect(alerts()).toEqual([]);
    expect(git().ref("refs/omgbase/diverged/origin")).toBeNull();
    // The ids ref: rewritten alongside, its content trailers re-pointed.
    const idsTip = git().ref("refs/omgbase/ids")!;
    expect(idsTip).not.toBe(idsBefore);
    const contents = git().revList(null, idsTip).map((c) => parseMessage(git().message(c))!.content).filter((c): c is string => c !== null);
    for (const c of contents) expect(git().objectType(c)).toBe("commit");
    expect(contents.some((c) => replayed.includes(c))).toBe(true);
    expect(contents.some((c) => oursBefore.includes(c))).toBe(false);
    // Push lands (fast-forward of the remote), the remote's log is ours.
    expect(provider().push(repoId, config(), "2026-10-20T10:08:00.000Z").pushed).toBe(true);
    expect(logOf(remote())).toBe(logOf(git()));
    expect(checkpoint("2026-10-20T10:09:00.000Z").committed).toBe(0);
  });

  it("--merge writes one merge commit over the old tip as the base and keeps both histories", () => {
    const { rewritten, local } = rewriteRemote();
    provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    const r = provider().reconcile(repoId, config(), sink, "merge", "2026-10-20T10:07:00.000Z");
    expect(r.mode).toBe("merge");
    expect(r.rewritten).toBe(1);
    expect(r.backup).toBe(local);
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toEqual(["c.md", "d.md"]);
    const tip = git().tip("omgbase")!;
    expect(git().parentsOf(tip)).toEqual([local, rewritten]);
    expect(parseMessage(git().message(tip))!.merge).toBe(rewritten);
    expect(git().blob(git().treeEntries(tip).get("c.md")!).toString()).toBe("# C\n\nRewritten remote version.\n");
    expect(alerts()).toEqual([]);
    expect(provider().push(repoId, config(), "2026-10-20T10:08:00.000Z").pushed).toBe(true);
    expect(remote().tip("omgbase")).toBe(tip);
  });

  it("--merge with a conflict keeps both versions and waits for resolve", () => {
    const { rewritten } = rewriteRemote();
    // Our unpushed edit of c.md collides with the rewrite's c.md.
    write("c.md", "# C\n\nEdited here too.\n", "2026-10-20T10:04:40.000Z");
    const local = checkpoint("2026-10-20T10:04:50.000Z").tip!;
    provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    const r = provider().reconcile(repoId, config(), sink, "merge", "2026-10-20T10:07:00.000Z");
    expect(r.conflicts).toEqual(["c.md"]);
    expect(r.rewritten).toBe(0);
    expect(r.applied).toEqual(["d.md", sidecarPath("c.md", "remote", rewritten)]);
    expect(git().tip("omgbase")).toBe(local);
    expect(alerts().map((a) => a.code)).toEqual([GIT_MERGE_CONFLICT_ALERT]);
    const res = provider().resolve(repoId, config(), sink, "c.md", "ours", "2026-10-20T10:08:00.000Z");
    expect(res.merged).not.toBeNull();
    expect(git().parentsOf(res.merged!)[1]).toBe(rewritten);
    expect(reconstruct("d_2")).toBe("# C\n\nEdited here too.\n");
    expect(alerts()).toEqual([]);
  });

  it("--adopt makes the remote's head truth: its tree through the vault, our edits beside theirs as .local sidecars, our tip on a backup ref", () => {
    const { rewritten, local } = rewriteRemote();
    provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    const r = provider().reconcile(repoId, config(), sink, "adopt", "2026-10-20T10:07:00.000Z");
    expect(r.mode).toBe("adopt");
    expect(r.tip).toBe(rewritten);
    expect(git().tip("omgbase")).toBe(rewritten);
    expect(r.backup).toBe(local);
    expect(git().ref(`refs/omgbase/backup/${tsSegment("2026-10-20T10:07:00.000Z")}`)).toBe(local);
    // a.md was edited locally since the last agreement and the remote has the old bytes: theirs at the path, ours beside it.
    const side = sidecarPath("a.md", "local", local);
    expect(r.conflicts).toEqual(["a.md"]);
    expect(r.applied).toEqual(["a.md", side, "c.md", "d.md"]);
    expect(reconstruct("d_0")).toBe("# A\n\nFirst.\n");
    expect(store.db.prepare("SELECT path FROM docs WHERE repo_id = ? AND deleted_at IS NULL ORDER BY path").all(repoId).map((x) => (x as { path: string }).path)).toEqual([side, "a.md", "b.md", "c.md", "d.md"]);
    const a = alerts();
    expect(a.map((x) => x.code)).toEqual([GIT_MERGE_CONFLICT_ALERT]);
    expect(a[0]!.detail).toEqual({ remote: "origin", branch: "omgbase", remote_tip: rewritten, paths: ["a.md"], sidecars: { "a.md": side }, holds: { "a.md": "ours" } });
    // The worker commits the sidecar on top of the adopted head; the adopted paths are no-ops.
    const cp = checkpoint("2026-10-20T10:08:00.000Z");
    expect(cp.committed).toBe(1);
    expect(git().isAncestor(rewritten, cp.tip!)).toBe(true);
    // --ours brings our edit back to the path; no merge commit is pending here.
    const res = provider().resolve(repoId, config(), sink, "a.md", "ours", "2026-10-20T10:09:00.000Z");
    expect(res.merged).toBeNull();
    expect(reconstruct("d_0")).toBe("# A\n\nEdited here.\n");
    expect(alerts()).toEqual([]);
    expect(provider().push(repoId, config(), "2026-10-20T10:10:00.000Z").pushed).toBe(true);
  });

  it("--fork pushes our branch under <branch>-omgbase-<ts>, never the remote's branch, and alerts; push and fetch stay paused until --adopt", () => {
    const { rewritten, local } = rewriteRemote();
    provider().fetch(repoId, config(), sink, "2026-10-20T10:05:00.000Z");
    const r = provider().reconcile(repoId, config(), sink, "fork", "2026-10-20T10:07:00.000Z");
    expect(r.fork).toBe("omgbase-omgbase-20261020T100700Z");
    expect(remote().ref(`refs/heads/${r.fork}`)).toBe(local);
    expect(remote().tip("omgbase")).toBe(rewritten);
    expect(git().tip("omgbase")).toBe(local);
    const a = alerts();
    expect(a.map((x) => x.code)).toEqual([GIT_REMOTE_FORKED_ALERT]);
    expect(a[0]!.message).toBe(`the engine's branch was pushed to origin/${r.fork} — merge it into omgbase with git, then run omg history remote reconcile --adopt (push and fetch stay paused until then)`);
    expect(() => provider().push(repoId, config(), "2026-10-20T10:08:00.000Z")).toThrow(/was pushed to origin\//);
    expect(provider().remoteStatus(repoId, config()).state).toBe("diverged");
    // The human merged on the remote; adopt the result.
    const adopted = provider().reconcile(repoId, config(), sink, "adopt", "2026-10-20T10:09:00.000Z");
    expect(adopted.tip).toBe(rewritten);
    expect(alerts().map((x) => x.code)).toEqual([GIT_MERGE_CONFLICT_ALERT]);
  });
});

describe("the sweep's steps 7–8 and the scheduler", () => {
  it("remoteSync pushes under push: periodic and fetches under fetch: periodic", () => {
    bind({ push: "periodic", fetch: "periodic" });
    const r1 = runProviderRemoteSync(store, repoId, sink, "2026-10-20T10:02:00.000Z")!;
    expect(r1.paused).toBe(false);
    expect((r1.fetched as { state: string }).state).toBe("nothing");
    expect((r1.pushed as { pushed: boolean }).pushed).toBe(true);
    remoteCommit({ "c.md": "# C\n\nFrom the remote.\n" }, "2026-10-20T10:02:30.000Z");
    const r2 = runProviderRemoteSync(store, repoId, sink, "2026-10-20T10:03:00.000Z")!;
    expect((r2.fetched as { state: string }).state).toBe("fast-forward");
    expect((r2.pushed as { pushed: boolean }).pushed).toBe(false);
    bind({ push: "off", fetch: "off" });
    expect(runProviderRemoteSync(store, repoId, sink, "2026-10-20T10:04:00.000Z")).toEqual({ pushed: null, fetched: null, paused: false });
  });

  it("the scheduler runs synchronously under `every` and coalesces a burst under a debounce", () => {
    let runs = 0;
    const every = createCheckpointScheduler({ cadence: "every", run: () => { runs++; } });
    every.notify();
    every.notify();
    expect(runs).toBe(2);
    expect(every.pending()).toBe(false);
    // Fake timers: the handle is the callback itself.
    let armed: { fn: () => void; ms: number } | null = null;
    let cleared = 0;
    const debounced = createCheckpointScheduler({
      cadence: { debounce_ms: 250 },
      run: () => { runs++; },
      setTimeout: (fn, ms) => { armed = { fn, ms }; return fn; },
      clearTimeout: () => { cleared++; armed = null; },
    });
    debounced.notify();
    debounced.notify();
    debounced.notify();
    expect(runs).toBe(2);
    expect(cleared).toBe(2); // each notify re-arms
    expect(armed!.ms).toBe(250);
    expect(debounced.pending()).toBe(true);
    armed!.fn();
    expect(runs).toBe(3);
    expect(debounced.pending()).toBe(false);
    // flush runs a pending one now; close cancels.
    debounced.notify();
    debounced.flush();
    expect(runs).toBe(4);
    debounced.notify();
    debounced.close();
    expect(debounced.pending()).toBe(false);
    expect(runs).toBe(4);
    // An error in the worker reaches onError, never the hook's caller.
    const errors: unknown[] = [];
    const failing = createCheckpointScheduler({ cadence: "every", run: () => { throw new Error("boom"); }, onError: (e) => errors.push(e) });
    expect(() => failing.notify()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe("the empty tree constant", () => {
  it("is git's", () => {
    expect(git().text(["hash-object", "-t", "tree", "/dev/null"]).trim()).toBe(EMPTY_TREE);
  });
});
