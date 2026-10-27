// @omgbase/git-adapter — the Git-backed history provider (modular-core Phase
// 6a; spec/store §5.12, spec/surface §3/§4, spec/cli `history`, spec/sync §6).
// The core knows a `HistoryProvider` by name; this package is the one named
// `git`. Nothing here is imported by `@omgbase/core`: the CLI/MCP host registers
// `gitHistoryProvider()` before it opens a store.
export { GitHistoryProvider, gitHistoryProvider, DEFAULT_IDENTITY, FIXTURE_IDENTITY, type GitProviderOptions } from "./provider.js";
export { GitHistoryReader } from "./reader.js";
export { runCheckpoint, commitSnapshot, tipPosition, type WorkerContext } from "./worker.js";
export { GitRepo, GitError, gitAvailable, resetGitProbe, gitDate, gitBin, GIT_BIN_ENV, ZERO_SHA, SHA_RE, type GitIdentity, type CommitIdentity } from "./git.js";
export { renderMessage, parseMessage, subjectOf, seqValue, TRAILER_PREFIX, type CommitTrailers, type DocTrailer } from "./trailers.js";
export { GIT_PROVIDER, DEFAULT_GIT_DIR, DEFAULT_BRANCH, IDS_REF, gitConfigFor, readGitConfig, parseCadence, refuseCredentials, type GitHistoryConfig, type GitCadence, type GitRemoteConfig, type GitEnableOptions } from "./config.js";
export { GIT_CURSOR_SOURCE, readGitCursor, writeGitCursor, clearGitCursor, type GitCursor } from "./cursor.js";
export { ensureExcluded, excludeFileFor, EXCLUDE_LINE } from "./exclude.js";
