// Dataview expressions ("Expressions": literals, fields, arithmetic, comparison,
// boolean, `contains`; "Functions") → OQX expressions, built as `@omgbase/oqx`
// AST nodes. Two entry points: `toValue` for a value position (a column, a sort
// key, an operand) and `toWhere` for a predicate position (WHERE, HAVING, a
// source), where the consumer tests `_in_links exists { … }` live — they have no
// value form in OQX.
//
// Every expression carries a static `kind` (fields.ts) so date/duration
// arithmetic is spelled with the surface 4.8 methods — `date + dur` is NEVER
// `+` in OQX (string `+` concatenates) — and a field compared with a date is
// wrapped in `date()` so an authored `2026-10-15` and a canonical ISO instant
// compare as dates.
//
// Names follow surface 5.0 ("underscore = engine", spec/surface §1.2): a bare
// OQX name is an authored entry — a frontmatter/inline key on a document, an
// `attrs` key such as `checked` on a block — and an underscore-prefixed name is
// the engine's (`_path`, `_tags`, `_updated_at`, `_in_links`, …). A Dataview
// bare field is the author's value, so it stays bare (`title` is the authored
// `title`, never the computed `_title`); `file.*` and the task fields are the
// engine's, so they take the `_` spelling (fields.ts). The self aliases are
// gone: a docs row reads its own fields with no handle, and a block reaches its
// document through `_doc` (`_doc.due`, `_doc._tags`).

import { build, type Expr, type OpNode, type SelectItem, type TemplatePart, type Where } from "@omgbase/oqx";
import type { Expr as DExpr, Node } from "./ast.ts";
import { at, linkPath, nested, rootPath, warn, type Bound, type Ctx } from "./context.ts";
import { DqlError, unsupported } from "./errors.ts";
import {
  DATE_MEMBERS, DATE_MEMBERS_UNSUPPORTED, DURATION_MEMBERS, FILE_FIELDS, TASK_FIELDS, type CollectBody, type Derive, type Kind,
} from "./fields.ts";
import { FUNCTIONS } from "./functions.ts";
import { conjoin, disjoin, isOqxIdent, regexEscape } from "./oqx.ts";

/** A translated value: the OQX expression, its static kind, and — for
 * `file.name` / `file.folder` / `file.link` / `file.ext` — the client-side
 * derivation from `_path` the expression stands for (`derive`). `literal` is the
 * string value when the expression is a string literal (the rewrites of a
 * derived field against a literal need it). */
export interface Typed {
  expr: Expr;
  kind: Kind;
  derive?: Derive;
  literal?: string;
  /** The bare `rows` collection after GROUP BY (a value, not a scalar). */
  rows?: boolean;
}

const lit = build.lit;
const ident = build.ident;
const call = build.call;
const member = build.member;

function str(value: string): Typed { return { expr: lit(value), kind: "string", literal: value }; }

// ---- fields -------------------------------------------------------------------

/** `a.b.c` with an identifier head → ["a", "b", "c"]; null for any other shape. */
export function segments(e: DExpr): string[] | null {
  if (e.kind === "ident") return [e.name];
  if (e.kind === "member") {
    const head = segments(e.object);
    return head ? [...head, e.name] : null;
  }
  return null;
}

/** A bare Dataview field on the current row: an authored property. */
function bareField(name: string, node: Node, ctx: Ctx): Typed {
  if (!isOqxIdent(name)) {
    throw unsupported(`field ${name}`, "OQX has no bracket lookup by string, so a key that is not an identifier ([A-Za-z_][A-Za-z0-9_]*) cannot be read; rename the key", at(ctx, node));
  }
  if (ctx.groupKey !== null) {
    if (name === ctx.groupKey || name === "key") return { expr: ident(ctx.groupKey), kind: "unknown" };
    throw unsupported(`field ${name}`, `after GROUP BY only \`${ctx.groupKey}\` (the group key) and \`rows\` are in scope — Dataview reads a page field there as null`, at(ctx, node));
  }
  if (ctx.target === "blocks") {
    const task = TASK_FIELDS[name];
    if (task) {
      if (task.read === "unsupported") throw unsupported(`task field ${name}`, task.reason, at(ctx, node));
      if (task.read === "collect") return { expr: collectOf(ident(task.relation), task.body), kind: task.kind };
      if (task.warning) warn(ctx, task.warning);
      return { expr: ident(task.attr), kind: task.kind };
    }
    // Dataview reads a task's own inline fields here; omgbase indexes inline
    // fields per document, so the page's property is what is available.
    warn(ctx, `${name}: a task's inline fields are not indexed per task; read as the page's property _doc.${name}`);
    return { expr: authoredKey(ident("_doc"), name, ctx), kind: "unknown" };
  }
  return { expr: authoredKey(null, name, ctx), kind: "unknown" };
}

/** An authored key on a document (`recv` null: the row itself; else the handle
 * it is reached through, `_doc` on a block or the `this` row). A bare name IS
 * the authored key (surface 5.0: nothing bare is reserved) — except a key that
 * itself begins with `_`, which the bare namespace cannot spell (the engine
 * would judge `_x` an unknown engine name); it is read through the `_data`
 * handle, the merged authored view (`_data._x`, spec/surface §1.2), warned. */
function authoredKey(recv: Expr | null, name: string, ctx: Ctx): Expr {
  if (name.startsWith("_")) {
    warn(ctx, `${name}: an authored key beginning with \`_\` is read as _data.${name} (a bare \`_\` name is the engine's)`);
    return member(recv ? member(recv, "_data") : ident("_data"), name);
  }
  return recv ? member(recv, name) : ident(name);
}

/** A relation rendered as a collect: `_in_links collect { from _doc }`, `_blocks collect { where _type == "task" }`. */
function collectOf(receiver: Expr, body: CollectBody): Expr {
  switch (body) {
    case "from _doc": return build.op(receiver, "collect", build.subquery({ from: [ident("_doc")] }));
    case "from _dst": return build.op(receiver, "collect", build.subquery({ from: [ident("_dst")] }));
    case 'where _type == "task"': return build.op(receiver, "collect", build.subquery({ where: build.scalar(build.binary("==", ident("_type"), lit("task"))) }));
    case 'where _type == "list_item"': return build.op(receiver, "collect", build.subquery({ where: build.scalar(build.binary("==", ident("_type"), lit("list_item"))) }));
  }
}

/** An engine name of the row's document: bare on docs, through the `_doc` handle on a task. */
function docAttr(ctx: Ctx, name: string): Expr {
  return ctx.target === "blocks" ? member(ident("_doc"), name) : ident(name);
}

/** `file.<name>[.rest…]` ("Metadata on Pages"). */
function fileField(rest: string[], node: Node, ctx: Ctx): Typed {
  const name = rest[0];
  if (name === undefined) throw unsupported("file", "`file` alone is the page's metadata object; read one of its fields (file.name, file.mtime, …)", at(ctx, node));
  const f = FILE_FIELDS[name];
  if (!f) throw unsupported(`file.${name}`, "not a Dataview implicit field", at(ctx, node));
  let value: Typed;
  switch (f.read) {
    case "unsupported": throw unsupported(`file.${name}`, f.reason, at(ctx, node));
    // A block carries its document's `_path` too, so the derived fields read it bare on either target.
    case "derive": value = { expr: ident("_path"), kind: "string", derive: f.derive }; break;
    case "frontmatter": {
      const handle = docAttr(ctx, "_frontmatter");
      if (rest.length === 1) return { expr: call(null, "entries", [handle]), kind: "list" };
      return trailing({ expr: member(handle, rest[1]!), kind: "unknown" }, rest.slice(2), node, ctx);
    }
    case "collect": {
      value = { expr: collectOf(docAttr(ctx, f.relation), f.body), kind: f.kind };
      break;
    }
    case "attr": {
      if (f.warning) warn(ctx, f.warning);
      if (name === "size") value = { expr: call(null, "size", [docAttr(ctx, "_raw")]), kind: "number" };
      else if (name === "mday") { ctx.features.add("dates"); value = { expr: call(docAttr(ctx, "_updated_at"), "date", []), kind: "date" }; }
      else if (name === "cday") { ctx.features.add("dates"); value = { expr: call(docAttr(ctx, "_created_at"), "date", []), kind: "date" }; }
      else value = { expr: docAttr(ctx, f.attr), kind: f.kind };
      break;
    }
  }
  return trailing(value, rest.slice(1), node, ctx);
}

/** `this.…` — the current document, a constant the client supplies. */
function thisField(rest: string[], node: Node, ctx: Ctx): Typed {
  if (ctx.thisPath === null) throw unsupported("this", "the query reads the current document; pass { thisPath } to translate()", at(ctx, node));
  const path = rootPath(ctx.thisPath);
  const name = rest[0];
  if (name === undefined) throw unsupported("this", "`this` alone is the current page; read one of its fields", at(ctx, node));
  if (name === "file") {
    const which = rest[1];
    const bare = path.replace(/^\//, "");
    const slash = bare.lastIndexOf("/");
    switch (which) {
      case "path": return trailing(str(path), rest.slice(2), node, ctx);
      case "link": return trailing({ ...str(path), derive: "link" }, rest.slice(2), node, ctx);
      case "name": return trailing(str(bare.slice(slash + 1).replace(/\.md$/, "")), rest.slice(2), node, ctx);
      case "folder": return trailing(str(slash < 0 ? "" : bare.slice(0, slash)), rest.slice(2), node, ctx);
      case "ext": return trailing(str(bare.includes(".") ? bare.slice(bare.lastIndexOf(".") + 1) : ""), rest.slice(2), node, ctx);
      default: throw unsupported(`this.file.${which ?? ""}`, "only this.file.path, .name, .folder, .link and .ext are constants; other metadata of the current page is not available", at(ctx, node));
    }
  }
  // this.<property>: the current document's row, looked up from the root scan.
  const row = build.op(build.outer(ctx.depth, "docs"), "first", build.subquery({ where: build.scalar(build.binary("==", ident("_path"), lit(path))) }));
  return trailing({ expr: authoredKey(row, name, ctx), kind: "unknown" }, rest.slice(1), node, ctx);
}

/** `rows[.…]` after GROUP BY: the group's rows as an aggregate. */
function rowsField(rest: string[], node: Node, ctx: Ctx): Typed {
  if (ctx.groupKey === null) throw unsupported("rows", "`rows` exists only after GROUP BY", at(ctx, node));
  if (rest.length === 0) return { expr: rowsCollect(ctx), kind: "list", rows: true };
  // The per-row value, read as the ungrouped row reads it.
  const inner = rowRead(rest, node, { ...ctx, groupKey: null });
  return { expr: aggregateOf(ctx, "collect", inner.expr), kind: "list", ...(inner.derive ? { derive: inner.derive } : {}) };
}

/** A field path read on the (ungrouped) row: `file.*`, a `FLATTEN`-bound name, a
 * task field on a re-rooted TASK query, else an authored property. */
function rowRead(segs: string[], node: Node, ctx: Ctx): Typed {
  const [head, ...rest] = segs as [string, ...string[]];
  const bound = ctx.bound.get(head);
  if (bound) return boundValue(bound, rest, node, ctx);
  if (ctx.taskBound && head !== "file" && TASK_FIELDS[head]) return boundValue(ctx.taskBound, segs, node, ctx);
  if (head === "file") return fileField(rest, node, ctx);
  return trailing(bareField(head, node, ctx), rest, node, ctx);
}

/** `<bound>[.rest…]`: a read of a `FLATTEN`-bound element (spec/oqx §25). Inside
 * the flatten's own block (`ctx.element === b`) the element is the row — bare
 * names and `$it` — so the read is spelled as the element's own row reads it; on
 * the flattened row the same spelling is re-read through the bound name
 * (`rebase`: `checked` → `t.checked`, `_doc.due` → `t._doc.due`, `$it` → `t`). A
 * block element (a task, a list item) reads by the task-field table, a document
 * element by the page's (`o.file.mtime` → `o._updated_at`), a scalar or authored
 * element by plain navigation. */
function boundValue(b: Bound, rest: string[], node: Node, ctx: Ctx): Typed {
  const inBlock = ctx.element === b;
  if (ctx.groupKey !== null && !inBlock) {
    // After GROUP BY the flattened rows are inside `rows`; only the key survives (Dataview reads the rest as null).
    if (b.name === ctx.groupKey && rest.length === 0) return { expr: ident(ctx.groupKey), kind: "unknown" };
    throw unsupported(`field ${[b.name, ...rest].join(".")}`, `after GROUP BY only \`${ctx.groupKey}\` (the group key) and \`rows\` are in scope — Dataview reads a flattened name there as null`, at(ctx, node));
  }
  if (b.kind === "scalar" || b.kind === "value") {
    const base: Typed = { expr: inBlock ? ident("$it") : ident(b.name), kind: b.kind === "scalar" ? "string" : "unknown" };
    return trailing(base, rest, node, ctx);
  }
  if (rest.length === 0) return { expr: inBlock ? ident("$it") : ident(b.name), kind: "unknown" };
  // The element as its own row: a blocks row for a task or list item, a docs row for a linked document.
  const rowCtx: Ctx = { ...ctx, target: b.kind === "doc" ? "docs" : "blocks", groupKey: null, bound: new Map(), element: null, taskBound: null };
  let v: Typed;
  if (rest[0] === "file") {
    if (b.kind !== "doc") throw unsupported(`${b.name}.file`, "a task has no `file`; the page's fields are the row's own (file.*)", at(ctx, node));
    v = fileField(rest.slice(1), node, rowCtx);
  } else {
    v = trailing(bareField(rest[0]!, node, rowCtx), rest.slice(1), node, rowCtx);
  }
  return inBlock ? v : { ...v, expr: rebase(v.expr, b.name) };
}

/** `e`, written for the element's own row, re-read through `name` on the
 * flattened row: a bare identifier becomes `<name>.<ident>`, `$it` becomes
 * `<name>`; `^` references, other `$`-names, literals and the inside of a block
 * (its own scope — only the receiver is re-based) are untouched. */
export function rebase(e: Expr, name: string): Expr {
  const r = (x: Expr): Expr => rebase(x, name);
  switch (e.kind) {
    case "ident":
      if (e.name === "$it") return ident(name);
      if (e.name.startsWith("$")) return e;
      return member(ident(name), e.name);
    case "lit": case "outer": case "binding": return e;
    case "member": return { ...e, recv: r(e.recv) };
    case "call": return { ...e, recv: e.recv ? r(e.recv) : null, args: e.args.map(r) };
    case "unary": case "required": return { ...e, expr: r(e.expr) };
    case "binary": case "logical": case "in": return { ...e, left: r(e.left), right: r(e.right) };
    case "range": return { ...e, lo: e.lo ? r(e.lo) : null, hi: e.hi ? r(e.hi) : null };
    case "tuple": return { ...e, items: e.items.map(r) };
    case "template": return { ...e, parts: e.parts.map((p): TemplatePart => (typeof p === "string" ? p : r(p))) };
    case "aggregate": return { ...e, arg: e.arg ? r(e.arg) : null };
    case "op": return { ...e, receiver: r(e.receiver) };
  }
}

/** `rebase` over a predicate tree (the consumer tests sit inside and/or/not). */
export function rebaseWhere(w: Where, name: string): Where {
  switch (w.kind) {
    case "scalar": return { ...w, expr: rebase(w.expr, name) };
    case "and": case "or": return { ...w, parts: w.parts.map((p) => rebaseWhere(p, name)) };
    case "not": return { ...w, expr: rebaseWhere(w.expr, name) };
    case "op": return { ...w, receiver: rebase(w.receiver, name) };
  }
}

/** `collect(x)` — or, when a SORT preceded the GROUP BY, the block form that
 * carries the row order: `rows collect { x values order by … }`. */
function aggregateOf(ctx: Ctx, fn: "collect" | "sum" | "min" | "max" | "avg" | "first" | "last" | "any" | "all", value: Expr): Expr {
  if (ctx.rowsOrder && (fn === "collect" || fn === "first" || fn === "last")) {
    ctx.rowsOrderUsed = true;
    const sub = build.subquery({ select: [build.field("v", value)], values: true, orderBy: ctx.rowsOrder });
    if (fn === "collect") return build.op(ident("rows"), "collect", sub);
    if (fn === "first") return build.op(ident("rows"), "first", sub);
    return build.op(ident("rows"), "first", { ...sub, orderBy: ctx.rowsOrder.map((o) => build.order(o.expr, !o.desc)) });
  }
  return call(null, fn, [value]);
}

/** The group's rows as records: `rows collect { select _path }` (docs) or
 * `rows collect { select _id, _text, checked, _path }` (tasks), ordered by the
 * pre-group SORT when there was one. */
export function rowsCollect(ctx: Ctx): Expr {
  if (ctx.rowsOrder) ctx.rowsOrderUsed = true;
  const select = ctx.taskBound ? taskSelect(ctx.taskBound.name)
    : (ctx.target === "blocks" ? ["_id", "_text", "checked", "_path"] : ["_path"]).map((n) => build.field(n, ident(n)));
  return build.op(ident("rows"), "collect", build.subquery({ select, orderBy: ctx.rowsOrder }));
}

/** The alias of the task's block id on a TASK query re-rooted at the page
 * (`_id` and `_path` are the page's envelope, so the task's id needs another name). */
export const TASK_ID_ALIAS = "task_id";

/** The task shape read through a bound task: `_path, task_id: t._id, text: t._text, checked: t.checked`. */
export function taskSelect(bound: string): SelectItem[] {
  return [
    build.field("_path", ident("_path")),
    build.field(TASK_ID_ALIAS, member(ident(bound), "_id")),
    build.field("text", member(ident(bound), "_text")),
    build.field("checked", member(ident(bound), "checked")),
  ];
}

/** Trailing `.name` segments on a value: date methods, or plain navigation. */
function trailing(value: Typed, rest: string[], node: Node, ctx: Ctx): Typed {
  let v = value;
  for (const name of rest) v = memberOf(v, name, node, ctx);
  return v;
}

function memberOf(obj: Typed, name: string, node: Node, ctx: Ctx): Typed {
  if (obj.derive) throw unsupported(`file.${obj.derive === "basename" ? "name" : obj.derive === "dirname" ? "folder" : obj.derive}.${name}`, "a value derived from path has no fields", at(ctx, node));
  if (obj.kind === "date") {
    if (DATE_MEMBERS.has(name)) { ctx.features.add("dates"); return { expr: call(obj.expr, name, []), kind: name === "date" ? "date" : "number" }; }
    if (DATE_MEMBERS_UNSUPPORTED.has(name)) throw unsupported(`date.${name}`, "the date contract has year/month/day/weekday/hour/minute/second/date only", at(ctx, node));
  }
  if (obj.kind === "duration" && DURATION_MEMBERS.has(name)) {
    throw unsupported(`duration.${name}`, "a duration is a number of seconds in OQX; its calendar components are not available (dur_text()/dur_iso() format it)", at(ctx, node));
  }
  if (!isOqxIdent(name)) throw unsupported(`.${name}`, "not an OQX identifier", at(ctx, node));
  return { expr: member(obj.expr, name), kind: "unknown" };
}

// ---- values -------------------------------------------------------------------

export function toValue(e: DExpr, ctx: Ctx): Typed {
  switch (e.kind) {
    case "string": return str(e.value);
    case "number": return { expr: lit(e.value), kind: "number" };
    case "boolean": return { expr: lit(e.value), kind: "boolean" };
    case "null": return { expr: lit(null), kind: "unknown" };
    case "date": ctx.features.add("dates"); return { expr: call(null, "date", [lit(e.text)]), kind: "date" };
    // A duration literal keeps its text: as the argument of `.plus`/`.minus` the
    // STRING is passed (calendar-aware months and years, surface §1.3), while a
    // value position gets `dur("…")`, the number of seconds.
    case "duration": ctx.features.add("dates"); return { expr: call(null, "dur", [lit(e.text)]), kind: "duration", literal: e.text };
    case "link":
      throw unsupported("[[link]] literal", "a link is a value only in FROM and in contains(file.inlinks | file.outlinks, [[note]]); OQX has no link type", at(ctx, e));
    case "list": {
      if (e.items.length === 0) throw unsupported("[] (empty list)", "OQX has no list literal", at(ctx, e));
      if (e.items.length === 1) return { expr: call(null, "list", [toValue(e.items[0]!, ctx).expr]), kind: "list" };
      return { expr: build.tuple(e.items.map((i) => toValue(i, ctx).expr)), kind: "list" };
    }
    case "object": throw unsupported("{…} (object literal)", "OQX has no object literal", at(ctx, e));
    case "lambda": throw unsupported("lambda", "(x) => … has no OQX counterpart", at(ctx, e));
    case "paren": return toValue(e.expr, ctx);
    case "ident": case "member": return fieldValue(e, ctx);
    case "index": return indexValue(e, ctx);
    case "call": return callValue(e, ctx);
    case "neg": return { expr: build.unary("-", toValue(e.expr, ctx).expr), kind: "number" };
    case "not": return { expr: build.unary("!", toValue(e.expr, ctx).expr), kind: "boolean" };
    case "binary": return binaryValue(e, ctx);
  }
}

function fieldValue(e: DExpr & ({ kind: "ident" } | { kind: "member" }), ctx: Ctx): Typed {
  const segs = segments(e);
  if (!segs) {
    // `<expr>.name` on a computed object (a call result, an index).
    if (e.kind !== "member") throw new Error("unreachable");
    return memberOf(toValue(e.object, ctx), e.name, e, ctx);
  }
  const [head, ...rest] = segs as [string, ...string[]];
  // A name FLATTEN bound shadows every other reading of it (spec/oqx §25).
  if (ctx.bound.has(head)) return rowRead(segs, e, ctx);
  switch (head) {
    case "file": return fileField(rest, e, ctx);
    case "this": return thisField(rest, e, ctx);
    case "rows": return rowsField(rest, e, ctx);
    case "key":
      if (ctx.groupKey !== null) return trailing({ expr: ident(ctx.groupKey), kind: "unknown" }, rest, e, ctx);
      return rowRead(segs, e, ctx);
    default: return rowRead(segs, e, ctx);
  }
}

function indexValue(e: DExpr & { kind: "index" }, ctx: Ctx): Typed {
  const obj = toValue(e.object, ctx);
  const ix = e.index;
  if (ix.kind === "string") return memberOf(obj, ix.value, e, ctx);
  if (ix.kind === "number") {
    if (!Number.isInteger(ix.value)) throw unsupported(`[${ix.value}]`, "OQX indexes are non-negative integers", at(ctx, e));
    return { expr: build.op(obj.expr, "first", build.subquery({ offset: lit(ix.value) })), kind: "unknown" };
  }
  if (ix.kind === "neg" && ix.expr.kind === "number") throw unsupported(`[-${ix.expr.value}]`, "OQX has no negative (from-the-end) indexes", at(ctx, e));
  throw unsupported("[expr] (computed index)", "OQX indexes by an integer literal or a string key", at(ctx, e));
}

// ---- calls ---------------------------------------------------------------------

/** A link-literal (or `this.file.link`) argument as a path test on `field`. */
function linkTest(field: Expr, arg: DExpr, ctx: Ctx): Expr {
  if (arg.kind === "link") {
    const p = linkPath(ctx, arg.target, arg);
    return "exact" in p ? build.binary("==", field, lit(p.exact)) : call(field, "endsWith", [lit(p.suffix)]);
  }
  const v = toValue(arg, ctx);
  if (v.derive === "link" && v.literal !== undefined) return build.binary("==", field, lit(v.literal));
  throw unsupported("contains(file.inlinks | file.outlinks, x)", "x must be a [[link]] or this.file.link", at(ctx, arg));
}

/** `contains(file.tags, "#t")` — the expanded-tag test: the tag or any nested
 * `t/…` tag (Dataview "#a/b" carries "#a" too; omgbase stores the authored
 * `a/b`, so the prefix is tested). */
function tagTest(tags: Expr, tag: string): OpNode {
  const bare = tag.replace(/^#/, "");
  return build.op(tags, "exists", build.subquery({
    where: build.or([
      build.scalar(build.binary("==", ident("$it"), lit(bare))),
      build.scalar(call(ident("$it"), "startsWith", [lit(`${bare}/`)])),
    ]),
  }));
}

/** The predicate forms of `contains`/`econtains` that have no value form (a consumer test). */
function containsWhere(e: DExpr & { kind: "call" }, ctx: Ctx): Where | null {
  const name = e.name.toLowerCase();
  if ((name !== "contains" && name !== "econtains") || e.args.length !== 2) return null;
  const [haystack, needle] = e.args as [DExpr, DExpr];
  const h = toValue(haystack, ctx);
  // The links are the collect's receiver (`_in_links`, `_doc._in_links`, a task's own `_out_links`, `t._out_links`).
  const links = (): Expr => (h.expr.kind === "op" ? h.expr.receiver : h.expr);
  if (h.kind === "inlinks") return build.op(links(), "exists", build.subquery({ where: build.scalar(linkTest(member(ident("_doc"), "_path"), needle, nested(ctx))) }));
  if (h.kind === "outlinks") return build.op(links(), "exists", build.subquery({ where: build.scalar(linkTest(member(ident("_dst"), "_path"), needle, nested(ctx))) }));
  if (h.kind === "tags" && name === "contains") {
    const n = toValue(needle, ctx);
    if (n.literal === undefined) throw unsupported("contains(file.tags, x)", "x must be a string literal (\"#tag\")", at(ctx, needle));
    return tagTest(toValue(haystack, ctx).expr, n.literal);
  }
  return null;
}

function callValue(e: DExpr & { kind: "call" }, ctx: Ctx): Typed {
  const name = e.name.toLowerCase();
  const entry = FUNCTIONS[name];
  if (!entry) throw unsupported(`${e.name}()`, "unknown Dataview function", at(ctx, e));
  if (entry.status === "unsupported") throw unsupported(`${e.name}()`, entry.reason, at(ctx, e));
  const args = e.args;
  const arity = (n: number): void => {
    if (args.length !== n) throw new DqlError("parse", `${e.name}() takes ${n} argument${n === 1 ? "" : "s"}`, at(ctx, e));
  };
  const rowsArg = (arg: DExpr): Typed | null => {
    const segs = segments(arg);
    if (!segs || segs[0] !== "rows") return null;
    if (ctx.groupKey === null) throw unsupported("rows", "`rows` exists only after GROUP BY", at(ctx, arg));
    if (segs.length === 1) return { expr: ident("$it"), kind: "unknown", rows: true };
    return rowRead(segs.slice(1), arg, { ...ctx, groupKey: null });
  };

  switch (name) {
    case "date": {
      if (args.length === 2) throw unsupported("date(text, format)", "the date contract parses ISO text only", at(ctx, e));
      arity(1);
      ctx.features.add("dates");
      return { expr: call(null, "date", [toValue(args[0]!, ctx).expr]), kind: "date" };
    }
    case "dur": { arity(1); ctx.features.add("dates"); return { expr: call(null, "dur", [toValue(args[0]!, ctx).expr]), kind: "duration" }; }
    case "string": { arity(1); return { expr: build.template(["", toValue(args[0]!, ctx).expr, ""]), kind: "string" }; }
    case "lower": case "upper": { arity(1); return { expr: call(toValue(args[0]!, ctx).expr, name, []), kind: "string" }; }
    case "startswith": case "endswith": {
      arity(2);
      const s = toValue(args[0]!, ctx);
      const p = toValue(args[1]!, ctx);
      if (s.derive) return { expr: derivedTest(s, name, p, e, ctx), kind: "boolean" };
      return { expr: call(s.expr, name === "startswith" ? "startsWith" : "endsWith", [p.expr]), kind: "boolean" };
    }
    case "length": {
      arity(1);
      const r = rowsArg(args[0]!);
      if (r?.rows) return { expr: call(null, "count", []), kind: "number" };
      const v = toValue(args[0]!, ctx);
      // `size(<relation>)`: the collect's receiver (`_in_links`, `_doc._in_links`, `t._out_links`).
      if (v.kind === "inlinks" || v.kind === "outlinks") return { expr: call(null, "size", [v.expr.kind === "op" ? v.expr.receiver : v.expr]), kind: "number" };
      return { expr: call(null, "size", [v.expr]), kind: "number" };
    }
    case "contains": case "econtains": {
      arity(2);
      const h = toValue(args[0]!, ctx);
      if (h.kind === "inlinks" || h.kind === "outlinks") throw unsupported(`${e.name}(file.${h.kind}, …)`, "a link test is a predicate: use it in WHERE", at(ctx, e));
      const n = toValue(args[1]!, ctx);
      if (h.derive) return { expr: derivedTest(h, "contains", n, e, ctx), kind: "boolean" };
      if (h.kind === "tags" && name === "contains") warn(ctx, "contains(file.tags, …) in value position tests the exact tag; nested tags match only in WHERE");
      const needle = (h.kind === "tags" || h.kind === "etags") && n.literal !== undefined ? lit(n.literal.replace(/^#/, "")) : n.expr;
      return { expr: build.inOp(needle, h.expr), kind: "boolean" };
    }
    case "icontains": {
      arity(2);
      const h = toValue(args[0]!, ctx);
      const n = toValue(args[1]!, ctx);
      if (h.derive) throw unsupported("icontains(file.name | file.folder, …)", "case-insensitive tests on a derived field are not expressible", at(ctx, e));
      const needle = n.literal !== undefined ? lit(n.literal.toLowerCase()) : call(n.expr, "lower", []);
      return { expr: call(call(h.expr, "lower", []), "contains", [needle]), kind: "boolean" };
    }
    case "containsword": {
      arity(2);
      const h = toValue(args[0]!, ctx);
      const w = toValue(args[1]!, ctx);
      if (w.literal === undefined) throw unsupported("containsword(x, w)", "w must be a string literal", at(ctx, e));
      if (h.derive) throw unsupported("containsword(file.name | file.folder, …)", "word tests on a derived field are not expressible", at(ctx, e));
      return { expr: build.binary("~", h.expr, lit(`\\b${regexEscape(w.literal)}\\b`)), kind: "boolean" };
    }
    case "regextest": case "regexmatch": {
      arity(2);
      const p = toValue(args[0]!, ctx);
      const s = toValue(args[1]!, ctx);
      if (s.derive) throw unsupported(`${e.name}(…, file.name | file.folder)`, "regex tests on a derived field are not expressible", at(ctx, e));
      // regexmatch matches the WHOLE string; OQX anchors only when the pattern does.
      const pattern = name === "regexmatch" && p.literal !== undefined ? lit(`^(?:${p.literal})$`) : p.expr;
      if (name === "regexmatch" && p.literal === undefined) warn(ctx, "regexmatch(pattern, s) with a computed pattern is unanchored in OQX (Dataview matches the whole string)");
      return { expr: build.binary("~", s.expr, pattern), kind: "boolean" };
    }
    case "default": {
      arity(2);
      const x = toValue(args[0]!, ctx);
      const d = toValue(args[1]!, ctx);
      return { expr: build.logical("||", x.expr, d.expr), kind: x.kind === d.kind ? x.kind : "unknown" };
    }
    case "striptime": { arity(1); ctx.features.add("dates"); return { expr: call(dateOf(toValue(args[0]!, ctx)), "date", []), kind: "date" }; }
    case "dateformat": {
      arity(2);
      ctx.features.add("dates");
      const pattern = toValue(args[1]!, ctx);
      // The surface's format tokens are yyyy MM dd HH mm ss MMM EEE; every other
      // character is literal (surface §1.3) — Luxon's MMMM, EEEE, h, a, … are not.
      if (pattern.literal !== undefined && /[A-Za-z]/.test(pattern.literal.replace(/yyyy|MMM|EEE|MM|dd|HH|mm|ss/g, ""))) {
        warn(ctx, `dateformat pattern "${pattern.literal}": only yyyy MM dd HH mm ss MMM EEE are tokens in OQX; other letters print literally`);
      }
      return { expr: call(dateOf(toValue(args[0]!, ctx)), "format", [pattern.expr]), kind: "string" };
    }
    case "sum": case "min": case "max": case "average": case "any": case "all": case "none": {
      arity(1);
      const r = rowsArg(args[0]!);
      if (!r || r.rows) throw unsupported(`${e.name}()`, entry.status === "group" ? `${e.name}(rows.<field>) after GROUP BY is the supported form` : "", at(ctx, e));
      const fn = name === "average" ? "avg" : name === "none" ? "any" : name;
      const agg = aggregateOf(ctx, fn as "sum", r.expr);
      if (name === "none") return { expr: build.unary("!", agg), kind: "boolean" };
      return { expr: agg, kind: name === "any" || name === "all" ? "boolean" : r.kind === "date" ? "date" : "number" };
    }
    default: throw unsupported(`${e.name}()`, "no handler", at(ctx, e));
  }
}

/** A value known or assumed to be a date, wrapped in `date()` unless it already is one. */
function dateOf(v: Typed): Expr {
  return v.kind === "date" ? v.expr : call(null, "date", [v.expr]);
}

/** The Dataview field a derivation stands for. */
export function deriveField(derive: Derive): string {
  return derive === "basename" ? "file.name" : derive === "dirname" ? "file.folder" : derive === "link" ? "file.link" : "file.ext";
}

/** A test on a path-derived field (`file.name`, `file.folder`, `file.link`,
 * `file.ext`) against a literal, rewritten over the path the derived value
 * reads (`_path`, `_doc._path`, `o._path`) — OQX has no basename or dirname,
 * so the literal moves into the test instead. */
function derivedTest(derived: Typed, op: "==" | "!=" | "contains" | "startswith" | "endswith", other: Typed, node: Node, ctx: Ctx): Expr {
  const derive = derived.derive!;
  const field = deriveField(derive);
  if (other.literal === undefined) throw unsupported(`${field} ${op === "==" ? "=" : op} x`, `${field} is derived from _path on the client; it compares only with a string literal (or this.file.*)`, at(ctx, node));
  const v = other.literal;
  const path = derived.expr;
  const esc = regexEscape(v);
  switch (derive) {
    case "basename":
      switch (op) {
        case "==": return call(path, "endsWith", [lit(`/${v}.md`)]);
        case "!=": return build.unary("!", call(path, "endsWith", [lit(`/${v}.md`)]));
        case "startswith": return build.binary("~", path, lit(`/${esc}[^/]*\\.md$`));
        case "endswith": return call(path, "endsWith", [lit(`${v}.md`)]);
        case "contains": return build.binary("~", path, lit(`/[^/]*${esc}[^/]*\\.md$`));
      }
      break;
    case "dirname": {
      const folder = v.replace(/^\/+|\/+$/g, "");
      switch (op) {
        case "==": return build.binary("~", path, lit(folder === "" ? "^/[^/]+$" : `^/${regexEscape(folder)}/[^/]+$`));
        case "!=": return build.binary("!~", path, lit(folder === "" ? "^/[^/]+$" : `^/${regexEscape(folder)}/[^/]+$`));
        case "startswith": return call(path, "startsWith", [lit(`/${folder}`)]);
        case "endswith": return build.binary("~", path, lit(`${regexEscape(folder)}/[^/]*$`));
        case "contains": return build.binary("~", path, lit(`${regexEscape(folder)}[^/]*/`));
      }
      break;
    }
    case "link":
      if (op === "==") return build.binary("==", path, lit(rootPath(v)));
      if (op === "!=") return build.binary("!=", path, lit(rootPath(v)));
      break;
    case "ext":
      if (op === "==") return call(path, "endsWith", [lit(`.${v.replace(/^\./, "")}`)]);
      if (op === "!=") return build.unary("!", call(path, "endsWith", [lit(`.${v.replace(/^\./, "")}`)]));
      break;
  }
  throw unsupported(`${field} ${op}`, "only =, != and (for file.name / file.folder) contains/startswith/endswith are expressible over path", at(ctx, node));
}

// ---- operators -------------------------------------------------------------------

function binaryValue(e: DExpr & { kind: "binary" }, ctx: Ctx): Typed {
  const op = e.op;
  if (op === "&" || op === "|") {
    const l = toValue(e.left, ctx);
    const r = toValue(e.right, ctx);
    return { expr: build.logical(op === "&" ? "&&" : "||", l.expr, r.expr), kind: "boolean" };
  }
  const l = toValue(e.left, ctx);
  const r = toValue(e.right, ctx);
  if (op === "=" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const oqxOp = op === "=" ? "==" : op;
    if (l.derive || r.derive) {
      if (oqxOp !== "==" && oqxOp !== "!=") throw unsupported(`${deriveField((l.derive ?? r.derive)!)} ${op}`, "a path-derived field orders only by path (SORT); compare it with = or !=", at(ctx, e));
      const [d, other] = l.derive ? [l, r] : [r, l];
      // `this.file.link == file.link` style: both derived → both literal-less; use the literal side.
      return { expr: derivedTest(d, oqxOp, other.literal !== undefined ? other : d, e, ctx), kind: "boolean" };
    }
    // A date against anything not statically a date: read the other side as a date.
    let left = l.expr;
    let right = r.expr;
    if (l.kind === "date" && r.kind === "unknown") { ctx.features.add("dates"); right = call(null, "date", [r.expr]); }
    if (r.kind === "date" && l.kind === "unknown") { ctx.features.add("dates"); left = call(null, "date", [l.expr]); }
    return { expr: build.binary(oqxOp, left, right), kind: "boolean" };
  }
  // Arithmetic.
  if (l.kind === "date" || r.kind === "date" || l.kind === "duration" || r.kind === "duration") ctx.features.add("dates");
  // The shift a date takes: a duration literal's STRING (calendar-aware for its
  // months and years, surface §1.3), otherwise the value (a number of seconds).
  const shift = (t: Typed): Expr => (t.kind === "duration" && t.literal !== undefined ? lit(t.literal) : t.expr);
  if (op === "+") {
    if (l.kind === "date") return { expr: call(l.expr, "plus", [shift(r)]), kind: "date" };
    if (r.kind === "date") return { expr: call(r.expr, "plus", [shift(l)]), kind: "date" };
    if (l.kind === "duration" && r.kind === "unknown") { warn(ctx, "`duration + field` read as field.plus(duration): the field is taken for a date"); return { expr: call(r.expr, "plus", [shift(l)]), kind: "date" }; }
    if (r.kind === "duration" && l.kind === "unknown") { warn(ctx, "`field + duration` read as field.plus(duration): the field is taken for a date"); return { expr: call(l.expr, "plus", [shift(r)]), kind: "date" }; }
    return { expr: build.binary("+", l.expr, r.expr), kind: l.kind === r.kind ? l.kind : "unknown" };
  }
  if (op === "-") {
    if (l.kind === "date" && r.kind === "duration") return { expr: call(l.expr, "minus", [shift(r)]), kind: "date" };
    if (l.kind === "date" && r.kind === "date") return { expr: call(r.expr, "until", [l.expr]), kind: "duration" };
    if (l.kind === "date" && r.kind === "unknown") {
      // `date - field`: Dataview subtracts a date (→ duration) or a duration (→ date). A field is read as a date.
      warn(ctx, "`date - field` read as date(field).until(date): the field is taken for a date, the result a duration");
      return { expr: call(call(null, "date", [r.expr]), "until", [l.expr]), kind: "duration" };
    }
    if (l.kind === "unknown" && r.kind === "date") {
      return { expr: call(r.expr, "until", [call(null, "date", [l.expr])]), kind: "duration" };
    }
    if (l.kind === "unknown" && r.kind === "duration") {
      warn(ctx, "`field - duration` read as field.minus(duration): the field is taken for a date");
      return { expr: call(l.expr, "minus", [shift(r)]), kind: "date" };
    }
    return { expr: build.binary("-", l.expr, r.expr), kind: l.kind === r.kind ? l.kind : "unknown" };
  }
  if (l.kind === "date" || r.kind === "date") throw unsupported(`date ${op} x`, "a date only adds or subtracts", at(ctx, e));
  return { expr: build.binary(op, l.expr, r.expr), kind: l.kind === "duration" || r.kind === "duration" ? "duration" : "number" };
}

// ---- predicates ------------------------------------------------------------------

/** A predicate position: the boolean structure is OQX's own `where` tree so the
 * consumer tests (`in_links exists { … }`) can sit inside and/or/not. */
export function toWhere(e: DExpr, ctx: Ctx): Where {
  switch (e.kind) {
    case "paren": return toWhere(e.expr, ctx);
    case "not": return build.not(toWhere(e.expr, ctx));
    case "binary":
      if (e.op === "&") return conjoin([toWhere(e.left, ctx), toWhere(e.right, ctx)])!;
      if (e.op === "|") return disjoin([toWhere(e.left, ctx), toWhere(e.right, ctx)]);
      break;
    case "call": {
      const w = containsWhere(e, ctx);
      if (w) return w;
      break;
    }
    default: break;
  }
  const v = toValue(e, ctx);
  if (v.rows) throw unsupported("rows", "the bare rows collection is not a predicate", at(ctx, e));
  return build.scalar(v.expr);
}
