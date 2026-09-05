import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  resolveRef,
  tasksComplete,
  sectionsAppend,
  type Op,
  type To,
  type At,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";
import { runOps, readContent, readStdin, expandBlockArgs, extractContentOpts } from "./_mutate.js";
import { runRmDoc } from "./docs.js";

// Write sugar (11 §5.6): each command builds kernel Ops and applies them as one
// changeset via the shared runOps helper (writer flock, actor default, dry-run,
// conflict rendering). `apply` is the primitive; the rest are sugar.

function block(cli: Cli, ws: ReturnType<Cli["workspace"]>, repoId: string, ref: string): string {
  const r = resolveRef(ws.store, repoId, ref);
  if (!r || r.kind !== "block") throw new EngineErrorLike("block_missing", `not a block: ${ref}`);
  return r.blockId!;
}

function rawHashOf(ws: ReturnType<Cli["workspace"]>, blockId: string): string | null {
  const row = ws.store.db
    .prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
    .get(blockId) as { h: string } | undefined;
  return row?.h ?? null;
}

// Parse an `--at` spec: end|start|before X|after X (default end).
function parseAt(values: { at?: string }): At {
  const at = values.at?.trim();
  if (!at || at === "end") return "end";
  if (at === "start") return "start";
  const m = /^(before|after)\s+(.+)$/.exec(at);
  if (m) return m[1] === "before" ? { before: m[2]! } : { after: m[2]! };
  throw new CliUsageError(`bad --at '${at}' (use end|start|before <id>|after <id>)`);
}

// ---- apply (primitive) ------------------------------------------------------

function runApply(cli: Cli, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { f: { type: "string", short: "f" }, reason: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  apply -f changeset.json|-  [--reason s] [--actor s]  — apply a raw changeset");
    return EXIT_OK;
  }
  const raw = values.f ? (values.f === "-" ? readStdin() : readFileSync(values.f, "utf8")) : readStdin();
  const parsed = JSON.parse(raw) as { ops?: Op[] };
  if (!parsed.ops || !Array.isArray(parsed.ops)) throw new CliUsageError("changeset must have an `ops` array");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  return runOps(cli, ws, repo, parsed.ops, { ...(values.reason ? { reason: values.reason } : {}), ...(values.actor ? { actor: values.actor } : {}) });
}

// ---- insert -----------------------------------------------------------------

function runInsert(cli: Cli, args: string[]): number {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { at: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  insert <to> [--at end|start|before X|after X] (-m md | -f file | -)  — insert blocks");
    return EXIT_OK;
  }
  const to = positionals[0];
  if (!to) throw new CliUsageError("insert requires a <to> parent (block id, or a heading id for section append)");
  const markdown = readContent(content);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const parent = block(cli, ws, repo.repoId, to);
  const op: Op = { op: "insert", to: { parent, at: parseAt(values) } as To, markdown };
  return runOps(cli, ws, repo, [op], actorOf(values));
}

// ---- update -----------------------------------------------------------------

function runUpdate(cli: Cli, args: string[]): number {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { expect: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  update <block> (-m md | -f file | -) [--expect hash]  — replace a block's markdown (CAS)");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("update requires a <block>");
  const markdown = readContent(content);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blockId = block(cli, ws, repo.repoId, ref);
  // CAS (§5.7): scripted callers pass --expect; interactive callers omit it and
  // we pin the just-read hash (protects against concurrent edits, not against
  // edits since a read the caller never made).
  const expect = values.expect ?? rawHashOf(ws, blockId);
  if (!values.expect) {
    cli.io.err(cli.style.dim(`  updating ${ref} (CAS pinned from current bytes)`));
  }
  const op: Op = { op: "update", block: blockId, markdown, ...(expect ? { expect: { content_hash: expect } } : {}) };
  return runOps(cli, ws, repo, [op], actorOf(values));
}

// ---- move -------------------------------------------------------------------

function runMove(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { to: { type: "string" }, at: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  move <blocks…|-> --to <parent> [--at …]  — move blocks under a new parent");
    return EXIT_OK;
  }
  if (!values.to) throw new CliUsageError("move requires --to <parent>");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = expandBlockArgs(positionals).map((r) => block(cli, ws, repo.repoId, r));
  if (blocks.length === 0) throw new CliUsageError("move requires one or more blocks (or - for stdin)");
  const parent = block(cli, ws, repo.repoId, values.to);
  const op: Op = { op: "move", blocks, to: { parent, at: parseAt(values) } as To };
  return runOps(cli, ws, repo, [op], actorOf(values));
}

// ---- rm (blocks; --doc handled by the doc-level command) --------------------

function runRm(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { doc: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  rm <blocks…|->            — remove blocks (resurrection pool catches regret)\n  rm --doc <doc>            — delete a whole document");
    return EXIT_OK;
  }
  if (values.doc !== undefined) {
    // Doc deletion always requires the explicit --doc (11 §5.6).
    return runRmDoc(cli, values.doc, values.actor);
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = expandBlockArgs(positionals).map((r) => block(cli, ws, repo.repoId, r));
  if (blocks.length === 0) throw new CliUsageError("rm requires one or more blocks (or - for stdin), or --doc");
  const op: Op = { op: "remove", blocks };
  return runOps(cli, ws, repo, [op], actorOf(values));
}

// ---- done (tasks_complete) --------------------------------------------------

function runDone(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { undo: { type: "boolean" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  done <blocks…|-> [--undo]  — check (or uncheck) task blocks");
    return EXIT_OK;
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = expandBlockArgs(positionals).map((r) => block(cli, ws, repo.repoId, r));
  if (blocks.length === 0) throw new CliUsageError("done requires one or more task blocks (or - for stdin)");
  const ops: Op[] = values.undo
    ? blocks.map((b) => ({ op: "update", block: b, attrs: { checked: false }, expect: pinned(ws, b) }) as Op)
    : tasksComplete(ws.store, blocks);
  return runOps(cli, ws, repo, ops, actorOf(values));
}

// ---- append (sections_append) -----------------------------------------------

function runAppend(cli: Cli, args: string[]): number {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  append <heading> (-m md | -f | -)  — append content at the end of a heading's section");
    return EXIT_OK;
  }
  const heading = positionals[0];
  if (!heading) throw new CliUsageError("append requires a <heading> block");
  const markdown = readContent(content);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const headingId = block(cli, ws, repo.repoId, heading);
  return runOps(cli, ws, repo, sectionsAppend(headingId, markdown), actorOf(values));
}

// ---- split / merge ----------------------------------------------------------

function runSplit(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { at: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  split <block> --at n[,n…]  — split a block at character offset(s)");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("split requires a <block>");
  if (!values.at) throw new CliUsageError("split requires --at n[,n…]");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blockId = block(cli, ws, repo.repoId, ref);
  const at = values.at.split(",").map((s) => Number(s.trim()));
  const op: Op = { op: "split", block: blockId, at, expect: { content_hash: rawHashOf(ws, blockId) ?? "" } };
  return runOps(cli, ws, repo, [op], actorOf(values));
}

function runMerge(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { sep: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  merge <blocks…>  — merge adjacent blocks into the first");
    return EXIT_OK;
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = expandBlockArgs(positionals).map((r) => block(cli, ws, repo.repoId, r));
  if (blocks.length < 2) throw new CliUsageError("merge requires at least two blocks");
  const op: Op = { op: "merge", blocks, ...(values.sep !== undefined ? { separator: values.sep } : {}) };
  return runOps(cli, ws, repo, [op], actorOf(values));
}

// helpers ---------------------------------------------------------------------

function pinned(ws: ReturnType<Cli["workspace"]>, blockId: string): { content_hash: string } {
  return { content_hash: rawHashOf(ws, blockId) ?? "" };
}
function actorOf(values: { actor?: string }): { actor?: string } {
  return values.actor ? { actor: values.actor } : {};
}

export const cmdApply: Command = { name: "apply", summary: "Apply a raw changeset (the primitive)", run: (c, a) => runApply(c, a) };
export const cmdInsert: Command = { name: "insert", summary: "Insert blocks under a parent", run: (c, a) => runInsert(c, a) };
export const cmdUpdate: Command = { name: "update", summary: "Replace a block's markdown (CAS)", run: (c, a) => runUpdate(c, a) };
export const cmdMove: Command = { name: "move", summary: "Move blocks under a new parent", run: (c, a) => runMove(c, a) };
export const cmdRm: Command = { name: "rm", summary: "Remove blocks (or --doc a document)", run: (c, a) => runRm(c, a) };
export const cmdDone: Command = { name: "done", summary: "Check/uncheck task blocks", run: (c, a) => runDone(c, a) };
export const cmdAppend: Command = { name: "append", summary: "Append into a heading's section", run: (c, a) => runAppend(c, a) };
export const cmdSplit: Command = { name: "split", summary: "Split a block at offsets", run: (c, a) => runSplit(c, a) };
export const cmdMerge: Command = { name: "merge", summary: "Merge adjacent blocks", run: (c, a) => runMerge(c, a) };
