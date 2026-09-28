// Monaco adapter: register OQX with a `monaco` instance — the language, its
// Monarch tokenizer and its configuration — through a minimal structural type,
// so this package never imports `monaco-editor`.
//
//   import * as monaco from "monaco-editor";
//   import { registerOqx } from "@omgbase/oqx-syntax/monaco";
//   registerOqx(monaco);
//   monaco.editor.create(el, { language: "oqx", value: "name from people" });

import { oqxLanguageConfiguration, type LanguageConfiguration } from "./language-configuration.js";
import { oqxMonarchGrammar, type MonarchGrammar } from "./monarch.js";
import { LANGUAGE } from "./vocabulary.js";

export interface MonacoLanguageExtensionPoint {
  id: string;
  extensions: string[];
  aliases: string[];
  mimetypes: string[];
}

/** Monaco's `LanguageConfiguration` for OQX: `wordPattern` as a RegExp. */
export interface MonacoLanguageConfiguration extends Omit<LanguageConfiguration, "wordPattern"> {
  wordPattern: RegExp;
}

/** The subset of `monaco.languages` this adapter needs. */
export interface MonacoLanguagesLike {
  register(language: MonacoLanguageExtensionPoint): void;
  setMonarchTokensProvider(languageId: string, grammar: MonarchGrammar): unknown;
  setLanguageConfiguration(languageId: string, configuration: MonacoLanguageConfiguration): unknown;
}

export const oqxMonacoLanguage: MonacoLanguageExtensionPoint = {
  id: LANGUAGE.id,
  extensions: [...LANGUAGE.extensions],
  aliases: [...LANGUAGE.aliases],
  mimetypes: [...LANGUAGE.mimeTypes],
};

export const oqxMonacoLanguageConfiguration: MonacoLanguageConfiguration = {
  ...oqxLanguageConfiguration,
  wordPattern: new RegExp(oqxLanguageConfiguration.wordPattern, "g"),
};

/** Register OQX (language, Monarch tokens, configuration). Returns the language id. */
export function registerOqx(monaco: { languages: MonacoLanguagesLike }): string {
  monaco.languages.register(oqxMonacoLanguage);
  monaco.languages.setMonarchTokensProvider(LANGUAGE.id, oqxMonarchGrammar);
  monaco.languages.setLanguageConfiguration(LANGUAGE.id, oqxMonacoLanguageConfiguration);
  return LANGUAGE.id;
}
