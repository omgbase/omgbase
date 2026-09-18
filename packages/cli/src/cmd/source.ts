import { resolve, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import {
  createSource,
  deleteSource,
  listSources,
  getSourceByName,
  attachSourceToRepo,
  detachSourceFromRepo,
  sourcesForRepo,
  ensureRepo,
  freshnessSweep,
  walkMarkdownAsync,
  rebuildFileStats,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns } from "../render.js";
import { drainEmbeddings } from "./_embed.js";
import { ensureFsAdapter, FS_ADAPTER } from "./_source.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg source` (ADR-014) — the source registry: where a repo's bytes come from
// (a filesystem directory today; git/S3/etc. via adapters later). A repo owns
// identity + history; adding a filesystem source points it at a directory and
// runs the initial sync. There is no separate "attach/ingest/load" verb —
// `source add <dir>` is how content enters, and the initial ingest is just that
// source's first sync (the same reconcile path every later sync uses).

function help(cli: Cli): number {
  cli.io.out(`  ${cli.style.bold("source")} — where a repo's bytes come from (filesystem today; git/S3/… later)`);
  cli.io.out(`  ${cli.style.dim("usage:")} omg source <add|list|attach|detach|rm> …`);
  cli.io.out("    add <dir> [--slug <s>] [--name <n>] [-y]   point a repo at a filesystem dir (creates the repo + initial sync)");
  cli.io.out("    list                                       list sources + which repos they feed");
  cli.io.out("    attach <name> [--repo <slug>]              attach an existing source to a repo");
  cli.io.out("    detach <name> [--repo <slug>]              detach a source from a repo");
  cli.io.out("    rm <name>                                  delete a source (and its attachments)");
  return EXIT_OK;
}

function attachedRepoSlugs(cli: Cli, ws: ReturnType<Cli["workspace"]>, sourceId: string): string[] {
  return ws.repos().filter((r) => sourcesForRepo(ws.store, r.repoId).some((s) => s.sourceId === sourceId)).map((r) => r.slug);
}

async function runSource(cli: Cli, args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "help") return help(cli);
  const rest = args.slice(1);

  switch (sub) {
    case "add":
      return runAdd(cli, rest);
    case "list":
      return runList(cli);
    case "attach":
      return runAttachDetach(cli, rest, "attach");
    case "detach":
      return runAttachDetach(cli, rest, "detach");
    case "rm":
      return runRm(cli, rest);
    default:
      throw new CliUsageError(`unknown source subcommand '${sub}'`);
  }
}

// Walk `abs` for markdown while showing a growing count beside a [y/N] prompt.
// The scan runs concurrently with the question; the count carries a `+` suffix
// until the walk completes. Returns the answer plus whether the walk finished.
async function confirmIngestWithCount(cli: Cli, abs: string, slug: string): Promise<{ ok: boolean; complete: boolean }> {
  const signal = { aborted: false };
  let count = 0;
  let complete = false;
  const isTTY = cli.io.stdoutTTY && process.stdin.isTTY;

  const render = (): void => {
    if (!isTTY) return;
    process.stderr.write(`\r  add source for ${slug} — ${count}${complete ? "" : "+"} files  [y/N] `);
  };
  const walk = walkMarkdownAsync(abs, (n) => { count = n; render(); }, signal).then(() => { complete = true; render(); });

  if (!isTTY) {
    // No TTY to prompt: refuse rather than silently ingesting the tree.
    signal.aborted = true;
    await walk;
    return { ok: false, complete };
  }
  render();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) => rl.question("", res));
  rl.close();
  signal.aborted = true;
  await walk;
  return { ok: /^y(es)?$/i.test(answer.trim()), complete };
}

async function runAdd(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { slug: { type: "string" }, name: { type: "string" }, yes: { type: "boolean", short: "y" }, help: { type: "boolean" } },
  });
  if (values.help) return help(cli);
  const dir = positionals[0];
  if (!dir) throw new CliUsageError("source add requires a <dir>");
  const abs = resolve(cli.cwd, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new EngineErrorLike("target_missing", `no such directory: ${abs}`);

  const slug = values.slug ?? (basename(abs) || "vault");
  const sourceName = values.name ?? `${slug}-fs`;
  const ws = cli.workspace();
  if (getSourceByName(ws.store, sourceName)) throw new EngineErrorLike("path_taken", `a source named '${sourceName}' already exists`);

  // Consent gate: -y proceeds; a TTY prompts with a live file count; a non-TTY
  // without -y refuses rather than absorbing the tree silently.
  if (!values.yes) {
    const { ok } = await confirmIngestWithCount(cli, abs, slug);
    if (cli.io.stdoutTTY) process.stderr.write("\n");
    if (!ok) {
      const why = !process.stdin.isTTY || !cli.io.stdoutTTY ? `refusing without -y (would ingest files under ${shortenHome(abs)})` : "cancelled";
      cli.io.err(cli.style.dim(`  ${why}`));
      return EXIT_OK;
    }
  }

  // A repo owns identity; register its fs source, then run the initial sync
  // through the ordinary freshness path (the same reconcile every later sync
  // uses). ensureRepo(…, null) mints identity only — the source is explicit.
  const repoId = ensureRepo(ws.store, slug, null);
  ensureFsAdapter(ws.store);
  const sourceId = createSource(ws.store, { name: sourceName, adapter: FS_ADAPTER, config: { root: abs } });
  attachSourceToRepo(ws.store, repoId, sourceId);
  const swept = freshnessSweep(ws.store, repoId, abs);
  rebuildFileStats(ws.store, repoId, abs);

  // Offer to embed freshly-ingested blocks now (consent-gated like the ingest).
  const drained = await drainEmbeddings(cli, ws, repoId, {
    verbose: true,
    confirm: async ({ pending, remote, providerName }) => {
      if (pending === 0) return false;
      if (values.yes) return true;
      const where = remote ? `${providerName} (remote — block text leaves your machine)` : `${providerName} (local)`;
      return confirmTTY(cli, `embed ${pending} block(s) now via ${where}?`);
    },
  });

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ repo: slug, repoId, source: sourceName, root: abs, ingested: swept.ingested.length, ...(drained ? { embedded: drained.embedded } : {}) }));
    return EXIT_OK;
  }
  const { render, style, io } = cli;
  io.out(`  ${render.g.diamond} ${style.accent(slug)} ← ${style.path(shortenHome(abs))}  ${style.dim(`${swept.ingested.length} files`)}`);
  if (drained) io.err(`  ${style.ok(render.g.ok)} embedded ${drained.embedded}, cached ${drained.cached}`);
  return EXIT_OK;
}

function runList(cli: Cli): number {
  const ws = cli.workspace();
  const sources = listSources(ws.store).map((s) => ({ ...s, repos: attachedRepoSlugs(cli, ws, s.sourceId) }));

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(sources.map((s) => ({ name: s.name, adapter: s.adapter, config: s.config, repos: s.repos }))));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const s of sources) cli.io.out(JSON.stringify({ name: s.name, adapter: s.adapter, config: s.config, repos: s.repos }));
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const s of sources) cli.io.out(s.name);
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (sources.length === 0) {
    io.out(style.dim("  no sources registered"));
    return EXIT_OK;
  }
  const rows = sources.map((s) => [
    `  ${style.accent(s.name)}`,
    style.dim(s.adapter),
    style.path(String(s.config.root ?? "")),
    style.dim(s.repos.length > 0 ? `→ ${s.repos.join(", ")}` : "(unattached)"),
  ]);
  for (const line of columns(rows)) io.out(line);
  return EXIT_OK;
}

function runAttachDetach(cli: Cli, args: string[], verb: "attach" | "detach"): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name) throw new CliUsageError(`source ${verb} requires a <name>`);
  const ws = cli.workspace();
  const source = getSourceByName(ws.store, name);
  if (!source) throw new EngineErrorLike("target_missing", `no source named '${name}'`);
  const repo = cli.repo(ws);

  if (verb === "attach") attachSourceToRepo(ws.store, repo.repoId, source.sourceId);
  else detachSourceFromRepo(ws.store, repo.repoId, source.sourceId);

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ source: name, repo: repo.slug, attached: verb === "attach" }));
    return EXIT_OK;
  }
  cli.io.out(`  ${cli.render.g.ok} ${verb === "attach" ? "attached" : "detached"} ${cli.style.accent(name)} ${verb === "attach" ? "→" : "⇸"} ${cli.style.accent(repo.slug)}`);
  return EXIT_OK;
}

function runRm(cli: Cli, args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name) throw new CliUsageError("source rm requires a <name>");
  const ws = cli.workspace();
  const source = getSourceByName(ws.store, name);
  if (!source) throw new EngineErrorLike("target_missing", `no source named '${name}'`);
  deleteSource(ws.store, source.sourceId);

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ source: name, deleted: true }));
    return EXIT_OK;
  }
  cli.io.out(`  ${cli.render.g.ok} deleted source ${cli.style.accent(name)}`);
  return EXIT_OK;
}

// small local helpers ---------------------------------------------------------

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

function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export const cmdSource: Command = { name: "source", summary: "Where a repo's bytes come from (add/list/attach/detach/rm)", run: (cli, a) => runSource(cli, a) };
