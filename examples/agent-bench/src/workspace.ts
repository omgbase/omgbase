// A fresh workspace per task run, built exactly as the CLI spec runner builds its
// `alchemy` template (packages/cli/corpus/cli/fixture.ts): the corpus copied to
// <ws>/vault, `omg init --yes --no-embedder` (or `--embedder <cmd|url>` when the
// bench runs with one), `omg source add vault --repo fixture -y`, all under the two
// conformance seams so ids and timestamps are deterministic (d_0 is /index.md,
// b_153 the "Tasks" heading of calcination, …) and a task can name ids in its
// checks and solution. Two corpora: `alchemy` (the shared OQX fixture, 20 files)
// and `timeline` (this package's generated snapshot, corpora/timeline, 348 files —
// src/corpus.ts).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TIMELINE_DIR, diffTrees, readTree } from "./corpus.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..");
export const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
/** The shared OQX fixture corpus (read-only: hundreds of spec fixtures pin it). */
export const ALCHEMY_DIR = join(REPO_ROOT, "packages", "core", "corpus", "oqx", "fixtures", "alchemy");
export interface CorpusSpec {
  dir: string;
  /**
   * run under `OMGBASE_SPEC_MINTER=sequential`, so ids are deterministic (`d_0`,
   * `b_153`) and a task may name them. The sequential minter starts a fresh issued
   * set in every process and gives up after 1000 in-use candidates
   * (packages/core/src/core/ids.ts), so it only works for a corpus with fewer than
   * ~1000 blocks: alchemy (~300) yes; timeline (~5000) no — a second process (the
   * MCP server's first write, `omg sync`) could mint nothing. Timeline tasks name
   * paths, never ids, so it runs under the production minter.
   */
  sequentialIds: boolean;
}

/** The corpora a task may name (`"corpus"` in tasks/*.json); the default is alchemy. */
export const CORPORA: Readonly<Record<string, CorpusSpec>> = {
  alchemy: { dir: ALCHEMY_DIR, sequentialIds: true },
  timeline: { dir: TIMELINE_DIR, sequentialIds: false },
};
export type CorpusName = keyof typeof CORPORA;
export const DEFAULT_CORPUS = "alchemy";
/** The built reference CLI (`pnpm build` at the repo root); `OMG` overrides. */
export const OMG = process.env.OMG ?? join(REPO_ROOT, "packages", "cli", "dist", "src", "main.js");
export const REPO_SLUG = "fixture";
export const SPEC_CLOCK = "2026-09-27T00:00:00.000Z";

export function corpusSpec(corpus: string = DEFAULT_CORPUS): CorpusSpec {
  const spec = CORPORA[corpus];
  if (spec === undefined) throw new Error(`unknown corpus "${corpus}" (have ${Object.keys(CORPORA).join(", ")})`);
  return spec;
}

export function corpusDir(corpus: string = DEFAULT_CORPUS): string {
  return corpusSpec(corpus).dir;
}

export interface Workspace {
  /** the workspace directory (`omg mcp -C <dir>`) */
  dir: string;
  /** the repo's source directory: <dir>/vault */
  vault: string;
  /** which corpus the vault is a copy of */
  corpus: string;
  /** the embedding provider `omg init` was given, when the bench runs with one */
  embedder?: string;
  /** the environment every omg process of this workspace runs under */
  env: NodeJS.ProcessEnv;
  /** absolute path of a repo-relative document path (either form) */
  file(path: string): string;
  cleanup(): void;
}

/** The seams + a HOME/TMPDIR inside the workspace, like the spec runners (the minter seam only where the corpus allows it — `CorpusSpec`). */
export function workspaceEnv(dir: string, sequentialIds = true): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NO_COLOR: "1",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    ...(sequentialIds ? { OMGBASE_SPEC_MINTER: "sequential" } : {}),
    OMGBASE_SPEC_CLOCK: SPEC_CLOCK,
  };
}

interface OmgOutput {
  stdout: string;
  stderr: string;
}

function omgRun(dir: string, env: NodeJS.ProcessEnv, argv: string[], timeout = 60_000): OmgOutput {
  const r = spawnSync(process.execPath, [OMG, "--no-color", ...argv], { cwd: dir, env, encoding: "utf8", timeout });
  if (r.error) throw new Error(`spawn omg ${argv.join(" ")}: ${r.error.message}${r.signal ? ` (signal ${r.signal})` : ""}`);
  if (r.status !== 0) throw new Error(`omg ${argv.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

function omg(dir: string, env: NodeJS.ProcessEnv, argv: string[], timeout = 60_000): string {
  return omgRun(dir, env, argv, timeout).stdout;
}

/** The head and the tail of a long output (a crash's first line says what; its last lines say where). */
function excerpt(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max / 2)} … ${t.slice(-max / 2)}` : t;
}

/**
 * The JSON an `omg --json <cmd>` printed: the LAST line of stdout that parses (a
 * warning or progress line before it is tolerated). Empty or unparsable output is an
 * error that carries the command and whatever stdout/stderr held — the way the
 * embedding provider's crash surfaced as a bare `Unexpected end of JSON input`
 * (`omg embed status` exits 0 with nothing on stdout when the provider cannot start).
 */
export function parseOmgJson<T>(out: OmgOutput, command: string): T {
  const lines = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!/^[[{]/.test(line)) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      // not this line
    }
  }
  const why = lines.length === 0 ? "printed nothing on stdout" : `printed no JSON on stdout (${JSON.stringify(excerpt(out.stdout, 200))})`;
  throw new Error(`${command} ${why}${out.stderr.trim() ? `; stderr: ${JSON.stringify(excerpt(out.stderr))}` : ""}`);
}

function omgJson<T>(dir: string, env: NodeJS.ProcessEnv, argv: string[], timeout = 60_000): T {
  return parseOmgJson<T>(omgRun(dir, env, argv, timeout), `omg ${argv.join(" ")}`);
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
  const r = omgJson<SweepResult>(ws.dir, ws.env, ["--json", "sync"]);
  return { scanned: r.scanned, ingested: r.ingested, deleted: r.deleted, conflicted: r.conflicted, changed: r.changed };
}

/** `omg embed status --json`: the queue depth for the configured provider. */
export interface EmbedStatus {
  provider: string | null;
  model?: string;
  queued: number;
  docsQueued?: number;
}

export function embedStatus(ws: Workspace): EmbedStatus {
  const s = omgJson<Partial<EmbedStatus>>(ws.dir, ws.env, ["--json", "embed", "status"]);
  if (typeof s.queued !== "number") throw new Error(`omg --json embed status answered without a numeric \`queued\`: ${JSON.stringify(s)}`);
  return s as EmbedStatus;
}

/**
 * Embed everything now: `omg embed drain` (the provider is spawned, every queued
 * block and document embedded, the provider released), then wait until `omg embed
 * status` reports an empty queue — so a `semantic(…)` query has every vector it needs
 * before the agent's first turn. Throws, naming the provider command and what omg
 * printed, when the drain or the status fails or the queue does not drain.
 */
export function embedWorkspace(ws: Workspace, attempts = 5): EmbedStatus {
  if (!ws.embedder) throw new Error("embedWorkspace: the workspace was created without an embedder");
  try {
    omgJson(ws.dir, ws.env, ["--json", "embed", "drain"], 600_000);
    let status = embedStatus(ws);
    for (let i = 1; i < attempts && (status.queued > 0 || (status.docsQueued ?? 0) > 0); i++) {
      omgJson(ws.dir, ws.env, ["--json", "embed", "drain"], 600_000);
      status = embedStatus(ws);
    }
    if (status.queued > 0 || (status.docsQueued ?? 0) > 0) throw new Error(`the embedding queue did not drain: ${JSON.stringify(status)}`);
    return status;
  } catch (e) {
    throw new Error(`embedding the workspace with provider ${JSON.stringify(ws.embedder)} failed — ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/**
 * The `--embedder` value as `omg init` should store it. omg spawns the provider
 * with the WORKSPACE as its working directory, so a command naming a file by a
 * path relative to the shell (`node packages/embedder/dist/src/bin.js`) cannot be
 * found there — that was the bench's `Unexpected end of JSON input`. Every
 * whitespace-separated token that is a relative path to an existing file is made
 * absolute against `cwd`; a URL, an absolute path and a bare command on PATH
 * (`omgbase-embedder`) pass through unchanged.
 */
export function resolveEmbedder(embedder: string, cwd = process.cwd()): string {
  if (/^https?:\/\//i.test(embedder)) return embedder;
  const resolved = embedder
    .split(/(\s+)/)
    .map((tok) => (/\S/.test(tok) && !isAbsolute(tok) && /[/\\]|\.[cm]?js$/.test(tok) && existsSync(resolve(cwd, tok)) ? resolve(cwd, tok) : tok))
    .join("");
  // A bare JavaScript file as the command (`--embedder packages/embedder/dist/src/bin.js`)
  // is run through node: omg spawns the provider directly, and a built `bin.js` has a
  // shebang but not always the executable bit (the 2026-10-21 run's `spawn … EACCES`).
  const first = resolved.trim().split(/\s+/)[0] ?? "";
  return /\.[cm]?js$/i.test(first) ? `node ${resolved.trim()}` : resolved;
}

export interface WorkspaceOptions {
  /** which corpus to copy into the vault (default alchemy) */
  corpus?: string;
  /** `omg init --embedder <cmd|url>` instead of `--no-embedder` (the bench's `--embedder`) */
  embedder?: string;
  /** where to make the temp directory (default the OS temp dir) */
  root?: string;
}

/** Build a fresh workspace under the OS temp dir (or `root`). ~1–2 s for alchemy, a few seconds for timeline (two cold omg starts + the ingest). */
export function createWorkspace(opts: WorkspaceOptions = {}): Workspace {
  const corpus = opts.corpus ?? DEFAULT_CORPUS;
  const spec = corpusSpec(corpus);
  const source = spec.dir;
  if (!existsSync(OMG)) throw new Error(`the built CLI is missing at ${OMG} — run \`pnpm build\` at the repository root first`);
  if (!existsSync(source)) throw new Error(`the ${corpus} corpus is missing at ${source}${corpus === "timeline" ? " — run `pnpm --filter agent-bench corpus`" : ""}`);
  // realpath: macOS's tmpdir is a symlink and omg reports the resolved spelling.
  const base = opts.root ?? realpathSync(tmpdir());
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "agent-bench-"));
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "tmp"));
  const vault = join(dir, "vault");
  cpSync(source, vault, { recursive: true });
  const env = workspaceEnv(dir, spec.sequentialIds);
  omg(dir, env, ["init", "--yes", ...(opts.embedder ? ["--embedder", opts.embedder] : ["--no-embedder"])]);
  omg(dir, env, ["source", "add", "vault", "--repo", REPO_SLUG, "-y"], 180_000);
  return {
    dir,
    vault,
    corpus,
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    env,
    file: (path) => join(vault, path.replace(/^\/+/, "")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The pristine bytes of a corpus document (either path form). */
export function fixtureBytes(path: string, corpus: string = DEFAULT_CORPUS): string {
  return readFileSync(join(corpusDir(corpus), path.replace(/^\/+/, "")), "utf8");
}

/** The paths whose bytes differ between the workspace's vault and its pristine corpus (added, removed or edited files). Empty = untouched. */
export function vaultDiff(ws: Workspace): string[] {
  return diffTrees(readTree(corpusDir(ws.corpus)), readTree(ws.vault));
}
