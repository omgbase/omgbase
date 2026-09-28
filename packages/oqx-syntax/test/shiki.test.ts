// Shiki loads the grammar as a custom language and highlights with it — the
// docs / Astro path of the design note.

import { describe, expect, it } from "vitest";
import { createHighlighter, type BundledLanguage } from "shiki";
import { oqxShikiLanguage } from "../src/shiki.js";

describe("Shiki", () => {
  it("registers `oqx` and highlights a query", async () => {
    const hl = await createHighlighter({ themes: ["github-dark"], langs: [oqxShikiLanguage] });
    try {
      expect(hl.getLoadedLanguages()).toContain("oqx");
      const html = hl.codeToHtml('name from people where age > 30 && city == "NYC"', { lang: "oqx", theme: "github-dark" });
      expect(html).toContain("<pre");
      expect(html).toMatch(/<span style="color:#[0-9A-Fa-f]{6}">from<\/span>/);
      const tokens = hl.codeToTokensBase("from r where $depth > 1", { lang: "oqx" as BundledLanguage, theme: "github-dark", includeExplanation: true });
      const scopes = tokens.flat().flatMap((t) => t.explanation ?? []).flatMap((e) => e.scopes.map((s) => s.scopeName));
      expect(scopes).toContain("keyword.control.oqx");
      expect(scopes).toContain("variable.language.oqx");
    } finally {
      hl.dispose();
    }
  });
});
