// OQX structural parser. Parses query STRUCTURE (the `from` source-projection
// chain, where/select, the where-clause boolean tree, and postfix consumer
// directives) and captures scalar predicate/value interiors verbatim as source
// slices for the CEL layer. Two design-kernel rules (see the syntax-refresh
// note): dot navigation belongs to the host object model (a receiver/source is a
// dotted identifier chain), and whitespace directives (collect/exists/count/
// first/single) belong to OQX (`<receiver> <op> { <block> }`, never a method).
// OQX owns &&/||/!/grouping at the where level so consumer ops (invisible to CEL)
// can compose with scalar predicates; each maximal pure-scalar leaf is handed to
// CEL untouched. Throws FilterInvalid (from the CEL parser) so MCP/CLI error
// mapping is uniform.

import { lexOqx, type OqxToken, OqxLexError } from "./lexer.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type {
  SurfaceQuery, SurfaceWhere, SurfaceScalar, SurfaceOp, SurfaceSubquery, SurfaceSelectItem, SurfaceFollow,
} from "./ast.js";
import type { CountRelOp, OqxConsumer, OrderSpec } from "./ir.js";

const OP_NAMES = new Set(["collect", "exists", "count", "first", "single"]);
const RELOPS = new Set<string>(["==", "!=", "<", "<=", ">", ">="]);
// Reserved consumer directives; `all` is reserved but not implemented.
const CONSUMERS = new Set(["collect", "exists", "count", "first", "single", "all"]);

export function parseOqx(src: string): SurfaceQuery {
  let tokens: OqxToken[];
  try {
    tokens = lexOqx(src);
  } catch (e) {
    throw new FilterInvalid(e instanceof OqxLexError ? e.message : String(e), "OQX §1");
  }
  return new OqxParser(src, tokens).parseQuery();
}

class OqxParser {
  private pos = 0;
  constructor(private src: string, private tokens: OqxToken[]) {}

  private peek(): OqxToken { return this.tokens[this.pos]!; }
  private peekAt(n: number): OqxToken | undefined { return this.tokens[this.pos + n]; }
  private next(): OqxToken { return this.tokens[this.pos++]!; }
  private at(type: string, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private atOp(value: string): boolean {
    const t = this.peek();
    return t.type === "op" && t.value === value;
  }
  private fail(msg: string): never {
    throw new FilterInvalid(msg, "OQX §1");
  }

  // Top level is EITHER the bare source form (`from <E> …`, consumer defaults to
  // `collect`) OR the consumer form (`<receiver> <op> { … }`). The bare form
  // begins with `from`; the consumer form begins with a navigation receiver.
  parseQuery(): SurfaceQuery {
    if (this.at("kw", "from")) {
      const body = this.parseBody(/* orderByAllowed */ true);
      if (!this.at("eof")) this.fail(`unexpected '${this.peek().value || this.peek().type}' after the query`);
      if (body.from.length === 0) this.fail("OQX query must start with `from`");
      return { from: body.from, where: body.where, select: body.select, consumer: "collect", ...(body.orderBy ? { orderBy: body.orderBy } : {}), ...(body.follow ? { follow: body.follow } : {}) };
    }
    // Consumer form: <receiver> <op> { <body> }.
    if (!this.at("ident")) this.fail("OQX query must start with `from` or a `<receiver> <consumer> { … }` directive");
    const receiver = this.parseNavExpr();
    const op = this.parseConsumerKeyword();
    if (!this.at("lbrace")) this.fail(`expected '{' after the top-level '${op}' directive`);
    this.next();
    const body = this.parseBody(/* orderByAllowed */ true);
    if (!this.at("rbrace")) this.fail(`expected '}' to close the top-level '${op} { … }' block`);
    this.next();
    if (!this.at("eof")) this.fail(`unexpected '${this.peek().value || this.peek().type}' after the query`);
    return {
      from: [receiver, ...body.from], where: body.where, select: body.select, consumer: op,
      ...(body.orderBy ? { orderBy: body.orderBy } : {}), ...(body.follow ? { follow: body.follow } : {}),
    };
  }

  // Consume a reserved consumer directive keyword (`collect`/`exists`/…).
  private parseConsumerKeyword(): OqxConsumer {
    if (!this.at("ident")) this.fail("expected a query consumer (collect/exists/count/first/single)");
    const op = this.peek().value;
    if (op === "all") this.fail("`all` is a reserved consumer but is not implemented yet");
    if (!CONSUMERS.has(op)) this.fail(`unknown consumer '${op}' — use collect/exists/count/first/single`);
    this.next();
    return op as OqxConsumer;
  }

  // A navigation expression: a dotted identifier chain (host-model navigation),
  // captured verbatim (dots = host navigation; the query directive that follows
  // is whitespace-separated). Legacy dotted-consumer syntax (`nodes.collect(`)
  // is detected here and rejected with a migration hint.
  private parseNavExpr(): string {
    if (!this.at("ident")) this.fail("expected a navigation expression (a relation/property name)");
    const segments = [this.next().value];
    while (this.at("dot")) {
      this.next();
      if (!this.at("ident")) this.fail("expected an identifier after '.' in a navigation expression");
      segments.push(this.next().value);
    }
    // Legacy syntax guard: `<recv>.<consumer>(…)` was the old method form.
    const last = segments[segments.length - 1]!;
    if (segments.length >= 2 && OP_NAMES.has(last) && this.at("lparen")) {
      const recv = segments.slice(0, -1).join(".");
      this.fail(`OQX query consumers are postfix directives, not methods. Use \`${recv} ${last} { … }\`.`);
    }
    return segments.join(".");
  }

  // Parse a query body: an optional leading `from` source-projection chain, then
  // where/select/(order by)/(follow), in that spirit. `follow` is TERMINAL. The
  // loop stops at eof or a closing '}' (a consumer/top block boundary).
  private parseBody(orderByAllowed: boolean): {
    from: string[]; where: SurfaceWhere | null; select: SurfaceSelectItem[]; orderBy?: OrderSpec[]; follow?: SurfaceFollow;
  } {
    const from: string[] = [];
    let where: SurfaceWhere | null = null;
    let select: SurfaceSelectItem[] = [];
    let orderBy: OrderSpec[] | undefined;
    let follow: SurfaceFollow | undefined;
    let sawWhere = false, sawSelect = false, sawOrder = false, sawNonFrom = false;

    while (!this.at("eof") && !this.at("rbrace")) {
      if (this.atFollow()) {
        follow = this.parseFollowClause();
        break; // follow is terminal (it consumes its own sub-clauses)
      } else if (this.at("kw", "from")) {
        if (sawNonFrom) this.fail("`from` source projections must precede where/select/order by/follow");
        this.next();
        from.push(this.parseNavExpr());
      } else if (this.at("kw", "where")) {
        if (sawWhere) this.fail("duplicate `where` clause");
        sawWhere = true; sawNonFrom = true;
        this.next();
        where = this.parseWhereExpr();
      } else if (this.at("kw", "select")) {
        if (sawSelect) this.fail("duplicate `select` clause");
        sawSelect = true; sawNonFrom = true;
        this.next();
        select = this.parseSelectItems();
      } else if (this.at("caret")) {
        // Keyword-less lift items (leading `^name:` in a where-position collect
        // body) — a projection without the `select` keyword.
        if (sawSelect) this.fail("duplicate projection");
        sawSelect = true; sawNonFrom = true;
        select = this.parseSelectItems();
      } else if (orderByAllowed && this.atOrderBy()) {
        if (sawOrder) this.fail("duplicate `order by` clause");
        sawOrder = true; sawNonFrom = true;
        this.next(); this.next(); // `order` `by`
        orderBy = this.parseOrderSpecs();
      } else if (this.looksLikePredicate()) {
        // Implicit `where`: a leading predicate-shaped expression (comparison /
        // logical / membership / negation / grouping) may omit the keyword.
        if (sawWhere) this.fail("duplicate `where` clause (an implicit predicate cannot follow a `where`)");
        sawWhere = true; sawNonFrom = true;
        where = this.parseWhereExpr();
      } else if (this.at("ident") || this.at("field")) {
        // Implicit `select`: a leading reference / record-shaped expression (a
        // bare property/navigation or `name: value` list) may omit the keyword.
        // A bare reference is NEVER inferred as a predicate (`active` projects,
        // it does not filter — use `where active` or `active == true`).
        if (sawSelect) this.fail("duplicate projection (an implicit select cannot follow a `select`)");
        sawSelect = true; sawNonFrom = true;
        select = this.parseSelectItems();
      } else {
        this.fail(`unexpected '${this.peek().value || this.peek().type}' — expected from/where/select${orderByAllowed ? "/order by" : ""}/follow`);
      }
    }
    return { from, where, select, ...(orderBy ? { orderBy } : {}), ...(follow ? { follow } : {}) };
  }

  // Decide, by SYNTACTIC SHAPE only (never runtime type), whether the leading
  // unkeyworded expression in a query body is a predicate (→ implicit `where`)
  // rather than a projection (→ implicit `select`). Predicate-shaped = a leading
  // unary `!`/grouping, or a depth-0 comparison / `&&` / `||` / `in` membership.
  // A depth-0 `colon` (a `name: value` projection item) or `comma` (a projection
  // list) marks a projection before any such operator; a bare property/nav with
  // no operator is a projection. This keeps the decision local (no type lookup).
  private looksLikePredicate(): boolean {
    if (this.at("op")) return true;      // a leading unary `!` (or a stray operator)
    if (this.at("lparen")) return true;  // a grouped boolean expression
    const CMP = new Set(["==", "!=", "<", "<=", ">", ">=", "||"]);
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.type === "eof" || t.type === "rbrace") break;
      if (depth === 0) {
        if (t.type === "colon" || t.type === "comma") return false; // a projection item/list
        if (t.type === "kw") break;                                 // where/select/from boundary
        if (t.type === "and") return true;                          // &&
        if (t.type === "op" && CMP.has(t.value)) return true;
        if (t.type === "ident" && t.value === "in") return true;    // membership
        // a trailing `order by` / `follow` clause ends the run (see captureScalar)
        if (t.type === "ident" && (t.value === "order" || t.value === "follow")) {
          const nx = this.tokens[i + 1];
          if (nx && nx.type === "ident") break;
        }
      }
      if (t.type === "lparen") depth++;
      else if (t.type === "rparen") { if (depth === 0) break; depth--; }
    }
    return false;
  }

  // `follow` is a contextual keyword (an ordinary ident elsewhere); it marks the
  // recursive clause only in clause position (`follow <receiver>`).
  private atFollow(): boolean {
    if (!this.at("ident", "follow")) return false;
    const nx = this.peekAt(1);
    return !!nx && (nx.type === "ident");
  }

  // follow := "follow" ["distinct"] <receiver> [ "{" followBody "}" ].  The
  // optional brace body holds where/frontier/depth/by sub-clauses (contextual
  // keywords); predicate interiors are captured verbatim (full CEL). A bare
  // `follow <receiver>` (no braces) carries no sub-clauses.
  private parseFollowClause(): SurfaceFollow {
    this.next(); // `follow`
    let distinct = false;
    if (this.at("ident", "distinct")) { this.next(); distinct = true; }
    const receiver = this.parseNavExpr();
    const follow: SurfaceFollow = { distinct, receiver, where: null, frontier: null, depth: null, by: null, via: null };
    if (!this.at("lbrace")) return follow; // bare follow, no sub-clauses
    this.next(); // '{'
    while (!this.at("eof") && !this.at("rbrace")) {
      if (this.at("kw", "where")) {
        if (follow.where !== null) this.fail("duplicate `where` in follow clause");
        this.next();
        const src = this.captureFollowExpr();
        if (!src) this.fail("expected a successor predicate after `follow … { where`");
        follow.where = src;
      } else if (this.at("ident", "by")) {
        if (follow.by !== null) this.fail("duplicate `by` in follow clause");
        this.next();
        const src = this.captureFollowExpr();
        if (!src) this.fail("expected an identity expression after `by`");
        follow.by = src;
      } else if (this.at("ident", "via")) {
        if (follow.via !== null) this.fail("duplicate `via` in follow clause");
        this.next();
        const src = this.captureFollowExpr();
        if (!src) this.fail("expected an edge predicate after `via`");
        follow.via = src;
      } else if (this.at("ident", "frontier")) {
        if (follow.frontier !== null) this.fail("duplicate `frontier` in follow clause");
        this.next();
        const src = this.captureFollowExpr();
        if (!src) this.fail("expected a boundary predicate after `frontier`");
        follow.frontier = src;
      } else if (this.at("ident", "depth")) {
        if (follow.depth !== null) this.fail("duplicate `depth` in follow clause");
        this.next();
        if (!this.at("number")) this.fail("expected an integer after `depth`");
        const numTok = this.next();
        const value = Number(numTok.value);
        if (!Number.isInteger(value) || value < 1 || value > 8) {
          this.fail(`follow depth must be an integer between 1 and 8, got '${numTok.value}'`);
        }
        follow.depth = value;
      } else {
        this.fail(`unexpected '${this.peek().value || this.peek().type}' in follow block — expected where/frontier/depth/by/via`);
      }
    }
    if (!this.at("rbrace")) this.fail("expected '}' to close the follow block");
    this.next();
    return follow;
  }

  // Capture a follow successor/boundary predicate verbatim: a maximal run up to
  // the next follow sub-clause keyword (`frontier`/`depth`/`by`) at depth 0, a
  // '}', or eof — tracking paren depth so the predicate's own parens don't end
  // it. Unlike a where-leaf, &&/|| do NOT end it: the whole boolean expression is
  // handed to CEL as one scalar (follow predicates carry no OQX consumer ops).
  private captureFollowExpr(): string {
    const startOff = this.peek().pos;
    let depth = 0;
    let endOff = startOff;
    while (!this.at("eof")) {
      const t = this.peek();
      if (depth === 0) {
        if (t.type === "rbrace") break;
        if (t.type === "ident" && (t.value === "frontier" || t.value === "depth" || t.value === "by" || t.value === "via")) break;
        // a keyword (a second `where`, or a stray select/from) ends the run — it
        // cannot appear inside a CEL scalar, so it marks the next sub-clause.
        if (t.type === "kw") break;
      }
      if (t.type === "lparen") depth++;
      else if (t.type === "rparen") depth--;
      endOff = t.pos + t.value.length;
      this.next();
    }
    return this.src.slice(startOff, endOff).trim();
  }

  // `order` and `by` are NOT reserved keywords — only the adjacent pair marks the
  // clause, so `order` stays usable as an ordinary field name elsewhere.
  private atOrderBy(): boolean {
    const t = this.peek();
    const nx = this.peekAt(1);
    return t.type === "ident" && t.value === "order" && !!nx && nx.type === "ident" && nx.value === "by";
  }

  // order := spec { "," spec };  spec := <valueExpr> [asc | desc]  (default asc)
  private parseOrderSpecs(): OrderSpec[] {
    const specs = [this.parseOrderSpec()];
    while (this.at("comma")) { this.next(); specs.push(this.parseOrderSpec()); }
    return specs;
  }

  private parseOrderSpec(): OrderSpec {
    const raw = this.captureScalarUntilSelectBoundary();
    if (!raw) this.fail("expected an order expression after `order by`");
    const m = /\s+(asc|desc)$/i.exec(raw);
    if (m) {
      const source = raw.slice(0, m.index).trim();
      if (!source) this.fail("order expression is only a direction; expected `<expr> asc|desc`");
      return { source, desc: m[1]!.toLowerCase() === "desc" };
    }
    return { source: raw, desc: false };
  }

  // ---- where boolean tree: or → and → unary(!) → primary --------------------
  // Leaves are scalar runs or consumer ops; OQX owns &&/||/!/grouping.
  private parseWhereExpr(): SurfaceWhere {
    return this.parseOr();
  }

  private parseOr(): SurfaceWhere {
    const left = this.parseAnd();
    if (!this.atOp("||")) return left;
    const parts: SurfaceWhere[] = [left];
    while (this.atOp("||")) {
      this.next();
      parts.push(this.parseAnd());
    }
    return { kind: "or", parts };
  }

  private parseAnd(): SurfaceWhere {
    const left = this.parseUnary();
    if (!this.at("and")) return left;
    const parts: SurfaceWhere[] = [left];
    while (this.at("and")) {
      this.next();
      parts.push(this.parseUnary());
    }
    return { kind: "and", parts };
  }

  private parseUnary(): SurfaceWhere {
    if (this.atOp("!")) {
      this.next();
      return { kind: "not", expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): SurfaceWhere {
    // Grouping: OQX owns parens at the where level (so a grouped mix of scalars
    // and ops parses uniformly). A purely-scalar group re-compiles identically.
    if (this.at("lparen")) {
      this.next();
      const e = this.parseWhereExpr();
      if (!this.at("rparen")) this.fail("expected ')' to close a grouped where expression");
      this.next();
      return e;
    }
    const op = this.tryParseOp();
    if (op) return this.maybeCountCmp(op);
    return this.parseScalarLeaf();
  }

  // `count { … } <op> <int>` in where position (only count is comparable; other
  // ops rejected in lower.ts). A bare op with no trailing comparison is left as
  // truthiness (non-empty).
  private maybeCountCmp(op: SurfaceOp): SurfaceOp {
    if (this.peek().type === "op" && RELOPS.has(this.peek().value)) {
      const relop = this.next().value as CountRelOp;
      if (!this.at("number")) this.fail(`expected an integer after '${op.receiver} ${op.op} { … } ${relop}'`);
      const numTok = this.next();
      const value = Number(numTok.value);
      if (!Number.isInteger(value)) this.fail(`count comparison takes an integer, got '${numTok.value}'`);
      op.countCmp = { op: relop, value };
    }
    return op;
  }

  // Detect + parse a postfix consumer op: `<navExpr> <consumer> { <subquery> }`.
  // Returns null (without consuming) when the lookahead is not a consumer op —
  // e.g. a scalar reach-through (`doc.layer == "canon"`) or a bare field.
  private tryParseOp(): SurfaceOp | null {
    if (!this.at("ident")) return null;
    const start = this.pos;
    const receiver = this.parseNavExpr();
    // A consumer op is `<receiver> <consumer-keyword> {`.
    if (
      this.at("ident") && OP_NAMES.has(this.peek().value) &&
      this.peekAt(1)?.type === "lbrace"
    ) {
      const opName = this.next().value;
      this.next(); // '{'
      const sub = this.parseSubquery();
      if (!this.at("rbrace")) this.fail(`expected '}' to close ${receiver} ${opName} { … }`);
      this.next();
      return { kind: "op", receiver, op: opName as SurfaceOp["op"], sub };
    }
    // Not a consumer op — rewind and let the caller treat it as a scalar.
    this.pos = start;
    return null;
  }

  // A consumer block body: an optional leading `from` chain, an optional `where`,
  // and a projection (explicit `select …` or a keyword-less run of `^lift:`
  // items). Terminated by the closing '}'.
  private parseSubquery(): SurfaceSubquery {
    const body = this.parseBody(/* orderByAllowed */ false);
    const sub: SurfaceSubquery = { from: body.from, where: body.where, select: body.select };
    if (body.follow) sub.follow = body.follow;
    return sub;
  }

  // select := item { "," item };  item := ident | ident ":" (op | scalar)
  private parseSelectItems(): SurfaceSelectItem[] {
    const items: SurfaceSelectItem[] = [this.parseSelectItem()];
    while (this.at("comma")) {
      this.next();
      items.push(this.parseSelectItem());
    }
    return items;
  }

  private parseSelectItem(): SurfaceSelectItem {
    // A leading `^` marks a one-scope lift (`^name: expr`) — only meaningful in
    // a where-position collect's body; enforced during lowering.
    let lift = false;
    if (this.at("caret")) { this.next(); lift = true; }
    if (!this.at("ident") && !this.at("field")) this.fail("expected a projection name/field");
    const nameTok = this.next();
    if (this.at("colon")) {
      this.next();
      const name = nameTok.value;
      // named projection: either a nested consumer op, or a scalar value expr.
      const op = this.tryParseOp();
      if (op) {
        if (op.op !== "collect" && op.op !== "first" && op.op !== "single") {
          this.fail(`select projection '${name}' must use collect { … }/first { … }/single { … }, not ${op.op}`);
        }
        if (lift) this.fail(`a lift (^${name}) value must be a scalar expression, not ${op.op} { … }`);
        return { kind: "collect", name, op };
      }
      const source = this.captureScalarUntilSelectBoundary();
      if (!source) this.fail(`projection '${name}' has no value expression`);
      return lift ? { kind: "field", name, source, lift } : { kind: "field", name, source };
    }
    // bare projection: a single field (`path`, `kind`, `$path`, `^value`) OR a
    // dotted navigation (`attrs.text`, `doc.layer`) — the projected key defaults
    // to the LAST segment (`attrs.text` → key `text`; alias with `name: expr`).
    if (this.at("dot")) {
      const segments = [nameTok.value];
      while (this.at("dot")) {
        this.next();
        if (!this.at("ident") && !this.at("field")) this.fail("expected an identifier after '.' in a projection");
        segments.push(this.next().value);
      }
      const source = segments.join(".");
      const name = segments[segments.length - 1]!;
      return lift ? { kind: "field", name, source, lift } : { kind: "field", name, source };
    }
    const bareName = nameTok.value;
    return lift ? { kind: "field", name: bareName, source: bareName, lift } : { kind: "field", name: bareName, source: bareName };
  }

  // A scalar leaf: a maximal verbatim run up to the next depth-0 boolean
  // boundary (`&&`, `||`), a where/select keyword, a ')', a '}', or eof.
  private parseScalarLeaf(): SurfaceScalar {
    const source = this.captureScalarUntilTermBoundary();
    if (!source) this.fail(`unexpected '${this.peek().value || this.peek().type}' in where — expected a predicate`);
    return { kind: "scalar", source };
  }

  private captureScalarUntilTermBoundary(): string {
    return this.captureScalar(/* stopOnComma */ false);
  }
  private captureScalarUntilSelectBoundary(): string {
    return this.captureScalar(/* stopOnComma */ true);
  }

  // Slice raw source from the current token to the stopping token, tracking
  // paren depth so structural chars inside a scalar (e.g. f(a, b), "a && b")
  // don't end the run prematurely. OQX owns depth-0 && / || / ! / grouping, so
  // a scalar leaf never contains those at depth 0; consumer blocks own '{'/'}'.
  private captureScalar(stopOnComma: boolean): string {
    const startTok = this.peek();
    const startOff = startTok.pos;
    let depth = 0;
    let endOff = startOff;
    while (!this.at("eof")) {
      const t = this.peek();
      if (depth === 0) {
        if (t.type === "and") break;
        if (t.type === "op" && (t.value === "||" || t.value === "!")) break;
        if (t.type === "kw") break; // from/where/select cannot appear inside a scalar
        // a trailing `order by` clause ends a where-leaf or select value.
        if (t.type === "ident" && t.value === "order") {
          const nx = this.peekAt(1);
          if (nx && nx.type === "ident" && nx.value === "by") break;
        }
        // a trailing `follow` clause likewise ends a where-leaf / select value /
        // order expression — but only in CLAUSE position (`follow <receiver>`),
        // i.e. when the next token is an ident. This keeps `follow`/`depth`/
        // `frontier` usable as ordinary field names as operands.
        if (t.type === "ident" && t.value === "follow") {
          const nx = this.peekAt(1);
          if (nx && nx.type === "ident") break;
        }
        if (t.type === "rparen" || t.type === "lbrace" || t.type === "rbrace") break;
        if (stopOnComma && t.type === "comma") break;
      }
      if (t.type === "lparen") depth++;
      else if (t.type === "rparen") depth--;
      // advance; record end as the offset just past this token's value
      endOff = t.pos + t.value.length;
      this.next();
    }
    return this.src.slice(startOff, endOff).trim();
  }
}
