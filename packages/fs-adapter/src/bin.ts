#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { FsAdapter } from "./index.js";

// omgbase-fs-adapter — a stdio filesystem sync source (sync-plugins §4). The
// engine spawns this with the source config rendered to flags and speaks NDJSON:
//
//   handshake  → {"protocol":1,"capabilities":{identity,writeThrough,watch}}
//   request    ← {"id":n,"method":"enumerate|fetch|write|remove|watch|unwatch","params":{…}}
//   response   → {"id":n,"result":{…}}  | {"id":n,"error":"…"}
//   watch feed → {"event":"ready"}                (once, after the watch response, when
//                                                 chokidar's initial scan has completed —
//                                                 spec/sync §5 readiness, 1.2)
//              → {"event":"batch","paths":[…]}   (unsolicited, while watching)
//
// A host waits for `ready` before its priming sweep, so an edit landing while the
// scan runs is caught by the sweep and one landing after it by the feed.
// stdout carries ONLY protocol JSON; all logs go to stderr.

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    ext: { type: "string", multiple: true },
    "debounce-ms": { type: "string" },
  },
});
if (!values.root) {
  process.stderr.write("omgbase-fs-adapter: --root <path> is required\n");
  process.exit(2);
}

const adapter = new FsAdapter({
  root: values.root,
  ...(values.ext ? { ext: values.ext } : {}),
  ...(values["debounce-ms"] ? { debounceMs: Number(values["debounce-ms"]) } : {}),
});

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let watch: { stop(): Promise<void> } | null = null;

function handle(req: { id?: number; method?: string; params?: Record<string, unknown> }): void {
  const { id, method, params = {} } = req;
  try {
    switch (method) {
      case "enumerate":
        write({ id, result: { entries: adapter.enumerate() } });
        break;
      case "fetch":
        write({ id, result: { item: adapter.fetch(String(params.path)) } });
        break;
      case "write":
        adapter.write(String(params.path), String(params.content));
        write({ id, result: { ok: true } });
        break;
      case "remove":
        adapter.remove(String(params.path));
        write({ id, result: { ok: true } });
        break;
      case "watch": {
        if (!watch) {
          const w = adapter.watch((paths) => write({ event: "batch", paths }));
          watch = w;
          // `ready` after the response (below): the ack first, then the feed's readiness.
          void w.ready.then(() => { if (watch === w) write({ event: "ready" }); });
        }
        write({ id, result: { ok: true } });
        break;
      }
      case "unwatch":
        void watch?.stop();
        watch = null;
        write({ id, result: { ok: true } });
        break;
      default:
        write({ id, error: `unknown method: ${method}` });
    }
  } catch (err) {
    write({ id, error: (err as Error).message });
  }
}

function main(): void {
  write({ protocol: 1, capabilities: adapter.capabilities() });
  process.stderr.write(`[omgbase-fs-adapter] watching ${values.root}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(trimmed);
    } catch {
      write({ error: `invalid request JSON: ${trimmed.slice(0, 80)}` });
      return;
    }
    handle(req);
  });
  rl.on("close", () => {
    void watch?.stop().finally(() => process.exit(0));
    if (!watch) process.exit(0);
  });
}

main();
