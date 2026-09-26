import { sha256, normalizeVisibleText } from "../../core/hash.js";
import type { MatchBlock } from "../types.js";
import { flatten, type FlatSource } from "../flatten.js";

// Synthetic edit-script generator (03 §9). Applies scripted edits to a document
// of blocks, producing (old blocks with ids, new blocks, ground-truth mapping).
// Ground truth is exact by construction. A seeded PRNG makes runs reproducible
// (this is harness code, not the matcher — determinism here is for repeatability).

export type EditClass = "edit" | "insert" | "delete" | "move" | "reorder" | "split" | "merge" | "copy";

/** Structured-mode classes (list-item edits; see generateStructuredCase). */
export type StructuredEditClass =
  | "item-edit-mid" | "item-edit-last" | "item-insert" | "item-delete" | "item-move"
  | "item-gains-nested-list" | "item-reorder"
  /** the list container whose items were edited (must carry) */
  | "list"
  /** any block the script did not touch (must carry) */
  | "same"
  /** the paragraph / nested list / nested items minted under an item that gained a nested list */
  | "nested-new";

export interface GroundTruth {
  /** new block key → old id it should carry (absent ⇒ should be minted) */
  carries: Map<string, string>;
  /** old ids expected to be deleted */
  deleted: Set<string>;
  /** per new key, the edit class that produced it (for per-class metrics) */
  classOf: Map<string, EditClass | StructuredEditClass>;
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

// ---------------------------------------------------------------------------
// Structured document mode (spec/reconcile §10 "mid-item edits on short items").
//
// Documents mix paragraphs, headings and lists; the scripted edits act on list
// items of a parameterized length (2–6 words). Trees are built as FlatSource
// and flattened with flatten(), so `text` follows spec/format §4.1 for
// containers exactly as the reconciler sees it: the list's text is its items'
// texts joined by one space; an item that gains a nested list becomes a
// container whose text is "<its words> <nested words…>". Shapes mirror the
// parser (packages/core/src/core/parse): item raw `- words`, list raw = item
// raws joined by `\n`, a nested list's raw keeps the indent on continuation
// lines only (source slice starting at content).
//
// Ground truth: the list carries; every untouched block carries; the edited
// item SHOULD carry (that is the question the mode measures); inserted items
// and the new nested blocks are minted; deleted items are deleted.

export interface StructuredOpts {
  /** top-level blocks in the base document (default 10) */
  size?: number;
  /** edits per case ≈ size × intensity (default 0.3 ⇒ 3) */
  intensity?: number;
  /** words per list item; a number fixes it, absent ⇒ 2–6 per item */
  itemWords?: number;
}

// A larger vocabulary than the flat mode's so short items stay unique within a
// document (ground truth needs distinguishable items; duplicates would make the
// "right" id a coin toss the matcher cannot be blamed for).
const ITEM_WORDS = (
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa " +
  "quebec romeo sierra tango uniform victor whiskey xray yankee zulu apple banana cherry damson elder " +
  "fig grape hazel iris jasmine kale lemon mango nectar olive peach quince radish sage thyme umber " +
  "violet walnut yarrow zest amber birch cedar dune ember flint gorse heath ivy jade kelp lotus moss " +
  "nickel onyx pearl quartz reed slate tundra vale willow"
).split(" ");

type Cls = StructuredEditClass;

interface GItem { id: string | null; words: string[]; cls: Cls | null; nested: string[] | null }
type GBlock =
  | { kind: "paragraph" | "heading"; id: string; raw: string }
  | { kind: "list"; id: string; items: GItem[]; cls: Cls | null };

function itemToSource(it: GItem, withId: boolean): FlatSource {
  const own = it.words.join(" ");
  if (it.nested === null) {
    const s: FlatSource = { type: "list_item", raw: `- ${own}`, children: [] };
    if (withId && it.id) s.blockId = it.id;
    return s;
  }
  // Parser shape: item raw keeps the nested lines; children are the folded
  // paragraph and the nested list; the nested list's first line starts at content.
  const nestedItemRaws = it.nested.map((w) => `- ${w}`);
  const nestedList: FlatSource = {
    type: "list",
    raw: nestedItemRaws.join("\n  "),
    children: nestedItemRaws.map((raw) => ({ type: "list_item", raw, children: [] })),
  };
  const s: FlatSource = {
    type: "list_item",
    raw: `- ${own}\n  ${nestedItemRaws.join("\n  ")}`,
    children: [{ type: "paragraph", raw: own, children: [] }, nestedList],
  };
  if (withId && it.id) s.blockId = it.id;
  return s;
}

function blockToSource(b: GBlock, withId: boolean): FlatSource {
  if (b.kind === "list") {
    const children = b.items.map((it) => itemToSource(it, withId));
    const s: FlatSource = { type: "list", raw: children.map((c) => c.raw).join("\n"), children };
    if (withId) s.blockId = b.id;
    return s;
  }
  const s: FlatSource = { type: b.kind, raw: b.raw, children: [] };
  if (withId) s.blockId = b.id;
  return s;
}

/** Walk a FlatSource tree in flatten()'s order, yielding the same positional keys. */
function walkKeys(list: FlatSource[], parentKey: string | null, fn: (b: FlatSource, key: string) => void): void {
  list.forEach((b, index) => {
    const key = `${parentKey ?? ""}/${index}`;
    fn(b, key);
    walkKeys(b.children, key, fn);
  });
}

export const STRUCTURED_ITEM_CLASSES: readonly Cls[] = [
  "item-edit-mid", "item-edit-last", "item-insert", "item-delete", "item-move", "item-gains-nested-list", "item-reorder",
];

/** Generate one structured case (see the mode comment above). */
export function generateStructuredCase(seed: number, opts: StructuredOpts = {}): GeneratedCase {
  // Offset the seed space so structured cases never share a PRNG stream with flat ones.
  const r = rng((seed + 0x5a5a0000) >>> 0);
  const size = opts.size ?? 10;
  const intensity = opts.intensity ?? 0.3;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!;
  const wordCount = (): number => opts.itemWords ?? 2 + Math.floor(r() * 5);

  let nextId = 0;
  const mint = (): string => `b_${nextId++}`;
  const used = new Set<string>(); // item texts, unique across the document
  const freshWords = (n: number): string[] => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const w = Array.from({ length: n }, () => pick(ITEM_WORDS));
      const key = w.join(" ");
      if (!used.has(key)) { used.add(key); return w; }
    }
    // Vocabulary exhausted for this length (only plausible for 1-word items): accept a repeat.
    return Array.from({ length: n }, () => pick(ITEM_WORDS));
  };
  const replaceWord = (words: string[], at: number): void => {
    // Replace so the resulting item text is new to the document (bounded retries).
    for (let attempt = 0; attempt < 50; attempt++) {
      const w = pick(ITEM_WORDS);
      if (w === words[at]) continue;
      const trial = [...words]; trial[at] = w;
      const key = trial.join(" ");
      if (!used.has(key)) { used.add(key); words[at] = w; return; }
    }
    words[at] = pick(ITEM_WORDS.filter((w) => w !== words[at]));
  };

  // Base document: ids are assigned in document (pre-order) order.
  const blocks: GBlock[] = [];
  for (let i = 0; i < size; i++) {
    const roll = r();
    // Guarantee two lists so there is always something to edit.
    const wantList = roll < 0.5 || (i >= size - 2 && blocks.filter((b) => b.kind === "list").length < 2);
    if (wantList) {
      const id = mint();
      const n = 3 + Math.floor(r() * 5); // 3–7 items
      const items: GItem[] = Array.from({ length: n }, () => ({ id: mint(), words: freshWords(wordCount()), cls: null, nested: null }));
      blocks.push({ kind: "list", id, items, cls: null });
    } else if (roll < 0.65) {
      blocks.push({ kind: "heading", id: mint(), raw: `${"#".repeat(1 + Math.floor(r() * 3))} ${sentence(r, 2 + Math.floor(r() * 3))}` });
    } else {
      blocks.push({ kind: "paragraph", id: mint(), raw: sentence(r, 8 + Math.floor(r() * 8)) });
    }
  }
  const oldTree = blocks.map((b) => blockToSource(b, true));
  const old = flatten(oldTree);

  // Scripted item edits.
  const deleted = new Set<string>();
  const lists = blocks.filter((b): b is Extract<GBlock, { kind: "list" }> => b.kind === "list");
  const nEdits = Math.max(1, Math.floor(size * intensity));
  for (let e = 0; e < nEdits; e++) {
    const list = pick(lists);
    const cls = pick(STRUCTURED_ITEM_CLASSES);
    const untouched = list.items.map((it, i) => [it, i] as const).filter(([it]) => it.id !== null && it.cls === null);
    if (untouched.length === 0) continue;
    const [it, idx] = pick(untouched);
    switch (cls) {
      case "item-edit-mid": {
        // change 1–2 words, none of them the last one
        const positions = it.words.length - 1;
        if (positions < 1) continue;
        const changes = Math.min(positions, 1 + Math.floor(r() * 2));
        const chosen = new Set<number>();
        while (chosen.size < changes) chosen.add(Math.floor(r() * positions));
        used.delete(it.words.join(" "));
        for (const at of chosen) replaceWord(it.words, at);
        it.cls = cls;
        break;
      }
      case "item-edit-last": {
        used.delete(it.words.join(" "));
        replaceWord(it.words, it.words.length - 1);
        it.cls = cls;
        break;
      }
      case "item-insert": {
        const at = Math.floor(r() * (list.items.length + 1));
        list.items.splice(at, 0, { id: null, words: freshWords(wordCount()), cls, nested: null });
        break;
      }
      case "item-delete": {
        if (list.items.length < 3) continue;
        deleted.add(it.id!);
        list.items.splice(idx, 1);
        break;
      }
      case "item-move": {
        if (list.items.length < 3) continue;
        list.items.splice(idx, 1);
        let dest = Math.floor(r() * list.items.length);
        if (dest >= idx) dest++; // any position other than the original
        list.items.splice(Math.min(dest, list.items.length), 0, it);
        it.cls = cls;
        break;
      }
      case "item-reorder": {
        const j = idx + 1 < list.items.length ? idx + 1 : idx - 1;
        if (j < 0) continue;
        const other = list.items[j]!;
        if (other.id === null || other.cls !== null) continue;
        list.items[idx] = other; list.items[j] = it;
        it.cls = cls; other.cls = cls;
        break;
      }
      case "item-gains-nested-list": {
        it.nested = Array.from({ length: 2 + Math.floor(r() * 2) }, () => freshWords(1)[0]!);
        it.cls = cls;
        break;
      }
      default:
        continue;
    }
    list.cls = "list";
  }

  // New tree: built with the truth ids attached, harvested, then stripped.
  const newTree = blocks.map((b) => blockToSource(b, true));
  const carries = new Map<string, string>();
  const classOf = new Map<string, EditClass | StructuredEditClass>();
  const clsByKey = new Map<string, Cls>();
  {
    // Classes by key: mirror blockToSource's shape.
    const listIdx = new Map<GBlock, number>();
    blocks.forEach((b, i) => listIdx.set(b, i));
    for (const b of blocks) {
      const bk = `/${listIdx.get(b)!}`;
      if (b.kind !== "list") { clsByKey.set(bk, "same"); continue; }
      clsByKey.set(bk, b.cls ?? "same");
      b.items.forEach((it, i) => {
        const ik = `${bk}/${i}`;
        clsByKey.set(ik, it.cls ?? (it.id === null ? "item-insert" : "same"));
        if (it.nested !== null) {
          clsByKey.set(`${ik}/0`, "nested-new");
          clsByKey.set(`${ik}/1`, "nested-new");
          it.nested.forEach((_, j) => clsByKey.set(`${ik}/1/${j}`, "nested-new"));
        }
      });
    }
  }
  walkKeys(newTree, null, (b, key) => {
    const cls = clsByKey.get(key) ?? "same";
    classOf.set(key, cls);
    if (b.blockId && !deleted.has(b.blockId)) carries.set(key, b.blockId);
    delete b.blockId;
  });
  const neu = flatten(newTree);

  const carriedIds = new Set(carries.values());
  for (const b of old) if (!carriedIds.has(b.blockId!)) deleted.add(b.blockId!);

  return { old, neu, truth: { carries, deleted, classOf } };
}
