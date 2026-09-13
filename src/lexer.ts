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
// which is exactly the desired "interpolation is a value, never source text".)

import { OqxError } from "./errors.ts";

export type TokType =
  | "ident"
  | "kw" // from | where | select
  | "string"
  | "number"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "comma"
  | "colon"
  | "caret" // ^ — one-scope lift marker
  | "dot"
  | "op" // == != <= >= < > && || ! + - * / %  (value carries the operator)
  | "binding" // a ${…} interpolation; `index` names the value slot
  | "eof";

export interface Token {
  type: TokType;
  value: string;
  pos: number;
  index?: number; // binding tokens only
}

const KEYWORDS = new Set(["from", "where", "select"]);

// Multi-char operators, longest first (the scanner tries these before singles).
const MULTI_OPS = ["==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_OPS = new Set(["<", ">", "!", "+", "-", "*", "/", "%"]);

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Lex a tagged-template call: the cooked string fragments and the count of
 * interpolated values. Emits a single flat token stream with `binding` tokens
 * (index 0..values-1) between fragments, terminated by `eof`. */
export function lexTemplate(fragments: readonly string[], values: number): Token[] {
  const tokens: Token[] = [];
  let base = 0; // running offset across fragments + rendered `${…}` markers
  for (let f = 0; f < fragments.length; f++) {
    lexFragment(fragments[f]!, base, tokens);
    base += fragments[f]!.length;
    if (f < fragments.length - 1) {
      // account for the value's rendered width in the display source (see rawSource)
      const marker = `\${${f}}`;
      tokens.push({ type: "binding", value: marker, pos: base, index: f });
      base += marker.length;
    }
  }
  if (values !== fragments.length - 1) {
    throw new OqxError(`template arity mismatch: ${fragments.length} fragments, ${values} values`, "lex");
  }
  tokens.push({ type: "eof", value: "", pos: base });
  return tokens;
}

/** Lex a plain string (no bindings) — used by the string entry point. */
export function lexString(src: string): Token[] {
  const tokens: Token[] = [];
  lexFragment(src, 0, tokens);
  tokens.push({ type: "eof", value: "", pos: src.length });
  return tokens;
}

function lexFragment(src: string, base: number, out: Token[]): void {
  let i = 0;
  const n = src.length;
  const push = (type: TokType, value: string, at: number): void => {
    out.push({ type, value, pos: base + at });
  };

  while (i < n) {
    const c = src[i]!;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

    if (c === "(") { push("lparen", c, i); i++; continue; }
    if (c === ")") { push("rparen", c, i); i++; continue; }
    if (c === "{") { push("lbrace", c, i); i++; continue; }
    if (c === "}") { push("rbrace", c, i); i++; continue; }
    if (c === ",") { push("comma", c, i); i++; continue; }
    if (c === ":") { push("colon", c, i); i++; continue; }
    if (c === "^") { push("caret", c, i); i++; continue; }

    // `.` is a dot only when not the leading part of a number (.5) — but OQX has
    // no leading-dot numerals, so a bare `.` is always navigation.
    if (c === "." && !isDigit(src[i + 1] ?? "")) { push("dot", c, i); i++; continue; }

    // string literal — decode into its VALUE (quotes stripped, escapes resolved).
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let sval = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          i++;
          sval += unescape(src[i]);
        } else {
          sval += src[i];
        }
        i++;
      }
      if (i >= n) throw new OqxError(`unterminated string literal at ${base + start}`, "lex");
      i++; // closing quote
      out.push({ type: "string", value: sval, pos: base + start });
      continue;
    }

    // number (integer or decimal, optional exponent)
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && isDigit(src[i]!)) i++;
      if (src[i] === ".") { i++; while (i < n && isDigit(src[i]!)) i++; }
      if (src[i] === "e" || src[i] === "E") {
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        while (i < n && isDigit(src[i]!)) i++;
      }
      push("number", src.slice(start, i), start);
      continue;
    }

    // operators (multi-char first)
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) { push("op", two, i); i += 2; continue; }
    if (SINGLE_OPS.has(c)) { push("op", c, i); i++; continue; }

    // identifier / keyword
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(src[i]!)) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.has(word) ? "kw" : "ident", word, start);
      continue;
    }

    throw new OqxError(`unexpected character ${JSON.stringify(c)} at ${base + i}`, "lex");
  }
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
