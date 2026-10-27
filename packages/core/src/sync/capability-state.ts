import type { Store } from "../core/store/store.js";
import type { CapabilityState } from "../core/capabilities/errors.js";
import { attachedProvider, coverageFrom, historyProviderOf, NATIVE_PROVIDER, providerConfigOf, readCapabilities, semanticProviderConfigured, type ManifestRow } from "../core/store/manifest.js";
import type { HistoryRemoteSummary } from "../core/capabilities/types.js";
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

/** How complete a provider's capture is (spec/surface §4 `version`, 6.4 — Phase 6a): `every` — one version per feed row (the native recorder; the git provider under cadence `every`); `checkpoints` — the rows pending when the worker runs fold into one commit (the git provider under a `debounce_ms` cadence). */
export type HistoryCompleteness = "every" | "checkpoints";

export interface CapabilityStates {
  /** `provider` (6.4): the manifest row's `config.provider`, `native` when absent; `coverage_from`: the first coverage interval's `from` (spec/store §3.1 rule 2), null when capture never ran; `writer_requires`: the manifest flag (resolution 17); `completeness` (6.4): see `HistoryCompleteness`; `remote` (6.5, Phase 6b): the provider's remote binding — `{ name, branch, state, pushed_through }` — null for the native recorder and for a provider row that binds none. */
  history: { state: CapabilityState; provider: string; coverage_from: string | null; writer_requires: boolean; completeness: HistoryCompleteness; remote: HistoryRemoteSummary | null };
  /** `model`: the manifest row's `config.model`, null when none is configured. */
  semantic: { state: CapabilityState; model: string | null };
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

/**
 * The history capability's state for `repoId`: the manifest row's (`disabled`
 * when absent); `unavailable` when the composition lacks the module the row's
 * PROVIDER needs — the recorder for a native row (reachable since Phase 4a —
 * the core-only build), the attached provider for a `provider: git` row, or
 * one that is attached but cannot run here (`git` not on PATH; Phase 6a).
 */
export function historyState(store: Store, repoId: string | null): CapabilityState {
  if (repoId === null) return store.capabilities.history ? "enabled" : "unavailable";
  const row = readCapabilities(store.db, repoId).history;
  const provider = historyProviderOf(row);
  if (provider === NATIVE_PROVIDER) {
    if (!store.capabilities.history) return "unavailable";
    return row?.state ?? "disabled";
  }
  const p = attachedProvider(store.db, provider);
  if (!p || !p.available().ok) return "unavailable";
  return row?.state ?? "disabled";
}

/**
 * The `remote` member of `version.capabilities.history` (6.5, Phase 6b; spec/store §5.12 "Remote status"): the attached
 * provider's summary of the row's binding — the three levels a client needs are then on one wire: current state (the
 * rows), locally checkpointed (`completeness`, the tip) and remotely synchronised (`remote.state`, `pushed_through`).
 * Null for the native recorder, a row without a binding, or a provider that is not attached or cannot run (its state
 * says `unavailable`). Local refs only: no network is touched by a `version` call.
 */
export function historyRemote(store: Store, repoId: string | null, row: ManifestRow | null): HistoryRemoteSummary | null {
  if (repoId === null || !row) return null;
  const provider = historyProviderOf(row);
  if (provider === NATIVE_PROVIDER) return null;
  const p = attachedProvider(store.db, provider);
  if (!p || !p.remoteSummary || !p.available().ok) return null;
  return p.remoteSummary(repoId, providerConfigOf(row));
}

/** The `completeness` of a repository's capture (6.4): `checkpoints` only for a provider row whose `cadence` is a debounce object. */
export function historyCompleteness(row: ManifestRow | null): HistoryCompleteness {
  const cadence = row?.config.cadence;
  return typeof cadence === "object" && cadence !== null ? "checkpoints" : "every";
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

/**
 * The `version` tool's `capabilities` member (and the CLI's, `sync_status`'s):
 * both capabilities' states from the manifest, with (spec/surface §4 `version`,
 * 6.1 — phase-1-contracts §2.3) `history.coverage_from` / `writer_requires`
 * and `semantic.model`, read from the rows; without a repository `null`/`false`.
 */
export function capabilityStates(store: Store, repoId: string | null, failed?: SemanticHostReport | null): CapabilityStates {
  const rows = repoId === null ? { history: null, semantic: null } : readCapabilities(store.db, repoId);
  return {
    history: { state: historyState(store, repoId), provider: historyProviderOf(rows.history), coverage_from: coverageFrom(rows.history), writer_requires: rows.history?.writer_requires ?? false, completeness: historyCompleteness(rows.history), remote: historyRemote(store, repoId, rows.history) },
    semantic: { state: semanticState(store, repoId, failed), model: modelOf(rows.semantic) },
  };
}

function modelOf(row: ManifestRow | null): string | null {
  const m = row?.config.model;
  return typeof m === "string" && m !== "" ? m : null;
}
