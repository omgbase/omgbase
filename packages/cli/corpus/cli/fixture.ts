// The CLI spec fixture contract (spec/cli/README.md §8) and the machinery the
// reference runner uses to execute it:
//
//   validateFixtureFile()   the shape every suite under spec/cli/cases must have
//   Workspaces              the per-run `alchemy` / `empty` templates and the
//                           fixed <tmp> a case runs in
//   runCase()               one case (or one `steps` sequence) against the built
//                           `omg` binary under the seams, outcomes rewritten with
//                           `<workspace>`
//   describeChange()        the `+`/`~`/`-` regeneration report the runners print
//
// Nothing here decides anything about the CLI: it spawns the built binary the
// way a user would (argv, cwd, stdin, environment) and records what came back.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace, rebuildFileStats } from "@omgbase/core";

// packages/cli/corpus/cli → repo root is four levels up.
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const SPEC_DIR = join(REPO_ROOT, "spec", "cli");
export const CASES_DIR = join(SPEC_DIR, "cases");
export const ALCHEMY_DIR = join(REPO_ROOT, "packages", "core", "corpus", "oqx", "fixtures", "alchemy");
export const BIN = join(REPO_ROOT, "packages", "cli", "dist", "src", "main.js");

/** §8: the clock every case runs under (the `ts` of every commit a verb stamps). */
export const SPEC_CLOCK = "2026-09-27T00:00:00.000Z";
/** §8: the slug the alchemy workspace's repo carries. */
export const FIXTURE_REPO_SLUG = "fixture";
/** §8: the placeholder for the temporary directory in argv/env/stdin/files and in outputs. */
export const WORKSPACE_TOKEN = "<workspace>";

/** A wedged child must fail loudly, not hang the worker (see test/spawn.ts). */
const SPAWN_TIMEOUT_MS = 60_000;

// ---- the contract ----------------------------------------------------------------

export type WorkspaceKind = "alchemy" | "none" | "empty";

export interface Expect {
  exit: number;
  stdout: string;
  /** exact when pinned (a non-zero exit, or `pin_stderr`); absent otherwise */
  stderr?: string;
}

export interface StepInput {
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** files written under <tmp> before the step (`null` deletes); `*.sh` are made executable */
  files?: Record<string, string | null>;
  pin_stderr?: boolean;
  notes?: string;
  /** recorded by the reference; absent only before the first generation */
  expect?: Expect;
}

export interface CaseBase {
  name: string;
  notes?: string;
  workspace: WorkspaceKind;
  env?: Record<string, string>;
  files?: Record<string, string | null>;
}

/** A single invocation. */
export type SingleCase = CaseBase & StepInput;

/** A sequence on one workspace: every step's expectation is recorded. */
export interface SequenceCase extends CaseBase {
  steps: StepInput[];
}

export type FixtureCase = SingleCase | SequenceCase;

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export function isSequence(c: FixtureCase | Record<string, unknown>): c is SequenceCase {
  return Array.isArray((c as { steps?: unknown }).steps);
}

const CASE_KEYS = new Set(["name", "notes", "workspace", "env", "files", "stdin", "argv", "pin_stderr", "expect", "steps"]);
const STEP_KEYS = new Set(["argv", "stdin", "env", "files", "pin_stderr", "notes", "expect"]);
const EXPECT_KEYS = new Set(["exit", "stdout", "stderr"]);

interface ValidateOptions {
  requireExpect?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkStrings(v: unknown, at: string, problems: string[]): void {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) problems.push(`${at}: argv must be an array of strings`);
}

function checkEnv(v: unknown, at: string, problems: string[]): void {
  if (v === undefined) return;
  if (!isRecord(v) || Object.values(v).some((x) => typeof x !== "string")) problems.push(`${at}: env must be a string → string record`);
}

function checkFiles(v: unknown, at: string, problems: string[]): void {
  if (v === undefined) return;
  if (!isRecord(v) || Object.values(v).some((x) => typeof x !== "string" && x !== null)) problems.push(`${at}: files must be a path → (string | null) record`);
  else if (Object.keys(v).some((p) => p.startsWith("/") || p.split("/").includes(".."))) problems.push(`${at}: files paths must be relative to <tmp>`);
}

function checkExpect(v: unknown, at: string, problems: string[], required: boolean): void {
  if (v === undefined) {
    if (required) problems.push(`${at}: missing \`expect\` (run CLI_SPEC_UPDATE=1)`);
    return;
  }
  if (!isRecord(v)) return void problems.push(`${at}: expect must be an object`);
  for (const k of Object.keys(v)) if (!EXPECT_KEYS.has(k)) problems.push(`${at}: unknown expect key \`${k}\``);
  if (typeof v.exit !== "number") problems.push(`${at}: expect.exit must be a number`);
  if (typeof v.stdout !== "string") problems.push(`${at}: expect.stdout must be a string`);
  if (v.stderr !== undefined && typeof v.stderr !== "string") problems.push(`${at}: expect.stderr must be a string when present`);
}

function checkStep(v: unknown, at: string, problems: string[], required: boolean): void {
  if (!isRecord(v)) return void problems.push(`${at}: a step must be an object`);
  for (const k of Object.keys(v)) if (!STEP_KEYS.has(k)) problems.push(`${at}: unknown step key \`${k}\``);
  checkStrings(v.argv, at, problems);
  if (v.stdin !== undefined && typeof v.stdin !== "string") problems.push(`${at}: stdin must be a string`);
  checkEnv(v.env, at, problems);
  checkFiles(v.files, at, problems);
  if (v.pin_stderr !== undefined && typeof v.pin_stderr !== "boolean") problems.push(`${at}: pin_stderr must be a boolean`);
  checkExpect(v.expect, at, problems, required);
}

/** Every shape problem in a suite file (empty = well-formed). */
export function validateFixtureFile(file: string, doc: unknown, opts: ValidateOptions = {}): string[] {
  const problems: string[] = [];
  const required = opts.requireExpect ?? true;
  if (!isRecord(doc)) return [`${file}: not an object`];
  if (typeof doc.suite !== "string") problems.push(`${file}: missing \`suite\``);
  if (!Array.isArray(doc.cases)) return [...problems, `${file}: missing \`cases\``];
  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}[${i}]`;
    if (!isRecord(c)) return void problems.push(`${at}: a case must be an object`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name \`${c.name}\``);
    else seen.add(c.name);
    for (const k of Object.keys(c)) if (!CASE_KEYS.has(k)) problems.push(`${at}: unknown key \`${k}\``);
    if (c.workspace !== "alchemy" && c.workspace !== "none" && c.workspace !== "empty") problems.push(`${at}: workspace must be alchemy | none | empty`);
    checkEnv(c.env, at, problems);
    checkFiles(c.files, at, problems);
    if (isSequence(c)) {
      for (const k of ["argv", "stdin", "pin_stderr", "expect"]) if (k in c) problems.push(`${at}: a sequence case carries \`${k}\` on its steps, not itself`);
      if (c.steps.length === 0) problems.push(`${at}: steps must not be empty`);
      c.steps.forEach((s: unknown, j: number) => checkStep(s, `${at}.steps[${j}]`, problems, required));
    } else {
      checkStep({ argv: c.argv, stdin: c.stdin, env: undefined, files: undefined, pin_stderr: c.pin_stderr, expect: c.expect }, at, problems, required);
    }
  });
  return problems;
}

// ---- the corpus -------------------------------------------------------------------

/** bytewise (UTF-16 code unit) order, as the surface fixtures sort paths */
export function cmpBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every `*.md` under `dir` as `{ "<relative posix path>": "<source>" }`, keys sorted. */
export function readCorpusFromDisk(dir = ALCHEMY_DIR): Record<string, string> {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) files.push(full);
    }
  };
  walk(dir);
  const out: Record<string, string> = {};
  const rel = files.map((f) => [relative(dir, f).split(sep).join("/"), f] as const).sort((a, b) => cmpBytes(a[0], b[0]));
  for (const [path, full] of rel) out[path] = readFileSync(full, "utf8");
  return out;
}

// ---- spawning ---------------------------------------------------------------------

export interface Outcome {
  exit: number;
  stdout: string;
  stderr: string;
}

/** §8: the environment every case runs under, before the case's own `env`. */
export function baseEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // A minimal, explicit environment: PATH (for `/bin/sh` editors and `which`), the
  // seams, no color, a HOME that never prefixes <tmp> (so `~` shortening cannot
  // fire), and none of the editor/prompt variables a case may set itself.
  env.PATH = process.env.PATH;
  env.NO_COLOR = "1";
  env.HOME = join(tmp, "home");
  env.TMPDIR = join(tmp, "tmp");
  env.OMGBASE_SPEC_MINTER = "sequential";
  env.OMGBASE_SPEC_CLOCK = SPEC_CLOCK;
  return env;
}

/** Replace the placeholder with the run's real path in an input string. */
export function substituteWorkspace(s: string, tmp: string): string {
  return s.split(WORKSPACE_TOKEN).join(tmp);
}

/** §8: every occurrence of <tmp> in an output becomes `<workspace>`. */
export function rewriteWorkspace(s: string, tmp: string): string {
  return s.split(tmp).join(WORKSPACE_TOKEN).split(cliVersion()).join(VERSION_TOKEN);
}

/** §8: the binary's own version string becomes `<version>` (the two binaries are versioned apart). */
export const VERSION_TOKEN = "<version>";
let cachedVersion: string | null = null;
function cliVersion(): string {
  if (cachedVersion === null) {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}

// ---- §8: the `version` verb's outputs are recorded by shape --------------------------
//
// `omg version` prints release-specific values (the engine, its versions, the
// runtime, the build), so the fixture pins the SHAPE: every leaf becomes its type
// name — `<string>`, `<number>`, `<null>`, `<boolean>`. Both binaries' runners apply
// the same rule (spec/cli §6 `version`, spec/surface §6):
//
//   JSON (`--json`): objects keep their keys with values normalized recursively,
//   arrays keep their length; the two engine-specific parts are the exceptions —
//   `components` (keyed by the engine's own packages) is recorded as `"<object>"`
//   and the optional `mcp.sdk` (present only when an SDK is used) is dropped —
//   and `commit`/`built`, null or not by BUILD ENVIRONMENT (a git checkout or
//   not), are one token either way: `"<string|null>"`.
//
//   Human: each `key  value` line keeps its key cell and its spacing; the value
//   cell becomes the type name of the tool's leaf, decided by the KEY (a type
//   read off the text would misfire on an all-digit commit sha): `<null>` when
//   it prints `—`, `<string|null>` for `commit`/`built`, `<number>` for `schema`,
//   else `<string>`; the indented `components` lines (`  <name>  <version>`)
//   collapse into one line `  <object>`.
//
// Applied only to a successful `version` invocation (exit 0, not its help card).

/** Does this argv invoke the `version` verb (not `--version`, not its card)? Returns the output mode or null. */
export function versionVerbMode(argv: string[]): "human" | "json" | null {
  const takesValue = new Set(["-C", "--directory", "--repo", "--server", "-H", "--header"]);
  let command: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (takesValue.has(a)) { i++; continue; }
    if (a === "--help" || a === "-h") return null;
    if (a === "--json" || a === "--jsonl" || a === "--ids") { json = true; continue; }
    if (a.startsWith("-")) continue;
    if (command === null) command = a;
  }
  if (command !== "version") return null;
  return json ? "json" : "human";
}

/** JSON: leaves → type names; keys kept; `components` → `"<object>"`; `mcp.sdk` dropped. */
export function typeShape(v: unknown, path: string[] = []): unknown {
  if (v === null) return "<null>";
  if (Array.isArray(v)) return v.map((x, i) => typeShape(x, [...path, String(i)]));
  if (typeof v === "object") {
    if (path.length === 1 && path[0] === "components") return "<object>";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (path.length === 1 && path[0] === "mcp" && k === "sdk") continue;
      // `commit`/`built` are null or not by BUILD ENVIRONMENT (a git checkout or
      // not), which no fixture can pin: one token for either.
      out[k] = path.length === 0 && (k === "commit" || k === "built") ? "<string|null>" : typeShape(x, [...path, k]);
    }
    return out;
  }
  return `<${typeof v}>`;
}

const HUMAN_LINE = /^(\S+)(\s{2,})(.*)$/;

/** Human: value cells → the leaf's type name, by key; the indented component lines → one `  <object>` line. */
export function typeShapeHuman(stdout: string): string {
  const out: string[] = [];
  let inComponents = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("  ")) {
      if (!inComponents) out.push("  <object>");
      inComponents = true;
      continue;
    }
    inComponents = false;
    const m = HUMAN_LINE.exec(line);
    if (!m) { out.push(line); continue; }
    const [, key, gap, value] = m as unknown as [string, string, string, string];
    const cell = key === "commit" || key === "built" ? "<string|null>" : value === "\u2014" ? "<null>" : key === "schema" ? "<number>" : "<string>";
    out.push(key + gap + cell);
  }
  return out.join("\n");
}

/** The §8 rewrite of a successful `version` step's stdout; anything else is returned as is. */
export function normalizeVersionOutput(argv: string[], o: Outcome): Outcome {
  if (o.exit !== 0) return o;
  const mode = versionVerbMode(argv);
  if (mode === null) return o;
  if (mode === "json") {
    const lines = o.stdout.split("\n");
    const doc = lines.map((l) => (l === "" ? l : JSON.stringify(typeShape(JSON.parse(l))))).join("\n");
    return { ...o, stdout: doc };
  }
  return { ...o, stdout: typeShapeHuman(o.stdout) };
}

export function spawnOmg(tmp: string, argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Outcome {
  const env = { ...baseEnv(tmp) };
  for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = substituteWorkspace(v, tmp);
  const args = [BIN, "--no-color", ...argv.map((a) => substituteWorkspace(a, tmp))];
  const r = spawnSync(process.execPath, args, {
    cwd: tmp,
    env,
    input: opts.stdin !== undefined ? substituteWorkspace(opts.stdin, tmp) : "",
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error) throw new Error(`spawn omg ${argv.join(" ")}: ${r.error.message}`);
  if (r.status === null) throw new Error(`omg ${argv.join(" ")} was killed (${r.signal ?? "timeout"})\n${r.stderr}`);
  return normalizeVersionOutput(argv, { exit: r.status, stdout: rewriteWorkspace(r.stdout, tmp), stderr: rewriteWorkspace(r.stderr, tmp) });
}

// ---- workspaces -------------------------------------------------------------------

function writeFiles(tmp: string, files: Record<string, string | null> | undefined): void {
  for (const [path, content] of Object.entries(files ?? {})) {
    const abs = join(tmp, path);
    if (content === null) {
      if (existsSync(abs)) unlinkSync(abs);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, substituteWorkspace(content, tmp));
    if (path.endsWith(".sh")) chmodSync(abs, 0o755);
  }
}

/** Re-record `file_stats` for every repo of the workspace at `tmp` (spec/sync §4.3; no id is minted). */
function rewarmStatCache(tmp: string): void {
  const ws = Workspace.open(tmp);
  try {
    for (const repo of ws.repos()) if (repo.rootPath) rebuildFileStats(ws.store, repo.repoId, repo.rootPath);
  } finally {
    ws.close();
  }
}

function emptyDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/**
 * The run's scratch area. Every case runs in ONE fixed directory `<tmp>` (so a
 * repo's registered root — an absolute path in `sources.config` — stays valid
 * across cases); the `alchemy` and `empty` workspaces are built once as
 * templates, by the reference's own verbs (§8: `init --yes --no-embedder`, then
 * for alchemy `source add vault --repo fixture -y`), and copied in per case. A
 * copy cannot keep nanosecond mtimes, so the freshness cache (`file_stats`) is
 * rebuilt after each copy — the library call mints nothing — leaving exactly the
 * state a fresh bootstrap leaves (the first sweep sees no candidates).
 */
export class Workspaces {
  readonly root: string;
  readonly tmp: string;
  private readonly templates = new Map<WorkspaceKind, string>();

  constructor() {
    // realpath: macOS's tmpdir is a symlink and the binary reports the resolved spelling.
    this.root = mkdtempSync(join(realpathSync(tmpdir()), "omgbase-cli-spec-"));
    this.tmp = join(this.root, "ws");
    mkdirSync(this.tmp);
  }

  private template(kind: WorkspaceKind): string | null {
    if (kind === "none") return null;
    const have = this.templates.get(kind);
    if (have) return have;
    // Build in place (at <tmp>, the path every case sees), then snapshot.
    emptyDir(this.tmp);
    mkdirSync(join(this.tmp, "home"));
    mkdirSync(join(this.tmp, "tmp"));
    const bootstrap = (argv: string[]): void => {
      const r = spawnOmg(this.tmp, argv);
      if (r.exit !== 0) throw new Error(`bootstrap \`omg ${argv.join(" ")}\` exited ${r.exit}\n${r.stderr}`);
    };
    if (kind === "alchemy") {
      const corpus = readCorpusFromDisk();
      for (const [path, content] of Object.entries(corpus)) {
        const abs = join(this.tmp, "vault", path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    bootstrap(["init", "--yes", "--no-embedder"]);
    if (kind === "alchemy") bootstrap(["source", "add", "vault", "--repo", FIXTURE_REPO_SLUG, "-y"]);
    const snapshot = join(this.root, `template-${kind}`);
    cpSync(this.tmp, snapshot, { recursive: true, preserveTimestamps: true });
    this.templates.set(kind, snapshot);
    return snapshot;
  }

  /** Reset <tmp> to a fresh workspace of `kind`. */
  prepare(kind: WorkspaceKind): string {
    const tpl = this.template(kind);
    emptyDir(this.tmp);
    if (tpl) {
      cpSync(tpl, this.tmp, { recursive: true, preserveTimestamps: true });
      if (kind === "alchemy") rewarmStatCache(this.tmp);
    } else {
      mkdirSync(join(this.tmp, "home"));
      mkdirSync(join(this.tmp, "tmp"));
    }
    return this.tmp;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

// ---- running a case -----------------------------------------------------------------

/** A case as loaded: `expect` may still be missing before the first generation. */
export type CaseInput = FixtureCase;

/** Record one step's outcome as an `Expect` (§8: stderr pinned on a non-zero exit or `pin_stderr`). */
function toExpect(o: Outcome, pin: boolean): Expect {
  return { exit: o.exit, stdout: o.stdout, ...(pin || o.exit !== 0 ? { stderr: o.stderr } : {}) };
}

export interface CaseRun {
  /** one per step (one for a single case) */
  expects: Expect[];
  /** the unpinned stderr of every step, for failure messages */
  stderr: string[];
}

export function runCase(ws: Workspaces, c: CaseInput): CaseRun {
  const tmp = ws.prepare(c.workspace);
  writeFiles(tmp, c.files);
  const steps: StepInput[] = isSequence(c) ? c.steps : [c];
  const expects: Expect[] = [];
  const stderr: string[] = [];
  for (const s of steps) {
    writeFiles(tmp, s.files);
    const env = { ...(c.env ?? {}), ...(s.env ?? {}) };
    const o = spawnOmg(tmp, s.argv, { ...(s.stdin !== undefined ? { stdin: s.stdin } : {}), env });
    expects.push(toExpect(o, Boolean(s.pin_stderr)));
    stderr.push(o.stderr);
  }
  return { expects, stderr };
}

/** The expectations a case carries, one per step (undefined when a step has none yet). */
export function expectsOf(c: CaseInput): (Expect | undefined)[] {
  return isSequence(c) ? c.steps.map((s) => s.expect) : [c.expect];
}

/** Write freshly recorded expectations back onto the case (keeping key order: an existing `expect` keeps its slot). */
export function assignExpects(c: CaseInput, expects: Expect[]): void {
  if (isSequence(c)) c.steps.forEach((s, i) => { s.expect = expects[i]!; });
  else c.expect = expects[0]!;
}

/** A human-readable first difference between two expectations, or null. */
export function diffExpect(actual: Expect, expect: Expect): string | null {
  if (actual.exit !== expect.exit) return `exit ${actual.exit}, expected ${expect.exit}`;
  if (actual.stdout !== expect.stdout) return `stdout differs:\n${firstDiff(actual.stdout, expect.stdout)}`;
  if (expect.stderr !== undefined && actual.stderr !== expect.stderr) return `stderr differs:\n${firstDiff(actual.stderr ?? "", expect.stderr)}`;
  return null;
}

function firstDiff(actual: string, expect: string): string {
  const a = actual.split("\n");
  const e = expect.split("\n");
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) return `  line ${i + 1}\n    actual:   ${JSON.stringify(a[i] ?? "<end>")}\n    expected: ${JSON.stringify(e[i] ?? "<end>")}`;
  }
  return "  (identical lines; whitespace at end?)";
}

/** The `+`/`~`/`-` report of a regeneration. */
export function describeChange(suite: string, before: { name: string }[], after: { name: string }[]): string[] {
  const lines: string[] = [];
  const old = new Map(before.map((c) => [c.name, c] as const));
  const seen = new Set<string>();
  for (const c of after) {
    seen.add(c.name);
    const prev = old.get(c.name);
    const had = prev && expectsOf(prev as CaseInput).every((e) => e !== undefined);
    if (!prev || !had) lines.push(`  + ${suite}::${c.name}`);
    else if (JSON.stringify(expectsOf(prev as CaseInput)) !== JSON.stringify(expectsOf(c as CaseInput))) lines.push(`  ~ ${suite}::${c.name}`);
  }
  for (const name of old.keys()) if (!seen.has(name)) lines.push(`  - ${suite}::${name}`);
  return lines;
}
