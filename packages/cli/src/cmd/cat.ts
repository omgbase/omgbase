import { parseArgs } from "node:util";
import { resolveRef, nodesGet, docsRead } from "@omgbase/core";
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
    // Cat the whole document byte-for-byte via the faithful reconstructor
    // (leading trivia + frontmatter + each top-level block's raw + its trivia).
    // This is the same content docs_read returns and what ingest's convergence
    // check asserts against — never a hand-rolled block join (which dropped
    // trivia and mangled spacing).
    const res = docsRead(ws.store, resolved.docId);
    if (!res) throw new EngineErrorLike("doc_missing", `no document ${ref}`);
    cli.capture?.(res.content); // shell: the bytes (a string; @_ only)
    if (cli.flags.mode === "json") {
      cli.io.out(JSON.stringify({ doc: res.docId, path: res.path, content: res.content }));
    } else {
      cli.io.out(res.content);
    }
    return EXIT_OK;
  }

  const node = nodesGet(ws.store, resolved.docId, resolved.blockId!, { resolution });
  if (!node) throw new EngineErrorLike("block_missing", `no block ${ref}`);
  cli.capture?.(node); // shell: the block (single entity)
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(node));
    return EXIT_OK;
  }
  cli.io.out(node.raw ?? node.text ?? node.label ?? "");
  return EXIT_OK;
}

export const cmdCat: Command = { name: "cat", summary: "Content bytes of a node (default raw)", run: (cli, a) => runCat(cli, a) };
