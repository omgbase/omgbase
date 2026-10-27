# omgbase-git-adapter

The **Git-backed history provider** for [omgbase](https://github.com/omgbase/omgbase), Rust implementation — the twin of `@omgbase/git-adapter` (modular-core Phase 6a; `spec/store` §5.12, `spec/surface` §3 "The git provider", `spec/cli` `history`, `spec/sync` §6). A repository's history is kept by **one provider**: the engine's native recorder (the store's own history tables) or this one — a **bare Git repository at `<workspace>/.omgbase/git`** whose commits are built from the database rows by a **checkpoint worker** consuming the change feed. The core (`omgbase-store`) knows the provider only by name: the composition layer (the `omgbase` binary, the fixture runners) attaches it before a store opens:

```rust
use omgbase_git_adapter::{GitHistoryProvider, default_identity};
use omgbase_store::Capabilities;

let caps = Capabilities::standard().with_provider(Box::new(GitHistoryProvider::new(workspace_root, default_identity())));
```

## What it does

- `omg history enable --provider git [--branch <b>] [--cadence every|<ms>]` — `git init --bare`, the `.omgbase/` line in the user's `.git/info/exclude`, the manifest row `{ provider: "git", git_dir: ".omgbase/git", branch, cadence, ids_ref: "refs/omgbase/ids", remote: null }`, one **baseline** commit of the full current tree.
- **The checkpoint worker** (`omg history checkpoint`; the freshness sweep's step 6): resumes from the branch tip's `omgbase-seq` trailer (the `$git` row of `sync_state` is its cache), pages `changes_since`, stages each row's documents from the ROWS (`reconstruct` → `git hash-object -w --stdin`; a move = remove + add; a delete leaves the tree), builds the tree through a temporary index, `commit-tree` with the replay trailers, the `git.commit` fault site, `update-ref` by compare-and-swap. Cadence `every` is one commit per feed row; `{ debounce_ms }` folds the pending rows into one.
- **Trailers**: `omgbase-seq`, `omgbase-ts`, `omgbase-commit` (one per row), `omgbase-origin`, `omgbase-actor`, `omgbase-plan`, `omgbase-rescan` (a snapshot), `omgbase-doc: <doc_id> <path> <head|->` — rendered and parsed by the engine, never by `git interpret-trailers`.
- **Reads** through the `HistoryReader` seam: `docs_history` (`_commit` the git sha, `_hash` the blob's sha256, `_rev` the trailer's head token), `docs_read { at: <sha> | <head> }`, `docs_diff_unified`, the `revisions` root; the current head unretained until a commit names it; a sha is decided here (`pruned`, `outside_coverage`, `target_missing`); `blocks_history` / `docs_diff` are `unsupported`.
- **Determinism**: every spawn runs `git` with `GIT_DIR`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, no `HOME`, `LC_ALL=C`, `TZ=UTC`; the committer `omgbase <omgbase@localhost>` (`omgbase@fixture` under the conformance seams), the author's name the row's actor, both dates the row's `ts` as `@<seconds> +0000` — so the shas the fixtures pin are the same in both engines. `OMGBASE_GIT_BIN` names the executable (default `git`).

Unavailability is loud and writes continue: without `git` on PATH every history read of a git-provider repository is `capability_unavailable { history, unavailable, provider, reason }` and the `history_provider_unavailable` alert is raised; the next checkpoint that runs catches up. `remote` and `refs/omgbase/ids` are reserved for 6b.
