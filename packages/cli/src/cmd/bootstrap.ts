import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { Workspace, reposStatus, workspaceSettings, writeWorkspaceSettings } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns as columnsLocal } from "../render.js";
import { EngineErrorLike, EXIT_OK } from "../output.js";

// Bootstrap: init / repos (11 §5.1). Pointing a repo at a directory is
// `omg source add <dir>` (ADR-014) — a repo owns identity; sources bring bytes.

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
  if (values.help) return help(cli, "init", "omgbase init [dir] [--yes] [--embedder <cmd|url> | --no-embedder]", "Create an omgbase workspace (.omgbase/ + database) in dir (default cwd). Does not ingest files — run `omg source add .` to point a repo at a directory. --embedder sets the embedding provider directly; --no-embedder skips the provider offer entirely.");

  const dir = resolve(positionals[0] ?? cli.cwd);
  mkdirSync(dir, { recursive: true });
  const omgbaseDir = join(dir, ".omgbase");
  if (existsSync(join(omgbaseDir, "omgbase.db"))) {
    throw new EngineErrorLike("path_taken", `workspace already initialized at ${dir}`);
  }

  // Create the workspace + db only. Ingesting a working tree is a separate,
  // consent-gated step (`omg source add`) so init never silently absorbs whatever
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
  io.err(style.dim(`  next: ${style.accent("omg source add .")} to point a repo at a directory of files`));
  if (needsProviderHint) {
    io.err(style.dim(`  semantic search is off — no embedding provider set. Install the built-in embedder:`));
    io.err(style.dim(`    ${EMBEDDER_INSTALL} && omg config set embedding.provider ${EMBEDDER_CMD} --repo ""`));
  }
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
    style.path(r.rootPath ? shortenHome(r.rootPath) : "(no source)"),
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

export const cmdInit: Command = { name: "init", summary: "Create a workspace (run `source add` to ingest files)", run: (cli, a) => runInit(cli, a) };
export const cmdRepos: Command = { name: "repos", summary: "List repos in this workspace", run: (cli, a) => runRepos(cli, a) };
