// @omgbase/git-adapter — the Git-backed history provider (modular-core Phase
// 6a; spec/store §5.12, spec/surface §3/§4, spec/cli `history`, spec/sync §6).
// The core knows a `HistoryProvider` by name; this package is the one named
// `git`. Nothing here is imported by `@omgbase/core`: the CLI/MCP host registers
// `gitHistoryProvider()` before it opens a store.
export { GitHistoryProvider, gitHistoryProvider, DEFAULT_IDENTITY, FIXTURE_IDENTITY, type GitProviderOptions } from "./provider.js";
export { GitHistoryReader } from "./reader.js";
export { runCheckpoint, commitSnapshot, tipPosition, resumePosition, type WorkerContext } from "./worker.js";
export { idsRecord, idsBlobText, idsPath, idsPosition, syncIds, IDS_PREFIX, type IdsRecord, type IdsBlock } from "./ids.js";
export {
  remoteSet, remoteUnset, remoteStatus, remoteSummary, pushBranch, fetchRemote, resolveConflict, reconcileRemote, remoteSync, pushAfterCheckpoint, pausedBy, sidecarPath, tsSegment,
  rejectedMessage, rewrittenMessage, conflictMessage, forkedMessage,
  GIT_REMOTE_DIVERGED_ALERT, GIT_MERGE_CONFLICT_ALERT, GIT_REMOTE_FORKED_ALERT,
  type RemoteStatus, type FetchResult, type FetchState, type ResolveResult, type ResolveChoice, type ReconcileResult, type ReconcileMode,
} from "./remote.js";
export { createCheckpointScheduler, type CheckpointScheduler, type SchedulerOptions } from "./scheduler.js";
export { GitRepo, GitError, gitAvailable, resetGitProbe, gitDate, gitBin, GIT_BIN_ENV, ZERO_SHA, EMPTY_TREE, SHA_RE, type GitIdentity, type CommitIdentity } from "./git.js";
export { renderMessage, parseMessage, subjectOf, seqValue, TRAILER_PREFIX, type CommitTrailers, type DocTrailer } from "./trailers.js";
export {
  GIT_PROVIDER, DEFAULT_GIT_DIR, DEFAULT_BRANCH, IDS_REF, DEFAULT_REMOTE_NAME, PUSH_POLICIES, FETCH_POLICIES, gitConfigFor, readGitConfig, readRemoteConfig, remoteConfigFor, validRemoteName, parseCadence, refuseCredentials,
  type GitHistoryConfig, type GitCadence, type GitRemoteConfig, type GitRemoteOptions, type GitPushPolicy, type GitFetchPolicy, type GitEnableOptions,
} from "./config.js";
export { GIT_CURSOR_SOURCE, readGitCursor, writeGitCursor, writeGitPushed, clearGitCursor, type GitCursor, type GitPushed } from "./cursor.js";
export { ensureExcluded, excludeFileFor, EXCLUDE_LINE } from "./exclude.js";
