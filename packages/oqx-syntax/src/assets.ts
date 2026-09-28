// The generated files, by path relative to the package root. `scripts/generate.mjs`
// writes them after a build; `test/assets.test.ts` fails when a checked-in file
// differs from what would be written, so the JSON never drifts from the source.

import { oqxLanguageConfiguration } from "./language-configuration.js";
import { oqxMonarchGrammar } from "./monarch.js";
import { oqxTextMateGrammar } from "./textmate.js";
import { buildMarkdownInjectionGrammar, buildVsCodeManifest } from "./vscode.js";

/** @param version the package version, stamped into the VS Code extension manifest */
export function buildAssets(version: string): Record<string, unknown> {
  return {
    "syntax/oqx.tmLanguage.json": oqxTextMateGrammar,
    "syntax/oqx.monarch.json": oqxMonarchGrammar,
    "syntax/language-configuration.json": oqxLanguageConfiguration,
    "vscode/package.json": buildVsCodeManifest(version),
    "vscode/language-configuration.json": oqxLanguageConfiguration,
    "vscode/syntaxes/oqx.tmLanguage.json": oqxTextMateGrammar,
    "vscode/syntaxes/oqx.markdown-injection.tmLanguage.json": buildMarkdownInjectionGrammar(),
  };
}

/** The on-disk rendering: two-space JSON with a trailing newline. */
export function renderAsset(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
