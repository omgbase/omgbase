import { parseArgs } from "node:util";
import { findDoc, docsOutline, type OutlineResult } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, truncationFooter, EXIT_OK, renderHelp } from "../output.js";
import { remoteCall } from "./_remote.js";

// `omg outline <doc|path>` (alias ol) — the wire format (06 §6). Human output
// prints the outline text with full block ids inline; --json emits the
// OutlineResult verbatim.

async function runOutline(cli: Cli, args: string[]): Promise<number> {
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
    return renderHelp(cli, {
      name: "outline",
      summary: "A document's outline with block ids inline (frozen wire format) — the orientation view",
      usage: "outline <doc|path> [--depth <n>] [--section <locator>] [--skeleton]",
      options: [
        ["--depth <n>", "limit heading depth"],
        ["--section <locator>", "outline only the section at a locator"],
        ["--skeleton", "structure only, no text"],
      ],
    });
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("outline requires a <doc|path>");

  let result: OutlineResult;
  let header: string;
  if (cli.flags.server) {
    // Remote: the docs_outline tool resolves the ref + returns the same
    // OutlineResult. The header shows the ref you passed (no local path lookup).
    result = await remoteCall<OutlineResult>(cli, "docs_outline", {
      doc: ref,
      ...(values.depth ? { depth: Number(values.depth) } : {}),
      ...(values.skeleton ? { resolution: "skeleton" } : {}),
    });
    header = ref;
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    const info = ref.startsWith("d_") ? findDoc(ws.store, { docId: ref }) : findDoc(ws.store, { repoId: repo.repoId, path: ref });
    if (!info) throw new EngineErrorLike("doc_missing", `no document ${ref}`);
    const opts: Parameters<typeof docsOutline>[2] = {};
    if (values.depth) opts.depth = Number(values.depth);
    if (values.skeleton) opts.resolution = "skeleton";
    result = docsOutline(ws.store, info.docId, opts);
    header = info.path;
  }

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  io.out(render.wordmark(header));
  io.out(render.rule(40));
  // Colorize the inline block ids + § marks.
  for (const line of result.text.split("\n")) {
    io.out(colorizeOutline(line, style));
  }
  if (result.truncated) truncationFooter(io, style, "budget");
  return EXIT_OK;
}

function colorizeOutline(line: string, style: import("../style.js").Style): string {
  // leading block id (b_…) → id style; trailing ` §` → accent.
  return line
    .replace(/\bb_[0-9a-z]+\b/, (m) => style.id(m))
    .replace(/§/g, style.accent("§"));
}

export const cmdOutline: Command = {
  name: "outline",
  aliases: ["ol"],
  summary: "Document outline (frozen wire format)",
  run: (cli, a) => runOutline(cli, a),
};
