import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { Workspace, attachRepo, rebuildFileStats, reposStatus } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns as columnsLocal } from "../render.js";
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

function offerGitignore(cli: Cli, root: string, yes: boolean, force: boolean): Promise<void> | void {
  const gi = join(root, ".gitignore");
  const line = ".omgbase/";
  const already = existsSync(gi) && readFileSync(gi, "utf8").split(/\r?\n/).some((l) => l.trim() === line || l.trim() === ".omgbase");
  if (already) return;

  const append = (): void => {
    const prefix = existsSync(gi) && !readFileSync(gi, "utf8").endsWith("\n") ? "\n" : "";
    appendFileSync(gi, `${prefix}${line}\n`);
    cli.io.err(cli.style.dim(`  added ${line} to .gitignore`));
  };

  // never silent (11 §5.1): --yes appends, TTY prompts, non-TTY without --yes
  // prints a notice and skips.
  if (yes || force) return append();
  return confirmTTY(cli, `append ${line} to .gitignore?`).then((ok) => {
    if (ok) append();
    else cli.io.err(cli.style.dim(`  skipped .gitignore; add ${line} yourself to keep the db out of git`));
  });
}

async function runInit(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean", short: "y" }, help: { type: "boolean" } },
  });
  if (values.help) return help(cli, "init", "omgbase init [dir] [--yes]", "Create .omgbase/ + database in dir (default cwd), attach it as a repo, run the initial ingest.");

  const dir = resolve(positionals[0] ?? cli.cwd);
  mkdirSync(dir, { recursive: true });
  const omgbaseDir = join(dir, ".omgbase");
  if (existsSync(join(omgbaseDir, "omgbase.db"))) {
    throw new EngineErrorLike("path_taken", `workspace already initialized at ${dir}`);
  }

  const ws = Workspace.open(dir);
  const slug = basename(dir) || "vault";
  const result = attachRepo(ws.store, slug, dir);
  rebuildFileStats(ws.store, result.repoId, dir);

  await offerGitignore(cli, dir, Boolean(values.yes), false);

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ workspace: dir, repo: slug, repoId: result.repoId, files: result.fileCount, converged: result.allConverged }));
    ws.close();
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  io.out(render.wordmark("initialized"));
  io.out(render.rule(40));
  io.out(`  ${style.ok(render.g.ok)} workspace  ${style.path(dir)}`);
  io.out(`  ${render.g.diamond} repo       ${style.accent(slug)}  ${style.dim(`${result.fileCount} files`)}`);
  io.out(`  ${render.statusDot(result.allConverged ? "ok" : "warn", result.allConverged ? "all files converged" : "some files did not converge")}`);
  ws.close();
  return EXIT_OK;
}

async function runAttach(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { slug: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) return help(cli, "attach", "omgbase attach <path> --slug <s>", "Attach an additional working tree to this workspace.");
  const path = positionals[0];
  if (!path) throw new CliUsageError("attach requires a <path>");
  const abs = resolve(path);
  if (!existsSync(abs)) throw new EngineErrorLike("target_missing", `no such directory: ${abs}`);
  const slug = values.slug ?? basename(abs);

  const ws = cli.workspace();
  const result = attachRepo(ws.store, slug, abs);
  rebuildFileStats(ws.store, result.repoId, abs);

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ repo: slug, repoId: result.repoId, files: result.fileCount, converged: result.allConverged }));
    return EXIT_OK;
  }
  const { render, style, io } = cli;
  io.out(`  ${render.g.diamond} attached ${style.accent(slug)}  ${style.path(abs)}  ${style.dim(`${result.fileCount} files`)}`);
  return EXIT_OK;
}

function runRepos(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) return help(cli, "repos", "omgbase repos", "List repos in this workspace: slug, root path, doc/block counts.");
  const ws = cli.workspace();
  const repos = ws.repos().map((r) => ({ ...r, status: reposStatus(ws.store, r.repoId) }));

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(repos.map((r) => ({ slug: r.slug, root: r.rootPath, documents: r.status.documents, blocks: r.status.blocks }))));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const r of repos) cli.io.out(JSON.stringify({ slug: r.slug, root: r.rootPath, documents: r.status.documents, blocks: r.status.blocks }));
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
    style.dim(`${r.status.documents} docs`),
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

export const cmdInit: Command = { name: "init", summary: "Create a workspace + attach the current dir", run: (cli, a) => runInit(cli, a) };
export const cmdAttach: Command = { name: "attach", summary: "Attach another working tree", run: (cli, a) => runAttach(cli, a) };
export const cmdRepos: Command = { name: "repos", summary: "List repos in this workspace", run: (cli, a) => runRepos(cli, a) };
