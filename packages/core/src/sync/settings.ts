import type { Store } from "../core/store/store.js";
import { refreshSemanticManifest, refreshSemanticManifests, semanticProviderOf } from "../core/store/manifest.js";

// Settings scopes (config-scope). Config is ONE schema at TWO layers: the
// workspace_settings singleton is the default layer; a repo's repos.settings
// overrides it key-by-key at the leaf. Readers (embedding, gc, …) resolve the
// effective view via resolveSettings so a value set once at the workspace is
// inherited by every repo unless that repo overrides it. There is no separate
// "global config" namespace — top-level concepts are tables, not settings.

export type Settings = Record<string, unknown>;

function parse(json: string | undefined): Settings {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Settings) : {};
  } catch {
    return {};
  }
}

/** The workspace default settings blob (the layer repos inherit from). */
export function workspaceSettings(store: Store): Settings {
  const row = store.db.prepare("SELECT settings FROM workspace_settings WHERE id = 0").get() as
    | { settings: string }
    | undefined;
  return parse(row?.settings);
}

/** A single repo's own (override) settings blob — NOT merged with defaults. */
export function repoOwnSettings(store: Store, repoId: string): Settings {
  const row = store.db.prepare("SELECT settings FROM repos WHERE repo_id = ?").get(repoId) as
    | { settings: string }
    | undefined;
  return parse(row?.settings);
}

// A settings write that CHANGES a repository's effective `embedding.provider`
// re-derives its semantic manifest row (spec/store §3.1 `capabilities`, §5.10 —
// resolution 1: `enabled` iff a provider resolves): the workspace layer may
// touch every repository's row, a repo's own layer that repository's. A write
// that leaves the provider as it was moves the row's config (`model`/`dim`)
// and keeps its STATE — so `omg embed disable` (Phase 4b) is sticky across
// unrelated settings writes and `omg embed enable` is the way back; a provider
// set or unset still flips the row, the simple path `omg init --embedder` and
// `omg config set embedding.provider` rely on. In the same transaction.

export function writeWorkspaceSettings(store: Store, settings: Settings): void {
  store.write((db) => {
    const repos = (db.prepare("SELECT repo_id FROM repos ORDER BY rowid").all() as { repo_id: string }[]).map((r) => r.repo_id);
    const before = new Map(repos.map((id) => [id, semanticProviderOf(db, id)] as const));
    db.prepare("INSERT INTO workspace_settings (id, settings) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings").run(JSON.stringify(settings));
    const flipped = new Set(repos.filter((id) => semanticProviderOf(db, id) !== before.get(id)));
    refreshSemanticManifests(db, new Date().toISOString(), flipped);
  });
}

export function writeRepoSettings(store: Store, repoId: string, settings: Settings): void {
  store.write((db) => {
    const before = semanticProviderOf(db, repoId);
    db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run(JSON.stringify(settings), repoId);
    refreshSemanticManifest(db, repoId, new Date().toISOString(), { flip: semanticProviderOf(db, repoId) !== before });
  });
}

/** Deep-merge: `over` wins at the leaf; nested plain objects merge recursively,
 *  everything else (scalars, arrays) replaces wholesale. */
export function deepMerge(base: Settings, over: Settings): Settings {
  const out: Settings = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (isPlainObject(b) && isPlainObject(v)) out[k] = deepMerge(b, v);
    else out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Settings {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The effective settings a repo sees: workspace defaults with the repo's own
 * settings deep-merged on top. Every settings consumer should read through this
 * so the workspace-default/repo-override rule holds uniformly. Pass repoId=null
 * (e.g. a sourceless workspace-scoped read) to get the defaults alone.
 */
export function resolveSettings(store: Store, repoId: string | null): Settings {
  const defaults = workspaceSettings(store);
  if (!repoId) return defaults;
  return deepMerge(defaults, repoOwnSettings(store, repoId));
}
