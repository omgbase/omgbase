import { dirname, resolve } from "node:path";
import type { Store, CommitRecord, HistoryProvider, HistoryProviderAvailability, HistoryProviderConfig, HistoryCheckpointResult, HistoryProviderFactory } from "@omgbase/core";
import { GitRepo, gitAvailable, type GitIdentity } from "./git.js";
import { GitHistoryReader } from "./reader.js";
import { GIT_PROVIDER, gitConfigFor, readGitConfig, type GitCadence, type GitHistoryConfig } from "./config.js";
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
    return runCheckpoint(this.context(repoId, readGitConfig(config)), opts);
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
