import { parseArgs } from "node:util";
import { resolveRef, nodesGet, findDoc, docLinks, historyNode, docPropertiesMerged } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, renderHelp } from "../output.js";
import { expandBlockArgs } from "./_mutate.js";

// `omg show <node…|->` (11 §5.2) — the metadata card: attrs, placement, open
// edges, last change. `cat` is the bytes; `show` is the card. Several refs (or
// `-` = refs from stdin, one per line) print one card each — the hydrate step
// of `omg q … --ids | omg show -`.

/** One ref → its card payload (the --json object) and how to render it. */
interface ShowOne {
  payload: Record<string, unknown>;
  render(): void;
}

function showOne(cli: Cli, ref: string, include: string[]): ShowOne {
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved) throw new EngineErrorLike("doc_missing", `no node ${ref}`);

  if (resolved.kind === "document") {
    const info = findDoc(ws.store, { docId: resolved.docId })!;
    const links = docLinks(ws.store, resolved.docId, { direction: "both" });
    const properties = docPropertiesMerged(ws.store.db, resolved.docId);
    const payload = { kind: "document", id: info.docId, path: info.path, properties, edges: links };
    return { payload, render: () => renderDocCard(cli, info.path, properties, links) };
  }

  const node = nodesGet(ws.store, resolved.docId, resolved.blockId!, { resolution: "full" });
  if (!node) throw new EngineErrorLike("block_missing", `no block ${ref}`);
  const history = include.includes("history") ? historyNode(ws.store, resolved.blockId!, { limit: 5 }) : undefined;
  return { payload: { ...node, ...(history ? { history } : {}) }, render: () => renderBlockCard(cli, node, history) };
}

function runShow(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { include: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "show",
      summary: "Metadata card for a node: attrs, placement, open edges, last change (`cat` is the bytes)",
      usage: "show <node…|-> [--include history]",
      options: [
        ["<node…>", "one or more refs: a doc/block id, a path, or a locator"],
        ["-", `read refs from stdin, one per line (\`${cli.prog} q … --ids | ${cli.prog} show -\`)`],
        ["--include <list>", "comma-separated extras; `history` adds the block's last 5 changes"],
      ],
    });
  }
  const refs = expandBlockArgs(positionals);
  if (refs.length === 0) throw new CliUsageError("show requires a <node> (or - to read refs from stdin)");
  const include = (values.include ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const cards = refs.map((ref) => showOne(cli, ref, include));
  // One ref keeps the single-entity shape (→ @_, frame intact); several become a list.
  const single = cards.length === 1 ? cards[0]! : null;
  cli.capture?.(single ? single.payload : cards.map((c) => c.payload));
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(single ? single.payload : cards.map((c) => c.payload)));
    return EXIT_OK;
  }
  if (cli.flags.mode !== "human") {
    for (const c of cards) cli.io.out(JSON.stringify(c.payload));
    return EXIT_OK;
  }
  for (const c of cards) c.render();
  return EXIT_OK;
}

function renderDocCard(cli: Cli, path: string, fm: Record<string, unknown>, links: ReturnType<typeof docLinks>): void {
  const { render, style, io } = cli;
  io.out(render.wordmark(path));
  io.out(render.rule(40));
  const keys = Object.keys(fm);
  if (keys.length > 0) {
    io.out(`  ${style.dim("properties")}`);
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
