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
//   flatten <expr> [{…}] [as <name>] …  group by …  having …  order by …  limit N  offset N
//
// A `follow` destination is a relation of the current row (a receiver, never
// an outer reference) or a destination block — a receiver (which MAY be an
// outer reference, `^people`, or a tuple `(a, b)`) followed by `{ body }`, or
// by `collect`/`first`/`single` [`distinct`] `{ body }`, exactly the
// select-position directive `tryOp` recognizes, re-evaluated per frontier row.
// Since 0.20 there is no options block: a brace after ANY destination opens
// that destination's block, whose body admits two clauses no other block has —
// `frontier P` and `depth n`, in the clause order after `where`.
//
// A query names its source BEFORE its body (0.26, the collection-scoped form):
// `<collection> [<consumer>] [distinct] { body }` — the receiver supplies the
// rows, so the body never names its source and its `from` is the re-projection
// (a flatMap). The clause form `select … from S …` is still read as the same
// tree (its top-level body needs `from`); the printer never writes it. Only
// `select` may drop its keyword, and only when it is the first clause written
// (`people { name, age }`); every other clause always carries its keyword. A
// body with a receiver may instead lead with a predicate (since 0.17): a
// leading expression that is syntactically a predicate — not a bare name, a
// dotted navigation or a lift — opens a `where`-first body (`people { age > 50
// }`, `people exists { age > 50 }`); at the clause form's top level a leading
// predicate is still an error, since `where` would precede `from`. An
// out-of-order clause is a parse error naming the order.
//
// Two 0.26 shapes desugar HERE as well: a consumer word with no block is the
// directive over the empty block (`jobs first` ≡ `jobs first { }`, `jobs count
// > 1`, `_nodes exists`; a consumer word right after a complete receiver can be
// nothing else), and a projection-only block over a `collect`/`first`/`single`
// directive whose block projects nothing is that directive's projection
// (`jobs[0] { name }` ≡ `jobs first { name offset 0 }`, `mergeProjectionBlock`).
//
// Sugar (0.17) desugars HERE, to existing nodes: `x { … }` is `x collect { … }`
// wherever a value stands (a select item, a where leaf, a follow destination, a
// call argument — since 0.20 without exception) and `x distinct { … }` is
// `x collect distinct { … }` (0.20); `x[p]` is `x first { where p }`, `x[n]` is `x first { offset n }`, with a
// trailing `!` making the first a `single` (predicate) or a `required` (index);
// `is x` is `!!x`, `not x` is `!x`. Two shapes are new: the postfix `required`
// (`x!`, tightest) and the identity operators `is` / `is not` (comparison
// level). A directive may stand in value position (`jobs first { }.pay`), which
// is how the canonical printer writes a bracket chain back. `where` may reference the same
// body's `select` aliases: the parser VALIDATES those references (a cycle or a
// block alias inside an expression is a parse error) but keeps the surface
// form; `resolveAliases` (resolve.ts) substitutes them before evaluation.
//
// Absolute scope references (0.18) desugar HERE too: `N^name` — an unsigned
// integer literal immediately followed by `^` — is the `outer` reference (or the
// lift) reaching scope N, i.e. `levels = depth − N`, where `depth` is the
// syntactic scope depth of the position being parsed (SEMANTICS §2: the root is
// 0, a top-level row 1, a block's body one deeper than its receiver, a follow
// `where` one deeper than the frontier row). The parser tracks that depth
// (`this.depth`) exactly as the `visit` walk computes it; `N >= depth` is a
// parse error. There is no new node: `print` writes the carets back.
//
// Every node carries its `span` — `[start, end)` in code points over the raw
// source, from the first token that produced it to the end of the last; a
// parenthesized operand's span includes its parentheses (spec/oqx/AST.md).
//
// Tuples (0.20): `(e1, e2, …)` with two or more elements is a `tuple` node — a
// value and a receiver; one expression in parentheses stays grouping.
//
// Template literals (0.21): `` `text ${expr} text` `` is a `template` node — a
// primary value whose interpolations are full expressions read at the current
// depth (`parseTemplateLiteral`); the lexer balances the braces, so an
// interpolation may hold a `{ … }` block or another template literal.
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
  BinaryOp, Span, TemplatePart, Flatten, GroupBy, GroupKey, AggregateName,
} from "./ast.ts";
import { AGGREGATE_NAMES, isAggregateName } from "./ast.ts";
import { readKeys, resolveRowClauses, resolveSelect, resolveWhere } from "./resolve.ts";
import { visit } from "./walk.ts";
import { printTemplate } from "./print.ts";

const CONSUMERS = new Set<string>(["collect", "exists", "none", "count", "first", "single"]);
// The fixed clause order of a body (ADR-020). Each clause appears at most once.
// `frontier` is a clause of every body that has a `follow` (a destination
// block's marks the occurrences it reaches, any other body's its seeds — 0.20);
// `depth` is legal only in a follow destination block, and the order sentence
// names it only there. `group by` and `having` (0.24) sit after `follow`: the
// rows a body yields — the walk's occurrences, when it has one — are what gets
// grouped, and the bound and the ordering then apply to the groups. `flatten`
// (0.25) sits between them: it fans the rows a body yields — the occurrences,
// after a walk — out per element, and is the one clause that may repeat (each
// `flatten` fans out the rows the previous produced, SEMANTICS §25).
const CLAUSE_ORDER = ["select", "from", "where", "frontier", "depth", "follow", "flatten", "group by", "having", "order by", "limit", "offset"] as const;
type Clause = (typeof CLAUSE_ORDER)[number];
const DESTINATION_ONLY: ReadonlySet<Clause> = new Set<Clause>(["depth"]);
// The clauses a body may hold, in order.
function clausesOf(ctx: BodyCtx): Clause[] {
  return CLAUSE_ORDER.filter((c) => ctx.destination || !DESTINATION_ONLY.has(c));
}
// Contextual clause words lexed as bare idents; an open-ended range must stop
// before them rather than consume them as its high bound.
const CLAUSE_WORDS = new Set<string>([
  "collect", "exists", "none", "count", "first", "single",
  "order", "by", "asc", "desc", "follow", "distinct", "frontier", "depth", "in", "values",
  "limit", "offset", "group", "having", "flatten", "as",
]);
// The names a group scope resolves besides its keys (SEMANTICS §24): the
// group's rows, the key record itself, and its identity.
const GROUP_SCOPE_NAMES: ReadonlySet<string> = new Set(["rows", "$it", "$key"]);
const RELOPS = new Set<string>(["==", "!=", "<", "<=", ">", ">="]);
// The comparison level (GRAMMAR §4): the six relational operators and, since
// 0.22, the four regex operators — sugar over `matches`, non-associative like
// the rest of the level.
const CMP_OPS = new Set<string>(["==", "!=", "<", "<=", ">", ">=", "~", "~*", "!~", "!~*"]);
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
  /** A `follow` destination block (0.20): the only body that admits `depth`, and
   * the one whose `frontier` marks the occurrences it reaches (read one level out)
   * rather than the seeds of its own `follow`. */
  destination: boolean;
}
const TOP_CTX: BodyCtx = { top: true, op: null, liftsAllowed: false, destination: false };

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
  frontier: Expr | null;
  depth: number | null;
  flatten: Flatten[];
  groupBy: GroupBy | null;
  having: Where | null;
  distinct: boolean;
  values: boolean;
  limit: Expr | null;
  offset: Expr | null;
}

/** The clauses of an omitted block (`jobs first` — the empty block `{ }`). */
function emptyBody(): BodyClauses {
  return { froms: [], where: null, select: [], orderBy: null, follow: null, frontier: null, depth: null, flatten: [], groupBy: null, having: null, distinct: false, values: false, limit: null, offset: null };
}

/** The names a projection would shadow in a `where` of the same body: every
 * item's name except a plain self-projection (`pay: pay`, `pay`), which
 * substitutes a name for itself. */
function shadowingNames(items: SelectItem[]): string[] {
  return items
    .filter((it) => it.name !== "" && !(it.kind === "field" && it.lift === 0 && it.expr.kind === "ident" && it.expr.name === it.name))
    .map((it) => it.name);
}

/** Whether a bare identifier anywhere under `w` has one of `names` (the alias
 * guard of the projection-block merge; conservative: nested blocks included). */
function readsAnyOf(w: Where, names: string[]): boolean {
  const wanted = new Set(names.filter((n) => n !== ""));
  if (wanted.size === 0) return false;
  let found = false;
  visit(w, { enter(node) { if (node.kind === "ident" && wanted.has(node.name)) found = true; return !found; } });
  return found;
}

// A copy of a node with another span (a parenthesized operand takes the span of
// its parentheses).
function withSpan<T extends { span: Span }>(node: T, span: Span): T {
  return { ...node, span };
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  /** While a block's leading run is read speculatively as a predicate, a bare
   * `first`/`single` leaf is not rejected on sight: the body decides after the
   * run is classified (`rejectBareLookups`). */
  private deferLookup = false;
  /** The scope depth (SEMANTICS §2) at which the construct being parsed is
   * evaluated: 0 at the root (the top-level source and bounds), 1 for a
   * top-level row's clauses, one deeper per block body and per follow `where`.
   * An absolute reference `N^name` reads `depth − N` scopes out. */
  private depth = 0;
  /** Whether a consumer word with no block is read as a directive over the
   * empty block (`jobs first` ≡ `jobs first { }`, since 0.26). Off only while
   * the clause form's top-level `from` expression is read, so `from people
   * count` keeps its whole-query hint (a count is never a source). */
  private bareDirectives = true;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** Run `f` with the scope depth set to `d`, restoring it afterwards (also on
   * the error path, so a speculative read that fails leaves the depth intact). */
  private atDepth<T>(d: number, f: () => T): T {
    const saved = this.depth;
    this.depth = d;
    try { return f(); } finally { this.depth = saved; }
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
    this.failAt(this.peek().pos, msg);
  }
  private failAt(pos: number, msg: string): never {
    throw new OqxError(`${msg} (at offset ${pos})`, "parse");
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
    let directive = this.tryOp(false);
    if (directive && !this.at("eof") && (this.at("lbracket") || this.atBlock() !== null)) {
      // A longer chain whose outermost node is still a directive
      // (`people first { } first { }` — how `people[p][0]` prints back; a block
      // over the directive, `people[0] { name }`, merges into it, 0.26).
      const save = this.pos;
      try {
        const e = this.parsePostfix(directive);
        if (e.kind === "op" && this.at("eof")) directive = e;
        else this.pos = save;
      } catch (err) {
        if (!(err instanceof OqxError)) throw err;
        this.pos = save;
      }
    }
    if (directive && this.at("eof")) return this.queryFromOp(directive, start);
    if (directive) this.fail(`unexpected ${this.tokDesc()} after the top-level directive`);
    // A bracket chain whose outermost node is a directive is the whole query too
    // (`people[age > 40]` ≡ `people first { where age > 40 }`). Read
    // speculatively: anything else (a parse error, a longer expression) is the
    // body form's business.
    if (this.at("ident") || this.at("caret") || this.at("binding")) {
      const save = this.pos;
      try {
        const e = this.parsePostfix();
        if (e.kind === "op" && this.at("eof")) return this.queryFromOp(e, start);
      } catch (err) {
        if (!(err instanceof OqxError)) throw err;
      }
      this.pos = save;
    }

    // Body form: the fixed clause list; its `from` is the source.
    const body = this.parseBody(TOP_CTX);
    if (!this.at("eof")) this.fail(`unexpected ${this.tokDesc()} after the query — nothing may follow the last clause`);
    if (body.froms.length === 0) {
      this.fail("a query must name its source before its body: `<collection> { … }` (or `<collection> <consumer> { … }`; the clause form `select … from <collection> …` is still read)");
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
      frontier: body.frontier,
      flatten: body.flatten,
      groupBy: body.groupBy,
      having: body.having,
      distinct: body.distinct,
      values: body.values,
      limit: body.limit,
      offset: body.offset,
    };
  }

  // The whole-query form of a directive: its receiver is the source, its block
  // the body, its consumer the query's.
  private queryFromOp(e: OpNode, start: number): Query {
    return {
      kind: "query", span: this.sp(start), source: e.receiver, from: e.sub.from, where: e.sub.where, select: e.sub.select,
      orderBy: e.sub.orderBy, consumer: e.op, follow: e.sub.follow, frontier: e.sub.frontier, flatten: e.sub.flatten, groupBy: e.sub.groupBy, having: e.sub.having,
      distinct: e.distinct, values: e.sub.values, limit: e.sub.limit, offset: e.sub.offset,
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
    let frontier: Expr | null = null;
    let depth: number | null = null;
    const flatten: Flatten[] = [];
    let groupBy: GroupBy | null = null;
    let having: Where | null = null;
    let distinct = false;
    let values = false;
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    let stage = -1;
    // A top-level body's row clauses (select/where/follow/order by) are read at
    // depth 1, its source and bounds at the root (0); a block's clauses are all
    // at the block's depth, which `parseConsumerBlock` set.
    const rowDepth = ctx.top ? 1 : this.depth;

    const enter = (clause: Clause): void => {
      const idx = CLAUSE_ORDER.indexOf(clause);
      // `flatten` is the one clause that may repeat (0.25): each fans out the
      // rows the previous produced.
      if (idx === stage && clause !== "flatten") this.fail(`duplicate \`${clause}\` clause`);
      if (idx < stage) {
        this.fail(`\`${clause}\` must come before \`${CLAUSE_ORDER[stage]}\` — OQX clause order is ${clausesOf(ctx).join(", ")}`);
      }
      stage = idx;
    };

    while (!this.at("eof") && !this.at("rbrace")) {
      if (this.at("kw", "select")) {
        enter("select");
        this.next();
        if (this.at("ident", "distinct")) { this.next(); distinct = true; }
        ({ items: select, values } = this.atDepth(rowDepth, () => this.parseProjection(ctx)));
        continue;
      }
      if (this.at("kw", "from")) {
        enter("from");
        this.next();
        // At the clause form's top level a consumer word after the source is the
        // whole-query mistake (`from people count`): kept as the hint below,
        // not read as a braceless directive (a count is never a source).
        const bare = this.bareDirectives;
        if (ctx.top) this.bareDirectives = false;
        try { froms.push(this.parseValueExpr()); } finally { this.bareDirectives = bare; }
        continue;
      }
      if (this.at("kw", "where")) {
        enter("where");
        this.next();
        where = this.atDepth(rowDepth, () => this.parseWhere());
        continue;
      }
      // `frontier P` (0.20) — in a follow destination block the destination's
      // own clause, read in the occurrence's scope whose parent is the walk's
      // enclosing scope: one level OUT of the block's rows (SEMANTICS §20), so
      // `^` there is the enclosing scope, not the frontier row. In any other
      // body it marks the seeds of the body's own `follow` (checked below) and
      // is read in the seed's scope, like `where`.
      if (this.at("ident", "frontier") && this.startsValue(this.peekAt(1))) {
        enter("frontier");
        this.next();
        frontier = this.atDepth(ctx.destination ? rowDepth - 1 : rowDepth, () => this.parseValueExpr());
        continue;
      }
      // `depth n` — a follow destination block's own clause (0.20).
      if (ctx.destination && this.at("ident", "depth") && this.peekAt(1)?.type === "number") {
        enter("depth");
        this.next();
        const v = Number(this.next().value);
        if (!Number.isInteger(v) || v < 1 || v > 8) this.fail("follow depth must be an integer between 1 and 8");
        depth = v;
        continue;
      }
      if (this.atFollow()) {
        enter("follow");
        follow = this.atDepth(rowDepth, () => this.parseFollow());
        continue;
      }
      // `flatten <expr> [{ … }] [as <name>]` (0.25): the value is read on each
      // row, like `where`; a brace after a receiver is the receiver-block sugar
      // (the `collect` op), so the block needs no slot of its own.
      if (this.atFlatten()) {
        enter("flatten");
        flatten.push(this.atDepth(rowDepth, () => this.parseFlatten(flatten)));
        continue;
      }
      // `group by k, name: expr` (0.24): the keys are read on the rows, like `where`.
      if (this.atGroupBy()) {
        enter("group by");
        groupBy = this.atDepth(rowDepth, () => this.parseGroupBy());
        continue;
      }
      // `having P` (0.24): a predicate over each GROUP, read at the row depth
      // (the group scope sits where the rows did).
      if (this.atHaving()) {
        enter("having");
        this.next();
        having = this.atDepth(rowDepth, () => this.parseWhere());
        continue;
      }
      if (this.atOrderBy()) {
        enter("order by");
        this.next(); this.next(); // `order` `by`
        orderBy = this.atDepth(rowDepth, () => this.parseOrderSpecs());
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
      // the one keyword that may be dropped, and only in first position) — or,
      // in a block, a leading predicate that opens a `where`-first body. After
      // any clause it is an error.
      if (stage === -1 && (this.at("ident") || this.at("binding") || this.at("caret") || this.canStartValue())) {
        const lead = this.atDepth(rowDepth, () => this.parseLeadingRun(ctx));
        if (lead.where) {
          enter("where");
          where = lead.where;
        } else {
          enter("select");
          ({ items: select, values } = lead.projection!);
        }
        continue;
      }
      this.failUnexpectedInBody(stage, ctx);
    }
    // Validate the alias references of this body (cycles, a block alias inside a
    // `where` expression, a `select` item naming an item to its right); the
    // surface form is kept. `where` first: its cycle report follows its own path.
    // A grouped body without a projection yields its keys and a count (0.24);
    // the items are synthesized before the alias validation sees the select.
    if (groupBy && select.length === 0) select = defaultGroupProjection(groupBy, (msg) => this.failAt(groupBy!.span[0], msg));
    const resolvedWhere = where ? resolveWhere(select, where, (msg) => this.fail(msg)) : null;
    // The resolved items: an aggregate reached through an alias (`n: count(),
    // xs: collect(n)`) is judged where it will be evaluated.
    const resolvedSelect0 = resolveSelect(select, (msg) => this.fail(msg));
    // The row-reading clauses see the aliases too (0.27): `frontier`, `flatten`,
    // the keys and `order by` are judged (aggregates, group reads) as they will
    // be evaluated — with a key that names an alias taking its expression and
    // that alias's item reading the key.
    const rc = resolveRowClauses(resolvedSelect0, { frontier, flatten, groupBy, orderBy }, (msg) => this.fail(msg));
    const resolvedSelect = rc.select;
    // `having` reads the group: an aliased key's name there is the key.
    const resolvedHaving = having ? resolveWhere(readKeys(select, rc.aliasedKeys), having, (msg) => this.fail(msg)) : null;
    // Outside a destination block `frontier` marks the seeds of this body's walk,
    // so it needs one.
    if (frontier && !follow && !ctx.destination) {
      this.fail("`frontier` needs a `follow` — a body's `frontier <expr>` marks which of its rows (the walk's seeds) are frontiers; a destination block's marks the occurrences reached through it");
    }
    // Grouping (0.24): `having` needs a `group by`; `distinct` is redundant with
    // one; aggregates may stand only in the post-group clauses; and every bare
    // name read at the group scope must be a key, an alias, or the group's rows.
    if (having && !groupBy) {
      this.failAt(having.span[0], "`having` needs a `group by` — `having <pred>` filters the groups a body yields; a per-row filter is `where`");
    }
    if (groupBy) {
      if (distinct) this.failAt(groupBy.span[0], DISTINCT_WITH_GROUP);
      this.checkGroupedBody({ select, resolvedSelect, having, resolvedHaving, orderBy: rc.orderBy, froms, where: resolvedWhere, frontier: rc.frontier, flatten: rc.flatten, limit, offset, groupBy: rc.groupBy });
    } else {
      this.rejectAggregates({ select, resolvedSelect, having: null, resolvedHaving: null, orderBy: rc.orderBy, froms, where: resolvedWhere, frontier: rc.frontier, flatten: rc.flatten, limit, offset, groupBy: null });
    }
    return { froms, where, select, orderBy, follow, frontier, depth, flatten, groupBy, having, distinct, values, limit, offset };
  }

  // ---- flatten (0.25) -------------------------------------------------------

  // `flatten` is a clause when a value can follow the word; otherwise it is a
  // field name (`select flatten from r`).
  private atFlatten(): boolean {
    if (!this.at("ident", "flatten")) return false;
    const nx = this.peekAt(1);
    // A value start — or an aggregate call whose name is a consumer word
    // (`flatten collect(x)`), admitted so the aggregate check can name it.
    return this.startsValue(nx) || (nx?.type === "ident" && isAggregateName(nx.value) && this.peekAt(2)?.type === "lparen");
  }

  // `flatten <expr> [as <name>]`. The expression is any value — a block after a
  // receiver is read by the postfix grammar as the implicit `collect` op (0.20),
  // which is exactly the block over the coerced collection SEMANTICS §25 wants.
  // The name defaults to a plain navigation's last segment (as a select item's
  // or a group key's does); anything else needs `as`. Names are unique within
  // the body, never a `$`-name (the language's), a keyword or a literal word.
  private parseFlatten(earlier: readonly Flatten[]): Flatten {
    const start = this.start();
    this.next(); // `flatten`
    const expr = this.parseValueExpr();
    let name: string;
    if (this.at("ident", "as")) {
      this.next();
      const t = this.peek();
      if (t.type !== "ident") this.fail("expected a name after `as` (`flatten <expr> as <name>`)");
      if (LITERAL_WORDS.has(t.value)) this.fail(`\`${t.value}\` is a literal and cannot name a flattened value (\`flatten <expr> as <name>\`)`);
      if (t.value.startsWith("$")) this.fail(`a flattened value cannot be bound to a \`$\`-name (\`${t.value}\`) — \`$\` belongs to the language; choose another name`);
      name = this.next().value;
    } else {
      const key = navKey(expr);
      if (key === null) {
        this.failAt(start, `\`flatten ${describe(expr)}\` needs a name (\`flatten ${describe(expr)} as <name>\`) — only a plain navigation names itself by its last segment`);
      }
      name = key;
    }
    if (earlier.some((f) => f.name === name)) this.failAt(start, `duplicate flatten name '${name}' — each flatten binds its own name (\`flatten <expr> as <other>\`)`);
    return { kind: "flatten", span: this.sp(start), expr, name };
  }

  // ---- grouping (0.24) ------------------------------------------------------

  // `group by` is a clause only as the two-word sequence (a field named `group`
  // stays a name: `select group from r`).
  private atGroupBy(): boolean {
    const t = this.peek();
    const nx = this.peekAt(1);
    return t.type === "ident" && t.value === "group" && !!nx && nx.type === "ident" && nx.value === "by";
  }

  // `having` is a clause when a predicate can follow it — a value start, or an
  // aggregate call whose name is a consumer word (`having count() > 1`:
  // `count` alone cannot begin a value, `count(` can); otherwise a field name.
  private atHaving(): boolean {
    if (!this.at("ident", "having")) return false;
    const nx = this.peekAt(1);
    return this.startsValue(nx) || (nx?.type === "ident" && isAggregateName(nx.value) && this.peekAt(2)?.type === "lparen");
  }

  private parseGroupBy(): GroupBy {
    const start = this.start();
    this.next(); this.next(); // `group` `by`
    const keys = [this.parseGroupKey()];
    while (this.at("comma")) { this.next(); keys.push(this.parseGroupKey()); }
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k.name)) this.failAt(k.span[0], `duplicate group key '${k.name}' — each key needs its own name (alias one: \`other: expr\`)`);
      seen.add(k.name);
    }
    return { kind: "groupBy", span: this.sp(start), keys };
  }

  // One key, shaped like a select item: `name: expr`, or an unaliased navigation
  // keyed by its last segment; any other expression needs the alias, because the
  // alias is how the post-group clauses refer to the key.
  private parseGroupKey(): GroupKey {
    const start = this.start();
    if (this.at("ident") && this.peekAt(1)?.type === "colon") {
      const name = this.next().value;
      this.next(); // ':'
      const expr = this.parseValueExpr();
      return { kind: "key", span: this.sp(start), name, expr };
    }
    if (!this.canStartValue()) this.fail("expected a group key after `group by` (`group by <name>` or `group by <alias>: <expr>`)");
    const expr = this.parseValueExpr();
    const name = navKey(expr);
    if (name === null) {
      this.failAt(start, `a group key that is not a plain name needs an alias (\`group by key: ${describe(expr)}\`) — the alias is the name the select, \`having\` and \`order by\` read it by`);
    }
    return { kind: "key", span: this.sp(start), name, expr };
  }

  // `name(` where `name` is an aggregate: `count()`, `sum(e)`, `collect(distinct
  // e)`. The cursor is at the `(`. Arity and the `distinct` modifier are checked
  // here; WHERE the aggregate may stand is the body's business (`checkGroupedBody`).
  private parseAggregate(name: AggregateName, start: number): Expr {
    this.next(); // '('
    let distinct = false;
    if (this.at("ident", "distinct") && this.startsValue(this.peekAt(1))) { this.next(); distinct = true; }
    let arg: Expr | null = null;
    if (!this.at("rparen")) {
      arg = this.parseValueExpr();
      if (this.at("comma")) this.fail(`\`${name}(…)\` takes one argument — an aggregate reduces one expression over the group's rows`);
    }
    if (!this.at("rparen")) this.fail(`expected ')' to close \`${name}(…)\``);
    this.next();
    if (arg === null && name !== "count") this.fail(`\`${name}()\` needs an argument (\`${name}(<expr>)\`) — only \`count()\` counts the group's rows without one`);
    if (distinct && (name === "any" || name === "all")) {
      this.fail(`\`${name}(distinct …)\`: \`distinct\` applies to a value aggregate (count, sum, min, max, avg, collect, first, last), not to a predicate aggregate`);
    }
    return { kind: "aggregate", span: [start, this.end()], name, arg, distinct };
  }

  // A free call: an aggregate node for an aggregate name (reserved since 0.24),
  // an ordinary `call` otherwise. The cursor is at the `(`.
  private parseFreeCall(name: string, start: number): Expr {
    if (isAggregateName(name)) return this.parseAggregate(name, start);
    const args = this.parseArgs();
    return { kind: "call", span: this.sp(start), recv: null, name, args };
  }

  // The clauses an aggregate may NOT stand in — every clause read before the
  // rows are grouped (`from`, `where`, `frontier`, the keys, the bound) — and,
  // in a body without `group by`, every clause. The `where` is the alias-resolved
  // one, so an aggregate reached through a select alias is caught too.
  private rejectAggregates(b: GroupCheck): void {
    const found: [Expr, string][] = [];
    const collect = (exprs: (Expr | null)[], clause: string): void => {
      const out: Expr[] = [];
      for (const e of exprs) if (e) aggregatesIn(e, out);
      for (const a of out) found.push([a, clause]);
    };
    const where: Expr[] = [];
    if (b.where) whereAggregates(b.where, where);
    for (const a of where) found.push([a, "`where`"]);
    collect(b.froms, "`from`");
    collect([b.frontier], "`frontier`");
    collect(b.flatten.map((f) => f.expr), "`flatten`");
    collect([b.limit], "`limit`");
    collect([b.offset], "`offset`");
    if (b.groupBy) collect(b.groupBy.keys.map((k) => k.expr), "a `group by` key");
    if (!b.groupBy) {
      collect(b.resolvedSelect.filter((it) => it.kind === "field").map((it) => (it as Extract<SelectItem, { kind: "field" }>).expr), "a select item");
      if (b.orderBy) collect(b.orderBy.map((o) => o.expr), "`order by`");
    }
    const hit = found[0];
    if (!hit) return;
    const [agg, clause] = hit;
    if (!b.groupBy) {
      this.failAt(agg.span[0], `\`${describe(agg)}\` is an aggregate: it is read after grouping and may stand only in a select item, \`having\` or \`order by\` of a body with \`group by\` — this body has none`);
    }
    this.failAt(agg.span[0], `\`${describe(agg)}\` is an aggregate and cannot be read in ${clause}${clause === "`where`" ? " (a select alias standing for one included)" : ""} — the rows are not grouped yet there; aggregates stand in a select item, \`having\` or \`order by\``);
  }

  // A grouped body: aggregates only after the grouping (and never nested), and
  // every bare name at the group scope a key, an alias, or the group's rows.
  private checkGroupedBody(b: GroupCheck): void {
    this.rejectAggregates(b);
    // An aggregate's argument is read on the group's rows, where there is no
    // group to aggregate: `sum(count())` is an error, not a double reduction.
    const post: Expr[] = [];
    for (const it of b.resolvedSelect) if (it.kind === "field") aggregatesIn(it.expr, post);
    if (b.resolvedHaving) whereAggregates(b.resolvedHaving, post);
    if (b.orderBy) for (const o of b.orderBy) aggregatesIn(o.expr, post);
    const nested = nestedAggregate(post);
    if (nested) this.failAt(nested.span[0], `\`${describe(nested)}\`: an aggregate cannot nest — its argument is read on each of the group's rows, where there is no group to reduce`);
    const keys = new Set(b.groupBy!.keys.map((k) => k.name));
    const valid = (aliases: Iterable<string>): ReadonlySet<string> => new Set([...keys, ...GROUP_SCOPE_NAMES, ...aliases]);
    const aliases: string[] = [];
    // The resolved items: an alias to the left is inlined, a key-defining alias reads its key (0.27).
    for (const it of b.resolvedSelect) {
      const names = valid(aliases);
      if (it.kind === "field") this.checkGroupExpr(it.expr, names, "a select item");
      else this.checkGroupExpr(it.op.receiver, names, "a select item");
      const own = it.kind === "collect" ? (it.name === "" ? null : it.name) : it.lift === 0 && it.name !== "" ? it.name : null;
      if (own !== null) aliases.push(own);
    }
    if (b.having) this.checkGroupWhere(b.having, valid(aliases), "`having`");
    if (b.orderBy) for (const o of b.orderBy) this.checkGroupExpr(o.expr, valid([]), "`order by`");
  }

  private checkGroupWhere(w: Where, valid: ReadonlySet<string>, where: string): void {
    switch (w.kind) {
      case "and": case "or": w.parts.forEach((p) => this.checkGroupWhere(p, valid, where)); return;
      case "not": this.checkGroupWhere(w.expr, valid, where); return;
      case "scalar": this.checkGroupExpr(w.expr, valid, where); return;
      case "op": this.checkGroupExpr(w.receiver, valid, where); return; // the block is its own scope
    }
  }

  // Every bare name `e` reads at the group scope (an aggregate's argument reads
  // the group's rows and is not checked; a nested block is its own scope, only
  // its receiver is read here). `inCall` names the enclosing non-aggregate free
  // call, for the "not an aggregate" hint.
  private checkGroupExpr(e: Expr, valid: ReadonlySet<string>, where: string, inCall: string | null = null): void {
    switch (e.kind) {
      case "ident":
        if (!valid.has(e.name)) {
          const hint = inCall === null ? "" : `; \`${inCall}(…)\` is not an aggregate — the aggregates are ${[...AGGREGATE_NAMES].join(", ")}`;
          this.failAt(e.span[0], `\`${e.name}\` is not a group key or aggregate — ${where} of a grouped body reads the group: a key (\`group by ${e.name}\`), an aggregate over its rows (\`collect(${e.name})\`), or the rows themselves (\`rows collect { select ${e.name} }\`)${hint}`);
        }
        return;
      case "lit": case "binding": case "outer": case "aggregate": return;
      case "member": this.checkGroupExpr(e.recv, valid, where, inCall); return;
      case "call":
        if (e.recv) this.checkGroupExpr(e.recv, valid, where, inCall);
        for (const a of e.args) this.checkGroupExpr(a, valid, where, e.recv === null ? e.name : inCall);
        return;
      case "unary": case "required": this.checkGroupExpr(e.expr, valid, where, inCall); return;
      case "binary": case "logical": case "in":
        this.checkGroupExpr(e.left, valid, where, inCall);
        this.checkGroupExpr(e.right, valid, where, inCall);
        return;
      case "range":
        if (e.lo) this.checkGroupExpr(e.lo, valid, where, inCall);
        if (e.hi) this.checkGroupExpr(e.hi, valid, where, inCall);
        return;
      case "tuple": e.items.forEach((x) => this.checkGroupExpr(x, valid, where, inCall)); return;
      case "template": e.parts.forEach((p) => { if (typeof p !== "string") this.checkGroupExpr(p, valid, where, inCall); }); return;
      case "op": this.checkGroupExpr(e.receiver, valid, where, inCall); return;
    }
  }

  // The keyword-less run that opens a body. At the top level it is always the
  // projection. In a block it is a `where`-first body when the leading expression
  // is SYNTACTICALLY a predicate (GRAMMAR §2): the run is read as a where tree
  // first; if that tree is predicate-shaped — anything but a bare name, a dotted
  // navigation or a lift, with a parenthesized expression counting as a
  // predicate — and is not the item of a `values` projection, it is the `where`.
  // Otherwise the tokens are re-read as the projection. When both readings fail,
  // the error that got further wins (the farthest-failure rule), so a mistake
  // deep inside `{ jobs exists { … } }` is reported where it is.
  private parseLeadingRun(ctx: BodyCtx): { where: Where | null; projection: { items: SelectItem[]; values: boolean } | null } {
    if (!ctx.top) {
      const save = this.pos;
      const first = this.peek();
      let w: Where | null = null;
      let specErr: OqxError | null = null;
      let specPos = -1;
      this.deferLookup = true;
      try {
        w = this.parseWhere();
      } catch (e) {
        if (!(e instanceof OqxError)) throw e;
        specErr = e;
        specPos = this.pos;
      } finally {
        this.deferLookup = false;
      }
      if (w && predicateShaped(w, first) && !this.at("ident", "values")) {
        if (this.at("comma")) {
          this.fail(`a leading predicate starts a \`where\`-first body, which has no projection — write the projection first: \`{ <projection> where ${describe(w)} }\``);
        }
        this.rejectBareLookups(w);
        return { where: w, projection: null };
      }
      this.pos = save;
      if (specErr) {
        try {
          return { where: null, projection: this.parseProjection(ctx) };
        } catch (e) {
          if (e instanceof OqxError && this.pos < specPos) throw specErr;
          throw e;
        }
      }
    }
    return { where: null, projection: this.parseProjection(ctx) };
  }

  // The error for a token that starts no clause, phrased for the mistake it most
  // likely is: a bare run right after `from` (the old implicit `where`, or a
  // consumer word where a whole-query directive was meant), or a stray token.
  private failUnexpectedInBody(stage: number, ctx: BodyCtx): never {
    const t = this.peek();
    const last = stage >= 0 ? CLAUSE_ORDER[stage] : null;
    const remaining = clausesOf(ctx).filter((c) => CLAUSE_ORDER.indexOf(c) > stage).join("/");
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
      if (t.value === "depth" && !ctx.destination) {
        this.fail(`unexpected 'depth' after \`${last}\` — \`depth\` is a clause of a follow destination block only (\`follow <relation> { depth 2 }\`)`);
      }
      if (t.value === "depth") this.fail("expected an integer after `depth` (`depth 1`..`depth 8`)");
      if (t.value === "frontier") this.fail(`unexpected 'frontier' after \`${last}\` — \`frontier\` takes an expression (\`frontier <expr>\`) and belongs to a body that has a \`follow\``);
      if (t.value === "flatten") this.fail(`unexpected 'flatten' after \`${last}\` — \`flatten\` takes a value to split into rows (\`flatten <expr> [{ … }] [as <name>]\`)`);
      if (t.value === "group") this.fail(`unexpected 'group' after \`${last}\` — a grouping is written \`group by <key>[, <key>…]\` (a key is a name or \`alias: <expr>\`)`);
      if (t.value === "having") this.fail(`unexpected 'having' after \`${last}\` — \`having\` takes a predicate over each group (\`having count() > 1\`) and belongs to a body that has a \`group by\``);
    }
    if (last === "from" && t.type === "ident" && CONSUMERS.has(t.value)) {
      this.fail(`unexpected \`${t.value}\` after \`from\` — a whole-query consumer is written \`<collection> ${t.value} { … }\`; to project a field named ${t.value} write \`select ${t.value} from …\`; a predicate needs \`where\``);
    }
    if (last === "from") {
      this.fail(`unexpected ${this.tokDesc()} after \`from\` — a predicate needs \`where\` (there is no implicit where), and a projection goes before \`from\` (\`select … from …\`); expected ${remaining}`);
    }
    // `{ name, rel exists { … } }`: the leading items were read as the projection,
    // so the consumer word is where the mistake shows.
    if (last === "select" && t.type === "ident" && CONSUMERS.has(t.value)) {
      this.fail(`unexpected \`${t.value}\` after a projection — a consumer test is a predicate: write \`where <relation> ${t.value} { … }\` after the projection (a block may lead with a predicate only when nothing is projected); a nested block in a projection needs a name (\`name: <relation> collect { … }\`)`);
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

  // Whether the token `n` ahead can head a scope reference: a `^` run, or the
  // `N^` of an absolute reference.
  private atScopeRefAt(n: number): boolean {
    return this.peekAt(n)?.type === "caret" || this.atAbsoluteRefAt(n);
  }

  // `N^` — an unsigned integer literal (digits only) immediately followed by a
  // caret, no whitespace between: an absolute scope reference (GRAMMAR §4).
  // `1 ^x` is not one (the `^` then fails as a stray token), nor is `1.0^x`.
  private atAbsoluteRef(): boolean { return this.atAbsoluteRefAt(0); }
  private atAbsoluteRefAt(n: number): boolean {
    const t = this.peekAt(n);
    const nx = this.peekAt(n + 1);
    return t?.type === "number" && /^\d+$/.test(t.value) && nx?.type === "caret" && nx.pos === t.end;
  }

  // The head of an outer reference or a lift: a run of carets (one scope out
  // per caret), or an absolute reference `N^` (scope N, GRAMMAR §4), both as the
  // number of scopes out from the current depth. Returns 0 when there is none.
  // The absolute form is checked before anything is consumed, so a failing
  // lookahead (`tryOp`) leaves the cursor on the integer.
  private parseScopeRef(): number {
    if (this.atAbsoluteRef()) {
      const n = this.peek();
      const target = Number(n.value);
      if (target >= this.depth) {
        this.fail(`scope ${n.value} does not enclose this block (the current scope is depth ${this.depth})`);
      }
      this.next(); // the integer
      this.next(); // the caret
      return this.depth - target;
    }
    return this.parseCarets();
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
    return !!nx && (nx.type === "ident" || nx.type === "binding" || nx.type === "lparen" || this.atScopeRefAt(1));
  }

  // Whether the cursor is at something that can begin a `follow` destination:
  // a name, a binding, a scope reference, or a tuple's `(`.
  private atDestinationStart(): boolean {
    return this.at("ident") || this.at("binding") || this.at("lparen") || this.atScopeRefAt(0);
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
      if (!this.atDestinationStart()) {
        this.fail("expected a relation after `follow distinct` (`follow distinct <relation>`)");
      }
    }
    const destinations: FollowDestination[] = [this.parseFollowDestination()];
    while (this.at("comma")) {
      this.next();
      if (!this.atDestinationStart()) {
        this.fail("expected a relation after ',' (`follow <relation>, <relation>`)");
      }
      destinations.push(this.parseFollowDestination());
    }
    return { kind: "follow", span: this.sp(start), destinations, distinct };
  }

  // One `follow` destination: a receiver (a binding, a dotted name — headed by a
  // bare name, an outer reference or a free-function call — or a tuple) that is
  // either a plain relation of the current row or, when a block follows, a
  // destination block. The block is what `tryOp` recognizes in select position
  // — `{ … }` (the implicit `collect`), `distinct { … }`, or a consumer word and
  // `{` / `distinct {` — read with the destination flag so its body admits
  // `frontier` and `depth`. Only collect/first/single yield rows to walk; the
  // where-position tests are rejected by name. A receiver headed by an outer
  // reference can never be a plain destination (plain destinations are relations
  // of the current row), so without a block it is an error naming the block
  // spellings.
  private parseFollowDestination(): FollowDestination {
    const outer = this.atScopeRefAt(0);
    const op = this.tryOp(false, true);
    if (op) {
      if (op.op !== "collect" && op.op !== "first" && op.op !== "single") {
        this.fail(`a follow destination must use collect/first/single, not \`${op.op}\` (exists/none/count are where-position tests)`);
      }
      return op;
    }
    if (outer) {
      this.fail("`follow` takes a relation of the current row (`follow <relation>`); an outer reference walks a root collection only as a destination block — `follow ^docs { where … }` or `follow ^docs collect { … }`");
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
    if (this.at("lparen")) {
      const t = this.tryTuple();
      if (t) return t;
      this.fail("expected a collection navigation (a property/relation name) or a tuple `(a, b)`");
    }
    const start = this.start();
    const levels = this.parseScopeRef();
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
    if (levels === 0 && this.at("lparen")) expr = this.parseFreeCall(head.value, start);
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
        if (it.name === "") {
          if (it.kind === "collect") this.fail("a nested block in a projection needs a name (`name: <relation> collect { … }`); as a predicate, a consumer test is written `where <relation> exists { … }`");
          if (ctx.top) this.fail("a leading expression is a projection (select): an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `<collection> { <predicate> }`, or write `where …` after `from` — at the top level of the clause form a predicate is never implicit (the clause order puts `from` first)");
          this.fail("an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `where …` after the projection (a block may lead with a predicate only when nothing is projected: `{ age > 18 }`)");
        }
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
    // error there. `N^name:` is the lift into scope N (GRAMMAR §4).
    const lift = this.parseScopeRef();
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
        // `name: jobs first { }.pay`: the directive is the head of a longer value
        // (a block over it, `jobs[0] { name }`, merges into it — 0.26).
        if (this.atScalarContinuation() || this.atBlock() !== null) return this.finishItem(name, this.parseOr(op), lift, start);
        if (op.op !== "collect" && op.op !== "first" && op.op !== "single" && op.op !== "count") {
          this.fail(`projection '${name}' must use collect/first/single/count, not ${op.op} (exists/none are where-position tests; \`count { … }\` is a value since 0.24)`);
        }
        return this.finishItem(name, op, lift, start);
      }
      return this.finishItem(name, this.parseValueExpr(), lift, start);
    }
    // Unaliased item: a bare/dotted navigation (under any `!`) keys by its last
    // segment; any other expression is unnamed ("") — legal only under `values`
    // (checked by parseProjection, which sees the whole list).
    const expr = this.parseValueExpr();
    return this.finishItem(navKey(expr) ?? "", expr, lift, start);
  }

  // An item from its value: exactly a directive (written out, or the bracket
  // sugar) is the `collect` item kind; anything else is a `field`.
  private finishItem(name: string, expr: Expr, lift: number, start: number): SelectItem {
    if (expr.kind === "op") {
      if (lift) this.fail(`a lift (^${name}) value must be a scalar expression, not ${expr.op} { … }`);
      return { kind: "collect", span: this.sp(start), name, op: expr };
    }
    return { kind: "field", span: this.sp(start), name, expr, lift };
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
    if (!this.atOr()) return left;
    const parts = [left];
    while (this.atOr()) { this.next(); parts.push(this.parseWhereAnd()); }
    return { kind: "or", span: this.sp(start), parts };
  }

  private parseWhereAnd(): Where {
    const start = this.start();
    const left = this.parseWherePrimary();
    if (!this.atAnd()) return left;
    const parts = [left];
    while (this.atAnd()) { this.next(); parts.push(this.parseWherePrimary()); }
    return { kind: "and", span: this.sp(start), parts };
  }

  // `&&` / `and` and `||` / `or` are one operator each (0.17): the words are
  // exact synonyms of the symbols, parsed to the same nodes.
  private atAnd(): boolean { return this.atOp("&&") || this.at("kw", "and"); }
  private atOr(): boolean { return this.atOp("||") || this.at("kw", "or"); }

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
    // Leading negations: `!`, `not` (one each) and `is` (two — `is x` ≡ `!!x`).
    const notStarts: number[] = [];
    for (;;) {
      if (this.atOp("!") || this.at("kw", "not")) notStarts.push(this.next().pos);
      else if (this.at("kw", "is")) { const p = this.next().pos; notStarts.push(p, p); }
      else break;
    }
    if (this.at("lparen")) {
      // A tuple (0.20) is a value, not a group: the receiver of a consumer test
      // (`(a, b) exists { }`) or a scalar operand (`(a, b).size() > 1`).
      const tuple = this.tryTuple();
      if (tuple) {
        if (this.atBlock()) return wrapNot(this.finishWhereOp(this.parseConsumerBlock(tuple, this.atBlock()!, true)), notStarts);
        let e = this.parsePostfix(tuple);
        for (let i = notStarts.length - 1; i >= 0; i--) e = { kind: "unary", span: [notStarts[i]!, e.span[1]], op: "!", expr: e };
        const expr = this.parseCmp(e);
        return { kind: "scalar", span: expr.span, expr };
      }
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
    // A `first`/`single` directive is a value, never a test: the scalar grammar
    // reads it (as a value-position directive) with whatever follows it, and
    // `rejectBareLookup` turns a bare one into the lookup error.
    if (op && op.op !== "first" && op.op !== "single") return wrapNot(this.finishWhereOp(op), notStarts);
    // A scalar leaf, re-read from the first `!` so the scalar grammar gives `!`
    // its one precedence (tighter than comparison). A leaf whose whole value is
    // a negation keeps the `not` node shape (`where !active`).
    this.pos = start;
    const leaf = scalarLeaf(this.parseCmp());
    if (!this.deferLookup) this.rejectBareLookup(leaf);
    return leaf;
  }

  // A where leaf that is exactly a `first`/`single` directive (under any `!`) is
  // the select-position lookup error: a lookup is a value, and alone in `where`
  // the writer almost certainly meant `exists`.
  private rejectBareLookup(w: Where): void {
    let core: Where = w;
    while (core.kind === "not") core = core.expr;
    if (core.kind !== "scalar") return;
    let e = core.expr;
    while (e.kind === "unary" && e.op === "!") e = e.expr;
    if (e.kind === "op" && (e.op === "first" || e.op === "single")) {
      this.fail(`${e.op} { … } is a select-position lookup; in where use exists { … } / none { … } or count { … } <op> N (\`x[p]\` is \`x first { where p }\`; a lookup is a value — compare it, navigate it or require it: \`x[p].name == …\`, \`x[0]!\`)`);
    }
  }

  // `rejectBareLookup` over every leaf of a tree read with `deferLookup` on.
  private rejectBareLookups(w: Where): void {
    switch (w.kind) {
      case "and": case "or": w.parts.forEach((p) => this.rejectBareLookups(p)); return;
      case "not": case "scalar": this.rejectBareLookup(w); return;
      case "op": return;
    }
  }

  // Whether the token after a `)` (or a directive) continues a scalar
  // expression: an operator, `.`-navigation, a bracket, a postfix `!`, a range,
  // `in`, or `is`.
  private atScalarContinuation(): boolean {
    const t = this.peek();
    if (t.type === "op") return CMP_OPS.has(t.value) || ADD_OPS.has(t.value) || MUL_OPS.has(t.value) || t.value === "!";
    if (t.type === "kw") return t.value === "is";
    return t.type === "dot" || t.type === "range" || t.type === "lbracket" || (t.type === "ident" && t.value === "in");
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

  // Detect + parse a postfix consumer op `<receiver> <consumer> { <sub> }` — or
  // its implicit-`collect` forms `<receiver> { <sub> }` and `<receiver> distinct
  // { <sub> }` (0.20). Returns null (rewinding) when the lookahead is not a
  // directive. `destination` marks a follow destination block (its body admits
  // `frontier`/`depth`).
  private tryOp(inWhere: boolean, destination = false): OpNode | null {
    const start = this.pos;
    const startPos = this.start();
    let receiver: Expr;
    // An absolute reference that does not enclose this scope is an error only
    // if the tokens do form a directive (`0^docs collect { }` at the root);
    // otherwise the expression grammar gets to read them (a top-level `0^name`
    // item is a lift, with the lift's own error), so the failure is held back
    // until the lookahead has decided.
    let scopeErr: OqxError | null = null;
    if (this.at("binding")) receiver = this.bindingNode(this.next());
    else if (this.at("lparen")) {
      // A tuple receiver, `(a, b) { … }`; a single parenthesized expression is
      // grouping and never a receiver.
      const t = this.tryTuple();
      if (!t) { this.pos = start; return null; }
      receiver = t;
    } else if (this.at("ident") || this.atScopeRefAt(0)) {
      let levels = 0;
      try {
        levels = this.parseScopeRef();
      } catch (err) {
        if (!(err instanceof OqxError)) throw err;
        scopeErr = err;
        this.next(); this.next(); // the integer and the caret, as if it had parsed
        levels = 1;
      }
      if (!this.at("ident")) { this.pos = start; return null; }
      receiver = this.parseNavFrom(this.next(), levels, startPos).expr;
    } else return null;

    const op = this.atBlock();
    if (op) {
      if (scopeErr) throw scopeErr;
      if (receiver.kind === "ident" && LITERAL_WORDS.has(receiver.name)) this.fail(`\`${receiver.name}\` is a literal, not a collection`);
      // `count { }` with nothing before it: the consumer word is not a receiver.
      if (op === "collect" && receiver.kind === "ident" && CONSUMERS.has(receiver.name) && this.at("lbrace")) {
        this.fail(`unexpected '{' after \`${receiver.name}\` — a consumer needs a receiver: \`<collection> ${receiver.name} { … }\``);
      }
      return this.parseConsumerBlock(receiver, op, inWhere, destination);
    }
    this.pos = start;
    return null;
  }

  // The cursor is at what opens a block over an already-read receiver: `{` or
  // `distinct {` (the implicit `collect`), or a consumer word and `{` /
  // `distinct {`. Consumes nothing.
  private atBlock(): Consumer | null {
    if (this.at("lbrace")) return "collect";
    if (this.at("ident", "distinct") && this.peekAt(1)?.type === "lbrace") return "collect";
    return this.atConsumerBlock();
  }

  // The cursor is at a consumer word that opens a block — `<op> {` or
  // `<op> distinct {` — or, since 0.26, at the word alone: a consumer word
  // right after a complete receiver can be nothing else (OQX never places two
  // operands side by side), and it reads as the directive over the empty block
  // (`jobs first` ≡ `jobs first { }`, `_nodes exists`, `jobs count > 1`). The
  // braceless reading is off only inside the clause form's top-level `from`
  // (`bareDirectives`). Consumes nothing.
  private atConsumerBlock(): Consumer | null {
    if (!this.at("ident") || !CONSUMERS.has(this.peek().value)) return null;
    const after = this.peekAt(1);
    const opThenBrace = after?.type === "lbrace";
    const opDistinctBrace = after?.type === "ident" && after.value === "distinct" && this.peekAt(2)?.type === "lbrace";
    return opThenBrace || opDistinctBrace || this.bareDirectives ? (this.peek().value as Consumer) : null;
  }

  // `[<op>] [distinct] { <sub> }` over an already-parsed receiver; the cursor is
  // at the consumer word, at `distinct`, or at the `{` of the implicit `collect`.
  // `destination` marks a follow destination block (0.20): its body may carry
  // `frontier` and `depth`.
  private parseConsumerBlock(receiver: Expr, op: Consumer, inWhere: boolean, destination = false): OpNode {
    const startPos = receiver.span[0];
    if (this.at("ident") && CONSUMERS.has(this.peek().value)) this.next(); // the consumer word (absent for `x { … }`)
    let distinct = false;
    if (this.at("ident", "distinct")) { this.next(); distinct = true; }
    let body: BodyClauses;
    let subSpan: Span;
    if (this.at("lbrace")) {
      const lbrace = this.next().pos; // '{'
      const defer = this.deferLookup;
      this.deferLookup = false;
      // The receiver was read at the enclosing depth; the block's rows are one deeper.
      body = this.atDepth(this.depth + 1, () => this.parseBody({ top: false, op, liftsAllowed: inWhere && op === "collect", destination }));
      this.deferLookup = defer;
      if (!this.at("rbrace")) this.fail(`expected '}' to close the ${op} { … } block`);
      this.next();
      // `x collect distinct { group by k }`: the directive's distinct is as
      // redundant as the body's own (checked in parseBody).
      if (distinct && body.groupBy) this.failAt(body.groupBy.span[0], DISTINCT_WITH_GROUP);
      subSpan = this.sp(lbrace);
    } else {
      // A consumer word with no block (0.26) is the directive over the empty
      // block `{ }` — the word was written (only a brace makes a bare
      // `collect`), so nothing more is consumed; the block spans nothing, at
      // the end of the word.
      body = emptyBody();
      subSpan = [this.end(), this.end()];
    }
    const sub: Subquery = {
      kind: "subquery",
      span: subSpan,
      from: body.froms,
      where: body.where,
      select: body.select,
      orderBy: body.orderBy,
      follow: body.follow,
      frontier: body.frontier,
      depth: body.depth,
      flatten: body.flatten,
      groupBy: body.groupBy,
      having: body.having,
      values: body.values,
      limit: body.limit,
      offset: body.offset,
    };
    return this.mergeProjectionBlock(receiver, op, distinct || body.distinct, sub, startPos);
  }

  // A projection-only block over a `collect`/`first`/`single` directive whose
  // own block projects nothing IS that directive's projection (0.26):
  // `jobs[0] { name }` ≡ `jobs first { name offset 0 }`, `jobs[p] { name }` ≡
  // `jobs first { name where p }`, `jobs[0] { }` ≡ `jobs[0]`. The outer items
  // are read on the very rows the inner block filtered, at the same depth, so
  // the merge is exact — except when the outer block carries a clause of its
  // own (those run AFTER the pick: `jobs[0] { name where pay > 2 }` is the
  // first job, kept only if it pays), when the inner directive dedups
  // (`distinct` compares the projection), or when an outer alias would shadow a
  // bare name the inner `where` reads (`jobs[pay > 2] { pay: employer }`): then
  // the two directives stay.
  private mergeProjectionBlock(receiver: Expr, op: Consumer, distinct: boolean, sub: Subquery, startPos: number): OpNode {
    const plain: OpNode = { kind: "op", span: this.sp(startPos), receiver, op, sub, countCmp: null, distinct };
    if (receiver.kind !== "op" || op !== "collect") return plain;
    const inner = receiver;
    if ((inner.op !== "collect" && inner.op !== "first" && inner.op !== "single") || inner.distinct || inner.countCmp !== null) return plain;
    if (inner.sub.select.length > 0 || inner.sub.values) return plain;
    const projectionOnly = sub.from.length === 0 && sub.where === null && sub.orderBy === null && sub.follow === null && sub.frontier === null
      && sub.depth === null && sub.flatten.length === 0 && sub.groupBy === null && sub.having === null && sub.limit === null && sub.offset === null;
    if (!projectionOnly) return plain;
    if (inner.sub.where && readsAnyOf(inner.sub.where, shadowingNames(sub.select))) return plain;
    return {
      kind: "op", span: this.sp(startPos), receiver: inner.receiver, op: inner.op, countCmp: null, distinct,
      sub: { ...inner.sub, select: sub.select, values: sub.values, span: [inner.sub.span[0], sub.span[1]] },
    };
  }

  // A tuple `(e1, e2, …)` at the cursor's `(` (0.20): two or more comma-separated
  // expressions. A single parenthesized expression is grouping, not a tuple —
  // the cursor is rewound and null returned (also on a parse error, so the
  // caller's own reading reports its own error).
  private tryTuple(): Expr | null {
    const save = this.pos;
    const lparen = this.next().pos; // '('
    try {
      const items = [this.parseValueExpr()];
      if (!this.at("comma")) { this.pos = save; return null; }
      while (this.at("comma")) { this.next(); items.push(this.parseValueExpr()); }
      if (!this.at("rparen")) this.fail("expected ')' to close the tuple");
      this.next();
      return { kind: "tuple", span: [lparen, this.end()], items };
    } catch (err) {
      if (!(err instanceof OqxError)) throw err;
      this.pos = save;
      return null;
    }
  }

  // A bracket suffix on `recv` (GRAMMAR §4): `[n]` / `[${…}]` is positional —
  // `recv first { offset n }` — and anything else a predicate —
  // `recv first { where p }`; a trailing `!` makes the index required and the
  // predicate a `single` (required too, so that zero matches is an error).
  private parseBracket(recv: Expr): Expr {
    if (recv.kind === "lit" || recv.kind === "template") this.fail(`\`${describe(recv)}\` is a literal, not a collection`);
    const start = recv.span[0];
    const lbracket = this.next().pos; // '['
    let index: Expr | null = null;
    let where: Where | null = null;
    if (this.at("number") && this.peekAt(1)?.type === "rbracket") {
      const t = this.next();
      const v = Number(t.value);
      if (!Number.isInteger(v)) this.fail(`an index is a non-negative integer literal or a binding (got ${t.value})`);
      index = { kind: "lit", span: [t.pos, t.end], value: v };
    } else if (this.at("binding") && this.peekAt(1)?.type === "rbracket") {
      index = this.bindingNode(this.next());
    } else if (this.atOp("-") && this.peekAt(1)?.type === "number" && this.peekAt(2)?.type === "rbracket") {
      this.fail("negative indices are not supported (`x[-1]`): an index is a non-negative integer literal or a binding");
    } else {
      const defer = this.deferLookup;
      this.deferLookup = false;
      // The predicate is the block's `where`: read in the rows' scope, one deeper.
      where = this.atDepth(this.depth + 1, () => this.parseWhere());
      this.deferLookup = defer;
    }
    if (!this.at("rbracket")) this.fail("expected ']' to close the bracket");
    this.next();
    const subSpan: Span = [lbracket, this.end()];
    const sub = (parts: Partial<Subquery>): Subquery => ({
      kind: "subquery", span: subSpan, from: [], where: null, select: [], orderBy: null, follow: null, frontier: null, depth: null, flatten: [], groupBy: null, having: null, values: false, limit: null, offset: null, ...parts,
    });
    const bang = this.atOp("!") ? this.next() : null;
    if (index) {
      const op: OpNode = { kind: "op", span: [start, subSpan[1]], receiver: recv, op: "first", sub: sub({ offset: index }), countCmp: null, distinct: false };
      return bang ? { kind: "required", span: [start, bang.end], expr: op } : op;
    }
    if (bang) {
      const op: OpNode = { kind: "op", span: [start, bang.end], receiver: recv, op: "single", sub: sub({ where }), countCmp: null, distinct: false };
      return { kind: "required", span: [start, bang.end], expr: op };
    }
    return { kind: "op", span: [start, subSpan[1]], receiver: recv, op: "first", sub: sub({ where }), countCmp: null, distinct: false };
  }

  // ---- expression Pratt parser ----------------------------------------------
  // Value position (select/order/follow/source): full boolean+arithmetic. Each
  // level takes an optional already-parsed `left` operand (a directive read by
  // `tryOp`, a promoted where-group), so it continues into the operator tail
  // without re-reading its tokens.
  private parseValueExpr(): Expr { return this.parseOr(); }

  private parseOr(left?: Expr): Expr {
    left = this.parseAnd(left);
    while (this.atOr()) {
      this.next();
      const right = this.parseAnd();
      left = { kind: "logical", span: [left.span[0], right.span[1]], op: "||", left, right };
    }
    return left;
  }

  private parseAnd(left?: Expr): Expr {
    left = this.parseCmp(left);
    while (this.atAnd()) {
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
    const isCmp = (): boolean => (this.peek().type === "op" && CMP_OPS.has(this.peek().value)) || this.at("ident", "in") || this.at("kw", "is");
    if (!isCmp()) return lhs;
    let op = this.next().value;
    // `is` / `is not` — identity (SEMANTICS §5b); `is not` is the compound.
    if (op === "is" && this.at("kw", "not")) { this.next(); op = "is not"; }
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
    return this.startsValue(this.peek());
  }

  private startsValue(t: Token | undefined): boolean {
    if (!t) return false;
    if (t.type === "ident") return !CLAUSE_WORDS.has(t.value);
    if (t.type === "kw") return t.value === "is" || t.value === "not"; // the prefix operators
    if (t.type === "number" || t.type === "string" || t.type === "tmpl_start" ||
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
    if (this.atOp("!") || this.atOp("-") || this.at("kw", "is") || this.at("kw", "not")) {
      const tok = this.next();
      const expr = this.parseUnary();
      const span: Span = [tok.pos, expr.span[1]];
      // `is x` ≡ `!!x`, `not x` ≡ `!x`: pure sugar, both nodes spanning the sugar.
      if (tok.type === "kw") {
        const not: Expr = { kind: "unary", span, op: "!", expr };
        return tok.value === "is" ? { kind: "unary", span, op: "!", expr: not } : not;
      }
      return { kind: "unary", span, op: tok.value as "!" | "-", expr };
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
        // free function call: name(args) — a bare name read here, not `(f)(x)`;
        // an aggregate name makes it an `aggregate` node (0.24)
        expr = this.parseFreeCall(expr.name, start);
      } else if (this.at("lbracket")) {
        expr = this.parseBracket(expr);
      } else if (this.atOp("!")) {
        // Postfix `!`: a `!` right after a complete chain is `required` — OQX
        // never places two operands side by side, so it cannot begin one here.
        const bang = this.next();
        expr = { kind: "required", span: [start, bang.end], expr };
      } else if (this.atValueDirective() || this.at("lbrace") || (this.at("ident", "distinct") && this.peekAt(1)?.type === "lbrace")) {
        // A value-position directive, `recv first { … }` — how a bracket chain
        // prints back — or the implicit `collect` of a bare `{ … }` / `distinct
        // { … }` (0.20: the receiver-block sugar stands wherever a value does,
        // `size(children { is checked })`). exists/none/count have no value form
        // and are left to the body's own error.
        if (expr.kind === "lit" || expr.kind === "template") this.fail(`\`${describe(expr)}\` is a literal, not a collection`);
        expr = this.parseConsumerBlock(expr, this.atBlock()!, false);
      } else {
        break; // anything else ends the chain
      }
    }
    return expr;
  }

  // The directives that have a value form: collect/first/single, and since 0.24
  // `count { … }` (the number of rows the block yields). exists/none are
  // predicates only.
  private atValueDirective(): boolean {
    const op = this.atConsumerBlock();
    return op === "collect" || op === "first" || op === "single" || op === "count";
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
    if (t.type === "caret" || this.atAbsoluteRef()) {
      const levels = this.parseScopeRef();
      if (!this.at("ident")) this.fail("expected an identifier after '^' (an outer reference)");
      const name = this.next();
      return { kind: "outer", span: [t.pos, name.end], levels, name: name.value };
    }
    if (t.type === "number") { this.next(); return { kind: "lit", span: [t.pos, t.end], value: Number(t.value) }; }
    if (t.type === "string") { this.next(); return { kind: "lit", span: [t.pos, t.end], value: t.value }; }
    if (t.type === "tmpl_start") return this.parseTemplateLiteral();
    if (t.type === "binding") { this.next(); return this.bindingNode(t); }
    if (t.type === "lparen") {
      this.next();
      const e = this.parseValueExpr();
      if (this.at("comma")) {
        // A tuple `(e1, e2, …)` (0.20): two or more elements.
        const items = [e];
        while (this.at("comma")) { this.next(); items.push(this.parseValueExpr()); }
        if (!this.at("rparen")) this.fail("expected ')' to close the tuple");
        this.next();
        return { kind: "tuple", span: [t.pos, this.end()], items };
      }
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

  // A template literal (GRAMMAR §4, since 0.21): the cursor is at the opening
  // backtick. The lexer has already split the literal into text runs and `${ … }`
  // interpolations (with balanced braces, so an interpolation may hold a block
  // or another template literal); each interpolation holds one full value
  // expression, read at the current scope depth. `parts` alternates strictly —
  // text, expression, text, … — with a (possibly empty) text part first and last.
  private parseTemplateLiteral(): Expr {
    const open = this.next(); // the backtick
    const parts: TemplatePart[] = [];
    let text = "";
    for (;;) {
      const t = this.peek();
      if (t.type === "tmpl_text") { this.next(); text += t.value; continue; }
      if (t.type === "tmpl_end") { this.next(); break; }
      if (t.type === "tmpl_interp_start") {
        this.next();
        if (this.at("tmpl_interp_end")) {
          this.failAt(t.pos, "empty interpolation `${}` in a template literal — an interpolation holds an expression (`${name}`)");
        }
        const e = this.parseValueExpr();
        if (!this.at("tmpl_interp_end")) this.fail("expected '}' to close the `${…}` interpolation of a template literal");
        this.next();
        parts.push(text, e);
        text = "";
        continue;
      }
      // Unreachable: the lexer closes every literal it opens or fails.
      this.fail(`unexpected ${this.tokDesc()} in a template literal`);
    }
    parts.push(text);
    return { kind: "template", span: [open.pos, this.end()], parts };
  }
}

// ---- grouping helpers (0.24) --------------------------------------------------

const DISTINCT_WITH_GROUP = "`distinct` is redundant with `group by` — a grouped body already yields one row per distinct key tuple; drop `distinct`";

// The clauses `checkGroupedBody` / `rejectAggregates` look at: the body's own
// expressions, with `where` (and `resolvedHaving`) already alias-resolved.
interface GroupCheck {
  select: SelectItem[];
  /** The items with their aliases substituted (`resolveSelect`), for the aggregate checks. */
  resolvedSelect: SelectItem[];
  having: Where | null;
  resolvedHaving: Where | null;
  orderBy: OrderSpec[] | null;
  froms: Expr[];
  where: Where | null;
  frontier: Expr | null;
  flatten: readonly Flatten[];
  limit: Expr | null;
  offset: Expr | null;
  groupBy: GroupBy | null;
}

// The projection of a grouped body that writes none (SEMANTICS §24): every key
// by its name, then `count: count()`. Synthesized here so the tree shows what
// the body projects and the engine has no grouped "row itself" to define; the
// nodes carry the empty span (they did not come from source).
function defaultGroupProjection(groupBy: GroupBy, fail: (msg: string) => never): SelectItem[] {
  if (groupBy.keys.some((k) => k.name === "count")) {
    fail("a group key named `count` needs an explicit `select` — the default projection of a grouped body is its keys plus `count: count()`");
  }
  const items: SelectItem[] = groupBy.keys.map((k) => ({ kind: "field", span: [0, 0], name: k.name, expr: { kind: "ident", span: [0, 0], name: k.name }, lift: 0 }));
  items.push({ kind: "field", span: [0, 0], name: "count", expr: { kind: "aggregate", span: [0, 0], name: "count", arg: null, distinct: false }, lift: 0 });
  return items;
}

// Every aggregate node in `e` read at THIS scope (a nested block's body is its
// own scope and is not entered; a block's receiver is). An aggregate's argument
// is entered too, so a nested aggregate is found by `nestedAggregate`.
function aggregatesIn(e: Expr, out: Expr[]): void {
  switch (e.kind) {
    case "aggregate": out.push(e); if (e.arg) aggregatesIn(e.arg, out); return;
    case "lit": case "ident": case "outer": case "binding": return;
    case "member": aggregatesIn(e.recv, out); return;
    case "call": if (e.recv) aggregatesIn(e.recv, out); e.args.forEach((a) => aggregatesIn(a, out)); return;
    case "unary": case "required": aggregatesIn(e.expr, out); return;
    case "binary": case "logical": case "in": aggregatesIn(e.left, out); aggregatesIn(e.right, out); return;
    case "range": if (e.lo) aggregatesIn(e.lo, out); if (e.hi) aggregatesIn(e.hi, out); return;
    case "tuple": e.items.forEach((x) => aggregatesIn(x, out)); return;
    case "template": e.parts.forEach((p) => { if (typeof p !== "string") aggregatesIn(p, out); }); return;
    case "op": aggregatesIn(e.receiver, out); return;
  }
}

function whereAggregates(w: Where, out: Expr[]): void {
  switch (w.kind) {
    case "and": case "or": w.parts.forEach((p) => whereAggregates(p, out)); return;
    case "not": whereAggregates(w.expr, out); return;
    case "scalar": aggregatesIn(w.expr, out); return;
    case "op": aggregatesIn(w.receiver, out); return;
  }
}

// The first aggregate whose argument holds another (`sum(count())`), if any.
function nestedAggregate(found: readonly Expr[]): Expr | null {
  for (const a of found) {
    if (a.kind !== "aggregate" || !a.arg) continue;
    const inner: Expr[] = [];
    aggregatesIn(a.arg, inner);
    if (inner.length > 0) return a;
  }
  return null;
}

// The default key of an unaliased projection item: the last segment of a bare /
// dotted / outer navigation (`name`, `meta.slug` → "slug", `^name`), else null.
function navKey(e: Expr): string | null {
  switch (e.kind) {
    case "ident": return e.name;
    case "outer": return e.name;
    case "member": return e.name;
    case "required": return navKey(e.expr);
    default: return null;
  }
}

// Whether a block's leading run, read as a where tree, is syntactically a
// predicate (GRAMMAR §2): anything but a bare name, a dotted navigation or a lift
// (an `outer`), with a parenthesized leading expression always a predicate.
function predicateShaped(w: Where, first: Token): boolean {
  if (first.type === "lparen") return true;
  if (w.kind !== "scalar") return true;
  return !isNavigation(w.expr);
}

function isNavigation(e: Expr): boolean {
  switch (e.kind) {
    case "ident": case "outer": return true;
    case "member": return isNavigation(e.recv);
    default: return false;
  }
}

// The canonical text of a node for an error message; a binding shows as its
// `${n}` marker (the printer refuses to turn a bound value into source).
function describe(node: Expr | Where): string {
  const t = printTemplate(node);
  return t.strings.map((s, i) => (i < t.count ? `${s}\${${t.indices[i]}}` : s)).join("");
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
