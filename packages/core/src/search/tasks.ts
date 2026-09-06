import type { Store } from "../core/store/store.js";
import { contextPrefix, shouldEmbed, type EmbedTask } from "./embeddings.js";

// Build the embedding task list for a repo (05 §6). Walks every live block,
// keeps those worth embedding on their own (shouldEmbed), and attaches the
// context prefix the worker embeds with: "{doc title} · {path} · {heading
// chain} · {type}". The heading chain comes from the sections table — the
// sections whose ordinal range contains the block, ordered by heading level.
//
// Keyed by block raw_hash (content_hash), so the worker's cache dedupes across
// identical content and only misses re-embed.

interface BlockRow {
  block_id: string;
  doc_id: string;
  path: string;
  ordinal: number;
  type: string;
  text: string;
  raw_hash: Buffer;
}

interface SectionRow {
  doc_id: string;
  heading_text: string;
  level: number;
  first_ordinal: number;
  last_ordinal: number;
}

function docTitle(titleByDoc: Map<string, string>, firstHeadingByDoc: Map<string, string>, docId: string, path: string): string {
  const t = titleByDoc.get(docId);
  if (t && t.trim()) return t;
  return firstHeadingByDoc.get(docId) ?? path;
}

/** Build EmbedTask[] for every embeddable live block in the repo. */
export function buildEmbedTasks(store: Store, repoId: string): EmbedTask[] {
  const blocks = store.db
    .prepare(
      `SELECT b.block_id, b.doc_id, d.path AS path,
              b.ordinal, b.type, b.text, b.raw_hash
       FROM blocks b JOIN documents d ON d.doc_id = b.doc_id
       WHERE b.repo_id = ? AND b.deleted_commit IS NULL
       ORDER BY d.path, b.ordinal`,
    )
    .all(repoId) as BlockRow[];

  // Frontmatter title per doc (scalar), for the embed context prefix. One scan
  // of the properties table instead of a per-block metadata parse.
  const titleByDoc = new Map<string, string>();
  for (const r of store.db.prepare(
    `SELECT p.doc_id AS doc_id, p.val_text AS title FROM properties p
     WHERE p.repo_id = ? AND p.source = 'frontmatter' AND p.key = 'title'
       AND p.card = 'scalar' AND p.type = 'string' AND p.deleted_commit IS NULL`,
  ).all(repoId) as { doc_id: string; title: string | null }[]) {
    if (r.title) titleByDoc.set(r.doc_id, r.title);
  }

  // All sections in the repo, with their heading text, for chain lookup.
  const sections = store.db
    .prepare(
      `SELECT s.doc_id AS doc_id, hb.text AS heading_text, s.level AS level,
              s.first_ordinal AS first_ordinal, s.last_ordinal AS last_ordinal
       FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
       WHERE hb.repo_id = ?`,
    )
    .all(repoId) as SectionRow[];

  const sectionsByDoc = new Map<string, SectionRow[]>();
  for (const s of sections) {
    (sectionsByDoc.get(s.doc_id) ?? sectionsByDoc.set(s.doc_id, []).get(s.doc_id)!).push(s);
  }

  // First heading text per doc, as a title fallback.
  const firstHeadingByDoc = new Map<string, string>();
  for (const s of sections) {
    if (!firstHeadingByDoc.has(s.doc_id)) firstHeadingByDoc.set(s.doc_id, s.heading_text);
  }

  const headingChain = (docId: string, ordinal: number): string[] => {
    const docSections = sectionsByDoc.get(docId);
    if (!docSections) return [];
    // Sections containing this ordinal, shallowest (lowest level) first.
    return docSections
      .filter((s) => ordinal >= s.first_ordinal && ordinal <= s.last_ordinal)
      .sort((a, b) => a.level - b.level)
      .map((s) => s.heading_text);
  };

  const tasks: EmbedTask[] = [];
  for (const b of blocks) {
    if (!shouldEmbed(b.text)) continue;
    const ctx = contextPrefix({
      docTitle: docTitle(titleByDoc, firstHeadingByDoc, b.doc_id, b.path),
      path: b.path,
      headingChain: headingChain(b.doc_id, b.ordinal),
      blockType: b.type,
    });
    tasks.push({ blockId: b.block_id, contentHashHex: b.raw_hash.toString("hex"), ctx, text: b.text });
  }
  return tasks;
}
