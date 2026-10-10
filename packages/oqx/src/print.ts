// The canonical printer (spec/oqx/AST.md §6): the one source text of a tree.
// Single spaces, double-quoted strings with GRAMMAR §1 escapes, the minimal
// parentheses the precedence table (GRAMMAR §4) needs, `select` written at the
// top level, every option in its canonical position. The law both spec runners
// enforce over every fixture query:
//
//   strip(parse(print(parse(q)))) ≡ strip(parse(q))
//
// `print(parse(q)) == q` is NOT a law — the printer normalizes spelling. A
// binding is a value, never source text: `print` throws on one; `printTemplate`
// emits template fragments around each binding instead.

import type { AstNode, Expr, Follow, OpNode, OrderSpec, Query, SelectItem, Subquery, Where } from "./ast.ts";
import { OqxError } from "./errors.ts";

/** The template form of a tree: `strings` has `count + 1` fragments; the i-th gap
 * stands for the binding `indices[i]` of the printed tree, so a caller re-runs it
 * as `parseTemplate(strings, count)` with the values permuted by `indices`. In a
 * tree straight from `parseTemplate`, `indices` is `0..count-1` unless the
 * canonical clause order moved a binding past another (`${0} collect { x: ${1} }`
 * prints as `select x: ${1} from ${0}`). */
export interface Template {
  strings: string[];
  count: number;
  indices: number[];
}

/** The canonical source of a node. Throws (`OqxError`, stage `print`) on a binding. */
export function print(node: AstNode): string {
  let text = "";
  for (const p of render(node)) {
    if (typeof p === "number") {
      throw new OqxError(`cannot print binding \${${p}}: a binding is a value, not source text — use printTemplate`, "print");
    }
    text += p;
  }
  return text;
}

/** The canonical source of a node as template fragments, one gap per binding. */
export function printTemplate(node: AstNode): Template {
  const strings: string[] = [];
  const indices: number[] = [];
  let current = "";
  for (const p of render(node)) {
    if (typeof p === "number") { strings.push(current); current = ""; indices.push(p); }
    else current += p;
  }
  strings.push(current);
  return { strings, count: indices.length, indices };
}

// Output is a list of pieces: source text, or a binding index standing where the
// binding goes (so a template can be split exactly there).
type Out = (string | number)[];

const cat = (...xs: (string | Out)[]): Out => xs.flatMap((x) => (typeof x === "string" ? [x] : x));
const join = (parts: Out[], sep: string): Out => parts.flatMap((p, i) => (i === 0 ? p : [sep, ...p]));
const paren = (o: Out, yes: boolean): Out => (yes ? cat("(", o, ")") : o);

// Precedence levels of GRAMMAR §4, loosest to tightest. A child is parenthesized
// when its level is below what its position requires.
const OR = 1, AND = 2, CMP = 3, RANGE = 4, ADD = 5, MUL = 6, UNARY = 7, POSTFIX = 8, PRIMARY = 9;

function prec(e: Expr): number {
  switch (e.kind) {
    case "lit": case "ident": case "outer": case "binding": return PRIMARY;
    case "member": case "call": return POSTFIX;
    case "unary": return UNARY;
    case "binary": return e.op === "+" || e.op === "-" ? ADD : e.op === "*" || e.op === "/" || e.op === "%" ? MUL : CMP;
    case "in": return CMP;
    case "range": return RANGE;
    case "logical": return e.op === "&&" ? AND : OR;
  }
}

function render(n: AstNode): Out {
  switch (n.kind) {
    case "query": return query(n);
    case "subquery": return block(n);
    case "op": return op(n);
    case "follow": return follow(n);
    case "order": return order(n);
    case "field": case "collect": return item(n);
    case "and": case "or": case "not": case "scalar": return where(n);
    default: return expr(n);
  }
}

// ---- query / bodies ---------------------------------------------------------

function query(q: Query): Out {
  // Body form for `collect` — unless the query carries body-level `from`
  // re-projections, which only a block can hold (a second top-level `from` is a
  // duplicate clause): then the directive form `source collect { … from E }`.
  if (q.consumer === "collect" && q.from.length === 0) {
    // `select` is always written — except for a leading bare item literally
    // named `distinct`, which the keyword would swallow as the modifier.
    const first = q.select[0];
    const bareDistinct = !q.distinct && first?.kind === "field" && first.name === "distinct"
      && first.expr.kind === "ident" && first.expr.name === "distinct";
    const clauses: Out[] = [];
    if (q.select.length > 0) {
      const items = projection(q.select, q.values);
      clauses.push(bareDistinct ? items : cat(`select ${q.distinct ? "distinct " : ""}`, items));
    }
    clauses.push(cat("from ", expr(q.source)));
    clauses.push(...tail(q));
    return join(clauses, " ");
  }
  // Directive form: `<source> <consumer> [distinct] { body }`.
  return cat(expr(q.source), ` ${q.consumer}${q.distinct ? " distinct" : ""} `, braces(body(q)));
}

type Body = Pick<Subquery, "select" | "values" | "from" | "where" | "follow" | "orderBy" | "limit" | "offset">;

// The clauses after `from` (a query) or after the projection (a block): the
// fixed clause order, each present clause once.
function tail(b: Omit<Body, "select" | "values">): Out[] {
  const out: Out[] = [];
  for (const e of b.from) out.push(cat("from ", expr(e)));
  if (b.where) out.push(cat("where ", where(b.where)));
  if (b.follow) out.push(follow(b.follow));
  if (b.orderBy && b.orderBy.length > 0) out.push(cat("order by ", join(b.orderBy.map(order), ", ")));
  if (b.limit) out.push(cat("limit ", expr(b.limit)));
  if (b.offset) out.push(cat("offset ", expr(b.offset)));
  return out;
}

// A block body: the projection leads without its keyword (the body's first
// clause is always the projection, so the keyword adds nothing there).
function body(b: Body): Out[] {
  const clauses: Out[] = [];
  if (b.select.length > 0) clauses.push(projection(b.select, b.values));
  clauses.push(...tail(b));
  return clauses;
}

function block(sub: Subquery): Out {
  return braces(body(sub));
}

function braces(clauses: Out[]): Out {
  return clauses.length === 0 ? ["{ }"] : cat("{ ", join(clauses, " "), " }");
}

function projection(items: SelectItem[], values: boolean): Out {
  return cat(join(items.map(item), ", "), values ? " values" : "");
}

function item(it: SelectItem): Out {
  if (it.kind === "collect") return cat(`${it.name}: `, op(it.op));
  return cat("^".repeat(it.lift), it.name === "" ? "" : `${it.name}: `, expr(it.expr));
}

function order(o: OrderSpec): Out {
  return cat(expr(o.expr), o.desc ? " desc" : "");
}

function op(o: OpNode): Out {
  return cat(
    expr(o.receiver),
    ` ${o.op}${o.distinct ? " distinct" : ""} `,
    block(o.sub),
    o.countCmp ? ` ${o.countCmp.op} ${number(o.countCmp.value)}` : "",
  );
}

function follow(f: Follow): Out {
  const dests = join(f.destinations.map((d) => (d.kind === "op" ? op(d) : expr(d))), ", ");
  const opts: Out[] = [];
  if (f.where) opts.push(cat("where ", expr(f.where)));
  if (f.frontier) opts.push(cat("frontier ", expr(f.frontier)));
  if (f.depth !== null) opts.push([`depth ${f.depth}`]);
  if (f.by) opts.push(cat("by ", expr(f.by)));
  return cat(`follow${f.distinct ? " distinct" : ""} `, dests, opts.length > 0 ? cat(" { ", join(opts, " "), " }") : "");
}

// ---- where ------------------------------------------------------------------

function where(w: Where): Out {
  switch (w.kind) {
    case "and": return join(w.parts.map((p) => paren(where(p), p.kind === "or" || p.kind === "and")), " && ");
    case "or": return join(w.parts.map((p) => paren(where(p), p.kind === "or")), " || ");
    case "not": {
      const inner = w.expr;
      // The operand of `!` is a consumer test, a group, or a scalar primary —
      // a comparison or anything looser must be grouped (`!(a == b)`).
      const grouped = inner.kind === "and" || inner.kind === "or" || (inner.kind === "scalar" && prec(inner.expr) < UNARY);
      return cat("!", paren(where(inner), grouped));
    }
    case "scalar": return expr(w.expr);
    case "op": return op(w);
  }
}

// ---- expressions ------------------------------------------------------------

function expr(e: Expr): Out {
  switch (e.kind) {
    case "lit": return [literal(e.value)];
    case "ident": return [e.name];
    case "outer": return ["^".repeat(e.levels) + e.name];
    case "binding": return [e.index];
    case "member": return cat(receiver(e.recv), `.${e.name}`);
    case "call": {
      const args = cat("(", join(e.args.map(expr), ", "), ")");
      return e.recv === null ? cat(e.name, args) : cat(receiver(e.recv), `.${e.name}`, args);
    }
    case "unary": return cat(e.op, operand(e.expr, UNARY));
    case "binary": {
      const p = prec(e);
      // Left-associative arithmetic keeps an equal-level left operand bare and
      // groups an equal-level right one; a comparison is non-associative, so a
      // nested comparison is grouped on either side.
      return cat(operand(e.left, p === CMP ? p + 1 : p), ` ${e.op} `, operand(e.right, p + 1));
    }
    case "logical": {
      const p = prec(e);
      return cat(operand(e.left, p), ` ${e.op} `, operand(e.right, p + 1));
    }
    case "in": return cat(operand(e.left, CMP + 1), " in ", operand(e.right, CMP + 1));
    case "range":
      return cat(e.lo ? operand(e.lo, ADD) : "", e.exclusiveEnd ? "..." : "..", e.hi ? operand(e.hi, ADD) : "");
  }
}

// A child expression, parenthesized when its level is below `min`.
function operand(e: Expr, min: number): Out {
  return paren(expr(e), prec(e) < min);
}

// The value a `.name` navigates: postfix level, and a number literal is grouped
// too (`1.size()` would lex as a malformed number).
function receiver(e: Expr): Out {
  return paren(expr(e), prec(e) < POSTFIX || (e.kind === "lit" && typeof e.value === "number"));
}

function literal(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return number(v);
  return quote(v);
}

/** A number in the shortest round-trip form (`String(n)`); the lexer reads every
 * spelling JavaScript produces for a finite number, including `1e+21`. */
function number(n: number): string {
  return String(n);
}

/** A double-quoted string literal with the GRAMMAR §1 escapes. */
function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\n": out += "\\n"; break;
      case "\t": out += "\\t"; break;
      case "\r": out += "\\r"; break;
      case "\0": out += "\\0"; break;
      default: out += ch;
    }
  }
  return out + '"';
}
