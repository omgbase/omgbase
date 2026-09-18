import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { oqxRun, oqxRunAsync, collectSemanticPhrases, type EmbedQuery, type OqxResult } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { truncationFooter, EngineErrorLike, EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";
import { remoteCall } from "./_remote.js";
import { readStdin } from "./_mutate.js";

// `omg query <source>` — OQX composable query. Dot navigation belongs to the host
// object model (`doc.layer`, `section.blocks`); whitespace query directives
// belong to OQX (`<receiver> collect|exists|count|first|single { <block> }`).
// `from E` selects + flattens a relation relative to the current source scope
// (top-level `from docs` = the repository's docs; `repo.docs collect { from
// nodes … }` re-projects each doc through its nodes). Inside a block the
// `where`/`select` keyword may be omitted: a leading predicate-shaped expression
// is an implicit `where` (`nodes exists { kind == "md:task" }`), a bare
// reference / `name: value` list is an implicit `select` (`nodes collect
// { attrs.text }`); a bare boolean property still projects (filter with
// `where active` or `active == true`). Features: a boolean where
// tree over scalar predicates and consumer directives, count comparisons
// (`nodes count { … } >= 2`), nestable collect, one-scope lifts (^name:) that
// filter + capture, one-scope-outward references (^name) that correlate a nested
// query to a parent binding, explicit root relations repo.docs/nodes/blocks for
// join-equivalents, first/single lookups, full-text text(...) + embedding-score
// semantic(...) predicates, `order by <expr> [asc|desc]` ranking, and recursive
// `follow [distinct] <rel> [{ where … frontier … depth n by … }]` traversal over
// a type-preserving relation with $depth/$stop/$ordinal recursion metadata +
// post-walk filtering. A top-level consumer directive changes the result shape:
// `repo.docs count { … }` / `repo.docs exists { … }` reduce to a scalar,
// `repo.docs first { … }` / `repo.docs single { … }` to zero-or-one row (bare
// `from …` = collect). Coexists with `omg q` (CEL). Source is a positional
// string or -f file|-. Human output: one hit per line (id + path), or the scalar
// for count/exists; --json/--jsonl/--ids.

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
    cli.io.out("  e.g. query 'from docs where nodes count { where kind == \"md:task\" } >= 2'");
    cli.io.out("       query 'from nodes where kind == \"md:section\" select items: section.blocks collect { where type == \"list_item\" }'");
    cli.io.out("       query 'from docs where nodes collect { ^open: value where kind == \"md:task\" && !attrs.checked } select $path, open'");
    cli.io.out("       query 'from docs select owner_id, owner: repo.nodes single { where kind == \"person\" && attrs.id == ^owner_id }'");
    cli.io.out("       query 'repo.docs count { where layer == \"canon\" }'   # scalar; also repo.<target> exists/first/single { … }");
    cli.io.out("       query 'repo.docs collect { from nodes where kind == \"md:task\" }'   # `from E` re-projects the source (→ nodes)");
    cli.io.out("       query 'from docs where text(\"philosophers stone\") && layer == \"canon\"'   # full-text prune");
    cli.io.out("       query 'from blocks where semantic(\"the great work\") > 0.6 select s: semantic(\"the great work\")'  # embedding score (needs a provider)");
    cli.io.out("       query 'from docs where type == \"practitioner\" order by era desc'   # order by <expr> [asc|desc]");
    cli.io.out("       query 'from blocks where $id == \"b_x\" select t: text, d: $depth, s: $stop follow block.children'   # recursive walk ($depth/$stop metadata)");
    cli.io.out("       query 'from nodes where name == \"Overview\" follow section.subsections { depth 3 }'   # follow [distinct] <rel> [{ where … frontier … depth n by … }]");
    cli.io.out("       query 'from docs where $path == \"index.md\" select p: $path, d: $depth, s: $stop follow doc.out'   # citation graph (cyclic-safe: $stop=cycle)");
    cli.io.out("       query 'from blocks where type == \"list_item\" && $leaf follow block.children'   # $leaf/$depth/$stop filter the walk result post-walk");
    cli.io.out("       query 'from edges where predicate == \"depends_on\" select src: $src, to: $dst_path'   # the edges target: predicate/provenance/dst_kind + $src/$dst_path/$dst_uri");
    cli.io.out("       query 'from docs where $path == \"a.md\" follow doc.out { via predicate == \"cites\" }'   # predicate-filtered traversal (via = the licensing edge)");
    return EXIT_OK;
  }

  const source = values.file
    ? (values.file === "-" ? readStdin() : readFileSync(values.file, "utf8"))
    : positionals.join(" ").trim();
  if (!source) {
    cli.io.err(cli.style.dim("  usage: query <source>  (or -f file|-)"));
    return EXIT_OK;
  }

  const opts: { limit?: number; cursor?: string } = {};
  if (values.n) opts.limit = Number(values.n);
  if (values.cursor) opts.cursor = values.cursor;

  let result: OqxResult;
  if (cli.flags.server) {
    // Remote: the `query` MCP tool returns the same OqxResult; render unchanged.
    result = await remoteCall<OqxResult>(cli, "query", {
      query: source,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    });
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    // A query using semantic("…") needs the embedding provider to turn each
    // phrase into a query vector; everything else runs on the sync core with no
    // provider loaded. loadEmbedding is only touched when a phrase is present.
    const phrases = collectSemanticPhrases(source);
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
  }

  // Shell capture (typed result before formatting): a scalar for count/exists,
  // else the whole result (its .hits become the addressable frame).
  cli.capture?.(
    result.consumer === "count" ? result.count : result.consumer === "exists" ? result.exists : result,
  );

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

// `query` (alias `q`) is the single, default query surface — the OQX engine.
// (The `oqx` alias was removed: OQX *is* the query experience, so `query`/`q`
// name it. The impl lives in this file, still named oqx.ts after the engine.)
export const cmdOqx: Command = {
  name: "query",
  aliases: ["q"],
  summary: "Composable query (OQX: from/where/select + collection ops)",
  run: (cli, a) => runOqx(cli, a),
};
