import { execPath } from "node:process";
import { createExternalSource, type SyncSource } from "@omgbase/core";
import { fsAdapterBinPath } from "@omgbase/fs-adapter";
import { connectEngine, type EngineSpec, type McpEngineClient } from "./mcp-engine-client.js";
import { Coordinator } from "./coordinator.js";

// runFsMirror (ADR-014): mirror a filesystem directory against an omgbase repo
// reached OVER MCP — the client/remote path shared by the `omgbase-sync` bin and
// `omg sync --server`. It connects to the MCP server (spawning a command over
// stdio, or reaching an http(s) URL over Streamable HTTP), opens the fs adapter as
// a source, and drives the Coordinator: one initial sync in (+ optional export
// out), then optionally stays live. The in-process/local path (no server) is
// handled by the CLI directly (freshness sweep / watcher); this is only the
// over-the-wire form.

export interface FsMirrorOptions {
  /** The engine to mirror into: a parsed `EngineSpec` (`parseEngineSpec` — an
   *  http(s) URL over Streamable HTTP, or a command over stdio), or a bare
   *  command argv such as ["omg","mcp","-C","/vault"] (always spawned). */
  server: EngineSpec | string[];
  /** Filesystem directory to mirror (absolute). */
  root: string;
  /** Stay live after the initial sync, mirroring edits as they land. */
  watch?: boolean;
  /** Also export engine-authored changes back to the directory. */
  out?: boolean;
  /** Diagnostics sink (stderr-style); defaults to no-op. */
  log?: (msg: string) => void;
}

/**
 * Run one filesystem↔engine mirror over MCP. Resolves when the initial sync (+
 * optional export) completes; in `watch` mode it resolves only after SIGINT/
 * SIGTERM, having torn down the source + engine. Throws on connect/spawn failure.
 */
export async function runFsMirror(opts: FsMirrorOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const spec: EngineSpec = Array.isArray(opts.server)
    ? { kind: "stdio", command: opts.server[0]!, args: opts.server.slice(1) }
    : opts.server;
  const engine: McpEngineClient = await connectEngine(spec);
  const source: SyncSource = await createExternalSource({ command: execPath, args: [fsAdapterBinPath(), "--root", opts.root] });
  const coord = new Coordinator(engine, source);

  const shutdown = async (): Promise<void> => {
    try {
      await source.close();
    } finally {
      await engine.close();
    }
  };

  try {
    const s = await coord.syncIn();
    log(`in: +${s.ingested.length} ingested, =${s.suppressed.length} unchanged, !${s.conflicted.length} conflicted, -${s.deleted.length} deleted`);
    if (opts.out) {
      const o = await coord.syncOut();
      log(`out: →${o.written.length} written, ✗${o.removed.length} removed`);
    }
    if (opts.watch) {
      const sub = await coord.watchIn({
        onSummary: (w) => log(`watch: +${w.ingested.length} =${w.suppressed.length} !${w.conflicted.length} -${w.deleted.length}`),
        onError: (err) => log(`watch error: ${String(err)}`),
      });
      if (!sub) {
        log("source cannot watch — nothing to do (did the initial sync above)");
        await shutdown();
        return;
      }
      log("watching — Ctrl-C to stop");
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void sub.stop().then(shutdown).then(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return;
    }
  } finally {
    if (!opts.watch) await shutdown();
  }
}
