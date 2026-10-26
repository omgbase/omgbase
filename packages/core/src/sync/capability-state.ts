import type { Store } from "../core/store/store.js";
import type { CapabilityState } from "../core/capabilities/errors.js";
import { readCapabilities, semanticProviderConfigured } from "../core/store/manifest.js";
import { resolveSettings } from "./settings.js";

// Capability discovery (modular-core Phase 2 → 3e-ii; phase-1-contracts §1.5,
// §2.3 and §7 resolution 1). Since store 17.0 (3e-ii) the states are READ FROM
// THE MANIFEST — the `capabilities` table (`core/store/manifest.ts`): `history`
// is its row's state (`unavailable` when the composition lacks the recorder —
// unreachable through 17.0), `semantic` its row's state overlaid with what the
// host knows (`unavailable` when a configured provider failed to start — a
// runtime fact, never persisted) and `disabled` when the store runs without
// the module. The row itself follows Brendan's resolution 1 — `enabled` iff a
// provider is configured, stored vectors never consulted — written at
// `ensure_repo`, by migration 17 and by every settings write until the Phase 4
// `embed` verbs own it. Without a repository there is no row to read: the
// answer is the composition's for history and the workspace layer's provider
// setting for semantic — exactly what Phase 2 derived.

export interface CapabilityStates {
  history: { state: CapabilityState };
  semantic: { state: CapabilityState };
}

/** What the host knows about a configured provider it could not start (`omg mcp`'s embedder load). */
export interface SemanticHostReport { provider: string; reason: string }

/** Is a provider configured for `repoId` (null: the workspace layer alone)? */
export function semanticConfigured(store: Store, repoId: string | null): boolean {
  if (repoId !== null) return semanticProviderConfigured(store.db, repoId);
  const embedding = resolveSettings(store, null).embedding;
  if (!embedding || typeof embedding !== "object") return false;
  const provider = (embedding as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.trim() !== "";
}

/** The history capability's state for `repoId`: the manifest row's (`disabled` when absent); `unavailable` when the composition lacks the recorder. */
export function historyState(store: Store, repoId: string | null): CapabilityState {
  if (!store.capabilities.history) return "unavailable";
  if (repoId === null) return "enabled";
  const row = readCapabilities(store.db, repoId).history;
  return row?.state ?? "disabled";
}

/**
 * The semantic capability's state for `repoId`: `disabled` when the store runs
 * without the module (`Capabilities.semantic === null`) or the manifest row is
 * absent or `disabled`; `unavailable` when the row is `enabled` but the host
 * reports the provider failed to start; `enabled` otherwise.
 */
export function semanticState(store: Store, repoId: string | null, failed?: SemanticHostReport | null): CapabilityState {
  if (!store.capabilities.semantic) return "disabled";
  const enabled = repoId === null ? semanticConfigured(store, null) : readCapabilities(store.db, repoId).semantic?.state === "enabled";
  if (!enabled) return "disabled";
  return failed ? "unavailable" : "enabled";
}

/** The `version` tool's `capabilities` member (and the CLI's): both capabilities' states, from the manifest. */
export function capabilityStates(store: Store, repoId: string | null, failed?: SemanticHostReport | null): CapabilityStates {
  return {
    history: { state: historyState(store, repoId) },
    semantic: { state: semanticState(store, repoId, failed) },
  };
}
