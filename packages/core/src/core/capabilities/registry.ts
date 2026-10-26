import type { Database } from "better-sqlite3";
import type { Capabilities, HistoryRecorder, IdentityClaims, SemanticProvider } from "./types.js";
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
 * The history MODULE, or `capability_unavailable { history, unavailable }`
 * (phase-1-contracts §2.1) when the composition lacks it — what the retention
 * verbs (`history plan|export|attach|detach|list`) and the 16.x → 17 migration
 * need: the module itself, whatever a repository's manifest says. A COMMIT
 * asks `captureFor` (`core/store/manifest.ts`) instead — the recorder only
 * while the repository's capture is on (Phase 4a).
 */
export function requireHistory(db: Database): HistoryRecorder {
  const h = capabilitiesOf(db).history;
  if (!h) throw CapabilityUnavailable.historyUnavailable();
  return h;
}

/** The identity claims (spec/store §2.1): every composition has them. */
export function claimsOf(db: Database): IdentityClaims {
  return capabilitiesOf(db).claims;
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
