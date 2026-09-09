import { parseArgs } from "node:util";
import { nodeSet, editablePropsFor } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";
import { runOps } from "./_mutate.js";

// `omg node set <nodeId> <prop> <value>` (node-editability) — surgically set an
// editable property of a projected node (e.g. a link's text/target, a task's
// checked). Resolves node → block via the adapter's registered editor and
// applies one update op. `omg node props <nodeId>` reports what's editable.

function nodeKindFormat(cli: Cli, nodeId: string): { kind: string; format: string } {
  const ws = cli.workspace();
  const row = ws.store.db.prepare(
    "SELECT n.kind AS kind, d.format AS format FROM nodes n JOIN docs d ON d.doc_id = n.doc_id WHERE n.node_id = ?",
  ).get(nodeId) as { kind: string; format: string } | undefined;
  if (!row) throw new EngineErrorLike("block_missing", `no node ${nodeId}`);
  return row;
}

function runNode(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || rest.includes("--help")) {
    cli.io.err("  node set <nodeId> <prop> <value>   — set an editable node property (surgical)");
    cli.io.err("  node props <nodeId>                — list a node's editable properties");
    return EXIT_OK;
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);

  if (sub === "props") {
    const nodeId = rest[0];
    if (!nodeId) throw new CliUsageError("node props <nodeId>");
    const { kind, format } = nodeKindFormat(cli, nodeId);
    const props = editablePropsFor(format, kind);
    if (cli.flags.mode !== "human") { cli.io.out(JSON.stringify({ node: nodeId, kind, editable: props })); return EXIT_OK; }
    if (props.length === 0) cli.io.err(cli.style.dim(`  ${kind} has no editable properties`));
    else cli.io.out(`  ${cli.style.accent(kind)} ${cli.style.dim("editable:")} ${props.join(", ")}`);
    return EXIT_OK;
  }

  if (sub === "set") {
    parseArgs({ args: rest, allowPositionals: true, options: { actor: { type: "string" } } });
    const [nodeId, prop, ...valueParts] = rest.filter((a) => !a.startsWith("--"));
    if (!nodeId || !prop || valueParts.length === 0) throw new CliUsageError("node set <nodeId> <prop> <value>");
    const value = valueParts.join(" ");
    const ops = nodeSet(ws.store, nodeId, prop, value);
    return runOps(cli, ws, repo, ops, { reason: `node_set ${prop}` });
  }

  throw new CliUsageError(`unknown node subcommand '${sub}' (set|props)`);
}

export const cmdNode: Command = { name: "node", summary: "Edit a node's editable properties (surgical)", run: (c, a) => runNode(c, a) };
