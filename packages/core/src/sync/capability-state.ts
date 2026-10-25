import type { Store } from "../core/store/store.js";
import type { CapabilityState } from "../core/capabilities/errors.js";
import { resolveSettings } from "./settings.js";

// Capability discovery (modular-core Phase 2; phase-1-contracts §1.5, §2.3 and
// §7 resolution 1). This phase adds no `capabilities` table (the DDL split is
// the store 17 major): the manifest is DERIVED, and the one rule is Brendan's
// resolution 1 — the semantic capability is `enabled` iff a provider is
// configured; stored vectors are never consulted ("you can't run an embed
// search without a provider even if you have vector data"). The configuration
// is the repository's effective `embedding.provider` (workspace defaults ←
// repo overrides, `spec/sync` §3); with no repository the workspace layer's.

export interface CapabilityStates {
  history: { state: CapabilityState };
  semantic: { state: CapabilityState };
}

/** What the host knows about a configured provider it could not start (`omg mcp`'s embedder load). */
export interface SemanticHostReport { provider: string; reason: string }

/** Is a provider configured for `repoId` (null: the workspace layer alone)? */
export function semanticConfigured(store: Store, repoId: string | null): boolean {
  const embedding = resolveSettings(store, repoId).embedding;
  if (!embedding || typeof embedding !== "object") return false;
  const provider = (embedding as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.trim() !== "";
}

/**
 * The semantic capability's state for `repoId`: `disabled` when the store runs
 * without the module (`Capabilities.semantic === null`) or no provider is
 * configured; `unavailable` when one is configured but the host reports it
 * failed to start; `enabled` otherwise.
 */
export function semanticState(store: Store, repoId: string | null, failed?: SemanticHostReport | null): CapabilityState {
  if (!store.capabilities.semantic) return "disabled";
  if (!semanticConfigured(store, repoId)) return "disabled";
  return failed ? "unavailable" : "enabled";
}

/** The `version` tool's `capabilities` member (and the CLI's): both capabilities' states. */
export function capabilityStates(store: Store, repoId: string | null, failed?: SemanticHostReport | null): CapabilityStates {
  return {
    history: { state: store.capabilities.history ? "enabled" : "disabled" },
    semantic: { state: semanticState(store, repoId, failed) },
  };
}
