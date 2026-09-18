import { parseArgs } from "node:util";
import { resolve as resolveThing, type ResolveInput } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";
import { remoteCall } from "./_remote.js";

type FindHit = ReturnType<typeof resolveThing>[number];

// `omg find <text>` (11 §5.2) — resolve: ranked {id, locator, preview,
// evidence}. `-1` prints the top hit's id alone (pipe fuel: omg cat $(omg find … -1)).

async function runFind(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      n: { type: "string", short: "n" },
      one: { type: "boolean", short: "1" },
      verbose: { type: "boolean", short: "v" },
      "no-semantic": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  find <text> [-n N] [-1] [-v] [--no-semantic]  — ranked hybrid search; -1 prints the top id alone");
    return EXIT_OK;
  }
  const text = positionals.join(" ").trim();
  if (!text) throw new CliUsageError("find requires <text>");

  const limit = values.one ? 1 : values.n ? Number(values.n) : 10;

  let hits: FindHit[];
  if (cli.flags.server) {
    // Remote: the `resolve` tool does the hybrid ranking server-side (using the
    // server's embedder if configured). Same ranked-hit shape → render unchanged.
    hits = await remoteCall<FindHit[]>(cli, "resolve", { query: text, limit });
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    // Hybrid by default: if a provider is configured, fuse the query vector into
    // the ranking (--no-semantic forces FTS-only). resolve() blends when a vector
    // is supplied.
    const input: ResolveInput = { repoId: repo.repoId, query: text, limit };
    if (!values["no-semantic"]) {
      const loaded = await loadEmbedding(ws, repo.repoId);
      if (loaded) {
        try {
          const vec = await loaded.worker.embedQuery(text);
          input.vector = { model: loaded.provider.model, vec };
        } finally {
          await loaded.close();
        }
      }
    }
    hits = resolveThing(ws.store, input);
  }
  cli.capture?.(hits); // shell: the ranked hits become the addressable frame

  // -1: bare top id.
  if (values.one) {
    if (hits[0]) cli.io.out(hits[0].id);
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const h of hits) cli.io.out(h.id);
    return EXIT_OK;
  }
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(hits));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const h of hits) cli.io.out(JSON.stringify(h));
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (hits.length === 0) {
    io.err(style.dim("  no matches"));
    return EXIT_OK;
  }
  for (const h of hits) {
    io.out(`${style.id(h.id)}  ${style.accent(h.locator)}  ${h.preview}`);
    if (values.verbose) io.err(style.dim(`    ${JSON.stringify(h.evidence)}`));
  }
  return EXIT_OK;
}

export const cmdFind: Command = { name: "find", summary: "Ranked hybrid search for the id of a thing", run: (cli, a) => runFind(cli, a) };
