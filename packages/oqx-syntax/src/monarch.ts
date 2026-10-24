// The Monaco Monarch grammar, serialized from `rules.ts`. Regexes are emitted as
// strings (Monarch compiles them with `^(?:…)` against the rest of the line), a
// `cases` group becomes a Monarch `cases` object over word lists held as grammar
// attributes, and `tokenPostfix` appends `.oqx` to every token as Monaco's own
// languages do. `syntax/oqx.monarch.json` is this object serialized.

import { COMMENTS, RULES, STRINGS, STRING_ESCAPE, TEMPLATE_LITERAL, WHITESPACE, withIdent, type GroupAction, type Rule } from "./rules.js";
import { LANGUAGE, LANGUAGE_VERSION, TOKEN_CLASSES, type TokenClass } from "./vocabulary.js";

export type MonarchAction =
  | string
  | { token: string; next?: string }
  | { cases: Record<string, string> }
  | MonarchAction[];
export type MonarchRule = [string, MonarchAction] | { include: string };

export interface MonarchGrammar {
  /** Informational; Monaco ignores unknown attributes. */
  languageId: string;
  languageVersion: string;
  defaultToken: string;
  tokenPostfix: string;
  ignoreCase: false;
  brackets: Array<{ open: string; close: string; token: string }>;
  tokenizer: Record<string, MonarchRule[]>;
  /** Word lists referenced by `cases` (`@builtinMethods`, …). */
  [wordList: string]: unknown;
}

const token = (cls: TokenClass): string => TOKEN_CLASSES[cls].monarch;

/** Monarch cannot express `@` in a string regex (it names an attribute); write it as `\x40`. */
const monarchRegex = (regex: string): string => withIdent(regex).replaceAll("@", "\\x40");

function action(g: GroupAction, lists: Record<string, readonly string[]>, ruleName: string): MonarchAction {
  if (g === "whitespace") return "white";
  if (typeof g === "string") return token(g);
  const cases: Record<string, string> = {};
  for (const c of g.cases) {
    const key = `${ruleName}-${c.token}`.replace(/-(\w)/g, (_m, ch: string) => ch.toUpperCase());
    lists[key] = c.words;
    cases[`@${key}`] = token(c.token);
  }
  cases["@default"] = token(g.default);
  return { cases };
}

function convert(rule: Rule, lists: Record<string, readonly string[]>): MonarchRule {
  const regex = monarchRegex(rule.regex);
  if (rule.groups.length === 1) return [regex, action(rule.groups[0]!, lists, rule.name)];
  return [regex, rule.groups.map((g) => action(g, lists, rule.name))];
}

/** Build the grammar as a plain JSON-serializable object. */
export function buildMonarchGrammar(): MonarchGrammar {
  const lists: Record<string, readonly string[]> = {};
  const root: MonarchRule[] = [{ include: "@whitespace" }];
  const tokenizer: Record<string, MonarchRule[]> = { root };
  for (const s of STRINGS) {
    const state = s.name.replace(/-(\w)/g, (_m, ch: string) => ch.toUpperCase());
    root.push([s.quote, { token: token("string"), next: `@${state}` }]);
    tokenizer[state] = [
      [s.body, token("string")],
      [STRING_ESCAPE, token("stringEscape")],
      [s.quote, { token: token("string"), next: "@pop" }],
    ];
  }
  // The template literal (0.21): a `template` state for the text, an
  // `templateInterpolation` state that is the root grammar again plus the braces,
  // and a `templateBlock` state per `{` inside it so the interpolation's own `}`
  // is the one that pops back to the text.
  root.push([TEMPLATE_LITERAL.quote, { token: token("template"), next: "@template" }]);
  tokenizer["template"] = [
    [STRING_ESCAPE, token("stringEscape")],
    [TEMPLATE_LITERAL.interpolationOpen, { token: token("interpolation"), next: "@templateInterpolation" }],
    [TEMPLATE_LITERAL.quote, { token: token("template"), next: "@pop" }],
    [TEMPLATE_LITERAL.text, token("template")],
  ];
  tokenizer["templateInterpolation"] = [
    ["\\{", { token: token("braceOpen"), next: "@templateBlock" }],
    [TEMPLATE_LITERAL.interpolationClose, { token: token("interpolation"), next: "@pop" }],
    { include: "@root" },
  ];
  tokenizer["templateBlock"] = [
    ["\\{", { token: token("braceOpen"), next: "@templateBlock" }],
    ["\\}", { token: token("braceClose"), next: "@pop" }],
    { include: "@root" },
  ];
  for (const rule of RULES) root.push(convert(rule, lists));
  // Comments (0.28) live in the whitespace state, as Monaco's own languages keep
  // them: `root` includes it first, so `//` and `/*` never reach the operator
  // rule, and every state that includes `@root` (an interpolation, a block inside
  // one) sees them too. A block comment is its own state until `*/`.
  tokenizer["whitespace"] = [
    [WHITESPACE, "white"],
    [COMMENTS.blockOpen, { token: token("commentBlock"), next: "@comment" }],
    [COMMENTS.line, token("commentLine")],
  ];
  tokenizer["comment"] = [
    [COMMENTS.blockBody, token("commentBlock")],
    [COMMENTS.blockClose, { token: token("commentBlock"), next: "@pop" }],
  ];
  return {
    languageId: LANGUAGE.id,
    languageVersion: LANGUAGE_VERSION,
    defaultToken: token("illegal"),
    tokenPostfix: `.${LANGUAGE.id}`,
    ignoreCase: false,
    brackets: [
      { open: "{", close: "}", token: token("braceOpen") },
      { open: "(", close: ")", token: token("parenOpen") },
      { open: "[", close: "]", token: token("bracketOpen") },
    ],
    ...lists,
    tokenizer,
  };
}

/** The OQX Monarch grammar. Identical to `syntax/oqx.monarch.json`. */
export const oqxMonarchGrammar: MonarchGrammar = buildMonarchGrammar();
