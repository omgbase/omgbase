import {
  createExternalSource,
  ensureAdapter,
  listAdapters,
  sourcesForRepo,
  renderConfigFlags,
  type SyncSource,
  type SourceRow,
  type Store,
  type RepoRow,
} from "@omgbase/core";
import { fsAdapterLaunch } from "@omgbase/fs-adapter";

// Resolve a repo's live sync source for `omg watch`/`omg mcp`/`omg sync`
// (sync-plugins, ADR-014 Stage 3). Resolution now prefers the source REGISTRY
// (adapters/sources/attachments tables): a repo's attached filesystem source is
// spawned from its `sources.config`. When a repo has no registered source we
// fall back to synthesizing the fs source from its `root_path` — the pre-registry
// behavior — so existing single-fs repos keep working unchanged until `attach`
// starts populating the registry (Stage 5) and `root_path` is retired (Stage 6).

/** The built-in filesystem adapter's registry name. */
export const FS_ADAPTER = "fs";

/** Seed the built-in `fs` adapter row (idempotent). Required before creating an
 *  fs source (the `sources.adapter` FK is enforced). The stored command is
 *  registry data only (spec/sync §2, §5): the host never runs it for `fs` — see
 *  spawnSource — so a source is never pinned to a stale path. */
export function ensureFsAdapter(store: Store): void {
  ensureAdapter(store, FS_ADAPTER, "omgbase-fs-adapter", []);
}

/** Spawn one registered source as a live SyncSource. The built-in `fs` adapter
 *  is launched per spec/sync §5 (1.2): `$OMGBASE_FS_ADAPTER` whitespace-split
 *  when set and non-empty, else the bundled `@omgbase/fs-adapter` bin under the
 *  running `node`; then the row's fixed `args`, then the rendered config flags
 *  (`fsAdapterLaunch`). Other adapters would spawn their stored command. */
function spawnSource(store: Store, source: SourceRow): Promise<SyncSource> {
  const flags = renderConfigFlags(source.config);
  if (source.adapter === FS_ADAPTER) {
    const row = listAdapters(store).find((a) => a.name === FS_ADAPTER);
    const launch = fsAdapterLaunch(row?.args ?? [], flags);
    return createExternalSource({ ...launch, ...(hasEnv(source) ? { env: source.env } : {}) });
  }
  // Custom adapter: spawn its stored command (looked up by the caller).
  throw new Error(`no launcher for adapter '${source.adapter}' (only the built-in '${FS_ADAPTER}' is wired)`);
}

function hasEnv(source: SourceRow): boolean {
  return Object.keys(source.env).length > 0;
}

/**
 * Build the live filesystem SyncSource for a repo from its attached `fs` source
 * (ADR-014), or null if it has none (a sourceless/headless repo).
 */
export async function openRepoSource(store: Store, repo: RepoRow): Promise<SyncSource | null> {
  const fsSource = sourcesForRepo(store, repo.repoId).find((s) => s.adapter === FS_ADAPTER);
  if (!fsSource) return null;
  const root = fsSource.config.root;
  if (typeof root !== "string" || root === "") return null;
  return spawnSource(store, fsSource);
}
