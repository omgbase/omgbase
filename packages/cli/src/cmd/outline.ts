import { parseArgs } from "node:util";
import { findDoc, docsOutline } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, truncationFooter, EXIT_OK } from "../output.js";

// `omg outline <doc|path>` (alias ol) — the frozen wire format (06 §6). Human
// output prints the outline text + the ids alias table; --json emits the
// OutlineResult verbatim.

function runOutline(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      depth: { type: "string" },
      section: { type: "string" },
      skeleton: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  outline <doc|path> [--depth n] [--skeleton]  — document outline (frozen wire format)");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("outline requires a <doc|path>");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const info = ref.startsWith("d_") ? findDoc(ws.store, { docId: ref }) : findDoc(ws.store, { repoId: repo.repoId, path: ref });
  if (!info) throw new EngineErrorLike("doc_missing", `no document ${ref}`);

  const opts: Parameters<typeof docsOutline>[2] = {};
  if (values.depth) opts.depth = Number(values.depth);
  if (values.skeleton) opts.resolution = "skeleton";
  const result = docsOutline(ws.store, info.docId, opts);

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  io.out(render.wordmark(info.path));
  io.out(render.rule(40));
  // The outline text is the frozen format; colorize alias ids (dim) + § marks.
  for (const line of result.text.split("\n")) {
    io.out(colorizeOutline(line, style));
  }
  // ids alias table trailer.
  io.out("");
  io.out(style.dim("  ids:"));
  for (const [alias, id] of Object.entries(result.ids)) {
    io.out(`    ${style.accent(alias)} ${style.dim("→")} ${style.id(id)}`);
  }
  if (result.truncated) truncationFooter(io, style, "budget");
  return EXIT_OK;
}

// eslint-disable-next-line no-control-regex
function colorizeOutline(line: string, style: import("../style.js").Style): string {
  // leading `  b01 ` alias → dim; trailing ` §` → accent.
  return line
    .replace(/\b(b\d{2,})\b/, (m) => style.id(m))
    .replace(/§/g, style.accent("§"));
}

export const cmdOutline: Command = {
  name: "outline",
  aliases: ["ol"],
  summary: "Document outline (frozen wire format)",
  run: (cli, a) => runOutline(cli, a),
};
