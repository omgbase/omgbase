// The TextMate grammar (`source.oqx`), serialized from `rules.ts`. A `cases`
// group becomes one rule per word list (most specific first) plus the default;
// everything else maps one to one. The grammar is flat: no begin/end states
// except block comments, strings and template literals, so a stray bracket never
// swallows the rest of the document. A template literal (0.21) is a begin/end
// rule whose `${ … }` interpolation re-enters `#expression`; a `{` inside an
// interpolation opens a nested begin/end block so the interpolation's own `}` is
// the one that balances it. A block comment (0.28) is a begin/end rule with no
// inner patterns; a line comment a plain match.

import { COMMENTS, RULES, STRINGS, STRING_ESCAPE, TEMPLATE_LITERAL, expandCases, withIdent, type GroupAction, type Rule } from "./rules.js";
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
  // Comments (0.28) come first: whitespace to the lexer, and `//` / `/*` must
  // never reach the operator rule. The delimiters carry the conventional
  // `punctuation.definition.comment` scopes inside the comment's own.
  add("comment-line", {
    comment: "comment-line",
    match: `(${COMMENTS.lineOpen}).*`,
    name: scope("commentLine"),
    captures: { "1": { name: "punctuation.definition.comment.oqx" } },
  });
  add("comment-block", {
    comment: "comment-block",
    name: scope("commentBlock"),
    begin: COMMENTS.blockOpen,
    end: COMMENTS.blockClose,
    beginCaptures: { "0": { name: "punctuation.definition.comment.begin.oqx" } },
    endCaptures: { "0": { name: "punctuation.definition.comment.end.oqx" } },
  });
  for (const s of STRINGS) add(s.name, stringRule(s.name, s.quote));
  repository["string-escape"] = { comment: "string-escape", match: STRING_ESCAPE, name: scope("stringEscape") };
  // The template literal: the backticks and the text are `template`, an escape is
  // the string escape, `${` … `}` is an interpolation holding `#expression` again.
  // The rule carries no `name` of its own, so whitespace inside an interpolation
  // stays unscoped exactly as it is at the top level.
  const mark = (cls: TokenClass): Record<string, { name: string }> => ({ "0": { name: scope(cls) } });
  add("template", {
    comment: "template",
    begin: TEMPLATE_LITERAL.quote,
    end: TEMPLATE_LITERAL.quote,
    beginCaptures: mark("template"),
    endCaptures: mark("template"),
    patterns: [{ include: "#string-escape" }, { include: "#template-interpolation" }, { include: "#template-text" }],
  });
  repository["template-text"] = { comment: "template-text", match: TEMPLATE_LITERAL.text, name: scope("template") };
  repository["template-interpolation"] = {
    comment: "template-interpolation",
    begin: TEMPLATE_LITERAL.interpolationOpen,
    end: TEMPLATE_LITERAL.interpolationClose,
    beginCaptures: mark("interpolation"),
    endCaptures: mark("interpolation"),
    // A `{` opens a nested block before the flat brace rule can claim it, so the
    // block's `}` ends the block rather than the interpolation.
    patterns: [{ include: "#template-block" }, { include: "#expression" }],
  };
  repository["template-block"] = {
    comment: "template-block",
    begin: "\\{",
    end: "\\}",
    beginCaptures: mark("braceOpen"),
    endCaptures: mark("braceClose"),
    patterns: [{ include: "#template-block" }, { include: "#expression" }],
  };
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
