// A fresh alchemy workspace per task run, built exactly as the CLI spec runner
// builds its `alchemy` template (packages/cli/corpus/cli/fixture.ts): the corpus
// copied to <ws>/vault, `omg init --yes --no-embedder`, `omg source add vault
// --repo fixture -y`, all under the two conformance seams so ids and timestamps
// are deterministic (d_0 is /index.md, b_153 the "Tasks" heading of
// calcination, …) and a task can name ids in its checks and solution.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..");
export const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
/** The corpus every task runs on. */
export const ALCHEMY_DIR = join(REPO_ROOT, "packages", "core", "corpus", "oqx", "fixtures", "alchemy");
/** The built reference CLI (`pnpm build` at the repo root); `OMG` overrides. */
export const OMG = process.env.OMG ?? join(REPO_ROOT, "packages", "cli", "dist", "src", "main.js");
export const REPO_SLUG = "fixture";
export const SPEC_CLOCK = "2026-09-27T00:00:00.000Z";

export interface Workspace {
  /** the workspace directory (`omg mcp -C <dir>`) */
  dir: string;
  /** the repo's source directory: <dir>/vault */
  vault: string;
  /** the environment every omg process of this workspace runs under */
  env: NodeJS.ProcessEnv;
  /** absolute path of a repo-relative document path (either form) */
  file(path: string): string;
  cleanup(): void;
}

/** The seams + a HOME/TMPDIR inside the workspace, like the spec runners. */
export function workspaceEnv(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NO_COLOR: "1",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    OMGBASE_SPEC_MINTER: "sequential",
    OMGBASE_SPEC_CLOCK: SPEC_CLOCK,
  };
}

function omg(dir: string, env: NodeJS.ProcessEnv, argv: string[]): string {
  const r = spawnSync(process.execPath, [OMG, "--no-color", ...argv], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
  if (r.error) throw new Error(`spawn omg ${argv.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`omg ${argv.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** What the one-shot sweep found (`omg sync --json`; spec/sync §4.3): paths in the `/`-rooted reference form. */
export interface SweepResult {
  scanned: number;
  ingested: string[];
  deleted: string[];
  conflicted: string[];
  changed: boolean;
}

/**
 * Make the store observe what the disk holds: `omg sync`, the explicit form of the
 * freshness sweep (spec/sync §4.3) — a file not in the stat cache or whose
 * `(mtime, size)` moved is re-hashed and, when its bytes changed, ingested as an
 * observed commit (a new file included); a cached path that is gone is tombstoned
 * (so a move is a deletion plus an insertion). `omg mcp --no-watch` runs no priming
 * sweep of its own, which is why the `fs` profile calls this before spawning the
 * server its checks run through.
 */
export function syncWorkspace(ws: Workspace): SweepResult {
  const out = omg(ws.dir, ws.env, ["--json", "sync"]);
  const r = JSON.parse(out) as SweepResult;
  return { scanned: r.scanned, ingested: r.ingested, deleted: r.deleted, conflicted: r.conflicted, changed: r.changed };
}

/** Build a fresh workspace under the OS temp dir (or `root`). ~1–2 s (two cold omg starts). */
export function createWorkspace(root?: string): Workspace {
  if (!existsSync(OMG)) throw new Error(`the built CLI is missing at ${OMG} — run \`pnpm build\` at the repository root first`);
  if (!existsSync(ALCHEMY_DIR)) throw new Error(`the alchemy corpus is missing at ${ALCHEMY_DIR}`);
  // realpath: macOS's tmpdir is a symlink and omg reports the resolved spelling.
  const base = root ?? realpathSync(tmpdir());
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "agent-bench-"));
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "tmp"));
  const vault = join(dir, "vault");
  cpSync(ALCHEMY_DIR, vault, { recursive: true });
  const env = workspaceEnv(dir);
  omg(dir, env, ["init", "--yes", "--no-embedder"]);
  omg(dir, env, ["source", "add", "vault", "--repo", REPO_SLUG, "-y"]);
  return {
    dir,
    vault,
    env,
    file: (path) => join(vault, path.replace(/^\/+/, "")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The pristine bytes of a corpus document (either path form). */
export function fixtureBytes(path: string): string {
  return readFileSync(join(ALCHEMY_DIR, path.replace(/^\/+/, "")), "utf8");
}
