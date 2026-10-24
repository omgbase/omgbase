// Prism: class-level parity with the TextMate grammar over the corpus and every
// spec fixture, tokenizing with the real prismjs.

import { describe, expect, it } from "vitest";
import Prism from "prismjs";
import { CONTAINER, oqxPrismGrammar, registerOqxPrism } from "../src/prism.js";
import { TOKEN_CLASSES, type TokenClass } from "../src/vocabulary.js";
import { CORPUS } from "./corpus.js";
import { specQueries } from "./spec-fixtures.js";
import { tokenizeTextMate } from "./textmate-runtime.js";
import { normalize, render, type ClassToken } from "./tokens.js";

const classes = new Set(Object.keys(TOKEN_CLASSES));

function flatten(tokens: Array<string | Prism.Token>, out: Array<{ text: string; cls: TokenClass | null }>, parent: TokenClass | null): void {
  for (const t of tokens) {
    if (typeof t === "string") {
      // Text inside a classed token is content of that class, blank or not (the
      // space between two interpolations of a template literal is template text);
      // outside one it may only be whitespace.
      if (t.trim() !== "" && parent === null) throw new Error(`untokenized text ${JSON.stringify(t)}`);
      out.push({ text: t, cls: parent });
      continue;
    }
    const aliasList = Array.isArray(t.alias) ? t.alias : t.alias ? [t.alias] : [];
    const alias = aliasList.includes(CONTAINER) ? undefined : [t.type, ...aliasList].find((n) => classes.has(n));
    if (alias === undefined) {
      // a container token: its inside tokens carry the classes
      if (typeof t.content === "string") throw new Error(`container ${t.type} without inside tokens`);
      flatten(Array.isArray(t.content) ? t.content : [t.content], out, null);
      continue;
    }
    const cls = alias as TokenClass;
    if (typeof t.content === "string") out.push({ text: t.content, cls });
    else flatten(Array.isArray(t.content) ? t.content : [t.content], out, cls);
  }
}

function tokenizePrism(source: string): ClassToken[] {
  const out: Array<{ text: string; cls: TokenClass | null }> = [];
  flatten(Prism.tokenize(source, oqxPrismGrammar as unknown as Prism.Grammar), out, null);
  return normalize(out);
}

describe("Prism grammar", () => {
  it("agrees with TextMate over the corpus", () => {
    for (const sample of CORPUS) expect(render(tokenizePrism(sample.source)), sample.name).toBe(sample.tokens);
  });

  it("agrees with TextMate over every spec/oqx fixture query", async () => {
    for (const q of specQueries()) {
      expect(render(tokenizePrism(q.source)), `${q.suite} / ${q.name}: ${q.source}`).toBe(render(await tokenizeTextMate(q.source)));
    }
  });

  it("registers as Prism.languages.oqx and highlights with standard classes", () => {
    expect(registerOqxPrism(Prism)).toBe("oqx");
    expect(Prism.languages.oqx).toBe(oqxPrismGrammar);
    const html = Prism.highlight("name from people where jobs count { } > 1 && size(x) > 1 && a in 1..2", Prism.languages.oqx!, "oqx");
    expect(html).toContain('<span class="token keyword">from</span>');
    expect(html).toContain('<span class="token consumer keyword">count</span>');
    expect(html).toContain('<span class="token call-builtinFunction builtinFunction builtin">size</span>');
    expect(html).toContain('<span class="token membership keyword">in</span>');
    expect(html).toContain('<span class="token range operator">..</span>');
    expect(html).toContain('<span class="token identifier">name</span>');
    const commented = Prism.highlight("name /* a\nb */ from r // c", Prism.languages.oqx!, "oqx");
    expect(commented).toContain('<span class="token comment-block commentBlock comment">/* a\nb */</span>');
    expect(commented).toContain('<span class="token comment-line commentLine comment">// c</span>');
  });

  it("every pattern has the m flag and the keys are unique rule names", () => {
    // A container (a multi-group match, an interpolation) is named by the tokens
    // inside it; `rest` is Prism's re-entry into the whole grammar, not a token.
    const named = (k: string, t: { alias: string[] }) => classes.has(k) || t.alias.some((a) => classes.has(a) || a === CONTAINER);
    for (const [key, token] of Object.entries(oqxPrismGrammar)) {
      if (key === "rest") continue;
      expect(token.pattern.flags, key).toContain("m");
      if (token.inside) {
        for (const [k, inner] of Object.entries(token.inside)) {
          if (k === "rest") continue;
          expect(named(k, inner as { alias: string[] }), k).toBe(true);
        }
      } else expect(named(key, token), key).toBe(true);
    }
    // Before Prism first runs it, an interpolation's inside grammar re-enters the
    // whole grammar through `rest` (Prism then splices the tokens in and drops the key).
    const interpolation = oqxPrismGrammar.template!.inside!["template-interpolation"]!;
    const inside = interpolation.inside as Record<string, unknown>;
    expect(inside.rest === oqxPrismGrammar || inside.template === oqxPrismGrammar.template).toBe(true);
  });
});
