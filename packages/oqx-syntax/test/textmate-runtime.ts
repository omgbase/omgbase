// Tokenize OQX with the real TextMate engine (vscode-textmate over Oniguruma),
// exactly as VS Code and Shiki do, and reduce each token to a token class.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { INITIAL, Registry, type IGrammar, type IRawGrammar } from "vscode-textmate";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { oqxTextMateGrammar } from "../src/textmate.js";
import { LANGUAGE, TOKEN_CLASSES, type TokenClass } from "../src/vocabulary.js";
import type { ClassToken } from "./tokens.js";
import { normalize } from "./tokens.js";

const require = createRequire(import.meta.url);

let grammarPromise: Promise<IGrammar> | undefined;

export function loadOqxGrammar(): Promise<IGrammar> {
  grammarPromise ??= (async () => {
    const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
    const registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: async (scopeName) => (scopeName === LANGUAGE.scopeName ? (oqxTextMateGrammar as unknown as IRawGrammar) : null),
    });
    const grammar = await registry.loadGrammar(LANGUAGE.scopeName);
    if (!grammar) throw new Error("grammar did not load");
    return grammar;
  })();
  return grammarPromise;
}

export interface ScopedToken {
  text: string;
  scopes: string[];
}

/** Raw tokens with their full scope stacks, line by line. */
export async function tokenizeScopes(source: string): Promise<ScopedToken[]> {
  const grammar = await loadOqxGrammar();
  const out: ScopedToken[] = [];
  let state = INITIAL;
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) out.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes });
    if (i < lines.length - 1) out.push({ text: "\n", scopes: [LANGUAGE.scopeName] });
    state = r.ruleStack;
  });
  return out;
}

/** Innermost scope that names a token class (longest class prefix wins);
 * whitespace-only text or the bare `source.oqx` stack is `null`. */
export function classOfScopes(scopes: readonly string[]): TokenClass | null {
  for (let i = scopes.length - 1; i > 0; i--) {
    const cls = classOfScope(scopes[i]!);
    if (cls) return cls;
  }
  return null;
}

const byScope: Array<[string, TokenClass]> = (Object.entries(TOKEN_CLASSES) as Array<[TokenClass, { textmate: string }]>)
  .map(([cls, v]) => [v.textmate.replace(/\.oqx$/, ""), cls] as [string, TokenClass])
  .sort((a, b) => b[0].length - a[0].length);

function classOfScope(scope: string): TokenClass | null {
  const bare = scope.replace(/\.oqx$/, "");
  for (const [prefix, cls] of byScope) if (bare === prefix || bare.startsWith(prefix + ".")) return cls;
  return null;
}

/** Class tokens: whitespace dropped, adjacent same-class runs merged. */
export async function tokenizeTextMate(source: string): Promise<ClassToken[]> {
  const raw = await tokenizeScopes(source);
  return normalize(raw.map((t) => ({ text: t.text, cls: classOfScopes(t.scopes) })));
}
