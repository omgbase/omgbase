import type { Database } from "better-sqlite3";
import type { Store } from "./store.js";

// The store's own read of the settings layers (spec/sync §3: the workspace
// layer with the repo's own deep-merged over it at the leaf). Inlined here
// rather than imported from `sync/settings.ts` — `core/` does not import its
// siblings — and shared by the core's readers of a policy (the claims prune,
// the feed retention) and the recorder's (`retention.ts`, which re-exports
// these two for its existing importers).

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A settings blob as stored (`workspace_settings.settings`, `repos.settings`): an object, or `{}` for anything else. */
export function parseSettingsJson(json: string | undefined | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

/** The repo's effective settings: the workspace layer with the repo's own deep-merged over it at the leaf. */
export function effectiveSettings(store: Store, repoId: string): Record<string, unknown> {
  return effectiveSettingsOf(store.db, repoId);
}

/** `effectiveSettings` over the bare connection (the writers hold only `db`). */
export function effectiveSettingsOf(db: Database, repoId: string): Record<string, unknown> {
  const ws = parseSettingsJson((db.prepare("SELECT settings FROM workspace_settings WHERE id = 0").get() as { settings: string } | undefined)?.settings);
  const own = parseSettingsJson((db.prepare("SELECT settings FROM repos WHERE repo_id = ?").get(repoId) as { settings: string } | undefined)?.settings);
  const merge = (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      const b = out[k];
      out[k] = isRecord(b) && isRecord(v) ? merge(b, v) : v;
    }
    return out;
  };
  return merge(ws, own);
}
