// Cross-engine latency comparison: omg mcp (node) vs omgbase mcp (rust, release build),
// both --no-watch over one workspace, same read-only tool calls. Usage (from packages/core, after
// `pnpm build` and `cargo build --release -p omgbase`): node scripts/bench-engines.mjs <workspace> [N].
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "node:perf_hooks";

const W = process.argv[2];
const N = Number(process.argv[3] ?? 20);
const ROOT = new URL("../../../", import.meta.url).pathname;
const peers = {
  typescript: { command: process.execPath, args: [ROOT + "packages/cli/dist/src/main.js", "mcp", "-C", W, "--no-watch"] },
  rust: { command: ROOT + "target/release/omgbase", args: ["mcp", "--workspace", W, "--no-watch"] },
};
const calls = [
  ["docs_tree", { depth: 2 }],
  ["docs_list", { limit: 200 }],
  ["text_search", { q: "crucible tincture", limit: 20 }],
  ["query", { query: 'select $path, type from docs where $path.startsWith("journal/") order by $path desc', limit: 50 }],
  ["query", { query: "select $path, text from blocks where checked == false", limit: 50 }],
  ["query", { query: 'select $path, text from blocks where type == "task"', limit: 50 }],
  ["query", { query: 'select $path, text from blocks where type == "task" && checked == false', limit: 50 }],
  ["query", { query: 'select $path, value from nodes where kind == "md:link"', limit: 50 }],
  ["query", { query: 'select $path from docs where layer == "draft" && tags.contains("mercury")', limit: 50 }],
  ["query", { query: 'blocks count { where text.contains("crucible") }', limit: 50 }],
  ["docs_read", { path: "notes/a/doc-0000.md", include_ids: true }],
  ["docs_outline", { path: "notes/a/doc-0000.md" }],
  ["graph", { roots: ["notes/a/doc-0000.md"], degrees: 2 }],
  ["repos_status", {}],
];

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p95: q(0.95), min: s[0] };
}

async function bench(name, peer) {
  const t0 = performance.now();
  const transport = new StdioClientTransport({ ...peer, stderr: "ignore", env: { ...process.env } });
  const client = new Client({ name: "bench", version: "0" });
  await client.connect(transport);
  await client.listTools();
  const startup = performance.now() - t0;
  const out = {};
  for (const [tool, args] of calls) {
    const key = tool === "query" ? `query: ${args.query.slice(0, 48)}` : tool;
    const r0 = await client.callTool({ name: tool, arguments: args });
    if (r0.isError) { out[key] = { error: r0.content?.[0]?.text?.slice(0, 120) }; continue; }
    const times = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      await client.callTool({ name: tool, arguments: args });
      times.push(performance.now() - t);
    }
    out[key] = { ...stats(times), bytes: JSON.stringify(r0).length };
  }
  await client.close();
  return { startup, out };
}

const results = {};
for (const [name, peer] of Object.entries(peers)) results[name] = await bench(name, peer);
const f = (x) => (typeof x === "number" ? x.toFixed(1).padStart(7) : String(x).padStart(7));
console.log(`workspace ${W}, N=${N} per call, ms\n`);
console.log("startup (spawn→initialize→tools/list): ts", f(results.typescript.startup), " rust", f(results.rust.startup));
console.log("\n" + "call".padEnd(58) + "ts p50".padStart(8) + "rs p50".padStart(8) + "ts p95".padStart(8) + "rs p95".padStart(8) + "  ratio  bytes(ts/rs)");
for (const key of Object.keys(results.typescript.out)) {
  const a = results.typescript.out[key], b = results.rust.out[key];
  if (a.error || b.error) { console.log(key.padEnd(58), "ts:", a.error ?? "ok", "| rust:", b.error ?? "ok"); continue; }
  console.log(key.padEnd(58) + f(a.p50) + f(b.p50) + f(a.p95) + f(b.p95) + `  ${(a.p50 / b.p50).toFixed(1)}x  ${a.bytes}/${b.bytes}`);
}
