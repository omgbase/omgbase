import { parseArgs } from "node:util";
import { resolveRef, docLinks } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg links <node>` (11 §5.4) — open edges touching the node; default both
// directions, grouped; doc-grain by default, --blocks for block-grain.
// Backlinks = --in.

function runLinks(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      in: { type: "boolean" },
      out: { type: "boolean" },
      pred: { type: "string" },
      blocks: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  links <node> [--in|--out] [--pred p,p] [--blocks]  — open edges; --in = backlinks");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("links requires a <node>");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved) throw new EngineErrorLike("doc_missing", `no node ${ref}`);

  const direction = values.in && !values.out ? "in" : values.out && !values.in ? "out" : "both";
  const opts: Parameters<typeof docLinks>[2] = { direction };
  if (values.pred) opts.predicates = values.pred.split(",").map((s) => s.trim());
  if (values.blocks) opts.blocks = true;
  const result = docLinks(ws.store, resolved.docId, opts);

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const e of [...result.out, ...result.in]) cli.io.out(e.node);
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  const g = render.g;
  if (result.out.length === 0 && result.in.length === 0) {
    io.err(style.dim("  no links"));
    return EXIT_OK;
  }
  if (result.out.length > 0) {
    io.out(style.dim("  out"));
    for (const e of result.out) io.out(`    ${style.accent(e.predicate)} ${style.dim(g.arrow)} ${style.id(e.node)} ${style.dim(`×${e.count}`)}`);
  }
  if (result.in.length > 0) {
    io.out(style.dim("  in (backlinks)"));
    for (const e of result.in) io.out(`    ${style.id(e.node)} ${style.dim(g.arrow)} ${style.accent(e.predicate)} ${style.dim(`×${e.count}`)}`);
  }
  return EXIT_OK;
}

export const cmdLinks: Command = { name: "links", summary: "Open edges touching a node", run: (cli, a) => runLinks(cli, a) };
