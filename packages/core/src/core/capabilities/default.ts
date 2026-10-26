import type { Store } from "../store/store.js";
import type { Capabilities, CapabilitiesFactory } from "./types.js";
import { HistoryRecorderImpl } from "./history.js";
import { SemanticProviderImpl } from "./semantic.js";
import { IdClaims } from "./claims.js";
import { coreCapabilities } from "./core.js";

/**
 * The full composition — what every store ran with before Phase 1: the
 * recorder over the store's own history tables, the semantic provider over its
 * vector tables (which also registers the `cosine` UDF), the `id_claims`
 * table (spec/store §2.1, 17.0). The composition layer (`Workspace`, the CLI, a library embedding)
 * names a factory on `StoreOptions.capabilities`; a `Store` opened without one
 * takes `envCapabilities()`, which is this set unless the environment selects
 * another composition.
 */
export function defaultCapabilities(store: Store): Capabilities {
  return {
    history: new HistoryRecorderImpl(store),
    semantic: new SemanticProviderImpl(store),
    claims: new IdClaims(store),
  };
}

/**
 * The core + history composition (modular-core Phase 5a; the plan's §5 second
 * composition): the recorder and the claims, NO semantic module — `semantic()`,
 * the fusion ranker's vector leg and the `embed` verbs raise
 * `capability_unavailable { semantic, disabled }`, no vector table exists, no
 * `cosine` UDF is registered; capture and every history read behave as on the
 * full composition. Selected by `OMGBASE_CAPABILITIES=history`.
 */
export function historyCapabilities(store: Store): Capabilities {
  return {
    history: new HistoryRecorderImpl(store),
    semantic: null,
    claims: new IdClaims(store),
  };
}

/**
 * The core + semantic composition (modular-core Phase 5a; the plan's §5 third
 * composition): the semantic provider and the claims, NO history module — a
 * repository it creates is born `disabled`, an enabled repository's writes are
 * refused under `writer_requires`, every history tool answers
 * `capability_unavailable { history, unavailable }`, the `revisions` root lists
 * nothing; the semantic bundle's DDL follows the composition as on the full
 * one. Selected by `OMGBASE_CAPABILITIES=semantic`.
 */
export function semanticCapabilities(store: Store): Capabilities {
  return {
    history: null,
    semantic: new SemanticProviderImpl(store),
    claims: new IdClaims(store),
  };
}

/** The environment variable that selects the composition a factory-less store runs with. */
export const CAPABILITIES_ENV = "OMGBASE_CAPABILITIES";

/** The four compositions of the modular-core plan (§5): what `OMGBASE_CAPABILITIES` accepts. `full` is the default. */
export const COMPOSITIONS = ["core", "history", "semantic", "full"] as const;
export type Composition = (typeof COMPOSITIONS)[number];

/** The composition the environment names: unset or empty → `full`; anything outside `COMPOSITIONS` is a configuration error. */
export function envComposition(env: NodeJS.ProcessEnv = process.env): Composition {
  const v = (env[CAPABILITIES_ENV] ?? "").trim();
  if (v === "") return "full";
  if ((COMPOSITIONS as readonly string[]).includes(v)) return v as Composition;
  throw new Error(`${CAPABILITIES_ENV}=${JSON.stringify(v)} is not a composition; use one of ${COMPOSITIONS.map((c) => `"${c}"`).join(", ")} (the default is "full")`);
}

/** The factory of a named composition. */
export function compositionCapabilities(composition: Composition): CapabilitiesFactory {
  switch (composition) {
    case "full": return defaultCapabilities;
    case "core": return coreCapabilities;
    case "history": return historyCapabilities;
    case "semantic": return semanticCapabilities;
  }
}

/** Does the composition carry the history module? */
export function compositionHasHistory(composition: Composition): boolean {
  return composition === "full" || composition === "history";
}

/** Does the composition carry the semantic module? */
export function compositionHasSemantic(composition: Composition): boolean {
  return composition === "full" || composition === "semantic";
}

/**
 * The composition the environment names: `core` → `coreCapabilities` (no
 * history module, no semantic module — a core-only build, Phase 4a); `history`
 * → `historyCapabilities` (no semantic module); `semantic` →
 * `semanticCapabilities` (no history module); unset, empty or `full` → the
 * defaults (Phase 5a: the plan's four compositions). Anything else is a
 * configuration error. `OMGBASE_CAPABILITIES` is a TEST-ONLY override, not a
 * production mechanism: in production the composition is the build's (the
 * TypeScript engine always carries both modules) and whether a repository's
 * commits are captured is its MANIFEST (`history enable|disable`). The fixture
 * runners and every `omg` verb open their stores through this, so
 * `OMGBASE_CAPABILITIES=<composition> pnpm --filter @omgbase/core exec vitest
 * run corpus/store …` is "this composition boots, writes, passes the invariants
 * it owns" — `pnpm conformance` runs every suite under all four (spec/store §9.6).
 */
export function envCapabilities(env: NodeJS.ProcessEnv = process.env): CapabilitiesFactory {
  return compositionCapabilities(envComposition(env));
}
