// The write side of the connector: turning "link /a.md to /b.md" into ONE
// `apply` whose storage the USER chose. A rendered edge says nothing about
// where a new relationship should live, and a document may already hold several
// path-valued frontmatter fields, so `relationChoices` lists every candidate —
// each list field (append), each scalar path field (make it a list, or replace
// its value with the loss spelled out), a new list field, a body link — and the
// page asks; nothing here picks a storage silently.
//
// `attachRelationCommand` is a `@omgbase/client` `RepositoryCommand`: the
// forward write re-reads the source document and pins the effect to its
// revision (a document that moved on is `stale_plan`, not a clobber); the
// compensation re-reads again and REFUSES unless the field (or the inserted
// block) still holds exactly what the write produced, so an undo never undoes
// someone else's concurrent edit. Values are written as rooted paths (`/b.md`),
// the form `_path` carries and `](/b.md)` resolves to.

import { insertMarkdown, removeBlocks, setFrontmatter, unsetFrontmatter, type Applied, type CommandClient, type Compensation, type Effect, type RepositoryCommand } from "@omgbase/client";
import { wikiStem } from "./links.ts";
import { rooted } from "./paths.ts";

export type RelationChoice =
  /** An existing frontmatter field holding a path (`replace-scalar` | `to-list`) or paths (`append`). */
  | { kind: "frontmatter"; field: string; current: string[]; mode: "append" | "to-list" | "replace-scalar"; note: string }
  /** A new list field the user names (`field` is the user's text; "" until typed). */
  | { kind: "frontmatter-new"; field: string }
  /** A Markdown link paragraph appended to the body. */
  | { kind: "body-link" };

/** A `/`-rooted `.md` path or a `[[wikilink]]`. */
export function isPathValue(v: unknown): v is string {
  return typeof v === "string" && (/^\/[^\s]+\.md$/i.test(v) || /^\[\[[^\]]+\]\]$/.test(v));
}

/** Does `v` (a path or a wikilink) name the document at `to`? */
export function namesDocument(v: string, to: string): boolean {
  if (v.startsWith("[[")) {
    const name = v.slice(2, -2).split("|")[0]!.trim();
    return name === wikiStem(to) || rooted(name.replace(/\.md$/i, "")) === rooted(to).replace(/\.md$/i, "");
  }
  return rooted(v) === rooted(to);
}

/** Every storage the relationship `from → to` could take, for the user to choose from.
 * A field that already names `to` is left out (appending it would duplicate the link). */
export function relationChoices(sourceDoc: { frontmatter: Record<string, unknown> }, to: string): RelationChoice[] {
  const target = rooted(to);
  const out: RelationChoice[] = [];
  for (const [field, value] of Object.entries(sourceDoc.frontmatter ?? {})) {
    if (Array.isArray(value)) {
      if (value.length === 0 || !value.every(isPathValue)) continue;
      if (value.some((v) => namesDocument(v, target))) continue;
      out.push({ kind: "frontmatter", field, current: [...value], mode: "append", note: `append to the ${value.length}-entry list` });
    } else if (isPathValue(value)) {
      if (namesDocument(value, target)) continue;
      out.push({ kind: "frontmatter", field, current: [value], mode: "to-list", note: `the field becomes a list: [${value}, ${target}]` });
      out.push({ kind: "frontmatter", field, current: [value], mode: "replace-scalar", note: `replaces ${value}, which is dropped` });
    }
  }
  out.push({ kind: "frontmatter-new", field: "" });
  out.push({ kind: "body-link" });
  return out;
}

/** The one line the confirm dialog shows. */
export function describeRelation(how: RelationChoice, from: string, to: string): string {
  const f = rooted(from), t = rooted(to);
  switch (how.kind) {
    case "frontmatter":
      if (how.mode === "append") return `append ${t} to frontmatter \`${how.field}\` of ${f} (now ${how.current.length + 1} entries)`;
      if (how.mode === "to-list") return `turn frontmatter \`${how.field}\` of ${f} into a list [${how.current[0] ?? ""}, ${t}]`;
      return `replace ${how.current[0] ?? "the value"} with ${t} in frontmatter \`${how.field}\` of ${f}`;
    case "frontmatter-new":
      return `create frontmatter list \`${how.field || "<field>"}\` on ${f} with ${t}`;
    case "body-link":
      return `append a link to ${t} at the end of ${f}`;
  }
}

export type RelationState =
  | { kind: "frontmatter"; field: string; revision: string | null; previous: unknown; existed: boolean; written: unknown }
  | { kind: "body-link"; blockId: string | null; hash: string | null; markdown: string };

export interface AttachRelationInput {
  from: string;
  to: string;
  /** The destination's title for the body link's text (default: the path's stem). */
  toTitle?: string | null;
  how: RelationChoice;
  repo?: string | null;
  label?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The value a frontmatter choice writes over the field's CURRENT value (re-read at write time). */
export function nextFieldValue(how: RelationChoice, current: unknown, existed: boolean, to: string): unknown {
  const t = rooted(to);
  if (how.kind === "frontmatter-new") {
    if (existed) throw new Error(`frontmatter field \`${how.field}\` already exists — choose it as an existing field instead`);
    return [t];
  }
  if (how.kind !== "frontmatter") throw new Error("not a frontmatter choice");
  if (Array.isArray(current)) {
    if (current.some((v) => typeof v === "string" && namesDocument(v, t))) throw new Error(`\`${how.field}\` already names ${t}`);
    return [...current, t];
  }
  if (how.mode === "replace-scalar") return t;
  if (!existed || current === null || current === undefined) return [t];
  if (typeof current === "string" && namesDocument(current, t)) throw new Error(`\`${how.field}\` already names ${t}`);
  return [current, t];
}

/** The Markdown of the appended link paragraph. */
export function bodyLinkMarkdown(to: string, title: string | null | undefined): string {
  const t = rooted(to);
  const text = (title ?? "").trim() || wikiStem(t);
  return `[${text.replace(/[[\]]/g, "")}](${t})`;
}

/** The ids present after a write and not before, top level only, in document order. */
export function newTopLevelBlocks(before: readonly string[], after: readonly string[], parents: Record<string, string | null> = {}): string[] {
  const old = new Set(before);
  return after.filter((id) => !old.has(id) && (parents[id] ?? null) === null);
}

/** Attach `from → to` the way the user chose; undo compensates only when the write is still intact. */
export function attachRelationCommand(input: AttachRelationInput): RepositoryCommand<RelationState> {
  const from = rooted(input.from), to = rooted(input.to), { how, repo } = input;
  const label = input.label ?? describeRelation(how, from, to);
  const guard = (rev: string | null) => (rev ? { revision: rev } : undefined);

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
        return { receipts: [receipt], revisions: receipt.revisions, state: { kind: "body-link", blockId, hash, markdown } };
      },
      async compensate(ctx, applied: Applied<RelationState>): Promise<Compensation> {
        const s = applied.state;
        if (s.kind !== "body-link") return { refused: "not a body-link state" };
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
  const readField = async (client: CommandClient) => {
    const d = await client.docsRead({ _path: from }, { repo });
    const fm = d.properties.frontmatter ?? {};
    return { revision: d.rev, value: fm[field], existed: Object.prototype.hasOwnProperty.call(fm, field) };
  };
  return {
    kind: "repository",
    label,
    async apply(ctx) {
      if (!field) throw new Error("the new frontmatter field needs a name");
      const before = await readField(ctx.client);
      const value = nextFieldValue(how, before.value, before.existed, to);
      const effect: Effect = setFrontmatter(from, field, value, guard(before.revision));
      const receipt = await ctx.client.apply({ effects: [effect], reason: label, repo });
      return { receipts: [receipt], revisions: receipt.revisions, state: { kind: "frontmatter", field, revision: before.revision, previous: before.value, existed: before.existed, written: value } };
    },
    async compensate(ctx, applied: Applied<RelationState>): Promise<Compensation> {
      const s = applied.state;
      if (s.kind !== "frontmatter") return { refused: "not a frontmatter state" };
      const now = await readField(ctx.client);
      if (!now.existed) return { refused: `\`${field}\` is gone from ${from}` };
      if (!same(now.value, s.written)) return { refused: `\`${field}\` no longer holds the value this command wrote (now ${JSON.stringify(now.value)})` };
      const effect = s.existed ? setFrontmatter(from, field, s.previous, guard(now.revision)) : unsetFrontmatter(from, field, guard(now.revision));
      return { effects: [effect], reason: s.existed ? `restore \`${field}\`` : `remove \`${field}\`` };
    },
  };
}
