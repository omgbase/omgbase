import type { Database } from "better-sqlite3";
import { sha256, serializeTreeEntries, type TreeEntry } from "../hash.js";
import { myersScript } from "../edit-script.js";

// Delta tree nodes (spec/store §4.1 "Delta nodes", §4.4 "Checkpoints", §6,
// 16.0). A sibling list — the body root, a container's children — and a
// revision's frontmatter may be stored as a DELTA against the same list (the
// same frontmatter) of the document's PREVIOUS revision (`revisions.seq − 1`
// of the same `doc_id`; the base is implicit, no base hash is stored):
//
//   tree_nodes.entries   full:   [ [block_id, raw_hash_hex, child, type, attrs, trivia], … ]   (15.x, unchanged)
//                        delta:  {"d":[ op, … ]}
//   blobs.bytes (frontmatter)   full:   the frontmatter block's raw, `---…`              (15.x, unchanged)
//                               delta:  {"f":[ op, … ]}
//
// told apart by the FIRST BYTE (`[` / `-` full, `{` delta). An op is one of
// `["=",n]` (keep the next n entries of the base), `["+",x]` (insert x),
// `["-"]` (drop the next base entry), `["~",x]` (replace the next base entry
// with x); x is a six-element entry (body) or a line with its ending
// (frontmatter), spliced verbatim. The ops consume exactly the base. A node
// is a delta only when the delta is strictly smaller than the full form, the
// revision is not a CHECKPOINT (`(seq − 1) % 16 == 0`, the first revision, a
// revision whose previous one is archived or missing), and a base exists at
// the same position (the same block id in the previous revision's tree; the
// root; the previous frontmatter). A delta node hash is `sha256(entries)` like
// any node — content-addressed, shared by any two revisions producing the same
// text — and is MEANINGFUL ONLY in the context of the revision that names it:
// a reader resolves `{`-form at (doc, seq, block) by applying the ops to the
// resolved list at (doc, seq − 1, block), walking back until a `[`-form node
// (at most 15 steps, by the checkpoint cadence). A revision therefore never
// reuses a delta node of its predecessor for an unchanged list: an unchanged
// list reuses the base's node hash only when that node is SELF-CONTAINED (a
// `[`-form node whose every child is self-contained — context-free), else it
// writes the identity delta `{"d":[["=",n]]}` (one shared row, ~17 B).
//
// The GC mark (§7) is EXPLICIT: a live revision marks the objects its own
// nodes name (every entry of a `[`-node, the `+`/`~` entries of a `{`-node, the
// frontmatter blob whatever its form); what a delta keeps "as the base" is
// marked by the base revision, which the base-liveness rule keeps live: a
// delta's previous revision is never archived while the delta is — the squash
// re-checkpoints a kept revision whose predecessor it archives (archive.ts).

/** The checkpoint cadence: revision `seq` is a checkpoint when `(seq − 1) % CHECKPOINT_EVERY == 0` (1, 17, 33, …). */
export const CHECKPOINT_EVERY = 16;

let checkpointEvery = CHECKPOINT_EVERY;

/** The measurement seam (tests only): `1` makes every revision a checkpoint, which is exactly the 15.x encoding. */
export function setCheckpointEvery(n: number | null): void {
  checkpointEvery = n ?? CHECKPOINT_EVERY;
}

export function currentCheckpointEvery(): number {
  return checkpointEvery;
}

/** spec/store §4.4: the cadence rule alone — the writer adds "no base" and "base archived". */
export function isCheckpointSeq(seq: number): boolean {
  return (seq - 1) % checkpointEvery === 0;
}

/** A malformed or unresolvable delta (ops that do not consume the base, a `{`-node with no base, a delta in a segment). */
export class DeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeltaError";
  }
}

/** One op over the base's positions; `x` is the payload's TEXT (an entry's canonical JSON, or a frontmatter line). */
export type DeltaOp = ["=", number] | ["+", string] | ["-"] | ["~", string];

/** One §4.1 entry: [block_id, raw_hash_hex, child_tree_hash_hex | null, type, attrs, trivia_hash_hex | null]. */
export type Entry = [string, string, string | null, string, Record<string, unknown>, string | null];

// ---- encodings ----------------------------------------------------------------------

/** An entry's canonical text — exactly the six-element array as §4.1 serializes it. */
export function entryText(e: Entry): string {
  const t: TreeEntry = { blockId: e[0], rawHashHex: e[1], childTreeHashHex: e[2], type: e[3], attrs: e[4], triviaHashHex: e[5] };
  return serializeTreeEntries([t]).slice(1, -1);
}

/** Parse one entry's canonical text back (the payload of a `+`/`~` op, or a full node's element). */
export function parseEntry(v: unknown): Entry | null {
  if (!Array.isArray(v) || v.length !== 6) return null;
  const [id, raw, child, type, attrs, trivia] = v as unknown[];
  if (typeof id !== "string" || typeof raw !== "string" || typeof type !== "string") return null;
  if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) return null;
  if (child !== null && typeof child !== "string") return null;
  if (trivia !== null && typeof trivia !== "string") return null;
  return [id, raw, child, type, attrs as Record<string, unknown>, trivia];
}

/** The full-form text of a sibling list from its entry texts. */
export function fullNodeText(texts: readonly string[]): string {
  return `[${texts.join(",")}]`;
}

/**
 * The delta text of `next` against `base` (both as the payload texts of their
 * items): Myers' shortest edit script over the texts, grouped — a run of keeps
 * is `["=",n]`; inside a run of edits the k-th deletion and the k-th insertion
 * pair into `["~",x]`, the surplus deletions are `["-"]` and the surplus
 * insertions `["+",x]`. `key` is `"d"` for a body node, `"f"` for a
 * frontmatter; `payload` renders an item's text into the op (verbatim for an
 * entry, JSON-quoted for a line).
 */
export function encodeDelta(base: readonly string[], next: readonly string[], key: "d" | "f", payload: (text: string) => string): string {
  const script = myersScript([...base], [...next]);
  const ops: string[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i]!;
    if (op.kind === "keep") {
      let n = 0;
      while (i < script.length && script[i]!.kind === "keep") {
        n++;
        i++;
      }
      ops.push(`["=",${n}]`);
      continue;
    }
    const deletes: string[] = [];
    const inserts: string[] = [];
    while (i < script.length && script[i]!.kind !== "keep") {
      if (script[i]!.kind === "delete") deletes.push(script[i]!.line);
      else inserts.push(script[i]!.line);
      i++;
    }
    const paired = Math.min(deletes.length, inserts.length);
    for (let k = 0; k < paired; k++) ops.push(`["~",${payload(inserts[k]!)}]`);
    for (let k = paired; k < deletes.length; k++) ops.push(`["-"]`);
    for (let k = paired; k < inserts.length; k++) ops.push(`["+",${payload(inserts[k]!)}]`);
  }
  return `{"${key}":[${ops.join(",")}]}`;
}

/** The delta of a body sibling list: entry texts spliced verbatim. */
export function encodeBodyDelta(baseTexts: readonly string[], nextTexts: readonly string[]): string {
  return encodeDelta(baseTexts, nextTexts, "d", (t) => t);
}

/** Lines of a text, each with its own line ending (`\n`, or `\r\n` — the `\r` stays with its line); the last has none. `""` → `[""]`. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The delta of a frontmatter raw against the previous revision's raw: lines, JSON-quoted (spec/store §4.1 "frontmatter delta"). */
export function encodeFrontmatterDelta(baseRaw: string, nextRaw: string): string {
  return encodeDelta(splitLines(baseRaw), splitLines(nextRaw), "f", (t) => JSON.stringify(t));
}

/**
 * The measured-and-not-chosen variant (spec/store §10 "Decisions", 16.0): a
 * frontmatter delta whose changed lines are blob references (64 hex) instead
 * of inlined bytes. Returns the text and the lines a writer would have to put
 * as blobs. Never written; the measurement test costs it against the inlined form.
 */
export function encodeFrontmatterDeltaRefs(baseRaw: string, nextRaw: string): { text: string; newBlobs: string[] } {
  const newBlobs: string[] = [];
  const text = encodeDelta(splitLines(baseRaw), splitLines(nextRaw), "f", (t) => {
    newBlobs.push(t);
    return JSON.stringify(sha256(t).toString("hex"));
  });
  return { text, newBlobs };
}

/** UTF-8 byte length — the never-larger rule compares bytes, as `blobs.size` and `tree_nodes.entries` are stored. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// ---- parsing ---------------------------------------------------------------------------

export type ParsedNode = { form: "full"; entries: Entry[] } | { form: "delta"; ops: DeltaOp[] };

function parseOps(v: unknown, payload: (x: unknown) => string | null): DeltaOp[] | null {
  if (!Array.isArray(v)) return null;
  const ops: DeltaOp[] = [];
  for (const raw of v) {
    if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "string") return null;
    const tag = raw[0];
    if (tag === "=") {
      if (raw.length !== 2 || typeof raw[1] !== "number" || !Number.isInteger(raw[1]) || raw[1] <= 0) return null;
      ops.push(["=", raw[1]]);
    } else if (tag === "-") {
      if (raw.length !== 1) return null;
      ops.push(["-"]);
    } else if (tag === "+" || tag === "~") {
      if (raw.length !== 2) return null;
      const x = payload(raw[1]);
      if (x === null) return null;
      ops.push([tag, x]);
    } else return null;
  }
  return ops;
}

/** Parse a `tree_nodes.entries` text: `[`-form entries or `{"d":…}` ops; null when neither. */
export function parseNodeText(text: string): ParsedNode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const entries: Entry[] = [];
    for (const e of parsed) {
      const entry = parseEntry(e);
      if (!entry) return null;
      entries.push(entry);
    }
    return { form: "full", entries };
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "d") return null;
  const ops = parseOps((parsed as { d: unknown }).d, (x) => {
    const e = parseEntry(x);
    return e ? entryText(e) : null;
  });
  return ops ? { form: "delta", ops } : null;
}

/** Parse a frontmatter blob's bytes: the raw (`-`-form) or `{"f":…}` ops; null when a `{` text is not a valid delta. */
export function parseFrontmatterBlob(text: string): { form: "full"; raw: string } | { form: "delta"; ops: DeltaOp[] } | null {
  if (!text.startsWith("{")) return { form: "full", raw: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "f") return null;
  const ops = parseOps((parsed as { f: unknown }).f, (x) => (typeof x === "string" ? x : null));
  return ops ? { form: "delta", ops } : null;
}

/** Apply ops to a base (item texts); `DeltaError` unless the ops consume exactly the base. */
export function applyOps(ops: readonly DeltaOp[], base: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const op of ops) {
    switch (op[0]) {
      case "=":
        if (i + op[1] > base.length) throw new DeltaError(`delta keeps ${op[1]} entries at position ${i} of a base with ${base.length}`);
        for (let k = 0; k < op[1]; k++) out.push(base[i++]!);
        break;
      case "-":
        if (i >= base.length) throw new DeltaError(`delta drops an entry past the end of a base with ${base.length}`);
        i++;
        break;
      case "~":
        if (i >= base.length) throw new DeltaError(`delta replaces an entry past the end of a base with ${base.length}`);
        i++;
        out.push(op[1]);
        break;
      case "+":
        out.push(op[1]);
        break;
    }
  }
  if (i !== base.length) throw new DeltaError(`delta consumed ${i} of ${base.length} base entries`);
  return out;
}

/** The objects a node's text names on its own: every entry of a `[`-node, the `+`/`~` entries of a `{`-node (spec/store §7, the explicit mark). */
export function explicitEntries(node: ParsedNode): Entry[] {
  if (node.form === "full") return node.entries;
  const out: Entry[] = [];
  for (const op of node.ops) {
    if (op[0] === "+" || op[0] === "~") {
      const e = parseEntry(JSON.parse(op[1]));
      if (e) out.push(e);
    }
  }
  return out;
}

// ---- resolution --------------------------------------------------------------------------

/** A sibling list resolved in its revision's context. */
export interface ResolvedList {
  /** The node row's hash (hex) as the revision references it — a `[` or `{` node. */
  hash: string;
  form: "full" | "delta";
  entries: Entry[];
  /** `entries` as canonical texts (what a delta is encoded against). */
  texts: string[];
  /** A `[`-form node whose every child list is self-contained: context-free, reusable by the next revision. */
  selfContained: boolean;
}

/** A revision's whole tree resolved: the root list and every container's children by the container's block id. */
export interface ResolvedTree {
  root: ResolvedList;
  byBlock: Map<string, ResolvedList>;
}

interface RevRow {
  root_tree: Buffer | null;
  frontmatter_blob: Buffer | null;
  archive: string | null;
}

/**
 * Resolves nodes in revision context, memoized per connection use. `prefix`
 * is `""` for the store or `"<alias>."` for an archive segment — a segment
 * holds checkpoint forms only (spec/store §7.1), so a `{`-node there is an
 * error rather than a walk-back.
 */
export class TreeResolver {
  private readonly nodeStmt;
  private readonly revStmt;
  private readonly blobStmt;
  private readonly lists = new Map<string, ResolvedList>();
  private readonly trees = new Map<string, ResolvedTree>();
  private readonly frontmatters = new Map<string, string>();

  constructor(private readonly db: Database, private readonly prefix = "") {
    this.nodeStmt = db.prepare(`SELECT entries FROM ${prefix}tree_nodes WHERE hash = ?`);
    this.revStmt = db.prepare(`SELECT root_tree, frontmatter_blob${prefix === "" ? ", archive" : ", NULL AS archive"} FROM ${prefix}revisions WHERE doc_id = ? AND seq = ?`);
    this.blobStmt = db.prepare(`SELECT bytes FROM ${prefix}blobs WHERE hash = ?`);
  }

  private revision(docId: string, seq: number): RevRow | undefined {
    return this.revStmt.get(docId, seq) as RevRow | undefined;
  }

  /** The base revision of a delta at `seq`: `seq − 1`, which must exist and be live (spec/store §4.4, §8 I10). */
  private base(docId: string, seq: number, what: string): RevRow {
    if (this.prefix !== "") throw new DeltaError(`${what} of ${docId} at seq ${seq} is a delta inside an archive segment`);
    const prev = this.revision(docId, seq - 1);
    if (!prev) throw new DeltaError(`${what} of ${docId} at seq ${seq} is a delta but the document has no revision ${seq - 1}`);
    if (prev.archive !== null) throw new DeltaError(`${what} of ${docId} at seq ${seq} is a delta whose base revision ${seq - 1} is archived`);
    return prev;
  }

  /**
   * The sibling list stored under `hashHex`, in the context of `(docId, seq)`,
   * at the position `blockId` (null = the root). A `[`-node resolves to its
   * entries; a `{`-node to its ops applied to the same position of `seq − 1`.
   */
  list(docId: string, seq: number, hashHex: string, blockId: string | null): ResolvedList {
    const key = `${docId} ${seq} ${blockId ?? ""} ${hashHex}`;
    const memo = this.lists.get(key);
    if (memo) return memo;
    const row = this.nodeStmt.get(Buffer.from(hashHex, "hex")) as { entries: string } | undefined;
    if (!row) throw new DeltaError(`tree node ${hashHex} named by ${docId} at seq ${seq} is missing`);
    const node = parseNodeText(row.entries);
    if (!node) throw new DeltaError(`tree node ${hashHex} does not parse as a full or delta node`);
    let entries: Entry[];
    let texts: string[];
    if (node.form === "full") {
      entries = node.entries;
      texts = entries.map(entryText);
    } else {
      const prev = this.base(docId, seq, `node ${hashHex}`);
      if (!prev.root_tree) throw new DeltaError(`base revision ${seq - 1} of ${docId} has no root tree`);
      const baseList = blockId === null
        ? this.list(docId, seq - 1, prev.root_tree.toString("hex"), null)
        : this.childList(docId, seq - 1, prev.root_tree.toString("hex"), blockId);
      if (!baseList) throw new DeltaError(`node ${hashHex} of ${docId} at seq ${seq} is a delta for block ${blockId} which has no children at seq ${seq - 1}`);
      texts = applyOps(node.ops, baseList.texts);
      entries = texts.map((t) => {
        const e = parseEntry(JSON.parse(t));
        if (!e) throw new DeltaError(`delta node ${hashHex} resolved to a malformed entry`);
        return e;
      });
    }
    // Self-containment needs the children: a delta is never self-contained; a
    // full node is when every child list is.
    let selfContained = node.form === "full";
    if (selfContained) {
      for (const e of entries) {
        if (e[2] !== null && !this.list(docId, seq, e[2], e[0]).selfContained) {
          selfContained = false;
          break;
        }
      }
    }
    const out: ResolvedList = { hash: hashHex, form: node.form, entries, texts, selfContained };
    this.lists.set(key, out);
    return out;
  }

  /** The children list of `blockId` anywhere in the tree rooted at `rootHex` (context `(docId, seq)`), or undefined when the block has no children there. */
  childList(docId: string, seq: number, rootHex: string, blockId: string): ResolvedList | undefined {
    return this.tree(docId, seq, rootHex).byBlock.get(blockId);
  }

  /** The whole tree of a revision, every list resolved in its context. */
  tree(docId: string, seq: number, rootHex: string): ResolvedTree {
    const key = `${docId} ${seq} ${rootHex}`;
    const memo = this.trees.get(key);
    if (memo) return memo;
    const byBlock = new Map<string, ResolvedList>();
    const root = this.list(docId, seq, rootHex, null);
    const walk = (list: ResolvedList): void => {
      for (const e of list.entries) {
        if (e[2] === null) continue;
        const child = this.list(docId, seq, e[2], e[0]);
        byBlock.set(e[0], child);
        walk(child);
      }
    };
    walk(root);
    const out = { root, byBlock };
    this.trees.set(key, out);
    return out;
  }

  /** A revision's frontmatter raw from its `frontmatter_blob` (a `-`-form blob, or a `{"f":…}` delta over `seq − 1`'s). */
  frontmatter(docId: string, seq: number, blobHex: string): string {
    const key = `${docId} ${seq} ${blobHex}`;
    const memo = this.frontmatters.get(key);
    if (memo !== undefined) return memo;
    const row = this.blobStmt.get(Buffer.from(blobHex, "hex")) as { bytes: Buffer } | undefined;
    if (!row) throw new DeltaError(`frontmatter blob ${blobHex} named by ${docId} at seq ${seq} is missing`);
    const text = row.bytes.toString("utf8");
    const parsed = parseFrontmatterBlob(text);
    if (!parsed) throw new DeltaError(`frontmatter blob ${blobHex} does not parse as a raw or a delta`);
    let raw: string;
    if (parsed.form === "full") raw = parsed.raw;
    else {
      const prev = this.base(docId, seq, `frontmatter ${blobHex}`);
      if (!prev.frontmatter_blob) throw new DeltaError(`frontmatter ${blobHex} of ${docId} at seq ${seq} is a delta but revision ${seq - 1} has no frontmatter`);
      const baseRaw = this.frontmatter(docId, seq - 1, prev.frontmatter_blob.toString("hex"));
      raw = applyOps(parsed.ops, splitLines(baseRaw)).join("");
    }
    this.frontmatters.set(key, raw);
    return raw;
  }

  /**
   * The checkpoint (self-contained) form of a resolved tree: every list as a
   * `[`-node whose child hashes are the full children's — what an archive
   * segment holds (§7.1) and what the squash re-checkpoints a kept revision
   * to. Returns the root's full hash and every full node by hash.
   */
  checkpointForm(tree: ResolvedTree): { rootHex: string; nodes: Map<string, string> } {
    const nodes = new Map<string, string>();
    const full = (list: ResolvedList): string => {
      const texts = list.entries.map((e) => {
        if (e[2] === null) return entryText(e);
        const child = tree.byBlock.get(e[0]);
        if (!child) throw new DeltaError(`block ${e[0]} names a child tree but the resolved tree has none`);
        const childHex = full(child);
        return entryText([e[0], e[1], childHex, e[3], e[4], e[5]]);
      });
      const text = fullNodeText(texts);
      const hex = sha256(text).toString("hex");
      nodes.set(hex, text);
      return hex;
    };
    return { rootHex: full(tree.root), nodes };
  }
}

/** The blob hashes (raw + trivia) a list of entries names — the raws a reconstruct reads, the mark's leaves. */
export function entryBlobs(entries: readonly Entry[], into: Set<string>): void {
  for (const e of entries) {
    into.add(e[1]);
    if (e[5] !== null) into.add(e[5]);
  }
}
