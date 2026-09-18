import { Store } from "./store/store.js";
import { mintId } from "./ids.js";

// Repo identity + fs-source registration (ADR-014). A repo owns identity +
// history, NOT a filesystem: `ensureRepo` mints the repo row, and when given a
// filesystem root it registers that as an `fs` source + attachment (the durable
// "where its bytes come from"). Ingesting a directory's files is a separate
// concern — `ingestDirectory` (sync/attach.ts) for the reconciling walk, or the
// freshness sweep / `observeOne` on the live path. The CLI entry point is
// `omg source add <dir>`; there is no `omg attach` verb.

/** Create (or reuse) a repo row for `slug`, returning its id. When `rootPath` is
 *  given it is registered as an `fs` source + attachment, not stored on the repo.
 *  Pass null for a sourceless/headless repo. */
export function ensureRepo(store: Store, slug: string, rootPath: string | null = null): string {
  const existing = store.db.prepare("SELECT repo_id FROM repos WHERE slug = ?").get(slug) as
    | { repo_id: string }
    | undefined;
  if (existing) return existing.repo_id;
  const repoId = mintId("rp");
  store.db.prepare("INSERT INTO repos (repo_id, slug) VALUES (?, ?)").run(repoId, slug);
  if (rootPath) registerFsSource(store, repoId, slug, rootPath);
  return repoId;
}

/** Register (idempotently) an `fs` source at `root` and attach it to a repo.
 *  Inline raw SQL — kept here rather than calling sync/sources to avoid a
 *  core→sync import cycle; the source shape matches sync/sources exactly. */
function registerFsSource(store: Store, repoId: string, slug: string, root: string): void {
  const db = store.db;
  db.prepare("INSERT OR IGNORE INTO adapters (name, command, args) VALUES ('fs', 'omgbase-fs-adapter', '[]')").run();
  const name = `${slug}-fs`;
  let source = db.prepare("SELECT source_id FROM sources WHERE name = ?").get(name) as { source_id: string } | undefined;
  if (!source) {
    const sourceId = mintId("src");
    db.prepare("INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?, ?, 'fs', ?, '{}')").run(sourceId, name, JSON.stringify({ root }));
    source = { source_id: sourceId };
  }
  db.prepare("INSERT OR IGNORE INTO attachments (repo_id, source_id) VALUES (?, ?)").run(repoId, source.source_id);
}
