import type { Store } from "../core/store/store.js";
import { FilesystemSource } from "./filesystem-source.js";
import { attachSource, type AttachResult } from "./driver.js";

// Full-featured filesystem attach (sync/). Routes every file through the
// reconciling resolver so identity threads AND edges are extracted on the
// initial walk. As of 13-sync-plugins this is a thin wrapper over the
// source-agnostic attachSource driver with a FilesystemSource; core/attach stays
// the resolver-less primitive.

export type { AttachResult };

/** Attach a filesystem directory as a repo: create it + ingest all Markdown. */
export function attachRepo(store: Store, slug: string, rootPath: string): AttachResult {
  return attachSource(store, slug, rootPath, new FilesystemSource(rootPath));
}
