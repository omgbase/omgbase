import { parseArgs } from "node:util";
import { resolveRef, nodesGet, blockRaw, loadDocBlocks, findDoc } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg cat <node>` (11 §5.2) — content only, default raw exact bytes, pipe-clean.
// For a document ref, cats the whole rendered document; for a block, the block
// (subtree at raw). No decoration on stdout: cat is the bytes.

function runCat(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { resolution: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.out("  cat <node> [--resolution raw|text|outline|skeleton|full]  — content bytes");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("cat requires a <node>");
  const resolution = (values.resolution ?? "raw") as "raw" | "text" | "outline" | "skeleton" | "full";

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved) throw new EngineErrorLike("doc_missing", `no node ${ref}`);

  if (resolved.kind === "document") {
    // Cat the whole document: concatenate block raws in order.
    const info = findDoc(ws.store, { docId: resolved.docId })!;
    const roots = loadDocBlocks(ws.store, resolved.docId);
    const parts: string[] = [];
    const walk = (nodes: typeof roots): void => {
      for (const n of nodes) {
        parts.push(blockRaw(ws.store, n.rawHashHex));
        walk(n.children);
      }
    };
    walk(roots);
    if (cli.flags.mode === "json") {
      cli.io.out(JSON.stringify({ doc: resolved.docId, path: info.path, content: parts.join("\n") }));
    } else {
      cli.io.out(parts.join("\n"));
    }
    return EXIT_OK;
  }

  const node = nodesGet(ws.store, resolved.docId, resolved.blockId!, { resolution });
  if (!node) throw new EngineErrorLike("block_missing", `no block ${ref}`);
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(node));
    return EXIT_OK;
  }
  cli.io.out(node.raw ?? node.text ?? node.label ?? "");
  return EXIT_OK;
}

export const cmdCat: Command = { name: "cat", summary: "Content bytes of a node (default raw)", run: (cli, a) => runCat(cli, a) };
