// OQX structural lexer for the generic kernel.
//
// Unlike the reference lexer (which slices raw source for the CEL layer), this
// one fully tokenizes: the parser builds an evaluable expression AST directly
// from the token stream, so there is no source-slicing seam.
//
// Tagged-template bindings are lexed as first-class tokens. Each template string
// FRAGMENT is lexed independently and a synthetic `binding` token is injected
// between adjacent fragments. A binding therefore can never span a token or
// alter the grammar — the prepared-statement / injection-safe property the
// host-bindings design note calls for. (A consequence: `${x}` inside a string
// literal does not interpolate — that fragment would be an unterminated string —
// which is exactly the desired "interpolation is a value, never source text".
// The same holds for a backtick template literal (0.21): a fragment that ends
// inside one is an unterminated literal, so a bound value never stands in one.)
//
// Template literals `` `text ${expr}` `` are lexed with a mode stack: the text
// between the backticks is one `tmpl_text` token per run (decoded), a `${`
// opens an interpolation whose tokens are ordinary source until the `}` that
// balances it, and an interpolation may hold another template literal.
//
// Positions (`Token.pos` / `Token.end`, the `span` of every AST node, and the
// offsets quoted in error messages) count Unicode CODE POINTS over the raw
// source (`rawSource` for a template, where a binding occupies its `${n}`
// marker) — not UTF-16 code units — so the two implementations agree on every
// offset (spec/oqx/AST.md §3). `toUtf16` converts a span for a UTF-16 editor.

import { OqxError } from "./errors.ts";
import type { Span } from "./ast.ts";

export type TokType =
  | "ident"
  | "kw" // from | where | select | is | not | and | or
  | "string"
  | "number"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "lbracket" // [ — a bracket lookup (since 0.17)
  | "rbracket"
  | "comma"
  | "colon"
  | "caret" // ^ — one-scope lift marker
  | "dot"
  | "range" // `..` (inclusive) or `...` (exclusive end) — a Ruby-style range operator (value carries which)
  | "op" // == != <= >= < > && || ! + - * / % ~ ~* !~ !~*  (value carries the operator)
  | "binding" // a ${…} interpolation; `index` names the value slot
  // A template literal (since 0.21): the opening and closing backticks, a run of
  // its decoded text, and the `${` / `}` around an interpolation — whose `}` is a
  // token of its own, so a block's `}` inside the interpolation stays `rbrace`.
  | "tmpl_start"
  | "tmpl_text"
  | "tmpl_interp_start"
  | "tmpl_interp_end"
  | "tmpl_end"
  | "eof";

export interface Token {
  type: TokType;
  /** The source text of the token, except: a `string` token carries its decoded
   * value (quotes stripped, escapes resolved), and so does a `tmpl_text` run; a
   * `binding` carries the display marker `${N}`; `eof` carries `""`. */
  value: string;
  /** Code-point offset of the token's first character. */
  pos: number;
  /** Code-point offset just past the token's last character (`[pos, end)`). */
  end: number;
  index?: number; // binding tokens only
}

const KEYWORDS = new Set(["from", "where", "select", "is", "not", "and", "or"]);

// Multi-char operators, longest first (the scanner tries these before singles).
// The regex operators (since 0.22) are among them: `!~*` is tried before `!~`,
// which is tried before `!` — so `name!~"B"` is `name !~ "B"`, not a required
// `name!` — and `~*` before `~`, so `x~*y` is `x ~* y`.
const TRIPLE_OPS = ["!~*"];
const MULTI_OPS = ["==", "!=", "<=", ">=", "&&", "||", "!~", "~*"];
const SINGLE_OPS = new Set(["<", ">", "!", "+", "-", "*", "/", "%", "~"]);

const isIdentStart = (c: string): boolean => /^[A-Za-z_$]$/.test(c);
const isIdentPart = (c: string): boolean => /^[A-Za-z0-9_$]$/.test(c);
const isDigit = (c: string): boolean => c.length === 1 && c >= "0" && c <= "9";

/** The length of a string in Unicode code points. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Lex a tagged-template call: the cooked string fragments and the count of
 * interpolated values. Emits a single flat token stream with `binding` tokens
 * (index 0..values-1) between fragments, terminated by `eof`. */
export function lexTemplate(fragments: readonly string[], values: number): Token[] {
  const tokens: Token[] = [];
  let base = 0; // running offset across fragments + rendered `${…}` markers
  for (let f = 0; f < fragments.length; f++) {
    try {
      lexFragment(fragments[f]!, base, tokens);
    } catch (err) {
      // A fragment ends inside a backtick literal: the bound value would have
      // to stand inside it, and a bound value is never source text (GRAMMAR §1).
      if (err instanceof OqxError && f < fragments.length - 1 && err.message.startsWith("unterminated template literal")) {
        throw new OqxError(`${err.message} — a template literal must be complete within one fragment: a \${…} binding cannot stand inside a backtick literal (interpolate a name, or bind the whole string)`, "lex");
      }
      throw err;
    }
    base += codePointLength(fragments[f]!);
    if (f < fragments.length - 1) {
      // account for the value's rendered width in the display source (see rawSource)
      const marker = `\${${f}}`;
      tokens.push({ type: "binding", value: marker, pos: base, end: base + marker.length, index: f });
      base += marker.length;
    }
  }
  if (values !== fragments.length - 1) {
    throw new OqxError(`template arity mismatch: ${fragments.length} fragments, ${values} values`, "lex");
  }
  tokens.push({ type: "eof", value: "", pos: base, end: base });
  return tokens;
}

/** Lex a plain string (no bindings) — used by the string entry point. */
export function lexString(src: string): Token[] {
  const tokens: Token[] = [];
  lexFragment(src, 0, tokens);
  const n = codePointLength(src);
  tokens.push({ type: "eof", value: "", pos: n, end: n });
  return tokens;
}

// The lexer's mode inside a template literal (GRAMMAR §1, since 0.21): the text of
// the literal, or a `${…}` interpolation, which is ordinary source again — with a
// brace depth, so the `}` that closes the interpolation is told from a block's.
// Nesting is a stack: an interpolation may hold another template literal.
type Mode =
  | { kind: "template"; start: number }
  | { kind: "interp"; start: number; depth: number };

function lexFragment(src: string, base: number, out: Token[]): void {
  // One entry per code point, so every index below is a code-point offset.
  const cps = Array.from(src);
  let i = 0;
  const n = cps.length;
  const at = (j: number): string => cps[j] ?? "";
  const text = (from: number, to: number): string => cps.slice(from, to).join("");
  const push = (type: TokType, value: string, start: number, end: number): void => {
    out.push({ type, value, pos: base + start, end: base + end });
  };
  const modes: Mode[] = [];

  while (i < n) {
    const mode = modes[modes.length - 1];

    // Template text: everything up to the closing backtick or the `${` of an
    // interpolation, decoded with the string escapes (`\<c>` is `<c>`, so `` \` ``
    // and `\$` keep a backtick or a dollar literal). Newlines are kept verbatim.
    if (mode?.kind === "template") {
      const start = i;
      let sval = "";
      while (i < n) {
        const c = cps[i]!;
        if (c === "`" || (c === "$" && at(i + 1) === "{")) break;
        if (c === "\\") { i++; sval += unescape(cps[i]); i++; continue; }
        sval += c;
        i++;
      }
      if (i > start) push("tmpl_text", sval, start, Math.min(i, n));
      if (i >= n) break; // unterminated — reported below
      if (cps[i] === "`") { push("tmpl_end", "`", i, i + 1); i++; modes.pop(); continue; }
      push("tmpl_interp_start", "${", i, i + 2);
      modes.push({ kind: "interp", start: i, depth: 0 });
      i += 2;
      continue;
    }

    const c = cps[i]!;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

    if (c === "`") { push("tmpl_start", c, i, i + 1); modes.push({ kind: "template", start: i }); i++; continue; }
    if (c === "(") { push("lparen", c, i, i + 1); i++; continue; }
    if (c === ")") { push("rparen", c, i, i + 1); i++; continue; }
    if (c === "{") { if (mode) mode.depth++; push("lbrace", c, i, i + 1); i++; continue; }
    if (c === "}") {
      // Inside an interpolation a `}` at depth 0 closes it; deeper, it closes a block.
      if (mode && mode.depth === 0) { push("tmpl_interp_end", c, i, i + 1); i++; modes.pop(); continue; }
      if (mode) mode.depth--;
      push("rbrace", c, i, i + 1); i++; continue;
    }
    if (c === "[") { push("lbracket", c, i, i + 1); i++; continue; }
    if (c === "]") { push("rbracket", c, i, i + 1); i++; continue; }
    if (c === ",") { push("comma", c, i, i + 1); i++; continue; }
    if (c === ":") { push("colon", c, i, i + 1); i++; continue; }
    if (c === "^") { push("caret", c, i, i + 1); i++; continue; }

    // range operator — `...` (exclusive end) or `..` (inclusive), longest first.
    // Scanned before the dot rule so `a..b` never looks like member navigation,
    // and before the number rule so the bounds lex as separate numbers.
    if (c === "." && at(i + 1) === ".") {
      if (at(i + 2) === ".") { push("range", "...", i, i + 3); i += 3; continue; }
      push("range", "..", i, i + 2); i += 2; continue;
    }

    // `.` followed by a digit is neither navigation (a property name cannot start
    // with a digit) nor a number (OQX has no leading-dot numerals): it is a
    // malformed number, reported as such rather than surfacing as a confusing
    // parse error downstream. Any other `.` is member navigation.
    if (c === ".") {
      if (isDigit(at(i + 1))) {
        const end = scanNumberTail(cps, i + 1, base);
        const lit = text(i, end);
        throw new OqxError(`malformed number ${JSON.stringify(lit)} at ${base + i} — a number starts with a digit (write 0${lit}), and a property name cannot be a digit (there is no index access)`, "lex");
      }
      push("dot", c, i, i + 1); i++; continue;
    }

    // string literal — decode into its VALUE (quotes stripped, escapes resolved).
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let sval = "";
      while (i < n && cps[i] !== quote) {
        if (cps[i] === "\\") {
          i++;
          sval += unescape(cps[i]);
        } else {
          sval += cps[i]!;
        }
        i++;
      }
      if (i >= n) throw new OqxError(`unterminated string literal at ${base + start}`, "lex");
      i++; // closing quote
      push("string", sval, start, i);
      continue;
    }

    // number: `digits [ "." digits ] [ ("e"|"E") ["+"|"-"] digits ]`. A `.` is a
    // decimal point only when a digit follows: `1..5` is `1` `..` `5`. A `.`
    // followed by anything else (`1.`, `1.x`) and an exponent marker without
    // digits (`1e`, `1e+`) are malformed numbers — lex errors, never a silent
    // NaN or a dangling dot.
    if (isDigit(c)) {
      const start = i;
      i = scanNumberTail(cps, i, base);
      push("number", text(start, i), start, i);
      continue;
    }

    // operators (multi-char first, longest first)
    const three = c + at(i + 1) + at(i + 2);
    if (TRIPLE_OPS.includes(three)) { push("op", three, i, i + 3); i += 3; continue; }
    const two = c + at(i + 1);
    if (MULTI_OPS.includes(two)) { push("op", two, i, i + 2); i += 2; continue; }
    if (SINGLE_OPS.has(c)) { push("op", c, i, i + 1); i++; continue; }

    // identifier / keyword
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(cps[i]!)) i++;
      const word = text(start, i);
      push(KEYWORDS.has(word) ? "kw" : "ident", word, start, i);
      continue;
    }

    throw new OqxError(`unexpected character ${JSON.stringify(c)} at ${base + i}`, "lex");
  }

  // The end of the source inside a template literal.
  const open = modes[modes.length - 1];
  if (open?.kind === "template") throw new OqxError(`unterminated template literal at ${base + open.start}`, "lex");
  if (open?.kind === "interp") {
    throw new OqxError(`unterminated \${…} interpolation in a template literal at ${base + open.start} — expected '}'`, "lex");
  }
}

// Scan a number whose first digit is at `i`; return the index just past it.
// Throws the malformed-number lex error for a trailing decimal point or an
// exponent without digits.
function scanNumberTail(cps: readonly string[], i: number, base = 0): number {
  const start = i;
  const n = cps.length;
  const at = (j: number): string => cps[j] ?? "";
  const fail = (end: number, why: string): never => {
    throw new OqxError(`malformed number ${JSON.stringify(cps.slice(start, end).join(""))} at ${base + start} — ${why}`, "lex");
  };
  while (i < n && isDigit(cps[i]!)) i++;
  if (at(i) === "." && at(i + 1) !== ".") {
    if (!isDigit(at(i + 1))) fail(i + 1, "a decimal point needs a digit after it (write 1.0, not 1.)");
    i++;
    while (i < n && isDigit(cps[i]!)) i++;
  }
  if (at(i) === "e" || at(i) === "E") {
    let j = i + 1;
    if (at(j) === "+" || at(j) === "-") j++;
    if (!isDigit(at(j))) fail(j, "an exponent needs at least one digit (write 1e5)");
    i = j;
    while (i < n && isDigit(cps[i]!)) i++;
  }
  return i;
}

function unescape(c: string | undefined): string {
  switch (c) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "0": return "\0";
    case undefined: return "";
    default: return c; // \\, \", \', \/, and anything else → the literal char
  }
}

/** A human-readable reconstruction of the query source, with `${N}` markers where
 * bindings were, for error messages. */
export function rawSource(fragments: readonly string[]): string {
  return fragments.map((s, i) => (i < fragments.length - 1 ? `${s}\${${i}}` : s)).join("");
}

/** Convert a code-point span (as every AST node carries) to UTF-16 code-unit
 * offsets over `source` — the units a JavaScript string, a DOM range or an
 * editor API counts in. `source` is the raw source the span was measured over
 * (for a template, `rawSource(strings)`). Offsets past the end clamp. */
export function toUtf16(span: Span, source: string): Span {
  const [start, end] = span;
  let cp = 0;
  let unit = 0;
  let startUnit = -1;
  let endUnit = -1;
  for (const ch of source) {
    if (cp === start) startUnit = unit;
    if (cp === end) endUnit = unit;
    cp++;
    unit += ch.length;
  }
  if (startUnit < 0) startUnit = unit;
  if (endUnit < 0) endUnit = unit;
  return [startUnit, endUnit];
}
