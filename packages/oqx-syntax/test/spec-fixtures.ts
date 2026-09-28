// Every query in the OQX specification's fixtures (`spec/oqx/cases/*.json`), as
// display source: a template's fragments are joined with `${n}` binding markers,
// the way the reference renders a query for an error message.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SPEC_DIR = join(import.meta.dirname, "..", "..", "..", "spec", "oqx");

export interface FixtureQuery {
  suite: string;
  name: string;
  source: string;
  /** `lex` / `parse` / `eval` when the case expects an error, else null. */
  errorStage: string | null;
  errorIncludes: string[];
}

export function specQueries(): FixtureQuery[] {
  const out: FixtureQuery[] = [];
  const dir = join(SPEC_DIR, "cases");
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const suite = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      suite: string;
      cases: Array<{
        name: string;
        query?: string;
        template?: { strings: string[] };
        expect: { error?: { stage: string; includes?: string[] } };
      }>;
    };
    for (const c of suite.cases) {
      const source = c.query ?? c.template!.strings.map((s, i, a) => (i < a.length - 1 ? `${s}\${${i}}` : s)).join("");
      out.push({
        suite: suite.suite,
        name: c.name,
        source,
        errorStage: c.expect.error?.stage ?? null,
        errorIncludes: c.expect.error?.includes ?? [],
      });
    }
  }
  return out;
}
