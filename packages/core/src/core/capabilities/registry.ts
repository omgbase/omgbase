import type { Database } from "better-sqlite3";
import type { Capabilities, HistoryRecorder, SemanticProvider } from "./types.js";
import { CapabilityUnavailable } from "./errors.js";

// The connection → capabilities binding. `Store` binds the set it was opened
// with (the composition layer's choice, `envCapabilities()` when none was
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
 * The error is unreachable while every composition installs the recorder; it
 * is the hook `capability_unavailable { capability: history }` (D3) grows from.
 */
export function requireHistory(db: Database): HistoryRecorder {
  const h = capabilitiesOf(db).history;
  if (!h) throw new Error("the history capability is not enabled on this store");
  return h;
}

/** The semantic provider, or null when the store runs without the module (`coreCapabilities`). */
export function semanticOf(db: Database): SemanticProvider | null {
  return capabilitiesOf(db).semantic;
}

/**
 * The semantic provider, or `capability_unavailable { capability: "semantic",
 * state: "disabled" }` (phase-1-contracts §2.1) when the store runs without the
 * module — what `semantic()`, the fusion ranker's vector leg and the `embed`
 * verbs raise on the core-only composition.
 */
export function requireSemantic(db: Database): SemanticProvider {
  const s = capabilitiesOf(db).semantic;
  if (!s) throw CapabilityUnavailable.semanticDisabled();
  return s;
}
