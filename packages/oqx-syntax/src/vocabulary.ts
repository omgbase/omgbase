// The OQX lexical vocabulary — the single source every highlighting artifact in
// this package is generated from (the TextMate grammar, the Monarch grammar, the
// language configuration). It mirrors `spec/oqx/GRAMMAR.md` §1 (tokens) and the
// contextual-word list, `SEMANTICS.md` §11 (builtins) and §20 (recursion
// intrinsics), and — kept apart in `omgbase` — the names the omgbase surface
// (`spec/surface` §1.2–1.3) binds on top of the language.
//
// Highlighting is lexical: it colors by token shape and by position-free lookahead,
// never by parsing. The vocabulary therefore records *words*, not grammar, and the
// tests in `test/` pin it to the specification text so it cannot drift silently.

/** The OQX language version (`spec/oqx/VERSION`, `major.minor`) this vocabulary describes. */
export const LANGUAGE_VERSION = "0.18";

/** Reserved words: never usable as a bare field name (GRAMMAR §1). `is`, `not`,
 * `and`, `or` are the word operators (GRAMMAR §4, since 0.17). */
export const KEYWORDS = ["from", "where", "select", "is", "not", "and", "or"] as const;

/** The word operators among the keywords: prefix `is`/`not`, infix `is`/`is not`,
 * `and`/`or` (synonyms of `&&`/`||`). Highlighted as operators, not clauses. */
export const WORD_OPERATORS = ["is", "not", "and", "or"] as const;

/** Contextual words: syntax only in position, otherwise ordinary field names
 * (GRAMMAR §1). The order is the specification's. */
export const CONTEXTUAL_WORDS = [
  "collect", "exists", "none", "count", "first", "single",
  "order", "by", "asc", "desc", "follow", "distinct",
  "frontier", "depth", "in", "values", "limit", "offset",
] as const;

/** Consumer words: `receiver consumer [distinct] { body }` (GRAMMAR §2, §3). */
export const CONSUMERS = ["collect", "exists", "none", "count", "first", "single"] as const;

/** Words that open a clause: `order by`, `follow`, `limit`, `offset` (GRAMMAR §3). */
export const CLAUSE_WORDS = ["order", "by", "follow", "limit", "offset"] as const;

/** Options inside a `follow … { … }` block (GRAMMAR §3, `follow`). `where` is a keyword. */
export const FOLLOW_OPTIONS = ["where", "frontier", "depth", "by"] as const;

/** Modifiers: `distinct` (select/follow/consumer), `asc`/`desc` (order by), `values` (projection). */
export const MODIFIERS = ["distinct", "asc", "desc", "values"] as const;

/** Literal words — literals in every position (GRAMMAR §1). */
export const LITERALS = ["true", "false", "null"] as const;

/** Operators, longest first (GRAMMAR §1; the lexer's MULTI_OPS then SINGLE_OPS). */
export const OPERATORS = {
  comparison: ["==", "!=", "<=", ">=", "<", ">"],
  /** `!` is also the postfix required operator (`x!`, GRAMMAR §4) — lexically one token. */
  logical: ["&&", "||", "!"],
  arithmetic: ["+", "-", "*", "/", "%"],
  /** `..` inclusive, `...` exclusive high end; scanned before `.` (GRAMMAR §1). */
  range: ["...", ".."],
  /** The membership operator is a contextual word (GRAMMAR §4). */
  membership: ["in"],
} as const;

/** Punctuation (GRAMMAR §1). `^` is the outer-reference / lift marker (and, as
 * `N^`, the absolute scope reference — one lexeme, since 0.18); `[`/`]` are the
 * bracket lookup (since 0.17). */
export const PUNCTUATION = ["(", ")", "{", "}", "[", "]", ",", ":", ".", "^"] as const;

/** Free functions defined by the language (SEMANTICS §11). */
export const BUILTIN_FUNCTIONS = ["list", "size", "has", "range", "entries"] as const;

/** Methods defined by the language (SEMANTICS §11). */
export const BUILTIN_METHODS = ["lower", "upper", "contains", "startsWith", "endsWith", "matches", "size"] as const;

/** Intrinsics the language itself defines: the current item and entry key
 * (SEMANTICS §2, §21) and the recursion intrinsics of a `follow` occurrence (§20).
 * Any other `$name` is a host intrinsic — the grammar scopes every `$`-identifier
 * as `variable.language`, so hosts need not be enumerated to be highlighted. */
export const INTRINSICS = ["$it", "$key", "$depth", "$stop", "$leaf", "$frontier", "$ordinal"] as const;

/** Identifier shape (GRAMMAR §1): `[A-Za-z_$][A-Za-z0-9_$]*`. */
export const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";

/** Characters that are lex errors anywhere (GRAMMAR §1): there are no comments
 * and no single `=`/`&`/`|`. */
export const ILLEGAL_CHARACTERS = ["=", "&", "|", "@", ";", "#", "`", "~", "?", "\\"] as const;

/** Language metadata shared by every editor integration. */
export const LANGUAGE = {
  id: "oqx",
  scopeName: "source.oqx",
  displayName: "OQX",
  aliases: ["OQX", "oqx"],
  extensions: [".oqx"],
  mimeTypes: ["text/x-oqx"],
  /** Fenced-code-block info strings that should select this grammar. */
  fenceLanguages: ["oqx"],
} as const;

/**
 * The omgbase host vocabulary — names the omgbase surface (`spec/surface`
 * §1.2–1.3) binds on top of OQX. They are **not** part of the language:
 * `@omgbase/oqx` knows nothing of them, and another host may bind different
 * names. The grammar highlights the row functions (`text("…")`, `semantic("…")`,
 * …) as host functions; intrinsics and relations are listed for consumers such
 * as completion providers and are covered by the generic `$`-identifier rule.
 */
export const OMGBASE = {
  /** The named roots of a repository scope (`$repo.<root>` from any row). */
  roots: ["docs", "blocks", "nodes", "edges"],
  /** Row functions written as free calls, evaluated against the current row. */
  rowFunctions: [
    "text", "semantic",
    "under", "under_heading", "within", "under_kind", "yaml_path", "json_pointer",
    "has_edge", "has_anchor", "child_count", "parent_type",
  ],
  /** `$`-intrinsics by target (every one is scoped `variable.language` by shape). */
  intrinsics: {
    every: ["$repo"],
    docs: ["$id", "$path", "$content_hash", "$updated_at", "$body", "$title", "$tags"],
    blocks: ["$id", "$doc", "$path", "$ordinal", "$depth", "$body", "$content_hash", "$updated_at"],
    nodes: ["$id", "$node_id", "$doc_id", "$block_id", "$path"],
    edges: ["$id", "$src", "$dst", "$src_block", "$via", "$from_commit", "$path", "$dst_path", "$dst_uri"],
  },
  /** Relations reachable from a row (`follow children`, `nodes exists { … }`). */
  relations: [
    "nodes", "blocks", "out", "in", "out_edges", "in_edges",
    "children", "section", "subsections", "doc", "block",
  ],
} as const;

/**
 * Token classes: one name per kind of thing the highlighters distinguish, with
 * its TextMate scope, its Monarch token, its CodeMirror 6 highlight tag (a
 * `@lezer/highlight` tag expression such as `special(variableName)`), its
 * CodeMirror 5 style class, and its Prism standard class (null: unstyled).
 * Every grammar is generated from this table, and the parity tests map each
 * grammar's output back to these names to prove they agree.
 */
export const TOKEN_CLASSES = {
  keyword: { textmate: "keyword.control.oqx", monarch: "keyword", codemirror: "keyword", legacy: "keyword", prism: "keyword" },
  clause: { textmate: "keyword.control.clause.oqx", monarch: "keyword.clause", codemirror: "keyword", legacy: "keyword", prism: "keyword" },
  consumer: { textmate: "keyword.control.consumer.oqx", monarch: "keyword.consumer", codemirror: "controlKeyword", legacy: "keyword", prism: "keyword" },
  followOption: { textmate: "keyword.control.follow.oqx", monarch: "keyword.follow", codemirror: "keyword", legacy: "keyword", prism: "keyword" },
  modifier: { textmate: "keyword.other.modifier.oqx", monarch: "keyword.modifier", codemirror: "modifier", legacy: "keyword", prism: "keyword" },
  literal: { textmate: "constant.language.oqx", monarch: "constant.language", codemirror: "atom", legacy: "atom", prism: "boolean" },
  number: { textmate: "constant.numeric.oqx", monarch: "number", codemirror: "number", legacy: "number", prism: "number" },
  numberInvalid: { textmate: "invalid.illegal.number.oqx", monarch: "invalid.number", codemirror: "invalid", legacy: "error", prism: "invalid" },
  string: { textmate: "string.quoted.oqx", monarch: "string", codemirror: "string", legacy: "string", prism: "string" },
  stringEscape: { textmate: "constant.character.escape.oqx", monarch: "string.escape", codemirror: "escape", legacy: "string-2", prism: "symbol" },
  binding: { textmate: "variable.other.binding.oqx", monarch: "variable.binding", codemirror: "meta", legacy: "meta", prism: "variable" },
  intrinsic: { textmate: "variable.language.oqx", monarch: "variable.predefined", codemirror: "special(variableName)", legacy: "variable-2", prism: "builtin" },
  lift: { textmate: "keyword.operator.lift.oqx", monarch: "operator.lift", codemirror: "operator", legacy: "operator", prism: "operator" },
  alias: { textmate: "variable.other.alias.oqx", monarch: "identifier.alias", codemirror: "definition(propertyName)", legacy: "def", prism: "property" },
  builtinFunction: { textmate: "support.function.builtin.oqx", monarch: "predefined.function", codemirror: "standard(function(variableName))", legacy: "builtin", prism: "builtin" },
  hostFunction: { textmate: "support.function.omgbase.oqx", monarch: "predefined.function.omgbase", codemirror: "standard(function(variableName))", legacy: "builtin", prism: "builtin" },
  function: { textmate: "entity.name.function.oqx", monarch: "identifier.function", codemirror: "function(variableName)", legacy: "variable", prism: "function" },
  builtinMethod: { textmate: "support.function.method.oqx", monarch: "predefined.method", codemirror: "standard(function(variableName))", legacy: "builtin", prism: "builtin" },
  method: { textmate: "entity.name.function.method.oqx", monarch: "identifier.method", codemirror: "function(variableName)", legacy: "variable", prism: "function" },
  member: { textmate: "variable.other.member.oqx", monarch: "identifier.member", codemirror: "propertyName", legacy: "property", prism: "property" },
  identifier: { textmate: "variable.other.readwrite.oqx", monarch: "identifier", codemirror: "variableName", legacy: "variable", prism: null },
  operator: { textmate: "keyword.operator.oqx", monarch: "operator", codemirror: "operator", legacy: "operator", prism: "operator" },
  range: { textmate: "keyword.operator.range.oqx", monarch: "operator.range", codemirror: "operator", legacy: "operator", prism: "operator" },
  membership: { textmate: "keyword.operator.membership.oqx", monarch: "keyword.operator.membership", codemirror: "operatorKeyword", legacy: "keyword", prism: "keyword" },
  wordOperator: { textmate: "keyword.operator.word.oqx", monarch: "keyword.operator.word", codemirror: "operatorKeyword", legacy: "keyword", prism: "keyword" },
  braceOpen: { textmate: "punctuation.section.block.begin.oqx", monarch: "delimiter.curly", codemirror: "brace", legacy: "bracket", prism: "punctuation" },
  braceClose: { textmate: "punctuation.section.block.end.oqx", monarch: "delimiter.curly", codemirror: "brace", legacy: "bracket", prism: "punctuation" },
  bracketOpen: { textmate: "punctuation.section.brackets.begin.oqx", monarch: "delimiter.square", codemirror: "squareBracket", legacy: "bracket", prism: "punctuation" },
  bracketClose: { textmate: "punctuation.section.brackets.end.oqx", monarch: "delimiter.square", codemirror: "squareBracket", legacy: "bracket", prism: "punctuation" },
  parenOpen: { textmate: "punctuation.section.group.begin.oqx", monarch: "delimiter.parenthesis", codemirror: "paren", legacy: "bracket", prism: "punctuation" },
  parenClose: { textmate: "punctuation.section.group.end.oqx", monarch: "delimiter.parenthesis", codemirror: "paren", legacy: "bracket", prism: "punctuation" },
  comma: { textmate: "punctuation.separator.comma.oqx", monarch: "delimiter.comma", codemirror: "separator", legacy: "punctuation", prism: "punctuation" },
  colon: { textmate: "punctuation.separator.key-value.oqx", monarch: "delimiter.colon", codemirror: "punctuation", legacy: "punctuation", prism: "punctuation" },
  accessor: { textmate: "punctuation.accessor.oqx", monarch: "delimiter.accessor", codemirror: "derefOperator", legacy: "punctuation", prism: "punctuation" },
  illegal: { textmate: "invalid.illegal.oqx", monarch: "invalid", codemirror: "invalid", legacy: "error", prism: "invalid" },
} as const;

export type TokenClass = keyof typeof TOKEN_CLASSES;

/** Alternation of literal words for a regular expression, longest first so a
 * prefix never shadows a longer word (`...` before `..`, `startsWith` intact). */
export function alternation(words: readonly string[]): string {
  return [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRegExp).join("|");
}

/** Escape a literal for use inside a regular expression source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}
