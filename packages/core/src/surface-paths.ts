// The surface's path rule applied at its boundary (spec/surface §1 "Paths",
// 2.0): every path a tool or verb returns is `/`-rooted. The surface-owned
// readers (`core/read`, `graph/history`, `graph/link-health`, the query
// binding) root their own output; the results that belong to another spec —
// `spec/mutate`'s apply and document-operation results and opsets,
// `spec/store`'s observe outcomes, `spec/search`'s hits, `spec/sync`'s sweep —
// keep their storage-form paths in the library (their own fixtures pin them)
// and are re-shaped HERE, by the MCP server and the `omg` verbs alike, so the
// two clients cannot drift. Each function returns a new value; the input is
// not mutated.

import type { ApplyResult } from "./mutate/apply.js";
import type { DocOpResult, DocMoveResult } from "./mutate/docs.js";
import type { RetargetHit } from "./mutate/macros.js";
import type { Opset } from "./mutate/opset.js";
import type { DocsUpdateResult } from "./mutate/plan-update.js";
import type { ObserveResult, ObserveDeleteResult } from "./sync/observe.js";
import type { SweepResult } from "./sync/freshness.js";
import type { TextSearchResult } from "./search/text.js";
import type { ResolveHit } from "./search/resolve.js";
import { referencePath, referenceKeyed } from "./core/paths.js";

/** `spec/mutate` §4's result: `revisions[].path` and the dry-run `diffs` keys. */
export function surfaceApplyResult<T extends ApplyResult>(res: T): T {
  return {
    ...res,
    revisions: res.revisions.map((r) => ({ ...r, path: referencePath(r.path) })),
    ...(res.diffs ? { diffs: referenceKeyed(res.diffs) } : {}),
  };
}

/** `docs_create` / `docs_delete` / `docs_set_meta`: `path` and the `diffs` keys. */
export function surfaceDocOpResult<T extends DocOpResult>(res: T): T {
  return { ...res, path: referencePath(res.path), ...(res.diffs ? { diffs: referenceKeyed(res.diffs) } : {}) };
}

/** `docs_move`: the document-op fields plus each dangling link's source `path`
 *  (its `target` stays as authored — that is what the link says). */
export function surfaceDocMoveResult(res: DocMoveResult): DocMoveResult {
  return { ...surfaceDocOpResult(res), dangling: res.dangling.map((l) => ({ ...l, path: referencePath(l.path) })) };
}

/** `observe` / `observe_many` outcomes. */
export function surfaceObserveResult<T extends ObserveResult>(res: T): T {
  return { ...res, path: referencePath(res.path) };
}

/** `observe_delete`. */
export function surfaceObserveDeleteResult(res: ObserveDeleteResult): ObserveDeleteResult {
  return { ...res, path: referencePath(res.path) };
}

/** `text_search` hits. */
export function surfaceTextSearch(res: TextSearchResult): TextSearchResult {
  return { ...res, hits: res.hits.map((h) => ({ ...h, path: referencePath(h.path) })) };
}

/** `resolve` hits: the locator is `<path>#<type>[<ordinal>]`; its path half is
 *  rooted (a locator without `#` names no path and is left alone). */
export function surfaceResolveHits(hits: ResolveHit[]): ResolveHit[] {
  return hits.map((h) => {
    const i = h.locator.indexOf("#");
    return i < 0 ? h : { ...h, locator: referencePath(h.locator.slice(0, i)) + h.locator.slice(i) };
  });
}

/** `links_retarget` / `links_repair` hits (`path` is the block's document). */
export function surfaceRetargetHits(hits: RetargetHit[]): RetargetHit[] {
  return hits.map((h) => ({ ...h, path: referencePath(h.path) }));
}

/** A whole-document update plan: `target.path` and `precondition.path`. */
export function surfaceOpset(opset: Opset): Opset {
  return {
    ...opset,
    target: { ...opset.target, path: referencePath(opset.target.path) },
    precondition: { ...opset.precondition, path: referencePath(opset.precondition.path) },
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
