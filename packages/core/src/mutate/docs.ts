import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import { parseTree } from "../core/parse/tree.js";
import { adapterForPath } from "../format/index.js";
import { findDoc, findDocByRef } from "../core/read/reader.js";
import { mintId } from "../core/ids.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { inboundLinksTo, retargetLinksInRaw, type InboundLink } from "../graph/inbound-links.js";
import { planChangeset, type Op } from "./apply.js";
import { commitChangeset, readDocBase, type CommitHead, type CommitTargets, type Effect } from "./commit.js";
import { resolveDocStore, type DocStore } from "./doc-store.js";
import { MutationError, type MutBlock, type MutDoc } from "./tree.js";

// Document-level operations (06 §API: docs_create/move/delete/set_meta; 11 §5.6
// new/mv/rm --doc/meta). These live in the library so both the CLI and the MCP
// server share one implementation (§1: the CLI holds no business logic). Each
// lowers to the internal effects `commit.ts` runs as ONE request: one
// transaction, one `api` commit with a generated reason (spec/mutate §6, 2.1) —
// under the workspace writer flock when a workspace dir is given.

export interface DocOpContext {
  repoId: string;
  /** Working-tree root for the default filesystem write target. Omit only when
   *  supplying an explicit `docStore` (e.g. a headless NullDocStore). */
  rootPath?: string;
  /** Write target (ADR-014 §5); defaults to a filesystem store at `rootPath`. */
  docStore?: DocStore;
  /** workspace .omgbase/ dir; when set, the write runs under the writer flock. */
  omgbaseDir?: string;
  actor?: string;
  /** Commit timestamp (RFC 3339 UTC) for every commit the operation records; defaults to now (see `ApplyRequest.ts`). */
  ts?: string;
  /**
   * Validate and plan only: every check the real operation makes (`doc_missing`,
   * `path_taken`, …) runs, nothing is written or committed, and the result
   * carries `committed: false` plus the per-file `diffs` the operation would
   * produce — the same shape `apply`'s `dryRun` returns. A create's `docId` is
   * the id the real run would mint next (a dry run consumes it, as `apply`'s does).
   */
  dryRun?: boolean;
}

function nowOr(ctx: DocOpContext): string {
  return ctx.ts ?? new Date().toISOString();
}

export interface DocOpResult {
  docId: string;
  path: string;
  committed: boolean;
  /**
   * With `dryRun`: the file changes the operation would make, keyed by
   * repo-relative path — `before` the current bytes (`""` for a file that
   * would be created), `after` the bytes the operation would leave (`""` for a
   * file that would be removed). A rename is two entries: the old path
   * emptied, the new path filled. Absent on a committed result.
   */
  diffs?: Record<string, { before: string; after: string }>;
}

export interface DocMoveOptions {
  /**
   * Rewrite the inbound links that named the OLD path so they point at the new
   * one — a destination-aware rewrite (anchors, link text, titles, and code
   * spans preserved; absolute/relative style kept) applied as a CAS-checked
   * `update` per source block, committed WITH the move as one commit (2.1).
   * **Default `true`** (spec/mutate 1.3): a move means "same document, new
   * place", so the authored links follow it; pass `false` for the rarer intent
   * that the old path become unbound. Frontmatter-level relations are never
   * rewritten (reported in `dangling`).
   */
  retargetInbound?: boolean;
}

export interface DocMoveResult extends DocOpResult {
  /**
   * Inbound links still pointing at the OLD path after this call — the source
   * blocks `links_stale` will now report (with the default retarget: only the
   * frontmatter relations, which are never rewritten). Computed from the open
   * edge index before the move.
   */
  dangling: InboundLink[];
  /**
   * The source blocks rewritten and the docs re-ingested (empty lists when the
   * rewrite ran but only frontmatter relations linked in); `null` when the
   * retarget was opted out (`retargetInbound: false`) or nothing linked in.
   */
  retargeted: { blocks: string[]; docs: string[] } | null;
}

function dirOf(path: string): string {
  return path.replace(/[^/]*$/, "");
}

function underLock<T>(ctx: DocOpContext, fn: () => T): T {
  return ctx.omgbaseDir ? withWriterLock(ctx.omgbaseDir, fn) : fn();
}

/** spec/mutate §6: the storage form of a document path — leading `/` stripped, `\` → `/`. */
export function canonicalDocPath(path: string): string {
  return path.replace(/^\/+/, "").split("\\").join("/");
}
const canonical = canonicalDocPath;

/** The one commit row a document operation records (spec/mutate §6). */
function head(ctx: DocOpContext, reason: string): CommitHead {
  return { origin: "api", actor: ctx.actor ?? null, reason };
}

function targets(ctx: DocOpContext, docStore: DocStore): CommitTargets {
  return { docStore, ...(ctx.omgbaseDir ? { omgbaseDir: ctx.omgbaseDir } : {}) };
}

/** Compose a full document's bytes from optional frontmatter + body markdown
 *  (spec/mutate §6 `docs_create`): the body with a trailing `\n` ensured; a
 *  non-empty frontmatter mapping becomes `---\n<yaml>\n---\n` followed by a
 *  blank line unless the body already starts with one. The effect planner's
 *  `set frontmatter.<k>` composes through this same function (§11.3), so its
 *  bytes equal `docs_set_meta`'s for the same patch. */
export function composeFile(markdown: string, frontmatter?: Record<string, unknown>): string {
  const body = markdown.endsWith("\n") || markdown.length === 0 ? markdown : markdown + "\n";
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const yaml = stringifyYaml(frontmatter).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

/**
 * A document this request CREATES as the planner's working tree (spec/mutate
 * §11.3, 3.0): `source` (the composed file) parsed per the path's format —
 * the frontmatter block becomes `frontmatterRaw` (its raw + its trailing
 * trivia, as `loadMutDoc` builds it), the bytes before it the leading trivia,
 * every body block a `MutBlock` with its exact trivia and an id minted NOW in
 * pre-order under the current minter (the symbolic one at plan time, so the
 * ids are `$new.k`; the production one at execute, so the replay mints the
 * same positions). `docId` is the plan's document symbol. The round-trip law
 * makes `renderDoc` of the result equal `source` byte for byte.
 */
export function parseNewDoc(symbol: string, path: string, source: string): MutDoc {
  const adapter = adapterForPath(path);
  const tree = adapter ? adapter.parse(source) : parseTree(source);
  const fm = tree.children[0]?.type === "frontmatter" ? tree.children[0] : null;
  const rest = fm ? tree.children.slice(1) : tree.children;
  const toMut = (b: RawBlock): MutBlock => ({ id: mintId("b"), type: b.type, raw: b.raw, trivia: b.trivia, attrs: b.attrs, children: b.children.map(toMut) });
  return {
    docId: symbol,
    path,
    format: adapter?.format ?? "markdown",
    leadingTrivia: tree.leadingTrivia,
    frontmatterRaw: fm ? fm.raw + fm.trivia : null,
    children: rest.map(toMut),
  };
}

/** docs_create: create a new document from complete file bytes (frontmatter incl.). */
export function docsCreate(store: Store, ctx: DocOpContext, path: string, markdown: string, frontmatter?: Record<string, unknown>): DocOpResult {
  const rel = canonical(path);
  const existing = findDoc(store, { repoId: ctx.repoId, path: rel });
  if (existing) throw new MutationError("path_taken", `document already exists at ${rel}`);
  const content = composeFile(markdown, frontmatter);

  const docStore = resolveDocStore(ctx);
  if (ctx.dryRun) {
    if (docStore.exists(rel)) throw new MutationError("path_taken", `file already exists on disk at ${rel}`);
    return { docId: mintId("d"), path: rel, committed: false, diffs: { [rel]: { before: "", after: content } } };
  }
  return underLock(ctx, () => {
    if (docStore.exists(rel)) throw new MutationError("path_taken", `file already exists on disk at ${rel}`);
    // `precondition: null`: no live document may be at the path when the
    // commit validates (the check above, re-run inside the transaction).
    const effects: Effect[] = [{ kind: "ingest_reconciled", path: rel, source: content, precondition: null }];
    if (ctx.omgbaseDir) effects.push({ kind: "record_stat", path: rel, bytes: content });
    const res = commitChangeset(store, ctx.repoId, head(ctx, `create ${rel}`), effects, nowOr(ctx), targets(ctx, docStore));
    return { docId: res.ingests[0]!.docId, path: rel, committed: true };
  });
}

/**
 * docs_move: rename a document to a new path (identity preserved). The edge
 * index follows the path, not the identity: links written against the OLD path
 * now dangle (their open edges are re-pointed at `phantom:<old>`, exactly what
 * re-extracting the source would produce, so `links_stale` sees them), and
 * phantom edges already written against the NEW path are adopted. By default
 * the dangling inbound links are rewritten to the new path in the SAME commit
 * (spec/mutate 1.3 for the default, 2.1 for the one commit); `retargetInbound:
 * false` leaves them as written and the result lists them.
 */
export function docsMove(store: Store, ctx: DocOpContext, docRef: string, toPath: string, opts: DocMoveOptions = {}): DocMoveResult {
  const retargetInbound = opts.retargetInbound !== false;
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);
  const toRel = canonical(toPath);
  if (findDoc(store, { repoId: ctx.repoId, path: toRel })) throw new MutationError("path_taken", `a document already exists at ${toRel}`);

  // Who links here BY PATH, as written — before the path changes.
  const inbound = inboundLinksTo(store, ctx.repoId, info.docId, info.path);

  const docStore = resolveDocStore(ctx);
  if (ctx.dryRun) {
    if (docStore.exists(toRel)) throw new MutationError("path_taken", `file already exists on disk at ${toRel}`);
    const content = docStore.read(info.path) ?? "";
    const diffs: Record<string, { before: string; after: string }> = { [info.path]: { before: content, after: "" }, [toRel]: { before: "", after: content } };
    const planned = { docId: info.docId, path: toRel, committed: false, diffs };
    if (!retargetInbound || inbound.length === 0) return { ...planned, dangling: inbound, retargeted: null };
    const plan = planInboundRetarget(store, info.docId, info.path, toRel, inbound);
    if (plan.ops.length > 0) {
      const preview = planChangeset(store, { ...applyCtx(ctx), ops: plan.ops, origin: { actor: ctx.actor ?? "api" } });
      Object.assign(diffs, preview.diffs);
    }
    return { ...planned, dangling: plan.dangling, retargeted: { blocks: plan.blocks, docs: plan.docs } };
  }
  // One lock, one commit (spec/sync §7, lock scope = write scope; spec/mutate
  // §6, 2.1): the rename + row update AND the inbound retarget are one request —
  // `move_path` first, so each rewritten source's edges resolve to the moved
  // document, then the retarget's `ingest_known` per source, all under the
  // commit `move <from> -> <to>`.
  return underLock(ctx, () => {
    if (docStore.exists(toRel)) throw new MutationError("path_taken", `file already exists on disk at ${toRel}`);
    const content = docStore.read(info.path) ?? "";

    const effects: Effect[] = [{ kind: "move_path", docId: info.docId, from: info.path, to: toRel, currentRev: info.currentRev, inbound, bytes: content }];
    if (ctx.omgbaseDir) effects.push({ kind: "clear_stat", path: info.path }, { kind: "record_stat", path: toRel, bytes: content });

    // Rewrite the dangling links block by block (one coalesced update per block,
    // CAS on the block's current hash); the re-ingest re-extracts each source
    // doc, whose links now resolve to the moved doc.
    const plan = retargetInbound && inbound.length > 0 ? planInboundRetarget(store, info.docId, info.path, toRel, inbound) : null;
    if (plan && plan.ops.length > 0) {
      const changeset = planChangeset(store, { ...applyCtx(ctx), ops: plan.ops, origin: { actor: ctx.actor ?? "api" } });
      for (const e of changeset.effects) {
        // The moved document is loaded under its OLD path (the row changes
        // inside the transaction); when it links to itself by path it is a
        // retarget source too and its rewritten bytes belong at the new path.
        if (e.kind === "ingest_known" && e.docId === info.docId) effects.push({ ...e, path: toRel });
        else if (e.kind === "record_stat" && e.path === info.path) effects.push({ ...e, path: toRel });
        else effects.push(e);
      }
    }

    commitChangeset(store, ctx.repoId, head(ctx, `move ${info.path} -> ${toRel}`), effects, nowOr(ctx), targets(ctx, docStore));
    const moved = { docId: info.docId, path: toRel, committed: true };
    if (!plan) return { ...moved, dangling: inbound, retargeted: null };
    return { ...moved, dangling: plan.dangling, retargeted: { blocks: plan.blocks, docs: plan.docs } };
  });
}

/** The `ApplyRequest` fields a document operation's context supplies to the retarget's changeset plan. */
function applyCtx(ctx: DocOpContext): { repoId: string; rootPath?: string; docStore?: DocStore; omgbaseDir?: string } {
  return {
    repoId: ctx.repoId,
    ...(ctx.rootPath ? { rootPath: ctx.rootPath } : {}),
    ...(ctx.docStore ? { docStore: ctx.docStore } : {}),
    ...(ctx.omgbaseDir ? { omgbaseDir: ctx.omgbaseDir } : {}),
  };
}

/**
 * The `retarget_inbound` plan of a move `fromPath → toRel`: one coalesced,
 * CAS-pinned `update` per deepest hit block, the blocks and docs it touches,
 * and the inbound links it leaves dangling. Pure over the store's current
 * blocks — the move itself changes no block — so the real move and its dry run
 * plan identically. Exported for the effect planner's `move document` (§11.3).
 */
export function planInboundRetarget(store: Store, docId: string, fromPath: string, toRel: string, inbound: InboundLink[]): { ops: Op[]; blocks: string[]; docs: string[]; dangling: InboundLink[] } {
  const byBlock = new Map<string, InboundLink>();
  for (const l of inbound) if (l.block_id !== null && !byBlock.has(l.block_id)) byBlock.set(l.block_id, l);
  // A container's raw includes its children's raw, so a link inside a list item
  // is reported for BOTH the list and the item. Rewrite the deepest block only:
  // updating the container would re-parse (and re-identify) its children, and
  // the child's update alone already changes the container's rendered raw.
  const parentOf = store.db.prepare("SELECT parent_block FROM blocks WHERE block_id = ? AND deleted_commit IS NULL");
  const containers = new Set<string>();
  for (const blockId of byBlock.keys()) {
    let cur: string | null = blockId;
    while (cur) {
      const row = parentOf.get(cur) as { parent_block: string | null } | undefined;
      cur = row?.parent_block ?? null;
      if (cur && byBlock.has(cur)) containers.add(cur);
    }
  }
  for (const c of containers) byBlock.delete(c);
  const ops: Op[] = [];
  const blocks: string[] = [];
  const docs = new Set<string>();
  const readBlock = store.db.prepare("SELECT bl.raw_hash, b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash WHERE bl.block_id = ? AND bl.deleted_commit IS NULL");
  for (const [blockId, src] of byBlock) {
    const row = readBlock.get(blockId) as { raw_hash: Buffer; bytes: Buffer } | undefined;
    if (!row) continue;
    // Match against the directory the link was RESOLVED in (the source's path at
    // extraction time); write relative forms against the source's CURRENT
    // directory — they differ only for links inside the moved doc itself.
    const writeDir = src.doc_id === docId ? dirOf(toRel) : dirOf(src.path);
    const newRaw = retargetLinksInRaw(row.bytes.toString("utf8"), dirOf(src.path), writeDir, fromPath, toRel);
    if (newRaw === null) continue;
    ops.push({ op: "update", block: blockId, markdown: newRaw, expect: { content_hash: row.raw_hash.toString("hex") } });
    blocks.push(blockId);
    docs.add(src.doc_id);
  }
  // Containers whose rewritten child covered them count as rewritten too.
  const rewritten = new Set([...blocks, ...containers]);
  const dangling = inbound.filter((l) => l.block_id === null || !rewritten.has(l.block_id));
  return { ops, blocks, docs: [...docs], dangling };
}

/** docs_delete: mark a document deleted and remove its file (nothing pooled — an intentional removal). */
export function docsDelete(store: Store, ctx: DocOpContext, docRef: string): DocOpResult {
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);

  const docStore = resolveDocStore(ctx);
  if (ctx.dryRun) {
    return { docId: info.docId, path: info.path, committed: false, diffs: { [info.path]: { before: docStore.read(info.path) ?? "", after: "" } } };
  }
  return underLock(ctx, () => {
    const effects: Effect[] = [{ kind: "tombstone", docId: info.docId, path: info.path, currentRev: info.currentRev, pool: false }];
    if (ctx.omgbaseDir) effects.push({ kind: "clear_stat", path: info.path });
    commitChangeset(store, ctx.repoId, head(ctx, `delete ${info.path}`), effects, nowOr(ctx), targets(ctx, docStore));
    return { docId: info.docId, path: info.path, committed: true };
  });
}

/** docs_set_meta: surgical frontmatter patch (set/unset keys), re-ingested. */
export function docsSetMeta(
  store: Store,
  ctx: DocOpContext,
  docRef: string,
  patch: { set?: Record<string, unknown>; unset?: string[] },
): DocOpResult {
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);

  const docStore = resolveDocStore(ctx);
  // `original` is `null` when the doc store has no bytes at the path (a
  // headless NullDocStore): the patch then starts from an empty file and the
  // commit has no disk to CAS against.
  const patched = (): { original: string | null; content: string } => {
    const original = docStore.read(info.path);
    const { frontmatter, body } = splitFrontmatter(original ?? "");
    const merged: Record<string, unknown> = { ...frontmatter, ...(patch.set ?? {}) };
    for (const k of patch.unset ?? []) delete merged[k];
    return { original, content: composeFile(body, merged) };
  };
  if (ctx.dryRun) {
    const { original, content } = patched();
    return { docId: info.docId, path: info.path, committed: false, diffs: { [info.path]: { before: original ?? "", after: content } } };
  }
  return underLock(ctx, () => {
    // The triple the patch is computed against plus the bytes it patched: the
    // commit validates both (spec/mutate §4 step 5, 2.2) — a row that moved is
    // `stale_plan`, a file whose bytes the row's `file_hash` does not name is
    // `sync_conflict` (the human's edit is ingested as observed, not committed
    // under this `set_meta`).
    const base = readDocBase(store.db, info.docId);
    if (!base) throw new MutationError("doc_missing", `no document ${docRef}`);
    const { original, content } = patched();
    const effects: Effect[] = [{ kind: "ingest_reconciled", path: info.path, source: content, precondition: { docId: info.docId, base, original } }];
    if (ctx.omgbaseDir) effects.push({ kind: "record_stat", path: info.path, bytes: content });
    const res = commitChangeset(store, ctx.repoId, head(ctx, `set_meta ${info.path}`), effects, nowOr(ctx), targets(ctx, docStore));
    return { docId: res.ingests[0]!.docId, path: info.path, committed: true };
  });
}

/** Split a file's bytes into (frontmatter object, body markdown) with
 *  `^---\r?\n([\s\S]*?)\r?\n---\r?\n?` (spec/mutate §6). Missing or malformed
 *  frontmatter yields an empty object and the whole content as body. */
export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
  } catch {
    /* malformed → empty */
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}
