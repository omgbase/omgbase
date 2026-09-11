// OQX structural lexer (slice 1). Tokenizes query STRUCTURE only. Scalar
// predicate interiors are recovered by the parser via source-offset slicing
// (tokens carry `pos`), so operators/numbers/$-fields are lexed just enough to
// advance and to keep string contents from breaking structure. The scalar text
// is handed verbatim to the CEL layer (search/cel), never re-serialized here.

export type OqxTokenType =
  | "kw" // from | where | select
  | "ident"
  | "string"
  | "number"
  | "field" // $-intrinsic ($path, $updated_at, …) — only meaningful inside scalar runs
  | "lparen"
  | "rparen"
  | "comma"
  | "colon"
  | "caret" // ^ — one-scope lift marker on a select item
  | "and" // &&
  | "dot"
  | "op" // any other operator run: == != <= >= < > || ! + - * /
  | "eof";

export interface OqxToken {
  type: OqxTokenType;
  value: string;
  pos: number; // start offset in source
}

export class OqxLexError extends Error {}

const KEYWORDS = new Set(["from", "where", "select"]);
const OP_CHARS = new Set(["=", "!", "<", ">", "|", "+", "-", "*", "/"]);

export function lexOqx(src: string): OqxToken[] {
  const tokens: OqxToken[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

    if (c === "(") { tokens.push({ type: "lparen", value: c, pos: i }); i++; continue; }
    if (c === ")") { tokens.push({ type: "rparen", value: c, pos: i }); i++; continue; }
    if (c === ",") { tokens.push({ type: "comma", value: c, pos: i }); i++; continue; }
    if (c === ":") { tokens.push({ type: "colon", value: c, pos: i }); i++; continue; }
    if (c === ".") { tokens.push({ type: "dot", value: c, pos: i }); i++; continue; }
    if (c === "^") { tokens.push({ type: "caret", value: c, pos: i }); i++; continue; }

    if (c === "&" && src[i + 1] === "&") { tokens.push({ type: "and", value: "&&", pos: i }); i += 2; continue; }

    // string literal — capture whole span so structural chars inside don't leak.
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      if (i >= n) throw new OqxLexError(`unterminated string starting at ${start}`);
      i++; // closing quote
      tokens.push({ type: "string", value: src.slice(start, i), pos: start });
      continue;
    }

    // number
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < n && ((src[i]! >= "0" && src[i]! <= "9") || src[i] === ".")) i++;
      tokens.push({ type: "number", value: src.slice(start, i), pos: start });
      continue;
    }

    // $-intrinsic field
    if (c === "$") {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      tokens.push({ type: "field", value: src.slice(start, i), pos: start });
      continue;
    }

    // operator run (== != <= >= < > || ! …)
    if (OP_CHARS.has(c)) {
      const start = i;
      while (i < n && OP_CHARS.has(src[i]!)) i++;
      tokens.push({ type: "op", value: src.slice(start, i), pos: start });
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      const word = src.slice(start, i);
      tokens.push({ type: KEYWORDS.has(word) ? "kw" : "ident", value: word, pos: start });
      continue;
    }

    throw new OqxLexError(`unexpected character '${c}' at ${i}`);
  }

  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}
