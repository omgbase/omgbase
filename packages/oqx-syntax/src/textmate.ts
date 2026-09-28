// The TextMate grammar (`source.oqx`), serialized from `rules.ts`. A `cases`
// group becomes one rule per word list (most specific first) plus the default;
// everything else maps one to one. The grammar is flat: no begin/end states
// except strings, so a stray bracket never swallows the rest of the document.

import { RULES, STRINGS, STRING_ESCAPE, expandCases, withIdent, type GroupAction, type Rule } from "./rules.js";
import { LANGUAGE, LANGUAGE_VERSION, TOKEN_CLASSES, type TokenClass } from "./vocabulary.js";

export interface TextMateRule {
  comment?: string;
  name?: string;
  match?: string;
  captures?: Record<string, { name: string }>;
  begin?: string;
  end?: string;
  beginCaptures?: Record<string, { name: string }>;
  endCaptures?: Record<string, { name: string }>;
  patterns?: TextMateRule[];
  include?: string;
}

export interface TextMateGrammar {
  $schema: string;
  name: string;
  scopeName: string;
  fileTypes: string[];
  /** The `spec/oqx` language version the grammar describes (informational). */
  version: string;
  patterns: TextMateRule[];
  repository: Record<string, TextMateRule>;
}

const scope = (cls: TokenClass): string => TOKEN_CLASSES[cls].textmate;

/** One rule → its TextMate rules (several when a group has `cases`). */
function expand(rule: Rule): TextMateRule[] {
  return expandCases(rule).map((r) => plain(r.name, withIdent(r.regex), r.groups));
}

function plain(name: string, regex: string, groups: readonly GroupAction[]): TextMateRule {
  if (groups.length === 1) {
    const g = groups[0]!;
    if (typeof g !== "string" || g === "whitespace") throw new Error(`rule ${name}: a single group must be a token class`);
    return { comment: name, match: regex, name: scope(g) };
  }
  const captures: Record<string, { name: string }> = {};
  groups.forEach((g, i) => {
    if (typeof g !== "string") throw new Error(`rule ${name}: unexpanded cases in group ${i + 1}`);
    if (g !== "whitespace") captures[String(i + 1)] = { name: scope(g) };
  });
  return { comment: name, match: regex, captures };
}

function stringRule(name: string, quote: string): TextMateRule {
  const kind = quote === '"' ? "double" : "single";
  return {
    comment: name,
    name: `${scope("string").replace(/\.oqx$/, "")}.${kind}.oqx`,
    begin: quote,
    end: quote,
    beginCaptures: { "0": { name: "punctuation.definition.string.begin.oqx" } },
    endCaptures: { "0": { name: "punctuation.definition.string.end.oqx" } },
    patterns: [{ include: "#string-escape" }],
  };
}

/** Build the grammar as a plain JSON-serializable object. */
export function buildTextMateGrammar(): TextMateGrammar {
  const repository: Record<string, TextMateRule> = {};
  const order: string[] = [];
  const add = (key: string, r: TextMateRule): void => {
    if (repository[key]) throw new Error(`duplicate repository key ${key}`);
    repository[key] = r;
    order.push(key);
  };
  for (const s of STRINGS) add(s.name, stringRule(s.name, s.quote));
  repository["string-escape"] = { comment: "string-escape", match: STRING_ESCAPE, name: scope("stringEscape") };
  for (const rule of RULES) for (const r of expand(rule)) add(r.comment!, r);
  repository["expression"] = { patterns: order.map((key) => ({ include: `#${key}` })) };
  return {
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: LANGUAGE.displayName,
    scopeName: LANGUAGE.scopeName,
    fileTypes: LANGUAGE.extensions.map((e) => e.slice(1)),
    version: LANGUAGE_VERSION,
    patterns: [{ include: "#expression" }],
    repository,
  };
}

/** The OQX TextMate grammar. Identical to `syntax/oqx.tmLanguage.json`. */
export const oqxTextMateGrammar: TextMateGrammar = buildTextMateGrammar();
