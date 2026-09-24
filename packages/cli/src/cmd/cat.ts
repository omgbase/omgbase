import { parseArgs } from "node:util";
import { resolveRef, nodesGet, docsRead } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, renderHelp } from "../output.js";
import { remoteCall } from "./_remote.js";
import { expandBlockArgs } from "./_mutate.js";

// `omg cat <node…|->` (11 §5.2) — content only, default raw exact bytes, pipe-clean.
// For a document ref, cats the whole rendered document; for a block, the block
// (subtree at raw). No decoration on stdout: cat is the bytes. Several refs (or
// `-` = refs from stdin, one per line — the counterpart of `--ids`, same
// convention as the mutators) are cat'ed in order, like unix cat.
//
// Refs are what `resolveRef` accepts: a block/doc/node id or a repo-relative
// document path. `--resolution` is a block-level notion (nodes_get); a document
// is always its exact bytes (docs_read has no resolution ladder), so asking for
// another resolution on a document ref is warned about, not silently ignored.

type Resolution = "raw" | "text" | "outline" | "skeleton" | "full";

/** One ref → its bytes (human), its --json payload, and what the shell captures. */
interface CatOne {
  text: string;
  json: unknown;
  capture: unknown;
}

/** `--resolution` only means something for a block; say so (stderr) rather than
 *  silently handing back raw bytes as if the flag had applied. */
function warnDocResolution(cli: Cli, ref: string, resolution: Resolution): void {
  if (resolution === "raw") return;
  cli.io.err(cli.style.warn(`  --resolution ${resolution} ignored for ${ref}: a document is always its exact bytes (resolutions apply to block refs)`));
}

async function catOne(cli: Cli, ref: string, resolution: Resolution): Promise<CatOne> {
  // Remote: the polymorphic `read_ref` tool classifies + reads server-side.
  if (cli.flags.server) {
    const r = await remoteCall<Record<string, unknown> & { kind: string }>(cli, "read_ref", { ref, ...(resolution !== "raw" ? { resolution } : {}) });
    if (r.kind === "document") {
      warnDocResolution(cli, ref, resolution);
      return { text: String(r.content ?? ""), json: { doc: r.docId, path: r.path, content: r.content }, capture: r.content };
    }
    return { text: String(r.raw ?? r.text ?? r.label ?? ""), json: r, capture: r };
  }

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
    warnDocResolution(cli, ref, resolution);
    // shell: the bytes (a string; @_ only)
    return { text: res.content, json: { doc: res.docId, path: res.path, content: res.content }, capture: res.content };
  }

  const node = nodesGet(ws.store, resolved.docId, resolved.blockId!, { resolution });
  if (!node) throw new EngineErrorLike("block_missing", `no block ${ref}`);
  // shell: the block (single entity)
  return { text: node.raw ?? node.text ?? node.label ?? "", json: node, capture: node };
}

async function runCat(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { resolution: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "cat",
      summary: "Content bytes of a node — exact raw bytes by default, pipe-clean (`show` is the metadata card)",
      usage: "cat <node…|-> [--resolution raw|text|outline|skeleton|full]",
      options: [
        ["<node…>", "one or more refs: a block id (`b_…`), a doc id (`d_…`), a node id (`n_…`), or a repo-relative doc path (`notes/x.md`)"],
        ["-", `read refs from stdin, one per line (\`${cli.prog} q … --ids | ${cli.prog} cat -\`)`],
        ["--resolution <r>", "block refs only: raw (default: exact bytes) | text | outline | skeleton | full; a document is always its exact bytes (warns if given)"],
      ],
    });
  }
  const refs = expandBlockArgs(positionals);
  if (refs.length === 0) throw new CliUsageError("cat requires a <node> (or - to read refs from stdin)");
  const resolution = (values.resolution ?? "raw") as Resolution;

  const results: CatOne[] = [];
  for (const ref of refs) results.push(await catOne(cli, ref, resolution));

  // One ref keeps the single-entity shape (a string/object); several become a list.
  const single = results.length === 1 ? results[0]! : null;
  cli.capture?.(single ? single.capture : results.map((r) => r.capture));

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(single ? single.json : results.map((r) => r.json)));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const r of results) cli.io.out(JSON.stringify(r.json));
    return EXIT_OK;
  }
  for (const r of results) cli.io.out(r.text);
  return EXIT_OK;
}

export const cmdCat: Command = { name: "cat", summary: "Content bytes of a node (default raw)", run: (cli, a) => runCat(cli, a) };
