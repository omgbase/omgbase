import type { HistoryPushResult, HistoryRemoteState, HistoryRemoteSummary, HistoryVaultSink, HistoryRemoteSyncResult } from "@omgbase/core";
import { EngineError, clearAlert, feedStatus, listActiveAlerts, raiseAlert, reconstructContent, repoEpoch, updateHistoryProviderConfig } from "@omgbase/core";
import { EMPTY_TREE, type GitRepo } from "./git.js";
import { parseMessage, renderMessage, type CommitTrailers } from "./trailers.js";
import { readGitCursor, writeGitCursor, writeGitPushed } from "./cursor.js";
import { remoteConfigFor, type GitHistoryConfig, type GitRemoteConfig, type GitRemoteOptions } from "./config.js";
import { resumePosition, runCheckpoint, type WorkerContext } from "./worker.js";

// The remote half of the git history provider (spec/store §5.12 "The remote
// binding" … "Divergence", 17.6 — modular-core Phase 6b; the design note's §8
// and "Remote divergence"). Sync is coordination between the engine's branch
// and the remote's: OUTBOUND is `git push` — never `--force`; a rejected push
// is reported, not forced — INBOUND is `git fetch` into the bare repository and
// a THREE-WAY MERGE AT THE TREE LEVEL with the common ancestor git supplies
// (the piece optional native history took away), whose clean result flows into
// the vault THROUGH THE SOURCE BOUNDARY (`HistoryVaultSink`: external edits the
// ordinary reconcile matches identities for, the feed records, the worker then
// finds already in the tree) and whose conflicts are surfaced with BOTH
// versions kept (the remote's as a sidecar beside ours) until the operator
// settles each. A REWRITTEN remote (rebased, force-pushed — its tip no longer
// descends from the tip we last knew) is detected, stopped and alerted; push
// and fetch pause, checkpointing continues, and one of four explicit
// remediations is the operator's: `--rebase`, `--merge`, `--adopt`, `--fork`.
// NEVER: a force-push, unpushed local commits dropped without a backup ref, a
// silent last-write-wins.
//
// Refs this module keeps in the bare repository, all under names git itself
// never writes: `refs/remotes/<name>/<branch>` the remote-tracking ref (the
// last tip seen on the remote — moved by fetch and by a successful push);
// `refs/omgbase/remotes/<name>/ids` the remote's ids ref as fetched;
// `refs/omgbase/diverged/<name>` the OLD remote tip while a divergence stands
// (the base `--rebase` and `--merge` use; the objects stay reachable);
// `refs/omgbase/merge/<name>` the remote tip a merge with conflicts is waiting
// on; `refs/omgbase/backup/<ts>` our previous tip before a remediation moved
// the branch.

export const GIT_REMOTE_DIVERGED_ALERT = "git_remote_diverged";
export const GIT_MERGE_CONFLICT_ALERT = "git_merge_conflict";
export const GIT_REMOTE_FORKED_ALERT = "git_remote_forked";

export type FetchState = "nothing" | "fast-forward" | "merged" | "conflict" | "diverged";
export type ReconcileMode = "rebase" | "merge" | "adopt" | "fork";
export type ResolveChoice = "ours" | "theirs";

export interface RemoteStatus {
  remote: string;
  branch: string;
  local_tip: string | null;
  remote_tip: string | null;
  pushed_through: number | null;
  state: HistoryRemoteState;
}

export interface FetchResult {
  state: FetchState;
  /** the remote's tip after the fetch (null when the remote branch does not exist yet) */
  remote_tip: string | null;
  /** `diverged` alone: the tip we last knew the remote at (null for unrelated histories) */
  old_remote_tip?: string | null;
  /** our branch tip after the fetch */
  tip: string | null;
  /** the paths written into the vault from the remote (sidecars included), in path order */
  applied: string[];
  /** the conflicting paths (a sidecar beside each) */
  conflicts: string[];
}

export interface ResolveResult {
  path: string;
  choice: ResolveChoice;
  remaining: string[];
  /** the merge commit written when the last conflict was settled, else null */
  merged: string | null;
  tip: string | null;
}

export interface ReconcileResult {
  mode: ReconcileMode;
  tip: string | null;
  /** the previous tip, kept on `refs/omgbase/backup/<ts>` (rebase, merge, adopt) */
  backup: string | null;
  /** `--rebase`: the commits rewritten; `--merge`: 1 when the merge commit was written, 0 while conflicts stand */
  rewritten: number;
  /** `--fork`: the branch pushed */
  fork: string | null;
  applied: string[];
  conflicts: string[];
}

// ---- refs and helpers ----

const trackingRef = (r: GitRemoteConfig): string => `refs/remotes/${r.name}/${r.branch}`;
const idsTrackingRef = (r: GitRemoteConfig): string => `refs/omgbase/remotes/${r.name}/ids`;
const divergedRef = (r: GitRemoteConfig): string => `refs/omgbase/diverged/${r.name}`;
const mergeRef = (r: GitRemoteConfig): string => `refs/omgbase/merge/${r.name}`;
const short = (sha: string): string => sha.slice(0, 7);

/** `<ts>` as a ref/branch segment: `20260927T000000Z`. */
export function tsSegment(ts: string): string {
  return ts.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The sidecar beside `path` holding the OTHER side's version: `<stem>.remote-<short>.md` / `<stem>.local-<short>.md` (a path without `.md` keeps its name and gains the suffix). */
export function sidecarPath(path: string, side: "remote" | "local", sha: string): string {
  const m = /^(.*)\.md$/.exec(path);
  return m ? `${m[1]}.${side}-${short(sha)}.md` : `${path}.${side}-${short(sha)}`;
}

function requireRemote(ctx: WorkerContext): GitRemoteConfig {
  const r = ctx.config.remote;
  if (!r) throw new Error("no remote is bound to this repository's git history — run omg history remote set --url <url> first");
  return r;
}

interface DivergedDetail {
  remote: string;
  branch: string;
  local_tip: string | null;
  remote_tip: string | null;
  old_remote_tip?: string | null;
}

function activeAlert(ctx: WorkerContext, code: string): { detail: Record<string, unknown> } | null {
  const a = listActiveAlerts(ctx.store.db, ctx.repoId).find((x) => x.code === code);
  return a ? { detail: a.detail ?? {} } : null;
}

/**
 * Are push and fetch PAUSED? While the remote stands rewritten
 * (`git_remote_diverged` carrying `old_remote_tip`) or forked, nothing moves
 * either way until a remediation; a plain rejected push (no `old_remote_tip`)
 * pauses nothing — `history fetch` merges the remote's commits and clears it.
 */
export function pausedBy(ctx: WorkerContext): { code: string; detail: Record<string, unknown> } | null {
  const diverged = activeAlert(ctx, GIT_REMOTE_DIVERGED_ALERT);
  if (diverged && "old_remote_tip" in diverged.detail) return { code: GIT_REMOTE_DIVERGED_ALERT, detail: diverged.detail };
  const forked = activeAlert(ctx, GIT_REMOTE_FORKED_ALERT);
  if (forked) return { code: GIT_REMOTE_FORKED_ALERT, detail: forked.detail };
  return null;
}

function pausedError(paused: { code: string; detail: Record<string, unknown> }): EngineError {
  const d = paused.detail as unknown as DivergedDetail & { fork?: string };
  const message = paused.code === GIT_REMOTE_FORKED_ALERT
    ? forkedMessage(d.remote, d.branch, d.fork ?? "")
    : rewrittenMessage(d.remote, d.branch, d.remote_tip ?? null, d.old_remote_tip ?? null);
  // The data in the pinned key order (the alert row stores its detail canonically sorted).
  const data: Record<string, unknown> = { remote: d.remote, branch: d.branch, local_tip: d.local_tip ?? null, remote_tip: d.remote_tip ?? null, old_remote_tip: d.old_remote_tip ?? null, ...(d.fork !== undefined ? { fork: d.fork } : {}) };
  return new EngineError("git_remote_diverged", message, { data, retriable: true });
}

function pendingMergeError(ctx: WorkerContext, r: GitRemoteConfig): EngineError | null {
  const conflict = activeAlert(ctx, GIT_MERGE_CONFLICT_ALERT);
  if (!conflict) return null;
  const paths = (conflict.detail.paths as string[] | undefined) ?? [];
  return new EngineError("git_merge_conflict", conflictMessage(r.name, r.branch, (conflict.detail.remote_tip as string | null) ?? null, paths), { data: conflict.detail, retriable: true });
}

// ---- the pinned messages (byte for byte in both engines) ----

export function rejectedMessage(remote: string, branch: string, remoteTip: string | null, localTip: string | null): string {
  return `push to ${remote}/${branch} was rejected: the remote is at ${remoteTip ?? "an unknown tip"}, which does not descend from ${localTip ?? "our tip"} — run omg history fetch to merge the remote's commits, then push again`;
}
export function rewrittenMessage(remote: string, branch: string, remoteTip: string | null, oldRemoteTip: string | null): string {
  return `the remote ${remote}/${branch} was rewritten: its tip ${remoteTip ?? "(none)"} does not descend from the last known ${oldRemoteTip ?? "(none — unrelated histories)"} — push and fetch are paused while checkpoints continue locally; choose omg history remote reconcile --rebase | --merge | --adopt | --fork`;
}
export function conflictMessage(remote: string, branch: string, remoteTip: string | null, paths: string[]): string {
  return `the merge of ${remote}/${branch} at ${remoteTip ?? "(none)"} left ${paths.length} conflict(s): ${paths.join(", ")} — both versions are in the vault; settle each with omg history remote resolve <path> --ours|--theirs`;
}
export function forkedMessage(remote: string, branch: string, fork: string): string {
  return `the engine's branch was pushed to ${remote}/${fork} — merge it into ${branch} with git, then run omg history remote reconcile --adopt (push and fetch stay paused until then)`;
}

// ---- the binding ----

/** `history remote set`: the remote in the bare repository and the row's `remote` member; returns the config as written. */
export function remoteSet(ctx: WorkerContext, opts: GitRemoteOptions, now: string): GitHistoryConfig {
  const remote = remoteConfigFor(opts, ctx.config.branch);
  ctx.git.init(ctx.config.branch);
  const previous = ctx.config.remote;
  if (previous && previous.name !== remote.name) forgetRemote(ctx, previous, now);
  ctx.git.setRemote(remote.name, remote.url);
  const config: GitHistoryConfig = { ...ctx.config, remote };
  updateHistoryProviderConfig(ctx.store.db, ctx.repoId, config, now);
  return config;
}

/** `history remote unset`: the remote, its tracking and bookkeeping refs, the alerts about it and the row's binding leave; the pushed record is cleared. */
export function remoteUnset(ctx: WorkerContext, now: string): GitHistoryConfig {
  const previous = ctx.config.remote;
  if (previous) forgetRemote(ctx, previous, now);
  const config: GitHistoryConfig = { ...ctx.config, remote: null };
  updateHistoryProviderConfig(ctx.store.db, ctx.repoId, config, now);
  writeGitPushed(ctx.store.db, ctx.repoId, repoEpoch(ctx.store.db, ctx.repoId), null);
  return config;
}

function forgetRemote(ctx: WorkerContext, r: GitRemoteConfig, now: string): void {
  if (ctx.git.exists()) {
    ctx.git.removeRemote(r.name);
    for (const ref of [trackingRef(r), idsTrackingRef(r), divergedRef(r), mergeRef(r)]) ctx.git.deleteRef(ref);
  }
  for (const code of [GIT_REMOTE_DIVERGED_ALERT, GIT_MERGE_CONFLICT_ALERT, GIT_REMOTE_FORKED_ALERT]) clearAlert(ctx.store.db, ctx.repoId, code, now);
}

/** The seq a tip's `omgbase-seq` trailer covers when it is of `epoch`, else null. */
function seqOf(git: GitRepo, tip: string | null, epoch: string): number | null {
  if (tip === null) return null;
  const t = parseMessage(git.message(tip));
  return t && t.epoch === epoch ? t.to : null;
}

/** `history remote status` (local refs only — no network): where the two sides stand. */
export function remoteStatus(ctx: WorkerContext): RemoteStatus {
  const r = requireRemote(ctx);
  const git = ctx.git;
  const local = git.exists() ? git.tip(ctx.config.branch) : null;
  const remote = git.exists() ? git.ref(trackingRef(r)) : null;
  const cursor = readGitCursor(ctx.store.db, ctx.repoId);
  let state: HistoryRemoteState;
  if (remote === null || local === null) state = "unknown";
  else if (activeAlert(ctx, GIT_REMOTE_DIVERGED_ALERT) !== null || activeAlert(ctx, GIT_REMOTE_FORKED_ALERT) !== null) state = "diverged";
  else if (local === remote) state = "in-sync";
  else if (git.isAncestor(remote, local)) state = "ahead";
  else if (git.isAncestor(local, remote)) state = "behind";
  else state = "diverged";
  return { remote: r.name, branch: r.branch, local_tip: local, remote_tip: remote, pushed_through: cursor?.pushed?.seq ?? null, state };
}

/** `version.capabilities.history.remote`. */
export function remoteSummary(ctx: WorkerContext): HistoryRemoteSummary | null {
  if (!ctx.config.remote) return null;
  const s = remoteStatus(ctx);
  return { name: s.remote, branch: s.branch, state: s.state, pushed_through: s.pushed_through };
}

// ---- push ----

/**
 * `history push`: the content branch (`refs/heads/<b>:refs/heads/<rb>`) and,
 * when it exists, the ids ref — never `--force`. A rejected push raises
 * `git_remote_diverged` (warning; `{ remote, branch, local_tip, remote_tip }`)
 * and throws it; the ids ref's rejection alone is reported (`ids:
 * "rejected"`) — two engines writing one remote's identities is 6c's.
 */
export function pushBranch(ctx: WorkerContext, now: string): HistoryPushResult & { ids: "pushed" | "rejected" | "none" } {
  const r = requireRemote(ctx);
  const paused = pausedBy(ctx);
  if (paused) throw pausedError(paused);
  // A merge with conflicts is waiting: the branch does not yet hold what the remote has, so a push could only be rejected — refuse with the conflict instead.
  const pending = pendingMergeError(ctx, r);
  if (pending) throw pending;
  const git = ctx.git;
  const epoch = repoEpoch(ctx.store.db, ctx.repoId);
  const local = git.exists() ? git.tip(ctx.config.branch) : null;
  if (local === null) return { pushed: false, tip: null, pushed_through: null, ids: "none" };
  const before = git.ref(trackingRef(r));
  const result = git.push(r.name, [`refs/heads/${ctx.config.branch}:refs/heads/${r.branch}`]);
  if (result.status === "rejected") {
    let remoteTip: string | null = null;
    try { remoteTip = git.lsRemote(r.name, `refs/heads/${r.branch}`); } catch { /* unreachable now: the rejection stands on its own */ }
    const detail: DivergedDetail = { remote: r.name, branch: r.branch, local_tip: local, remote_tip: remoteTip };
    const message = rejectedMessage(r.name, r.branch, remoteTip, local);
    raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_REMOTE_DIVERGED_ALERT, severity: "warning", message, detail: { ...detail } }, now);
    throw new EngineError("git_remote_diverged", message, { data: detail, retriable: true });
  }
  if (result.status === "failed") throw new Error(`push to ${r.name} failed: ${result.stderr}`);
  git.setRef(trackingRef(r), local);
  // A rejected push's alert ends with the push that lands.
  clearAlert(ctx.store.db, ctx.repoId, GIT_REMOTE_DIVERGED_ALERT, now);
  const seq = seqOf(git, local, epoch) ?? readGitCursor(ctx.store.db, ctx.repoId)?.seq ?? null;
  writeGitPushed(ctx.store.db, ctx.repoId, epoch, { tip: local, seq });
  let ids: "pushed" | "rejected" | "none" = "none";
  const idsTip = git.ref(ctx.config.ids_ref);
  if (idsTip !== null) {
    const ir = git.push(r.name, [`${ctx.config.ids_ref}:${ctx.config.ids_ref}`]);
    if (ir.status === "ok") { git.setRef(idsTrackingRef(r), idsTip); ids = "pushed"; }
    else if (ir.status === "rejected") ids = "rejected";
    else throw new Error(`push of ${ctx.config.ids_ref} to ${r.name} failed: ${ir.stderr}`);
  }
  return { pushed: before !== local, tip: local, pushed_through: seq, ids };
}

// ---- fetch and the tree-level merge ----

interface ThreeWay {
  /** the remote's changes we did not touch: `path → blob | null` */
  theirsOnly: Map<string, string | null>;
  /** paths both sides changed to different blobs */
  conflicts: string[];
}

/** The per-path rule of spec/store §5.12 "Merge": one side changed → take it; both to the same blob → take it; both to different blobs → conflict. */
function threeWay(git: GitRepo, base: string | null, ours: string, theirs: string): ThreeWay {
  const baseTree = base ?? EMPTY_TREE;
  const ourChanges = git.diffTrees(baseTree, ours);
  const theirChanges = git.diffTrees(baseTree, theirs);
  const theirsOnly = new Map<string, string | null>();
  const conflicts: string[] = [];
  for (const [path, blob] of theirChanges) {
    if (!ourChanges.has(path)) theirsOnly.set(path, blob);
    else if (ourChanges.get(path) !== blob) conflicts.push(path);
  }
  conflicts.sort();
  return { theirsOnly, conflicts };
}

function blobChanges(git: GitRepo, changes: Map<string, string | null>): { path: string; content: Buffer | null }[] {
  return [...changes].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([path, blob]) => ({ path, content: blob === null ? null : git.blob(blob) }));
}

/** The position the worker will resume from after the branch moves: the current resume position, else the feed head before anything is ingested. */
function positionBeforeApply(ctx: WorkerContext, epoch: string): number {
  return resumePosition(ctx, epoch)?.seq ?? feedStatus(ctx.store.db, ctx.repoId).head;
}

function mergeTrailers(ctx: WorkerContext, epoch: string, seq: number, now: string, remoteTip: string): CommitTrailers {
  return { epoch, from: seq, to: seq, ts: now, commits: [], origin: null, actor: null, plan: null, docs: [], rescan: null, merge: remoteTip, content: null };
}

/** The merge commit: `tree` over parents (ours, theirs), subject `merge <name>/<rb>`, trailer `omgbase-merge: <remote tip>`. */
function writeMergeCommit(ctx: WorkerContext, r: GitRemoteConfig, tree: string, ours: string, theirs: string, seq: number, now: string): string {
  const epoch = repoEpoch(ctx.store.db, ctx.repoId);
  const message = renderMessage(`merge ${r.name}/${r.branch}`, mergeTrailers(ctx, epoch, seq, now, theirs));
  const sha = ctx.git.commitTree(tree, [ours, theirs], message, { author: ctx.identity, committer: ctx.identity, ts: now });
  ctx.git.updateRef(ctx.config.branch, sha, ours);
  writeGitCursor(ctx.store.db, ctx.repoId, { tip: sha, epoch, seq });
  return sha;
}

/** Record a merge with conflicts: the remote's versions as sidecars in the vault, the pending ref, the alert. */
function recordConflicts(ctx: WorkerContext, r: GitRemoteConfig, remoteTip: string, conflicts: string[], now: string, extra: Record<string, unknown> = {}): void {
  ctx.git.setRef(mergeRef(r), remoteTip);
  const detail = { remote: r.name, branch: r.branch, remote_tip: remoteTip, paths: conflicts, ...extra };
  raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_MERGE_CONFLICT_ALERT, severity: "warning", message: conflictMessage(r.name, r.branch, remoteTip, conflicts), detail }, now);
}

/** The remote's versions of the conflicting paths as sidecars (`<stem>.remote-<short>.md`); a path the remote deleted gets no sidecar. */
function remoteSidecars(git: GitRepo, remoteTip: string, conflicts: string[]): { path: string; content: Buffer | null }[] {
  const theirs = git.treeEntries(remoteTip);
  const out: { path: string; content: Buffer | null }[] = [];
  for (const path of conflicts) {
    const blob = theirs.get(path);
    if (blob !== undefined) out.push({ path: sidecarPath(path, "remote", remoteTip), content: git.blob(blob) });
  }
  return out;
}

/**
 * `history fetch` (spec/store §5.12 "Fetch"): fetch `<name>/<rb>` into the
 * tracking ref (and the remote's ids ref when it has one), then — nothing new:
 * `nothing`; the remote rewritten (its tip does not descend from the tip we
 * last knew, or unrelated histories): `diverged` — the alert, the old tip
 * kept, push and fetch paused; we are behind: the remote's tree changes into
 * the vault through the sink, then our branch fast-forwarded; both moved: the
 * three-way merge — clean: the remote's changes into the vault and one merge
 * commit; conflicts: the remote's versions beside ours, the alert, no merge
 * commit until `resolve`.
 */
export function fetchRemote(ctx: WorkerContext, now: string, vault: HistoryVaultSink): FetchResult {
  const r = requireRemote(ctx);
  const paused = pausedBy(ctx);
  if (paused) throw pausedError(paused);
  const pending = pendingMergeError(ctx, r);
  if (pending) throw pending;
  const git = ctx.git;
  git.init(ctx.config.branch);
  const epoch = repoEpoch(ctx.store.db, ctx.repoId);
  const local = git.tip(ctx.config.branch);
  const old = git.ref(trackingRef(r));
  const remoteHas = git.lsRemote(r.name, `refs/heads/${r.branch}`);
  if (remoteHas === null) return { state: "nothing", remote_tip: null, tip: local, applied: [], conflicts: [] };
  const err = git.fetch(r.name, [`+refs/heads/${r.branch}:${trackingRef(r)}`]);
  if (err !== null) throw new Error(`fetch from ${r.name} failed: ${err}`);
  if (git.lsRemote(r.name, ctx.config.ids_ref) !== null) git.fetch(r.name, [`+${ctx.config.ids_ref}:${idsTrackingRef(r)}`]);
  const remoteTip = git.ref(trackingRef(r))!;
  // A rejected push's alert is about a remote we have now fetched: it ends here (the merge below settles it, or the divergence alert replaces it).
  clearAlert(ctx.store.db, ctx.repoId, GIT_REMOTE_DIVERGED_ALERT, now);
  if (remoteTip === old || remoteTip === local) return { state: "nothing", remote_tip: remoteTip, tip: local, applied: [], conflicts: [] };
  const rewritten = old !== null ? !git.isAncestor(old, remoteTip) : local !== null && git.mergeBase(local, remoteTip) === null;
  if (rewritten) {
    if (old !== null) git.setRef(divergedRef(r), old);
    const detail: DivergedDetail = { remote: r.name, branch: r.branch, local_tip: local, remote_tip: remoteTip, old_remote_tip: old };
    raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_REMOTE_DIVERGED_ALERT, severity: "warning", message: rewrittenMessage(r.name, r.branch, remoteTip, old), detail: { ...detail } }, now);
    return { state: "diverged", remote_tip: remoteTip, old_remote_tip: old, tip: local, applied: [], conflicts: [] };
  }
  if (local === null || git.isAncestor(local, remoteTip)) {
    // Behind: the remote's changes enter through the vault, then the branch follows.
    const seq = positionBeforeApply(ctx, epoch);
    const changes = blobChanges(git, git.diffTrees(local ?? EMPTY_TREE, remoteTip));
    vault.apply(changes, now);
    git.updateRef(ctx.config.branch, remoteTip, local);
    writeGitCursor(ctx.store.db, ctx.repoId, { tip: remoteTip, epoch, seq });
    return { state: "fast-forward", remote_tip: remoteTip, tip: remoteTip, applied: changes.map((c) => c.path), conflicts: [] };
  }
  if (git.isAncestor(remoteTip, local)) return { state: "nothing", remote_tip: remoteTip, tip: local, applied: [], conflicts: [] }; // ahead: a push is due, nothing to merge
  // Both moved: the three-way merge at the tree level with the ancestor git supplies.
  const base = git.mergeBase(local, remoteTip);
  const { theirsOnly, conflicts } = threeWay(git, base, local, remoteTip);
  const seq = positionBeforeApply(ctx, epoch);
  const changes = [...blobChanges(git, theirsOnly), ...remoteSidecars(git, remoteTip, conflicts)];
  vault.apply(changes, now);
  if (conflicts.length > 0) {
    recordConflicts(ctx, r, remoteTip, conflicts, now, { base });
    return { state: "conflict", remote_tip: remoteTip, tip: local, applied: changes.map((c) => c.path), conflicts };
  }
  const tree = git.buildTree(git.treeOf(local), [...theirsOnly].filter(([, b]) => b !== null).map(([path, blob]) => ({ path, blob: blob! })), [...theirsOnly].filter(([, b]) => b === null).map(([p]) => p));
  const merged = writeMergeCommit(ctx, r, tree, local, remoteTip, seq, now);
  return { state: "merged", remote_tip: remoteTip, tip: merged, applied: changes.map((c) => c.path), conflicts: [] };
}

// ---- resolve ----

/**
 * `history remote resolve <path> --ours|--theirs`: the sidecar leaves the
 * vault (`--theirs` first writes the remote's version over ours); the path
 * leaves the alert; when none remains the pending merge — if one waits — is
 * committed over the resolution the worker just checkpointed.
 */
export function resolveConflict(ctx: WorkerContext, now: string, vault: HistoryVaultSink, path: string, choice: ResolveChoice): ResolveResult {
  const r = requireRemote(ctx);
  const conflict = activeAlert(ctx, GIT_MERGE_CONFLICT_ALERT);
  if (!conflict) throw new Error("no merge conflict is pending for this repository");
  const paths = (conflict.detail.paths as string[] | undefined) ?? [];
  if (!paths.includes(path)) throw new Error(`${path} is not a pending conflict (pending: ${paths.join(", ")})`);
  const remoteTip = (conflict.detail.remote_tip as string | null) ?? null;
  const holds = ((conflict.detail.holds as Record<string, "theirs" | "ours"> | undefined) ?? {})[path] ?? "theirs";
  const sidecar = ((conflict.detail.sidecars as Record<string, string> | undefined) ?? {})[path] ?? (remoteTip ? sidecarPath(path, "remote", remoteTip) : null);
  const changes: { path: string; content: Buffer | null }[] = [];
  const git = ctx.git;
  if (holds === "theirs") {
    // The vault holds OURS at the path, THEIRS in the sidecar.
    if (choice === "theirs" && remoteTip) {
      const blob = git.treeEntries(remoteTip).get(path);
      changes.push({ path, content: blob === undefined ? null : git.blob(blob) });
    }
  } else if (choice === "ours" && sidecar) {
    // `--adopt` left THEIRS at the path, OURS in the sidecar: ours comes back.
    const live = ctx.store.db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_at IS NULL").get(ctx.repoId, sidecar) as { doc_id: string } | undefined;
    const bytes = live ? reconstructContent(ctx.store.db, live.doc_id) : null;
    if (bytes !== null) changes.push({ path, content: Buffer.from(bytes) });
  }
  if (sidecar) changes.push({ path: sidecar, content: null });
  vault.apply(changes, now);
  const remaining = paths.filter((p) => p !== path);
  let merged: string | null = null;
  if (remaining.length > 0) {
    raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_MERGE_CONFLICT_ALERT, severity: "warning", message: conflictMessage(r.name, r.branch, remoteTip, remaining), detail: { ...conflict.detail, paths: remaining } }, now);
  } else {
    clearAlert(ctx.store.db, ctx.repoId, GIT_MERGE_CONFLICT_ALERT, now);
    const waiting = git.ref(mergeRef(r));
    if (waiting !== null) {
      // The resolution is checkpointed first, so the merge commit's tree is the vault's.
      runCheckpoint(ctx, { now });
      const tip = git.tip(ctx.config.branch)!;
      const seq = resumePosition(ctx, repoEpoch(ctx.store.db, ctx.repoId))?.seq ?? feedStatus(ctx.store.db, ctx.repoId).head;
      merged = writeMergeCommit(ctx, r, git.treeOf(tip), tip, waiting, seq, now);
      git.deleteRef(mergeRef(r));
    }
  }
  return { path, choice, remaining, merged, tip: git.tip(ctx.config.branch) };
}

// ---- the divergence remediations ----

function requireDivergence(ctx: WorkerContext): { detail: DivergedDetail & { fork?: string } } {
  const paused = pausedBy(ctx);
  if (!paused) throw new Error("the remote is not diverged: history remote reconcile applies only while the git_remote_diverged (or git_remote_forked) alert is active");
  return { detail: paused.detail as unknown as DivergedDetail & { fork?: string } };
}

function clearDivergence(ctx: WorkerContext, r: GitRemoteConfig, now: string): void {
  clearAlert(ctx.store.db, ctx.repoId, GIT_REMOTE_DIVERGED_ALERT, now);
  clearAlert(ctx.store.db, ctx.repoId, GIT_REMOTE_FORKED_ALERT, now);
  ctx.git.deleteRef(divergedRef(r));
}

function backup(ctx: WorkerContext, tip: string, now: string): string {
  ctx.git.setRef(`refs/omgbase/backup/${tsSegment(now)}`, tip);
  return tip;
}

/** `history remote reconcile --rebase|--merge|--adopt|--fork`. */
export function reconcileRemote(ctx: WorkerContext, now: string, vault: HistoryVaultSink, mode: ReconcileMode): ReconcileResult {
  const r = requireRemote(ctx);
  const { detail } = requireDivergence(ctx);
  const git = ctx.git;
  const epoch = repoEpoch(ctx.store.db, ctx.repoId);
  const local = git.tip(ctx.config.branch);
  const remoteTip = git.ref(trackingRef(r)) ?? detail.remote_tip ?? null;
  const old = git.ref(divergedRef(r)) ?? detail.old_remote_tip ?? null;
  if (local === null || remoteTip === null) throw new Error("nothing to reconcile: the branch or the remote has no tip");
  const result: ReconcileResult = { mode, tip: local, backup: null, rewritten: 0, fork: null, applied: [], conflicts: [] };

  if (mode === "fork") {
    const fork = `${r.branch}-omgbase-${tsSegment(now)}`;
    const pushed = git.push(r.name, [`refs/heads/${ctx.config.branch}:refs/heads/${fork}`]);
    if (pushed.status !== "ok") throw new Error(`push of the fork ${fork} to ${r.name} failed: ${pushed.stderr}`);
    clearDivergence(ctx, r, now);
    raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_REMOTE_FORKED_ALERT, severity: "warning", message: forkedMessage(r.name, r.branch, fork), detail: { remote: r.name, branch: r.branch, fork, local_tip: local, remote_tip: remoteTip, old_remote_tip: old } }, now);
    return { ...result, fork };
  }

  if (mode === "adopt") {
    // The remote's head becomes truth: its tree into the vault; a path we edited since the last agreement keeps our version beside it.
    const theirs = git.treeEntries(remoteTip);
    const ours = git.treeEntries(local);
    const base = old !== null ? git.treeEntries(old) : new Map<string, string>();
    const changes: { path: string; content: Buffer | null }[] = [];
    const conflicts: string[] = [];
    const sidecars: Record<string, string> = {};
    const holds: Record<string, "ours"> = {};
    for (const path of [...new Set([...theirs.keys(), ...ours.keys()])].sort()) {
      const t = theirs.get(path) ?? null;
      const o = ours.get(path) ?? null;
      const b = base.get(path) ?? null;
      if (t === o) continue;
      if (o === b) { changes.push({ path, content: t === null ? null : git.blob(t) }); continue; } // only the remote changed it
      if (t === null && b === null) continue; // ours alone, new on our side: kept, committed on top
      // A local edit the remote does not have: the remote's version takes the path, ours stays beside it.
      const side = sidecarPath(path, "local", local);
      changes.push({ path, content: t === null ? null : git.blob(t) });
      if (o !== null) changes.push({ path: side, content: git.blob(o) });
      conflicts.push(path);
      sidecars[path] = side;
      holds[path] = "ours";
    }
    const seq = positionBeforeApply(ctx, epoch);
    vault.apply(changes, now);
    result.backup = backup(ctx, local, now);
    git.updateRef(ctx.config.branch, remoteTip, local);
    writeGitCursor(ctx.store.db, ctx.repoId, { tip: remoteTip, epoch, seq });
    clearDivergence(ctx, r, now);
    if (conflicts.length > 0) {
      const d = { remote: r.name, branch: r.branch, remote_tip: remoteTip, paths: conflicts, sidecars, holds };
      raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_MERGE_CONFLICT_ALERT, severity: "warning", message: conflictMessage(r.name, r.branch, remoteTip, conflicts), detail: d }, now);
    }
    return { ...result, tip: remoteTip, applied: changes.map((c) => c.path), conflicts };
  }

  if (mode === "merge") {
    // One merge commit with the old remote tip as the base (what both sides last agreed on); both histories kept.
    const base = old ?? git.mergeBase(local, remoteTip);
    const { theirsOnly, conflicts } = threeWay(git, base, local, remoteTip);
    const seq = positionBeforeApply(ctx, epoch);
    const changes = [...blobChanges(git, theirsOnly), ...remoteSidecars(git, remoteTip, conflicts)];
    vault.apply(changes, now);
    clearDivergence(ctx, r, now);
    if (conflicts.length > 0) {
      recordConflicts(ctx, r, remoteTip, conflicts, now, { base });
      return { ...result, applied: changes.map((c) => c.path), conflicts };
    }
    result.backup = backup(ctx, local, now);
    const tree = git.buildTree(git.treeOf(local), [...theirsOnly].filter(([, b]) => b !== null).map(([path, blob]) => ({ path, blob: blob! })), [...theirsOnly].filter(([, b]) => b === null).map(([p]) => p));
    const merged = writeMergeCommit(ctx, r, tree, local, remoteTip, seq, now);
    return { ...result, tip: merged, rewritten: 1, applied: changes.map((c) => c.path), conflicts: [] };
  }

  // --rebase: replay our unpushed checkpoints onto the new remote head, per file three-way with the old remote tip as base.
  const oursCommits = git.revList(old, local);
  let running = remoteTip;
  const conflicts = new Set<string>();
  const rewrittenMap = new Map<string, string>();
  for (const c of oursCommits) {
    const parents = git.parentsOf(c);
    const firstParent = parents[0] ?? null;
    const diff = git.diffTrees(firstParent ?? EMPTY_TREE, c);
    const parentTree = firstParent ? git.treeEntries(firstParent) : new Map<string, string>();
    const runningTree = git.treeEntries(running);
    const adds: { path: string; blob: string }[] = [];
    const removes: string[] = [];
    for (const [path, blob] of diff) {
      const current = runningTree.get(path) ?? null;
      const before = parentTree.get(path) ?? null;
      if (current === blob) continue; // the remote did the same
      if (current !== before) conflicts.add(path); // the remote changed it too: ours stands, theirs beside it (below)
      if (blob === null) { if (current !== null) removes.push(path); } else adds.push({ path, blob });
    }
    const tree = adds.length === 0 && removes.length === 0 ? git.treeOf(running) : git.buildTree(git.treeOf(running), adds, removes);
    const message = git.message(c).replace(/\n$/, "");
    const trailers = parseMessage(message);
    const author = git.authorOf(c);
    const newParents = [running, ...parents.slice(1).map((p) => rewrittenMap.get(p) ?? p)];
    const sha = git.commitTree(tree, newParents, message, { author: { name: author.name, email: ctx.identity.email }, committer: ctx.identity, ts: trailers?.ts || now });
    rewrittenMap.set(c, sha);
    running = sha;
  }
  // The remote's changes since the old tip that we never touched enter the vault; the conflicting paths' remote versions beside ours.
  const { theirsOnly } = threeWay(git, old, local, remoteTip);
  const conflictPaths = [...conflicts].sort();
  const changes = [...blobChanges(git, theirsOnly), ...remoteSidecars(git, remoteTip, conflictPaths)];
  const seq = positionBeforeApply(ctx, epoch);
  vault.apply(changes, now);
  result.backup = backup(ctx, local, now);
  git.updateRef(ctx.config.branch, running, local);
  writeGitCursor(ctx.store.db, ctx.repoId, { tip: running, epoch, seq });
  rebaseIds(ctx, r, rewrittenMap, now);
  clearDivergence(ctx, r, now);
  if (conflictPaths.length > 0) {
    const d = { remote: r.name, branch: r.branch, remote_tip: remoteTip, paths: conflictPaths };
    raiseAlert(ctx.store.db, ctx.repoId, { code: GIT_MERGE_CONFLICT_ALERT, severity: "warning", message: conflictMessage(r.name, r.branch, remoteTip, conflictPaths), detail: d }, now);
  }
  return { ...result, tip: running, rewritten: oursCommits.length, applied: changes.map((c) => c.path), conflicts: conflictPaths };
}

/**
 * The ids ref rebased alongside: every ids commit whose `omgbase-content`
 * names a rewritten content commit is replayed — its tree changes over the
 * remote's ids tip when we have fetched one (else over its own base) — with
 * the trailer re-pointed at the rewritten sha. Identities are ours
 * throughout; the remote's ids chain, when it differs, is 6c's reconciliation.
 */
function rebaseIds(ctx: WorkerContext, r: GitRemoteConfig, rewritten: Map<string, string>, now: string): void {
  const git = ctx.git;
  const idsTip = git.ref(ctx.config.ids_ref);
  if (idsTip === null || rewritten.size === 0) return;
  const chain = git.revList(null, idsTip);
  const first = chain.findIndex((c) => { const t = parseMessage(git.message(c)); return t?.content !== null && t?.content !== undefined && rewritten.has(t.content); });
  if (first < 0) return;
  const replay = chain.slice(first);
  const base = git.ref(idsTrackingRef(r)) ?? git.parentsOf(replay[0]!)[0] ?? null;
  let running = base;
  for (const c of replay) {
    const parent = git.parentsOf(c)[0] ?? null;
    const diff = git.diffTrees(parent ?? EMPTY_TREE, c);
    const adds = [...diff].filter(([, b]) => b !== null).map(([path, blob]) => ({ path, blob: blob! }));
    const removes = [...diff].filter(([, b]) => b === null).map(([p]) => p);
    const runningTree = running === null ? null : git.treeOf(running);
    const tree = git.buildTree(runningTree, adds, removes.filter((p) => running !== null && git.treeEntries(running).has(p)));
    const message = git.message(c).replace(/\n$/, "").replace(/^omgbase-content: ([0-9a-f]{40})$/m, (_m, sha: string) => `omgbase-content: ${rewritten.get(sha) ?? sha}`);
    const t = parseMessage(message);
    const author = git.authorOf(c);
    running = git.commitTree(tree, running, message, { author: { name: author.name, email: ctx.identity.email }, committer: ctx.identity, ts: t?.ts || now });
  }
  if (running !== null) git.updateRefRaw(ctx.config.ids_ref, running, idsTip);
}

// ---- the sweep's steps 7–8 ----

/** `remoteSync` of the provider seam (spec/sync §4.3 steps 7–8): push on `periodic`, fetch on `periodic`; both skipped while paused or while a merge waits. */
export function remoteSync(ctx: WorkerContext, now: string, vault: HistoryVaultSink): HistoryRemoteSyncResult | null {
  const r = ctx.config.remote;
  if (!r) return null;
  if (pausedBy(ctx) !== null || activeAlert(ctx, GIT_MERGE_CONFLICT_ALERT) !== null) return { pushed: null, fetched: null, paused: true };
  const out: HistoryRemoteSyncResult = { pushed: null, fetched: null, paused: false };
  if (r.fetch === "periodic") {
    try { out.fetched = fetchRemote(ctx, now, vault) as unknown as Record<string, unknown>; } catch (e) { out.fetched = { error: e instanceof Error ? e.message : String(e) }; }
  }
  if (r.push === "periodic") {
    try { out.pushed = pushBranch(ctx, now); } catch (e) { out.pushed = { error: e instanceof Error ? e.message : String(e) }; }
  }
  return out;
}

/** `push: "on-checkpoint"`: after a checkpoint that committed, the push — its error reported on the receipt, never thrown (the checkpoint stands). */
export function pushAfterCheckpoint(ctx: WorkerContext, now: string, committed: number): HistoryPushResult | { error: string } | undefined {
  const r = ctx.config.remote;
  if (!r || r.push !== "on-checkpoint" || committed === 0) return undefined;
  try {
    return pushBranch(ctx, now);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
