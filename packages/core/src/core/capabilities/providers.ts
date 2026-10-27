import type { Store } from "../store/store.js";
import type { HistoryProvider } from "./types.js";

// The alternative history providers' REGISTRY (modular-core Phase 6a — the
// plan's "one alternative strategy through the documented contract"). The core
// knows a provider by the name a manifest row's `config.provider` carries and
// reaches its implementation through `Capabilities.providers`; the
// implementation itself lives OUTSIDE the core (`@omgbase/git-adapter`) and
// the core imports nothing from it — the dependency-direction gate
// (`dependency-direction.test.ts`) keeps it that way. So the composition layer
// REGISTERS a factory here before it opens a store: the CLI's entry point and
// the MCP host (`packages/cli`), the fixture runners (`packages/core/corpus/
// composition.ts`, through the test alias), a library embedding. The factory
// runs once per `Store` (`attachedProviders`), inside the composition's
// capabilities factory (`default.ts`: the `full` and `git` compositions attach
// every registered provider; `core`, `history` and `semantic` attach none, so
// the four 5a compositions keep their meaning).

export type HistoryProviderFactory = (store: Store) => HistoryProvider;

const registered = new Map<string, HistoryProviderFactory>();

/** Register (or replace) the factory of the provider named `name`. Idempotent. */
export function registerHistoryProvider(name: string, factory: HistoryProviderFactory): void {
  registered.set(name, factory);
}

/** Forget a registered provider (tests). */
export function unregisterHistoryProvider(name: string): void {
  registered.delete(name);
}

/** The registered provider names, sorted. */
export function registeredHistoryProviders(): string[] {
  return [...registered.keys()].sort();
}

/** Every registered provider attached to `store`, by name. */
export function attachedProviders(store: Store): Record<string, HistoryProvider> {
  const out: Record<string, HistoryProvider> = {};
  for (const [name, factory] of registered) out[name] = factory(store);
  return out;
}
