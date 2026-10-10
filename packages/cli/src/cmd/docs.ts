import { parseArgs } from "node:util";
import { parse as parseYamlScalar } from "yaml";
import { docsCreate, docsMove, docsDelete, docsSetMeta, surfaceDocOpResult, surfaceDocMoveResult, referencePath, type DocOpContext, type DocOpResult, type DocMoveResult } from "@omgbase/core";
import type { Cli } from "../context.js";
import type { Command } from "../commands.js";
import { CliUsageError, EXIT_OK, renderHelp } from "../output.js";
import { readContent, extractContentOpts, renderDiffs } from "./_mutate.js";
import { remoteCall } from "./_remote.js";

// Document-level commands (11 §5.6): new / mv / rm --doc / meta. Thin wrappers
// over the core doc ops, which own the file-write + commit + flock protocol.
// The global --dry-run rides as the op's `dryRun` (spec/cli §3.6): the op
// validates and returns the per-file diffs it would make, committing nothing.
// Every path printed is the reference form (spec/surface §1 "Paths"): the
// library's result is re-shaped through `surfaceDocOpResult` — the same
// function the MCP server applies — before it is rendered.

function ctxOf(cli: Cli, ws: ReturnType<Cli["workspace"]>, repoId: string, rootPath: string | null, actor?: string): DocOpContext {
  return {
    repoId,
    ...(rootPath ? { rootPath } : {}),
    omgbaseDir: ws.omgbaseDir,
    ...(actor ? { actor } : {}),
    ...(cli.flags.dryRun ? { dryRun: true } : {}),
  };
}

function report(cli: Cli, verb: string, res: DocOpResult): number {
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(res));
    return EXIT_OK;
  }
  if (cli.flags.dryRun) {
    renderDiffs(cli, res.diffs ?? {});
    return EXIT_OK;
  }
  cli.io.err(cli.style.dim(`  ${cli.style.ok(cli.render.g.ok)} ${verb} ${cli.style.accent(res.path)}`));
  cli.io.out(res.docId);
  return EXIT_OK;
}

// `mv` rewrites the inbound links by default (spec/mutate 1.3; `--no-retarget`
// opts out); say what happened wherever the move is reported (spec/cli §6 `mv`):
// the human confirmation carries the `retargeted` count and the same `dangling`
// list the --json result does, with the fix for each kind — `retarget` for
// authored links left as written, `meta` for a frontmatter relation (never
// rewritten by a move).
function reportMove(cli: Cli, from: string, res: DocMoveResult): number {
  const code = report(cli, "moved to", res);
  if (cli.flags.mode !== "human") return code;
  const { style, io } = cli;
  if (!cli.flags.dryRun && res.retargeted && res.retargeted.blocks.length > 0) {
    const b = res.retargeted.blocks.length;
    const d = res.retargeted.docs.length;
    io.err(style.dim(`  ${style.ok(cli.render.g.ok)} retargeted ${b} inbound link${b === 1 ? "" : "s"} in ${d} document${d === 1 ? "" : "s"}`));
  }
  if (res.dangling.length === 0) return code;
  const where = res.dangling.map((l) => (l.block ? `${l.path} ${l.block}` : `${l.path} (frontmatter)`)).join(", ");
  const n = res.dangling.length;
  io.err(style.warn(`  ${style.warn(cli.render.g.warn)} ${n} inbound link${n === 1 ? "" : "s"} still name${n === 1 ? "s" : ""} the old path: ${where}`));
  if (res.dangling.some((l) => l.block)) io.err(style.dim(`  fix: ${cli.prog} retarget ${from} ${res.path} --apply`));
  const seen = new Set<string>();
  for (const l of res.dangling) {
    if (l.block || !l.field) continue;
    const key = `${l.path}\u0000${l.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    io.err(style.dim(`  fix: ${cli.prog} meta ${l.path} --set ${l.field}=${res.path}`));
  }
  return code;
}

// ---- new --------------------------------------------------------------------

async function runNew(cli: Cli, args: string[]): Promise<number> {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "new",
      summary: "Create a document at <path> from complete file bytes (frontmatter included)",
      usage: "new <path> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]",
      options: [
        ["-m <markdown>", "content inline"],
        ["-f <file>", "content from a file"],
        ["-", "content from stdin"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const path = positionals[0];
  if (!path) throw new CliUsageError("new requires a <path>");
  const bytes = readContent(content);
  if (cli.flags.server) {
    return report(cli, "created", await remoteCall<DocOpResult>(cli, "docs_create", { path, markdown: bytes, ...dryRunArg(cli) }));
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = surfaceDocOpResult(docsCreate(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, values.actor), path, bytes));
  return report(cli, "created", res);
}

// ---- mv ---------------------------------------------------------------------

async function runMv(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { actor: { type: "string" }, "no-retarget": { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "mv",
      summary: "Rename/move a document to a new path; its identity and history are preserved and inbound links follow it",
      usage: "mv <doc> <new-path> [--no-retarget] [--actor <s>] [--dry-run]",
      options: [
        ["--no-retarget", "leave the inbound links as written (they dangle; fix later with retarget)"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const doc = positionals[0];
  const toPath = positionals[1];
  if (!doc || !toPath) throw new CliUsageError("mv requires <doc> and <new-path>");
  const noRetarget = values["no-retarget"] === true;
  if (cli.flags.server) {
    const res = await remoteCall<DocMoveResult>(cli, "docs_move", { doc, to_path: toPath, ...(noRetarget ? { retarget_inbound: false } : {}), ...dryRunArg(cli) });
    return reportMove(cli, fromPathOf(res, doc), res);
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = surfaceDocMoveResult(docsMove(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, values.actor), doc, toPath, noRetarget ? { retargetInbound: false } : {}));
  return reportMove(cli, fromPathOf(res, doc), res);
}

// ---- rm --doc (block rm lives in mutate.ts; this handles the --doc branch) --

export async function runRmDoc(cli: Cli, doc: string, actor?: string): Promise<number> {
  if (cli.flags.server) {
    return report(cli, "deleted", await remoteCall<DocOpResult>(cli, "docs_delete", { doc, ...dryRunArg(cli) }));
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = surfaceDocOpResult(docsDelete(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, actor), doc));
  return report(cli, "deleted", res);
}

// ---- meta -------------------------------------------------------------------

async function runMeta(cli: Cli, args: string[]): Promise<number> {
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
    return renderHelp(cli, {
      name: "meta",
      summary: "Surgical frontmatter patch: set/unset keys without touching the body",
      usage: "meta <doc> [--set k=v]… [--set-json k=<json>]… [--unset k]… [--actor <s>] [--dry-run]",
      options: [
        ["--set k=v", "set a string value (repeatable)"],
        ["--set-json k=<json>", "set a typed value from JSON (repeatable)"],
        ["--unset k", "remove a key (repeatable)"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
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

  if (cli.flags.server) {
    return report(cli, "patched", await remoteCall<DocOpResult>(cli, "docs_set_meta", {
      doc,
      ...(Object.keys(set).length ? { set } : {}),
      ...(unset.length ? { unset } : {}),
      ...dryRunArg(cli),
    }));
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const res = surfaceDocOpResult(docsSetMeta(ws.store, ctxOf(cli, ws, repo.repoId, repo.rootPath, values.actor), doc, { set, unset }));
  return report(cli, "patched", res);
}

function dryRunArg(cli: Cli): { dry_run?: true } {
  return cli.flags.dryRun ? { dry_run: true } : {};
}

// The path a move left behind, for the retarget hint, in the reference form:
// the dangling links name it as written (`target`, the canonical spelling with
// a leading `/`); fall back to the ref the user typed when nothing dangles.
function fromPathOf(res: DocMoveResult, ref: string): string {
  const named = res.dangling.find((l) => l.target)?.target;
  return referencePath(named ?? ref);
}

export const cmdNew: Command = { name: "new", summary: "Create a document", run: (c, a) => runNew(c, a) };
export const cmdMv: Command = { name: "mv", summary: "Rename a document", run: (c, a) => runMv(c, a) };
export const cmdMeta: Command = { name: "meta", summary: "Patch a document's frontmatter", run: (c, a) => runMeta(c, a) };
