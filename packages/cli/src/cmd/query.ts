import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { query, type QueryEnvelope } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { truncationFooter, EngineErrorLike, EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";

// `omg query [filter]` (alias q) (11 §5.3). One query language, three input
// forms → the same envelope (10 §1): positional CEL filter + flags; flags only;
// or -f envelope.yaml|- (exactly the ```omg fence body). Human output: one hit
// per line, id + locator + first line.

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function runQuery(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      docs: { type: "boolean" },
      text: { type: "string" },
      semantic: { type: "string" },
      select: { type: "string" },
      order: { type: "string" },
      n: { type: "string", short: "n" },
      cursor: { type: "string" },
      file: { type: "string", short: "f" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  query [filter] [--from blocks|documents] [--docs] [--text t] [--select f,f] [--order f,-f] [-n N] [--cursor c] [-f envelope.yaml|-]");
    return EXIT_OK;
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);

  let env: QueryEnvelope;
  if (values.file) {
    const raw = values.file === "-" ? readStdin() : readFileSync(values.file, "utf8");
    const parsed = (parseYaml(raw) ?? {}) as Partial<QueryEnvelope>;
    env = { from: parsed.from ?? "blocks", ...parsed };
  } else {
    const from = values.docs ? "documents" : (values.from as "documents" | "blocks" | undefined) ?? "blocks";
    env = { from };
    const filter = positionals.join(" ").trim();
    if (filter) env.filter = filter;
    if (values.text) env.text = values.text;
    if (values.select) env.select = values.select.split(",").map((s) => s.trim());
    if (values.order) env.order = values.order.split(",").map((s) => s.trim());
    if (values.n) env.limit = Number(values.n);
    if (values.cursor) env.cursor = values.cursor;
  }

  // --semantic: embed the phrase with the configured provider and hand the
  // vector to the envelope (query() then hybrid-ranks). No provider ⇒ a clear
  // semantic_unavailable rather than silently ignoring the flag.
  if (values.semantic) {
    const loaded = await loadEmbedding(ws, repo.repoId);
    if (!loaded) {
      throw new EngineErrorLike("semantic_unavailable", "no embedding provider configured", {
        hint: "omg config set embedding.provider <command|url>",
      });
    }
    try {
      const vec = await loaded.worker.embedQuery(values.semantic);
      env.vector = { model: loaded.provider.model, vec };
    } finally {
      await loaded.close();
    }
  }

  const result = query(ws.store, repo.repoId, env);

  if (cli.flags.mode === "ids") {
    for (const h of result.hits) cli.io.out(h.id);
    if (result.truncated) truncationFooter(cli.io, cli.style, result.cursor ?? "");
    return EXIT_OK;
  }
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const h of result.hits) cli.io.out(JSON.stringify(h));
    if (result.truncated) truncationFooter(cli.io, cli.style, result.cursor ?? "");
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (result.hits.length === 0) {
    io.err(style.dim("  no hits"));
    return EXIT_OK;
  }
  for (const h of result.hits) {
    // first line of text if the hit carries it; else just id + path locator.
    const preview = typeof h.text === "string" ? String(h.text).split("\n")[0] : "";
    io.out(`${style.id(h.id)}  ${style.accent(h.path)}  ${preview}`.trimEnd());
  }
  if (result.truncated) truncationFooter(io, style, result.cursor ?? "");
  return EXIT_OK;
}

export const cmdQuery: Command = { name: "query", aliases: ["q"], summary: "Query blocks/documents (CEL + text + semantic)", run: (cli, a) => runQuery(cli, a) };
