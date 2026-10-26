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
 * the core-only one.
 */
export function defaultCapabilities(store: Store): Capabilities {
  return {
    history: new HistoryRecorderImpl(store),
    semantic: new SemanticProviderImpl(store),
    claims: new IdClaims(store),
  };
}

/** The environment variable that selects the composition a factory-less store runs with. */
export const CAPABILITIES_ENV = "OMGBASE_CAPABILITIES";

/**
 * The composition the environment names: `core` → `coreCapabilities` (no
 * history module, no semantic module — a core-only build, Phase 4a); unset,
 * empty or `full` → the defaults. Anything else is a configuration error.
 * `OMGBASE_CAPABILITIES=core` is a TEST-ONLY override, not a production
 * mechanism: in production the composition is the build's (the TypeScript
 * engine always carries both modules) and whether a repository's commits are
 * captured is its MANIFEST (`history enable|disable`). The fixture runners and
 * every `omg` verb open their stores through this, so `OMGBASE_CAPABILITIES=
 * core pnpm --filter @omgbase/core exec vitest run corpus/store corpus/mutate
 * corpus/surface/spec.test.ts` is the "a core-only build boots, writes with
 * history disabled, passes the core invariants" run.
 */
export function envCapabilities(env: NodeJS.ProcessEnv = process.env): CapabilitiesFactory {
  const v = (env[CAPABILITIES_ENV] ?? "").trim();
  if (v === "" || v === "full") return defaultCapabilities;
  if (v === "core") return coreCapabilities;
  throw new Error(`${CAPABILITIES_ENV}=${JSON.stringify(v)} is not a composition; use "full" (the default) or "core"`);
}
