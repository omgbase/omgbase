import { parseArgs } from "node:util";
import { resolveRef, nodesGet, findDoc, docLinks, historyNode } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg show <node>` (11 §5.2) — the metadata card: attrs, placement, open
// edges, last change. `cat` is the bytes; `show` is the card.

function runShow(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { include: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.out("  show <node> [--include edges,history]  — metadata card (attrs, placement, edges, last change)");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("show requires a <node>");
  const include = (values.include ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved) throw new EngineErrorLike("doc_missing", `no node ${ref}`);

  if (resolved.kind === "document") {
    const info = findDoc(ws.store, { docId: resolved.docId })!;
    const links = docLinks(ws.store, resolved.docId, { direction: "both" });
    const payload = { kind: "document", id: info.docId, path: info.path, metadata: info.metadata, edges: links };
    if (cli.flags.mode !== "human") {
      cli.io.out(JSON.stringify(payload));
      return EXIT_OK;
    }
    renderDocCard(cli, info.path, info.metadata, links);
    return EXIT_OK;
  }

  const node = nodesGet(ws.store, resolved.docId, resolved.blockId!, { resolution: "full" });
  if (!node) throw new EngineErrorLike("block_missing", `no block ${ref}`);
  const history = include.includes("history") ? historyNode(ws.store, resolved.blockId!, { limit: 5 }) : undefined;
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ ...node, ...(history ? { history } : {}) }));
    return EXIT_OK;
  }
  renderBlockCard(cli, node, history);
  return EXIT_OK;
}

function renderDocCard(cli: Cli, path: string, fm: Record<string, unknown>, links: ReturnType<typeof docLinks>): void {
  const { render, style, io } = cli;
  io.out(render.wordmark(path));
  io.out(render.rule(40));
  const keys = Object.keys(fm);
  if (keys.length > 0) {
    io.out(`  ${style.dim("frontmatter")}`);
    for (const k of keys) io.out(`    ${style.accent(k)} ${style.dim("=")} ${fmt(fm[k])}`);
  }
  if (links.out.length > 0) {
    io.out(`  ${style.dim("out edges")}`);
    for (const e of links.out) io.out(`    ${style.accent(e.predicate)} ${style.dim(render.g.arrow)} ${style.id(e.node)} ${style.dim(`×${e.count}`)}`);
  }
  if (links.in.length > 0) {
    io.out(`  ${style.dim("backlinks")}`);
    for (const e of links.in) io.out(`    ${style.id(e.node)} ${style.dim(render.g.arrow)} ${style.accent(e.predicate)} ${style.dim(`×${e.count}`)}`);
  }
}

function renderBlockCard(cli: Cli, node: import("@omgbase/core").GetNode, history?: import("@omgbase/core").NodeChange[]): void {
  const { render, style, io } = cli;
  io.out(`  ${render.typeGlyph(node.type)} ${style.bold(node.type)}  ${style.id(node.id)}`);
  io.out(render.rule(40));
  if (node.placement) io.out(`  ${style.dim("placement")}  parent=${style.id(node.placement.parent ?? "—")} ordinal=${node.placement.ordinal} depth=${node.placement.depth}`);
  if (node.attrs && Object.keys(node.attrs).length > 0) {
    io.out(`  ${style.dim("attrs")}`);
    for (const [k, v] of Object.entries(node.attrs)) io.out(`    ${style.accent(k)} ${style.dim("=")} ${fmt(v)}`);
  }
  if (node.text) io.out(`  ${style.dim("text")}  ${node.text}`);
  if (history && history.length > 0) {
    io.out(`  ${style.dim("history")}`);
    for (const h of history) io.out(`    ${style.dim(`#${h.seq}`)} ${style.accent(h.kind)} ${style.dim(h.origin)} ${style.dim(h.ts)}`);
  }
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export const cmdShow: Command = { name: "show", summary: "Metadata card for a node", run: (cli, a) => runShow(cli, a) };
