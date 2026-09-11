import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { oqxRun, oqxRunAsync, collectSemanticPhrases, type EmbedQuery } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { truncationFooter, EngineErrorLike, EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";

// `omg oqx <source>` — OQX composable query (structural + section navigation +
// ad-hoc correlation: receiver-constrained nested queries, a boolean where tree
// over scalar predicates and collection ops, count comparisons, nestable
// collect, one-scope lifts (^name:) that filter + capture, one-scope-outward
// references (^name) that correlate a nested query to a parent binding, explicit
// root relations repo.docs/nodes/blocks for join-equivalents, first/single
// lookups, full-text text(...) + embedding-score semantic(...) predicates, and
// `order by <expr> [asc|desc]` ranking). Wrap the whole query in a top-level consumer to change its result
// shape: repo.count(...)/repo.exists(...) reduce to a scalar, repo.first(...)/
// repo.single(...) to zero-or-one row (bare = repo.collect). Coexists with
// `omg q` (CEL). Source is a positional string or -f file|-. Human output: one
// hit per line (id + path), or the scalar for count/exists; --json/--jsonl/--ids.

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function runOqx(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      cursor: { type: "string" },
      file: { type: "string", short: "f" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  query <source> [-n N] [--cursor c] [-f file|-]");
    cli.io.out("  e.g. query 'from docs where nodes.count(where kind == \"md:task\") >= 2'");
    cli.io.out("       query 'from nodes where kind == \"md:section\" select items: section.blocks.collect(where type == \"list_item\")'");
    cli.io.out("       query 'from docs where nodes.collect(^open: value where kind == \"md:task\" && !attrs.checked) select $path, open'");
    cli.io.out("       query 'from docs select owner_id, owner: repo.nodes.single(where kind == \"person\" && attrs.id == ^owner_id)'");
    cli.io.out("       query 'repo.count(from docs where layer == \"canon\")'   # scalar; also repo.exists/first/single(...)");
    cli.io.out("       query 'from docs where text(\"philosophers stone\") && layer == \"canon\"'   # full-text prune");
    cli.io.out("       query 'from blocks where semantic(\"the great work\") > 0.6 select s: semantic(\"the great work\")'  # embedding score (needs a provider)");
    cli.io.out("       query 'from docs where type == \"practitioner\" order by era desc'   # order by <expr> [asc|desc]");
    return EXIT_OK;
  }

  const source = values.file
    ? (values.file === "-" ? readStdin() : readFileSync(values.file, "utf8"))
    : positionals.join(" ").trim();
  if (!source) {
    cli.io.err(cli.style.dim("  usage: oqx <source>  (or -f file|-)"));
    return EXIT_OK;
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);

  const opts: { limit?: number; cursor?: string } = {};
  if (values.n) opts.limit = Number(values.n);
  if (values.cursor) opts.cursor = values.cursor;

  // A query using semantic("…") needs the embedding provider to turn each
  // phrase into a query vector; everything else runs on the sync core with no
  // provider loaded. loadEmbedding is only touched when a phrase is present.
  const phrases = collectSemanticPhrases(source);
  let result;
  if (phrases.length > 0) {
    const loaded = await loadEmbedding(ws, repo.repoId);
    if (!loaded) {
      throw new EngineErrorLike("semantic_unavailable", "semantic(...) needs an embedding provider", {
        hint: "omg config set embedding.provider <command|url>",
      });
    }
    try {
      const embed: EmbedQuery = async (t) => ({ model: loaded.provider.model, vec: await loaded.worker.embedQuery(t) });
      result = await oqxRunAsync(ws.store, repo.repoId, source, opts, embed);
    } finally {
      await loaded.close();
    }
  } else {
    result = oqxRun(ws.store, repo.repoId, source, opts);
  }

  // JSON emits the whole result verbatim (incl. consumer + any scalar), so
  // count/exists round-trip without special-casing.
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }

  // Scalar consumers (count/exists) have no hits — render the reduction itself.
  if (result.consumer === "count" || result.consumer === "exists") {
    const scalar = result.consumer === "count" ? String(result.count) : String(result.exists);
    cli.io.out(scalar);
    return EXIT_OK;
  }

  if (cli.flags.mode === "ids") {
    for (const h of result.hits) cli.io.out(h.id);
    if (result.truncated) truncationFooter(cli.io, cli.style, result.cursor ?? "");
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
    io.out(`${style.id(h.id)}  ${style.accent(h.path)}`.trimEnd());
  }
  if (result.truncated) truncationFooter(io, style, result.cursor ?? "");
  return EXIT_OK;
}

// `query` (alias `q`) is the single query surface; `oqx` stays as an alias since
// the engine keeps that name. The command impl lives in this file (oqx.ts).
export const cmdOqx: Command = {
  name: "query",
  aliases: ["q", "oqx"],
  summary: "Composable query (OQX engine: from/where/select + collection ops)",
  run: (cli, a) => runOqx(cli, a),
};
