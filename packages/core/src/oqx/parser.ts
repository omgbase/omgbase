// OQX structural parser (slice 2). Parses query STRUCTURE (from/where/select,
// the where-clause boolean tree, and receiver-constrained collection ops) and
// captures scalar predicate/value interiors verbatim as source slices for the
// CEL layer. OQX owns &&/||/!/grouping at the where level so collection ops
// (invisible to CEL) can compose with scalar predicates; each maximal pure-
// scalar leaf is handed to CEL untouched. Throws FilterInvalid (from the CEL
// parser) so MCP/CLI error mapping is uniform.

import { lexOqx, type OqxToken, OqxLexError } from "./lexer.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type {
  SurfaceQuery, SurfaceTarget, SurfaceWhere, SurfaceScalar, SurfaceOp, SurfaceSubquery, SurfaceSelectItem,
} from "./ast.js";
import type { CountRelOp, OqxConsumer, OrderSpec } from "./ir.js";

const RECEIVER_ROOTS = new Set(["nodes", "blocks", "doc", "node", "block", "section", "repo"]);
const OP_NAMES = new Set(["collect", "exists", "count", "first", "single"]);
const TARGETS = new Set(["docs", "blocks", "nodes"]);
const RELOPS = new Set<string>(["==", "!=", "<", "<=", ">", ">="]);
// Top-level consumers wrapping the whole query (`repo.<op>(from …)`); the bare
// `from …` form defaults to `collect`. `all` is reserved but not implemented.
const TOP_CONSUMERS = new Set(["collect", "count", "exists", "first", "single"]);

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

  parseQuery(): SurfaceQuery {
    // Optional top-level consumer wrapper: `repo.<op>( <query> )`. At the very
    // start `repo.` can only be a consumer (a query must otherwise begin with
    // `from`; the `repo.<target>` ROOT RELATION only appears as a receiver
    // inside where/select), so there is no ambiguity.
    const consumer = this.tryParseTopConsumer();
    const q = this.parseFromQuery(consumer !== null);
    if (consumer) {
      q.consumer = consumer;
      if (!this.at("rparen")) this.fail(`expected ')' to close repo.${consumer}(...)`);
      this.next();
    }
    if (!this.at("eof")) this.fail(`unexpected '${this.peek().value || this.peek().type}' after the query`);
    return q;
  }

  // Detect + open a top-level consumer wrapper, consuming `repo . <op> (` and
  // returning the consumer. Returns null (without consuming) when the source
  // does not start with `repo`.
  private tryParseTopConsumer(): OqxConsumer | null {
    if (!this.at("ident", "repo")) return null;
    this.next(); // repo
    if (!this.at("dot")) this.fail("expected `.<consumer>(...)` after a top-level `repo`");
    this.next();
    if (!this.at("ident")) this.fail("expected a consumer name after `repo.`");
    const op = this.next().value;
    if (op === "all") this.fail("`all` is a reserved top-level consumer but is not implemented yet");
    if (!TOP_CONSUMERS.has(op)) {
      this.fail(`unknown top-level consumer 'repo.${op}' — use collect/count/exists/first/single`);
    }
    if (!this.at("lparen")) this.fail(`expected '(' after 'repo.${op}'`);
    this.next();
    return op as OqxConsumer;
  }

  // Parse the `from … [where …] [select …]` query body. When `wrapped`, the
  // body is enclosed in a consumer's parens, so it also terminates at `)`.
  private parseFromQuery(wrapped: boolean): SurfaceQuery {
    if (!this.at("kw", "from")) this.fail("OQX query must start with `from`");
    this.next();
    const t = this.next();
    if (t.type !== "ident" && !(t.type === "kw")) this.fail("expected a target after `from`");
    const from = t.value as SurfaceTarget;
    if (!TARGETS.has(from)) this.fail(`unknown target '${t.value}' — use docs|blocks|nodes`);

    const q: SurfaceQuery = { from, where: null, select: [] };
    let sawWhere = false;
    let sawSelect = false;
    let sawOrder = false;
    while (!this.at("eof") && !(wrapped && this.at("rparen"))) {
      if (this.at("kw", "where")) {
        if (sawWhere) this.fail("duplicate `where` clause");
        sawWhere = true;
        this.next();
        q.where = this.parseWhereExpr();
      } else if (this.at("kw", "select")) {
        if (sawSelect) this.fail("duplicate `select` clause");
        sawSelect = true;
        this.next();
        q.select = this.parseSelectItems();
      } else if (this.atOrderBy()) {
        if (sawOrder) this.fail("duplicate `order by` clause");
        sawOrder = true;
        this.next(); this.next(); // `order` `by`
        q.orderBy = this.parseOrderSpecs();
      } else {
        this.fail(`unexpected '${this.peek().value || this.peek().type}' — expected where/select/order by`);
      }
    }
    return q;
  }

  // `order` and `by` are NOT reserved keywords — only the adjacent pair marks the
  // clause, so `order` stays usable as an ordinary field name elsewhere.
  private atOrderBy(): boolean {
    const t = this.peek();
    const nx = this.tokens[this.pos + 1];
    return t.type === "ident" && t.value === "order" && !!nx && nx.type === "ident" && nx.value === "by";
  }

  // order := spec { "," spec };  spec := <valueExpr> [asc | desc]  (default asc)
  private parseOrderSpecs(): OrderSpec[] {
    const specs = [this.parseOrderSpec()];
    while (this.at("comma")) { this.next(); specs.push(this.parseOrderSpec()); }
    return specs;
  }

  private parseOrderSpec(): OrderSpec {
    // Capture the value expression up to a comma / clause boundary, then peel a
    // trailing asc|desc word (requires preceding whitespace, so a field like
    // `foo_desc` or a string ending in "asc" is unaffected).
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
  // Leaves are scalar runs or collection ops; OQX owns &&/||/!/grouping.
  private parseWhereExpr(): SurfaceWhere {
    return this.parseOr();
  }

  private parseOr(): SurfaceWhere {
    let left = this.parseAnd();
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

  // `count(...) <op> <int>` in where position (only count is comparable; other
  // ops rejected in lower.ts). A bare op with no trailing comparison is left as
  // truthiness (non-empty).
  private maybeCountCmp(op: SurfaceOp): SurfaceOp {
    if (this.peek().type === "op" && RELOPS.has(this.peek().value)) {
      const relop = this.next().value as CountRelOp;
      if (!this.at("number")) this.fail(`expected an integer after '${op.receiver}.${op.op}(...) ${relop}'`);
      const numTok = this.next();
      const value = Number(numTok.value);
      if (!Number.isInteger(value)) this.fail(`count comparison takes an integer, got '${numTok.value}'`);
      op.countCmp = { op: relop, value };
    }
    return op;
  }

  // Detect + parse `<receiver>.<op>( <subquery> )`. Returns null (without
  // consuming) if the lookahead is not an op call.
  private tryParseOp(): SurfaceOp | null {
    const start = this.pos;
    if (!this.at("ident") || !RECEIVER_ROOTS.has(this.peek().value)) return null;
    // scan a dotted ident chain
    const segments: string[] = [this.next().value];
    while (this.at("dot")) {
      this.next();
      if (!this.at("ident")) { this.pos = start; return null; }
      segments.push(this.next().value);
    }
    // must be `... op (`
    const opName = segments[segments.length - 1]!;
    if (segments.length < 2 || !OP_NAMES.has(opName) || !this.at("lparen")) {
      this.pos = start; // not an op call — rewind, treat as scalar
      return null;
    }
    const receiver = segments.slice(0, -1).join(".");
    this.next(); // consume '('
    const sub = this.parseSubquery();
    if (!this.at("rparen")) this.fail(`expected ')' to close ${receiver}.${opName}(...)`);
    this.next();
    return { kind: "op", receiver, op: opName as SurfaceOp["op"], sub };
  }

  // Nested query body: `where <expr>` and a projection, in any order. The
  // projection is either the explicit `select <items>` form or a keyword-less
  // run of leading `^lift:` items (the canonical lift form
  // `collect(^open: value where P)`).
  private parseSubquery(): SurfaceSubquery {
    const sub: SurfaceSubquery = { where: null, select: [] };
    let sawWhere = false;
    let sawSelect = false;
    while (!this.at("rparen") && !this.at("eof")) {
      if (this.at("kw", "where")) {
        if (sawWhere) this.fail("duplicate `where` in nested query");
        sawWhere = true;
        this.next();
        sub.where = this.parseWhereExpr();
      } else if (this.at("kw", "select")) {
        if (sawSelect) this.fail("duplicate projection in nested query");
        sawSelect = true;
        this.next();
        sub.select = this.parseSelectItems();
      } else if (this.at("caret")) {
        // Keyword-less lift items leading the collect body.
        if (sawSelect) this.fail("duplicate projection in nested query");
        sawSelect = true;
        sub.select = this.parseSelectItems();
      } else {
        this.fail(`unexpected '${this.peek().value || this.peek().type}' in nested query — expected where/select or a ^lift`);
      }
    }
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
      // named projection: either a nested collect op, or a scalar value expr.
      const op = this.tryParseOp();
      if (op) {
        if (op.op !== "collect" && op.op !== "first" && op.op !== "single") {
          this.fail(`select projection '${name}' must use collect(...)/first(...)/single(...), not ${op.op}(...)`);
        }
        if (lift) this.fail(`a lift (^${name}) value must be a scalar expression, not ${op.op}(...)`);
        return { kind: "collect", name, op };
      }
      const source = this.captureScalarUntilSelectBoundary();
      if (!source) this.fail(`projection '${name}' has no value expression`);
      return lift ? { kind: "field", name, source, lift } : { kind: "field", name, source };
    }
    // bare field passthrough: `path`, `kind`, `$path`, `^value`, …
    const bareName = nameTok.value;
    return lift ? { kind: "field", name: bareName, source: bareName, lift } : { kind: "field", name: bareName, source: bareName };
  }

  // A scalar leaf: a maximal verbatim run up to the next depth-0 boolean
  // boundary (`&&`, `||`), a where/select keyword, a ')', or eof.
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
  // a scalar leaf never contains those at depth 0.
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
        if (t.type === "kw" && (t.value === "where" || t.value === "select")) break;
        // a trailing `order by` clause ends a where-leaf or select value.
        if (t.type === "ident" && t.value === "order") {
          const nx = this.tokens[this.pos + 1];
          if (nx && nx.type === "ident" && nx.value === "by") break;
        }
        if (t.type === "rparen") break;
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
