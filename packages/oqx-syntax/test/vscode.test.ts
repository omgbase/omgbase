// The VS Code extension's Markdown injection grammar: loaded on its own (VS Code
// injects it into `text.html.markdown`), a ```oqx fence opens an embedded OQX
// block that the OQX grammar tokenizes, and the closing fence ends it.

import { describe, expect, it } from "vitest";
import { INITIAL, Registry, type IRawGrammar } from "vscode-textmate";
import { createOnigScanner, createOnigString } from "vscode-oniguruma";
import { oqxTextMateGrammar } from "../src/textmate.js";
import { LANGUAGE } from "../src/vocabulary.js";
import { MARKDOWN_EMBEDDED_SCOPE, MARKDOWN_INJECTION_SCOPE, buildMarkdownInjectionGrammar } from "../src/vscode.js";
import { loadOqxGrammar } from "./textmate-runtime.js";

describe("VS Code Markdown injection", () => {
  it("highlights a ```oqx fence with source.oqx and stops at the closing fence", async () => {
    await loadOqxGrammar(); // loads the Oniguruma wasm once
    const injection = buildMarkdownInjectionGrammar() as unknown as IRawGrammar;
    const registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: async (scope) =>
        scope === MARKDOWN_INJECTION_SCOPE ? injection : scope === LANGUAGE.scopeName ? (oqxTextMateGrammar as unknown as IRawGrammar) : null,
    });
    const grammar = await registry.loadGrammar(MARKDOWN_INJECTION_SCOPE);
    expect(grammar).not.toBeNull();
    const lines = ["```oqx", "name from people where age > 30", "```", "from is prose here"];
    let state = INITIAL;
    const perLine = lines.map((line) => {
      const r = grammar!.tokenizeLine(line, state);
      state = r.ruleStack;
      return r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
    });
    expect(perLine[0]!.some((t) => t.text === "oqx" && t.scopes.includes("fenced_code.block.language.markdown"))).toBe(true);
    const from = perLine[1]!.find((t) => t.text === "from");
    // vscode-textmate does not push an included grammar's root scope; the
    // embedded scope plus the OQX rule scopes is what a theme sees.
    expect(from?.scopes).toEqual([MARKDOWN_INJECTION_SCOPE, "markup.fenced_code.block.markdown", MARKDOWN_EMBEDDED_SCOPE, "keyword.control.oqx"]);
    expect(perLine[2]!.some((t) => t.scopes.includes("punctuation.definition.markdown"))).toBe(true);
    for (const t of perLine[3]!) expect(t.scopes.some((s) => s.endsWith(".oqx"))).toBe(false);
  });
});
