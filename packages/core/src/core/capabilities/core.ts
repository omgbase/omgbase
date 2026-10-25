import type { Store } from "../store/store.js";
import type { Capabilities } from "./types.js";
import { HistoryRecorderImpl } from "./history.js";
import { TableUnionClaims } from "./claims.js";

/**
 * The core-only composition (modular-core Phase 2, README §6 gate): the
 * recorder — the head token is still the recorder's revision id (D1) until
 * Phase 3 mints it in the core, so every write needs it — and the claims, with
 * NO semantic module. Nothing in this composition reads or writes
 * `embeddings`/`doc_embeddings`, registers the `cosine` UDF or spawns a
 * provider; `semantic()`, `order by semantic(…)`, the fusion ranker's vector
 * leg and the `embed` verbs raise `capability_unavailable { capability:
 * "semantic", state: "disabled" }`. Selected by `OMGBASE_CAPABILITIES=core`
 * (`envCapabilities`) or named on `StoreOptions.capabilities`.
 */
export function coreCapabilities(store: Store): Capabilities {
  return {
    history: new HistoryRecorderImpl(store),
    semantic: null,
    claims: new TableUnionClaims(store.db),
  };
}
