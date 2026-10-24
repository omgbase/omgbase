// Sweep the specification's fixtures: a query the language accepts (or rejects
// only at parse or eval time) never shows a lex-error token, and a query the
// lexer rejects shows the matching one. The grammar's error classes therefore
// mean exactly what the specification's `lex` stage means.

import { describe, expect, it } from "vitest";
import { specQueries } from "./spec-fixtures.js";
import { tokenizeTextMate } from "./textmate-runtime.js";
import { render } from "./tokens.js";

describe("spec/oqx fixtures", () => {
  const queries = specQueries();

  it("lexically valid queries contain no lex-error token", async () => {
    for (const q of queries.filter((q) => q.errorStage !== "lex")) {
      const tokens = await tokenizeTextMate(q.source);
      const bad = tokens.filter((t) => t.cls === "illegal" || t.cls === "numberInvalid");
      expect(bad, `${q.suite} / ${q.name}: ${q.source}\n${render(tokens)}`).toEqual([]);
    }
  });

  it("lex-error queries show the lex error", async () => {
    const lex = queries.filter((q) => q.errorStage === "lex");
    expect(lex.length).toBeGreaterThan(10);
    for (const q of lex) {
      const tokens = await tokenizeTextMate(q.source);
      const why = q.errorIncludes.join(" ");
      const label = `${q.suite} / ${q.name}: ${q.source}\n${render(tokens)}`;
      if (why.includes("unexpected character")) expect(tokens.some((t) => t.cls === "illegal"), label).toBe(true);
      else if (why.includes("malformed number")) expect(tokens.some((t) => t.cls === "numberInvalid"), label).toBe(true);
      else if (why.includes("unterminated string")) {
        const last = tokens.at(-1);
        expect(last?.cls === "string" || last?.cls === "stringEscape", label).toBe(true);
      } else if (why.includes("unterminated comment")) {
        // The block comment is open (0.28): it runs to the end of the source as
        // a comment, never as an error token.
        expect(tokens.at(-1)?.cls, label).toBe("commentBlock");
        expect(tokens.some((t) => t.cls === "illegal"), label).toBe(false);
      } else if (why.includes("unterminated template literal") && why.includes("binding")) {
        // A fragment boundary inside the literal: the display source (the `${n}`
        // marker standing in for the value) is lexically a complete literal.
        expect(tokens.some((t) => t.cls === "template"), label).toBe(true);
        expect(tokens.some((t) => t.cls === "illegal"), label).toBe(false);
      } else if (why.includes("unterminated template literal")) {
        // The literal is open: it runs to the end of the source.
        expect(tokens.at(-1)?.cls, label).toBe("template");
      } else if (why.includes("interpolation")) {
        expect(tokens.some((t) => t.cls === "interpolation" && t.text === "${"), label).toBe(true);
        expect(tokens.some((t) => t.cls === "interpolation" && t.text === "}"), label).toBe(false);
      } else throw new Error(`unrecognized lex error in fixture: ${label}`);
    }
  });
});
