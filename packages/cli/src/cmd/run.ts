import { parseArgs } from "node:util";
import { resolveRef, findDoc, loadDocBlocks, blockRaw, oqxRun, oqxRunAsync, collectSemanticPhrases, type EmbedQuery, type BlockNode } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, truncationFooter, EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";

// `omg run <locator|path>` (11 §5.3) — evaluate the first ```omg fence in a doc
// (or the fence at a block locator) and print its results. The fence body is an
// OQX source string (the same language `omg oqx` runs). Strictly read-and-print:
// fences stay INERT in the corpus (ADR-011 §8) — nothing is projected or written.

function firstOmgFence(roots: BlockNode[]): BlockNode | null {
  for (const n of roots) {
    if (n.type === "code_fence" && n.attrs.lang === "omg") return n;
    const inner = firstOmgFence(n.children);
    if (inner) return inner;
  }
  return null;
}

// Strip the ``` fences from a code-fence block's raw, returning the body.
function fenceBody(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.trimStart().startsWith("```")) lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines[lines.length - 1]?.trimStart().startsWith("```")) lines.pop();
  return lines.join("\n");
}

async function runRun(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) {
    cli.io.err("  run <locator|path>  — evaluate the first ```omg fence (OQX source) in a doc and print results (inert)");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("run requires a <locator|path>");

  const ws = cli.workspace();
  const repo = cli.repo(ws);

  // A block ref runs that fence; a doc/path ref runs the doc's first omg fence.
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved) throw new EngineErrorLike("doc_missing", `no node ${ref}`);

  let fenceRaw: string | null = null;
  if (resolved.kind === "block") {
    const roots = loadDocBlocks(ws.store, resolved.docId);
    const find = (nodes: BlockNode[]): BlockNode | null => {
      for (const n of nodes) {
        if (n.blockId === resolved.blockId) return n;
        const inner = find(n.children);
        if (inner) return inner;
      }
      return null;
    };
    const node = find(roots);
    if (!node || node.type !== "code_fence") throw new EngineErrorLike("opaque_block", `block ${ref} is not an omg fence`);
    fenceRaw = blockRaw(ws.store, node.rawHashHex);
  } else {
    const info = findDoc(ws.store, { docId: resolved.docId })!;
    void info;
    const fence = firstOmgFence(loadDocBlocks(ws.store, resolved.docId));
    if (!fence) throw new EngineErrorLike("target_missing", `no \`\`\`omg fence in ${ref}`);
    fenceRaw = blockRaw(ws.store, fence.rawHashHex);
  }

  const source = fenceBody(fenceRaw).trim();
  if (!source) throw new EngineErrorLike("target_missing", `the omg fence in ${ref} is empty`);

  // Same execution path as `omg oqx`: load the embedder only when the fence uses
  // semantic(...); everything else runs on the sync core.
  const phrases = collectSemanticPhrases(source);
  let result;
  if (phrases.length > 0) {
    const loaded = await loadEmbedding(ws, repo.repoId);
    if (!loaded) {
      throw new EngineErrorLike("semantic_unavailable", "semantic(...) needs an embedding provider", {
        hint: "omg config set embedding.provider <command|url>",
      });
    }
    try {
      const embed: EmbedQuery = async (t) => ({ model: loaded.provider.model, vec: await loaded.worker.embedQuery(t) });
      result = await oqxRunAsync(ws.store, repo.repoId, source, {}, embed);
    } finally {
      await loaded.close();
    }
  } else {
    result = oqxRun(ws.store, repo.repoId, source);
  }

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  if (result.consumer === "count" || result.consumer === "exists") {
    cli.io.out(result.consumer === "count" ? String(result.count) : String(result.exists));
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const h of result.hits) cli.io.out(h.id);
    return EXIT_OK;
  }
  const { style, io } = cli;
  if (result.hits.length === 0) {
    io.err(style.dim("  no hits"));
    return EXIT_OK;
  }
  for (const h of result.hits) {
    const preview = typeof h.text === "string" ? String(h.text).split("\n")[0] : "";
    io.out(`${style.id(h.id)}  ${style.accent(h.path)}  ${preview}`.trimEnd());
  }
  if (result.truncated) truncationFooter(io, style, result.cursor ?? "");
  return EXIT_OK;
}

export const cmdRun: Command = { name: "run", summary: "Evaluate an ```omg fence (OQX, inert, read-only)", run: (c, a) => runRun(c, a) };
