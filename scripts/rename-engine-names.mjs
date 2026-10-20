#!/usr/bin/env node
// Rewrite a surface 4.x OQX query to the 5.0 spelling (spec/surface §1.2,
// "underscore = engine"): every ENGINE name a query reads — an attribute
// (`title` → `_title`), a source handle (`data.k` → `_data.k`), a relation
// (`blocks` → `_blocks`), a reach-through (`doc.x` → `_doc.x`), the root id
// (`^id` → `^_id`) — gains the prefix; the self aliases (`doc` on a document,
// `block` on a block, `section` on a node) become `$it`; a bare AUTHORED key
// (`layer`, `checked`, a frontmatter `title:`) and every collection name
// (`from docs`, `^docs`) stay as written. The rewrite is SPAN-EXACT: it edits
// the identifiers in place and keeps the query's formatting, sugar and
// comments-in-spelling (`&&` vs `and`, `nodes { … }` vs `nodes collect { … }`).
//
// Which identifiers are engine names depends on the ROW KIND they are read
// from, so the script resolves every reference's scope with `@omgbase/oqx`'s
// `references` pass (AST.md §5b) and the 4.11 kind tables below — exactly the
// judgement names.ts made before 5.0, run in reverse.
//
// Usage:
//   node scripts/rename-engine-names.mjs 'select title, path from docs'   # prints the 5.0 query
//   echo 'from blocks where type == "task"' | node scripts/rename-engine-names.mjs
// As a module: `rewriteQuery(source)`, `rewriteExpression(source, kind)`.
//
// A query that uses a 4.x name in a position the script cannot type (a
// member on a value it does not know the kind of) is left as written there and
// listed on stderr — read those by hand.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const oqx = await import(join(here, "..", "packages", "oqx", "dist", "index.js"));
const { parse, references, visit } = oqx;

// ---- the 4.11 vocabulary (spec/surface 4.11 §1.2) -----------------------------

const ROOTS = new Set(["docs", "blocks", "nodes", "links", "revisions"]);

/** per kind: the attributes, the self alias, the reach-throughs (→ kind), the relations (→ kind), the docs source handles */
const OLD = {
  docs: {
    attrs: new Set(["id", "path", "raw", "hash", "updated_at", "created_at", "title", "tags", "format"]),
    self: "doc",
    reach: {},
    rel: { blocks: "blocks", nodes: "nodes", out_links: "links", in_links: "links", revisions: "revisions" },
    handles: new Set(["data", "frontmatter", "inline"]),
  },
  blocks: {
    attrs: new Set(["id", "path", "raw", "hash", "updated_at", "created_at", "doc_id", "type", "text", "attrs", "depth", "ordinal"]),
    self: "block",
    reach: { doc: "docs" },
    rel: { children: "blocks", nodes: "nodes", out_links: "links", section: "nodes" },
    handles: new Set(),
  },
  nodes: {
    attrs: new Set(["id", "path", "doc_id", "block_id", "kind", "name", "value", "attrs"]),
    self: "section",
    reach: { doc: "docs", block: "blocks" },
    rel: { blocks: "blocks", subsections: "nodes", children: "nodes" },
    handles: new Set(),
  },
  links: {
    attrs: new Set(["id", "path", "doc_id", "block_id", "via_id", "dst_id", "dst_path", "uri", "field", "dst_kind", "predicate", "provenance", "anchor"]),
    self: null,
    reach: { doc: "docs", dst: "docs", block: "blocks" },
    rel: {},
    handles: new Set(),
  },
  revisions: {
    attrs: new Set(["id", "path", "rev", "seq", "doc_id", "commit", "ts", "origin", "actor", "reason", "hash", "is_current", "archived"]),
    self: null,
    reach: { doc: "docs" },
    rel: {},
    handles: new Set(),
  },
};

// ---- the kind of a scope (names.ts's walk, over the 4.11 tables) --------------

function dotted(e) {
  if (e.kind === "ident" || e.kind === "outer") return { head: e, rest: [] };
  if (e.kind !== "member") return null;
  const inner = dotted(e.recv);
  return inner === null ? null : { head: inner.head, rest: [...inner.rest, e.name] };
}

/** Follow a dotted path from a row kind (or "root") through the 4.11 self/reach/relations. */
function kindOfPath(on, path) {
  let cur = on;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (cur === null) return null;
    if (cur === "root") {
      if (seg === "$it") continue;
      if (!ROOTS.has(seg)) return null;
      cur = seg;
      continue;
    }
    if (typeof cur === "object") {
      if (seg !== "rows" || i !== 0) return null;
      cur = cur.group;
      continue;
    }
    if (seg === "$it" && i === 0) continue;
    const k = OLD[cur];
    if (k.self === seg) continue;
    const next = k.reach[seg] ?? k.rel[seg];
    if (next === undefined) return null;
    cur = next;
  }
  return cur === "root" || typeof cur === "object" ? null : cur;
}

function kindOfExpr(e, on, readDepth, byDepth) {
  switch (e.kind) {
    case "ident": return kindOfPath(on, [e.name]);
    case "outer": {
      const k = readDepth - e.levels;
      return kindOfPath(k <= 0 ? "root" : byDepth.get(k) ?? null, [e.name]);
    }
    case "member": {
      const path = dotted(e);
      if (path === null) return kindOfMemberOnValue(e, on, readDepth, byDepth);
      const head = path.head;
      const base = head.kind === "ident" ? on : (readDepth - head.levels <= 0 ? "root" : byDepth.get(readDepth - head.levels) ?? null);
      return kindOfPath(base, [head.name, ...path.rest]);
    }
    case "call": return e.recv === null && e.name === "refs" ? "docs" : null;
    case "required": return kindOfExpr(e.expr, on, readDepth, byDepth);
    case "op": {
      if (e.sub.select.some((it) => it.name !== "$key") || e.sub.values) return null;
      let k = kindOfExpr(e.receiver, on, readDepth, byDepth);
      for (const f of e.sub.from) k = k === null ? null : kindOfExpr(f, k, readDepth + 1, byDepth);
      return k;
    }
    default: return null;
  }
}

/** `<value>.a.b` where the value is a call or a block: the head's kind, then the path. */
function kindOfMemberOnValue(e, on, readDepth, byDepth) {
  const names = [];
  let cur = e;
  while (cur.kind === "member") { names.unshift(cur.name); cur = cur.recv; }
  const head = kindOfExpr(cur, on, readDepth, byDepth);
  return head === null ? null : kindOfPath(head, names);
}

function kindOfFrontier(seed, f, readDepth, byDepth) {
  if (seed === null) return null;
  for (const d of f.destinations) if (kindOfExpr(d, seed, readDepth, byDepth) !== seed) return null;
  return seed;
}

function kindOfScope(steps) {
  if (steps.length === 0) return "root";
  const byDepth = new Map([[0, "root"]]);
  let cur = "root";
  let readDepth = 0;
  for (const step of steps) {
    const e = step.expr;
    if (e.kind === "follow") cur = kindOfFrontier(cur === "root" || typeof cur === "object" ? null : cur, e, readDepth, byDepth);
    else if (e.kind === "groupBy") cur = { group: cur === "root" || typeof cur === "object" ? null : cur };
    else cur = kindOfExpr(e, cur, readDepth, byDepth);
    byDepth.set(step.depth, cur);
    readDepth = step.depth;
  }
  return cur === "root" || typeof cur === "object" ? null : cur;
}

// ---- renaming a chain ---------------------------------------------------------

/**
 * The 5.0 spelling of a dotted chain read on rows of `kind` ("root" for the
 * root scope). Returns the new segments, or null when nothing changes.
 */
function renameChain(kind, segs) {
  const out = [...segs];
  let changed = false;
  let cur = kind;
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (cur === null) break;
    if (s === "$it") continue;
    if (cur === "root") {
      if (s === "id") { out[i] = "_id"; changed = true; }
      // `^docs`, `^$it.docs`: a collection stays bare; what follows it reads that kind
      if (ROOTS.has(s)) { cur = s; continue; }
      break;
    }
    const k = OLD[cur];
    if (k.attrs.has(s)) { out[i] = `_${s}`; changed = true; break; } // the rest is the value's own navigation
    if (k.handles.has(s)) { out[i] = `_${s}`; changed = true; break; } // the rest is authored
    if (k.self === s) { out[i] = "$it"; changed = true; continue; }
    if (k.reach[s] !== undefined) { out[i] = `_${s}`; changed = true; cur = k.reach[s]; continue; }
    if (k.rel[s] !== undefined) { out[i] = `_${s}`; changed = true; cur = k.rel[s]; continue; }
    break; // an authored key (or a bare root name): as written, and the rest with it
  }
  return changed ? out : null;
}

const CHAIN_RE = /^(\d*\^*)([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)$/;

// ---- the rewrite ------------------------------------------------------------------

/**
 * Rewrite one query. Returns `{ source, warnings }`: the 5.0 text and the
 * positions the script could not type (left as written).
 */
export function rewriteQueryDetailed(source) {
  const q = parse(source);
  const cps = Array.from(source);
  const edits = []; // { start, end, text } in code points
  const warnings = [];
  const seen = new Set();
  const edit = (start, end, text) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    edits.push({ start, end, text });
  };

  // Pass 1: every reference (a bare identifier, a dotted navigation headed by
  // one, an outer reference) at a typed scope.
  const edited = new Set(); // reference span starts
  for (const ref of references(q)) {
    const kind = kindOfScope(ref.scope.steps);
    if (kind === null) { warnings.push(`untyped scope at ${ref.span[0]}: ${ref.name}`); continue; }
    const [start, end] = ref.span;
    const text = cps.slice(start, end).join("");
    const m = CHAIN_RE.exec(text);
    if (!m) { warnings.push(`unreadable chain at ${start}: ${text}`); continue; }
    const carets = m[1];
    const segs = m[2].split(".").map((s) => s.trim());
    const renamed = renameChain(kind, segs);
    edited.add(start);
    if (renamed === null) continue;
    // Re-emit the chain keeping the original separators' spacing (none expected).
    edit(start, end, carets + renamed.join("."));
  }

  // Pass 1b: a bare-field select item (`select title`) is also an ALIAS of
  // that name for the body's `where`/`having` and the items to its right
  // (SEMANTICS §14) — `references` skips those reads. When the item was renamed
  // (`_title`), the alias moved with it, so every read of the old alias name
  // moves too; a read that resolves to an unchanged alias stays.
  // The same for a `flatten <name>` with no `as` (0.25): the bound name is the
  // expression's own, so `flatten tags` → `flatten _tags` rebinds `_tags`, and
  // the post-flatten reads of `tags` (select, order by, group by, having, a
  // later flatten) move with it.
  const aliasMaps = new Map(); // body → Map(old alias → new)
  visit(q, {
    enter(node) {
      if (node.kind !== "query" && node.kind !== "subquery") return;
      const map = new Map();
      for (const it of node.select) {
        if (it.kind !== "field" || it.lift !== 0 || it.expr.kind !== "ident" || it.expr.name !== it.name) continue;
        const e = edits.find((x) => x.start === it.expr.span[0] && x.end === it.expr.span[1]);
        if (e) map.set(it.name, e.text);
      }
      for (const f of node.flatten ?? []) {
        if (f.expr.kind !== "ident" || f.expr.name !== f.name) continue;
        const e = edits.find((x) => x.start === f.expr.span[0] && x.end === f.expr.span[1]);
        if (e) map.set(f.name, e.text);
      }
      if (map.size > 0) aliasMaps.set(node, map);
    },
  });
  if (aliasMaps.size > 0) {
    visit(q, {
      enter(node, ctx) {
        if (node.kind !== "ident" || edited.has(node.span[0])) return;
        if (!["where", "having", "select", "orderBy", "groupBy", "flatten"].includes(ctx.clause)) return;
        for (let i = ctx.path.length - 1; i >= 0; i--) {
          const a = ctx.path[i];
          if (a.kind !== "query" && a.kind !== "subquery") continue;
          const map = aliasMaps.get(a);
          const to = map?.get(node.name);
          if (to !== undefined) edit(node.span[0], node.span[1], to);
          return;
        }
      },
    });
  }

  // Pass 1c: a `flatten <rows> as <name>` binds `<name>` to a ROW of the
  // flattened expression's kind (`flatten blocks { … } as b` → `b` is a block),
  // and `references` skips the reads of the bound name — so `b.text` after it
  // is renamed here by that kind.
  const boundRows = new Map(); // body → Map(bound name → kind)
  visit(q, {
    enter(node, ctx) {
      if (node.kind !== "query" && node.kind !== "subquery") return;
      const map = new Map();
      for (const f of node.flatten ?? []) {
        if (f.expr.kind === "ident" && f.expr.name === f.name) continue; // a self-named flatten (pass 1b)
        const scope = node.kind === "query" ? kindOfExpr(node.source, "root", 0, new Map([[0, "root"]])) : scopeKindAt({ path: [...ctx.path, node], depth: ctx.depth + 1 });
        const kind = scope === null ? null : kindOfExpr(f.expr, scope, ctx.depth + 1, new Map([[0, "root"]]));
        if (kind !== null) map.set(f.name, kind);
      }
      if (map.size > 0) boundRows.set(node, map);
    },
  });
  if (boundRows.size > 0) {
    visit(q, {
      enter(node, ctx) {
        if (node.kind !== "member") return;
        const d = dotted(node);
        if (d === null || d.head.kind !== "ident" || edited.has(node.span[0])) return;
        for (let i = ctx.path.length - 1; i >= 0; i--) {
          const a = ctx.path[i];
          if (a.kind !== "query" && a.kind !== "subquery") continue;
          const kind = boundRows.get(a)?.get(d.head.name);
          if (kind === undefined) return;
          const renamed = renameChain(kind, d.rest);
          if (renamed === null) return false;
          const [start, end] = node.span;
          const text = cps.slice(start, end).join("");
          const m = CHAIN_RE.exec(text);
          if (!m) { warnings.push(`unreadable chain at ${start}: ${text}`); return false; }
          edit(start, end, m[1] + [d.head.name, ...renamed].join("."));
          return false;
        }
      },
    });
  }

  // Pass 2: a navigation on a VALUE the pass above does not report — a call
  // (`refs(x).path`), a block (`^docs[path == ^x].path`, `refs(x)[0].path`,
  // `dst { }`) — whose kind we can still work out.
  visit(q, {
    enter(node, ctx) {
      if (node.kind !== "member") return;
      if (dotted(node) !== null) return false; // pass 1's
      const names = [];
      let cur = node;
      const members = [];
      while (cur.kind === "member") { names.unshift(cur.name); members.unshift(cur); cur = cur.recv; }
      const scopeKind = scopeKindAt(ctx);
      const head = kindOfExpr(cur, scopeKind, ctx.depth, new Map([[0, "root"]]));
      if (head === null) { warnings.push(`untyped value at ${node.span[0]}`); return; }
      const renamed = renameChain(head, names);
      if (renamed === null) return;
      members.forEach((mem, i) => {
        if (renamed[i] === names[i]) return;
        const end = mem.span[1];
        const start = end - Array.from(names[i]).length;
        if (cps.slice(start, end).join("") !== names[i]) { warnings.push(`member text mismatch at ${start}`); return; }
        edit(start, end, renamed[i]);
      });
      return;
    },
  });

  edits.sort((a, b) => b.start - a.start);
  let out = cps;
  for (const e of edits) out = [...out.slice(0, e.start), ...Array.from(e.text), ...out.slice(e.end)];
  return { source: out.join(""), warnings };
}

/** The kind of the rows at a visit position: the query's source chain by depth (an approximation for pass 2 — the receiver of a value is usually a root). */
function scopeKindAt(ctx) {
  // Walk the ancestors as `references` does: the query source, the op receivers.
  let cur = "root";
  let depth = 0;
  const byDepth = new Map([[0, "root"]]);
  for (let i = 0; i < ctx.path.length; i++) {
    const a = ctx.path[i];
    const next = ctx.path[i + 1];
    if (a.kind === "query") {
      if (next === a.source) break;
      depth = 1;
      cur = kindOfExpr(a.source, "root", 0, byDepth);
      byDepth.set(1, cur);
      for (const f of a.from) if (f !== next) cur = cur === null ? null : kindOfExpr(f, cur, 1, byDepth);
    } else if (a.kind === "op") {
      if (next !== a.sub) break;
      depth += 1;
      cur = cur === null ? null : kindOfExpr(a.receiver, cur, depth - 1, byDepth);
      byDepth.set(depth, cur);
    } else if (a.kind === "follow") {
      // destinations are read on the frontier rows: the seeds' kind
    }
  }
  return cur;
}

export function rewriteQuery(source) {
  return rewriteQueryDetailed(source).source;
}

/** Rewrite one EXPRESSION read on rows of `kind` (`docs` by default): a `{ oqx }` slot, a `-> ` leader's expression, a `graph.select` item. */
export function rewriteExpression(source, kind = "docs") {
  const prefix = "select __x: ";
  const suffix = ` from ${kind}`;
  const { source: out, warnings } = rewriteQueryDetailed(prefix + source + suffix);
  return { source: out.slice(prefix.length, out.length - suffix.length), warnings };
}

// ---- CLI ---------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = process.argv.slice(2).join(" ");
  const input = arg !== "" ? arg : await new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => resolve(s.trim()));
  });
  const { source, warnings } = rewriteQueryDetailed(input);
  process.stdout.write(source + "\n");
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
}

void require;
