import { dirname, resolve } from "node:path";
import type { Store, CommitRecord, HistoryProvider, HistoryProviderAvailability, HistoryProviderConfig, HistoryCheckpointResult, HistoryProviderFactory, HistoryPushResult, HistoryRemoteSummary, HistoryRemoteSyncResult, HistoryVaultSink } from "@omgbase/core";
import { GitRepo, gitAvailable, type GitIdentity } from "./git.js";
import { GitHistoryReader } from "./reader.js";
import { GIT_PROVIDER, gitConfigFor, readGitConfig, type GitCadence, type GitHistoryConfig, type GitRemoteOptions } from "./config.js";
import { fetchRemote, pushAfterCheckpoint, pushBranch, reconcileRemote, remoteSet, remoteStatus, remoteSummary, remoteSync, remoteUnset, resolveConflict, type FetchResult, type ReconcileMode, type ReconcileResult, type RemoteStatus, type ResolveChoice, type ResolveResult } from "./remote.js";
import { commitSnapshot, runCheckpoint, type WorkerContext } from "./worker.js";
import { clearGitCursor } from "./cursor.js";
import { ensureExcluded } from "./exclude.js";

// The git history provider (spec/store §5.12; modular-core Phase 6a): the
// `HistoryProvider` the composition layer registers under the name `git`
// (`registerHistoryProvider("git", gitHistoryProvider(opts))` in the CLI's entry
// point, the MCP host and the fixture runners). One instance per `Store`; the
// bare repository of a repository lives at `<workspace>/.omgbase/git`
// (`config.git_dir`, relative to the workspace root — the parent of the
// store's `omgbaseDir`).

/** The committer identity in production. The author's name is the commit's actor when it has one. */
export const DEFAULT_IDENTITY: GitIdentity = { name: "omgbase", email: "omgbase@localhost" };
/** The identity the fixture runners and the CLI under the spec seams use (spec/store §9.4 "The git provider"): pinned shas follow from it. */
export const FIXTURE_IDENTITY: GitIdentity = { name: "omgbase", email: "omgbase@fixture" };

export interface GitProviderOptions {
  identity?: GitIdentity;
}

export class GitHistoryProvider implements HistoryProvider {
  readonly name = GIT_PROVIDER;
  private readonly identity: GitIdentity;

  constructor(private readonly store: Store, opts: GitProviderOptions = {}) {
    this.identity = opts.identity ?? DEFAULT_IDENTITY;
  }

  available(): HistoryProviderAvailability {
    if (this.store.omgbaseDir === null) return { ok: false, reason: "the store has no workspace directory to keep a bare repository under" };
    return gitAvailable();
  }

  /** The workspace root: the parent of `.omgbase`. */
  private root(): string {
    return dirname(this.store.omgbaseDir!);
  }

  private repoOf(config: GitHistoryConfig): GitRepo {
    return new GitRepo(resolve(this.root(), config.git_dir));
  }

  private context(repoId: string, config: GitHistoryConfig): WorkerContext {
    return { store: this.store, repoId, git: this.repoOf(config), config, identity: this.identity };
  }

  reader(repoId: string, config: HistoryProviderConfig): GitHistoryReader {
    const c = readGitConfig(config);
    return new GitHistoryReader(this.store, repoId, this.repoOf(c), c);
  }

  enable(repoId: string, commit: CommitRecord, opts: Record<string, unknown>): { config: HistoryProviderConfig; baseline: { revisions: number; tip: string | null } } {
    const config = gitConfigFor({ ...(typeof opts.branch === "string" ? { branch: opts.branch } : {}), ...(opts.cadence !== undefined ? { cadence: opts.cadence as GitCadence } : {}) });
    const ctx = this.context(repoId, config);
    ctx.git.init(config.branch);
    ensureExcluded(this.root());
    const snap = commitSnapshot(ctx, commit.ts, commit);
    return { config, baseline: { revisions: snap.documents, tip: snap.tip } };
  }

  purge(repoId: string, config: HistoryProviderConfig): { removed: boolean; path: string } {
    const c = readGitConfig(config);
    const git = this.repoOf(c);
    const removed = git.remove();
    clearGitCursor(this.store.db, repoId);
    return { removed, path: git.gitDir };
  }

  checkpoint(repoId: string, config: HistoryProviderConfig, opts: { now?: string } = {}): HistoryCheckpointResult {
    const ctx = this.context(repoId, readGitConfig(config));
    const result = runCheckpoint(ctx, opts);
    // `push: "on-checkpoint"` (17.6): the push follows a checkpoint that committed; its outcome rides on the receipt.
    const push = pushAfterCheckpoint(ctx, opts.now ?? new Date().toISOString(), result.committed);
    return push === undefined ? result : { ...result, push };
  }

  // ---- the remote half (17.6, Phase 6b; `remote.ts`) ----

  remoteSummary(repoId: string, config: HistoryProviderConfig): HistoryRemoteSummary | null {
    return remoteSummary(this.context(repoId, readGitConfig(config)));
  }

  remoteSync(repoId: string, config: HistoryProviderConfig, opts: { now: string; vault: HistoryVaultSink }): HistoryRemoteSyncResult | null {
    return remoteSync(this.context(repoId, readGitConfig(config)), opts.now, opts.vault);
  }

  /** `history remote set`: returns the config as written to the row. */
  remoteSet(repoId: string, config: HistoryProviderConfig, options: GitRemoteOptions, now: string = new Date().toISOString()): GitHistoryConfig {
    return remoteSet(this.context(repoId, readGitConfig(config)), options, now);
  }

  /** `history remote unset`. */
  remoteUnset(repoId: string, config: HistoryProviderConfig, now: string = new Date().toISOString()): GitHistoryConfig {
    return remoteUnset(this.context(repoId, readGitConfig(config)), now);
  }

  /** `history remote status` (local refs only). */
  remoteStatus(repoId: string, config: HistoryProviderConfig): RemoteStatus {
    return remoteStatus(this.context(repoId, readGitConfig(config)));
  }

  /** `history push`. */
  push(repoId: string, config: HistoryProviderConfig, now: string = new Date().toISOString()): HistoryPushResult & { ids: "pushed" | "rejected" | "none" } {
    return pushBranch(this.context(repoId, readGitConfig(config)), now);
  }

  /** `history fetch`: inbound content through `vault`. */
  fetch(repoId: string, config: HistoryProviderConfig, vault: HistoryVaultSink, now: string = new Date().toISOString()): FetchResult {
    return fetchRemote(this.context(repoId, readGitConfig(config)), now, vault);
  }

  /** `history remote resolve <path> --ours|--theirs`. */
  resolve(repoId: string, config: HistoryProviderConfig, vault: HistoryVaultSink, path: string, choice: ResolveChoice, now: string = new Date().toISOString()): ResolveResult {
    return resolveConflict(this.context(repoId, readGitConfig(config)), now, vault, path, choice);
  }

  /** `history remote reconcile --rebase|--merge|--adopt|--fork`. */
  reconcile(repoId: string, config: HistoryProviderConfig, vault: HistoryVaultSink, mode: ReconcileMode, now: string = new Date().toISOString()): ReconcileResult {
    return reconcileRemote(this.context(repoId, readGitConfig(config)), now, vault, mode);
  }

  /** The bare repository of a repository (the measurement script, tests). */
  gitRepo(config: HistoryProviderConfig): GitRepo {
    return this.repoOf(readGitConfig(config));
  }
}

/** The factory the composition layer registers: `registerHistoryProvider("git", gitHistoryProvider())`. */
export function gitHistoryProvider(opts: GitProviderOptions = {}): HistoryProviderFactory {
  return (store: Store) => new GitHistoryProvider(store, opts);
}
