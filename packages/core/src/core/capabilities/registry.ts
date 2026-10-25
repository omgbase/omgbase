import type { Database } from "better-sqlite3";
import type { Capabilities, HistoryRecorder, SemanticProvider } from "./types.js";

// The connection → capabilities binding. `Store` binds the set it was opened
// with (the composition layer's choice, `defaultCapabilities` when none was
// named); a core path that holds only the connection — `ingestInto(db, …)`,
// `reconstructContent(db, …)`, the commit's transaction body — looks it up
// here rather than threading a parameter through every signature. The same
// `Database` object flows through `store.write`/`writeImmediate`, so the
// lookup is the store's. Imports nothing concrete: binding the defaults is the
// store's job, not this module's.

const bound = new WeakMap<Database, Capabilities>();

/** Bind `capabilities` to `db` (the `Store` constructor; a test seam for a bare connection). */
export function bindCapabilities(db: Database, capabilities: Capabilities): void {
  bound.set(db, capabilities);
}

/** The capabilities bound to `db`. A connection no `Store` opened has none — an engine bug, not a runtime state. */
export function capabilitiesOf(db: Database): Capabilities {
  const c = bound.get(db);
  if (!c) throw new Error("no capabilities are bound to this database connection — open it through Store");
  return c;
}

/**
 * The history recorder, which every write entry point still needs: the head
 * token is the recorder's revision id (D1) until Phase 3 mints it in the core.
 * The error is unreachable while the defaults are always installed; it is the
 * hook `capability_unavailable { capability: history }` (D3) grows from.
 */
export function requireHistory(db: Database): HistoryRecorder {
  const h = capabilitiesOf(db).history;
  if (!h) throw new Error("the history capability is not enabled on this store");
  return h;
}

/** The semantic provider, or null when the capability is off (the callers' `provider_unavailable`/`filter_invalid` paths handle null). */
export function semanticOf(db: Database): SemanticProvider | null {
  return capabilitiesOf(db).semantic;
}
