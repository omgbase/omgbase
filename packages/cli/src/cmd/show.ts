import { parseArgs } from "node:util";
import { resolveRef, nodesGet, docsRead, docLinks, historyNode, docPropertiesMerged } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, emitMachine, renderHelp } from "../output.js";
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
    // The card reads the merged properties + open links; `--json` is the
    // `docs_read` result tagged with its kind (`{ kind: "document", ...docs_read }`).
    const res = docsRead(ws.store, resolved.docId);
    if (!res) throw new EngineErrorLike("doc_missing", `no document ${ref}`);
    const links = docLinks(ws.store, resolved.docId, { direction: "both" });
    // The authored keys, merged (frontmatter + inline — the `_data` view); the
    // computed rows are rendered under their surface names (`_title`/`_tags`,
    // spec/surface §1.2, 5.0 — the store's `$title`/`$tags` keys never reach the
    // terminal) from the re-keyed `properties.computed` the read carries.
    const properties = Object.fromEntries(Object.entries(docPropertiesMerged(ws.store.db, resolved.docId)).filter(([k]) => !k.startsWith("$")));
    const computed = res.properties.computed ?? {};
    const payload = { kind: "document", ...res };
    return { payload, render: () => renderDocCard(cli, res._path, properties, computed, links) };
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
      summary: "Metadata card for a node: attrs, placement, open links, last change (`cat` is the bytes)",
      usage: "show <node…|-> [--include history]",
      options: [
        ["<node…>", "one or more refs: a block id (`b_…`), a doc id (`d_…`), a node id (`n_…`), or a doc path (`/notes/x.md`; the leading `/` is optional)"],
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
  if (cli.flags.mode !== "human") {
    const docs = cards.map((c) => c.payload);
    return single ? emitMachine(cli, single.payload) : emitMachine(cli, docs, { items: docs });
  }
  for (const c of cards) c.render();
  return EXIT_OK;
}

function renderDocCard(cli: Cli, path: string, fm: Record<string, unknown>, computed: Record<string, unknown>, links: ReturnType<typeof docLinks>): void {
  const { render, style, io } = cli;
  io.out(render.wordmark(path));
  io.out(render.rule(40));
  const keys = Object.keys(fm);
  if (keys.length > 0) {
    io.out(`  ${style.dim("properties")}`);
    for (const k of keys) io.out(`    ${style.accent(k)} ${style.dim("=")} ${fmt(fm[k])}`);
  }
  // The computed rows under their surface names (`_title`, `_tags` — spec/surface
  // §1.2, 5.0), their own section so a computed title never masquerades as authored.
  const computedKeys = Object.keys(computed);
  if (computedKeys.length > 0) {
    io.out(`  ${style.dim("computed")}`);
    for (const k of computedKeys) io.out(`    ${style.accent(k)} ${style.dim("=")} ${fmt(computed[k])}`);
  }
  if (links.out.length > 0) {
    io.out(`  ${style.dim("out links")}`);
    for (const e of links.out) io.out(`    ${style.accent(e._predicate)} ${style.dim(render.g.arrow)} ${style.id(e._doc_id)} ${style.dim(`×${e.count}`)}`);
  }
  if (links.in.length > 0) {
    io.out(`  ${style.dim("backlinks")}`);
    for (const e of links.in) io.out(`    ${style.id(e._doc_id)} ${style.dim(render.g.arrow)} ${style.accent(e._predicate)} ${style.dim(`×${e.count}`)}`);
  }
}

function renderBlockCard(cli: Cli, node: import("@omgbase/core").GetNode, history?: import("@omgbase/core").NodeChange[]): void {
  const { render, style, io } = cli;
  io.out(`  ${render.typeGlyph(node._type)} ${style.bold(node._type)}  ${style.id(node._id)}`);
  io.out(render.rule(40));
  // The placement is flattened onto the row (5.0: `parent_id`/`_ordinal`/`_depth`); the line reads the same.
  if (node._ordinal !== undefined) io.out(`  ${style.dim("placement")}  parent=${style.id(node.parent_id ?? "—")} ordinal=${node._ordinal} depth=${node._depth}`);
  if (node._attrs && Object.keys(node._attrs).length > 0) {
    io.out(`  ${style.dim("attrs")}`);
    for (const [k, v] of Object.entries(node._attrs)) io.out(`    ${style.accent(k)} ${style.dim("=")} ${fmt(v)}`);
  }
  if (node._text) io.out(`  ${style.dim("text")}  ${node._text}`);
  if (history && history.length > 0) {
    io.out(`  ${style.dim("history")}`);
    for (const h of history) io.out(`    ${style.dim(`#${h.seq}`)} ${style.accent(h.kind)} ${style.dim(h.origin)} ${style.dim(h.ts)}`);
  }
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export const cmdShow: Command = { name: "show", summary: "Metadata card for a node", run: (cli, a) => runShow(cli, a) };
