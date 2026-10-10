// OQX parser for the generic kernel. Parses query STRUCTURE (source chain,
// where/select/order/follow, the where-clause boolean tree, and postfix consumer
// directives) and, for scalar interiors, builds an evaluable expression AST with
// an embedded Pratt parser sharing the same token cursor.
//
// Two design-kernel rules (see the OQX syntax notes) shape the grammar:
//   1. Dot navigation belongs to the host object model — a receiver/source is a
//      dotted identifier chain (or a `${…}` binding), NOT a method call.
//   2. Whitespace directives (collect/exists/count/first/single) belong to OQX —
//      a consumer is `<receiver> <directive> { <block> }`, never a method.
//
// Clause order is FIXED (ADR-020). Within one clause body — the top level or a
// consumer block — each clause appears at most once, in exactly this order:
//
//   select <projection>  from <source>  where <predicate>  follow <dest>, … {…}
//   order by …  limit N  offset N
//
// A `follow` destination is a relation of the current row (a receiver, never
// an outer reference) or a destination block — a receiver (which MAY be an
// outer reference, `^people`) immediately followed by `collect`/`first`/
// `single` [`distinct`] `{ body }`, exactly the select-position directive
// `tryOp(false)` recognizes, re-evaluated per frontier row (language 0.14).
//
// Every clause is optional except that a top-level body needs `from` (the
// receiver-plus-consumer form `<receiver> <consumer> { block }` supplies the
// source itself, so its block's `from` is an optional re-projection). Only
// `select` may drop its keyword, and only when it is the first clause written
// (`name, age from people`); every other clause always carries its keyword, so
// a predicate is never implicit — a block filters with `where`. An out-of-order
// clause is a parse error naming the order. `where` may reference the same
// body's `select` aliases: the parser VALIDATES those references (a cycle or a
// block alias inside an expression is a parse error) but keeps the surface
// form; `resolveAliases` (resolve.ts) substitutes them before evaluation.
//
// Every node carries its `span` — `[start, end)` in code points over the raw
// source, from the first token that produced it to the end of the last; a
// parenthesized operand's span includes its parentheses (spec/oqx/AST.md).
//
// Principle of least surprise, applied to the grammar: a rule a careful user
// would not predict is a bug. Hence `!` binds tighter than comparison in every
// position (`!a == b` is `(!a) == b`, as in C); parentheses in `where` group a
// predicate OR a scalar, decided by what follows the `)`; a range's open end
// stops at a clause word; duplicate projection names, a `follow distinct` with
// no relation, a lift outside a where-position `collect`, and a top-level
// `limit ^n` (there is no enclosing scope) are parse errors rather than silent
// misreads.

import type { Token, TokType } from "./lexer.ts";
import { lexTemplate, lexString } from "./lexer.ts";
import { OqxError } from "./errors.ts";
import type {
  Query, Where, Expr, OpNode, Subquery, SelectItem, OrderSpec, Follow, FollowDestination, Consumer, RelOp,
  BinaryOp, Span,
} from "./ast.ts";
import { resolveWhere } from "./resolve.ts";

const CONSUMERS = new Set<string>(["collect", "exists", "none", "count", "first", "single"]);
// The fixed clause order of a body (ADR-020). Each clause appears at most once.
const CLAUSE_ORDER = ["select", "from", "where", "follow", "order by", "limit", "offset"] as const;
type Clause = (typeof CLAUSE_ORDER)[number];
// Contextual clause words lexed as bare idents; an open-ended range must stop
// before them rather than consume them as its high bound.
const CLAUSE_WORDS = new Set<string>([
  "collect", "exists", "none", "count", "first", "single",
  "order", "by", "asc", "desc", "follow", "distinct", "frontier", "depth", "in", "values",
  "limit", "offset",
]);
const RELOPS = new Set<string>(["==", "!=", "<", "<=", ">", ">="]);
const CMP_OPS = new Set<string>(["==", "!=", "<", "<=", ">", ">="]);
const ADD_OPS = new Set<string>(["+", "-"]);
const MUL_OPS = new Set<string>(["*", "/", "%"]);
// `true`/`false`/`null` are literals in every position, so they can never name a
// receiver (`true exists { … }`, `follow null`).
const LITERAL_WORDS = new Set<string>(["true", "false", "null"]);

// Where a clause body sits, for error messages and position-dependent rules.
interface BodyCtx {
  /** The top-level body form (a stray token there is "after the query"). */
  top: boolean;
  /** The consumer of the enclosing block, when not top-level. */
  op: Consumer | null;
  /** Whether `^name: expr` lift items are legal: only in a where-position `collect { … }`. */
  liftsAllowed: boolean;
}
const TOP_CTX: BodyCtx = { top: true, op: null, liftsAllowed: false };

/** Parse a tagged-template call into a Query. */
export function parseTemplate(fragments: readonly string[], values: number): Query {
  return new Parser(lexTemplate(fragments, values)).parseQuery();
}

/** Parse a plain query string (no bindings) into a Query. */
export function parseString(src: string): Query {
  return new Parser(lexString(src)).parseQuery();
}

interface BodyClauses {
  froms: Expr[];
  where: Where | null;
  select: SelectItem[];
  orderBy: OrderSpec[] | null;
  follow: Follow | null;
  distinct: boolean;
  values: boolean;
  limit: Expr | null;
  offset: Expr | null;
}

// A copy of a node with another span (a parenthesized operand takes the span of
// its parentheses).
function withSpan<T extends { span: Span }>(node: T, span: Span): T {
  return { ...node, span };
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ---- cursor helpers -------------------------------------------------------
  private peek(): Token { return this.tokens[this.pos]!; }
  private peekAt(n: number): Token | undefined { return this.tokens[this.pos + n]; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private at(type: TokType, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private atOp(value: string): boolean {
    const t = this.peek();
    return t.type === "op" && t.value === value;
  }
  private fail(msg: string): never {
    throw new OqxError(`${msg} (at offset ${this.peek().pos})`, "parse");
  }
  /** Code-point offset of the next token (the start of a node about to be parsed). */
  private start(): number { return this.peek().pos; }
  /** Code-point offset just past the last consumed token (the end of a node just parsed). */
  private end(): number { return this.pos === 0 ? 0 : this.tokens[this.pos - 1]!.end; }
  private sp(start: number): Span { return [start, this.end()]; }

  // ---- top level ------------------------------------------------------------
  parseQuery(): Query {
    const start = this.start();
    // Directive form: `<receiver> <consumer> { … }` consuming the whole query.
    const directive = this.tryOp(false);
    if (directive && this.at("eof")) {
      return {
        kind: "query",
        span: this.sp(start),
        source: directive.receiver,
        from: directive.sub.from,
        where: directive.sub.where,
        select: directive.sub.select,
        orderBy: directive.sub.orderBy,
        consumer: directive.op,
        follow: directive.sub.follow,
        distinct: directive.distinct,
        values: directive.sub.values,
        limit: directive.sub.limit,
        offset: directive.sub.offset,
      };
    }
    if (directive) this.fail(`unexpected ${this.tokDesc()} after the top-level directive`);

    // Body form: the fixed clause list; its `from` is the source.
    const body = this.parseBody(TOP_CTX);
    if (!this.at("eof")) this.fail(`unexpected ${this.tokDesc()} after the query — nothing may follow the last clause`);
    if (body.froms.length === 0) {
      this.fail("a query must name its source with `from <collection>` (or be `<collection> <consumer> { … }`)");
    }
    return {
      kind: "query",
      span: this.sp(start),
      source: body.froms[0]!,
      from: body.froms.slice(1),
      where: body.where,
      select: body.select,
      orderBy: body.orderBy,
      consumer: "collect",
      follow: body.follow,
      distinct: body.distinct,
      values: body.values,
      limit: body.limit,
      offset: body.offset,
    };
  }

  private tokDesc(): string {
    const t = this.peek();
    return t.type === "eof" ? "end of query" : `'${t.value || t.type}'`;
  }

  // ---- clause body (shared by top level and consumer blocks) ----------------
  // An ordered state machine over the fixed clause sequence: `stage` is the
  // index (in CLAUSE_ORDER) of the last clause parsed, so a clause with a lower
  // index is out of order and an equal index is a duplicate. The only
  // keyword-less clause is a leading projection (while `stage` is still -1).
  private parseBody(ctx: BodyCtx): BodyClauses {
    const froms: Expr[] = [];
    let where: Where | null = null;
    let select: SelectItem[] = [];
    let orderBy: OrderSpec[] | null = null;
    let follow: Follow | null = null;
    let distinct = false;
    let values = false;
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    let stage = -1;

    const enter = (clause: Clause): void => {
      const idx = CLAUSE_ORDER.indexOf(clause);
      if (idx === stage) this.fail(`duplicate \`${clause}\` clause`);
      if (idx < stage) {
        this.fail(`\`${clause}\` must come before \`${CLAUSE_ORDER[stage]}\` — OQX clause order is ${CLAUSE_ORDER.join(", ")}`);
      }
      stage = idx;
    };

    while (!this.at("eof") && !this.at("rbrace")) {
      if (this.at("kw", "select")) {
        enter("select");
        this.next();
        if (this.at("ident", "distinct")) { this.next(); distinct = true; }
        ({ items: select, values } = this.parseProjection(ctx));
        continue;
      }
      if (this.at("kw", "from")) {
        enter("from");
        this.next();
        froms.push(this.parseValueExpr());
        continue;
      }
      if (this.at("kw", "where")) {
        enter("where");
        this.next();
        where = this.parseWhere();
        continue;
      }
      if (this.atFollow()) {
        enter("follow");
        follow = this.parseFollow();
        continue;
      }
      if (this.atOrderBy()) {
        enter("order by");
        this.next(); this.next(); // `order` `by`
        orderBy = this.parseOrderSpecs();
        continue;
      }
      if (this.atBound()) {
        const word = this.peek().value as "limit" | "offset";
        enter(word);
        this.next();
        // A top-level bound is evaluated at the root scope itself, so `^n` there
        // has nothing to read: say so now instead of an "absent" error at eval.
        if (ctx.top && this.at("caret")) {
          this.fail(`\`${word} ^…\` at the top level has no enclosing scope — a top-level bound is a number literal or a binding; inside a block \`^name\` reads the enclosing row`);
        }
        const e = this.parsePostfix();
        if (word === "limit") limit = e; else offset = e;
        continue;
      }
      // A keyword-less run. Before any clause it is the projection (`select` is
      // the one keyword that may be dropped, and only in first position); after
      // any clause it is an error — a predicate is never implicit.
      if (stage === -1 && (this.at("ident") || this.at("binding") || this.at("caret") || this.canStartValue())) {
        enter("select");
        ({ items: select, values } = this.parseProjection(ctx));
        continue;
      }
      this.failUnexpectedInBody(stage, ctx);
    }
    // Validate the alias references of this body's `where` (cycles, a block
    // alias inside an expression); the surface form is kept.
    if (where) resolveWhere(select, where, (msg) => this.fail(msg));
    return { froms, where, select, orderBy, follow, distinct, values, limit, offset };
  }

  // The error for a token that starts no clause, phrased for the mistake it most
  // likely is: a bare run right after `from` (the old implicit `where`, or a
  // consumer word where a whole-query directive was meant), or a stray token.
  private failUnexpectedInBody(stage: number, ctx: BodyCtx): never {
    const t = this.peek();
    const remaining = CLAUSE_ORDER.slice(stage + 1).join("/");
    const last = stage >= 0 ? CLAUSE_ORDER[stage] : null;
    const isWord = t.type === "ident" || t.type === "kw" || t.type === "binding" || t.type === "caret";
    // Punctuation, an operator, or a literal after a complete clause is a stray
    // token, not a misplaced predicate: name where the body ends. (A comma keeps
    // the projection hint below — `name from r, id` almost always meant a
    // projection.)
    if (last !== null && !isWord && t.type !== "comma") {
      if (ctx.top) this.fail(`unexpected ${this.tokDesc()} after the query — nothing may follow the last clause (expected ${remaining} or the end of the query)`);
      this.fail(`unexpected ${this.tokDesc()} in the ${ctx.op} { … } block — expected ${remaining} or '}' to close the block`);
    }
    // Clause words that did not form a clause: say what the clause needs.
    if (last !== null && t.type === "ident") {
      if (t.value === "order") this.fail(`unexpected 'order' after \`${last}\` — an ordering is written \`order by <expr> [asc|desc]\``);
      if (t.value === "follow") this.fail(`unexpected 'follow' after \`${last}\` — \`follow\` needs a relation: \`follow <relation>\` or \`follow distinct <relation>\``);
      if (t.value === "limit" || t.value === "offset") {
        this.fail(`unexpected '${t.value}' after \`${last}\` — a bound is a non-negative number literal, a binding, or (inside a block) an outer reference \`^name\``);
      }
    }
    if (last === "from" && t.type === "ident" && CONSUMERS.has(t.value)) {
      this.fail(`unexpected \`${t.value}\` after \`from\` — a whole-query consumer is written \`<collection> ${t.value} { … }\`; to project a field named ${t.value} write \`select ${t.value} from …\`; a predicate needs \`where\``);
    }
    if (last === "from") {
      this.fail(`unexpected ${this.tokDesc()} after \`from\` — a predicate needs \`where\` (there is no implicit where), and a projection goes before \`from\` (\`select … from …\`); expected ${remaining}`);
    }
    // `{ rel exists { … } }` / `{ rel count { … } >= 2 }`: the leading `rel` was
    // read as the projection, so the consumer word is where the mistake shows.
    if (last === "select" && t.type === "ident" && CONSUMERS.has(t.value)) {
      this.fail(`unexpected \`${t.value}\` after a projection — a consumer test is a predicate: write \`where <relation> ${t.value} { … }\` — a predicate is never implicit; a nested block in a projection needs a name (\`name: <relation> collect { … }\`)`);
    }
    if (last === null) this.fail(`unexpected ${this.tokDesc()} — expected a projection or ${remaining}`);
    this.fail(`unexpected ${this.tokDesc()} after \`${last}\` — expected ${remaining}`);
  }

  // `limit <n>` / `offset <n>` — the word must be followed by something that can
  // be a bound (a number, a binding, or an outer reference), so a field that
  // happens to be called `limit` still projects/filters as a bare name.
  private atBound(): boolean {
    const t = this.peek();
    if (t.type !== "ident" || (t.value !== "limit" && t.value !== "offset")) return false;
    const nx = this.peekAt(1);
    return !!nx && (nx.type === "number" || nx.type === "binding" || nx.type === "caret");
  }

  private atOrderBy(): boolean {
    const t = this.peek();
    const nx = this.peekAt(1);
    return t.type === "ident" && t.value === "order" && !!nx && nx.type === "ident" && nx.value === "by";
  }

  // `follow` is a clause when a relation (or something that tries to be one —
  // `distinct`, an outer reference) follows; otherwise it is a field name.
  private atFollow(): boolean {
    if (!this.at("ident", "follow")) return false;
    const nx = this.peekAt(1);
    return !!nx && (nx.type === "ident" || nx.type === "binding" || nx.type === "caret");
  }

  // ---- follow ---------------------------------------------------------------
  private parseFollow(): Follow {
    const start = this.start();
    this.next(); // `follow`
    let distinct = false;
    // After `follow`, `distinct` is a keyword (a relation literally named
    // `distinct` is not supported); it must be followed by the relation.
    if (this.at("ident", "distinct")) {
      this.next();
      distinct = true;
      if (!this.at("ident") && !this.at("binding") && !this.at("caret")) {
        this.fail("expected a relation after `follow distinct` (`follow distinct <relation>`)");
      }
    }
    const destinations: FollowDestination[] = [this.parseFollowDestination()];
    while (this.at("comma")) {
      this.next();
      if (!this.at("ident") && !this.at("binding") && !this.at("caret")) {
        this.fail("expected a relation after ',' (`follow <relation>, <relation>`)");
      }
      destinations.push(this.parseFollowDestination());
    }
    const follow: Follow = { kind: "follow", span: this.sp(start), destinations, distinct, where: null, frontier: null, depth: null, by: null };
    if (!this.at("lbrace")) return follow;
    this.next(); // '{'
    while (!this.at("eof") && !this.at("rbrace")) {
      if (this.at("kw", "where")) {
        if (follow.where) this.fail("duplicate `where` in follow clause");
        this.next();
        follow.where = this.parseValueExpr();
      } else if (this.at("ident", "frontier")) {
        if (follow.frontier) this.fail("duplicate `frontier` in follow clause");
        this.next();
        follow.frontier = this.parseValueExpr();
      } else if (this.at("ident", "by")) {
        if (follow.by !== null) this.fail("duplicate `by` in follow clause");
        this.next();
        follow.by = this.parseValueExpr();
      } else if (this.at("ident", "depth")) {
        if (follow.depth !== null) this.fail("duplicate `depth` in follow clause");
        this.next();
        if (!this.at("number")) this.fail("expected an integer after `depth`");
        const v = Number(this.next().value);
        if (!Number.isInteger(v) || v < 1 || v > 8) this.fail("follow depth must be an integer between 1 and 8");
        follow.depth = v;
      } else {
        this.fail(`unexpected ${this.tokDesc()} in follow block — expected where/frontier/depth/by`);
      }
    }
    if (!this.at("rbrace")) this.fail("expected '}' to close the follow block");
    this.next();
    follow.span = this.sp(start);
    return follow;
  }

  // One `follow` destination. The lookahead mirrors `tryOp`: a receiver (binding,
  // or carets + a dotted name) followed by a consumer word and `{` / `distinct {`
  // is a destination block, parsed by `tryOp(false)` itself — but only the
  // select-position consumers (collect/first/single) yield rows to walk; the
  // where-position tests are rejected by name before their body is read. With
  // no directive the tokens are re-read as a plain relation of the current row,
  // where an outer reference is still an error (a `^name` head only makes sense
  // as the receiver of a block, since the block is what varies per row).
  private parseFollowDestination(): FollowDestination {
    const start = this.pos;
    let isReceiver = false;
    if (this.at("binding")) { this.next(); isReceiver = true; }
    else if (this.at("ident") || this.at("caret")) {
      const startPos = this.start();
      this.parseCarets();
      if (this.at("ident")) { this.parseNavFrom(this.next(), 0, startPos); isReceiver = true; }
    }
    if (isReceiver && this.at("ident") && CONSUMERS.has(this.peek().value)) {
      const op = this.peek().value;
      const after = this.peekAt(1);
      const opThenBrace = after?.type === "lbrace";
      const opDistinctBrace = after?.type === "ident" && after.value === "distinct" && this.peekAt(2)?.type === "lbrace";
      if (opThenBrace || opDistinctBrace) {
        if (op !== "collect" && op !== "first" && op !== "single") {
          this.fail(`a follow destination must use collect/first/single, not \`${op}\` (exists/none/count are where-position tests)`);
        }
        this.pos = start;
        const block = this.tryOp(false);
        if (!block) this.fail("expected a destination block (`<receiver> collect { … }`) after `follow`");
        return block;
      }
    }
    this.pos = start;
    if (this.at("caret")) {
      this.fail("`follow` takes a relation of the current row (`follow <relation>`); an outer reference `^name` is not allowed there — it may only head a destination block (`follow ^name collect { … }`)");
    }
    return this.parseReceiver();
  }

  // A receiver/source: a `${…}` binding, or a dotted identifier navigation chain
  // whose head may be an outer reference (`^rel`, `^^root.rel`) — since a bare
  // name is the current row's own property, an enclosing row's relation or a
  // named root is only reachable as a receiver through `^` — or a free-function
  // call (`entries(prefs)`), so a computed collection can be consumed directly.
  private parseReceiver(): Expr {
    if (this.at("binding")) return this.bindingNode(this.next());
    const start = this.start();
    const levels = this.parseCarets();
    if (!this.at("ident")) this.fail("expected a collection navigation (a property/relation name)");
    if (LITERAL_WORDS.has(this.peek().value)) this.fail(`\`${this.peek().value}\` is a literal, not a collection`);
    return this.parseNavFrom(this.next(), levels, start).expr;
  }

  private bindingNode(t: Token): Expr {
    return { kind: "binding", span: [t.pos, t.end], index: t.index! };
  }

  // Consume a run of `^` and return its length (0 when there is none).
  private parseCarets(): number {
    let levels = 0;
    while (this.at("caret")) { this.next(); levels++; }
    return levels;
  }

  // A dotted navigation chain from `head`; `levels` > 0 makes the head an outer
  // reference read exactly that many scopes out (`start` is then the position
  // of the first caret). A bare head followed by `(` is a free-function call
  // (`entries(x)`), which may then be navigated further.
  private parseNavFrom(head: Token, levels = 0, start = head.pos): { expr: Expr; name: string } {
    let expr: Expr = levels > 0
      ? { kind: "outer", span: [start, head.end], levels, name: head.value }
      : { kind: "ident", span: [start, head.end], name: head.value };
    let name = head.value;
    if (levels === 0 && this.at("lparen")) {
      const args = this.parseArgs();
      expr = { kind: "call", span: this.sp(start), recv: null, name: head.value, args };
    }
    while (this.at("dot")) {
      this.next();
      if (!this.at("ident")) this.fail("expected a property name after '.'");
      name = this.next().value;
      expr = { kind: "member", span: this.sp(start), recv: expr, name };
    }
    return { expr, name };
  }

  // ---- select ---------------------------------------------------------------
  // A projection list, optionally followed by the `values` mode word. Under
  // `values` the list must be exactly one item, which need not be named: the
  // row's result IS that value (no `{ name: value }` record), so a name would be
  // meaningless. Without `values`, every item needs a key — a bare/dotted
  // navigation supplies its own (the last segment); any other expression must be
  // aliased (`name: expr`).
  private parseProjection(ctx: BodyCtx): { items: SelectItem[]; values: boolean } {
    const items = [this.parseSelectItem(ctx)];
    while (this.at("comma")) { this.next(); items.push(this.parseSelectItem(ctx)); }
    let values = false;
    if (this.at("ident", "values")) {
      this.next();
      values = true;
      if (items.length !== 1) this.fail("`values` projects exactly one expression (got " + items.length + ")");
      const only = items[0]!;
      if (only.kind === "field" && only.lift > 0) this.fail("a lift (^name: …) cannot be combined with `values`");
    } else {
      // Every item needs a distinct key: two items with one name would silently
      // overwrite each other in the record. Lifts are keyed per scope (`^x` and
      // `^^x` bind different rows), so the lift depth is part of the key.
      const seen = new Set<string>();
      for (const it of items) {
        if (it.name === "") this.fail("a leading expression is a projection (select): an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `where …` — a predicate is never implicit");
        const key = `${"^".repeat(it.kind === "field" ? it.lift : 0)}${it.name}`;
        if (seen.has(key)) this.fail(`duplicate projection name '${it.name}' — each projected item needs its own name (alias one: \`other: expr\`)`);
        seen.add(key);
      }
    }
    return { items, values };
  }

  private parseSelectItem(ctx: BodyCtx): SelectItem {
    const start = this.start();
    // Leading `^`s mark a lift; the count is how many scopes out it binds. A
    // lift is bound by a `collect { … }` in where position and nowhere else — at
    // the top level, in a select-position block, or in an exists/none/count
    // block it would silently do nothing (or act as a plain field), so it is an
    // error there.
    const lift = this.parseCarets();
    if (!this.at("ident") && !this.canStartValue()) this.fail("expected a projection name");
    if (lift > 0 && !ctx.liftsAllowed) {
      const what = this.at("ident") ? `^${this.peek().value}` : "^name";
      this.fail(`a lift (${what}) binds a value into the enclosing row and is only valid in a \`collect { … }\` in where position (\`where <relation> collect { ${what}: … }\`)`);
    }
    if (this.at("ident") && this.peekAt(1)?.type === "colon") {
      const name = this.next().value;
      this.next(); // ':'
      const op = this.tryOp(false);
      if (op) {
        if (op.op !== "collect" && op.op !== "first" && op.op !== "single") {
          this.fail(`projection '${name}' must use collect/first/single, not ${op.op} (exists/none/count are where-position tests)`);
        }
        if (lift) this.fail(`a lift (^${name}) value must be a scalar expression, not ${op.op} { … }`);
        return { kind: "collect", span: this.sp(start), name, op };
      }
      const expr = this.parseValueExpr();
      return { kind: "field", span: this.sp(start), name, expr, lift };
    }
    // Unaliased item: a bare/dotted navigation keys by its last segment; any
    // other expression is unnamed ("") — legal only under `values` (checked by
    // parseProjection, which sees the whole list).
    const expr = this.parseValueExpr();
    return { kind: "field", span: this.sp(start), name: navKey(expr) ?? "", expr, lift };
  }

  // ---- order by -------------------------------------------------------------
  private parseOrderSpecs(): OrderSpec[] {
    const specs = [this.parseOrderSpec()];
    while (this.at("comma")) { this.next(); specs.push(this.parseOrderSpec()); }
    return specs;
  }

  private parseOrderSpec(): OrderSpec {
    const start = this.start();
    const expr = this.parseValueExpr();
    let desc = false;
    if (this.at("ident", "asc")) this.next();
    else if (this.at("ident", "desc")) { this.next(); desc = true; }
    return { kind: "order", span: this.sp(start), expr, desc };
  }

  // ---- where boolean tree: or → and → primary --------------------------------
  // `!` is handled in `parseWherePrimary`: it applies to the operand right after
  // it (a consumer test, a parenthesized group, or a scalar primary), never to a
  // whole comparison — `!a == b` is `(!a) == b`, exactly as in value position.
  private parseWhere(): Where { return this.parseWhereOr(); }

  private parseWhereOr(): Where {
    const start = this.start();
    const left = this.parseWhereAnd();
    if (!this.atOp("||")) return left;
    const parts = [left];
    while (this.atOp("||")) { this.next(); parts.push(this.parseWhereAnd()); }
    return { kind: "or", span: this.sp(start), parts };
  }

  private parseWhereAnd(): Where {
    const start = this.start();
    const left = this.parseWherePrimary();
    if (!this.atOp("&&")) return left;
    const parts = [left];
    while (this.atOp("&&")) { this.next(); parts.push(this.parseWherePrimary()); }
    return { kind: "and", span: this.sp(start), parts };
  }

  // A where operand: `[!…] ( where )`, `[!…] <receiver> <consumer> { … }`, or a
  // scalar leaf (a cmp-level expression, which handles its own `!`).
  //
  // Parentheses group EITHER a predicate or a scalar, decided by what follows
  // the `)`: a comparison, arithmetic, `in`, a range, or `.`-navigation means
  // the group is a scalar operand (`(a + 1) > 2`, `(a || b) == 5`,
  // `(x).size() > 1`); anything else means it is a predicate group
  // (`(a > 1) && b`). A group that contains a consumer test can only be a
  // predicate.
  private parseWherePrimary(): Where {
    const start = this.pos;
    const notStarts: number[] = [];
    while (this.atOp("!")) { notStarts.push(this.next().pos); }
    if (this.at("lparen")) {
      const lparen = this.next().pos;
      const inner = this.parseWhere();
      if (!this.at("rparen")) this.fail("expected ')' to close a grouped where expression");
      this.next();
      const group: Span = [lparen, this.end()];
      if (this.atScalarContinuation()) {
        let e = this.parsePostfix(withSpan(this.whereToExpr(inner), group));
        for (let i = notStarts.length - 1; i >= 0; i--) e = { kind: "unary", span: [notStarts[i]!, e.span[1]], op: "!", expr: e };
        const expr = this.parseCmp(e);
        return { kind: "scalar", span: expr.span, expr };
      }
      return wrapNot(withSpan(inner, group), notStarts);
    }
    const op = this.tryOp(true);
    if (op) return wrapNot(this.finishWhereOp(op), notStarts);
    // A scalar leaf, re-read from the first `!` so the scalar grammar gives `!`
    // its one precedence (tighter than comparison). A leaf whose whole value is
    // a negation keeps the `not` node shape (`where !active`).
    this.pos = start;
    return scalarLeaf(this.parseCmp());
  }

  // Whether the token after a `)` continues a scalar expression.
  private atScalarContinuation(): boolean {
    const t = this.peek();
    if (t.type === "op") return CMP_OPS.has(t.value) || ADD_OPS.has(t.value) || MUL_OPS.has(t.value);
    return t.type === "dot" || t.type === "range" || (t.type === "ident" && t.value === "in");
  }

  // A parenthesized where-group that turned out to be a scalar operand, as an
  // expression. A consumer test has no scalar value, so it cannot be operated on.
  private whereToExpr(w: Where): Expr {
    switch (w.kind) {
      case "scalar": return w.expr;
      case "not": return { kind: "unary", span: w.span, op: "!", expr: this.whereToExpr(w.expr) };
      case "and": case "or": {
        const op = w.kind === "and" ? "&&" : "||";
        return w.parts.map((p) => this.whereToExpr(p)).reduce((l, r) => ({ kind: "logical", span: [l.span[0], r.span[1]], op, left: l, right: r }));
      }
      case "op": {
        const hint = w.op === "count" ? ` — write \`<relation> count { … } ${this.peek().value} N\` without the parentheses` : "";
        this.fail(`a consumer test (${w.op} { … }) is a predicate, not a value, so it cannot be compared or operated on${hint}`);
      }
    }
  }

  // Validate a consumer op used in where position and attach any `count { … } <op> N`.
  private finishWhereOp(op: OpNode): OpNode {
    if (op.op === "first" || op.op === "single") {
      this.fail(`${op.op} { … } is a select-position lookup; in where use exists { … } / none { … } or count { … } <op> N`);
    }
    if (op.op === "collect") {
      const allLift = op.sub.select.length > 0 && op.sub.select.every((s) => s.kind === "field" && s.lift > 0);
      if (!allLift) this.fail("collect { … } in where must project only ^lift values (else use exists/count)");
    }
    if (this.peek().type === "op" && RELOPS.has(this.peek().value)) {
      if (op.op !== "count") this.fail(`only count { … } is comparable; '${op.op} { … } <op> N' is not valid`);
      const relop = this.next().value as RelOp;
      if (!this.at("number")) this.fail(`expected an integer after 'count { … } ${relop}'`);
      const v = Number(this.next().value);
      if (!Number.isInteger(v)) this.fail("count comparison takes an integer");
      op.countCmp = { op: relop, value: v };
      op.span = [op.span[0], this.end()];
    }
    return op;
  }

  // Detect + parse a postfix consumer op `<receiver> <consumer> { <sub> }`.
  // Returns null (rewinding) when the lookahead is not a consumer op.
  private tryOp(inWhere: boolean): OpNode | null {
    const start = this.pos;
    const startPos = this.start();
    let receiver: Expr;
    if (this.at("binding")) receiver = this.bindingNode(this.next());
    else if (this.at("ident") || this.at("caret")) {
      const levels = this.parseCarets();
      if (!this.at("ident")) { this.pos = start; return null; }
      receiver = this.parseNavFrom(this.next(), levels, startPos).expr;
    } else return null;

    if (this.at("ident") && CONSUMERS.has(this.peek().value)) {
      const after = this.peekAt(1);
      // `<op> { … }` or `<op> distinct { … }`.
      const opThenBrace = after?.type === "lbrace";
      const opDistinctBrace = after?.type === "ident" && after.value === "distinct" && this.peekAt(2)?.type === "lbrace";
      if (opThenBrace || opDistinctBrace) {
        if (receiver.kind === "ident" && LITERAL_WORDS.has(receiver.name)) this.fail(`\`${receiver.name}\` is a literal, not a collection`);
        const op = this.next().value as Consumer;
        let distinct = false;
        if (this.at("ident", "distinct")) { this.next(); distinct = true; }
        const lbrace = this.next().pos; // '{'
        const body = this.parseBody({ top: false, op, liftsAllowed: inWhere && op === "collect" });
        if (!this.at("rbrace")) this.fail(`expected '}' to close the ${op} { … } block`);
        this.next();
        const sub: Subquery = {
          kind: "subquery",
          span: this.sp(lbrace),
          from: body.froms,
          where: body.where,
          select: body.select,
          orderBy: body.orderBy,
          follow: body.follow,
          values: body.values,
          limit: body.limit,
          offset: body.offset,
        };
        return { kind: "op", span: this.sp(startPos), receiver, op, sub, countCmp: null, distinct: distinct || body.distinct };
      }
    }
    this.pos = start;
    return null;
  }

  // ---- expression Pratt parser ----------------------------------------------
  // Value position (select/order/follow/source): full boolean+arithmetic.
  private parseValueExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.atOp("||")) {
      this.next();
      const right = this.parseAnd();
      left = { kind: "logical", span: [left.span[0], right.span[1]], op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.atOp("&&")) {
      this.next();
      const right = this.parseCmp();
      left = { kind: "logical", span: [left.span[0], right.span[1]], op: "&&", left, right };
    }
    return left;
  }

  // Comparison / membership (also the entry point for a where scalar leaf, so a
  // where leaf never swallows the where-tree's && / ||). Non-associative: a
  // second comparison in a row is an error, not a silent stray token.
  //
  // Each level from here down takes an optional already-parsed `left` operand,
  // so a parenthesized where-group promoted to a scalar continues into the
  // operator tail without re-reading its tokens.
  private parseCmp(left?: Expr): Expr {
    const lhs = this.parseRange(left);
    const t = this.peek();
    const isCmp = (): boolean => (this.peek().type === "op" && CMP_OPS.has(this.peek().value)) || this.at("ident", "in");
    if (!isCmp()) return lhs;
    const op = this.next().value;
    const rhs = this.parseRange();
    const span: Span = [lhs.span[0], rhs.span[1]];
    const result: Expr = op === "in"
      ? { kind: "in", span, left: lhs, right: rhs }
      : { kind: "binary", span, op: op as BinaryOp, left: lhs, right: rhs };
    if (isCmp()) {
      this.fail(`comparisons do not chain: \`a ${t.value} b ${this.peek().value} c\` — write two comparisons joined with \`&&\``);
    }
    return result;
  }

  // Range literal: `lo..hi` / `lo...hi` and the open-ended forms `..hi`, `lo..`.
  // Binds looser than arithmetic (so `1+1..2*3` is the range 2..6) but tighter
  // than comparison / `in` (so `n in 1..5` reads as `n in (1..5)`). A leading
  // `..`/`...` opens the low end; a trailing `..`/`...` with no following value
  // opens the high end.
  private parseRange(left?: Expr): Expr {
    if (left === undefined && this.at("range")) {
      const tok = this.next();
      const exclusiveEnd = tok.value === "...";
      if (!this.canStartValue()) this.fail("a range needs at least one bound: `lo..hi`, `lo..`, or `..hi`");
      const hi = this.parseAdd();
      return { kind: "range", span: [tok.pos, hi.span[1]], lo: null, hi, exclusiveEnd };
    }
    const lo = this.parseAdd(left);
    if (this.at("range")) {
      const tok = this.next();
      const exclusiveEnd = tok.value === "...";
      const hi = this.canStartValue() ? this.parseAdd() : null;
      return { kind: "range", span: [lo.span[0], hi ? hi.span[1] : tok.end], lo, hi, exclusiveEnd };
    }
    return lo;
  }

  // Whether the current token can begin a value expression — used to tell an
  // open-ended range (`5..` followed by a clause boundary) from a bounded one.
  // Clause-continuation words (`order`, `by`, `follow`, `asc/desc`, `distinct`,
  // consumers, …) are lexed as bare idents, so they must NOT count as a value
  // start, or `where age in 18.. order by name` would read `order` as the bound.
  private canStartValue(): boolean {
    const t = this.peek();
    if (t.type === "ident") return !CLAUSE_WORDS.has(t.value);
    if (t.type === "number" || t.type === "string" ||
        t.type === "binding" || t.type === "lparen" || t.type === "caret") return true;
    return t.type === "op" && (t.value === "-" || t.value === "!");
  }

  private parseAdd(left?: Expr): Expr {
    left = this.parseMul(left);
    while (this.peek().type === "op" && ADD_OPS.has(this.peek().value)) {
      const op = this.next().value as BinaryOp;
      const right = this.parseMul();
      left = { kind: "binary", span: [left.span[0], right.span[1]], op, left, right };
    }
    return left;
  }

  private parseMul(left?: Expr): Expr {
    left = this.parseUnary(left);
    while (this.peek().type === "op" && MUL_OPS.has(this.peek().value)) {
      const op = this.next().value as BinaryOp;
      const right = this.parseUnary();
      left = { kind: "binary", span: [left.span[0], right.span[1]], op, left, right };
    }
    return left;
  }

  private parseUnary(left?: Expr): Expr {
    if (left !== undefined) return this.parsePostfix(left);
    if (this.atOp("!") || this.atOp("-")) {
      const tok = this.next();
      const expr = this.parseUnary();
      return { kind: "unary", span: [tok.pos, expr.span[1]], op: tok.value as "!" | "-", expr };
    }
    return this.parsePostfix();
  }

  private parsePostfix(left?: Expr): Expr {
    let expr = left ?? this.parsePrimary();
    const start = expr.span[0];
    for (;;) {
      if (this.at("dot")) {
        this.next();
        if (!this.at("ident")) this.fail("expected a property name after '.'");
        const name = this.next().value;
        if (this.at("lparen")) {
          const args = this.parseArgs();
          expr = { kind: "call", span: this.sp(start), recv: expr, name, args };
        } else {
          expr = { kind: "member", span: this.sp(start), recv: expr, name };
        }
      } else if (this.at("lparen") && left === undefined && expr.kind === "ident") {
        // free function call: name(args) — a bare name read here, not `(f)(x)`
        const args = this.parseArgs();
        expr = { kind: "call", span: this.sp(start), recv: null, name: expr.name, args };
      } else {
        break; // `{` is a consumer block boundary — not part of a value expression; anything else ends the chain too
      }
    }
    return expr;
  }

  private parseArgs(): Expr[] {
    this.next(); // '('
    const args: Expr[] = [];
    if (!this.at("rparen")) {
      args.push(this.parseValueExpr());
      while (this.at("comma")) { this.next(); args.push(this.parseValueExpr()); }
    }
    if (!this.at("rparen")) this.fail("expected ')' to close call arguments");
    this.next();
    return args;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    // `^name` / `^^name` — an outer reference reading `levels` scopes out. (As a
    // select-item head `^name:` is a lift, handled in parseSelectItem; here, in
    // expression position, `^` reads an enclosing row's field even when the
    // current row shadows the name.)
    if (t.type === "caret") {
      const levels = this.parseCarets();
      if (!this.at("ident")) this.fail("expected an identifier after '^' (an outer reference)");
      const name = this.next();
      return { kind: "outer", span: [t.pos, name.end], levels, name: name.value };
    }
    if (t.type === "number") { this.next(); return { kind: "lit", span: [t.pos, t.end], value: Number(t.value) }; }
    if (t.type === "string") { this.next(); return { kind: "lit", span: [t.pos, t.end], value: t.value }; }
    if (t.type === "binding") { this.next(); return this.bindingNode(t); }
    if (t.type === "lparen") {
      this.next();
      const e = this.parseValueExpr();
      if (!this.at("rparen")) this.fail("expected ')'");
      this.next();
      return withSpan(e, [t.pos, this.end()]);
    }
    if (t.type === "ident") {
      this.next();
      const span: Span = [t.pos, t.end];
      if (t.value === "true") return { kind: "lit", span, value: true };
      if (t.value === "false") return { kind: "lit", span, value: false };
      if (t.value === "null") return { kind: "lit", span, value: null };
      return { kind: "ident", span, name: t.value };
    }
    this.fail(`unexpected ${this.tokDesc()} — expected a value`);
  }
}

// The default key of an unaliased projection item: the last segment of a bare /
// dotted / outer navigation (`name`, `meta.slug` → "slug", `^name`), else null.
function navKey(e: Expr): string | null {
  switch (e.kind) {
    case "ident": return e.name;
    case "outer": return e.name;
    case "member": return e.name;
    default: return null;
  }
}

// `!` applied once per recorded `!` position to a where node, innermost first.
function wrapNot(w: Where, notStarts: readonly number[]): Where {
  for (let i = notStarts.length - 1; i >= 0; i--) w = { kind: "not", span: [notStarts[i]!, w.span[1]], expr: w };
  return w;
}

// A scalar where leaf. A leading `!` on the whole leaf becomes a `not` node (so
// `where !active` keeps its shape); inside a comparison it stays a unary `!`.
function scalarLeaf(e: Expr): Where {
  if (e.kind === "unary" && e.op === "!") return { kind: "not", span: e.span, expr: scalarLeaf(e.expr) };
  return { kind: "scalar", span: e.span, expr: e };
}
