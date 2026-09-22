// A real storage adapter: pushes the flat core of an OQX query (source scan +
// translatable conjunctive predicates, and a LIMIT for unordered first/single)
// into SQL over Node's built-in `node:sqlite`, and leaves everything it can't
// translate — nested consumer ops, `follow`, negation/disjunction, method calls
// like matches(), custom functions — as a residual the in-memory engine finishes
// over the rows SQL returned.
//
// This is imported on its own subpath (`oqx/sqlite`) so that plain consumers of
// `oqx` never pull in the experimental `node:sqlite` module.
//
// Semantics note: OQX equality is typed and strict (see semantics.ts). SQL `=`
// uses column affinity, so this adapter assumes a well-typed schema for the
// columns it pushes; anything it cannot translate faithfully stays residual.

import { DatabaseSync } from "node:sqlite";
import type { Query, Expr } from "../ast.ts";
import type { Plan, QueryPlanner } from "../planner.ts";
import { partitionPushable, residualQuery } from "../plan.ts";

export interface SqliteTableOptions {
  /** Columns that map to bare OQX fields (only these are pushable). */
  columns: readonly string[];
  /** Columns whose stored text should be JSON.parse'd back into row values. */
  jsonColumns?: readonly string[];
  /** Custom mapper from a raw SQL row to a query row (overrides jsonColumns). */
  map?: (raw: Record<string, unknown>) => unknown;
}

const RELOP_SQL: Record<string, string> = {
  "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
};
const ARITH_SQL = new Set(["+", "-", "*", "/", "%"]);

export class SqliteTable implements QueryPlanner {
  private db: DatabaseSync;
  private table: string;
  private columns: Set<string>;
  private opts: SqliteTableOptions;

  constructor(db: DatabaseSync, table: string, opts: SqliteTableOptions) {
    this.db = db;
    this.table = table;
    this.columns = new Set(opts.columns);
    this.opts = opts;
  }

  plan(query: Query, params: readonly unknown[]): Plan | null {
    if (query.source.kind !== "ident" || query.source.name !== this.table) return null;
    if (query.from.length > 0 || query.follow) return null;

    const { pushed, residual } = partitionPushable(query.where, (e) => this.translatable(e));
    const sqlParams: unknown[] = [];
    const whereSql = pushed.map((e) => this.translate(e, params, sqlParams)).join(" AND ");

    // A LIMIT is only safe when nothing is left to filter in-memory, the result
    // is unordered (first/single are "some row" without an order by), and the
    // query carries no limit/offset of its own (the residual applies those, so
    // a SQL LIMIT underneath would starve them).
    let tail = "";
    if (!residual && !query.orderBy && !query.limit && !query.offset) {
      if (query.consumer === "first") tail = " LIMIT 1";
      else if (query.consumer === "single") tail = " LIMIT 2";
    }

    const sql = `SELECT * FROM "${this.table}"${whereSql ? ` WHERE ${whereSql}` : ""}${tail}`;
    const raw = this.db.prepare(sql).all(...sqlParams.map(toSqlParam)) as Record<string, unknown>[];
    const rows = raw.map((r) => this.mapRow(r));
    return { rows: () => rows, residual: residualQuery(query, residual) };
  }

  private translatable(e: Expr): boolean {
    switch (e.kind) {
      case "lit": case "binding": return true;
      case "ident": return this.columns.has(e.name); // a bare name is always the current row's column
      case "unary": return (e.op === "!" || e.op === "-") && this.translatable(e.expr);
      case "logical": return this.translatable(e.left) && this.translatable(e.right);
      case "binary":
        return (e.op in RELOP_SQL || ARITH_SQL.has(e.op)) && this.translatable(e.left) && this.translatable(e.right);
      default: return false; // member/index/call/in/outer(^) → residual
    }
  }

  private translate(e: Expr, params: readonly unknown[], out: unknown[]): string {
    switch (e.kind) {
      case "lit": out.push(e.value); return "?";
      case "binding": out.push(params[e.index]); return "?";
      case "ident": return `"${e.name}"`;
      case "unary": return e.op === "!" ? `(NOT ${this.translate(e.expr, params, out)})` : `(-${this.translate(e.expr, params, out)})`;
      case "logical": {
        const op = e.op === "&&" ? "AND" : "OR";
        return `(${this.translate(e.left, params, out)} ${op} ${this.translate(e.right, params, out)})`;
      }
      case "binary": {
        const op = e.op in RELOP_SQL ? RELOP_SQL[e.op]! : e.op;
        return `(${this.translate(e.left, params, out)} ${op} ${this.translate(e.right, params, out)})`;
      }
      default: throw new Error(`sqlite: not translatable: ${e.kind}`);
    }
  }

  private mapRow(raw: Record<string, unknown>): unknown {
    if (this.opts.map) return this.opts.map(raw);
    if (this.opts.jsonColumns) {
      const out: Record<string, unknown> = { ...raw };
      for (const c of this.opts.jsonColumns) {
        if (typeof out[c] === "string") out[c] = JSON.parse(out[c] as string);
      }
      return out;
    }
    return raw;
  }
}

// node:sqlite accepts null | number | bigint | string | Uint8Array. Map the
// common host values that appear as bound params.
function toSqlParam(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}
