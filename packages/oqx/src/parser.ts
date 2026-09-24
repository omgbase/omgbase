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
//   select <projection>  from <source>  where <predicate>  follow <relation> {…}
//   order by …  limit N  offset N
//
// Every clause is optional except that a top-level body needs `from` (the
// receiver-plus-consumer form `<receiver> <consumer> { block }` supplies the
// source itself, so its block's `from` is an optional re-projection). Only
// `select` may drop its keyword, and only when it is the first clause written
// (`name, age from people`); every other clause always carries its keyword, so
// a predicate is never implicit — a block filters with `where`. An out-of-order
// clause is a parse error naming the order. `where` may reference the same
// body's `select` aliases: after a body is parsed, each bare identifier in its
// `where` that names an alias is replaced by the alias's expression (a
// compile-time rewrite — see `inlineAliases`).

import type { Token, TokType } from "./lexer.ts";
import { lexTemplate, lexString } from "./lexer.ts";
import { OqxError } from "./errors.ts";
import type {
  Query, Where, Expr, OpNode, Subquery, SelectItem, OrderSpec, Follow, Consumer, RelOp,
} from "./ast.ts";

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

  // ---- top level ------------------------------------------------------------
  parseQuery(): Query {
    // Directive form: `<receiver> <consumer> { … }` consuming the whole query.
    const directive = this.tryOp();
    if (directive && this.at("eof")) {
      return {
        source: directive.receiver,
        from: directive.sub.from,
        where: directive.sub.where,
        select: directive.sub.select,
        orderBy: directive.sub.orderBy,
        consumer: directive.op,
        follow: directive.sub.follow,
        distinct: directive.distinct ?? false,
        values: directive.sub.values ?? false,
        ...bounds(directive.sub),
      };
    }
    if (directive) this.fail(`unexpected ${this.tokDesc()} after the top-level directive`);

    // Body form: the fixed clause list; its `from` is the source.
    const body = this.parseBody(true);
    if (!this.at("eof")) this.fail(`unexpected ${this.tokDesc()} after the query`);
    if (body.froms.length === 0) {
      this.fail("a query must name its source with `from <collection>` (or be `<collection> <consumer> { … }`)");
    }
    return {
      source: body.froms[0]!,
      from: body.froms.slice(1),
      where: body.where,
      select: body.select,
      orderBy: body.orderBy,
      consumer: "collect",
      follow: body.follow,
      distinct: body.distinct,
      values: body.values,
      ...bounds(body),
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
  private parseBody(orderByAllowed: boolean): BodyClauses {
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
        ({ items: select, values } = this.parseProjection());
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
      if (orderByAllowed && this.atOrderBy()) {
        enter("order by");
        this.next(); this.next(); // `order` `by`
        orderBy = this.parseOrderSpecs();
        continue;
      }
      if (this.atBound()) {
        const word = this.peek().value as "limit" | "offset";
        enter(word);
        this.next();
        const e = this.parsePostfix();
        if (word === "limit") limit = e; else offset = e;
        continue;
      }
      // A keyword-less run. Before any clause it is the projection (`select` is
      // the one keyword that may be dropped, and only in first position); after
      // any clause it is an error — a predicate is never implicit.
      if (stage === -1 && (this.at("ident") || this.at("binding") || this.at("caret") || this.canStartValue())) {
        enter("select");
        ({ items: select, values } = this.parseProjection());
        continue;
      }
      this.failUnexpectedInBody(stage, orderByAllowed);
    }
    where = this.inlineAliases(select, where);
    return { froms, where, select, orderBy, follow, distinct, values, limit, offset };
  }

  // The error for a token that starts no clause, phrased for the mistake it most
  // likely is: a bare run right after `from` (the old implicit `where`, or a
  // consumer word where a whole-query directive was meant), or a stray token.
  private failUnexpectedInBody(stage: number, orderByAllowed: boolean): never {
    const t = this.peek();
    const remaining = CLAUSE_ORDER.slice(stage + 1).filter((c) => orderByAllowed || c !== "order by").join("/");
    const last = stage >= 0 ? CLAUSE_ORDER[stage] : null;
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

  // ---- alias inlining -------------------------------------------------------
  // `where` may reference the same body's `select` aliases. This is a
  // compile-time rewrite, not a second execution pass: every bare identifier in
  // the where tree that names an alias is replaced by that alias's expression,
  // so the engine and any pushdown planner see an ordinary where over row
  // fields. Rules:
  //   • an alias shadows a same-named row field inside `where`;
  //   • an alias's own name inside its own expression is the row field
  //     (`name: name.upper()` is not recursive), but a chain of aliases that
  //     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
  //   • an alias whose value is a `collect`/`first`/`single { … }` block may
  //     stand alone as a where leaf (a collection in predicate position means
  //     non-empty) but not appear inside an expression;
  //   • nested blocks (consumer bodies, follow blocks) are their own scopes and
  //     are not rewritten against this body's select — each body rewrites
  //     against its own.
  private inlineAliases(select: SelectItem[], where: Where | null): Where | null {
    if (!where || select.length === 0) return where;
    const aliases = new Map<string, SelectItem>();
    for (const it of select) {
      if (it.kind === "collect") aliases.set(it.name, it);
      else if (it.lift === 0 && it.name !== "") aliases.set(it.name, it);
    }
    if (aliases.size === 0) return where;
    const resolving: string[] = [];
    const subst = (e: Expr): Expr => {
      switch (e.kind) {
        case "ident": {
          const a = aliases.get(e.name);
          if (!a) return e;
          if (resolving[resolving.length - 1] === e.name) return e; // its own name inside its own expression: the row field
          if (resolving.includes(e.name)) {
            const cycle = [...resolving.slice(resolving.indexOf(e.name)), e.name].join(" → ");
            this.fail(`select aliases form a cycle: ${cycle} — an alias used in \`where\` cannot depend on itself`);
          }
          if (a.kind === "collect") {
            this.fail(`select alias '${e.name}' is a ${a.op.op} { … } block — in \`where\` it can only stand alone as a non-empty test, not inside an expression`);
          }
          resolving.push(e.name);
          const out = subst(a.expr);
          resolving.pop();
          return out;
        }
        case "member": return { ...e, recv: subst(e.recv) };
        case "index": return { ...e, recv: subst(e.recv), index: subst(e.index) };
        case "call": return { ...e, recv: e.recv ? subst(e.recv) : null, args: e.args.map(subst) };
        case "unary": return { ...e, expr: subst(e.expr) };
        case "binary": case "logical": case "in": return { ...e, left: subst(e.left), right: subst(e.right) };
        case "range": return { ...e, lo: e.lo ? subst(e.lo) : null, hi: e.hi ? subst(e.hi) : null };
        default: return e; // lit, binding, outer (`^name` reads an enclosing row, never an alias)
      }
    };
    const walk = (w: Where): Where => {
      switch (w.kind) {
        case "and": return { kind: "and", parts: w.parts.map(walk) };
        case "or": return { kind: "or", parts: w.parts.map(walk) };
        case "not": return { kind: "not", expr: walk(w.expr) };
        case "scalar": {
          if (w.expr.kind === "ident") {
            const a = aliases.get(w.expr.name);
            if (a?.kind === "collect") return a.op; // a collection in predicate position: non-empty
          }
          return { kind: "scalar", expr: subst(w.expr) };
        }
        case "op": return { ...w, receiver: subst(w.receiver) }; // the receiver is read in this scope; the block is its own scope
      }
    };
    return walk(where);
  }

  private atOrderBy(): boolean {
    const t = this.peek();
    const nx = this.peekAt(1);
    return t.type === "ident" && t.value === "order" && !!nx && nx.type === "ident" && nx.value === "by";
  }

  private atFollow(): boolean {
    if (!this.at("ident", "follow")) return false;
    const nx = this.peekAt(1);
    return !!nx && (nx.type === "ident" || nx.type === "binding");
  }

  // ---- follow ---------------------------------------------------------------
  private parseFollow(): Follow {
    this.next(); // `follow`
    let distinct = false;
    if (this.at("ident", "distinct")) {
      const nx = this.peekAt(1);
      if (nx && (nx.type === "ident" || nx.type === "binding")) { this.next(); distinct = true; }
    }
    const receiver = this.parseReceiver();
    const follow: Follow = { receiver, distinct, where: null, frontier: null, depth: null, by: null };
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
    return follow;
  }

  // A receiver/source: a `${…}` binding, or a dotted identifier navigation chain
  // whose head may be an outer reference (`^rel`, `^^root.rel`) — since a bare
  // name is the current row's own property, an enclosing row's relation or a
  // named root is only reachable as a receiver through `^` — or a free-function
  // call (`entries(prefs)`), so a computed collection can be consumed directly.
  private parseReceiver(): Expr {
    if (this.at("binding")) return { kind: "binding", index: this.next().index! };
    const levels = this.parseCarets();
    if (!this.at("ident")) this.fail("expected a collection navigation (a property/relation name)");
    return this.parseNavFrom(this.next(), levels).expr;
  }

  // Consume a run of `^` and return its length (0 when there is none).
  private parseCarets(): number {
    let levels = 0;
    while (this.at("caret")) { this.next(); levels++; }
    return levels;
  }

  // A dotted navigation chain from `head`; `levels` > 0 makes the head an outer
  // reference read exactly that many scopes out. A bare head followed by `(` is
  // a free-function call (`entries(x)`), which may then be navigated further.
  private parseNavFrom(head: Token, levels = 0): { expr: Expr; name: string } {
    let expr: Expr = levels > 0 ? { kind: "outer", levels, name: head.value } : { kind: "ident", name: head.value };
    let name = head.value;
    if (levels === 0 && this.at("lparen")) expr = { kind: "call", recv: null, name: head.value, args: this.parseArgs() };
    while (this.at("dot")) {
      this.next();
      if (!this.at("ident")) this.fail("expected an identifier after '.' in a navigation");
      name = this.next().value;
      expr = { kind: "member", recv: expr, name };
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
  private parseProjection(): { items: SelectItem[]; values: boolean } {
    const items = [this.parseSelectItem()];
    while (this.at("comma")) { this.next(); items.push(this.parseSelectItem()); }
    let values = false;
    if (this.at("ident", "values")) {
      this.next();
      values = true;
      if (items.length !== 1) this.fail("`values` projects exactly one expression (got " + items.length + ")");
      const only = items[0]!;
      if (only.kind === "field" && only.lift > 0) this.fail("a lift (^name: …) cannot be combined with `values`");
    } else {
      for (const it of items) {
        if (it.name === "") this.fail("a leading expression is a projection (select): an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `where …` — a predicate is never implicit");
      }
    }
    return { items, values };
  }

  private parseSelectItem(): SelectItem {
    // Leading `^`s mark a lift; the count is how many scopes out it binds.
    const lift = this.parseCarets();
    if (this.at("ident") && this.peekAt(1)?.type === "colon") {
      const name = this.next().value;
      this.next(); // ':'
      const op = this.tryOp();
      if (op) {
        if (op.op !== "collect" && op.op !== "first" && op.op !== "single") {
          this.fail(`projection '${name}' must use collect/first/single, not ${op.op} (exists/none/count are where-position tests)`);
        }
        if (lift) this.fail(`a lift (^${name}) value must be a scalar expression, not ${op.op} { … }`);
        return { kind: "collect", name, op };
      }
      const expr = this.parseValueExpr();
      return { kind: "field", name, expr, lift };
    }
    if (!this.at("ident") && !this.canStartValue()) this.fail("expected a projection name");
    // Unaliased item: a bare/dotted navigation keys by its last segment; any
    // other expression is unnamed ("") — legal only under `values` (checked by
    // parseProjection, which sees the whole list).
    const expr = this.parseValueExpr();
    return { kind: "field", name: navKey(expr) ?? "", expr, lift };
  }

  // ---- order by -------------------------------------------------------------
  private parseOrderSpecs(): OrderSpec[] {
    const specs = [this.parseOrderSpec()];
    while (this.at("comma")) { this.next(); specs.push(this.parseOrderSpec()); }
    return specs;
  }

  private parseOrderSpec(): OrderSpec {
    const expr = this.parseValueExpr();
    let desc = false;
    if (this.at("ident", "asc")) this.next();
    else if (this.at("ident", "desc")) { this.next(); desc = true; }
    return { expr, desc };
  }

  // ---- where boolean tree: or → and → not → primary -------------------------
  private parseWhere(): Where { return this.parseWhereOr(); }

  private parseWhereOr(): Where {
    const left = this.parseWhereAnd();
    if (!this.atOp("||")) return left;
    const parts = [left];
    while (this.atOp("||")) { this.next(); parts.push(this.parseWhereAnd()); }
    return { kind: "or", parts };
  }

  private parseWhereAnd(): Where {
    const left = this.parseWhereNot();
    if (!this.atOp("&&")) return left;
    const parts = [left];
    while (this.atOp("&&")) { this.next(); parts.push(this.parseWhereNot()); }
    return { kind: "and", parts };
  }

  private parseWhereNot(): Where {
    if (this.atOp("!")) { this.next(); return { kind: "not", expr: this.parseWhereNot() }; }
    return this.parseWherePrimary();
  }

  private parseWherePrimary(): Where {
    if (this.at("lparen")) {
      this.next();
      const e = this.parseWhere();
      if (!this.at("rparen")) this.fail("expected ')' to close a grouped where expression");
      this.next();
      return e;
    }
    const op = this.tryOp();
    if (op) return this.finishWhereOp(op);
    const expr = this.parseCmp();
    return { kind: "scalar", expr };
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
    }
    return op;
  }

  // Detect + parse a postfix consumer op `<receiver> <consumer> { <sub> }`.
  // Returns null (rewinding) when the lookahead is not a consumer op.
  private tryOp(): OpNode | null {
    const start = this.pos;
    let receiver: Expr;
    if (this.at("binding")) receiver = { kind: "binding", index: this.next().index! };
    else if (this.at("ident") || this.at("caret")) {
      const levels = this.parseCarets();
      if (!this.at("ident")) { this.pos = start; return null; }
      receiver = this.parseNavFrom(this.next(), levels).expr;
    } else return null;

    if (this.at("ident") && CONSUMERS.has(this.peek().value)) {
      const after = this.peekAt(1);
      // `<op> { … }` or `<op> distinct { … }`.
      const opThenBrace = after?.type === "lbrace";
      const opDistinctBrace = after?.type === "ident" && after.value === "distinct" && this.peekAt(2)?.type === "lbrace";
      if (opThenBrace || opDistinctBrace) {
        const op = this.next().value as Consumer;
        let distinct = false;
        if (this.at("ident", "distinct")) { this.next(); distinct = true; }
        this.next(); // '{'
        const { sub, distinct: bodyDistinct } = this.parseSubquery();
        if (!this.at("rbrace")) this.fail(`expected '}' to close the ${op} { … } block`);
        this.next();
        return { kind: "op", receiver, op, sub, distinct: distinct || bodyDistinct };
      }
    }
    this.pos = start;
    return null;
  }

  private parseSubquery(): { sub: Subquery; distinct: boolean } {
    const body = this.parseBody(true);
    return {
      sub: { from: body.froms, where: body.where, select: body.select, orderBy: body.orderBy, follow: body.follow, values: body.values, ...bounds(body) },
      distinct: body.distinct,
    };
  }

  // ---- expression Pratt parser ----------------------------------------------
  // Value position (select/order/follow/source): full boolean+arithmetic.
  private parseValueExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.atOp("||")) { this.next(); left = { kind: "logical", op: "||", left, right: this.parseAnd() }; }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.atOp("&&")) { this.next(); left = { kind: "logical", op: "&&", left, right: this.parseCmp() }; }
    return left;
  }

  // Comparison / membership (also the entry point for a where scalar leaf, so a
  // where leaf never swallows the where-tree's && / ||).
  private parseCmp(): Expr {
    let left = this.parseRange();
    if (this.peek().type === "op" && CMP_OPS.has(this.peek().value)) {
      const op = this.next().value;
      return { kind: "binary", op, left, right: this.parseRange() };
    }
    if (this.at("ident", "in")) { this.next(); return { kind: "in", left, right: this.parseRange() }; }
    return left;
  }

  // Range literal: `lo..hi` / `lo...hi` and the open-ended forms `..hi`, `lo..`.
  // Binds looser than arithmetic (so `1+1..2*3` is the range 2..6) but tighter
  // than comparison / `in` (so `n in 1..5` reads as `n in (1..5)`). A leading
  // `..`/`...` opens the low end; a trailing `..`/`...` with no following value
  // opens the high end.
  private parseRange(): Expr {
    if (this.at("range")) {
      const exclusiveEnd = this.next().value === "...";
      return { kind: "range", lo: null, hi: this.parseAdd(), exclusiveEnd };
    }
    const lo = this.parseAdd();
    if (this.at("range")) {
      const exclusiveEnd = this.next().value === "...";
      const hi = this.canStartValue() ? this.parseAdd() : null;
      return { kind: "range", lo, hi, exclusiveEnd };
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

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.peek().type === "op" && ADD_OPS.has(this.peek().value)) {
      const op = this.next().value;
      left = { kind: "binary", op, left, right: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.peek().type === "op" && MUL_OPS.has(this.peek().value)) {
      const op = this.next().value;
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.atOp("!")) { this.next(); return { kind: "unary", op: "!", expr: this.parseUnary() }; }
    if (this.atOp("-")) { this.next(); return { kind: "unary", op: "-", expr: this.parseUnary() }; }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at("dot")) {
        this.next();
        if (!this.at("ident")) this.fail("expected a property name after '.'");
        const name = this.next().value;
        if (this.at("lparen")) {
          expr = { kind: "call", recv: expr, name, args: this.parseArgs() };
        } else {
          expr = { kind: "member", recv: expr, name };
        }
      } else if (this.at("lparen") && expr.kind === "ident") {
        // free function call: name(args)
        expr = { kind: "call", recv: null, name: expr.name, args: this.parseArgs() };
      } else if (this.at("lbrace")) {
        break; // a consumer block boundary — not part of a value expression
      } else {
        break;
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
      return { kind: "outer", levels, name: this.next().value };
    }
    if (t.type === "number") { this.next(); return { kind: "lit", value: Number(t.value) }; }
    if (t.type === "string") { this.next(); return { kind: "lit", value: t.value }; }
    if (t.type === "binding") { this.next(); return { kind: "binding", index: t.index! }; }
    if (t.type === "lparen") {
      this.next();
      const e = this.parseValueExpr();
      if (!this.at("rparen")) this.fail("expected ')'");
      this.next();
      return e;
    }
    if (t.type === "ident") {
      this.next();
      if (t.value === "true") return { kind: "lit", value: true };
      if (t.value === "false") return { kind: "lit", value: false };
      if (t.value === "null") return { kind: "lit", value: null };
      return { kind: "ident", name: t.value };
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

// The optional `limit`/`offset` fields of a Query/Subquery, present only when set
// (so a Query built without them is unchanged).
function bounds(b: { limit?: Expr | null; offset?: Expr | null }): { limit?: Expr; offset?: Expr } {
  return { ...(b.limit ? { limit: b.limit } : {}), ...(b.offset ? { offset: b.offset } : {}) };
}
