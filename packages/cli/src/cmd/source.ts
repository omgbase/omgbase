import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createSource,
  deleteSource,
  listSources,
  getSourceByName,
  attachSourceToRepo,
  detachSourceFromRepo,
  sourcesForRepo,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns } from "../render.js";
import { ensureFsAdapter, FS_ADAPTER } from "./_source.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg source` (ADR-014 Stage 3) — manage the source registry: the external
// stores a repo reconciles with (a filesystem folder is one; git/S3/etc. later).
// Subcommands: list, add, attach, detach, rm. A repo's fs source resolves from
// here (else falls back to root_path) for watch/mcp/sync.

function help(cli: Cli): number {
  cli.io.out(`  ${cli.style.bold("source")} — manage sync sources (external stores a repo reconciles with)`);
  cli.io.out(`  ${cli.style.dim("usage:")} omg source <list|add|attach|detach|rm> …`);
  cli.io.out("    list                                  list sources + which repos they're attached to");
  cli.io.out("    add <name> --root <dir> [--adapter fs]  register a source (fs: --root <dir>)");
  cli.io.out("    attach <name> [--repo <slug>]         attach a source to a repo");
  cli.io.out("    detach <name> [--repo <slug>]         detach a source from a repo");
  cli.io.out("    rm <name>                             delete a source (and its attachments)");
  return EXIT_OK;
}

function attachedRepoSlugs(cli: Cli, ws: ReturnType<Cli["workspace"]>, sourceId: string): string[] {
  return ws.repos().filter((r) => sourcesForRepo(ws.store, r.repoId).some((s) => s.sourceId === sourceId)).map((r) => r.slug);
}

function runSource(cli: Cli, args: string[]): number {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "help") return help(cli);
  const rest = args.slice(1);

  switch (sub) {
    case "list":
      return runList(cli);
    case "add":
      return runAdd(cli, rest);
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

function runAdd(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { adapter: { type: "string" }, root: { type: "string" }, config: { type: "string" } },
  });
  const name = positionals[0];
  if (!name) throw new CliUsageError("source add requires a <name>");
  const adapter = values.adapter ?? FS_ADAPTER;

  // Build the source config: an fs source takes --root (stored absolute); a
  // generic source takes --config <json>. --root wins for the fs convenience.
  let config: Record<string, unknown> = {};
  if (values.config) {
    try {
      config = JSON.parse(values.config) as Record<string, unknown>;
    } catch {
      throw new CliUsageError("--config must be a JSON object");
    }
  }
  if (values.root !== undefined) config.root = resolve(cli.cwd, values.root);
  if (adapter === FS_ADAPTER && typeof config.root !== "string") {
    throw new CliUsageError("an fs source requires --root <dir> (or --config with a root)");
  }

  const ws = cli.workspace();
  if (getSourceByName(ws.store, name)) throw new EngineErrorLike("path_taken", `a source named '${name}' already exists`);
  if (adapter === FS_ADAPTER) ensureFsAdapter(ws.store); // seed the built-in adapter row (FK)
  const sourceId = createSource(ws.store, { name, adapter, config });

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ source: name, sourceId, adapter, config }));
    return EXIT_OK;
  }
  cli.io.out(`  ${cli.render.g.diamond} source ${cli.style.accent(name)}  ${cli.style.dim(adapter)}  ${cli.style.path(String(config.root ?? ""))}`);
  cli.io.err(cli.style.dim(`  next: ${cli.style.accent(`omg source attach ${name}`)} to bind it to a repo`));
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

export const cmdSource: Command = { name: "source", summary: "Manage sync sources (list/add/attach/detach/rm)", run: (cli, a) => runSource(cli, a) };
