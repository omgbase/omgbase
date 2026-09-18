import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { Store } from "../core/store/store.js";

// Workspace discovery (11 §2.1). Like git: walk up from a start directory
// looking for .omgbase/. The directory containing it is the workspace; its
// database is <workspace>/.omgbase/omgbase.db (02 §2). Repo selection within a
// workspace: the repo whose root_path contains the cwd; when none or several
// match, the caller must disambiguate with --repo (candidates are listed).

export interface RepoRow {
  repoId: string;
  slug: string;
  /** The repo's filesystem root, DERIVED from its attached `fs` source's
   *  `config.root` (ADR-014; the `repos.root_path` column was removed in v13).
   *  null for a sourceless/headless repo (its `sync`/`watch` are no-ops). */
  rootPath: string | null;
}

/** Extract an fs source's root from its stored `config` JSON, or null. */
function fsRootFromConfig(config: string | null): string | null {
  if (!config) return null;
  try {
    const root = (JSON.parse(config) as { root?: unknown }).root;
    return typeof root === "string" && root !== "" ? root : null;
  } catch {
    return null;
  }
}

export class Workspace {
  readonly root: string;
  readonly omgbaseDir: string;
  readonly dbPath: string;
  readonly store: Store;

  private constructor(root: string) {
    this.root = root;
    this.omgbaseDir = join(root, ".omgbase");
    this.dbPath = join(this.omgbaseDir, "omgbase.db");
    this.store = new Store({ path: this.dbPath });
  }

  /** Find the workspace containing `startDir` (walk up); null if none. */
  static find(startDir: string = process.cwd()): Workspace | null {
    let dir = resolve(startDir);
    for (;;) {
      const candidate = join(dir, ".omgbase");
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return new Workspace(dir);
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /** Open the workspace rooted exactly at `root` (creating .omgbase/ + db). */
  static open(root: string): Workspace {
    return new Workspace(resolve(root));
  }

  repos(): RepoRow[] {
    // rootPath is derived from the repo's attached `fs` source (ADR-014). A repo
    // may have several attachments, so the LEFT JOIN can yield multiple rows per
    // repo; dedup by repo and take the first fs source's root.
    const rows = this.store.db
      .prepare(
        `SELECT r.repo_id AS repo_id, r.slug AS slug, s.config AS fs_config
         FROM repos r
         LEFT JOIN attachments a ON a.repo_id = r.repo_id
         LEFT JOIN sources s ON s.source_id = a.source_id AND s.adapter = 'fs'
         ORDER BY r.slug`,
      )
      .all() as { repo_id: string; slug: string; fs_config: string | null }[];
    const byId = new Map<string, RepoRow>();
    for (const r of rows) {
      const existing = byId.get(r.repo_id);
      if (existing) {
        if (!existing.rootPath) existing.rootPath = fsRootFromConfig(r.fs_config);
      } else {
        byId.set(r.repo_id, { repoId: r.repo_id, slug: r.slug, rootPath: fsRootFromConfig(r.fs_config) });
      }
    }
    return [...byId.values()];
  }

  repoBySlug(slug: string): RepoRow | null {
    return this.repos().find((r) => r.slug === slug) ?? null;
  }

  /**
   * Select the active repo. With an explicit slug, that repo (or throws
   * repo_not_found). Otherwise the repo whose root_path contains `cwd`; if none
   * or several match, throws AmbiguousRepo with the candidate slugs.
   */
  selectRepo(cwd: string, slug?: string): RepoRow {
    const repos = this.repos();
    if (slug) {
      const found = repos.find((r) => r.slug === slug);
      if (!found) {
        throw new RepoSelectionError("repo_not_found", `no repo with slug '${slug}'`, repos.map((r) => r.slug));
      }
      return found;
    }
    if (repos.length === 1) return repos[0]!;
    const here = resolve(cwd);
    // Only filesystem-backed repos (a derived rootPath) can contain the cwd; a
    // sourceless/headless repo has no location, so it never matches by cwd.
    const containing = repos.filter((r) => {
      if (r.rootPath == null) return false;
      const rel = relative(resolve(r.rootPath), here);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (containing.length === 1) return containing[0]!;
    if (containing.length === 0) {
      throw new RepoSelectionError(
        "repo_not_found",
        `no repo contains ${here}; select one with --repo`,
        repos.map((r) => r.slug),
      );
    }
    // Several contain cwd (nested roots): pick the deepest (longest root path).
    containing.sort((a, b) => resolve(b.rootPath!).length - resolve(a.rootPath!).length);
    return containing[0]!;
  }

  close(): void {
    this.store.close();
  }
}

export class RepoSelectionError extends Error {
  constructor(
    readonly code: "repo_not_found",
    message: string,
    readonly candidates: string[],
  ) {
    super(message);
    this.name = "RepoSelectionError";
  }
}
