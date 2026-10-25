import type { Store } from "../store/store.js";
import type { Capabilities } from "./types.js";
import { HistoryRecorderImpl } from "./history.js";
import { SemanticProviderImpl } from "./semantic.js";
import { TableUnionClaims } from "./claims.js";

/**
 * The capabilities every store ran with before Phase 1 and every store runs
 * with after it: the recorder over the store's own history tables, the
 * semantic provider over its vector tables, the table-union claims. The
 * composition layer (`Workspace`, the CLI, a library embedding) names this
 * factory on `StoreOptions.capabilities`; a `Store` opened without one
 * (fixtures, unit tests) installs it too, so behaviour is identical either
 * way — Phase 2+ is where an absent capability becomes `null`.
 */
export function defaultCapabilities(store: Store): Capabilities {
  return {
    history: new HistoryRecorderImpl(store),
    semantic: new SemanticProviderImpl(store),
    claims: new TableUnionClaims(store.db),
  };
}
