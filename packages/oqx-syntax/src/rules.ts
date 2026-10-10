// The highlighting rules — one ordered table both grammars are serialized from.
//
// Every rule is a regular expression whose source is valid for Oniguruma
// (TextMate) and for JavaScript (Monarch) alike: no lookbehind (Monarch matches
// against the rest of the line, so earlier text is never visible), `$` means
// end of line in both, and lookahead may inspect the rest of the line. Rules are
// tried in order at each position and the first match wins — TextMate resolves
// a tie at one position by rule order, Monarch by rule order outright — so the
// table is ordered from the most specific shape to the most general.
//
// Contextual words (`count`, `limit`, `asc`, `in`, …) are syntax only in position
// (GRAMMAR §1); a lexical grammar approximates that position with lookahead: a
// consumer is a consumer word followed by `{` (or `distinct {`), a bound is
// `limit`/`offset` followed by a number, `^` or a binding, and so on. Anywhere
// else the word is an ordinary identifier — exactly the specification's reading.
// Lookahead is written with `[ \t]` rather than `\s` so that every grammar,
// including Prism's whole-text matcher, is bounded by the line the way the
// line-oriented engines (TextMate, Monarch, CodeMirror) inherently are.

import {
  BUILTIN_FUNCTIONS,
  BUILTIN_METHODS,
  CONSUMERS,
  CONTEXTUAL_WORDS,
  IDENTIFIER,
  KEYWORDS,
  LITERALS,
  OMGBASE,
  OPERATORS,
  WORD_OPERATORS,
  alternation,
  type TokenClass,
} from "./vocabulary.js";

/** A capture group's token: a class, whitespace (unscoped), or a word-list
 * classification (`cases`) with a default. */
export type GroupAction =
  | TokenClass
  | "whitespace"
  | { cases: ReadonlyArray<{ words: readonly string[]; token: TokenClass }>; default: TokenClass };

export interface Rule {
  /** Repository key in the TextMate grammar; a comment in Monarch. */
  name: string;
  /** Regex source. Write `IDENT` where the identifier shape goes; a group whose
   * action is a `cases` object must consist of exactly `(IDENT)`. */
  regex: string;
  /** One action per capture group, or a single action for a group-less match. */
  groups: readonly GroupAction[];
}

/** Ends a word: the next character cannot continue an identifier. `\b` would
 * not do — `$` is an identifier character in OQX but not a regex word character. */
export const END = "(?![A-Za-z0-9_$])";

/** Words that cannot begin a value (GRAMMAR §4): the keywords — except the prefix
 * operators `is` and `not`, which begin one — and the contextual words. */
const NON_VALUE_WORDS = [...KEYWORDS.filter((k) => k !== "is" && k !== "not"), ...CONTEXTUAL_WORDS];

/** Lookahead: the rest of the line begins a value — an identifier, an
 * intrinsic or binding (`$`), an outer reference, a group, a string, a number,
 * a unary operator, or an open-low range — and not a clause word. */
const VALUE_START =
  `(?![ \\t]*(?:${alternation(NON_VALUE_WORDS)})${END})` +
  `(?=[ \\t]*(?:[A-Za-z_$^("'0-9!\\-]|\\.\\.))`;

const words = (ws: readonly string[]): string => `(?:${alternation(ws)})${END}`;

export const RULES: readonly Rule[] = [
  // ---- literals with internal structure ------------------------------------
  { name: "binding", regex: "\\$\\{[^}]*\\}", groups: ["binding"] },

  // Malformed numbers are lex errors (GRAMMAR §1); they are matched before the
  // number rule so `1.` / `1e` / `.5` are marked rather than split.
  { name: "number-trailing-dot", regex: "[0-9]+\\.(?![.0-9])", groups: ["numberInvalid"] },
  { name: "number-bad-exponent", regex: "[0-9]+(?:\\.[0-9]+)?[eE](?:[+\\-](?![0-9])|(?![0-9+\\-]))", groups: ["numberInvalid"] },
  { name: "number-leading-dot", regex: "\\.[0-9]+(?:\\.[0-9]+)?(?:[eE][+\\-]?[0-9]+)?", groups: ["numberInvalid"] },
  { name: "number", regex: "[0-9]+(?:\\.[0-9]+)?(?:[eE][+\\-]?[0-9]+)?", groups: ["number"] },

  // `...` before `..` before `.` (GRAMMAR §1: the range operator is scanned first).
  { name: "range", regex: alternation(OPERATORS.range), groups: ["range"] },
  {
    name: "member-call",
    regex: "(\\.)(IDENT)(?=[ \\t]*\\()",
    groups: ["accessor", { cases: [{ words: BUILTIN_METHODS, token: "builtinMethod" }], default: "method" }],
  },
  { name: "member", regex: "(\\.)(IDENT)", groups: ["accessor", "member"] },
  { name: "accessor", regex: "\\.", groups: ["accessor"] },

  // ---- words in position ----------------------------------------------------
  { name: "select-distinct", regex: `(select)([ \\t]+)(distinct)${END}`, groups: ["keyword", "whitespace", "modifier"] },
  { name: "follow-distinct", regex: `(follow)([ \\t]+)(distinct)${END}`, groups: ["clause", "whitespace", "modifier"] },
  { name: "order-by", regex: `(order)([ \\t]+)(by)${END}`, groups: ["clause", "whitespace", "clause"] },
  // The word operators (`is`, `not`, `and`, `or`) are keywords too (GRAMMAR §1),
  // highlighted as operators; before the keyword rule so it never claims them.
  { name: "word-operator", regex: words(WORD_OPERATORS), groups: ["wordOperator"] },
  { name: "keyword", regex: words(KEYWORDS), groups: ["keyword"] },
  {
    name: "consumer",
    regex: `${words(CONSUMERS)}(?=[ \\t]*(?:distinct${END}[ \\t]*)?\\{)`,
    groups: ["consumer"],
  },
  // `follow` is a clause when an identifier, a binding, or a `^` follows (GRAMMAR §3).
  { name: "follow", regex: `follow${END}(?=[ \\t]+[A-Za-z_$^])`, groups: ["clause"] },
  // `limit` / `offset` are bounds when a number, a binding, or `^name` follows.
  { name: "bound", regex: `${words(["limit", "offset"])}(?=[ \\t]+(?:[0-9^]|\\$\\{))`, groups: ["clause"] },
  // Options in a `follow { … }` block; `where` is already a keyword.
  { name: "follow-option", regex: `${words(["frontier", "depth", "by"])}${VALUE_START}`, groups: ["followOption"] },
  {
    name: "order-direction",
    regex: `${words(["asc", "desc"])}(?=[ \\t]*(?:,|\\}|$|${words(["limit", "offset"])}))`,
    groups: ["modifier"],
  },
  {
    name: "values",
    regex: `values${END}(?=[ \\t]*(?:\\}|$|${words(["from", "where", "follow", "order", "limit", "offset"])}))`,
    groups: ["modifier"],
  },
  { name: "distinct", regex: `distinct${END}(?=[ \\t]*\\{)`, groups: ["modifier"] },
  // `in` is the membership operator when a value follows; otherwise a field
  // (the omgbase `docs` root has an `in` relation: `in exists { … }`, `follow in`).
  { name: "membership", regex: `in${END}${VALUE_START}`, groups: ["membership"] },
  { name: "literal", regex: words(LITERALS), groups: ["literal"] },

  // ---- names ----------------------------------------------------------------
  { name: "alias", regex: "IDENT(?=[ \\t]*:)", groups: ["alias"] },
  {
    name: "call",
    regex: "(IDENT)(?=[ \\t]*\\()",
    groups: [
      {
        cases: [
          { words: BUILTIN_FUNCTIONS, token: "builtinFunction" },
          { words: OMGBASE.rowFunctions, token: "hostFunction" },
        ],
        default: "function",
      },
    ],
  },
  { name: "intrinsic", regex: "\\$[A-Za-z0-9_$]*", groups: ["intrinsic"] },
  { name: "identifier", regex: "IDENT", groups: ["identifier"] },

  // ---- operators and punctuation -------------------------------------------
  {
    name: "operator",
    regex: alternation([...OPERATORS.comparison, ...OPERATORS.logical, ...OPERATORS.arithmetic]),
    groups: ["operator"],
  },
  { name: "lift", regex: "\\^", groups: ["lift"] },
  { name: "comma", regex: ",", groups: ["comma"] },
  { name: "colon", regex: ":", groups: ["colon"] },
  { name: "brace-open", regex: "\\{", groups: ["braceOpen"] },
  { name: "brace-close", regex: "\\}", groups: ["braceClose"] },
  { name: "paren-open", regex: "\\(", groups: ["parenOpen"] },
  { name: "paren-close", regex: "\\)", groups: ["parenClose"] },
  { name: "bracket-open", regex: "\\[", groups: ["bracketOpen"] },
  { name: "bracket-close", regex: "\\]", groups: ["bracketClose"] },

  // Anything else is a lex error (GRAMMAR §1): `=`, `&`, `|`, `@`, `;`, `#`, …
  { name: "illegal", regex: "[^ \\t\\r\\n]", groups: ["illegal"] },
];

/** The string rules, shared by both grammars: `"…"` and `'…'` with `\<c>` escapes
 * (GRAMMAR §1). A string may span lines; a `\` at the end of a line escapes the newline. */
export const STRINGS = [
  { name: "string-double", quote: '"', body: '[^\\\\"]+' },
  { name: "string-single", quote: "'", body: "[^\\\\']+" },
] as const;
export const STRING_ESCAPE = "\\\\(?:.|$)";

/** Whitespace as OQX defines it (GRAMMAR §1): space, tab, newline, carriage return. */
export const WHITESPACE = "[ \\t\\r\\n]+";

/** Substitute the identifier shape into a rule's regex source. */
export function withIdent(regex: string): string {
  return regex.replaceAll("IDENT", IDENTIFIER);
}

/** Expand every `cases` group into ordinary rules: one per word list, most
 * specific first, then the default over the identifier shape. Grammars that
 * cannot classify a match by word list (TextMate, Prism) serialize these. */
export function expandCases(rule: Rule): Rule[] {
  const caseIndex = rule.groups.findIndex((g) => typeof g === "object");
  if (caseIndex === -1) return [rule];
  const cases = rule.groups[caseIndex] as Extract<GroupAction, object>;
  const out: Rule[] = [];
  for (const c of cases.cases) {
    const regex = rule.regex.replace("(IDENT)", `((?:${alternation(c.words)})${END})`);
    out.push({ name: `${rule.name}-${c.token}`, regex, groups: rule.groups.map((g, i) => (i === caseIndex ? c.token : g)) });
  }
  out.push({ name: rule.name, regex: rule.regex, groups: rule.groups.map((g, i) => (i === caseIndex ? cases.default : g)) });
  return out;
}

/** Split a rule's regex into its top-level capture groups and the trailing
 * (lookahead) tail: `(a)(b)(?=c)` → `{ groups: ["a", "b"], tail: "(?=c)" }`. A
 * regex without capture groups is one group with no tail. */
export function splitGroups(regex: string): { groups: string[]; tail: string } {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  for (; i < regex.length; i++) {
    const c = regex[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      // skip a character class
      i++;
      if (regex[i] === "^") i++;
      if (regex[i] === "]") i++;
      while (i < regex.length && regex[i] !== "]") {
        if (regex[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") {
      if (depth === 0) {
        if (regex[i + 1] === "?") {
          if (groups.length > 0) break; // the tail begins
        } else start = i;
      }
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0 && start !== -1) {
        groups.push(regex.slice(start + 1, i));
        start = -1;
        if (regex[i + 1] !== "(") {
          i++;
          break;
        }
      }
    }
  }
  if (groups.length === 0) return { groups: [regex], tail: "" };
  return { groups, tail: regex.slice(i) };
}
