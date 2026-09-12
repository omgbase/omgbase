import type { RawBlock } from "../core/parse/types.js";
import { rawHashHex, type MutBlock, type MutDoc } from "./tree.js";
import type { PlanOp, PlanDisposition } from "./opset.js";

// Lowering: reconcile output → kernel opset. Given the current document tree
// (with real ids), the proposed body blocks, and the reconciler's assignment
// (proposed-block positional key → carried-or-minted id), synthesize the kernel
// ops that transform the current tree into the proposed one while preserving
// the carried identities. The planner (plan-update.ts) verifies the result by
// simulation and escalates strategy on any byte-divergence, so this module may
// emit a plausible script and rely on that safety net for the hard cases.

/** A disposition row as this module consumes it (decoupled from reconcile/). */
export interface LowerDisposition {
  blockId: string;
  kind: string;
  confidence: number | null;
  reason: string | null;
  detail?: Record<string, unknown>;
}

interface TargetBlock {
  id: string;
  key: string;
  type: string;
  raw: string;
  trivia: string;
  children: TargetBlock[];
  /** id was present in the current tree (a carry) */
  carried: boolean;
}

export interface LowerResult {
  ops: PlanOp[];
  preserved: number;
  ambiguous: number;
}

function collectMutIds(list: MutBlock[], out: Set<string> = new Set()): Set<string> {
  for (const b of list) { out.add(b.id); collectMutIds(b.children, out); }
  return out;
}

function collectTargetIds(list: TargetBlock[], out: Set<string> = new Set()): Set<string> {
  for (const b of list) { out.add(b.id); collectTargetIds(b.children, out); }
  return out;
}

// Build the proposed tree annotated with assigned ids + carry flags, keying
// exactly as flatten()/assignFromMut() do (parentKey + '/' + index).
function buildTarget(blocks: RawBlock[], assignment: Map<string, string>, oldIds: Set<string>, parentKey: string | null): TargetBlock[] {
  return blocks.map((b, index) => {
    const key = `${parentKey ?? ""}/${index}`;
    const id = assignment.get(key) ?? key; // key fallback should not happen
    return {
      id,
      key,
      type: b.type,
      raw: b.raw,
      trivia: b.trivia,
      children: buildTarget(b.children, assignment, oldIds, key),
      carried: oldIds.has(id),
    };
  });
}

// Longest common subsequence of two id lists (indices into a). Standard DP;
// used to leave already-ordered survivors in place and move only the rest.
function lcs(a: string[], b: string[]): Set<string> {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.add(a[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

/**
 * Lower a reconciled whole-document update to a kernel opset (top-level
 * granularity). Preserves identity for every top-level block carried unchanged
 * and correctly realizes add / remove / reorder / content-edit at the top
 * level. A carried container whose content changed is updated as a whole (its
 * children re-minted); recursion to preserve nested identity is a later
 * refinement (verification keeps this honest either way).
 */
export function lowerTopLevel(oldDoc: MutDoc, rest: RawBlock[], assignment: Map<string, string>, dispositions: LowerDisposition[]): LowerResult {
  const docId = oldDoc.docId;
  const oldIds = collectMutIds(oldDoc.children);
  const target = buildTarget(rest, assignment, oldIds, null);
  const targetIdSet = collectTargetIds(target);
  const dispBy = new Map(dispositions.map((d) => [d.blockId, d]));
  const oldById = new Map<string, MutBlock>();
  { const walk = (l: MutBlock[]): void => { for (const b of l) { oldById.set(b.id, b); walk(b.children); } }; walk(oldDoc.children); }
  const oldTopIds = oldDoc.children.map((b) => b.id);
  const oldTopSet = new Set(oldTopIds);

  const ops: PlanOp[] = [];
  let preserved = 0;
  let ambiguous = 0;
  for (const d of dispositions) if (d.detail && Array.isArray((d.detail as { nearMisses?: unknown }).nearMisses)) ambiguous++;

  const meta = (id: string): { confidence: number | null; reason: string | null; detail?: Record<string, unknown> } => {
    const d = dispBy.get(id);
    return { confidence: d?.confidence ?? null, reason: d?.reason ?? null, ...(d?.detail ? { detail: d.detail } : {}) };
  };

  // 1. Removes: current top-level blocks gone from the proposed tree entirely.
  for (const ob of oldDoc.children) {
    if (!targetIdSet.has(ob.id)) {
      ops.push({
        op: { op: "remove", blocks: [ob.id], expect: { [ob.id]: { content_hash: rawHashHex(ob.raw) } } },
        disposition: "deleted", blocks: [ob.id], confidence: null, reason: "tombstone",
      });
    }
  }

  // 2. Content updates: a carried top-level block whose raw changed. A carried
  // container (list/blockquote) is updated as a whole — its raw carries the
  // children — but `childIds` threads the reconcile-carried identity of the
  // items onto the re-parsed subtree, so a within-container edit/reorder/insert
  // preserves the identity of every item that was NOT itself changed (only
  // genuinely new items mint). Nested identity, at no convergence cost.
  for (const t of target) {
    if (!t.carried) continue;
    const ob = oldById.get(t.id);
    if (!ob) continue; // carried an id that lives nested in old — handled by move below
    if (rawHashHex(ob.raw) !== rawHashHex(t.raw)) {
      const m = meta(t.id);
      const childIds = t.children.length > 0 ? carriedChildIdMap(t, oldIds) : {};
      ops.push({
        op: { op: "update", block: t.id, markdown: t.raw, expect: { content_hash: rawHashHex(ob.raw) }, ...(Object.keys(childIds).length > 0 ? { childIds } : {}) },
        disposition: "edited", blocks: [t.id], confidence: m.confidence, reason: m.reason, ...(m.detail ? { detail: m.detail } : {}),
      });
    }
  }

  // 3. Placement: realize the proposed top-level order. Leave the LCS of
  // survivors in place; move the rest and insert new blocks, each anchored after
  // the preceding proposed block (a minted-id placeholder for a fresh insert).
  const keptTop = target.filter((t) => t.carried && oldTopSet.has(t.id)).map((t) => t.id);
  const survivorsInOldOrder = oldTopIds.filter((id) => targetIdSet.has(id) && keptTop.includes(id));
  const stable = lcs(survivorsInOldOrder, keptTop);

  let prevRef: string | null = null; // null = document start
  const refOf: { ref: string }[] = []; // parallel to target, the id/placeholder to anchor after
  target.forEach((t, i) => {
    const anchorAt = prevRef === null ? "start" : { after: prevRef };
    if (!t.carried || !oldTopSet.has(t.id)) {
      // Insert new (or a block not previously top-level) at this position.
      const opIndex = ops.length;
      ops.push({
        op: { op: "insert", doc: docId, to: { parent: { doc: true }, at: anchorAt }, markdown: t.raw },
        disposition: dispositionForNew(dispBy.get(t.id)?.kind), blocks: [], confidence: dispBy.get(t.id)?.confidence ?? null, reason: dispBy.get(t.id)?.reason ?? null,
      });
      prevRef = `$${opIndex}.ids[0]`;
    } else {
      if (!stable.has(t.id)) {
        const m = meta(t.id);
        ops.push({
          op: { op: "move", blocks: [t.id], to: { parent: { doc: true }, at: anchorAt } },
          disposition: "moved", blocks: [t.id], confidence: m.confidence, reason: m.reason, ...(m.detail ? { detail: m.detail } : {}),
        });
      }
      prevRef = t.id;
    }
    refOf[i] = { ref: prevRef };
  });

  // 4. Trivia: set exact trailing trivia for proposed top-level blocks that are
  // inserted, moved, or whose trivia differs from the current block's — so the
  // committed bytes equal the proposed content exactly.
  target.forEach((t, i) => {
    const ob = t.carried ? oldById.get(t.id) : undefined;
    const wasTop = ob && oldTopSet.has(t.id);
    const moved = wasTop && !stable.has(t.id);
    const needs = !wasTop || moved || (ob && ob.trivia !== t.trivia);
    if (!needs) return;
    ops.push({
      op: { op: "update", block: refOf[i]!.ref, trivia: t.trivia },
      disposition: "retiled", blocks: wasTop ? [t.id] : [], confidence: null, reason: null,
    });
  });

  // preserved = carried top-level blocks with unchanged content AND position.
  for (const t of target) {
    if (t.carried && oldById.get(t.id) && rawHashHex(oldById.get(t.id)!.raw) === rawHashHex(t.raw) && stable.has(t.id)) preserved++;
  }

  return { ops, preserved, ambiguous };
}

// Positional-key → id map for a container's carried descendants (keys relative
// to the container's own children, e.g. "/0", "/1", "/0/0"). Only carried ids
// (present in the current tree) are threaded; genuinely-new positions are
// omitted so the op stays deterministic and opUpdate mints those fresh.
function carriedChildIdMap(container: TargetBlock, oldIds: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (children: TargetBlock[], parentKey: string): void => {
    children.forEach((c, i) => {
      const key = `${parentKey}/${i}`;
      if (oldIds.has(c.id)) out[key] = c.id;
      if (c.children.length > 0) walk(c.children, key);
    });
  };
  walk(container.children, "");
  return out;
}

function dispositionForNew(kind: string | undefined): PlanDisposition {
  if (kind === "copied_from") return "copied_from";
  if (kind === "resurrected") return "resurrected";
  if (kind === "split_from") return "split_from";
  return "inserted";
}

/**
 * Guaranteed fallback: replace the whole body. Remove every current top-level
 * block, then insert the entire proposed body as one op. Loses all block
 * identity but always reproduces the exact bytes (verification still checks).
 * Used only when no identity-preserving lowering converges.
 */
export function lowerReplace(oldDoc: MutDoc, content: string): LowerResult {
  const ops: PlanOp[] = [];
  for (const ob of oldDoc.children) {
    ops.push({ op: { op: "remove", blocks: [ob.id] }, disposition: "deleted", blocks: [ob.id], confidence: null, reason: "tombstone" });
  }
  ops.push({ op: { op: "insert", doc: oldDoc.docId, to: { parent: { doc: true }, at: "end" }, markdown: bodyOf(content) }, disposition: "bulk_rewrite", blocks: [], confidence: null, reason: null });
  return { ops, preserved: 0, ambiguous: 0 };
}

// Strip a leading YAML frontmatter block from raw content for a body-only insert.
function bodyOf(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return m ? content.slice(m[0].length).replace(/^\s*\n/, "") : content;
}
