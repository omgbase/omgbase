---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-store: minor
  omgbase-surface: minor
  omgbase-sync: minor
---
Modular-core Phase 6a — **the Git-backed history provider** (spec/store 17.5 §5.12, spec/surface 6.4, spec/cli 5.5, spec/sync 4.5): a repository's history may be kept by a bare Git repository at `.omgbase/git` instead of the recorder's tables. The core gains the `HistoryReader` seam (the read half of `HistoryRecorder`), the `HistoryProvider` seam and its registry (`registerHistoryProvider`), the fifth composition `OMGBASE_CAPABILITIES=git`, provider-aware manifest reads (`historyReaderFor`, `captureFor` null on a provider row, `requireWriter`, `anyHistoryEnabled` native-only), `history enable --provider git [--branch] [--cadence]`, `history checkpoint`, `history purge` on a git repository, the `git.commit` fault site, the `history_provider_unavailable` alert and the `unsupported` read state; `version.capabilities.history` gains `provider` and `completeness` (every `version`/`sync_status` fixture moved by the two keys). The new private package `@omgbase/git-adapter` holds the checkpoint worker (commits built from the rows over the change feed, replay trailers `omgbase-seq`/`-ts`/`-commit`/`-origin`/`-actor`/`-plan`/`-doc`/`-rescan`, cadence `every` | `{ debounce_ms }`), the `GitHistoryReader` and the git plumbing wrapper; the `omgbase` CLI registers it and renders the verbs; `doctor` reads the provider. The Rust crates track the spec bumps; their twin follows as a separate task with the fixtures (`spec/store/cases/history/git.json`, `reads::git-history`, the seven CLI cases) as its contract.
