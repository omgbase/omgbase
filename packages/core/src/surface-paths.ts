// The surface's rules applied at its boundary. Two of them:
//
// Paths (spec/surface §1 "Paths", 2.0): every path a tool or verb returns is
// `/`-rooted. The surface-owned readers (`core/read`, `graph/history`,
// `graph/link-health`, the query binding) root their own output; the results
// that belong to another spec — `spec/mutate`'s apply and document-operation
// results and opsets, `spec/store`'s observe outcomes, `spec/search`'s hits,
// `spec/sync`'s sweep — keep their storage-form paths in the library (their
// own fixtures pin them) and are re-shaped HERE.
//
// Row names (spec/surface §1.2, 3.0): a result that renders a document, block
// or edge row spells it the way the query binding does — `$id`, `$path`,
// `$hash`, `$raw`, `$updated_at`, plain `doc_id`/`block_id` foreign keys. The
// shapes other specs own under their own names — `spec/mutate`'s document
// operation result `{ docId, path, … }`, `spec/store`'s observe outcome — are
// re-shaped HERE too (`SurfaceDocOpResult`, `SurfaceObserveResult`, …).
//
// Both the MCP server and the `omg` verbs call these, so the two clients
// cannot drift. Each function returns a new value; the input is not mutated.

import type { ApplyResult } from "./mutate/apply.js";
import type { DocOpResult, DocMoveResult } from "./mutate/docs.js";
import type { RetargetHit } from "./mutate/macros.js";
import type { Opset } from "./mutate/opset.js";
import type { DocsUpdateResult } from "./mutate/plan-update.js";
import type { InboundLink } from "./graph/inbound-links.js";
import type { ObserveResult, ObserveDeleteResult } from "./sync/observe.js";
import type { SweepResult } from "./sync/freshness.js";
import type { TextSearchResult } from "./search/text.js";
import type { ResolveHit } from "./search/resolve.js";
import { referencePath, referenceKeyed } from "./core/paths.js";

/** `spec/mutate` §4's result: `revisions[].$path` and the dry-run `diffs` keys. */
export function surfaceApplyResult<T extends ApplyResult>(res: T): T {
  return {
    ...res,
    revisions: res.revisions.map((r) => ({ ...r, $path: referencePath(r.$path) })),
    ...(res.diffs ? { diffs: referenceKeyed(res.diffs) } : {}),
  };
}

/** A document operation's result on the wire (spec/surface §4, 3.0): the
 *  library's `{ docId, path, … }` (`spec/mutate` §6, unchanged there) renamed
 *  to the document's row attributes `$id`/`$path`, the path rooted, the
 *  dry-run `diffs` re-keyed; every other key (`committed`, `deleted`, …) as is. */
export type SurfaceDocOpResult<T extends DocOpResult> = Omit<T, "docId" | "path"> & { $id: string; $path: string };

/** `docs_create` / `docs_delete` / `docs_set_meta`. */
export function surfaceDocOpResult<T extends DocOpResult>(res: T): SurfaceDocOpResult<T> {
  const { docId, path, ...rest } = res;
  return { $id: docId, $path: referencePath(path), ...rest, ...(res.diffs ? { diffs: referenceKeyed(res.diffs) } : {}) };
}

/** An inbound link on the wire (`docs_move.dangling[]`): an edge row under the
 *  `edges` target's names (spec/surface §1.2) — `doc_id`, `$path` (rooted),
 *  `block_id`, `target` (as authored), `anchor`, `field?`. */
export interface SurfaceInboundLink {
  doc_id: string;
  $path: string;
  block_id: string | null;
  target: string;
  anchor: string | null;
  field?: string;
}

export function surfaceInboundLink(l: InboundLink): SurfaceInboundLink {
  const { path, ...rest } = l;
  return { doc_id: rest.doc_id, $path: referencePath(path), block_id: rest.block_id, target: rest.target, anchor: rest.anchor, ...(rest.field !== undefined ? { field: rest.field } : {}) };
}

/** `docs_move`: the document-op fields plus each dangling link (its `target`
 *  stays as authored — that is what the link says). */
export function surfaceDocMoveResult(res: DocMoveResult): Omit<SurfaceDocOpResult<DocMoveResult>, "dangling"> & { dangling: SurfaceInboundLink[] } {
  return { ...surfaceDocOpResult(res), dangling: res.dangling.map(surfaceInboundLink) };
}

/** An observe outcome on the wire (spec/surface §4, 3.0): `spec/store` §5's
 *  `{ docId, path, … }` (unchanged there) renamed to the document's row
 *  attributes `$id`/`$path`, the path rooted. */
export type SurfaceObserveResult<T extends { docId: string | null; path: string }> = Omit<T, "docId" | "path"> & { $id: T["docId"]; $path: string };

/** `observe` / `observe_many` outcomes. */
export function surfaceObserveResult<T extends ObserveResult>(res: T): SurfaceObserveResult<T> {
  const { docId, path, ...rest } = res;
  return { $id: docId, $path: referencePath(path), ...rest };
}

/** `observe_delete`. */
export function surfaceObserveDeleteResult(res: ObserveDeleteResult): SurfaceObserveResult<ObserveDeleteResult> {
  const { docId, path, ...rest } = res;
  return { $id: docId, $path: referencePath(path), ...rest };
}

/** `text_search` hits (`$path` rooted). */
export function surfaceTextSearch(res: TextSearchResult): TextSearchResult {
  return { ...res, hits: res.hits.map((h) => ({ ...h, $path: referencePath(h.$path) })) };
}

/** `resolve` hits: the locator is `<path>#<type>[<ordinal>]`; its path half is
 *  rooted (a locator without `#` names no path and is left alone). */
export function surfaceResolveHits(hits: ResolveHit[]): ResolveHit[] {
  return hits.map((h) => {
    const i = h.locator.indexOf("#");
    return i < 0 ? h : { ...h, locator: referencePath(h.locator.slice(0, i)) + h.locator.slice(i) };
  });
}

/** `links_retarget` / `links_repair` hits (`$path` is the block's document). */
export function surfaceRetargetHits(hits: RetargetHit[]): RetargetHit[] {
  return hits.map((h) => ({ ...h, $path: referencePath(h.$path) }));
}

/** A whole-document update plan: `target.$path` and `precondition.$path`. */
export function surfaceOpset(opset: Opset): Opset {
  return {
    ...opset,
    target: { ...opset.target, $path: referencePath(opset.target.$path) },
    precondition: { ...opset.precondition, $path: referencePath(opset.precondition.$path) },
  };
}

/** `docs_update`: the opset and, when committed, the apply result. */
export function surfaceDocsUpdate(res: DocsUpdateResult): DocsUpdateResult {
  return { opset: surfaceOpset(res.opset), result: res.result ? surfaceApplyResult(res.result) : null };
}

/** `omg sync`'s one-shot sweep: the ingested / suppressed / deleted / conflicted paths. */
export function surfaceSweepResult(res: SweepResult): SweepResult {
  return {
    ...res,
    ingested: res.ingested.map(referencePath),
    suppressed: res.suppressed.map(referencePath),
    deleted: res.deleted.map(referencePath),
    conflicted: res.conflicted.map(referencePath),
  };
}
