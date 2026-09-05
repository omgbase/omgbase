#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createProvider } from "./index.js";

// omgbase-embedder — a stdio embedding server (05 §6 provider contract). The
// engine spawns this process and speaks newline-delimited JSON:
//
//   • On startup we write ONE handshake line: {"model": "...", "dim": N}
//   • For each request line {"id": <n>, "texts": [<string>...]} we reply with
//     {"id": <n>, "vectors": [[<number>...]...]} (or {"id","error"} on failure).
//   • stdout carries ONLY protocol JSON; all logs go to stderr.
//
// Model + dim come from env so the same binary can serve different models:
//   OMGBASE_EMBEDDER_MODEL (default Xenova/all-MiniLM-L6-v2), OMGBASE_EMBEDDER_DIM (384).

const model = process.env.OMGBASE_EMBEDDER_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const dim = Number(process.env.OMGBASE_EMBEDDER_DIM ?? "384");

const provider = createProvider({ model, dim });

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  // Handshake first, so the client can read model/dim before sending work.
  write({ model, dim });
  process.stderr.write(`[omgbase-embedder] ready: ${model} (${dim}d)\n`);

  const rl = createInterface({ input: process.stdin });
  // Serialize requests through a promise chain so ordering + model load are safe.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let id: number | undefined;
      try {
        const req = JSON.parse(trimmed) as { id?: number; texts?: string[] };
        id = req.id;
        const vectors = await provider.embed(req.texts ?? []);
        write({ id, vectors });
      } catch (err) {
        write({ id, error: (err as Error).message });
      }
    });
  });
  rl.on("close", () => process.exit(0));
}

void main();
