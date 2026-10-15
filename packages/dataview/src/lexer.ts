// The DQL lexer. Dataview's query language is small: keywords (case-insensitive,
// recognized by the parser from identifier tokens), identifiers (which may carry
// `-` after the first character — Dataview sanitizes "my field" to `my-field`,
// so `a-b` is one name and subtraction needs spaces, as in Dataview), numbers,
// double- or single-quoted strings, `#tags`, `[[links]]` (optionally `!`-embedded),
// the operators `= == != < <= > >= + - * / % & | ! =>` and the punctuation
// `( ) [ ] { } , . :`. The bare date/duration literals `date(2026-10-15)` /
// `dur(1 hour 30 minutes)` are NOT lexed specially: the parser re-reads the raw
// source between the parentheses (see parser.ts), which keeps the lexer modeless.

import { DqlError, positionAt } from "./errors.ts";

export type TokenKind =
  | "ident" | "number" | "string" | "tag" | "link" | "op" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  /** The token's text: the decoded value for strings, the bare tag for `#tag`,
   * the inner text for links (`note|display`), the operator/punctuation itself. */
  value: string;
  /** For links: whether the token began with `!`. */
  embed?: boolean;
  start: number;
  end: number;
}

const isIdentStart = (c: string): boolean => /^[\p{L}_]$/u.test(c);
const isIdentPart = (c: string): boolean => /^[\p{L}\p{N}_-]$/u.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isTagPart = (c: string): boolean => /^[\p{L}\p{N}_\-/]$/u.test(c);

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (message: string, at: number): never => { throw new DqlError("parse", message, positionAt(source, at)); };

  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const start = i;

    // Strings: "…" or '…' with `\` escapes (Dataview strings are double-quoted;
    // single quotes are accepted for leniency).
    if (c === '"' || c === "'") {
      let value = "";
      i++;
      let closed = false;
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === "\\" && i + 1 < source.length) { value += source[i + 1]!; i += 2; continue; }
        if (ch === c) { i++; closed = true; break; }
        value += ch;
        i++;
      }
      if (!closed) fail("unterminated string", start);
      tokens.push({ kind: "string", value, start, end: i });
      continue;
    }

    // Links: [[target]] / [[target|display]] / [[target#heading]]; `![[…]]` embeds.
    if ((c === "!" && source.startsWith("[[", i + 1)) || source.startsWith("[[", i)) {
      const embed = c === "!";
      const open = embed ? i + 1 : i;
      const close = source.indexOf("]]", open + 2);
      if (close < 0) fail("unterminated link", start);
      tokens.push({ kind: "link", value: source.slice(open + 2, close), embed, start, end: close + 2 });
      i = close + 2;
      continue;
    }

    // Tags: #tag, #tag/sub, #tag-name.
    if (c === "#" && i + 1 < source.length && isTagPart(source[i + 1]!)) {
      i++;
      while (i < source.length && isTagPart(source[i]!)) i++;
      tokens.push({ kind: "tag", value: source.slice(start + 1, i), start, end: i });
      continue;
    }

    // Numbers: 12, 1.5, .5
    if (isDigit(c) || (c === "." && i + 1 < source.length && isDigit(source[i + 1]!))) {
      while (i < source.length && isDigit(source[i]!)) i++;
      if (source[i] === "." && i + 1 < source.length && isDigit(source[i + 1]!)) {
        i++;
        while (i < source.length && isDigit(source[i]!)) i++;
      }
      tokens.push({ kind: "number", value: source.slice(start, i), start, end: i });
      continue;
    }

    if (isIdentStart(c)) {
      i++;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), start, end: i });
      continue;
    }

    // Operators (longest first).
    const two = source.slice(i, i + 2);
    if (two === "=>" || two === "==" || two === "!=" || two === "<=" || two === ">=") {
      tokens.push({ kind: "op", value: two === "==" ? "=" : two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if ("=<>+-*/%&|!".includes(c)) {
      tokens.push({ kind: "op", value: c, start, end: i + 1 });
      i++;
      continue;
    }
    if ("()[]{},.:".includes(c)) {
      tokens.push({ kind: "punct", value: c, start, end: i + 1 });
      i++;
      continue;
    }
    fail(`unexpected character '${c}'`, start);
  }
  tokens.push({ kind: "eof", value: "", start: source.length, end: source.length });
  return tokens;
}
