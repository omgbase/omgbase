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
export const LANGUAGE_VERSION = "0.23";

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

/** The clauses of a `follow` destination block (GRAMMAR §3, `follow`, since
 * 0.20): `frontier <expr>` and `depth <n>`, after the block's `where`. `depth`
 * is a destination block's alone; `frontier` is also a clause of any body that
 * has a `follow` (its seeds' frontier) — lexically the same word in the same
 * position, so one rule covers both. (The pre-0.20 options block —
 * `where`/`frontier`/`depth`/`by` after the destinations — is gone; `by` is no
 * longer a word of the language.) */
export const DESTINATION_CLAUSES = ["frontier", "depth"] as const;

/** Modifiers: `distinct` (select/follow/consumer), `asc`/`desc` (order by), `values` (projection). */
export const MODIFIERS = ["distinct", "asc", "desc", "values"] as const;

/** Literal words — literals in every position (GRAMMAR §1). */
export const LITERALS = ["true", "false", "null"] as const;

/** Operators, longest first (GRAMMAR §1; the lexer's MULTI_OPS then SINGLE_OPS). */
export const OPERATORS = {
  comparison: ["==", "!=", "<=", ">=", "<", ">"],
  /** The infix regex operators (GRAMMAR §4, since 0.22): sugar over `matches`
   * at comparison precedence. Longest first — `!~*` before `!~` before `!`, so
   * `name!~"B"` is `name !~ "B"` and not a required `name!`; `~*` before `~`. */
  regex: ["!~*", "!~", "~*", "~"],
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

/** The template literal (GRAMMAR §1, §4, since 0.21): a backtick-delimited string
 * whose `${ … }` interpolations hold ordinary source — braces balanced, so an
 * interpolation may hold a `{ … }` block or another template literal — and whose
 * text decodes with the string escapes. The grammars highlight the delimiters and
 * the text as `template`, the `${` and `}` as `interpolation`. */
export const TEMPLATE = { quote: "`", interpolationOpen: "${", interpolationClose: "}" } as const;

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
 * and no single `=`/`&`/`|`. (The backtick left this list in 0.21: it opens a
 * template literal; `~` left it in 0.22: it is the regex match operator.) */
export const ILLEGAL_CHARACTERS = ["=", "&", "|", "@", ";", "#", "?", "\\"] as const;

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
 * …) as host functions; the attributes, handles and relations are listed for
 * consumers such as completion providers and highlight as plain identifiers
 * (the `$`-identifier rule covers OQX's own intrinsics only).
 */
export const OMGBASE = {
  /** The named roots of the repository (the root row: `^docs` from a row, bare `docs` at the top). */
  roots: ["docs", "blocks", "nodes", "links", "revisions"],
  /** Row functions written as free calls, evaluated against the current row. */
  rowFunctions: [
    "text", "semantic",
    "under", "under_heading", "within", "under_kind", "yaml_path", "json_pointer",
    "has_edge", "has_anchor", "child_count", "parent_type",
  ],
  /**
   * The engine attributes by target — bare snake_case names that win on
   * collision with an authored key (spec/surface §1.2, 3.0: `$` belongs to
   * OQX — `$it`, `$key`, `$depth`, … — and omgbase adds no `$` names; an
   * authored key with an attribute's name is reached through a source handle,
   * `data.<k>` / `frontmatter.<k>` / `inline.<k>`). They highlight as plain
   * identifiers; the list exists for completion providers.
   */
  attributes: {
    docs: ["id", "path", "raw", "hash", "updated_at", "title", "tags", "format"],
    blocks: ["id", "path", "doc_id", "raw", "hash", "updated_at", "type", "text", "attrs", "depth", "ordinal"],
    nodes: ["id", "path", "doc_id", "block_id", "kind", "name", "value", "attrs"],
    links: ["id", "path", "doc_id", "block_id", "via_id", "dst_id", "dst_path", "uri", "field", "dst_kind", "predicate", "provenance", "anchor"],
  },
  /** The source handles of a document (`data.<k>` the merged authored view, `frontmatter.<k>` / `inline.<k>` one source; `entries(x)` over any). */
  handles: ["data", "frontmatter", "inline"],
  /** Relations and reach-throughs of a row (`follow children`, `nodes exists { … }`,
   * a link's `dst` — its destination document — and `doc`, its source). */
  relations: [
    "nodes", "blocks", "out_links", "in_links",
    "children", "section", "subsections", "doc", "block", "dst",
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
  /** A template literal's backticks and text (0.21); its escapes are `stringEscape`. */
  template: { textmate: "string.template.oqx", monarch: "string.template", codemirror: "special(string)", legacy: "string-2", prism: "string" },
  /** The `${` and `}` around an interpolation (0.21); the source between them is ordinary OQX. */
  interpolation: { textmate: "punctuation.section.interpolation.oqx", monarch: "delimiter.interpolation", codemirror: "special(brace)", legacy: "bracket", prism: "punctuation" },
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
