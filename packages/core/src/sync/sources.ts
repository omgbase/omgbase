import type { Store } from "../core/store/store.js";
import { mintId } from "../core/ids.js";

// Source registry (sync-plugins §2, ADR-014 §3). CRUD over the reserved v9
// tables that separate *what a repo is* (identity/history in the DB) from *where
// its bytes come from*: adapters (name → external command), sources (a named
// {adapter, config, env}), attachments (repo ⇄ source, m:n). These were inert
// until now; wiring them is the step that lets a repo own zero, one, or several
// external sources instead of the single synthesized-from-root_path fs source.
//
// The engine only records membership + transports config here; it never spawns
// (that is the CLI/service, which owns the adapter binaries) and never mints
// block identity through this path (ADR-003 stays intact).

export interface AdapterRow {
  name: string;
  command: string;
  args: string[];
}

export interface SourceRow {
  sourceId: string;
  name: string;
  adapter: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
}

/** Register (or update) a named adapter → external command. Idempotent. */
export function ensureAdapter(store: Store, name: string, command: string, args: string[] = []): void {
  store.db
    .prepare(
      `INSERT INTO adapters (name, command, args) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET command = excluded.command, args = excluded.args`,
    )
    .run(name, command, JSON.stringify(args));
}

export function listAdapters(store: Store): AdapterRow[] {
  return (store.db.prepare("SELECT name, command, args FROM adapters ORDER BY name").all() as { name: string; command: string; args: string }[]).map(
    (r) => ({ name: r.name, command: r.command, args: JSON.parse(r.args) as string[] }),
  );
}

/** Create a named source over an adapter. Throws if `name` is taken or the
 *  adapter does not exist (FK enforced). Returns the minted source id. */
export function createSource(
  store: Store,
  spec: { name: string; adapter: string; config?: Record<string, unknown>; env?: Record<string, string> },
): string {
  const sourceId = mintId("src");
  store.db
    .prepare("INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?, ?, ?, ?, ?)")
    .run(sourceId, spec.name, spec.adapter, JSON.stringify(spec.config ?? {}), JSON.stringify(spec.env ?? {}));
  return sourceId;
}

export function deleteSource(store: Store, sourceId: string): void {
  store.db.prepare("DELETE FROM attachments WHERE source_id = ?").run(sourceId);
  store.db.prepare("DELETE FROM sync_state WHERE source_id = ?").run(sourceId);
  store.db.prepare("DELETE FROM sources WHERE source_id = ?").run(sourceId);
}

function rowToSource(r: { source_id: string; name: string; adapter: string; config: string; env: string }): SourceRow {
  return {
    sourceId: r.source_id,
    name: r.name,
    adapter: r.adapter,
    config: JSON.parse(r.config) as Record<string, unknown>,
    env: JSON.parse(r.env) as Record<string, string>,
  };
}

export function listSources(store: Store): SourceRow[] {
  return (store.db.prepare("SELECT source_id, name, adapter, config, env FROM sources ORDER BY name").all() as Parameters<typeof rowToSource>[0][]).map(rowToSource);
}

export function getSourceByName(store: Store, name: string): SourceRow | null {
  const r = store.db.prepare("SELECT source_id, name, adapter, config, env FROM sources WHERE name = ?").get(name) as Parameters<typeof rowToSource>[0] | undefined;
  return r ? rowToSource(r) : null;
}

/** Attach a source to a repo (m:n). Idempotent. */
export function attachSourceToRepo(store: Store, repoId: string, sourceId: string): void {
  store.db.prepare("INSERT OR IGNORE INTO attachments (repo_id, source_id) VALUES (?, ?)").run(repoId, sourceId);
}

export function detachSourceFromRepo(store: Store, repoId: string, sourceId: string): void {
  store.db.prepare("DELETE FROM attachments WHERE repo_id = ? AND source_id = ?").run(repoId, sourceId);
}

/** The sources attached to a repo (ordered by source name). */
export function sourcesForRepo(store: Store, repoId: string): SourceRow[] {
  return (
    store.db
      .prepare(
        `SELECT s.source_id, s.name, s.adapter, s.config, s.env
         FROM sources s JOIN attachments a ON a.source_id = s.source_id
         WHERE a.repo_id = ? ORDER BY s.name`,
      )
      .all(repoId) as Parameters<typeof rowToSource>[0][]
  ).map(rowToSource);
}

/** Render a source's structured config into adapter argv flags: each own key
 *  becomes `--key value` (booleans render as a bare `--key` when true, omitted
 *  when false). The declarative config→argv mapping reserved in sync-plugins
 *  §3.1; the fs adapter consumes `{ root }` → `--root <root>`. */
export function renderConfigFlags(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      if (value) out.push(`--${key}`);
      continue;
    }
    out.push(`--${key}`, String(value));
  }
  return out;
}
