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
  rootPath: string;
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
    return (
      this.store.db.prepare("SELECT repo_id, slug, root_path FROM repos ORDER BY slug").all() as {
        repo_id: string;
        slug: string;
        root_path: string;
      }[]
    ).map((r) => ({ repoId: r.repo_id, slug: r.slug, rootPath: r.root_path }));
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
    const containing = repos.filter((r) => {
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
    // Several contain cwd (nested roots): pick the deepest (longest root_path).
    containing.sort((a, b) => resolve(b.rootPath).length - resolve(a.rootPath).length);
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
