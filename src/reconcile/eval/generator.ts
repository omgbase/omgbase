import { sha256, normalizeVisibleText } from "../../core/hash.js";
import type { MatchBlock } from "../types.js";

// Synthetic edit-script generator (03 §9). Applies scripted edits to a document
// of blocks, producing (old blocks with ids, new blocks, ground-truth mapping).
// Ground truth is exact by construction. A seeded PRNG makes runs reproducible
// (this is harness code, not the matcher — determinism here is for repeatability).

export type EditClass = "edit" | "insert" | "delete" | "move" | "reorder" | "split" | "merge" | "copy";

export interface GroundTruth {
  /** new block key → old id it should carry (absent ⇒ should be minted) */
  carries: Map<string, string>;
  /** old ids expected to be deleted */
  deleted: Set<string>;
  /** per new key, the edit class that produced it (for per-class metrics) */
  classOf: Map<string, EditClass>;
}

export interface GeneratedCase {
  old: MatchBlock[];
  neu: MatchBlock[];
  truth: GroundTruth;
}

// Small deterministic PRNG (mulberry32).
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud".split(" ");

function sentence(r: () => number, n = 10): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out[i] = WORDS[Math.floor(r() * WORDS.length)]!;
  return out.join(" ");
}

interface Blk { id: string; raw: string }

function mkOld(blocks: Blk[]): MatchBlock[] {
  return blocks.map((b, index) => {
    const text = normalizeVisibleText(b.raw, "paragraph");
    return {
      blockId: b.id, type: "paragraph",
      rawHashHex: sha256(b.raw).toString("hex"),
      normHashHex: sha256(text).toString("hex"),
      text, anchors: [], parentKey: null, index, key: `/${index}`,
    };
  });
}
function mkNew(raws: string[]): MatchBlock[] {
  return raws.map((raw, index) => {
    const text = normalizeVisibleText(raw, "paragraph");
    return {
      type: "paragraph",
      rawHashHex: sha256(raw).toString("hex"),
      normHashHex: sha256(text).toString("hex"),
      text, anchors: [], parentKey: null, index, key: `/${index}`,
    };
  });
}

/** Generate one case: a base doc plus a scripted edit of the given intensity. */
export function generateCase(seed: number, opts: { size?: number; intensity?: number } = {}): GeneratedCase {
  const r = rng(seed);
  const size = opts.size ?? 12;
  const intensity = opts.intensity ?? 0.3;

  // Base document.
  const base: Blk[] = Array.from({ length: size }, (_, i) => ({ id: `b_${i}`, raw: sentence(r, 8 + Math.floor(r() * 8)) }));
  const old = mkOld(base);

  // Work on a mutable list of (id | null-for-new, raw, class).
  interface Item { id: string | null; raw: string; cls: EditClass | null }
  let items: Item[] = base.map((b) => ({ id: b.id, raw: b.raw, cls: null }));
  const deleted = new Set<string>();

  const nEdits = Math.max(1, Math.floor(size * intensity));
  for (let e = 0; e < nEdits; e++) {
    const roll = r();
    const idx = Math.floor(r() * items.length);
    if (items.length === 0) break;

    if (roll < 0.35) {
      // edit: change a few words but keep majority (carry expected)
      const it = items[idx]!;
      if (it.id && it.cls === null) {
        const words = it.raw.split(" ");
        const changes = Math.max(1, Math.floor(words.length * 0.2));
        for (let c = 0; c < changes; c++) words[Math.floor(r() * words.length)] = WORDS[Math.floor(r() * WORDS.length)]!;
        it.raw = words.join(" ");
        it.cls = "edit";
      }
    } else if (roll < 0.5) {
      // insert a brand-new block
      items.splice(idx, 0, { id: null, raw: sentence(r, 10), cls: "insert" });
    } else if (roll < 0.62) {
      // delete
      const it = items[idx]!;
      if (it.id) deleted.add(it.id);
      items.splice(idx, 1);
    } else if (roll < 0.8) {
      // move/reorder: pop and reinsert elsewhere
      const [it] = items.splice(idx, 1);
      if (it) {
        const dest = Math.floor(r() * (items.length + 1));
        if (it.cls === null && it.id) it.cls = "move";
        items.splice(dest, 0, it);
      }
    } else if (roll < 0.9) {
      // copy: near-duplicate an existing block (append a word so the original
      // still locks uniquely and the copy is detected against it, per 03 §4).
      const it = items[idx]!;
      if (it.id) items.splice(idx + 1, 0, { id: null, raw: `${it.raw} ${WORDS[Math.floor(r() * WORDS.length)]}`, cls: "copy" });
    } else {
      // reorder two adjacent
      if (idx + 1 < items.length) {
        const tmp = items[idx]!; items[idx] = items[idx + 1]!; items[idx + 1] = tmp;
        if (items[idx]!.id && items[idx]!.cls === null) items[idx]!.cls = "reorder";
      }
    }
  }

  const neu = mkNew(items.map((it) => it.raw));
  const carries = new Map<string, string>();
  const classOf = new Map<string, EditClass>();
  items.forEach((it, index) => {
    const key = `/${index}`;
    if (it.id && !deleted.has(it.id)) {
      carries.set(key, it.id);
      classOf.set(key, it.cls ?? "edit");
    } else if (it.cls) {
      classOf.set(key, it.cls);
    }
  });

  // Any old id not present in carries and not explicitly deleted is a delete.
  const carriedIds = new Set(carries.values());
  for (const b of base) if (!carriedIds.has(b.id)) deleted.add(b.id);

  return { old, neu, truth: { carries, deleted, classOf } };
}
