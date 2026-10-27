// The composition a fixture runner runs under (modular-core Phase 5a; spec/store
// §9.6, spec/surface §7.3, spec/sync §8, spec/cli §8, spec/graph §7, spec/search
// §7). `OMGBASE_CAPABILITIES` names one of the plan's four compositions —
// `core`, `history`, `semantic`, `full` (the default) — and every runner opens
// its stores through `envCapabilities()`, so the SAME scripts run on the
// composition named and the runner decides, per case, whether it is compared
// as recorded, compared through a MAPPING keyed on the module the composition
// lacks (the mapping lives here and in each runner, never in a fixture), or
// SKIPPED because the case needs the absent module. Each runner keeps a ledger
// and prints one machine-readable line at the end — `pnpm conformance`
// (`scripts/conformance.mjs`) collects them into the suite × composition matrix.
// The fixtures are never regenerated from a non-full run (`refuseUpdate`).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPOSITIONS, compositionHasGitProvider, compositionHasHistory, compositionHasSemantic, envComposition, type Composition } from "../src/core/capabilities/default.js";
import { registerHistoryProvider, type HistoryProviderFactory } from "../src/core/capabilities/providers.js";
import type { Store } from "../src/core/store/store.js";

export { COMPOSITIONS, type Composition };

/** The composition this process runs under (`OMGBASE_CAPABILITIES`, default `full`). */
export const COMPOSITION: Composition = envComposition();
/** Does the composition carry the history module (`full`, `history`)? */
export const HAS_HISTORY = compositionHasHistory(COMPOSITION);
/** Does the composition carry the semantic module (`full`, `semantic`)? */
export const HAS_SEMANTIC = compositionHasSemantic(COMPOSITION);
/** Does the composition attach the git history provider (`full`, `git` — modular-core Phase 6a; spec/store §9.6)? */
export const HAS_GIT = compositionHasGitProvider(COMPOSITION);

// The git history provider (Phase 6a): the runners are the composition layer of
// this process, so they REGISTER `@omgbase/git-adapter`'s factory before any
// store opens — exactly as the CLI's `installSpecSeams` does — with the fixture
// identity `omgbase <omgbase@fixture>` (spec/store §9.4 "The git provider"), so
// the commit shas the fixtures pin follow from the inputs. The package is loaded
// from its SOURCE through vitest (`vitest.config.ts` aliases `@omgbase/core` to
// this package's source so both share one module graph); `tsc` sees a computed
// specifier and resolves nothing — the core's own build never names the package
// (`dependency-direction.test.ts` pins that).
const GIT_ADAPTER_SRC = new URL("../../git-adapter/src/index.ts", import.meta.url);
interface GitAdapterModule { gitHistoryProvider(opts: { identity: { name: string; email: string } }): HistoryProviderFactory; FIXTURE_IDENTITY: { name: string; email: string } }
/** The git adapter's fixture `GitRepo` handle for a store's provider (the `git_log`/`git_tree` steps read it) — structural, so the core's build names no git-adapter type. */
export interface FixtureGitProvider { gitRepo(config: Record<string, unknown>): { text(args: string[]): string; exists(): boolean } }
let gitAdapter: GitAdapterModule | null = null;
if (HAS_GIT && existsSync(fileURLToPath(GIT_ADAPTER_SRC))) {
  gitAdapter = (await import(GIT_ADAPTER_SRC.href)) as GitAdapterModule;
  registerHistoryProvider("git", gitAdapter.gitHistoryProvider({ identity: gitAdapter.FIXTURE_IDENTITY }));
}
/** The git provider attached to `store` (the fixture steps that read the bare repository), or null. */
export function fixtureGitProvider(store: Store): FixtureGitProvider | null {
  return (store.capabilities.providers.git as unknown as FixtureGitProvider | undefined) ?? null;
}
/** Is this the full composition — the only one a fixture may be regenerated from? */
export const FULL = COMPOSITION === "full";

/** A `<X>_SPEC_UPDATE` under a reduced composition would record that composition's answers: refused. */
export function refuseUpdate(update: boolean, envVar: string): void {
  if (update && !FULL) throw new Error(`${envVar} under OMGBASE_CAPABILITIES=${COMPOSITION} would record the ${COMPOSITION} composition's answers; run it on the full one`);
}

/** The ledger line's prefix, shared with the CLI runner (`packages/cli/corpus/cli`) and parsed by `scripts/conformance.mjs`. */
export function ledgerLine(suite: string, composition: string, counts: { compared: number; mapped: number; skipped: number }): string {
  return `[${suite} spec] composition=${composition}: compared=${counts.compared} mapped=${counts.mapped} skipped=${counts.skipped}`;
}

/**
 * One runner's ledger: `compared` = cases compared exactly as recorded, `mapped`
 * = cases compared through a composition mapping (with a note of what moved),
 * `skipped` = cases not run because they need an absent module (with the reason).
 */
export class Ledger {
  readonly compared: string[] = [];
  readonly mapped: string[] = [];
  readonly skipped: string[] = [];
  constructor(readonly suite: string) {}

  /** A case compared: `mapped` names what the mapping changed (empty = compared as recorded). */
  record(id: string, mapped: string | false = false): void {
    if (mapped) this.mapped.push(`${id} (${mapped})`);
    else this.compared.push(id);
  }

  skip(id: string, reason: string): void {
    this.skipped.push(`${id} — ${reason}`);
  }

  /** The line (+ the mapped and skipped lists under a reduced composition), to stderr. */
  report(): void {
    const counts = { compared: this.compared.length, mapped: this.mapped.length, skipped: this.skipped.length };
    let text = `${ledgerLine(this.suite, COMPOSITION, counts)}\n`;
    if (!FULL) {
      for (const m of this.mapped) text += `  mapped ${m}\n`;
      for (const s of this.skipped) text += `  skip ${s}\n`;
    }
    process.stderr.write(text);
  }
}
