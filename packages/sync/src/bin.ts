#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runFsMirror } from "./mirror.js";

// `omgbase-sync` — the standalone synchronizer (ADR-014). A thin wrapper over
// `runFsMirror`: mirror a filesystem directory against an omgbase repo served
// over MCP (default server `omg mcp -C <root>`). Identical to `omg sync
// --server <cmd>` for callers that don't ship the full `omg` CLI.
//
//   omgbase-sync --root ./vault              # ingest the tree into the served repo
//   omgbase-sync --root ./vault --out        # also export engine-authored changes back
//   omgbase-sync --root ./vault --watch      # stay live: mirror edits as they land
//   omgbase-sync --root ./vault --server "omg mcp -C ./vault"   # custom / remote server command

function usage(): void {
  process.stderr.write(
    "usage: omgbase-sync --root <dir> [--server \"<cmd>\"] [--out] [--watch]\n" +
      "  --root <dir>     filesystem directory to mirror (required)\n" +
      "  --server <cmd>   MCP server command to spawn (default: omg mcp -C <root>)\n" +
      "  --out            also export engine-authored changes back to the directory\n" +
      "  --watch          stay live and mirror edits as they land\n",
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      server: { type: "string" },
      out: { type: "boolean" },
      watch: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.root) {
    usage();
    process.exit(values.help ? 0 : 2);
  }

  const root = resolve(values.root);
  const server = (values.server ?? `omg mcp -C ${root}`).split(/\s+/).filter(Boolean);
  await runFsMirror({
    server,
    root,
    ...(values.watch ? { watch: true } : {}),
    ...(values.out ? { out: true } : {}),
    log: (msg) => process.stderr.write(`[omgbase-sync] ${msg}\n`),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`[omgbase-sync] fatal: ${String(err)}\n`);
  process.exit(1);
});
