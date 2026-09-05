import { parseArgs } from "node:util";
import { graphTraverse, graphPath, graphSubgraph, resolveRef, type TraverseSpec, type Direction } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EXIT_OK } from "../output.js";
import { readIdsFromStdin } from "./_mutate.js";

// The edge graph is keyed by document id (doc-grain, 05 §3). Seeds may arrive as
// paths, doc ids, or block ids — resolve each to its owning doc id.
function toDocIds(cli: Cli, ws: ReturnType<Cli["workspace"]>, repoId: string, refs: string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("d_")) {
      out.push(ref);
      continue;
    }
    const r = resolveRef(ws.store, repoId, ref);
    if (r) out.push(r.docId);
    else out.push(ref); // pass through; traverse simply finds no edges
  }
  return [...new Set(out)];
}

// `omg graph traverse|path|subgraph` (11 §5.4). Doc-grain traversal over the
// authored edge graph. Seeds from stdin ("-") compose with --from; --json is
// the analytics export.

function seedsFrom(values: { from?: string }, positionals: string[]): string[] {
  const seeds: string[] = [];
  if (values.from) seeds.push(...values.from.split(",").map((s) => s.trim()).filter(Boolean));
  // A bare "-" positional pulls ids from stdin (composes with --from).
  if (positionals.includes("-")) seeds.push(...readIdsFromStdin());
  seeds.push(...positionals.filter((p) => p !== "-"));
  return [...new Set(seeds)];
}

function runGraph(cli: Cli, args: string[]): number {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "traverse":
      return runTraverse(cli, rest);
    case "path":
      return runPath(cli, rest);
    case "subgraph":
      return runSubgraph(cli, rest);
    case undefined:
    case "--help":
      cli.io.err("  graph traverse|path|subgraph  — traverse the authored edge graph");
      return EXIT_OK;
    default:
      throw new CliUsageError(`unknown graph subcommand '${sub}' (traverse|path|subgraph)`);
  }
}

function runTraverse(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      via: { type: "string" },
      dir: { type: "string" },
      depth: { type: "string" },
      "max-nodes": { type: "string" },
      "max-edges": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.err("  graph traverse [--from id,…|-] [--via p,p] [--dir out|in|both] [--depth n] [--max-nodes n] [--max-edges n]");
    return EXIT_OK;
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const seeds = toDocIds(cli, ws, repo.repoId, seedsFrom(values, positionals));
  if (seeds.length === 0) throw new CliUsageError("traverse needs seeds (--from id,… or - for stdin)");

  const spec: TraverseSpec = { from: seeds };
  if (values.via) spec.via = values.via.split(",").map((s) => s.trim());
  if (values.dir) spec.direction = values.dir as Direction;
  if (values.depth) spec.depth = Number(values.depth);
  const budget: { maxNodes?: number; maxEdges?: number } = {};
  if (values["max-nodes"]) budget.maxNodes = Number(values["max-nodes"]);
  if (values["max-edges"]) budget.maxEdges = Number(values["max-edges"]);
  if (Object.keys(budget).length) spec.budget = budget;

  const result = graphTraverse(ws.store, spec);
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const n of result.nodes) cli.io.out(n);
    return EXIT_OK;
  }
  const { style, io } = cli;
  for (const e of result.edges) io.out(`${style.id(e.src)} ${style.accent(e.predicate)} ${style.id(e.dst)}`);
  io.err(style.dim(`  ${result.nodes.length} nodes, ${result.edges.length} edges${result.truncated ? " (truncated)" : ""}`));
  return EXIT_OK;
}

function runPath(cli: Cli, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { from: { type: "string" }, to: { type: "string" }, via: { type: "string" }, "max-len": { type: "string" }, k: { type: "string", short: "k" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  graph path --from a --to b [--via p,p] [--max-len n] [-k n]");
    return EXIT_OK;
  }
  if (!values.from || !values.to) throw new CliUsageError("graph path requires --from and --to");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const [fromId] = toDocIds(cli, ws, repo.repoId, [values.from]);
  const [toId] = toDocIds(cli, ws, repo.repoId, [values.to]);
  const spec: Parameters<typeof graphPath>[1] = { from: fromId!, to: toId! };
  if (values.via) spec.via = values.via.split(",").map((s) => s.trim());
  if (values["max-len"]) spec.maxLen = Number(values["max-len"]);
  if (values.k) spec.k = Number(values.k);
  const result = graphPath(ws.store, spec);
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  const { style, io } = cli;
  if (result.paths.length === 0) io.err(style.dim("  no path"));
  for (const p of result.paths) io.out(p.map((n) => style.id(n)).join(style.dim(" → ")));
  return EXIT_OK;
}

function runSubgraph(cli: Cli, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { seeds: { type: "string" }, radius: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  graph subgraph --seeds id,… [--radius n]  — analytics export (use --json)");
    return EXIT_OK;
  }
  if (!values.seeds) throw new CliUsageError("graph subgraph requires --seeds id,…");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const spec: Parameters<typeof graphSubgraph>[1] = { seeds: toDocIds(cli, ws, repo.repoId, values.seeds.split(",").map((s) => s.trim())) };
  if (values.radius) spec.radius = Number(values.radius);
  const result = graphSubgraph(ws.store, spec);
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  const { style, io } = cli;
  for (const e of result.edges) io.out(`${style.id(e.src)} ${style.accent(e.predicate)} ${style.id(e.dst)}`);
  io.err(style.dim(`  ${result.nodes.length} nodes, ${result.edges.length} edges`));
  return EXIT_OK;
}

export const cmdGraph: Command = { name: "graph", summary: "Traverse the edge graph (traverse|path|subgraph)", run: (c, a) => runGraph(c, a) };
