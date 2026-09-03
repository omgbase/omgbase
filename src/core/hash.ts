import { createHash } from "node:crypto";

// Hashing & canonical serialization — 02 §5.
// Content hashes are sha256 of UTF-8 bytes, stored as 32-byte buffers and
// displayed truncated to 16 hex chars.

export function sha256(input: string | Uint8Array): Buffer {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return h.digest();
}

export function hashHex(input: string | Uint8Array): string {
  return sha256(input).toString("hex");
}

/** Display form: first 16 hex chars (02 §1). */
export function shortHash(hash: Buffer | string): string {
  const hex = typeof hash === "string" ? hash : hash.toString("hex");
  return hex.slice(0, 16);
}

/** raw_hash — sha256 of the exact raw source bytes (02 §1). */
export function rawHash(raw: string): Buffer {
  return sha256(raw);
}

// Normalized text (02 §5.2): per-line trim + internal whitespace-run collapse,
// drop blank lines, NFC. List-marker stripping is applied by the caller (it
// needs block type), so this operates on already-marker-stripped text.
export function normalizeText(raw: string): string {
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line.length > 0)
    .join(" ")
    .normalize("NFC");
}

/** norm_hash — sha256 of the normalized text (02 §1, §5.2). */
export function normHash(normalizedText: string): Buffer {
  return sha256(normalizedText);
}

// Canonical attrs JSON: object with lexicographically sorted keys, no
// whitespace (02 §5.1). Values are emitted with JSON.stringify (stable for
// scalars/arrays/nested objects we use).
export function canonicalAttrs(attrs: Record<string, unknown>): string {
  const keys = Object.keys(attrs).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(attrs[k])}`);
  return `{${parts.join(",")}}`;
}

function canonicalValue(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalValue).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(obj[k])}`).join(",")}}`;
}

// Tree-node entry (02 §5.1): positional array
//   [block_id, raw_hash_hex, child_tree_hash_hex|null, type, attrs_canonical_json, trivia_hash_hex|null]
export interface TreeEntry {
  blockId: string;
  rawHashHex: string;
  childTreeHashHex: string | null;
  type: string;
  attrs: Record<string, unknown>;
  triviaHashHex: string | null;
}

/** Canonical serialization of a tree node's entries (UTF-8, no whitespace). */
export function serializeTreeEntries(entries: TreeEntry[]): string {
  const rows = entries.map((e) =>
    [
      JSON.stringify(e.blockId),
      JSON.stringify(e.rawHashHex),
      e.childTreeHashHex === null ? "null" : JSON.stringify(e.childTreeHashHex),
      JSON.stringify(e.type),
      canonicalAttrs(e.attrs),
      e.triviaHashHex === null ? "null" : JSON.stringify(e.triviaHashHex),
    ].join(","),
  );
  return `[${rows.map((r) => `[${r}]`).join(",")}]`;
}

/** Tree-node hash: sha256 over the canonical entries serialization (02 §5.1). */
export function treeHash(entries: TreeEntry[]): Buffer {
  return sha256(serializeTreeEntries(entries));
}
