import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// The git plumbing wrapper (spec/store §5.12, modular-core Phase 6a): every
// call spawns `git` with `GIT_DIR` set to the bare repository and an
// environment that reads NO user configuration — `GIT_CONFIG_NOSYSTEM=1`,
// `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, no `HOME` — so the
// bytes of every object are a function of the engine's inputs alone (the
// fixtures pin commit shas). Author and committer identities and dates are
// per call (`CommitIdentity`): the committer is the engine's identity, the
// author's name the commit's actor, the dates the feed row's `ts` in git's
// raw form `@<unix seconds> +0000` (git keeps seconds; the exact `ts` rides in
// the `omgbase-ts` trailer). The Rust twin spawns the same argv under the same
// environment.

export interface GitIdentity {
  name: string;
  email: string;
}

export interface CommitIdentity {
  author: GitIdentity;
  committer: GitIdentity;
  /** RFC 3339 — rendered as `@<seconds> +0000` for both dates. */
  ts: string;
}

export interface GitRunOptions {
  input?: Buffer | string;
  /** extra environment for this call (`GIT_INDEX_FILE`, the identities) */
  env?: Record<string, string>;
  /** do not throw on a non-zero exit (the caller reads `status`) */
  allowFailure?: boolean;
}

export interface GitRunResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly status: number, readonly stderr: string) {
    super(`git ${args.join(" ")} exited ${status}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** The git executable: `git` on PATH, or what `OMGBASE_GIT_BIN` names (a host pinning one git; the tests pointing at a missing one). The Rust twin honours the same variable. */
export const GIT_BIN_ENV = "OMGBASE_GIT_BIN";
export function gitBin(): string {
  const v = process.env[GIT_BIN_ENV];
  return v !== undefined && v.trim() !== "" ? v.trim() : "git";
}

export const ZERO_SHA = "0".repeat(40);
export const SHA_RE = /^[0-9a-f]{40}$/;

/** `ts` (RFC 3339) as git's raw date `@<seconds> +0000`. */
export function gitDate(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`not an RFC 3339 instant: ${ts}`);
  return `@${Math.floor(ms / 1000)} +0000`;
}

/** Is `git` on PATH? The version line, or the reason it is not. Probed once per process. */
let probed: { ok: true; detail: string } | { ok: false; reason: string } | null = null;
export function gitAvailable(): { ok: true; detail: string } | { ok: false; reason: string } {
  if (probed) return probed;
  const r = spawnSync(gitBin(), ["--version"], { encoding: "utf8", env: baseEnv(null) });
  if (r.error) probed = { ok: false, reason: `${gitBin()} is not on PATH (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})` };
  else if (r.status !== 0) probed = { ok: false, reason: `git --version exited ${r.status}: ${(r.stderr ?? "").trim()}` };
  else probed = { ok: true, detail: (r.stdout ?? "").trim() };
  return probed;
}

/** Tests: forget the probe's answer. */
export function resetGitProbe(): void {
  probed = null;
}

function baseEnv(gitDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    TZ: "UTC",
  };
  if (gitDir !== null) env.GIT_DIR = gitDir;
  return env;
}

/** A bare repository at `gitDir`, driven through the plumbing. */
export class GitRepo {
  constructor(readonly gitDir: string) {}

  /** Does the bare repository exist (its `HEAD` file)? */
  exists(): boolean {
    return existsSync(join(this.gitDir, "HEAD"));
  }

  /** `git init --bare -b <branch>` (idempotent: an existing repository is left as it is). */
  init(branch: string): void {
    if (this.exists()) return;
    mkdirSync(this.gitDir, { recursive: true });
    // `--initial-branch` so no `init.defaultBranch` setting (which we never read) decides the name.
    this.run(["init", "--quiet", "--bare", "--initial-branch", branch, this.gitDir], { noGitDir: true });
  }

  /** Delete the bare repository. */
  remove(): boolean {
    if (!existsSync(this.gitDir)) return false;
    rmSync(this.gitDir, { recursive: true, force: true });
    return true;
  }

  run(args: string[], opts: GitRunOptions & { noGitDir?: boolean } = {}): GitRunResult {
    const env = { ...baseEnv(opts.noGitDir ? null : this.gitDir), ...(opts.env ?? {}) };
    const r = spawnSync(gitBin(), args, { env, input: opts.input, maxBuffer: 256 << 20 });
    if (r.error) throw r.error;
    const status = r.status ?? -1;
    const stderr = r.stderr ? r.stderr.toString("utf8") : "";
    if (status !== 0 && !opts.allowFailure) throw new GitError(args, status, stderr);
    return { status, stdout: r.stdout ?? Buffer.alloc(0), stderr };
  }

  text(args: string[], opts: GitRunOptions = {}): string {
    return this.run(args, opts).stdout.toString("utf8");
  }

  /** The branch tip, or null when the ref does not exist. */
  tip(branch: string): string | null {
    const r = this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
    if (r.status !== 0) return null;
    const sha = r.stdout.toString("utf8").trim();
    return SHA_RE.test(sha) ? sha : null;
  }

  /** `git hash-object -w --stdin`: the blob's sha. */
  writeBlob(bytes: Buffer | string): string {
    return this.text(["hash-object", "-w", "--stdin"], { input: bytes }).trim();
  }

  /**
   * Build a tree: the parent commit's tree (or empty) read into a temporary
   * index, `update-index --index-info` with the adds (`100644 blob <sha>\t<path>`)
   * and removes (`0 <zeros>\t<path>`), `write-tree`. Returns the tree sha. The
   * index file lives inside the bare repository and is removed afterwards.
   */
  buildTree(baseTree: string | null, adds: { path: string; blob: string }[], removes: string[]): string {
    const index = join(this.gitDir, `omgbase-index-${process.pid}.tmp`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (baseTree === null) this.run(["read-tree", "--empty"], { env });
      else this.run(["read-tree", baseTree], { env });
      const lines: string[] = [];
      for (const p of removes) lines.push(`0 ${ZERO_SHA}\t${p}`);
      for (const a of adds) lines.push(`100644 blob ${a.blob}\t${a.path}`);
      if (lines.length > 0) this.run(["update-index", "--index-info"], { env, input: lines.join("\n") + "\n" });
      return this.text(["write-tree"], { env }).trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** The tree a commit points at. */
  treeOf(commit: string): string {
    return this.text(["rev-parse", `${commit}^{tree}`]).trim();
  }

  /** `git commit-tree` with the message on stdin and the identities/dates in the environment; the commit sha. */
  commitTree(tree: string, parent: string | null, message: string, id: CommitIdentity): string {
    const date = gitDate(id.ts);
    const env = {
      GIT_AUTHOR_NAME: id.author.name, GIT_AUTHOR_EMAIL: id.author.email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: id.committer.name, GIT_COMMITTER_EMAIL: id.committer.email, GIT_COMMITTER_DATE: date,
    };
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"];
    return this.text(args, { env, input: message }).trim();
  }

  /** `git update-ref` with the old value as the compare-and-swap (`ZERO_SHA` = the ref must not exist). */
  updateRef(branch: string, newSha: string, oldSha: string | null): void {
    this.run(["update-ref", `refs/heads/${branch}`, newSha, oldSha ?? ZERO_SHA]);
  }

  /** The type of an object (`commit`, `blob`, `tree`, `tag`), or null when the object is missing. */
  objectType(sha: string): string | null {
    const r = this.run(["cat-file", "-t", sha], { allowFailure: true });
    return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
  }

  /** A commit's raw message (`%B`). */
  message(commit: string): string {
    return this.text(["log", "-1", "--format=%B", commit]);
  }

  /**
   * The commits of `branch`, oldest first, each as `{ sha, committerUnix, message }`;
   * `grep` (fixed string) narrows to the commits whose message contains it.
   */
  log(branch: string, opts: { grep?: string; regex?: string } = {}): { sha: string; committerUnix: number; message: string }[] {
    if (this.tip(branch) === null) return [];
    const filter = opts.grep !== undefined ? ["--fixed-strings", `--grep=${opts.grep}`] : opts.regex !== undefined ? ["--extended-regexp", `--grep=${opts.regex}`] : [];
    const args = ["log", "--reverse", "--format=%H%x1f%ct%x1f%B%x1e", ...filter, `refs/heads/${branch}`];
    const out = this.text(args);
    const records = out.split("\x1e").map((r) => r.replace(/^\n/, "")).filter((r) => r.trim() !== "");
    return records.map((r) => {
      const [sha, unix, message] = r.split("\x1f") as [string, string, string];
      return { sha: sha.trim(), committerUnix: Number(unix), message: message ?? "" };
    });
  }

  /**
   * `git cat-file --batch` over `<commit>:<path>` specs: the bytes of each, or
   * null when the object is missing (a path not in that tree). One spawn.
   */
  blobsAt(specs: string[]): (Buffer | null)[] {
    if (specs.length === 0) return [];
    const out = this.run(["cat-file", "--batch"], { input: specs.join("\n") + "\n" }).stdout;
    const result: (Buffer | null)[] = [];
    let pos = 0;
    for (let i = 0; i < specs.length; i++) {
      const nl = out.indexOf(0x0a, pos);
      if (nl < 0) { result.push(null); continue; }
      const header = out.subarray(pos, nl).toString("utf8");
      pos = nl + 1;
      const m = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(header);
      if (!m) { result.push(null); continue; } // `<spec> missing` / `ambiguous`
      const size = Number(m[3]);
      result.push(Buffer.from(out.subarray(pos, pos + size)));
      pos += size + 1; // the trailing newline after the content
    }
    return result;
  }

  /** `git ls-tree -r <ref>` as text (the fixtures' projection). */
  lsTree(ref: string): string {
    return this.text(["ls-tree", "-r", ref]);
  }

  /** `git count-objects -v` as a map (the measurement script's `size`/`size-pack`, in KiB). */
  countObjects(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const line of this.text(["count-objects", "-v"]).split("\n")) {
      const m = /^([a-z-]+): (\d+)$/.exec(line.trim());
      if (m) out[m[1]!] = Number(m[2]);
    }
    return out;
  }

  /** `git gc --quiet` (the measurement script packs before counting). */
  gc(): void {
    this.run(["gc", "--quiet"]);
  }
}
