import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { MutBlock, MutDoc } from "./tree.js";
import { adapterForPath } from "../format/index.js";

// Load a document from the store into a MutDoc. When rootPath is provided,
// reads the file from disk and parses through the adapter to get accurate
// trivia (leading/trailing whitespace, structural framing like JSON braces).
// Block IDs are grafted from the store onto the parsed tree by ordinal match.
// Without rootPath, falls back to DB-only reconstruction with default trivia.

interface Row {
  block_id: string;
  parent_block: string | null;
  ordinal: number;
  type: string;
  attrs: string;
  raw_hash: Buffer;
}

function defaultTrivia(format: string): string {
  if (format === "json") return ",\n";
  if (format === "yaml") return "\n";
  return "\n\n";
}

export function loadMutDoc(db: Database, docId: string, rootPath?: string): MutDoc | null {
  const doc = db.prepare("SELECT doc_id, path, format, current_rev FROM documents WHERE doc_id = ? AND deleted_commit IS NULL").get(docId) as
    | { doc_id: string; path: string; format: string; current_rev: string | null }
    | undefined;
  if (!doc) return null;

  // File-based path: parse the actual file through the adapter to get accurate
  // trivia, then graft stored block IDs onto the parsed tree by ordinal match.
  if (rootPath) {
    const abs = join(rootPath, doc.path);
    if (existsSync(abs)) {
      const content = readFileSync(abs, "utf8");
      const adapter = adapterForPath(doc.path);
      if (adapter) {
        const tree = adapter.parse(content);

        // Build a map of (parent_block, ordinal) → block_id for all stored blocks.
        const allStored = db
          .prepare("SELECT block_id, parent_block, ordinal FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL ORDER BY parent_block, ordinal")
          .all(docId) as { block_id: string; parent_block: string | null; ordinal: number }[];
        const idByParentOrdinal = new Map<string, string>();
        for (const r of allStored) {
          idByParentOrdinal.set(`${r.parent_block ?? ""}|${r.ordinal}`, r.block_id);
        }

        const fmIdx = tree.children.findIndex((b) => b.type === "frontmatter");
        const contentBlocks = fmIdx >= 0 ? tree.children.slice(fmIdx + 1) : tree.children;
        const fmBlock = fmIdx >= 0 ? tree.children[fmIdx] : null;

        const toMut = (b: { type: string; raw: string; trivia: string; attrs: Record<string, unknown>; children: unknown[] }, ordinal: number, parentId: string | null): MutBlock => {
          const id = idByParentOrdinal.get(`${parentId ?? ""}|${ordinal}`) ?? `unmatched_${ordinal}`;
          return {
            id,
            type: b.type,
            raw: b.raw,
            trivia: b.trivia,
            attrs: b.attrs,
            children: (b.children as typeof b[]).map((c, i) => toMut(c, i, id)),
          };
        };

        return {
          docId: doc.doc_id,
          path: doc.path,
          format: doc.format,
          leadingTrivia: tree.leadingTrivia,
          frontmatterRaw: fmBlock ? fmBlock.raw + fmBlock.trivia : null,
          children: contentBlocks.map((b, i) => toMut(b, i, null)),
        };
      }
    }
  }

  // Fallback: DB-only reconstruction with default trivia.
  const rows = db
    .prepare(
      `SELECT block_id, parent_block, ordinal, type, attrs, raw_hash
       FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL
       ORDER BY parent_block, ordinal`,
    )
    .all(docId) as Row[];

  const trivia = defaultTrivia(doc.format);
  const blob = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const nodes = new Map<string, MutBlock>();
  for (const r of rows) {
    const raw = (blob.get(r.raw_hash) as { bytes: Buffer } | undefined)?.bytes.toString("utf8") ?? "";
    nodes.set(r.block_id, {
      id: r.block_id,
      type: r.type,
      raw,
      trivia,
      attrs: JSON.parse(r.attrs) as Record<string, unknown>,
      children: [],
    });
  }

  const roots: MutBlock[] = [];
  const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
  for (const r of ordered) {
    const node = nodes.get(r.block_id)!;
    if (r.parent_block && nodes.has(r.parent_block)) nodes.get(r.parent_block)!.children.push(node);
  }
  for (const r of ordered) {
    if (!r.parent_block || !nodes.has(r.parent_block)) roots.push(nodes.get(r.block_id)!);
  }

  let frontmatterRaw: string | null = null;
  if (doc.current_rev) {
    const rev = db.prepare("SELECT frontmatter_blob FROM revisions WHERE rev_id = ?").get(doc.current_rev) as { frontmatter_blob: Buffer | null } | undefined;
    if (rev?.frontmatter_blob) {
      const fm = blob.get(rev.frontmatter_blob) as { bytes: Buffer } | undefined;
      if (fm) frontmatterRaw = fm.bytes.toString("utf8") + "\n\n";
    }
  }

  return { docId: doc.doc_id, path: doc.path, format: doc.format, leadingTrivia: "", frontmatterRaw, children: roots };
}
