// Relations as commands on the log: ATTACHING `from → to` (a connector drop)
// and DETACHING it (an edge deleted), each ONE guarded `apply`, each undoable.
//
// A relation lives in one of two places — a frontmatter field holding a path or
// a list of paths (`{ kind: "frontmatter", field }`), or a Markdown link in the
// body (`{ kind: "body-link" }`). `relationKinds` lists the kinds a connector
// should offer: the frontmatter fields the RENDERED graph already uses (by
// frequency), the source document's own list-of-paths fields the host passes
// in, then the body link — the vocabulary of the graph on screen, not a form.
//
// Attaching is ADDITIVE, always: an absent field becomes `[to]`, a list gains
// `to` (already there → the command throws before writing, so the log records
// `failed` with nothing applied), a scalar path becomes `[scalar, to]`; a scalar
// that is not a path is refused — nothing here ever replaces a value. Severing
// is the explicit `detachRelationCommand`: the list without `to` (empty → the
// field is unset), or the body link's block removed by its hash.
//
// Every forward write re-reads the source document and pins the effect to its
// revision (a document that moved on is `stale_plan`, not a clobber); every
// compensation re-reads again and REFUSES unless the field (or the block) still
// holds exactly what the write produced, so an undo never undoes someone else's
// concurrent edit. Values are written as rooted paths (`/b.md`), the form
// `_path` carries and `](/b.md)` resolves to.

import type { Applied, CommandClient, Compensation, RepositoryCommand } from "./commands.js";
import { OmgError } from "./client.js";
import { pathStem, rootedPath } from "./commands-documents.js";
import { insertMarkdown, removeBlocks, setFrontmatter, unsetFrontmatter, type Effect } from "./effects.js";

// ---- kinds ----------------------------------------------------------------------------

/** Where a relation is (or would be) authored. */
export type RelationKind = { kind: "frontmatter"; field: string } | { kind: "body-link" };

/** What `relationKinds` reads of a rendered edge: where it was authored and in which field. */
export interface EdgeProvenance {
  provenance: "frontmatter" | "body" | "external" | string;
  field: string | null;
}

/** How many rendered edges each frontmatter field carries (`field` → count); body and external edges are not counted. */
export function fieldCounts(edges: readonly EdgeProvenance[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) {
    if (e.provenance !== "frontmatter" || !e.field) continue;
    counts.set(e.field, (counts.get(e.field) ?? 0) + 1);
  }
  return counts;
}

/** The relation kinds a connector offers, in display order: the distinct
 * frontmatter FIELDS seen on the rendered edges (by frequency, then name), then
 * `extra` fields not already present (the source document's own list-of-paths
 * fields — the host supplies them), then the body link. Never empty. */
export function relationKinds(edges: readonly EdgeProvenance[], extra: readonly string[] = []): RelationKind[] {
  const counts = fieldCounts(edges);
  const fields = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([field]) => field);
  for (const f of extra) if (f.trim() !== "" && !fields.includes(f)) fields.push(f);
  return [...fields.map((field): RelationKind => ({ kind: "frontmatter", field })), { kind: "body-link" }];
}

// ---- values ---------------------------------------------------------------------------

/** A `/`-rooted `.md` path or a `[[wikilink]]`. */
export function isPathValue(v: unknown): v is string {
  return typeof v === "string" && (/^\/[^\s]+\.md$/i.test(v) || /^\[\[[^\]]+\]\]$/.test(v));
}

/** Does `v` (a path or a wikilink) name the document at `to`? */
export function namesDocument(v: string, to: string): boolean {
  if (v.startsWith("[[")) {
    const name = v.slice(2, -2).split("|")[0]!.trim();
    return name === pathStem(to) || rootedPath(name.replace(/\.md$/i, "")) === rootedPath(to).replace(/\.md$/i, "");
  }
  return rootedPath(v) === rootedPath(to);
}

/** The Markdown of the appended link paragraph. */
export function bodyLinkMarkdown(to: string, title: string | null | undefined): string {
  const t = rootedPath(to);
  const text = (title ?? "").trim() || pathStem(t);
  return `[${text.replace(/[[\]]/g, "")}](${t})`;
}

/** The ids present after a write and not before, top level only, in document order. */
export function newTopLevelBlocks(before: readonly string[], after: readonly string[], parents: Record<string, string | null> = {}): string[] {
  const old = new Set(before);
  return after.filter((id) => !old.has(id) && (parents[id] ?? null) === null);
}

/** What a frontmatter value is, in words, for the refusal of a non-path scalar. */
function kindOfValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a record";
  if (typeof v === "string") return "a string that is not a path";
  return `a ${typeof v}`;
}

// ---- descriptions ---------------------------------------------------------------------

/** The one line for an attach: "add /b.md to `depends_on` of /a.md" / "link /b.md from the body of /a.md". */
export function describeRelation(how: RelationKind, from: string, to: string): string {
  const f = rootedPath(from), t = rootedPath(to);
  return how.kind === "frontmatter" ? `add ${t} to \`${how.field}\` of ${f}` : `link ${t} from the body of ${f}`;
}

/** The one line for a detach: "remove /b.md from `depends_on` of /a.md" / "remove the body link to /b.md from /a.md". */
export function describeDetach(how: RelationKind, from: string, to: string): string {
  const f = rootedPath(from), t = rootedPath(to);
  return how.kind === "frontmatter" ? `remove ${t} from \`${how.field}\` of ${f}` : `remove the body link to ${t} from ${f}`;
}

// ---- attach ---------------------------------------------------------------------------

export interface AttachFrontmatterState {
  field: string;
  /** The field's value before the write (`undefined` when absent). */
  previous: unknown;
  existed: boolean;
  /** The value the write put there (the compensation's guard). */
  written: unknown;
}

export interface AttachBodyLinkState {
  /** The inserted paragraph's block id (null when it could not be identified — the undo refuses). */
  blockId: string | null;
  /** Its hash right after the write (the compensation's CAS). */
  hash: string | null;
}

export type AttachRelationState = AttachFrontmatterState | AttachBodyLinkState;

export interface AttachRelationInput {
  from: string;
  to: string;
  /** The destination's title for the body link's text (default: the path's stem). */
  toTitle?: string | null;
  how: RelationKind;
  repo?: string | null;
  label?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const guard = (rev: string | null) => (rev ? { revision: rev } : undefined);

async function readField(client: CommandClient, from: string, field: string, repo: string | null | undefined) {
  const d = await client.docsRead({ _path: from }, { repo });
  const fm = d.properties.frontmatter ?? {};
  return { revision: d.rev, value: fm[field], existed: Object.prototype.hasOwnProperty.call(fm, field) };
}

/** The value an additive attach writes over the field's CURRENT value: `[to]`
 * for an absent field, the list plus `to`, `[scalar, to]` for a scalar path.
 * Throws for a field that already names `to` and for a scalar that is not a path. */
export function attachedValue(field: string, current: unknown, existed: boolean, from: string, to: string): unknown[] {
  const t = rootedPath(to);
  if (!existed || current === undefined || current === null) return [t];
  if (Array.isArray(current)) {
    if (current.some((v) => typeof v === "string" && namesDocument(v, t))) throw new Error(`already related: ${t} is already in \`${field}\` of ${rootedPath(from)}`);
    return [...current, t];
  }
  if (isPathValue(current)) {
    if (namesDocument(current, t)) throw new Error(`already related: \`${field}\` of ${rootedPath(from)} already names ${t}`);
    return [current, t];
  }
  throw new Error(`\`${field}\` holds ${kindOfValue(current)}, not a path or a list of paths`);
}

/** Attach `from → to` additively; undo compensates only when the write is still intact. */
export function attachRelationCommand(input: AttachRelationInput): RepositoryCommand<AttachRelationState> {
  const from = rootedPath(input.from), to = rootedPath(input.to), { how, repo } = input;
  const label = input.label ?? describeRelation(how, from, to);

  if (how.kind === "body-link") {
    const markdown = bodyLinkMarkdown(to, input.toTitle);
    const read = (client: CommandClient) => client.docsRead({ _path: from }, { includeIds: true, repo });
    return {
      kind: "repository",
      label,
      async apply(ctx) {
        const before = await read(ctx.client);
        const receipt = await ctx.client.apply({ effects: [insertMarkdown({ _path: from }, "end", markdown)], reason: label, repo });
        const after = await read(ctx.client);
        const fresh = newTopLevelBlocks(before.ids ?? [], after.ids ?? [], after.parents ?? {});
        const blockId = fresh[fresh.length - 1] ?? null;
        const hash = blockId ? after.hashes?.[blockId] ?? null : null;
        return { receipts: [receipt], revisions: receipt.revisions, state: { blockId, hash } };
      },
      async compensate(ctx, applied: Applied<AttachRelationState>): Promise<Compensation> {
        const s = applied.state;
        if (!("blockId" in s)) return { refused: "not a body-link state" };
        if (!s.blockId || !s.hash) return { refused: `the inserted block in ${from} could not be identified after the write` };
        const now = await read(ctx.client);
        if (!(now.ids ?? []).includes(s.blockId)) return { refused: `block ${s.blockId} is gone from ${from}` };
        const h = now.hashes?.[s.blockId];
        if (h !== s.hash) return { refused: `block ${s.blockId} changed since (hash ${h ?? "unknown"}, expected ${s.hash})` };
        return { effects: [removeBlocks([s.blockId], { [s.blockId]: { content_hash: s.hash } })], reason: `remove the link to ${to}` };
      },
    };
  }

  const field = how.field;
  return {
    kind: "repository",
    label,
    async apply(ctx) {
      if (!field.trim()) throw new Error("the frontmatter field needs a name");
      const before = await readField(ctx.client, from, field, repo);
      const value = attachedValue(field, before.value, before.existed, from, to);
      const effect: Effect = setFrontmatter(from, field, value, guard(before.revision));
      const receipt = await ctx.client.apply({ effects: [effect], reason: label, repo });
      return { receipts: [receipt], revisions: receipt.revisions, state: { field, previous: before.value, existed: before.existed, written: value } };
    },
    async compensate(ctx, applied: Applied<AttachRelationState>): Promise<Compensation> {
      const s = applied.state;
      if (!("field" in s)) return { refused: "not a frontmatter state" };
      const now = await readField(ctx.client, from, field, repo);
      if (!now.existed) return { refused: `\`${field}\` is gone from ${from}` };
      if (!same(now.value, s.written)) return { refused: `\`${field}\` no longer holds the value this command wrote (now ${JSON.stringify(now.value)})` };
      const effect = s.existed ? setFrontmatter(from, field, s.previous, guard(now.revision)) : unsetFrontmatter(from, field, guard(now.revision));
      return { effects: [effect], reason: s.existed ? `restore \`${field}\`` : `remove \`${field}\`` };
    },
  };
}

// ---- detach ---------------------------------------------------------------------------

export interface DetachFrontmatterState {
  field: string;
  /** The field's value before the detach. */
  previous: unknown;
  /** What the detach left there (`undefined`: the field was unset). */
  written: unknown;
}

export interface DetachBodyLinkState {
  blockId: string;
  /** The removed block's source, re-inserted at the END of the document on undo (its position is not restored). */
  markdown: string;
}

export type DetachRelationState = DetachFrontmatterState | DetachBodyLinkState;

export interface DetachRelationInput {
  from: string;
  to: string;
  how: RelationKind;
  repo?: string | null;
  /** The body link's block (`_block_id` of the edge's link row); required for `body-link`. */
  blockId?: string | null;
  label?: string;
}

/** The value a detach leaves in the field: the list without `to` (`undefined` when
 * that is empty — the field is unset), `undefined` for the scalar `to`. Throws
 * when the field is absent or does not name `to`. */
export function detachedValue(field: string, current: unknown, existed: boolean, from: string, to: string): unknown[] | undefined {
  const t = rootedPath(to);
  const f = rootedPath(from);
  if (!existed || current === undefined || current === null) throw new Error(`\`${field}\` of ${f} is absent; nothing names ${t}`);
  if (Array.isArray(current)) {
    const rest = current.filter((v) => !(typeof v === "string" && namesDocument(v, t)));
    if (rest.length === current.length) throw new Error(`\`${field}\` of ${f} does not name ${t}`);
    return rest.length === 0 ? undefined : rest;
  }
  if (isPathValue(current) && namesDocument(current, t)) return undefined;
  throw new Error(`\`${field}\` of ${f} does not name ${t}`);
}

/** The block's current `_raw` and `_hash` (null when it is gone, or not in `from`). */
async function readBlock(client: CommandClient, blockId: string, from: string, repo: string | null | undefined): Promise<{ raw: string; hash: string } | null> {
  const r = await client.query(`blocks { select _raw, _hash where _id == ${JSON.stringify(blockId)} }`, { limit: 1, repo });
  const hit = r.hits[0];
  if (!hit || typeof hit._hash !== "string") return null;
  if (typeof hit._path === "string" && rootedPath(hit._path) !== from) return null;
  return { raw: typeof hit._raw === "string" ? hit._raw : "", hash: hit._hash };
}

/** Sever `from → to`: the field without `to` (unset when empty), or the body
 * link's block removed by its hash. Undo restores the field pinned to the current
 * revision, or re-inserts the block's source at the end of the document. */
export function detachRelationCommand(input: DetachRelationInput): RepositoryCommand<DetachRelationState> {
  const from = rootedPath(input.from), to = rootedPath(input.to), { how, repo } = input;
  const label = input.label ?? describeDetach(how, from, to);

  if (how.kind === "body-link") {
    const blockId = input.blockId ?? null;
    return {
      kind: "repository",
      label,
      async apply(ctx) {
        if (!blockId) throw new Error(`the body link to ${to} needs its block id to be removed`);
        const block = await readBlock(ctx.client, blockId, from, repo);
        if (!block) throw new Error(`block ${blockId} is gone from ${from}`);
        const receipt = await ctx.client.apply({ effects: [removeBlocks([blockId], { [blockId]: { content_hash: block.hash } })], reason: label, repo });
        return { receipts: [receipt], revisions: receipt.revisions, state: { blockId, markdown: block.raw } };
      },
      async compensate(ctx, applied: Applied<DetachRelationState>): Promise<Compensation> {
        const s = applied.state;
        if (!("blockId" in s)) return { refused: "not a body-link state" };
        if (s.markdown.trim() === "") return { refused: `the removed block ${s.blockId} had no source to re-insert` };
        try {
          await ctx.client.docsRead({ _path: from }, { repo });
        } catch (e) {
          if (e instanceof OmgError && e.code === "doc_missing") return { refused: `${from} no longer exists` };
          throw e;
        }
        return { effects: [insertMarkdown({ _path: from }, "end", s.markdown)], reason: `re-insert the link to ${to} (at the end of ${from})` };
      },
    };
  }

  const field = how.field;
  return {
    kind: "repository",
    label,
    async apply(ctx) {
      const before = await readField(ctx.client, from, field, repo);
      const value = detachedValue(field, before.value, before.existed, from, to);
      const effect: Effect = value === undefined ? unsetFrontmatter(from, field, guard(before.revision)) : setFrontmatter(from, field, value, guard(before.revision));
      const receipt = await ctx.client.apply({ effects: [effect], reason: label, repo });
      return { receipts: [receipt], revisions: receipt.revisions, state: { field, previous: before.value, written: value } };
    },
    async compensate(ctx, applied: Applied<DetachRelationState>): Promise<Compensation> {
      const s = applied.state;
      if (!("field" in s)) return { refused: "not a frontmatter state" };
      const now = await readField(ctx.client, from, field, repo);
      if (s.written === undefined) {
        if (now.existed) return { refused: `\`${field}\` was set again since it was unset (now ${JSON.stringify(now.value)})` };
      } else {
        if (!now.existed) return { refused: `\`${field}\` is gone from ${from}` };
        if (!same(now.value, s.written)) return { refused: `\`${field}\` no longer holds the value this command wrote (now ${JSON.stringify(now.value)})` };
      }
      return { effects: [setFrontmatter(from, field, s.previous, guard(now.revision))], reason: `restore \`${field}\`` };
    },
  };
}
