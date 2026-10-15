// The DQL parser: tokens → `DqlQuery` (ast.ts). Grammar, from the Dataview docs
// ("Queries": Query Types, Data Commands; "Sources"; "Expressions"):
//
//   query    := type [WITHOUT ID] [fields] [FROM source] command*
//   type     := TABLE | LIST | TASK | CALENDAR
//   fields   := field { "," field }            (TABLE: any number; LIST/CALENDAR: one)
//   field    := expr [AS (string | ident)]
//   command  := WHERE expr | SORT key { "," key } | LIMIT expr
//             | GROUP BY expr [AS name] | FLATTEN expr [AS name]
//   key      := expr [ASC | ASCENDING | DESC | DESCENDING]
//   source   := or ; or := and { (OR | "|") and } ; and := unary { (AND | "&") unary }
//   unary    := ("-" | "!") unary | "(" source ")" | string | tag | link
//             | outgoing "(" link ")" | csv "(" string ")"
//   expr     := or-expr with Dataview's precedence: `|` < `&` < comparison
//               < `+ -` < `* / %` < unary `! -` < postfix `. [] ()`
//
// Keywords are case-insensitive. A command keyword ends the expression before
// it, so `TABLE due FROM "x" WHERE …` needs no delimiter — which also means a
// field literally named `where` or `from` is unreachable, as in Dataview.

import type { Command, DqlQuery, Expr, Field, QueryType, SortKey, Source } from "./ast.ts";
import { dateLiteralText, durationLiteralText, isDateLiteral, isDurationLiteral } from "./dates.ts";
import { DqlError, positionAt } from "./errors.ts";
import { lex, type Token } from "./lexer.ts";

const QUERY_TYPES: ReadonlySet<string> = new Set(["TABLE", "LIST", "TASK", "CALENDAR"]);
const COMMANDS: ReadonlySet<string> = new Set(["FROM", "WHERE", "SORT", "LIMIT", "GROUP", "FLATTEN"]);

export function parseDql(source: string): DqlQuery {
  return new Parser(source).query();
}

class Parser {
  private readonly source: string;
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = lex(source);
  }

  // ---- token helpers --------------------------------------------------------

  private peek(offset = 0): Token { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!; }
  private next(): Token { const t = this.peek(); if (t.kind !== "eof") this.pos++; return t; }
  private fail(message: string, at: number = this.peek().start): never {
    throw new DqlError("parse", message, positionAt(this.source, at));
  }

  /** Whether the current token is the keyword `word` (case-insensitive identifier). */
  private isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "ident" && t.value.toUpperCase() === word;
  }
  private isCommandKeyword(): boolean {
    const t = this.peek();
    if (t.kind !== "ident") return false;
    const w = t.value.toUpperCase();
    if (!COMMANDS.has(w)) return false;
    // `GROUP` is a command only as `GROUP BY`.
    return w !== "GROUP" || this.isKeyword("BY", 1);
  }
  private isPunct(value: string, offset = 0): boolean { const t = this.peek(offset); return t.kind === "punct" && t.value === value; }
  private isOp(value: string, offset = 0): boolean { const t = this.peek(offset); return t.kind === "op" && t.value === value; }
  private expectPunct(value: string, what: string): Token {
    if (!this.isPunct(value)) this.fail(`expected '${value}' ${what}`);
    return this.next();
  }
  private expectKeyword(word: string): Token {
    if (!this.isKeyword(word)) this.fail(`expected ${word}`);
    return this.next();
  }

  // ---- query ------------------------------------------------------------------

  query(): DqlQuery {
    const head = this.peek();
    if (head.kind !== "ident" || !QUERY_TYPES.has(head.value.toUpperCase())) {
      this.fail("a query starts with TABLE, LIST, TASK or CALENDAR");
    }
    this.next();
    const type = head.value.toUpperCase() as QueryType;
    let withoutId = false;
    if (this.isKeyword("WITHOUT")) {
      if (type !== "TABLE" && type !== "LIST") this.fail(`WITHOUT ID applies to TABLE and LIST, not ${type}`);
      this.next();
      this.expectKeyword("ID");
      withoutId = true;
    }
    const fields: Field[] = [];
    if (type !== "TASK" && !this.isCommandKeyword() && this.peek().kind !== "eof") {
      fields.push(this.field());
      while (this.isPunct(",")) { this.next(); fields.push(this.field()); }
    }
    if (type === "LIST" && fields.length > 1) this.fail("LIST takes at most one expression", fields[1]!.start);
    if (type === "CALENDAR" && fields.length !== 1) this.fail("CALENDAR needs exactly one date field", head.start);
    let from: Source | null = null;
    if (this.isKeyword("FROM")) { this.next(); from = this.source_(); }
    const commands: Command[] = [];
    while (this.peek().kind !== "eof") {
      if (this.isKeyword("FROM")) this.fail("FROM must come right after the query type and its fields");
      if (!this.isCommandKeyword()) this.fail(`unexpected '${this.peek().value}' — expected WHERE, SORT, LIMIT, GROUP BY or FLATTEN`);
      commands.push(this.command());
    }
    return { type, withoutId, fields, from, commands, start: 0, end: this.source.length };
  }

  private field(): Field {
    const expr = this.expr();
    let alias: string | null = null;
    let end = expr.end;
    if (this.isKeyword("AS")) {
      this.next();
      const t = this.next();
      if (t.kind !== "string" && t.kind !== "ident") this.fail("expected a name after AS", t.start);
      alias = t.value;
      end = t.end;
    }
    return { expr, alias, text: this.source.slice(expr.start, expr.end), start: expr.start, end };
  }

  private command(): Command {
    const kw = this.next();
    const word = kw.value.toUpperCase();
    switch (word) {
      case "WHERE": { const expr = this.expr(); return { kind: "where", expr, start: kw.start, end: expr.end }; }
      case "LIMIT": { const count = this.expr(); return { kind: "limit", count, start: kw.start, end: count.end }; }
      case "SORT": {
        const keys: SortKey[] = [this.sortKey()];
        while (this.isPunct(",")) { this.next(); keys.push(this.sortKey()); }
        return { kind: "sort", keys, start: kw.start, end: keys[keys.length - 1]!.end };
      }
      case "GROUP": {
        this.expectKeyword("BY");
        const expr = this.expr();
        const alias = this.optionalAlias();
        return { kind: "group", expr, alias: alias?.name ?? null, start: kw.start, end: alias?.end ?? expr.end };
      }
      case "FLATTEN": {
        const expr = this.expr();
        const alias = this.optionalAlias();
        return { kind: "flatten", expr, alias: alias?.name ?? null, start: kw.start, end: alias?.end ?? expr.end };
      }
      default: return this.fail(`unknown command ${kw.value}`, kw.start);
    }
  }

  private optionalAlias(): { name: string; end: number } | null {
    if (!this.isKeyword("AS")) return null;
    this.next();
    const t = this.next();
    if (t.kind !== "string" && t.kind !== "ident") this.fail("expected a name after AS", t.start);
    return { name: t.value, end: t.end };
  }

  private sortKey(): SortKey {
    const expr = this.expr();
    let desc = false;
    let end = expr.end;
    if (this.isKeyword("DESC") || this.isKeyword("DESCENDING")) { desc = true; end = this.next().end; }
    else if (this.isKeyword("ASC") || this.isKeyword("ASCENDING")) { end = this.next().end; }
    return { expr, desc, start: expr.start, end };
  }

  // ---- sources ----------------------------------------------------------------

  private source_(): Source {
    let left = this.sourceAnd();
    while (this.isKeyword("OR") || this.isOp("|")) {
      this.next();
      const right = this.sourceAnd();
      left = { kind: "or", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private sourceAnd(): Source {
    let left = this.sourceUnary();
    while (this.isKeyword("AND") || this.isOp("&")) {
      this.next();
      const right = this.sourceUnary();
      left = { kind: "and", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private sourceUnary(): Source {
    const t = this.peek();
    if (this.isOp("-") || this.isOp("!")) {
      this.next();
      const source = this.sourceUnary();
      return { kind: "not", source, start: t.start, end: source.end };
    }
    if (this.isPunct("(")) {
      this.next();
      const inner = this.source_();
      const close = this.expectPunct(")", "to close the source group");
      return { ...inner, start: t.start, end: close.end };
    }
    switch (t.kind) {
      case "string": this.next(); return { kind: "folder", path: t.value, start: t.start, end: t.end };
      case "tag": this.next(); return { kind: "tag", tag: t.value, start: t.start, end: t.end };
      case "link": this.next(); return { kind: "link", target: linkTarget(t.value), start: t.start, end: t.end };
      case "ident": {
        const w = t.value.toLowerCase();
        if (w === "outgoing" && this.isPunct("(", 1)) {
          this.next(); this.next();
          const link = this.next();
          if (link.kind !== "link") this.fail("outgoing() takes a [[link]]", link.start);
          const close = this.expectPunct(")", "to close outgoing()");
          return { kind: "outgoing", target: linkTarget(link.value), start: t.start, end: close.end };
        }
        if (w === "csv" && this.isPunct("(", 1)) {
          this.next(); this.next();
          const path = this.next();
          if (path.kind !== "string") this.fail("csv() takes a quoted path", path.start);
          const close = this.expectPunct(")", "to close csv()");
          return { kind: "csv", path: path.value, start: t.start, end: close.end };
        }
        return this.fail(`a source is a "folder", a #tag, a [[link]], outgoing([[link]]) or csv("file") — not '${t.value}'`, t.start);
      }
      default: return this.fail("expected a source after FROM", t.start);
    }
  }

  // ---- expressions ------------------------------------------------------------

  expr(): Expr { return this.orExpr(); }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.isOp("|") || this.isKeyword("OR")) {
      this.next();
      const right = this.andExpr();
      left = { kind: "binary", op: "|", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private andExpr(): Expr {
    let left = this.cmpExpr();
    while (this.isOp("&") || this.isKeyword("AND")) {
      this.next();
      const right = this.cmpExpr();
      left = { kind: "binary", op: "&", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private cmpExpr(): Expr {
    let left = this.addExpr();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "=" || t.value === "!=" || t.value === "<" || t.value === "<=" || t.value === ">" || t.value === ">=")) {
        this.next();
        const right = this.addExpr();
        left = { kind: "binary", op: t.value, left, right, start: left.start, end: right.end };
      } else return left;
    }
  }

  private addExpr(): Expr {
    let left = this.mulExpr();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const right = this.mulExpr();
        left = { kind: "binary", op: t.value, left, right, start: left.start, end: right.end };
      } else return left;
    }
  }

  private mulExpr(): Expr {
    let left = this.unaryExpr();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.next();
        const right = this.unaryExpr();
        left = { kind: "binary", op: t.value, left, right, start: left.start, end: right.end };
      } else return left;
    }
  }

  private unaryExpr(): Expr {
    const t = this.peek();
    if (this.isOp("!")) { this.next(); const expr = this.unaryExpr(); return { kind: "not", expr, start: t.start, end: expr.end }; }
    if (this.isOp("-")) { this.next(); const expr = this.unaryExpr(); return { kind: "neg", expr, start: t.start, end: expr.end }; }
    return this.postfixExpr();
  }

  private postfixExpr(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isPunct(".")) {
        this.next();
        const name = this.next();
        if (name.kind !== "ident") this.fail("expected a property name after '.'", name.start);
        e = { kind: "member", object: e, name: name.value, start: e.start, end: name.end };
      } else if (this.isPunct("[")) {
        this.next();
        const index = this.expr();
        const close = this.expectPunct("]", "to close the index");
        e = { kind: "index", object: e, index, start: e.start, end: close.end };
      } else return e;
    }
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case "string": this.next(); return { kind: "string", value: t.value, start: t.start, end: t.end };
      case "number": this.next(); return { kind: "number", value: Number(t.value), start: t.start, end: t.end };
      case "link": {
        this.next();
        const bar = t.value.indexOf("|");
        const target = linkTarget(t.value);
        return { kind: "link", target, display: bar >= 0 ? t.value.slice(bar + 1) : null, embed: t.embed === true, start: t.start, end: t.end };
      }
      case "tag": return this.fail(`a #tag is a FROM source; in an expression write contains(file.tags, "#${t.value}")`, t.start);
      case "punct": {
        if (t.value === "(") {
          const lambda = this.tryLambda();
          if (lambda) return lambda;
          this.next();
          const expr = this.expr();
          const close = this.expectPunct(")", "to close the group");
          return { kind: "paren", expr, start: t.start, end: close.end };
        }
        if (t.value === "[") {
          this.next();
          const items: Expr[] = [];
          if (!this.isPunct("]")) {
            items.push(this.expr());
            while (this.isPunct(",")) { this.next(); items.push(this.expr()); }
          }
          const close = this.expectPunct("]", "to close the list");
          return { kind: "list", items, start: t.start, end: close.end };
        }
        if (t.value === "{") {
          this.next();
          const entries: { key: string; value: Expr }[] = [];
          if (!this.isPunct("}")) {
            for (;;) {
              const k = this.next();
              if (k.kind !== "ident" && k.kind !== "string") this.fail("expected an object key", k.start);
              this.expectPunct(":", "after the object key");
              entries.push({ key: k.value, value: this.expr() });
              if (this.isPunct(",")) { this.next(); continue; }
              break;
            }
          }
          const close = this.expectPunct("}", "to close the object");
          return { kind: "object", entries, start: t.start, end: close.end };
        }
        return this.fail(`unexpected '${t.value}'`, t.start);
      }
      case "ident": {
        if (this.isCommandKeyword() || this.isKeyword("AS")) this.fail(`expected an expression before ${t.value.toUpperCase()}`, t.start);
        const lower = t.value.toLowerCase();
        if (lower === "true" || lower === "false") { this.next(); return { kind: "boolean", value: lower === "true", start: t.start, end: t.end }; }
        if (lower === "null") { this.next(); return { kind: "null", start: t.start, end: t.end }; }
        // A single-parameter lambda without parentheses: `x => body`.
        if (this.isOp("=>", 1)) {
          this.next(); this.next();
          const body = this.expr();
          return { kind: "lambda", params: [t.value], body, start: t.start, end: body.end };
        }
        if (this.isPunct("(", 1)) return this.call(t);
        this.next();
        return { kind: "ident", name: t.value, start: t.start, end: t.end };
      }
      case "op": return this.fail(`unexpected '${t.value}'`, t.start);
      case "eof": return this.fail("unexpected end of query", t.start);
    }
  }

  /** `(a, b) => body` at the current `(`; null when the parentheses are not a parameter list. */
  private tryLambda(): Expr | null {
    let k = 1;
    const params: string[] = [];
    if (this.peek(k).kind === "ident") {
      params.push(this.peek(k).value);
      k++;
      while (this.isPunct(",", k) && this.peek(k + 1).kind === "ident") { params.push(this.peek(k + 1).value); k += 2; }
    }
    if (!(this.isPunct(")", k) && this.isOp("=>", k + 1))) return null;
    const start = this.peek().start;
    this.pos += k + 2;
    const body = this.expr();
    return { kind: "lambda", params, body, start, end: body.end };
  }

  /** `name(args)`, with the bare date/duration literal forms read off the raw source. */
  private call(name: Token): Expr {
    const lower = name.value.toLowerCase();
    const open = this.peek(1);
    if (lower === "date" || lower === "dur") {
      // Find the matching `)` by token nesting and look at the raw text between.
      let depth = 0;
      let k = 1;
      for (; ; k++) {
        const t = this.peek(k);
        if (t.kind === "eof") this.fail(`unterminated ${name.value}(`, open.start);
        if (t.kind === "punct" && t.value === "(") depth++;
        else if (t.kind === "punct" && t.value === ")") { depth--; if (depth === 0) break; }
      }
      const close = this.peek(k);
      const raw = this.source.slice(open.end, close.start);
      const inner = this.peek(2);
      // A quoted argument is already the OQX form (`date("today")`); a bare one
      // is a literal only when it matches the literal grammar.
      const quoted = inner.kind === "string" && k === 3;
      if (lower === "date" && (quoted ? isDateLiteral(inner.value) : isDateLiteral(raw))) {
        this.pos += k + 1;
        return { kind: "date", text: dateLiteralText(quoted ? inner.value : raw), start: name.start, end: close.end };
      }
      if (lower === "dur" && (quoted ? isDurationLiteral(inner.value) : isDurationLiteral(raw))) {
        this.pos += k + 1;
        return { kind: "duration", text: durationLiteralText(quoted ? inner.value : raw), start: name.start, end: close.end };
      }
    }
    this.next(); this.next();
    const args: Expr[] = [];
    if (!this.isPunct(")")) {
      args.push(this.expr());
      while (this.isPunct(",")) { this.next(); args.push(this.expr()); }
    }
    const close = this.expectPunct(")", `to close ${name.value}()`);
    return { kind: "call", name: name.value, args, start: name.start, end: close.end };
  }
}

/** The target of `[[target#heading|display]]`: the text before `|` and `#`. */
function linkTarget(inner: string): string {
  let t = inner;
  const bar = t.indexOf("|");
  if (bar >= 0) t = t.slice(0, bar);
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  return t.trim();
}
