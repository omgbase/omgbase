// Lexer for the CEL subset (query-language §3.1). Produces a flat token
// stream for the recursive-descent parser.

export type TokenType =
  | "ident"
  | "field" // $-prefixed intrinsic, tokenized whole incl. dots
  | "outer" // ^name — a one-scope-outward binding reference (OQX correlation)
  | "string"
  | "int"
  | "double"
  | "bool"
  | "null"
  | "op" // && || ! == != < <= > >=
  | "lparen"
  | "rparen"
  | "comma"
  | "dot"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export class LexError extends Error {}

const OPS_2 = new Set(["&&", "||", "==", "!=", "<=", ">="]);
// Arithmetic operators are lexed so the parser can reject them with a precise
// "arithmetic is not supported" message (10 §3.1) rather than a lex error.
const OPS_1 = new Set(["!", "<", ">", "+", "-", "*", "/"]);

export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const push = (type: TokenType, value: string, pos: number): void => {
    tokens.push({ type, value, pos });
  };

  while (i < n) {
    const c = src[i]!;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    if (c === "(") { push("lparen", c, i); i++; continue; }
    if (c === ")") { push("rparen", c, i); i++; continue; }
    if (c === ",") { push("comma", c, i); i++; continue; }
    if (c === ".") { push("dot", c, i); i++; continue; }

    // two-char operators
    const two = src.slice(i, i + 2);
    if (OPS_2.has(two)) { push("op", two, i); i += 2; continue; }
    if (OPS_1.has(c)) { push("op", c, i); i++; continue; }

    // strings
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let value = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          i++;
          const esc = src[i];
          if (esc === undefined) throw new LexError(`unterminated escape at ${i}`);
          value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          i++;
        } else {
          value += src[i];
          i++;
        }
      }
      if (i >= n) throw new LexError(`unterminated string starting at ${start}`);
      i++; // closing quote
      push("string", value, start);
      continue;
    }

    // numbers
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < n && src[i]! >= "0" && src[i]! <= "9") i++;
      let isDouble = false;
      if (src[i] === ".") {
        isDouble = true;
        i++;
        while (i < n && src[i]! >= "0" && src[i]! <= "9") i++;
      }
      push(isDouble ? "double" : "int", src.slice(start, i), start);
      continue;
    }

    // ^name — a one-scope-outward binding reference (the symmetric read form of
    // the `^name:` lift). OQX resolves the name against the enclosing query
    // scope's bindings; a bare `^` with no name is a lex error.
    if (c === "^") {
      const start = i;
      i++;
      const nameStart = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      if (i === nameStart) throw new LexError(`expected a binding name after '^' at ${start}`);
      push("outer", src.slice(nameStart, i), start);
      continue;
    }

    // $-intrinsic: $ident(.ident)*
    if (c === "$") {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      // allow dotted continuation only when followed by ident (handled by parser via dot tokens);
      // here we capture just the leading $ident. Dots handled as separate tokens.
      push("field", src.slice(start, i), start);
      continue;
    }

    // identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      const word = src.slice(start, i);
      if (word === "true" || word === "false") push("bool", word, start);
      else if (word === "null") push("null", word, start);
      else push("ident", word, start);
      continue;
    }

    throw new LexError(`unexpected character '${c}' at ${i}`);
  }

  push("eof", "", n);
  return tokens;
}
