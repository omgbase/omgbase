#!/usr/bin/env node
import { execPath } from "node:process";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createExternalSource, type SyncSource } from "@omgbase/core";
import { fsAdapterBinPath } from "@omgbase/fs-adapter";
import { connectStdioEngine, type McpEngineClient } from "./mcp-engine-client.js";
import { Coordinator } from "./coordinator.js";

// `omgbase-sync` — the standalone synchronizer (ADR-014 §10 D4). Mirrors a
// filesystem directory against an omgbase repo served over MCP: it spawns the
// MCP server (default `omg mcp -C <root>`), opens the fs adapter as a source,
// and runs one initial sync (+ optional export, + optional live watch).
//
//   omgbase-sync --root ./vault              # ingest the tree into the served repo
//   omgbase-sync --root ./vault --out        # also export engine-authored changes back
//   omgbase-sync --root ./vault --watch      # stay live: mirror edits as they land
//   omgbase-sync --root ./vault --server "omg mcp -C ./vault"   # custom server command

function log(msg: string): void {
  process.stderr.write(`[omgbase-sync] ${msg}\n`);
}

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
  const serverArgv = (values.server ?? `omg mcp -C ${root}`).split(/\s+/).filter(Boolean);
  const engine: McpEngineClient = await connectStdioEngine({ command: serverArgv[0]!, args: serverArgv.slice(1) });
  const source: SyncSource = await createExternalSource({ command: execPath, args: [fsAdapterBinPath(), "--root", root] });
  const coord = new Coordinator(engine, source);

  const shutdown = async (): Promise<void> => {
    try {
      await source.close();
    } finally {
      await engine.close();
    }
  };

  try {
    const inSummary = await coord.syncIn();
    log(`in: +${inSummary.ingested.length} ingested, =${inSummary.suppressed.length} unchanged, !${inSummary.conflicted.length} conflicted, -${inSummary.deleted.length} deleted`);
    if (values.out) {
      const out = await coord.syncOut();
      log(`out: →${out.written.length} written, ✗${out.removed.length} removed`);
    }
    if (values.watch) {
      const sub = await coord.watchIn({
        onSummary: (s) => log(`watch: +${s.ingested.length} =${s.suppressed.length} !${s.conflicted.length} -${s.deleted.length}`),
        onError: (err) => log(`watch error: ${String(err)}`),
      });
      if (!sub) {
        log("source cannot watch — nothing to do (did the initial sync above)");
        await shutdown();
        return;
      }
      log("watching — Ctrl-C to stop");
      await new Promise<void>((resolveWait) => {
        const stop = (): void => {
          void sub.stop().then(shutdown).then(resolveWait);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      return;
    }
  } finally {
    if (!values.watch) await shutdown();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[omgbase-sync] fatal: ${String(err)}\n`);
  process.exit(1);
});
