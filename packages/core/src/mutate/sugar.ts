import type { Store } from "../core/store/store.js";
import { findDoc } from "../core/read/reader.js";
import { inboundLinksTo, type InboundLink } from "../graph/inbound-links.js";
import { canonicalDocPath, planInboundRetarget } from "./docs.js";
import { resolveDocStore, type DocStore } from "./doc-store.js";
import { MutationError } from "./tree.js";
import type { Effect, EffectAt, EffectExpect, EffectTarget } from "./effects.js";
import { applyEffectsDetailed, stripEffectIndex, type ExecuteRequest, type Plan, type Receipt } from "./plan.js";

// The effect builders (spec/mutate §6 + §10, 3.0; spec/surface §4 "Sugar over
// effects", 4.0; ADR-021's retirement release). Every write the surface offers
// besides `apply` / `plan` / `execute` themselves — the block-level tools, the
// link macros, the four document operations and the whole-document update — is
// `apply { effects }` with a fixed commit `reason`. ONE builder per operation
// lives here so the MCP server (`mcp/server.ts`), the `omg` verbs
// (`packages/cli`) and the spec/mutate fixture runner's `docs` step
// (`corpus/mutate/fixture.ts`) compose exactly the same effects, and the Rust
// port mirrors the same table (ADR-012: the CLI holds no business logic).
//
// A builder returns `{ effects, reason? }` and decides nothing: it resolves no
// reference and runs no pre-check — the caller has already turned its refs into
// ids (the server through `resolve_ref` / `locateDoc`, the CLI through its own
// resolution, the fixture through `findDocByRef`) and raised its own errors, so
// the planner's copies of them never fire and every error envelope stays the
// caller's. `applySugar` then plans + executes the effects as one request and
// drops the planner's `effect_index` from any error (the caller built the
// effects; the index names nothing it sent).

/** What a builder returns: the ordered effects and the commit reason they carry (absent → the caller's `reason` argument). */
export interface Sugar {
  effects: Effect[];
  reason?: string;
}

/** A live document as the builders address it: its id and its storage-form path (the reasons spell the path). */
export interface SugarDoc {
  id: string;
  path: string;
}

const documentTarget = (id: string): EffectTarget => ({ kind: "document", id });
const blockTarget = (id: string): EffectTarget => ({ kind: "block", id });

/** A caller's guard as an effect guard: absent stays absent, an empty object stays an empty guard (the planner then pins what it needs). */
export function guardOf(e: { content_hash?: string | undefined; parent_children_hash?: string | undefined } | undefined): { expect?: EffectExpect } {
  if (!e) return {};
  const expect: EffectExpect = {};
  if (e.content_hash !== undefined) expect.content_hash = e.content_hash;
  if (e.parent_children_hash !== undefined) expect.parent_children_hash = e.parent_children_hash;
  return { expect };
}

// ---- the document operations (spec/mutate §6) ---------------------------------------------

/**
 * The pre-check a `create` / `move document` caller runs before planning
 * (spec/surface §4 "The document operations", §9): `path_taken` exactly as the
 * 2.x library operations raised it — the caller's message (`document already
 * exists at <rel>` for a create, `a document already exists at <rel>` for a
 * move), then `file already exists on disk at <rel>` — with NO `data`, so the
 * planner's own `path_taken { path }` never fires. Shared by the MCP tools and
 * the `omg` verbs (the Rust port mirrors it).
 */
export function requireAbsentPath(store: Store, repoId: string, where: { rootPath?: string; docStore?: DocStore }, rel: string, takenMessage: string): void {
  if (findDoc(store, { repoId, path: rel })) throw new MutationError("path_taken", takenMessage);
  if (resolveDocStore(where).exists(rel)) throw new MutationError("path_taken", `file already exists on disk at ${rel}`);
}

/** `docs_create` / `omg new`: one `create` at the canonical path; reason `create <rel>`. */
export function createEffects(path: string, markdown: string, frontmatter?: Record<string, unknown>): Sugar {
  const rel = canonicalDocPath(path);
  return { effects: [{ op: "create", path: rel, markdown, ...(frontmatter !== undefined ? { frontmatter } : {}) }], reason: `create ${rel}` };
}

/** `docs_move` / `omg mv`: one `move { target: document, to, retarget_inbound }`; reason `move <from> -> <to>`. */
export function moveDocEffects(doc: SugarDoc, toPath: string, retargetInbound = true): Sugar {
  const to = canonicalDocPath(toPath);
  return { effects: [{ op: "move", target: documentTarget(doc.id), to, ...(retargetInbound ? {} : { retarget_inbound: false }) }], reason: `move ${doc.path} -> ${to}` };
}

/** `docs_delete` / `omg rm --doc`: one `remove { target: document }`; reason `delete <path>`. */
export function deleteDocEffects(doc: SugarDoc): Sugar {
  return { effects: [{ op: "remove", target: documentTarget(doc.id) }], reason: `delete ${doc.path}` };
}

/**
 * `docs_set_meta` / `omg meta`: one `set`/`unset frontmatter.<k>` per key, `unset`
 * winning a key named in both (the legacy merge spread `set` then deleted `unset`);
 * reason `set_meta <path>`. An empty patch yields no effect — the caller refuses
 * it (`filter_invalid` "pass `set` and/or `unset`", spec/surface §9).
 */
export function setMetaEffects(doc: SugarDoc, set: Record<string, unknown> | undefined, unset: readonly string[] | undefined): Sugar {
  const gone = unset ?? [];
  const target = documentTarget(doc.id);
  const effects: Effect[] = [
    ...Object.entries(set ?? {}).filter(([k]) => !gone.includes(k)).map(([k, value]): Effect => ({ op: "set", target, field: `frontmatter.${k}`, value })),
    ...gone.map((k): Effect => ({ op: "unset", target, field: `frontmatter.${k}` })),
  ];
  return { effects, reason: `set_meta ${doc.path}` };
}

/** `docs_update` / `omg update <doc>`: one `set { document, content }`; the reason is the caller's. */
export function updateContentEffects(doc: Pick<SugarDoc, "id">, content: string, reason?: string): Sugar {
  return { effects: [{ op: "set", target: documentTarget(doc.id), field: "content", value: content }], ...(reason !== undefined ? { reason } : {}) };
}

// ---- the block-level tools (spec/surface §4) ----------------------------------------------

/** `blocks_insert` / `omg insert`: `insert into <document|block> at …`; the caller's `expect` is the destination-parent CAS. */
export function insertEffects(into: EffectTarget, at: EffectAt, markdown: string, expect?: { parent_children_hash?: string | undefined }): Sugar {
  return { effects: [{ op: "insert", into, at, markdown, ...guardOf(expect) }], reason: "blocks_insert" };
}

/**
 * `blocks_update` / `omg update <block>` / `omg edit`: `set markdown` and/or `set
 * attrs.checked`. The caller's `expect` guards the FIRST effect (the content CAS
 * is checked once, against the bytes the caller saw); a second effect is pinned
 * by the planner to the block as the first left it. Nothing to set → no effect
 * (the caller refuses it).
 */
export function updateBlockEffects(id: string, patch: { markdown?: string | undefined; checked?: boolean | undefined; expect?: { content_hash?: string | undefined; parent_children_hash?: string | undefined } | undefined }): Sugar {
  const target = blockTarget(id);
  const expect = guardOf(patch.expect);
  const effects: Effect[] = [];
  if (patch.markdown !== undefined) effects.push({ op: "set", target, field: "markdown", value: patch.markdown, ...expect });
  if (patch.checked !== undefined) effects.push({ op: "set", target, field: "attrs.checked", value: patch.checked, ...(effects.length === 0 ? expect : {}) });
  return { effects, reason: "blocks_update" };
}

/** `blocks_move` / `omg move`: one `move { targets, into, at, expect }`. */
export function moveBlocksEffects(ids: readonly string[], into: EffectTarget, at: EffectAt, expect?: { parent_children_hash?: string | undefined }): Sugar {
  return { effects: [{ op: "move", targets: ids.map(blockTarget), into, at, ...guardOf(expect) }], reason: "blocks_move" };
}

/** `blocks_remove` / `omg rm`: one `remove { targets }` (the planner pins each block). */
export function removeBlocksEffects(ids: readonly string[]): Sugar {
  return { effects: [{ op: "remove", targets: ids.map(blockTarget) }], reason: "blocks_remove" };
}

/** `blocks_split` / `omg split`: one `split { target, at }` (the planner pins the content CAS). */
export function splitEffects(id: string, at: readonly number[]): Sugar {
  return { effects: [{ op: "split", target: blockTarget(id), at: [...at] }], reason: "blocks_split" };
}

/** `blocks_merge` / `omg merge`: one `merge { targets, separator? }`. */
export function mergeEffects(ids: readonly string[], separator?: string): Sugar {
  return { effects: [{ op: "merge", targets: ids.map(blockTarget), ...(separator !== undefined ? { separator } : {}) }], reason: "blocks_merge" };
}

/** `blocks_check` / `omg done`: N × `set attrs.checked` (a block named twice is one write — the planner drops the duplicate). */
export function checkEffects(ids: readonly string[], checked: boolean): Sugar {
  return { effects: ids.map((id): Effect => ({ op: "set", target: blockTarget(id), field: "attrs.checked", value: checked })), reason: "blocks_check" };
}

/** `nodes_set` / `omg node set`: one `set { node, field: prop, value }`. */
export function nodeSetEffects(nodeId: string, prop: string, value: string): Sugar {
  return { effects: [{ op: "set", target: { kind: "node", id: nodeId }, field: prop, value }], reason: "nodes_set" };
}

/** `blocks_append` / `omg append`: `insert at end` into a heading's section or a container block (the caller decided which by the block's kind). */
export function appendEffects(into: EffectTarget, text: string): Sugar {
  return { effects: [{ op: "insert", into, at: "end", markdown: text }], reason: "blocks_append" };
}

/** `docs_append`: `insert at end` into the document's top level or a resolved section. */
export function docsAppendEffects(into: EffectTarget, text: string): Sugar {
  return { effects: [{ op: "insert", into, at: "end", markdown: text }], reason: "docs_append" };
}

/** `links_retarget` / `links_repair` / `omg retarget --apply`: one `retarget { repairs, path_glob? }` under the calling tool's name. */
export function retargetEffects(repairs: readonly { from: string; to: string }[], pathGlob: string | undefined, reason: "links_retarget" | "links_repair"): Sugar {
  return { effects: [{ op: "retarget", repairs: repairs.map((r) => ({ from: r.from, to: r.to })), ...(pathGlob !== undefined ? { path_glob: pathGlob } : {}) }], reason };
}

// ---- running the sugar -------------------------------------------------------------------------

/** The request half a caller supplies: where to write and under whom (`ExecuteRequest` minus the origin's reason, which the sugar carries). */
export type SugarRequest = Omit<ExecuteRequest, "origin"> & { actor: string | null; reason?: string };

/**
 * Plan + execute a builder's effects as one request (`applyEffectsDetailed`: one
 * lock, one transaction) under `actor` and the sugar's reason — `request.reason`
 * wins when given (a `--reason`, a `docs_update` argument) — and report any
 * planner failure without its `effect_index`. `dryRun` plans only (the CLI's
 * `--dry-run`, spec/cli §3.6: every dry run is a plan and burns no id).
 */
export function applySugar(store: Store, request: SugarRequest & { dryRun?: boolean }, sugar: Sugar): { plan: Plan; receipt?: Receipt } {
  const { actor, reason, dryRun, ...rest } = request;
  const chosen = reason ?? sugar.reason;
  try {
    return applyEffectsDetailed(store, { ...rest, effects: sugar.effects, origin: { actor, ...(chosen !== undefined ? { reason: chosen } : {}) }, ...(dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    throw stripEffectIndex(e);
  }
}

// ---- adapters over the Receipt -----------------------------------------------------------------

/** The document-operation result the `omg` document verbs and the fixture `docs` step record (`spec/mutate` §9): `{ id, path, committed }`, the path in the storage form. */
export interface DocOpOutcome {
  id: string;
  path: string;
  committed: true;
}

/** `docs_create`'s document is the receipt's first revision (`new_ids["$new.0"]` is the same id); every other operation's is the one addressed. */
export function createdDoc(receipt: Receipt, path: string): DocOpOutcome {
  const id = receipt.new_ids["$new.0"] ?? receipt.revisions[0]?.id;
  if (id === undefined) throw new Error("createdDoc: the receipt names no created document");
  return { id, path, committed: true };
}

export function docOutcome(doc: SugarDoc, path = doc.path): DocOpOutcome {
  return { id: doc.id, path, committed: true };
}

/** What a move reports about the inbound links (spec/mutate §6 `docs_move`; the `retargeted`/`dangling` extras of the tool and the verb). */
export interface MoveLinks {
  /** inbound links still naming the OLD path after the move — every link when the retarget was opted out, else the frontmatter relations a move never rewrites */
  dangling: InboundLink[];
  /** the source blocks rewritten and their documents; `null` when the retarget was opted out or nothing linked in */
  retargeted: { blocks: string[]; docs: string[] } | null;
}

/**
 * Who links to the document BY PATH as written, and what the move's retarget
 * rewrites — computed BEFORE the move from the current blocks (`planInboundRetarget`
 * is pure, so it equals what the planner lowers for the same `move` effect).
 */
export function moveLinks(store: Store, repoId: string, doc: SugarDoc, toPath: string, retargetInbound = true): MoveLinks {
  const to = canonicalDocPath(toPath);
  const inbound = inboundLinksTo(store, repoId, doc.id, doc.path);
  if (!retargetInbound || inbound.length === 0) return { dangling: inbound, retargeted: null };
  const plan = planInboundRetarget(store, doc.id, doc.path, to, inbound);
  return { dangling: plan.dangling, retargeted: { blocks: plan.blocks, docs: plan.docs } };
}
