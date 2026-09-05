import { parseArgs } from "node:util";
import { parse as parseYamlScalar } from "yaml";
import { docsCreate, docsMove, docsDelete, docsSetMeta, type DocOpContext, type DocOpResult } from "@omgbase/core";
import type { Cli } from "../context.js";
import type { Command } from "../commands.js";
import { CliUsageError, EXIT_OK } from "../output.js";
import { readContent, extractContentOpts } from "./_mutate.js";

// Document-level commands (11 §5.6): new / mv / rm --doc / meta. Thin wrappers
// over the core doc ops, which own the file-write + commit + flock protocol.

function ctxOf(cli: Cli, ws: ReturnType<Cli["workspace"]>, repoId: string, rootPath: string, actor?: string): DocOpContext {
  return { repoId, rootPath, omgbaseDir: ws.omgbaseDir, ...(actor ? { actor } : {}) };
}

function report(cli: Cli, verb: string, res: DocOpResult): number {
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(res));
    return EXIT_OK;
  }
  cli.io.err(cli.style.dim(`  ${cli.style.ok(cli.render.g.ok)} ${verb} ${cli.style.accent(res.path)}`));
  cli.io.out(res.docId);
  return EXIT_OK;
}

// ---- new --------------------------------------------------------------------

function runNew(cli: Cli, args: string[]): number {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  new <path> (-f file | -)  — create a document from complete file bytes (frontmatter incl.)");
    return EXIT_OK;
  }
  const path = positionals[0];
  if (!path) throw new CliUsageError("new requires a <path>");
  const bytes = readContent(content);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = docsCreate(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, values.actor), path, bytes);
  return report(cli, "created", res);
}

// ---- mv ---------------------------------------------------------------------

function runMv(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  mv <doc> <new-path>  — rename a document (identity preserved)");
    return EXIT_OK;
  }
  const doc = positionals[0];
  const toPath = positionals[1];
  if (!doc || !toPath) throw new CliUsageError("mv requires <doc> and <new-path>");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = docsMove(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, values.actor), doc, toPath);
  return report(cli, "moved to", res);
}

// ---- rm --doc (block rm lives in mutate.ts; this handles the --doc branch) --

export function runRmDoc(cli: Cli, doc: string, actor?: string): number {
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = docsDelete(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, actor), doc);
  return report(cli, "deleted", res);
}

// ---- meta -------------------------------------------------------------------

function runMeta(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      set: { type: "string", multiple: true },
      "set-json": { type: "string", multiple: true },
      unset: { type: "string", multiple: true },
      actor: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.err("  meta <doc> --set k=v … [--set-json k='…'] [--unset k …]  — surgical frontmatter patch");
    return EXIT_OK;
  }
  const doc = positionals[0];
  if (!doc) throw new CliUsageError("meta requires a <doc>");

  const set: Record<string, unknown> = {};
  for (const kv of values.set ?? []) {
    const eq = kv.indexOf("=");
    if (eq < 0) throw new CliUsageError(`--set expects k=v, got '${kv}'`);
    const key = kv.slice(0, eq);
    const val = kv.slice(eq + 1);
    // YAML scalar parse: numbers/bools/null become typed, strings stay strings.
    set[key] = parseYamlScalar(val) as unknown;
  }
  for (const kv of values["set-json"] ?? []) {
    const eq = kv.indexOf("=");
    if (eq < 0) throw new CliUsageError(`--set-json expects k=json, got '${kv}'`);
    set[kv.slice(0, eq)] = JSON.parse(kv.slice(eq + 1)) as unknown;
  }
  const unset = values.unset ?? [];
  if (Object.keys(set).length === 0 && unset.length === 0) throw new CliUsageError("meta requires --set or --unset");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = docsSetMeta(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, values.actor), doc, { set, unset });
  return report(cli, "patched", res);
}

export const cmdNew: Command = { name: "new", summary: "Create a document", run: (c, a) => runNew(c, a) };
export const cmdMv: Command = { name: "mv", summary: "Rename a document", run: (c, a) => runMv(c, a) };
export const cmdMeta: Command = { name: "meta", summary: "Patch a document's frontmatter", run: (c, a) => runMeta(c, a) };
