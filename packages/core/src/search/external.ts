import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import type { EmbeddingProvider } from "./embeddings.js";
import type { EmbeddingSettings } from "./provider.js";

// External embedding providers (05 §6). The provider is a *process or endpoint*,
// not a JS module: `embedding.provider` is either a shell command (spawned,
// spoken to over stdio) or an http(s) URL. This keeps the engine and CLI free of
// any ML dependency or in-process import — the embedder can be written in any
// language, run out-of-process, and be swapped by config alone.
//
// Wire protocols
// --------------
// stdio (newline-delimited JSON):
//   • On spawn the embedder writes ONE handshake line: {"model": "...", "dim": N}
//   • Per request the engine writes: {"id": <n>, "texts": [<string>...]}\n
//     and reads a matching:          {"id": <n>, "vectors": [[<number>...]...]}\n
//   • stderr is for logs/progress only — never protocol.
//
// http(s):
//   • GET  <url>            → {"model": "...", "dim": N}   (metadata handshake)
//   • POST <url> {texts:[]} → {"vectors": [[...]...]}

export interface ExternalProvider {
  provider: EmbeddingProvider;
  /** Release resources (kill a spawned process; no-op for HTTP). */
  close(): Promise<void>;
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

/**
 * Build an embedding provider from repo settings by connecting to an external
 * command (stdio) or endpoint (HTTP). Throws on misconfiguration or handshake
 * failure. Callers must call close() when done.
 */
export async function createExternalProvider(settings: EmbeddingSettings): Promise<ExternalProvider | null> {
  if (!settings.provider) return null;
  return isUrl(settings.provider) ? connectHttp(settings) : connectStdio(settings);
}

// ---- HTTP -------------------------------------------------------------------

async function connectHttp(settings: EmbeddingSettings): Promise<ExternalProvider> {
  const url = settings.provider!;
  let model = settings.model ?? "http";
  let dim = settings.dim ?? 0;
  try {
    const res = await fetch(url, { method: "GET" });
    if (res.ok) {
      const meta = (await res.json()) as { model?: string; dim?: number };
      if (meta.model) model = meta.model;
      if (typeof meta.dim === "number") dim = meta.dim;
    }
  } catch {
    // Metadata is best-effort; embed() failures below are the real signal.
  }
  const provider: EmbeddingProvider = {
    model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts, model }),
      });
      if (!res.ok) throw new Error(`embedding endpoint ${url} returned ${res.status}`);
      const body = (await res.json()) as { vectors?: number[][] };
      if (!body.vectors) throw new Error(`embedding endpoint ${url} returned no "vectors"`);
      return body.vectors;
    },
  };
  return { provider, close: async () => {} };
}

// ---- stdio ------------------------------------------------------------------

async function connectStdio(settings: EmbeddingSettings): Promise<ExternalProvider> {
  const parts = settings.provider!.trim().split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
  } catch (err) {
    throw new Error(`embedding command '${settings.provider}' failed to spawn: ${(err as Error).message}`);
  }

  const rl = createInterface({ input: child.stdout });
  const lines = lineQueue(rl);
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once("error", (err) => reject(new Error(`embedding command '${cmd}' failed to spawn: ${err.message}`)));
    child.once("exit", (code) => reject(new Error(`embedding command '${cmd}' exited early (code ${code ?? "?"})`)));
  });

  // Handshake: first stdout line carries model + dim.
  const handshakeRaw = await Promise.race([lines.next(), spawnFailed]);
  let model = settings.model ?? "stdio";
  let dim = settings.dim ?? 0;
  try {
    const meta = JSON.parse(handshakeRaw) as { model?: string; dim?: number };
    if (meta.model) model = meta.model;
    if (typeof meta.dim === "number") dim = meta.dim;
  } catch {
    throw new Error(`embedding command '${cmd}' sent an invalid handshake line: ${handshakeRaw.slice(0, 120)}`);
  }

  let nextId = 1;
  const provider: EmbeddingProvider = {
    model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const id = nextId++;
      child.stdin.write(JSON.stringify({ id, texts }) + "\n");
      // Read lines until the matching id arrives (tolerate interleaved ids).
      for (;;) {
        const raw = await Promise.race([lines.next(), spawnFailed]);
        const resp = JSON.parse(raw) as { id?: number; vectors?: number[][]; error?: string };
        if (resp.error) throw new Error(`embedder error: ${resp.error}`);
        if (resp.id === id) {
          if (!resp.vectors) throw new Error("embedder response missing vectors");
          return resp.vectors;
        }
      }
    },
  };

  const close = async (): Promise<void> => {
    rl.close();
    child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  };
  return { provider, close };
}

// A pull-based async line reader over a readline Interface: next() resolves with
// the next line, buffering lines that arrive before they're requested.
function lineQueue(rl: Interface): { next(): Promise<string> } {
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffered.push(line);
  });
  return {
    next(): Promise<string> {
      const b = buffered.shift();
      if (b !== undefined) return Promise.resolve(b);
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
  };
}
