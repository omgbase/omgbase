// @omgbase/oqx-syntax — syntax highlighting assets for OQX.
//
// One lexical vocabulary (`vocabulary.ts`) and one ordered rule table (`rules.ts`)
// generate every artifact: the TextMate grammar (`source.oqx`), the Monaco Monarch
// grammar, the editor language configuration, and the Shiki / Monaco / VS Code
// adapters. The JSON files under `syntax/` are those objects serialized; the tests
// prove the two grammars tokenize identically and pin the vocabulary to `spec/oqx`.
//
// Highlighting is lexical and lives apart from the parser: `@omgbase/oqx` stays
// the semantic source of truth, and this package never imports it at run time.

export {
  LANGUAGE,
  LANGUAGE_VERSION,
  KEYWORDS,
  WORD_OPERATORS,
  CONTEXTUAL_WORDS,
  CONSUMERS,
  CLAUSE_WORDS,
  FOLLOW_OPTIONS,
  MODIFIERS,
  LITERALS,
  OPERATORS,
  PUNCTUATION,
  BUILTIN_FUNCTIONS,
  BUILTIN_METHODS,
  INTRINSICS,
  IDENTIFIER,
  ILLEGAL_CHARACTERS,
  OMGBASE,
  TOKEN_CLASSES,
  type TokenClass,
} from "./vocabulary.js";
export { RULES, STRINGS, STRING_ESCAPE, WHITESPACE, type Rule, type GroupAction } from "./rules.js";
export { oqxTextMateGrammar, buildTextMateGrammar, type TextMateGrammar, type TextMateRule } from "./textmate.js";
export { oqxMonarchGrammar, buildMonarchGrammar, type MonarchGrammar, type MonarchRule, type MonarchAction } from "./monarch.js";
export { oqxLanguageConfiguration, type LanguageConfiguration } from "./language-configuration.js";
export { oqxShikiLanguage, oqxShikiLanguages, type ShikiLanguageRegistration } from "./shiki.js";
export {
  registerOqx,
  oqxMonacoLanguage,
  oqxMonacoLanguageConfiguration,
  type MonacoLanguagesLike,
  type MonacoLanguageExtensionPoint,
  type MonacoLanguageConfiguration,
} from "./monaco.js";
export {
  buildMarkdownInjectionGrammar,
  buildVsCodeManifest,
  MARKDOWN_INJECTION_SCOPE,
  MARKDOWN_EMBEDDED_SCOPE,
} from "./vscode.js";
export { buildAssets, renderAsset } from "./assets.js";
export {
  oqxStreamParser,
  oqxLegacyMode,
  oqxTokenTable,
  resolveTag,
  nextToken,
  startState,
  copyState,
  type StreamLike,
  type OqxStreamState,
  type HighlightTagsLike,
} from "./codemirror.js";
export { oqxPrismGrammar, buildPrismGrammar, registerOqxPrism, type PrismGrammar, type PrismToken } from "./prism.js";
