import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { oqxRun } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { truncationFooter, EXIT_OK } from "../output.js";

// `omg oqx <source>` — OQX composable query (structural + section navigation +
// ad-hoc correlation: receiver-constrained nested queries, a boolean where tree
// over scalar predicates and collection ops, count comparisons, nestable
// collect, one-scope lifts (^name:) that filter + capture, one-scope-outward
// references (^name) that correlate a nested query to a parent binding, explicit
// root relations repo.docs/nodes/blocks for join-equivalents, and first/single
// lookups). Coexists with `omg q` (CEL). Source is a positional string or -f
// file|-. Human output: one hit per line (id + path); --json/--jsonl/--ids.

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function runOqx(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      cursor: { type: "string" },
      file: { type: "string", short: "f" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  oqx <source> [-n N] [--cursor c] [-f file|-]");
    cli.io.out("  e.g. oqx 'from docs where nodes.count(where kind == \"md:task\") >= 2'");
    cli.io.out("       oqx 'from nodes where kind == \"md:section\" select items: section.blocks.collect(where type == \"list_item\")'");
    cli.io.out("       oqx 'from docs where nodes.collect(^open: value where kind == \"md:task\" && !attrs.checked) select $path, open'");
    cli.io.out("       oqx 'from docs select owner_id, owner: repo.nodes.single(where kind == \"person\" && attrs.id == ^owner_id)'");
    return EXIT_OK;
  }

  const source = values.file
    ? (values.file === "-" ? readStdin() : readFileSync(values.file, "utf8"))
    : positionals.join(" ").trim();
  if (!source) {
    cli.io.err(cli.style.dim("  usage: oqx <source>  (or -f file|-)"));
    return EXIT_OK;
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);

  const opts: { limit?: number; cursor?: string } = {};
  if (values.n) opts.limit = Number(values.n);
  if (values.cursor) opts.cursor = values.cursor;

  const result = oqxRun(ws.store, repo.repoId, source, opts);

  if (cli.flags.mode === "ids") {
    for (const h of result.hits) cli.io.out(h.id);
    if (result.truncated) truncationFooter(cli.io, cli.style, result.cursor ?? "");
    return EXIT_OK;
  }
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const h of result.hits) cli.io.out(JSON.stringify(h));
    if (result.truncated) truncationFooter(cli.io, cli.style, result.cursor ?? "");
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (result.hits.length === 0) {
    io.err(style.dim("  no hits"));
    return EXIT_OK;
  }
  for (const h of result.hits) {
    io.out(`${style.id(h.id)}  ${style.accent(h.path)}`.trimEnd());
  }
  if (result.truncated) truncationFooter(io, style, result.cursor ?? "");
  return EXIT_OK;
}

export const cmdOqx: Command = {
  name: "oqx",
  summary: "Composable query (OQX: from/where/select + collection ops)",
  run: (cli, a) => runOqx(cli, a),
};
