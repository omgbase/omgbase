import type { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";

// mrplex importer (07 task 7.4). Imports a set of mrplex documents into an
// omgbase repo: each doc's current body → minted block ids via a single
// `import`-origin commit. Explicitly NO retro-inferred block history — mrplex
// has document-version history at best, never block-grain lineage, so inventing
// dispositions would violate history honesty (invariant #7). Optionally the
// doc-version history could be imported as successive revisions, but block
// identity is minted fresh at the first import and only threads forward.

export interface MrplexDoc {
  /** repo-relative path (no leading slash) */
  path: string;
  /** full markdown body including any frontmatter fence */
  markdown: string;
}

export interface ImportPlan {
  repoId: string;
  docCount: number;
  totalBytes: number;
  paths: string[];
}

export interface ImportResult {
  repoId: string;
  imported: { path: string; docId: string; blockCount: number; converged: boolean }[];
  allConverged: boolean;
}

/** Dry-run: report what would be imported without writing anything. */
export function planImport(repoId: string, docs: MrplexDoc[]): ImportPlan {
  return {
    repoId,
    docCount: docs.length,
    totalBytes: docs.reduce((n, d) => n + Buffer.byteLength(d.markdown, "utf8"), 0),
    paths: docs.map((d) => d.path).sort(),
  };
}

/** Import the documents as `import`-origin commits with freshly minted ids. */
export function importDocs(store: Store, repoId: string, docs: MrplexDoc[]): ImportResult {
  const ts = new Date().toISOString();
  const imported: ImportResult["imported"] = [];
  let allConverged = true;
  for (const doc of docs) {
    const res = ingestFile(store, repoId, doc.path, doc.markdown, {
      ts,
      origin: "import",
      resolveIds: makeReconcilingResolver(store, repoId, { ts, path: doc.path }),
    });
    imported.push({ path: doc.path, docId: res.docId, blockCount: res.blockCount, converged: res.converged });
    if (!res.converged) allConverged = false;
  }
  return { repoId, imported, allConverged };
}
