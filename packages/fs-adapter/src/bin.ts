#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { FsAdapter } from "./index.js";

// omgbase-fs-adapter — a stdio filesystem sync source (13-sync-plugins §4). The
// engine spawns this with the source config rendered to flags and speaks NDJSON:
//
//   handshake  → {"protocol":1,"capabilities":{identity,writeThrough,watch}}
//   request    ← {"id":n,"method":"enumerate|fetch|write|remove|watch|unwatch","params":{…}}
//   response   → {"id":n,"result":{…}}  | {"id":n,"error":"…"}
//   watch feed → {"event":"batch","paths":[…]}   (unsolicited, while watching)
//
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
      case "watch":
        if (!watch) watch = adapter.watch((paths) => write({ event: "batch", paths }));
        write({ id, result: { ok: true } });
        break;
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
