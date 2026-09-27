import { parseArgs } from "node:util";
import { resolveRef, docLinks } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, emitMachine, renderHelp } from "../output.js";

// `omg links <node>` (11 §5.4) — open edges touching the node; default both
// directions, grouped; doc-grain by default, --blocks for block-grain (one row
// per edge, naming the source block). Backlinks = --in.

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
    return renderHelp(cli, {
      name: "links",
      summary: "Open edges touching a node, grouped by predicate (both directions by default)",
      usage: "links <node> [--in|--out] [--pred <p,p>] [--blocks]",
      options: [
        ["--in", "incoming edges only (backlinks)"],
        ["--out", "outgoing edges only"],
        ["--pred <p,p>", "keep only these predicates"],
        ["--blocks", "block-grain edges (default: doc-grain)"],
      ],
    });
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
  cli.capture?.(result); // shell: edges (out+in) become the addressable frame

  // `{ out, in }` is not a list: `--jsonl` prints the document; `--ids` the far nodes.
  if (cli.flags.mode !== "human") return emitMachine(cli, result, { ids: [...result.out, ...result.in].map((e) => e.node) });

  const { render, style, io } = cli;
  const g = render.g;
  if (result.out.length === 0 && result.in.length === 0) {
    io.err(style.dim("  no links"));
    return EXIT_OK;
  }
  // Doc-grain: one row per (predicate, node) with its rollup count. Block-grain:
  // one row per edge, the source block beside the far node.
  const src = (e: { block?: string | null }): string => style.dim(`(${e.block ?? "frontmatter"})`);
  if (result.out.length > 0) {
    io.out(style.dim("  out"));
    for (const e of result.out) {
      if (values.blocks) io.out(`    ${style.accent(e.predicate)} ${style.dim(g.arrow)} ${style.id(e.node)} ${src(e)}`);
      else io.out(`    ${style.accent(e.predicate)} ${style.dim(g.arrow)} ${style.id(e.node)} ${style.dim(`×${e.count}`)}`);
    }
  }
  if (result.in.length > 0) {
    io.out(style.dim("  in (backlinks)"));
    for (const e of result.in) {
      if (values.blocks) io.out(`    ${style.id(e.node)} ${src(e)} ${style.dim(g.arrow)} ${style.accent(e.predicate)}`);
      else io.out(`    ${style.id(e.node)} ${style.dim(g.arrow)} ${style.accent(e.predicate)} ${style.dim(`×${e.count}`)}`);
    }
  }
  return EXIT_OK;
}

export const cmdLinks: Command = { name: "links", summary: "Open edges touching a node", run: (cli, a) => runLinks(cli, a) };
