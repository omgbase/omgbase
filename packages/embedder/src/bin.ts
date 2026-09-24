#!/usr/bin/env node
import { createProvider } from "./index.js";
import { serve } from "./serve.js";

// omgbase-embedder — a stdio embedding server (05 §6 provider contract). The
// engine spawns this process and speaks newline-delimited JSON:
//
//   • On startup we write ONE handshake line: {"model": "...", "dim": N}
//   • For each request line {"id": <n>, "texts": [<string>...]} we reply with
//     {"id": <n>, "vectors": [[<number>...]...]} (or {"id","error"} on failure).
//   • stdout carries ONLY protocol JSON; all logs go to stderr.
//   • On stdin EOF we DRAIN: every request already received is answered (which
//     may mean waiting out the lazy first model load) before exiting — so a
//     piped one-shot (`echo '{"id":1,"texts":["hi"]}' | omgbase-embedder`) works.
//
// Model + dim come from env so the same binary can serve different models:
//   OMGBASE_EMBEDDER_MODEL (default Xenova/gte-base), OMGBASE_EMBEDDER_DIM (768),
//   OMGBASE_EMBEDDER_MAX_TOKENS (default 512 — gte-base's max sequence
//   length; the model truncates beyond it). The engine exports a repo's
//   `embedding.model`/`dim`/`maxInputTokens` settings as exactly these variables
//   when it spawns us (explicit settings win over inherited env). Reported in the
//   handshake so the engine's doc-embedding path picks whole-doc vs
//   pooled-fallback from the model's real limit rather than a hardcoded guess.

const model = process.env.OMGBASE_EMBEDDER_MODEL ?? "Xenova/gte-base";
const dim = Number(process.env.OMGBASE_EMBEDDER_DIM ?? "768");
const maxInputTokens = Number(process.env.OMGBASE_EMBEDDER_MAX_TOKENS ?? "512");

const provider = createProvider({ model, dim });

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  // Handshake first, so the client can read model/dim before sending work.
  write({ model, dim, maxInputTokens });
  process.stderr.write(`[omgbase-embedder] ready: ${model} (${dim}d)\n`);

  // Serve until stdin ends, then finish answering what was already received
  // (serve.ts). Exit explicitly: the ONNX runtime can keep the loop alive.
  await serve(process.stdin, provider, { write });
  process.exit(0);
}

void main();
