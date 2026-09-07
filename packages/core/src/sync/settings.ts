import type { Store } from "../core/store/store.js";

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

export function writeWorkspaceSettings(store: Store, settings: Settings): void {
  store.db
    .prepare("INSERT INTO workspace_settings (id, settings) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings")
    .run(JSON.stringify(settings));
}

export function writeRepoSettings(store: Store, repoId: string, settings: Settings): void {
  store.db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run(JSON.stringify(settings), repoId);
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
