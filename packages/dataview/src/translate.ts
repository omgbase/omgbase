// The translator: a DQL query → `{ oqx, render, warnings }`.
//
// Dataview applies its data commands in the order written; OQX has one fixed
// clause order (select, from, where, group by, having, order by, limit). The
// commands are folded conservatively:
//   - every WHERE before a GROUP BY is a `where` conjunct, in order; a WHERE
//     after it is a `having` conjunct;
//   - SORTs compose: a later SORT re-sorts with the earlier order as the tie
//     break, so `SORT a SORT b` is `order by b, a`; a SORT before GROUP BY is
//     the order of the rows inside each group (carried into `rows collect { … }`);
//   - LIMIT must be the last command (OQX bounds the final row set);
//   - one GROUP BY; a second one, and FLATTEN, are `unsupported` — a FLATTEN
//     needs the page's fields next to each element, and a body-level `from`
//     re-projection drops the page (spec/oqx §2);
//   - anything else that cannot be expressed is an `unsupported` error naming
//     the construct, never a query that means something else.

import { build, type Expr, type OpNode, type OrderSpec, type SelectItem, type Where } from "@omgbase/oqx";
import type { Command, DqlQuery, Expr as DExpr, Field, SortKey } from "./ast.ts";
import { at, warn, type Ctx } from "./context.ts";
import { DqlError, unsupported } from "./errors.ts";
import { deriveField, toValue, toWhere, rowsCollect, type Typed } from "./expressions.ts";
import type { Derive } from "./fields.ts";
import { assemble, conjoin, identsOf, isUsableAlias, type GroupKey } from "./oqx.ts";
import { parseDql } from "./parser.ts";
import { sourceWhere } from "./sources.ts";

/** What the server can do, set by a client from the server's `version`:
 * `dates` — surface ≥ 4.8 (`date()`, `dur()`, the date methods); `groupBy` —
 * OQX ≥ 0.24 (`group by`, `having`, aggregates, `rows`). Both default to true
 * (the output is pure OQX). A query that needs a missing capability is refused
 * as `unsupported` naming the feature — there is no client-side fallback yet. */
export interface Capabilities {
  groupBy: boolean;
  dates: boolean;
}

export interface TranslateOptions {
  /** The current document (`this`), in either path form. */
  thisPath?: string | null;
  /** Resolve a `[[target]]` to a rooted path (the vault knows its names; the
   * translator does not). Returning null falls back to `path.endsWith("/target.md")`. */
  resolveLink?: (target: string) => string | null;
  capabilities?: Partial<Capabilities>;
}

/** One output column: Dataview's header text, the OQX alias to read the value
 * under, and — for `file.name` / `file.folder` / `file.link` / `file.ext` —
 * the client-side derivation from the `path` the alias holds. */
export interface Column {
  name: string;
  alias: string;
  derive?: Derive;
}

export interface TaskShape {
  /** The aliases of a task row: the block id, the text, the checkbox, the document. */
  id: "id";
  text: "text";
  checked: "checked";
  path: "path";
}

export type RenderShape =
  | { type: "table"; withoutId: boolean; grouped: boolean; id: Column | null; columns: Column[] }
  | { type: "list"; withoutId: boolean; grouped: boolean; id: Column | null; value: Column | null }
  /** Tasks: ungrouped, every hit is a task (`task` names its aliases); grouped,
   * `rows` is the alias of the group's task list and `id` the group key. */
  | { type: "task"; grouped: boolean; id: Column | null; rows: string | null; task: TaskShape }
  | { type: "calendar"; grouped: false; id: Column; date: Column };

export interface Translation {
  oqx: string;
  render: RenderShape;
  warnings: string[];
}

const TASK: TaskShape = { id: "id", text: "text", checked: "checked", path: "path" };

export function translate(dql: string, options: TranslateOptions = {}): Translation {
  const query = parseDql(dql);
  const caps: Capabilities = { groupBy: true, dates: true, ...(options.capabilities ?? {}) };
  const ctx: Ctx = {
    source: dql,
    target: query.type === "TASK" ? "blocks" : "docs",
    depth: 1,
    thisPath: options.thisPath ?? null,
    resolveLink: options.resolveLink ?? (() => null),
    groupKey: null,
    rowsOrder: null,
    rowsOrderUsed: false,
    features: new Set(),
    warnings: [],
  };
  const out = new Translator(query, ctx).run();
  if (!caps.groupBy && ctx.features.has("groupBy")) {
    throw unsupported("GROUP BY", "the server's OQX has no grouping (spec/oqx < 0.24); capabilities.groupBy is false", null);
  }
  if (!caps.dates && ctx.features.has("dates")) {
    throw unsupported("date() / dur()", "the server's surface has no dates (surface < 4.8); capabilities.dates is false", null);
  }
  return out;
}

class Translator {
  private readonly where: Where[] = [];
  private readonly having: Where[] = [];
  private order: OrderSpec[] = []; // the final order (ungrouped, or after GROUP BY)
  private preGroupSort: SortKey[] = [];
  private limit: number | null = null;
  private group: GroupKey | null = null;
  private groupDerive: Derive | undefined;
  private readonly aliases = new Set<string>();
  /** Every bare name the DQL reads anywhere (an `AS` alias must not shadow one). */
  private readonly referenced = new Set<string>();
  /** Every OQX identifier the select items emitted so far read. */
  private readonly seenIdents = new Set<string>();
  private readonly q: DqlQuery;
  private readonly ctx: Ctx;

  constructor(q: DqlQuery, ctx: Ctx) {
    this.q = q;
    this.ctx = ctx;
    for (const f of q.fields) dqlIdents(f.expr, this.referenced);
    for (const c of q.commands) {
      if (c.kind === "sort") for (const k of c.keys) dqlIdents(k.expr, this.referenced);
      else if (c.kind === "limit") dqlIdents(c.count, this.referenced);
      else dqlIdents(c.expr, this.referenced);
    }
  }

  run(): Translation {
    const { q, ctx } = this;
    this.aliases.add("id").add("path");
    if (q.type === "TASK") { this.aliases.add("text"); this.aliases.add("checked"); }
    if (q.type === "TASK" && q.fields.length > 0) throw new DqlError("parse", "TASK takes no fields", at(ctx, q.fields[0]!));
    if (q.from) {
      const w = sourceWhere(q.from, ctx);
      // `FROM ""` is the whole vault: no conjunct.
      if (!(w.kind === "scalar" && w.expr.kind === "lit" && w.expr.value === true)) this.where.push(w);
    }
    for (let i = 0; i < q.commands.length; i++) this.command(q.commands[i]!, i === q.commands.length - 1);
    if (this.group) ctx.features.add("groupBy");

    const select: SelectItem[] = [];
    let render: RenderShape;
    const grouped = this.group !== null;
    const idColumn: Column | null = grouped
      ? { name: "Group", alias: this.group!.alias, ...(this.groupDerive ? { derive: this.groupDerive } : {}) }
      : { name: "File", alias: "path", derive: "link" };
    select.push(grouped ? build.field(this.group!.alias, build.ident(this.group!.alias)) : build.field("path", build.ident("path")));

    switch (q.type) {
      case "TABLE": {
        const columns = q.fields.map((f, i) => this.column(f, i, select));
        render = { type: "table", withoutId: q.withoutId, grouped, id: q.withoutId ? null : idColumn, columns };
        break;
      }
      case "LIST": {
        let value: Column | null = null;
        if (q.fields.length === 1) {
          const f = q.fields[0]!;
          const v = toValue(f.expr, ctx);
          select.push(item("value", v));
          value = { name: f.alias ?? f.text, alias: "value", ...(v.derive ? { derive: v.derive } : {}) };
        }
        render = { type: "list", withoutId: q.withoutId, grouped, id: q.withoutId ? null : idColumn, value };
        break;
      }
      case "TASK": {
        if (grouped) {
          select.push(build.collect("tasks", rowsCollect(ctx) as OpNode));
          ctx.rowsOrderUsed = true;
          render = { type: "task", grouped: true, id: idColumn, rows: "tasks", task: TASK };
        } else {
          for (const n of ["id", "text", "checked"]) select.push(build.field(n, build.ident(n)));
          render = { type: "task", grouped: false, id: idColumn, rows: null, task: TASK };
        }
        this.where.unshift(build.scalar(build.binary("==", build.ident("type"), build.lit("task"))));
        break;
      }
      case "CALENDAR": {
        if (grouped) throw unsupported("CALENDAR … GROUP BY", "a calendar places pages, not groups", at(ctx, q.commands.find((c) => c.kind === "group")!));
        const f = q.fields[0]!;
        const v = toValue(f.expr, ctx);
        if (v.derive) throw unsupported(`CALENDAR ${f.text}`, "the calendar field must be a date", at(ctx, f));
        select.push(item("date", v));
        // Pages without the field have no day (Dataview omits them).
        this.where.push(build.scalar(build.call(null, "has", [build.ident("date")])));
        render = { type: "calendar", grouped: false, id: idColumn!, date: { name: f.alias ?? f.text, alias: "date" } };
        break;
      }
    }

    if (ctx.rowsOrder && !ctx.rowsOrderUsed) {
      warn(ctx, "SORT before GROUP BY orders the rows inside each group, and no column reads the rows — it has no effect");
    }

    const oqx = assemble({
      select,
      source: ctx.target,
      where: conjoin(this.where),
      groupBy: this.group ? [this.group] : [],
      having: conjoin(this.having),
      orderBy: this.order,
      limit: this.limit,
    });
    return { oqx, render, warnings: [...ctx.warnings] };
  }

  private command(c: Command, last: boolean): void {
    const { ctx } = this;
    if (this.limit !== null) throw unsupported(`${c.kind.toUpperCase()} after LIMIT`, "OQX bounds the final row set; LIMIT must be the last command", at(ctx, c));
    switch (c.kind) {
      case "where":
        (this.group ? this.having : this.where).push(toWhere(c.expr, ctx));
        return;
      case "sort": {
        if (this.group) {
          // A later SORT re-sorts; the earlier order breaks its ties.
          this.order = [...c.keys.map((k) => this.orderSpec(k)), ...this.order];
        } else {
          this.preGroupSort = [...c.keys, ...this.preGroupSort];
          this.order = [...c.keys.map((k) => this.orderSpec(k)), ...this.order];
        }
        return;
      }
      case "limit": {
        if (!last) throw unsupported("LIMIT", "OQX bounds the final row set; LIMIT must be the last command", at(ctx, c));
        if (c.count.kind !== "number" || !Number.isInteger(c.count.value) || c.count.value < 0) {
          throw unsupported("LIMIT <expr>", "the limit must be a non-negative integer literal", at(ctx, c.count));
        }
        this.limit = c.count.value;
        return;
      }
      case "group": {
        if (this.group) throw unsupported("a second GROUP BY", "OQX groups once; grouping the groups is not expressible", at(ctx, c));
        const v = toValue(c.expr, ctx);
        if (v.rows) throw unsupported("GROUP BY rows", "the key must be a scalar", at(ctx, c));
        // `file.link` groups by the document (its path IS the key); a basename or
        // dirname key would need a function OQX lacks — grouping by path instead
        // would silently make one group per document.
        if (v.derive && v.derive !== "link") {
          throw unsupported(`GROUP BY ${deriveField(v.derive)}`, "OQX has no basename/dirname, and grouping by the path would mean one group per document", at(ctx, c));
        }
        let alias = "key";
        if (c.alias !== null) {
          if (!isUsableAlias(c.alias) || this.aliases.has(c.alias)) throw unsupported(`GROUP BY … AS ${c.alias}`, "the key's name must be an OQX identifier other than id/path", at(ctx, c));
          alias = c.alias;
        }
        this.aliases.add(alias);
        this.group = { alias, expr: v.expr };
        this.groupDerive = v.derive;
        // The pre-group order becomes the order of the rows inside each group.
        ctx.rowsOrder = this.order.length > 0 ? this.order : null;
        this.order = [];
        ctx.groupKey = alias;
        return;
      }
      case "flatten":
        throw unsupported("FLATTEN", "one row per element next to the page's fields is not expressible in OQX (a `from` re-projection drops the page); filter the list with a nested block instead", at(ctx, c));
    }
  }

  private orderSpec(k: SortKey): OrderSpec {
    const v = toValue(k.expr, this.ctx);
    if (v.rows) throw unsupported("SORT rows", "the rows collection does not order", at(this.ctx, k));
    if (v.derive) {
      warn(this.ctx, `SORT ${sourceOf(this.ctx, k)} orders by the full path (OQX has no basename/dirname)`);
    }
    return build.order(v.expr, k.desc);
  }

  private column(f: Field, i: number, select: SelectItem[]): Column {
    const v = toValue(f.expr, this.ctx);
    const alias = this.alias(f, v, i);
    const it = item(alias, v);
    select.push(it);
    identsOf(it, this.seenIdents);
    return { name: f.alias ?? f.text, alias, ...(v.derive ? { derive: v.derive } : {}) };
  }

  /** The OQX alias of a column: the `AS` name when it is a usable identifier,
   * else the field's own name when the value is a bare field, else `c<i>`.
   *
   * An OQX select alias shadows a same-named field in `where`, `order by` and
   * the items to its right, and may not be referenced by an item to its left
   * (spec/oqx GRAMMAR §3) — so an `AS` name never takes a name the query reads
   * elsewhere, and a bare field keeps its own name only when no earlier item
   * read it (`due, due` is `due, c1: due`; `file.mtime AS mtime, file.mtime` is
   * `mtime: updated_at, c1: updated_at`). */
  private alias(f: Field, v: Typed, i: number): string {
    const free = (c: string): boolean => isUsableAlias(c) && !c.startsWith("$") && !this.aliases.has(c) && !this.seenIdents.has(c);
    if (f.alias !== null && free(f.alias) && !this.referenced.has(f.alias)) { this.aliases.add(f.alias); return f.alias; }
    if (v.expr.kind === "ident" && !v.derive && free(v.expr.name)) { this.aliases.add(v.expr.name); return v.expr.name; }
    let n = i;
    while (this.aliases.has(`c${n}`) || this.referenced.has(`c${n}`) || this.seenIdents.has(`c${n}`)) n++;
    this.aliases.add(`c${n}`);
    return `c${n}`;
  }
}

/** A select item for a translated value: a `collect` item when the value is a
 * directive (`rows collect { … }`, `in_links collect { from doc }`), else a field. */
function item(alias: string, v: Typed): SelectItem {
  const e: Expr = v.expr;
  if (e.kind === "op" && (e.op === "collect" || e.op === "first" || e.op === "single")) return build.collect(alias, e);
  return build.field(alias, e);
}

function sourceOf(ctx: Ctx, node: { start: number; end: number }): string {
  return ctx.source.slice(node.start, node.end);
}

/** Every bare identifier (and member-chain head) a DQL expression reads. */
function dqlIdents(e: DExpr, into: Set<string>): void {
  switch (e.kind) {
    case "ident": into.add(e.name); return;
    case "member": dqlIdents(e.object, into); return;
    case "index": dqlIdents(e.object, into); dqlIdents(e.index, into); return;
    case "call": for (const a of e.args) dqlIdents(a, into); return;
    case "list": for (const i of e.items) dqlIdents(i, into); return;
    case "object": for (const en of e.entries) dqlIdents(en.value, into); return;
    case "neg": case "not": case "paren": dqlIdents(e.expr, into); return;
    case "binary": dqlIdents(e.left, into); dqlIdents(e.right, into); return;
    case "lambda": dqlIdents(e.body, into); return;
    default: return;
  }
}
