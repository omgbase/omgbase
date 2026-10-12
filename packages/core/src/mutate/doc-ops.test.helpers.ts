import type { Store } from "../core/store/store.js";
import { findDocByRef } from "../core/read/reader.js";
import type { InboundLink } from "../graph/inbound-links.js";
import type { DocStore } from "./doc-store.js";
import { MutationError } from "./tree.js";
import { applySugar, createEffects, createdDoc, deleteDocEffects, moveDocEffects, moveLinks, setMetaEffects, type SugarDoc } from "./sugar.js";

// Test support (not a test; not shipped — `*.test.*` is excluded from the
// package): the four document operations as the 2.x library spelled them —
// `docsCreate` / `docsMove` / `docsDelete` / `docsSetMeta` over a context — as
// thin shims over the 3.0 effect builders + `applySugar`, so the commit, CAS,
// materialization, history and doc-store suites keep reading as the scenarios
// they pin while exercising the one write path that exists.

export interface DocOpContext {
  repoId: string;
  rootPath?: string;
  docStore?: DocStore;
  omgbaseDir?: string;
  actor?: string;
  ts?: string;
}

export interface DocOpResult {
  docId: string;
  path: string;
  committed: true;
}

export interface DocMoveResult extends DocOpResult {
  dangling: InboundLink[];
  retargeted: { blocks: string[]; docs: string[] } | null;
}

function docOf(store: Store, ctx: DocOpContext, ref: string): SugarDoc {
  const info = findDocByRef(store, ctx.repoId, ref);
  if (!info) throw new MutationError("doc_missing", `no document ${ref}`);
  return { id: info.docId, path: info.path };
}

function request(ctx: DocOpContext) {
  const { actor, ...rest } = ctx;
  return { ...rest, actor: actor ?? null };
}

export function docsCreate(store: Store, ctx: DocOpContext, path: string, markdown: string, frontmatter?: Record<string, unknown>): DocOpResult {
  const built = createEffects(path, markdown, frontmatter);
  const { receipt } = applySugar(store, request(ctx), built);
  const res = createdDoc(receipt!, (built.effects[0] as { path: string }).path);
  return { docId: res.id, path: res.path, committed: true };
}

export function docsMove(store: Store, ctx: DocOpContext, ref: string, toPath: string, opts: { retargetInbound?: boolean } = {}): DocMoveResult {
  const doc = docOf(store, ctx, ref);
  const retarget = opts.retargetInbound !== false;
  const links = moveLinks(store, ctx.repoId, doc, toPath, retarget);
  const built = moveDocEffects(doc, toPath, retarget);
  applySugar(store, request(ctx), built);
  return { docId: doc.id, path: (built.effects[0] as { to: string }).to, committed: true, ...links };
}

export function docsDelete(store: Store, ctx: DocOpContext, ref: string): DocOpResult {
  const doc = docOf(store, ctx, ref);
  applySugar(store, request(ctx), deleteDocEffects(doc));
  return { docId: doc.id, path: doc.path, committed: true };
}

export function docsSetMeta(store: Store, ctx: DocOpContext, ref: string, patch: { set?: Record<string, unknown>; unset?: string[] }): DocOpResult {
  const doc = docOf(store, ctx, ref);
  applySugar(store, request(ctx), setMetaEffects(doc, patch.set, patch.unset));
  return { docId: doc.id, path: doc.path, committed: true };
}
