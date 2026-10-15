// OQX text assembly. Expressions, select items and `where` trees are built as
// `@omgbase/oqx` AST nodes (`build.*`) and written by the canonical printer, so
// quoting, escapes and minimal parentheses are the language's own; the clauses
// the 0.23 AST has no node for yet — `group by` / `having` (spec/oqx 0.24, in
// flight) — are assembled here as text in the fixed clause order. This is the
// one module to revise when the grouping syntax lands in the AST.

import { build, print, visit, type Expr, type OrderSpec, type SelectItem, type Where } from "@omgbase/oqx";

/** An OQX identifier (GRAMMAR §1): `[A-Za-z_$][A-Za-z0-9_$]*`. */
export function isOqxIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Words that can never be a bare field (spec/surface §1.2). */
const RESERVED_WORDS: ReadonlySet<string> = new Set(["select", "from", "where", "is", "not", "and", "or", "true", "false", "null"]);

export function isUsableAlias(name: string): boolean {
  return isOqxIdent(name) && !RESERVED_WORDS.has(name);
}

/** A select item: the bare name when the item is just a same-named field
 * (`path`, not the printer's `path: path`), else the canonical `alias: expr`. */
export function printItem(item: SelectItem): string {
  if (item.kind === "field" && item.lift === 0 && item.expr.kind === "ident" && item.expr.name === item.name) return item.name;
  return print(item);
}

export function printExpr(e: Expr): string {
  return print(e);
}

export function printWhere(w: Where): string {
  return print(w);
}

export function printOrder(specs: OrderSpec[]): string {
  return specs.map((o) => print(o)).join(", ");
}

/** The AND of several `where` trees (null when there are none); nested ANDs
 * are flattened so `a and b and c` prints without parentheses. */
export function conjoin(parts: Where[]): Where | null {
  const flat: Where[] = [];
  for (const p of parts) {
    if (p.kind === "and") flat.push(...p.parts);
    else flat.push(p);
  }
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0]!;
  return build.and(flat);
}

/** The OR of several `where` trees, nested ORs flattened. */
export function disjoin(parts: Where[]): Where {
  const flat: Where[] = [];
  for (const p of parts) {
    if (p.kind === "or") flat.push(...p.parts);
    else flat.push(p);
  }
  if (flat.length === 1) return flat[0]!;
  return build.or(flat);
}

/** A grouping key: `alias: expr`, the spec/oqx 0.24 spelling. */
export interface GroupKey {
  alias: string;
  expr: Expr;
}

export interface QueryText {
  select: SelectItem[];
  source: string; // `docs` | `blocks`
  where: Where | null;
  groupBy: GroupKey[];
  having: Where | null;
  orderBy: OrderSpec[];
  limit: number | null;
}

/** The whole query in the fixed clause order: select, from, where, group by,
 * having, order by, limit. */
export function assemble(q: QueryText): string {
  const clauses: string[] = [];
  clauses.push(`select ${q.select.map(printItem).join(", ")}`);
  clauses.push(`from ${q.source}`);
  if (q.where) clauses.push(`where ${printWhere(q.where)}`);
  if (q.groupBy.length > 0) clauses.push(`group by ${q.groupBy.map((k) => `${k.alias}: ${print(k.expr)}`).join(", ")}`);
  if (q.having) clauses.push(`having ${printWhere(q.having)}`);
  if (q.orderBy.length > 0) clauses.push(`order by ${printOrder(q.orderBy)}`);
  if (q.limit !== null) clauses.push(`limit ${q.limit}`);
  return clauses.join(" ");
}

/** Escape a literal for use inside an OQX regex (SEMANTICS §11 baseline). */
export function regexEscape(s: string): string {
  return s.replace(/[.*+?()[\]{}|^$\\]/g, "\\$&");
}

/** Every bare identifier an OQX expression reads (the names a later select
 * alias must not take: an alias may be referenced only by the items to its right). */
export function identsOf(e: Expr | Where | SelectItem, into: Set<string> = new Set()): Set<string> {
  visit(e, { enter(node) { if (node.kind === "ident") into.add(node.name); } });
  return into;
}
