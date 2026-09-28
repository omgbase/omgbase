// Shiki adapter: the TextMate grammar in the shape of a Shiki `LanguageRegistration`
// (a raw grammar plus `name`, `displayName`, `aliases`). No import of Shiki — the
// object is structurally typed so this package stays dependency-free.
//
//   import { createHighlighter } from "shiki";
//   import { oqxShikiLanguage } from "@omgbase/oqx-syntax/shiki";
//   const hl = await createHighlighter({ themes: ["github-dark"], langs: [oqxShikiLanguage] });
//   hl.codeToHtml("name from people where age > 30", { lang: "oqx", theme: "github-dark" });
//
// Markdown fences tagged ```oqx select the grammar once it is registered.

import { oqxTextMateGrammar, type TextMateGrammar } from "./textmate.js";
import { LANGUAGE } from "./vocabulary.js";

export interface ShikiLanguageRegistration extends Omit<TextMateGrammar, "name"> {
  /** The language id (`oqx`) — Shiki's `name` is the id, not the display name. */
  name: string;
  displayName: string;
  aliases: string[];
  embeddedLangs: string[];
}

export const oqxShikiLanguage: ShikiLanguageRegistration = {
  ...oqxTextMateGrammar,
  name: LANGUAGE.id,
  displayName: LANGUAGE.displayName,
  aliases: LANGUAGE.aliases.filter((a) => a !== LANGUAGE.id),
  embeddedLangs: [],
};

/** Convenience for `createHighlighter({ langs: oqxShikiLanguages })`. */
export const oqxShikiLanguages: ShikiLanguageRegistration[] = [oqxShikiLanguage];
