import type { Store } from "../store/store.js";
import type { Capabilities } from "./types.js";
import { IdClaims } from "./claims.js";

/**
 * The core-only composition (modular-core Phase 4a; README §6 gate): the
 * `id_claims` table alone — NO history module and NO semantic module. It is
 * what a core-only build is: a repository it creates starts with history
 * `disabled` (`ensure_repo`, spec/store §3.1), a repository whose manifest
 * has history `enabled` with `writer_requires` refuses its writes
 * (`requireWriter` → `capability_unavailable { history, unavailable }` + the
 * `writer_refused` alert), every history tool answers `capability_unavailable
 * { history, unavailable }`, the `revisions` root lists nothing, and
 * `semantic()`, `order by semantic(…)`, the fusion ranker's vector leg and the
 * `embed` verbs raise `capability_unavailable { semantic, disabled }`. Nothing
 * in it names a history or a vector table, registers the `cosine` UDF or
 * spawns a provider. Selected by `OMGBASE_CAPABILITIES=core` (`envCapabilities`
 * — the TEST-ONLY override that runs the TypeScript engine as a core-only
 * build: every fixture suite runs its observation scripts under it and asserts
 * the core invariants alone) or named on `StoreOptions.capabilities`. Through
 * Phase 3 this composition still carried the recorder (every write needed
 * it); Phase 4a made capture optional and dropped it here.
 */
export function coreCapabilities(store: Store): Capabilities {
  return {
    history: null,
    semantic: null,
    claims: new IdClaims(store),
  };
}
