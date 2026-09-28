// Golden tokenization of the corpus with the real TextMate engine, plus the
// scope conventions a theme relies on.

import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { CORPUS } from "./corpus.js";
import { tokenizeScopes, tokenizeTextMate } from "./textmate-runtime.js";
import { render } from "./tokens.js";
import { LANGUAGE } from "../src/vocabulary.js";

describe("TextMate grammar", () => {
  for (const sample of CORPUS) {
    it(`tokenizes: ${sample.name}`, async () => {
      expect(render(await tokenizeTextMate(sample.source))).toBe(sample.tokens);
    });
  }

  it("the corpus's `valid` flag agrees with the reference parser", () => {
    for (const sample of CORPUS) {
      let ok = true;
      try {
        parse(sample.source.replace(/\$\{\d+\}/g, "1"));
      } catch {
        ok = false;
      }
      expect(ok, `${sample.name}: ${sample.source}`).toBe(sample.valid);
    }
  });

  it("every token carries the root scope and strings mark their quotes", async () => {
    const tokens = await tokenizeScopes('name from r where a == "x"');
    for (const t of tokens) expect(t.scopes[0]).toBe(LANGUAGE.scopeName);
    const quote = tokens.find((t) => t.text === '"');
    expect(quote?.scopes).toContain("string.quoted.double.oqx");
    expect(quote?.scopes).toContain("punctuation.definition.string.begin.oqx");
  });

  it("a string's escape is scoped inside the string", async () => {
    const tokens = await tokenizeScopes('from r where a == "a\\"b"');
    const esc = tokens.find((t) => t.text === '\\"');
    expect(esc?.scopes.slice(1)).toEqual(["string.quoted.double.oqx", "constant.character.escape.oqx"]);
  });

  it("keywords are the reserved words; consumers, clauses and modifiers keep their own scopes", async () => {
    const scopesOf = async (src: string, text: string) =>
      (await tokenizeScopes(src)).find((t) => t.text === text)?.scopes.at(-1);
    expect(await scopesOf("from r", "from")).toBe("keyword.control.oqx");
    expect(await scopesOf("from r where x exists { }", "exists")).toBe("keyword.control.consumer.oqx");
    expect(await scopesOf("from r limit 3", "limit")).toBe("keyword.control.clause.oqx");
    expect(await scopesOf("select distinct a from r", "distinct")).toBe("keyword.other.modifier.oqx");
    expect(await scopesOf("from r where a in 1..2", "in")).toBe("keyword.operator.membership.oqx");
    expect(await scopesOf("from r where a in 1..2", "..")).toBe("keyword.operator.range.oqx");
    expect(await scopesOf("from r where $depth > 1", "$depth")).toBe("variable.language.oqx");
    expect(await scopesOf("from r where text('a')", "text")).toBe("support.function.omgbase.oqx");
    expect(await scopesOf("from r where size(a) > 1", "size")).toBe("support.function.builtin.oqx");
    expect(await scopesOf("from r where foo(a)", "foo")).toBe("entity.name.function.oqx");
    expect(await scopesOf("from r where a # b", "#")).toBe("invalid.illegal.oqx");
  });
});
