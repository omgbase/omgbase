// The two grammars must tokenize identically: the corpus, and every query in the
// specification's fixtures. This is what lets the hand-serialized Monarch grammar
// exist at all (the design note's condition: generated and tested from the same
// vocabulary so it cannot silently drift).

import { describe, expect, it } from "vitest";
import { oqxMonarchGrammar } from "../src/monarch.js";
import { CORPUS } from "./corpus.js";
import { tokenizeMonarch } from "./monarch-runtime.js";
import { specQueries } from "./spec-fixtures.js";
import { tokenizeTextMate } from "./textmate-runtime.js";
import { render } from "./tokens.js";

describe("TextMate ↔ Monarch parity", () => {
  it("over the corpus", async () => {
    for (const sample of CORPUS) {
      expect(render(tokenizeMonarch(oqxMonarchGrammar, sample.source)), sample.name).toBe(sample.tokens);
    }
  });

  it("over every spec/oqx fixture query", async () => {
    const queries = specQueries();
    expect(queries.length).toBeGreaterThan(800);
    for (const q of queries) {
      const tm = render(await tokenizeTextMate(q.source));
      const mo = render(tokenizeMonarch(oqxMonarchGrammar, q.source));
      expect(mo, `${q.suite} / ${q.name}: ${q.source}`).toBe(tm);
    }
  });

  it("the Monarch grammar stays inside the modelled subset and every regex compiles", () => {
    for (const [state, rules] of Object.entries(oqxMonarchGrammar.tokenizer)) {
      for (const rule of rules) {
        if ("include" in rule) {
          expect(oqxMonarchGrammar.tokenizer[rule.include.slice(1)], `${state}: ${rule.include}`).toBeDefined();
          continue;
        }
        expect(() => new RegExp(`^(?:${rule[0]})`)).not.toThrow();
        expect(rule[0], "Monarch reads @ as an attribute reference").not.toMatch(/(^|[^\\])@/);
      }
    }
  });
});
