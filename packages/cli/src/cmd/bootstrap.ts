import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, basename, resolve, dirname, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { Workspace, attachRepo, walkMarkdownAsync, rebuildFileStats, reposStatus, workspaceSettings, writeWorkspaceSettings } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns as columnsLocal } from "../render.js";
import { drainEmbeddings } from "./_embed.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// Bootstrap: init / attach / repos (11 §5.1).

async function confirmTTY(cli: Cli, question: string): Promise<boolean> {
  if (!cli.io.stdoutTTY || !process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => rl.question(`${question} [y/N] `, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Nearest ancestor (inclusive) that is a git working tree, or null. */
function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Keep the db out of git. The workspace `.omgbase/` only matters to git when it
 * lives inside a git working tree, so we locate the enclosing git root (if any)
 * and offer to ignore it via the *closest* existing `.gitignore` at or above
 * the workspace (bounded by the git root); if none exists in that span, we
 * create one at the git root. The ignore line is written relative to whichever
 * `.gitignore` we touch, so the pattern resolves correctly regardless of depth.
 * Outside a git repo there is nothing to ignore — we say so and skip.
 */
function offerGitignore(cli: Cli, omgbaseParent: string, yes: boolean): Promise<void> | void {
  const gitRoot = findGitRoot(omgbaseParent);
  if (!gitRoot) {
    cli.io.err(cli.style.dim("  not inside a git repo — no .gitignore needed for .omgbase/"));
    return;
  }

  // Find the closest existing .gitignore from the workspace up to the git root;
  // fall back to creating one at the git root.
  const findGitignore = (): { path: string; exists: boolean } => {
    let dir = resolve(omgbaseParent);
    for (;;) {
      const gi = join(dir, ".gitignore");
      if (existsSync(gi)) return { path: gi, exists: true };
      if (dir === gitRoot) return { path: join(gitRoot, ".gitignore"), exists: false };
      const parent = dirname(dir);
      if (parent === dir) return { path: join(gitRoot, ".gitignore"), exists: false };
      dir = parent;
    }
  };
  const target = findGitignore();
  // The pattern: `.omgbase/` at the workspace, expressed relative to the
  // .gitignore that will hold it (so a repo-root .gitignore gets `sub/dir/.omgbase/`).
  const rel = relative(dirname(target.path), join(omgbaseParent, ".omgbase")).split(sep).join("/");
  const line = `${rel}/`;

  const already =
    target.exists &&
    readFileSync(target.path, "utf8")
      .split(/\r?\n/)
      .some((l) => l.trim() === line || l.trim() === rel);
  if (already) return;

  const write = (): void => {
    if (target.exists) {
      const prefix = !readFileSync(target.path, "utf8").endsWith("\n") ? "\n" : "";
      appendFileSync(target.path, `${prefix}${line}\n`);
    } else {
      writeFileSync(target.path, `${line}\n`);
    }
    const shown = shortenHome(target.path);
    cli.io.err(cli.style.dim(`  ${target.exists ? "added" : "created"} ${line} in ${shown}`));
  };

  // never silent (11 §5.1): --yes writes, TTY prompts, non-TTY without --yes
  // prints a notice and skips.
  if (yes) return write();
  const verb = target.exists ? "append to" : "create";
  return confirmTTY(cli, `${verb} ${shortenHome(target.path)} to ignore ${line}?`).then((ok) => {
    if (ok) write();
    else cli.io.err(cli.style.dim(`  skipped .gitignore; add ${line} yourself to keep the db out of git`));
  });
}

const EMBEDDER_CMD = "omgbase-embedder";
const EMBEDDER_INSTALL = "npm i -g @omgbase/embedder";

/** Is `cmd` runnable on PATH? Probes with a short-lived spawn (no shell). */
function commandExists(cmd: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
  return probe.status === 0;
}

function setProvider(cli: Cli, ws: Workspace, provider: string): void {
  const current = workspaceSettings(ws.store);
  const emb = (current.embedding as Record<string, unknown> | undefined) ?? {};
  writeWorkspaceSettings(ws.store, { ...current, embedding: { ...emb, provider } });
  cli.io.err(cli.style.dim(`  embedding.provider = ${provider} (workspace default)`));
}

/**
 * Configure the workspace's embedding provider (workspace layer, so every repo
 * shares one vector space). Semantic search is off until a provider is set.
 * Three paths:
 *   • `--embedder <value>` — set it verbatim, no prompt, no PATH check (the
 *     caller stated explicit intent; the value may be any command or URL).
 *   • otherwise, only when `omgbase-embedder` is actually installed do we offer
 *     it (—yes accepts, TTY prompts). We never wire a provider that isn't
 *     there, so `omg embed` can't be left pointing at a missing command.
 *   • not installed and no `--embedder` ⇒ we don't touch settings and return
 *     true so init can print install/config guidance at the end.
 * Returns whether the caller should show the "no provider" guidance footer.
 */
async function offerEmbedder(cli: Cli, ws: Workspace, yes: boolean, embedder?: string): Promise<boolean> {
  const emb = workspaceSettings(ws.store).embedding as { provider?: string } | undefined;
  if (emb?.provider) return false; // already configured — leave it alone

  if (embedder !== undefined) {
    setProvider(cli, ws, embedder);
    return false;
  }

  // Only offer the built-in embedder if it's genuinely runnable.
  if (!commandExists(EMBEDDER_CMD)) return true;

  const accept = yes || (await confirmTTY(cli, `set ${EMBEDDER_CMD} as the embedding provider (enables semantic search)?`));
  if (!accept) return true;
  setProvider(cli, ws, EMBEDDER_CMD);
  return false;
}

async function runInit(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y" },
      embedder: { type: "string" },
      "no-embedder": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return help(cli, "init", "omgbase init [dir] [--yes] [--embedder <cmd|url> | --no-embedder]", "Create an omgbase workspace (.omgbase/ + database) in dir (default cwd). Does not ingest files — run `omg attach .` to add a repo. --embedder sets the embedding provider directly; --no-embedder skips the provider offer entirely.");

  const dir = resolve(positionals[0] ?? cli.cwd);
  mkdirSync(dir, { recursive: true });
  const omgbaseDir = join(dir, ".omgbase");
  if (existsSync(join(omgbaseDir, "omgbase.db"))) {
    throw new EngineErrorLike("path_taken", `workspace already initialized at ${dir}`);
  }

  // Create the workspace + db only. Ingesting a working tree is a separate,
  // consent-gated step (`omg attach`) so init never silently absorbs whatever
  // happens to live under cwd (home dir, desktop, …).
  const ws = Workspace.open(dir);
  let needsProviderHint = false;
  try {
    await offerGitignore(cli, dir, Boolean(values.yes));
    if (!values["no-embedder"]) {
      needsProviderHint = await offerEmbedder(cli, ws, Boolean(values.yes), values.embedder);
    }
  } finally {
    ws.close();
  }

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ workspace: dir }));
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  io.out(render.wordmark("initialized"));
  io.out(render.rule(40));
  io.out(`  ${style.ok(render.g.ok)} workspace  ${style.path(dir)}`);
  io.err(style.dim(`  next: ${style.accent("omg attach .")} to ingest a directory of files as a repo`));
  if (needsProviderHint) {
    io.err(style.dim(`  semantic search is off — no embedding provider set. Install the built-in embedder:`));
    io.err(style.dim(`    ${EMBEDDER_INSTALL} && omg config set embedding.provider ${EMBEDDER_CMD} --repo ""`));
  }
  return EXIT_OK;
}

// Walk `abs` for markdown while showing a live, growing count next to a [y/N]
// prompt. The scan runs concurrently with the question; the count carries a `+`
// suffix until the walk completes ("248+" → "248"). Returns the answer plus the
// files walked so far (the full set once the walk finished, which it always has
// by the time the user answers unless they answered mid-scan — attachRepo
// re-walks defensively when handed a partial, see below).
async function confirmAttachWithCount(
  cli: Cli,
  abs: string,
  slug: string,
): Promise<{ ok: boolean; files: string[]; complete: boolean }> {
  const signal = { aborted: false };
  let count = 0;
  let complete = false;
  const isTTY = cli.io.stdoutTTY && process.stdin.isTTY;

  const render = (): void => {
    if (!isTTY) return;
    const suffix = complete ? "" : "+";
    process.stderr.write(`\r  attach ${slug} — ${count}${suffix} files  [y/N] `);
  };

  const walk = walkMarkdownAsync(abs, (n) => { count = n; render(); }, signal)
    .then((files) => { complete = true; render(); return files; });

  if (!isTTY) {
    // No TTY to prompt: refuse rather than silently absorbing the tree.
    signal.aborted = true;
    await walk;
    return { ok: false, files: [], complete };
  }

  render();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) => rl.question("", res));
  rl.close();
  signal.aborted = true;
  const files = await walk;
  return { ok: /^y(es)?$/i.test(answer.trim()), files, complete };
}

async function runAttach(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { slug: { type: "string" }, yes: { type: "boolean", short: "y" }, help: { type: "boolean" } },
  });
  if (values.help) return help(cli, "attach", "omgbase attach <path> [--slug <s>] [-y]", "Attach a working tree to this workspace and ingest its Markdown files. Prompts before ingesting; -y skips the prompt.");
  const path = positionals[0];
  if (!path) throw new CliUsageError("attach requires a <path>");
  const abs = resolve(cli.cwd, path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new EngineErrorLike("target_missing", `no such directory: ${abs}`);
  const slug = values.slug ?? (basename(abs) || "vault");

  const ws = cli.workspace();

  // Consent gate: -y proceeds; otherwise prompt with a live file count. A
  // non-TTY without -y refuses rather than absorbing the tree silently.
  let files: string[] | undefined;
  if (!values.yes) {
    const { ok, files: walked, complete } = await confirmAttachWithCount(cli, abs, slug);
    if (cli.io.stdoutTTY) process.stderr.write("\n");
    if (!ok) {
      if (!process.stdin.isTTY || !cli.io.stdoutTTY) {
        cli.io.err(cli.style.dim(`  refusing to attach without -y (would ingest files under ${shortenHome(abs)})`));
      } else {
        cli.io.err(cli.style.dim("  cancelled"));
      }
      return EXIT_OK;
    }
    // Reuse the walk only if it finished before the user answered; a partial
    // list means attachRepo should re-walk to catch everything.
    if (complete) files = walked;
  }

  const result = attachRepo(ws.store, slug, abs, files);
  rebuildFileStats(ws.store, result.repoId, abs);

  const { render, style, io } = cli;
  if (cli.flags.mode === "human") {
    io.out(`  ${render.g.diamond} attached ${style.accent(slug)}  ${style.path(abs)}  ${style.dim(`${result.fileCount} files`)}`);
  }

  // Freshly-ingested blocks aren't embedded yet. If this workspace has an
  // embedding provider configured, offer to drain the queue now (verbose) so
  // semantic search works immediately — no separate `omg embed drain` needed.
  // Draining hands block text to the provider (and off-machine for a remote
  // endpoint), so it gets its own consent: `-y` accepts (as it did the ingest),
  // a TTY prompts, and a non-TTY without `-y` skips rather than blocking. No
  // provider ⇒ drainEmbeddings returns null and we say nothing.
  const drained = await drainEmbeddings(cli, ws, result.repoId, {
    verbose: true,
    confirm: async ({ pending, remote, providerName }) => {
      if (pending === 0) return false; // nothing to embed — don't prompt
      if (values.yes) return true;
      const where = remote ? `${providerName} (remote — block text leaves your machine)` : `${providerName} (local)`;
      return confirmTTY(cli, `embed ${pending} block(s) now via ${where}?`);
    },
  });

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({
      repo: slug,
      repoId: result.repoId,
      files: result.fileCount,
      converged: result.allConverged,
      ...(drained ? { embedded: drained.embedded } : {}),
    }));
    return EXIT_OK;
  }
  if (drained) io.err(`  ${style.ok(render.g.ok)} embedded ${drained.embedded}, cached ${drained.cached}`);
  return EXIT_OK;
}

function runRepos(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) return help(cli, "repos", "omgbase repos", "List repos in this workspace: slug, root path, doc/block counts.");
  const ws = cli.workspace();
  const repos = ws.repos().map((r) => ({ ...r, status: reposStatus(ws.store, r.repoId) }));

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(repos.map((r) => ({ slug: r.slug, root: r.rootPath, docs: r.status.docs, blocks: r.status.blocks }))));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const r of repos) cli.io.out(JSON.stringify({ slug: r.slug, root: r.rootPath, docs: r.status.docs, blocks: r.status.blocks }));
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const r of repos) cli.io.out(r.slug);
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  const rows = repos.map((r) => [
    `  ${render.g.diamond} ${style.accent(r.slug)}`,
    style.path(shortenHome(r.rootPath)),
    style.dim(`${r.status.docs} docs`),
    style.dim(`${r.status.blocks} blocks`),
  ]);
  if (rows.length === 0) io.out(style.dim("  no repos attached"));
  else for (const line of columnsLocal(rows)) io.out(line);
  return EXIT_OK;
}

// small local helpers ---------------------------------------------------------

function help(cli: Cli, name: string, usage: string, desc: string): number {
  cli.io.out(`  ${cli.style.bold(name)} — ${desc}`);
  cli.io.out(`  ${cli.style.dim("usage:")} ${usage}`);
  return EXIT_OK;
}

function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export const cmdInit: Command = { name: "init", summary: "Create a workspace (run `attach` to ingest files)", run: (cli, a) => runInit(cli, a) };
export const cmdAttach: Command = { name: "attach", summary: "Attach a working tree and ingest its files", run: (cli, a) => runAttach(cli, a) };
export const cmdRepos: Command = { name: "repos", summary: "List repos in this workspace", run: (cli, a) => runRepos(cli, a) };
