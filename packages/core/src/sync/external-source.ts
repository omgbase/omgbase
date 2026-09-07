import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import type {
  SyncSource,
  SourceCapabilities,
  SourceEntry,
  SourceItem,
  SourceWatch,
  WatchListener,
} from "./plugin.js";

// External source bridge (13-sync-plugins §4). Spawns an adapter command and
// speaks the newline-delimited JSON protocol, presenting the process as a
// SyncSource. Mirrors the embedder bridge (search/external.ts): a handshake
// line, then id-matched request/response — with one extension, an unsolicited
// {"event":"batch"} stream while a watch is live.
//
//   handshake  ← {"protocol":1,"capabilities":{identity,writeThrough,watch}}
//   request    → {"id":n,"method":"enumerate|fetch|write|remove|watch|unwatch","params":{…}}
//   response   ← {"id":n,"result":{…}}  | {"id":n,"error":"…"}
//   watch feed ← {"event":"batch","paths":[…]}   (no id; server-initiated)
//
// stdout is protocol only; the adapter's stderr is inherited for logs.

export interface ExternalSourceSpec {
  /** Adapter command (argv[0]). */
  command: string;
  /** Rendered flags from the source config (13 §3.1). */
  args: string[];
  /** Extra environment (secrets; 13 §3.2). Merged over process.env. */
  env?: Record<string, string>;
}

interface HandshakeMsg {
  protocol?: number;
  capabilities?: Partial<SourceCapabilities>;
}
interface ResponseMsg {
  id?: number;
  result?: unknown;
  error?: string;
  event?: string;
  paths?: string[];
}

/**
 * Spawn an adapter and connect it as a SyncSource. Throws on spawn/handshake
 * failure. Callers MUST call close() to terminate the process.
 */
export async function createExternalSource(spec: ExternalSourceSpec): Promise<SyncSource> {
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
  } catch (err) {
    throw new Error(`sync adapter '${spec.command}' failed to spawn: ${(err as Error).message}`);
  }

  const rl = createInterface({ input: child.stdout });
  let watchListener: WatchListener | null = null;
  const router = messageRouter(rl, (paths) => watchListener?.(paths));
  const died = new Promise<never>((_, reject) => {
    child.once("error", (err) => reject(new Error(`sync adapter '${spec.command}' failed to spawn: ${err.message}`)));
    child.once("exit", (code) => reject(new Error(`sync adapter '${spec.command}' exited early (code ${code ?? "?"})`)));
  });

  // Handshake: the first line declares protocol + capabilities.
  const handshakeRaw = await Promise.race([router.nextResponse(), died]);
  let caps: SourceCapabilities;
  try {
    const hs = JSON.parse(handshakeRaw) as HandshakeMsg;
    const c = hs.capabilities ?? {};
    caps = {
      identity: c.identity === "borne" ? "borne" : "inferred",
      writeThrough: Boolean(c.writeThrough),
      watch: Boolean(c.watch),
    };
  } catch {
    throw new Error(`sync adapter '${spec.command}' sent an invalid handshake: ${handshakeRaw.slice(0, 120)}`);
  }

  let nextId = 1;
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    for (;;) {
      const raw = await Promise.race([router.nextResponse(), died]);
      const msg = JSON.parse(raw) as ResponseMsg;
      if (msg.id !== id) continue; // response to another in-flight call
      if (msg.error) throw new Error(`sync adapter error (${method}): ${msg.error}`);
      return msg.result;
    }
  };

  const source: SyncSource = {
    capabilities: () => caps,

    async enumerate(): Promise<SourceEntry[]> {
      const r = (await call("enumerate")) as { entries?: SourceEntry[] };
      return r.entries ?? [];
    },

    async fetch(path: string): Promise<SourceItem | null> {
      const r = (await call("fetch", { path })) as { item?: SourceItem | null };
      return r.item ?? null;
    },

    ...(caps.watch
      ? {
          async watch(onBatch: WatchListener): Promise<SourceWatch> {
            watchListener = onBatch;
            await call("watch");
            return {
              async stop(): Promise<void> {
                watchListener = null;
                try {
                  await call("unwatch");
                } catch {
                  // process may already be exiting; ignore.
                }
              },
            };
          },
        }
      : {}),

    ...(caps.writeThrough
      ? {
          async write(path: string, content: string): Promise<void> {
            await call("write", { path, content });
          },
          async remove(path: string): Promise<void> {
            await call("remove", { path });
          },
        }
      : {}),

    async close(): Promise<void> {
      rl.close();
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
    },
  };

  return source;
}

// Demultiplex adapter stdout: {"event":"batch"} lines feed the watch listener;
// every other line is an id-addressed response buffered for nextResponse().
function messageRouter(rl: Interface, onBatch: (paths: string[]) => void): { nextResponse(): Promise<string> } {
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const peek = JSON.parse(trimmed) as ResponseMsg;
      if (peek.event === "batch") {
        onBatch(peek.paths ?? []);
        return;
      }
    } catch {
      // Non-JSON on stdout is a protocol violation; surface it as a response so
      // the awaiting call() rejects with a parse error rather than hanging.
    }
    const w = waiters.shift();
    if (w) w(trimmed);
    else buffered.push(trimmed);
  });
  return {
    nextResponse(): Promise<string> {
      const b = buffered.shift();
      if (b !== undefined) return Promise.resolve(b);
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
  };
}
