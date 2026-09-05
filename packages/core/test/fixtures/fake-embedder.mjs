#!/usr/bin/env node
// A deterministic fake stdio embedder for tests (no model). Implements the
// omgbase embedding protocol: handshake line, then {id,texts} → {id,vectors}.
// Vectors are a tiny normalized bag-of-words hash so similar text scores higher.
import { createInterface } from "node:readline";

const DIM = 8;
const MODEL = "fake-8";

function embed(text) {
  const v = new Array(DIM).fill(0);
  for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    let h = 0;
    for (const c of tok) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

process.stdout.write(JSON.stringify({ model: MODEL, dim: DIM }) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  try {
    const { id, texts } = JSON.parse(t);
    process.stdout.write(JSON.stringify({ id, vectors: (texts ?? []).map(embed) }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err) }) + "\n");
  }
});
rl.on("close", () => process.exit(0));
