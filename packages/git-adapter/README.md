# @omgbase/git-adapter

The **Git-backed history provider** for [omgbase](https://github.com/omgbase/omgbase) — modular-core Phase 6a, the plan's "one alternative history strategy through the documented contract" (`spec/store` §5.12, `spec/surface` §3 "The git provider", `spec/cli` `history`, `spec/sync` §6). A repository's history is kept by **one provider**: the engine's native recorder (the store's own history tables, captured inside every commit) or this one — a **bare Git repository at `<workspace>/.omgbase/git`** whose commits are built from the database rows by a **checkpoint worker** that consumes the change feed. The core knows the provider only by name: `@omgbase/core` imports nothing from this package; the composition layer (the `omg` CLI / `omg mcp` host, a library embedding, the fixture runners) registers it before any store opens:

```ts
import { registerHistoryProvider } from "@omgbase/core";
import { gitHistoryProvider } from "@omgbase/git-adapter";

registerHistoryProvider("git", gitHistoryProvider());
```

Private to the monorepo (like `@omgbase/elements`): the `omgbase` CLI depends on it and is what ships it.

## What it does

- **`omg history enable --provider git [--branch <b>] [--cadence every|<ms>]`** initialises the bare repository, ensures `.omgbase/` is listed in the user's `.git/info/exclude` (never `.gitignore` — a tracked file is never edited), writes the manifest row `{ provider: "git", git_dir: ".omgbase/git", branch, cadence, ids_ref: "refs/omgbase/ids", remote: null }` and commits a **baseline** of the full current tree. One provider per repository: switching is `history disable` then `enable --provider <other>`.
- **The checkpoint worker** (`omg history checkpoint`; the freshness sweep runs it before every CLI verb): reads `changes_since` from the branch tip's `omgbase-seq` trailer, hashes each touched document's accepted bytes (`reconstruct` — the rows, never the vault's files) into a blob, builds the tree from the previous commit's tree plus the adds and removes (deleted documents leave the tree; a move is a remove + add, git detects the rename), writes the commit with trailers and moves the ref by compare-and-swap. Cadence `every` is one commit per feed row; `{ debounce_ms }` folds the rows pending when the worker runs into one commit (6a has no timer).
- **Trailers** are the replay and identity record: `omgbase-seq: <epoch>:<seq>` (`<from>-<to>` folded), `omgbase-ts`, one `omgbase-commit: <c_id>` per row, `omgbase-origin`, `omgbase-actor`, `omgbase-plan` (when present), `omgbase-rescan: <epoch>:<head>` on a snapshot, one `omgbase-doc: <doc_id> <path> <head>` per touched document (`-` for a deletion). The worker is idempotent across the gap between the database commit and the git commit: a crash before `update-ref` (the `git.commit` fault site) leaves dangling objects the next run re-creates byte for byte.
- **Reads** through the core's `HistoryReader` seam: `docs_history` (versions with `_commit` the git sha, `_hash` the blob's sha256, `_rev` the head token the trailer recorded), `docs_read { at: <sha> | <head token> }`, `docs_diff_unified`, the `revisions` query root; the current head is listed unretained until a commit names it. `version.capabilities.history` reports `provider: "git"` and `completeness: "every" | "checkpoints"`.
- **Determinism**: every spawn runs `git` with `GIT_DIR`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, no `HOME`, `LC_ALL=C`, `TZ=UTC`; the committer is `omgbase <omgbase@localhost>` (the author's name the write's actor), the dates the feed row's `ts` as `@<seconds> +0000`. Under the conformance seams the identity is `omgbase <omgbase@fixture>`, so the shas the fixtures pin follow from the inputs alone. `OMGBASE_GIT_BIN` names the executable (default `git`).

## What it does not do

- **No block lineage.** Git keeps whole documents: `blocks_history` and `docs_diff` (block-grain) answer `capability_unavailable { history, unsupported, provider: "git", fix }` naming the tool that works (`docs_history`, `docs_diff_unified`). The native recorder's dispositions, retention ladder, archive segments and `history plan|export|attach|detach|list` do not apply — a git history is managed with git.
- **Checkpoint granularity.** Capture is asynchronous: a document changed twice before the worker runs is committed at its later bytes (the rows hold current state only); the earlier commit's trailer still names it. With cadence `every` and a worker run after every write (the sweep) every row is one commit.
- **Credentials never enter omgbase.** A URL carrying a user or password is refused anywhere one is accepted; `git` resolves access through the host (ssh keys, credential helpers). `remote` is `null` in 6a — pushing and fetching is 6b.
- **The identity record is the trailers (option 3).** The per-document id-map blobs under `.omgbase/ids/<doc_id>` on the separate ref `refs/omgbase/ids` are **reserved** — named in the config and the spec, written by nothing yet. A clone of the content branch recovers content, not identities, until that ref exists.
- **Unavailability is loud, writes continue.** When `git` is not on PATH (or the provider is not attached), every history read of a git-provider repository fails `capability_unavailable { history, unavailable, provider, reason }` and the `history_provider_unavailable` alert is raised; the engine keeps writing — the next checkpoint that runs catches up.

## Fixtures and tests

`spec/store/cases/history/git.json` pins the worker's commits as text (`git log --format=%H%n%s%n%(trailers)`, `git ls-tree -r`), the fault and its replay, the fold, purge then rescan, re-enable, the provider conflict; `spec/surface/cases/reads.json` `git-history` the reads and every refusal; `spec/cli/cases/history.json` the verbs. `OMGBASE_CAPABILITIES=git` runs every suite with this provider and no native recorder (`pnpm conformance`). `pnpm --filter @omgbase/git-adapter test` is the unit suite (the trailer codec, the config, the exclude file, the worker end to end).
