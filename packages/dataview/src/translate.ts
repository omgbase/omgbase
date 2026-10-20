// The translator: a DQL query → `{ oqx, render, warnings }`.
//
// Dataview applies its data commands in the order written; OQX has one fixed
// clause order (select, from, where, flatten…, group by, having, order by,
// limit). The commands are folded conservatively:
//   - every WHERE before a GROUP BY is a `where` conjunct, in order; a WHERE
//     after it is a `having` conjunct; a WHERE after a FLATTEN is split by what
//     each conjunct reads (below, "the WHERE split");
//   - SORTs compose: a later SORT re-sorts with the earlier order as the tie
//     break, so `SORT a SORT b` is `order by b, a`; a SORT before GROUP BY is
//     the order of the rows inside each group (carried into `rows collect { … }`);
//   - LIMIT must be the last command (OQX bounds the final row set);
//   - FLATTENs chain in order as `flatten <expr> as <name>` clauses (spec/oqx
//     0.25); a FLATTEN after GROUP BY has no place in the clause order;
//   - one GROUP BY; a second one is `unsupported`;
//   - anything else that cannot be expressed is an `unsupported` error naming
//     the construct, never a query that means something else.
//
// The WHERE split. OQX's `where` runs BEFORE `flatten` (SEMANTICS §25) and
// there is no post-flatten filter on ungrouped rows, so a Dataview `WHERE`
// written after a `FLATTEN` is split at its top-level `&`/`and` into conjuncts:
//   - a conjunct that reads only the page (no bound name) → the body `where` —
//     Dataview applies commands sequentially, but a page predicate holds the
//     same before and after the fan-out, so moving it is semantics-preserving;
//   - a conjunct that reads only ONE bound element → that flatten's block
//     (`flatten _blocks collect { where _type == "task" and checked } as t`):
//     filtering the elements before the fan-out is filtering the flattened rows
//     by the element, and a parent whose elements all fail yields no row —
//     Dataview's result for the same WHERE;
//   - a conjunct that mixes the element with the page, or two bound names
//     (`t.completed & status = "open"` as one `|`-joined predicate, `a.x = b.y`)
//     → `unsupported` naming the construct: it has no spelling.
// Two refinements: an implicit list field (`file.tags`, `file.aliases`) always
// gets a block (`_tags collect { }`), because Dataview's value is `[]` on a page
// without tags — no row — while OQX fans an absent value out to one row (§25);
// an authored field with an element conjunct is read through `list(…)` (a block
// over a scalar is an eval error; `list` makes a scalar a one-row collection and
// leaves a list alone), which drops a page where the field is absent (warned —
// Dataview keeps a null row there when the test passes null).

import { build, type Expr, type Flatten, type OpNode, type OrderSpec, type SelectItem, type Subquery, type Where } from "@omgbase/oqx";
import type { Command, DqlQuery, Expr as DExpr, Field, Node, SortKey } from "./ast.ts";
import { at, nested, warn, type Bound, type Ctx, type ElementKind } from "./context.ts";
import { DqlError, unsupported } from "./errors.ts";
import {
  TASK_ID_ALIAS, deriveField, rowsCollect, segments, taskSelect, toValue, toWhere, type Typed,
} from "./expressions.ts";
import { TASK_FIELDS, type Derive } from "./fields.ts";
import { assemble, conjoin, identsOf, isUsableAlias, type GroupKey } from "./oqx.ts";
import { parseDql } from "./parser.ts";
import { sourceWhere } from "./sources.ts";

/** What the server can do, set by a client from the server's `version`:
 * `dates` — surface ≥ 4.8 (`date()`, `dur()`, the date methods); `groupBy` —
 * OQX ≥ 0.24 (`group by`, `having`, aggregates, `rows`); `flatten` — OQX ≥ 0.25
 * (`flatten <expr> as <name>`). All default to true (the output is pure OQX). A
 * query that needs a missing capability is refused as `unsupported` naming the
 * feature — there is no client-side fallback yet. */
export interface Capabilities {
  groupBy: boolean;
  dates: boolean;
  flatten: boolean;
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
 * the client-side derivation from the `_path` the alias holds. */
export interface Column {
  name: string;
  alias: string;
  derive?: Derive;
}

/** The aliases of a task row: the block id, the text, the checkbox, the
 * document. On a plain TASK query every hit is a task block and the aliases
 * are the attributes themselves (`_id`, `_text`, `checked`, `_path`); on a TASK
 * query re-rooted at the page by `FLATTEN file.tasks`, `_id`/`_path` are the
 * page's envelope, so the task's id is projected as `task_id` and its text and
 * checkbox as `text` / `checked`. */
export interface TaskShape {
  id: string;
  text: string;
  checked: string;
  path: "_path";
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

const TASK: TaskShape = { id: "_id", text: "_text", checked: "checked", path: "_path" };
const TASK_FLATTENED: TaskShape = { id: TASK_ID_ALIAS, text: "text", checked: "checked", path: "_path" };

/** Names a `FLATTEN … AS` may not take beside the engine's `_` namespace (see
 * `bindName`): the translator's own words. */
const UNBINDABLE: ReadonlySet<string> = new Set(["file", "this", "rows", "key"]);

export function translate(dql: string, options: TranslateOptions = {}): Translation {
  const query = parseDql(dql);
  const caps: Capabilities = { groupBy: true, dates: true, flatten: true, ...(options.capabilities ?? {}) };
  const ctx: Ctx = {
    source: dql,
    target: query.type === "TASK" ? "blocks" : "docs",
    depth: 1,
    thisPath: options.thisPath ?? null,
    resolveLink: options.resolveLink ?? (() => null),
    bound: new Map(),
    element: null,
    taskBound: null,
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
  if (!caps.flatten && ctx.features.has("flatten")) {
    throw unsupported("FLATTEN", "the server's OQX has no flatten (spec/oqx < 0.25); capabilities.flatten is false", null);
  }
  if (!caps.dates && ctx.features.has("dates")) {
    throw unsupported("date() / dur()", "the server's surface has no dates (surface < 4.8); capabilities.dates is false", null);
  }
  return out;
}

/** One `FLATTEN` as it will be emitted: the bound name, the value's receiver
 * expression, and its block (null when the value is flattened as it is). An
 * element-only WHERE conjunct lands in `bound.block`; the block is built from
 * both when the query is assembled. */
interface FlattenSpec {
  bound: Bound;
  receiver: Expr;
  sub: Subquery | null;
  node: Node;
}

class Translator {
  private readonly where: Where[] = [];
  private readonly having: Where[] = [];
  private order: OrderSpec[] = []; // the final order (ungrouped, or after GROUP BY)
  private preGroupSort: SortKey[] = [];
  private limit: number | null = null;
  private group: GroupKey | null = null;
  private groupDerive: Derive | undefined;
  private readonly flattens: FlattenSpec[] = [];
  /** On a TASK query re-rooted at the page: the `FLATTEN file.tasks` command and its bound name. */
  private taskFlatten: { command: Command & { kind: "flatten" }; bound: Bound } | null = null;
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
      // A FLATTEN's name is read by every later clause: a column alias never takes it.
      if (c.kind === "flatten") { const n = flattenName(c); if (n !== null) this.referenced.add(n); }
    }
  }

  run(): Translation {
    const { q, ctx } = this;
    this.aliases.add("_id").add("_path");
    if (q.type === "TASK" && q.fields.length > 0) throw new DqlError("parse", "TASK takes no fields", at(ctx, q.fields[0]!));
    if (q.type === "TASK") { this.aliases.add("_text").add("text").add("checked"); this.rerootTask(); }
    if (this.taskFlatten) this.aliases.add(TASK_ID_ALIAS);
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
      : { name: "File", alias: "_path", derive: "link" };
    select.push(grouped ? build.field(this.group!.alias, build.ident(this.group!.alias)) : build.field("_path", build.ident("_path")));

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
        const shape = this.taskFlatten ? TASK_FLATTENED : TASK;
        if (grouped) {
          select.push(build.collect("tasks", rowsCollect(ctx) as OpNode));
          ctx.rowsOrderUsed = true;
          render = { type: "task", grouped: true, id: idColumn, rows: "tasks", task: shape };
        } else {
          if (this.taskFlatten) select.push(...taskSelect(this.taskFlatten.bound.name).slice(1));
          else for (const n of ["_id", "_text", "checked"]) select.push(build.field(n, build.ident(n)));
          render = { type: "task", grouped: false, id: idColumn, rows: null, task: shape };
        }
        // Every row of a plain TASK query is a task block; re-rooted at the page, the flatten's block says so.
        if (!this.taskFlatten) this.where.unshift(build.scalar(build.binary("==", build.ident("_type"), build.lit("task"))));
        break;
      }
      case "CALENDAR": {
        if (grouped) throw unsupported("CALENDAR … GROUP BY", "a calendar places pages, not groups", at(ctx, q.commands.find((c) => c.kind === "group")!));
        const f = q.fields[0]!;
        if (this.ownerOf(f.expr) !== "page") {
          throw unsupported("CALENDAR <flattened element>", "the calendar's date must be a page field: OQX drops pages without the date before the fan-out", at(ctx, f));
        }
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
      flatten: this.flattens.map((f) => this.flattenClause(f)),
      groupBy: this.group ? [this.group] : [],
      having: conjoin(this.having),
      orderBy: this.order,
      limit: this.limit,
    });
    return { oqx, render, warnings: [...ctx.warnings] };
  }

  /** A TASK query with a `FLATTEN file.tasks` (or `file.lists`) is re-rooted at
   * the page: the rows are documents, each task bound by the flatten, and the
   * bare task fields read the bound task. The only other reading — a task row
   * fanned out over its own page's tasks — is a cross product of a task with its
   * siblings, which no Dataview author means. Decided before the FROM and the
   * commands are translated, since every spelling depends on the target. */
  private rerootTask(): void {
    const { q, ctx } = this;
    const taskFlattens = q.commands.filter((c): c is Command & { kind: "flatten" } => c.kind === "flatten" && isTaskList(c.expr) !== null);
    if (taskFlattens.length === 0) return;
    if (taskFlattens.length > 1) throw unsupported("a second FLATTEN file.tasks", "a TASK query fans the page's tasks out once", at(ctx, taskFlattens[1]!));
    const command = taskFlattens[0]!;
    const bound: Bound = { name: this.bindName(command), kind: isTaskList(command.expr)!, block: [] };
    ctx.target = "docs";
    ctx.taskBound = bound;
    this.taskFlatten = { command, bound };
  }

  private command(c: Command, last: boolean): void {
    const { ctx } = this;
    if (this.limit !== null) throw unsupported(`${c.kind.toUpperCase()} after LIMIT`, "OQX bounds the final row set; LIMIT must be the last command", at(ctx, c));
    switch (c.kind) {
      case "where":
        if (this.group) { this.having.push(toWhere(c.expr, ctx)); return; }
        if (ctx.bound.size === 0 && !ctx.taskBound) { this.where.push(toWhere(c.expr, ctx)); return; }
        this.splitWhere(c);
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
          if (!isUsableAlias(c.alias) || c.alias.startsWith("_") || this.aliases.has(c.alias)) throw unsupported(`GROUP BY … AS ${c.alias}`, "the key's name must be an OQX identifier outside the engine's `_` namespace (and not _id/_path)", at(ctx, c));
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
        this.flatten(c);
        return;
    }
  }

  /** `FLATTEN <expr> [AS name]` → `flatten <expr> as <name>` (spec/oqx 0.25). */
  private flatten(c: Command & { kind: "flatten" }): void {
    const { ctx } = this;
    if (this.group) throw unsupported("FLATTEN after GROUP BY", "OQX's clause order puts flatten before group by: flatten first, then group", at(ctx, c));
    ctx.features.add("flatten");
    // The re-rooted TASK query's flatten was bound before the commands ran.
    const bound: Bound = this.taskFlatten?.command === c
      ? this.taskFlatten.bound
      : { name: this.bindName(c), kind: "value", block: [] };
    const spec = this.flattenValue(c, bound);
    this.flattens.push(spec);
    ctx.bound.set(bound.name, bound);
  }

  /** The name a FLATTEN binds: its `AS`, else the last segment of a field path
   * (Dataview names `FLATTEN file.tasks` `tasks`); anything else needs `AS`. A
   * name in the engine's `_` namespace is refused: the hit envelope (`_id`,
   * `_path`) cannot be rebound, and a bound `_x` would shadow (or pose as) an
   * engine field. Bare names are the user's, so `tags`, `id`, `path` bind as
   * any authored key would (a `FLATTEN file.tags` binds `tags` beside `_tags`). */
  private bindName(c: Command & { kind: "flatten" }): string {
    const { ctx } = this;
    const name = flattenName(c);
    if (name === null) throw unsupported(`FLATTEN ${sourceOf(ctx, c.expr)}`, "an expression that is not a field path needs AS <name> — Dataview names a field after its last segment, nothing else has a name", at(ctx, c));
    if (!isUsableAlias(name)) throw unsupported(`FLATTEN … AS ${name}`, "the name must be an OQX identifier", at(ctx, c));
    if (name.startsWith("_")) throw unsupported(`FLATTEN … AS ${name}`, "a name in the engine's `_` namespace cannot be bound (the hit envelope `_id`/`_path` included); the bare namespace is the user's — write AS <a bare name>", at(ctx, c));
    if (UNBINDABLE.has(name)) throw unsupported(`FLATTEN … AS ${name}`, "a name the translator reads specially (file, this, rows, key)", at(ctx, c));
    if (ctx.bound.has(name) || (ctx.taskBound !== null && ctx.taskBound.name === name && this.taskFlatten?.command !== c)) throw unsupported(`FLATTEN … AS ${name}`, "the name is already bound by an earlier FLATTEN", at(ctx, c));
    if (this.aliases.has(name)) throw unsupported(`FLATTEN … AS ${name}`, "the name is a column the query selects", at(ctx, c));
    return name;
  }

  /** The value a FLATTEN splits, as the element kind decides (see the header):
   * `file.tasks` / `file.lists` → `_blocks collect { where _type == … }`;
   * `file.outlinks` / `file.inlinks` → `_out_links collect { from _dst }` /
   * `_in_links collect { from _doc }`; `file.tags` / `file.etags` → `_tags
   * collect { }`, `file.aliases` → `aliases collect { }` (the block makes the
   * value a collection, Dataview's `[]`); anything else — an authored field, a
   * bound name's member, a computed value — the expression itself, a block
   * added only for an element WHERE. */
  private flattenValue(c: Command & { kind: "flatten" }, bound: Bound): FlattenSpec {
    const { ctx } = this;
    const doc = (name: string): Expr => (ctx.target === "blocks" ? build.member(build.ident("_doc"), name) : build.ident(name));
    const segs = segments(c.expr);
    if (segs && segs[0] === "file" && segs.length === 2) {
      switch (segs[1]) {
        case "tasks": case "lists": {
          bound.kind = segs[1] === "tasks" ? "task" : "list_item";
          const sub = build.subquery({ where: build.scalar(build.binary("==", build.ident("_type"), build.lit(segs[1] === "tasks" ? "task" : "list_item"))) });
          return { bound, receiver: doc("_blocks"), sub, node: c };
        }
        case "outlinks": bound.kind = "doc"; return { bound, receiver: doc("_out_links"), sub: build.subquery({ from: [build.ident("_dst")] }), node: c };
        case "inlinks": bound.kind = "doc"; return { bound, receiver: doc("_in_links"), sub: build.subquery({ from: [build.ident("_doc")] }), node: c };
        case "tags": case "etags": bound.kind = "scalar"; return { bound, receiver: doc("_tags"), sub: build.subquery(), node: c };
        case "aliases": bound.kind = "scalar"; return { bound, receiver: doc("aliases"), sub: build.subquery(), node: c };
        default: break;
      }
    }
    const v = toValue(c.expr, ctx);
    if (v.derive) throw unsupported(`FLATTEN ${deriveField(v.derive)}`, "a value derived from path is one string, not a list", at(ctx, c));
    if (v.rows) throw unsupported("FLATTEN rows", "the group's rows are not a value to split", at(ctx, c));
    bound.kind = "value";
    return { bound, receiver: v.expr, sub: null, node: c };
  }

  /** The emitted clause: the receiver, with its block when it has one or an
   * element WHERE gave it one. */
  private flattenClause(f: FlattenSpec): Flatten {
    const { bound } = f;
    if (f.sub === null && bound.block.length === 0) return build.flatten(f.receiver, bound.name);
    let receiver = f.receiver;
    if (f.sub === null) {
      // A block over a scalar is an eval error; `list(x)` is a one-row collection for a scalar and the list itself for a list.
      receiver = build.call(null, "list", [receiver]);
      warn(this.ctx, `WHERE ${bound.name}: the flattened value is filtered as a list (list(…) { where … }); a page where it is absent yields no row, where Dataview keeps one with ${bound.name} null when the test passes null`);
    }
    const sub = f.sub ?? build.subquery();
    const where = conjoin([...(sub.where ? [sub.where] : []), ...bound.block]);
    return build.flatten(build.op(receiver, "collect", { ...sub, where }), bound.name);
  }

  /** A WHERE after a FLATTEN (or on a re-rooted TASK query): each top-level
   * conjunct goes where what it reads lives — the page's to the body `where`,
   * one element's to that flatten's block, a mix nowhere (see the header). */
  private splitWhere(c: Command & { kind: "where" }): void {
    const { ctx } = this;
    for (const conj of conjuncts(c.expr)) {
      const owner = this.ownerOf(conj);
      if (owner === "page") { this.where.push(toWhere(conj, ctx)); continue; }
      if (owner === "mixed") {
        throw unsupported(`WHERE ${sourceOf(ctx, conj)}`, "a predicate after FLATTEN that mixes a flattened element with the page's fields (or two flattened names) has no OQX spelling — `where` runs before `flatten`; write it as separate conjuncts (`a & b`) so each side can be placed", at(ctx, conj));
      }
      const target = owner.kind === "task" || owner.kind === "list_item" ? "blocks" : "docs";
      owner.block.push(toWhere(conj, nested(ctx, { element: owner, target, groupKey: null })));
    }
  }

  /** Whose fields a DQL expression reads: the page's (no bound name — `this.*`
   * is a constant or an outer reference and counts for neither side), exactly
   * one bound element's, or a mix. */
  private ownerOf(e: DExpr): "page" | "mixed" | Bound {
    const { ctx } = this;
    const heads = new Set<string>();
    dqlIdents(e, heads);
    const owners = new Set<Bound | "page">();
    for (const h of heads) {
      const b = ctx.bound.get(h);
      if (b) owners.add(b);
      else if (ctx.taskBound && h !== "file" && h !== "this" && TASK_FIELDS[h]) owners.add(ctx.taskBound);
      else if (h !== "this") owners.add("page");
    }
    if (owners.size === 0) return "page";
    if (owners.size > 1) return "mixed";
    return [...owners][0]!;
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
   * `mtime: _updated_at, c1: _updated_at`). A FLATTEN-bound name selected bare
   * keeps its name (`tag` for `TABLE tag … FLATTEN file.tags AS tag`): the
   * alias and the bound name are the same value. An `AS` name in the engine's
   * `_` namespace is not taken (the hit would carry a `_` key that is not the
   * engine's); an engine attribute selected bare keeps its own name
   * (`_updated_at`) — the alias is the attribute itself. */
  private alias(f: Field, v: Typed, i: number): string {
    const free = (c: string): boolean => isUsableAlias(c) && !c.startsWith("$") && !this.aliases.has(c) && !this.seenIdents.has(c);
    if (f.alias !== null && !f.alias.startsWith("_") && free(f.alias) && !this.referenced.has(f.alias)) { this.aliases.add(f.alias); return f.alias; }
    if (v.expr.kind === "ident" && !v.derive && free(v.expr.name)) { this.aliases.add(v.expr.name); return v.expr.name; }
    let n = i;
    while (this.aliases.has(`c${n}`) || this.referenced.has(`c${n}`) || this.seenIdents.has(`c${n}`)) n++;
    this.aliases.add(`c${n}`);
    return `c${n}`;
  }
}

/** A select item for a translated value: a `collect` item when the value is a
 * directive (`rows collect { … }`, `_in_links collect { from _doc }`), else a field. */
function item(alias: string, v: Typed): SelectItem {
  const e: Expr = v.expr;
  if (e.kind === "op" && (e.op === "collect" || e.op === "first" || e.op === "single")) return build.collect(alias, e);
  return build.field(alias, e);
}

function sourceOf(ctx: Ctx, node: { start: number; end: number }): string {
  return ctx.source.slice(node.start, node.end);
}

/** The name a `FLATTEN` command binds: its `AS`, else the last segment of a
 * field path (`file.tasks` → `tasks`, `j.tags` → `tags`); null when neither. */
function flattenName(c: Command & { kind: "flatten" }): string | null {
  if (c.alias !== null) return c.alias;
  const segs = segments(c.expr);
  return segs ? segs[segs.length - 1]! : null;
}

/** `file.tasks` → "task", `file.lists` → "list_item", else null. */
function isTaskList(e: DExpr): ElementKind | null {
  const segs = segments(e);
  if (!segs || segs.length !== 2 || segs[0] !== "file") return null;
  return segs[1] === "tasks" ? "task" : segs[1] === "lists" ? "list_item" : null;
}

/** The top-level conjuncts of a predicate (through parentheses). */
function conjuncts(e: DExpr): DExpr[] {
  if (e.kind === "paren") return conjuncts(e.expr);
  if (e.kind === "binary" && e.op === "&") return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
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
