import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  resolveRef,
  isContainerBlock,
  appendEffects,
  checkEffects,
  insertEffects,
  mergeEffects,
  moveBlocksEffects,
  removeBlocksEffects,
  splitEffects,
  updateBlockEffects,
  type Store,
  type At,
  type EffectTarget,
  type Sugar,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, renderHelp } from "../output.js";
import { runSugar, runSugarRemote, runEffects, runEffectsRemote, runExecutePlan, runExecutePlanRemote, readContent, readStdin, expandBlockArgs, extractContentOpts, targetOf } from "./_mutate.js";
import { runRmDoc } from "./docs.js";
import { remoteCall, remoteHasTool } from "./_remote.js";

// Write sugar (11 §5.6; cli 4.0): each command resolves its refs, builds its
// effects with the shared builders of `@omgbase/core` (the same table the MCP
// tools use — ADR-012, the CLI holds no business logic) and applies them as one
// request via `runSugar` (writer flock, actor default, `--dry-run` as a plan,
// conflict rendering). `apply` is the primitive — a changeset of `effects`
// (ADR-021, the intentional-write vocabulary; the kernel `ops` input is retired
// at cli 4.0) — and `execute` commits a frozen plan; the rest are sugar.

// Error data spells a row attribute as the attribute (spec/surface §4, 5.0):
// `block_missing { _id }`, and the CLI's own `type_mismatch` names the block's
// `_id` and `_type`.
function block(cli: Cli, ws: ReturnType<Cli["workspace"]>, repoId: string, ref: string): string {
  const r = resolveRef(ws.store, repoId, ref);
  if (!r || r.kind !== "block") throw new EngineErrorLike("block_missing", `no block with id ${JSON.stringify(ref)}`, { data: { _id: ref } });
  return r.blockId!;
}

// A parent ref for insert/move: a block ref names that block as the parent; a
// document ref (id or path) names the document's top level — the same reading
// the server gives `blocks_insert.to` / `blocks_move.to`. The target's address
// is the row's `_id` (spec/mutate §11, 4.0).
function parent(ws: ReturnType<Cli["workspace"]>, repoId: string, ref: string): EffectTarget {
  const r = resolveRef(ws.store, repoId, ref);
  if (!r) throw new EngineErrorLike("block_missing", `no block with id ${JSON.stringify(ref)}`, { data: { _id: ref } });
  if (r.kind === "document") return { kind: "document", _id: r.docId };
  return { kind: "block", _id: r.blockId! };
}

// `done` addresses task blocks only (spec/cli §6): any other live block type is
// a type_mismatch before an op is built — the macro itself would record a no-op
// `edited` commit (its `_attrs.checked` only rewrites a task's marker).
function taskBlock(ws: ReturnType<Cli["workspace"]>, ref: string, blockId: string): string {
  const row = ws.store.db
    .prepare("SELECT type FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
    .get(blockId) as { type: string } | undefined;
  if (!row) throw new EngineErrorLike("block_missing", `no block with id ${JSON.stringify(ref)}`, { data: { _id: ref } });
  if (row.type !== "task") {
    throw new EngineErrorLike("type_mismatch", `not a task: ${ref} is a ${row.type}`, { data: { _id: blockId, _type: row.type } });
  }
  return blockId;
}

/** The block ref an `--at` anchor names (none for start/end) — a ref the remote fallback must be able to send as an id. */
function anchorOf(at: At): string[] {
  if (typeof at === "string") return [];
  return "before" in at ? [at.before] : [at.after];
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

async function runApply(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { f: { type: "string", short: "f" }, reason: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "apply",
      summary: "Apply a changeset — `{ effects: [...] }`, the intentional writes (create/insert/set/unset/move/remove/split/merge/retarget) planned and committed as one transaction — the primitive every other mutator expands to",
      usage: "apply [-f <changeset.json|->] [--reason <s>] [--actor <s>] [--dry-run]",
      options: [
        ["-f <file|->", "changeset JSON from a file or stdin (default: stdin)"],
        ["--reason <s>", "commit reason recorded in history"],
        ["--actor <s>", "commit actor (default human:$USER)"],
        ["--dry-run", "plan only: render the diff, commit nothing (--json prints the Plan for `execute`)"],
      ],
    });
  }
  const raw = values.f ? (values.f === "-" ? readStdin() : readFileSync(values.f, "utf8")) : readStdin();
  const parsed = JSON.parse(raw) as { ops?: unknown; effects?: unknown };
  // The effects are the one input (spec/cli §6 `apply`, 4.0): the kernel changeset
  // `{ ops }` of 3.x is refused by name — the six ops are a library/fixture contract.
  if (parsed.ops !== undefined) throw new CliUsageError("`ops` is no longer an input — apply takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0)");
  if (parsed.effects === undefined) throw new CliUsageError("changeset must have an `effects` array");
  if (!Array.isArray(parsed.effects)) throw new CliUsageError("changeset `effects` must be an array");
  const opts = { ...(values.reason ? { reason: values.reason } : {}), ...(values.actor ? { actor: values.actor } : {}) };
  if (cli.flags.server) return runEffectsRemote(cli, parsed.effects, values.reason);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  return runEffects(cli, ws, repo, parsed.effects, opts);
}

// ---- execute (the plan form of the Effect layer) ------------------------------

async function runExecute(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { f: { type: "string", short: "f" }, reason: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "execute",
      summary: "Commit exactly a frozen Plan (what `apply -f <effects> --dry-run --json` printed) — one transaction, one commit; stale_plan if a document moved on",
      usage: "execute (-f <plan.json> | -) [--reason <s>] [--actor <s>]",
      options: [
        ["-f <file|->", "the Plan JSON from a file or stdin"],
        ["-", "the Plan JSON from stdin"],
        ["--reason <s>", "commit reason recorded in history"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  // The plan IS the preview: a dry run of `execute` would be `apply --dry-run` again.
  if (cli.flags.dryRun) throw new CliUsageError("execute has no dry run — the plan is the preview (re-plan with apply --dry-run)");
  const source = values.f ?? (positionals[0] === "-" ? "-" : undefined);
  if (source === undefined) throw new CliUsageError("execute requires -f <plan.json> (or - for stdin)");
  const plan = JSON.parse(source === "-" ? readStdin() : readFileSync(source, "utf8")) as unknown;
  if (cli.flags.server) return runExecutePlanRemote(cli, plan, values.reason);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  return runExecutePlan(cli, ws, repo, plan, { ...(values.reason ? { reason: values.reason } : {}), ...(values.actor ? { actor: values.actor } : {}) });
}

// ---- insert -----------------------------------------------------------------

async function runInsert(cli: Cli, args: string[]): Promise<number> {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { at: { type: "string" }, expect: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "insert",
      summary: "Insert markdown as new block(s) under a parent block or heading",
      usage: "insert <to> (-m <markdown> | -f <file> | -) [--at end|start|before <id>|after <id>] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]",
      options: [
        ["<to>", "parent block id, or a heading block id to append into its section"],
        ["-m <markdown>", "content inline"],
        ["-f <file>", "content from a file"],
        ["-", "content from stdin"],
        ["--at <pos>", "end (default) | start | before <id> | after <id>"],
        ["--expect <hash>", "destination CAS: fail with stale_expectation unless the parent's direct child ids (joined by \",\", sha256 hex) still hash to this"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const to = positionals[0];
  if (!to) throw new CliUsageError("insert requires a <to> parent (a container block id, or a doc id/path for the top level)");
  const markdown = readContent(content);
  // The destination-parent CAS (spec/mutate §1.2) rides as the effect's expect.
  const expect = values.expect ? { parent_children_hash: values.expect } : undefined;
  const at = parseAt(values);
  if (cli.flags.server) {
    return runSugarRemote(cli, "blocks_insert", { to, markdown, at, ...(expect ? { expect } : {}) }, () => insertEffects(targetOf(to), at, markdown, expect).effects, [to, ...anchorOf(at)]);
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  return runSugar(cli, ws, repo, insertEffects(parent(ws, repo.repoId, to), at, markdown, expect), actorOf(values));
}

// ---- update -----------------------------------------------------------------

async function runUpdate(cli: Cli, args: string[]): Promise<number> {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { expect: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "update",
      summary: "Replace a block's markdown, with compare-and-swap against the block's current hash",
      usage: "update <block> (-m <markdown> | -f <file> | -) [--expect <hash>] [--actor <s>] [--dry-run]",
      options: [
        ["-m <markdown>", "content inline"],
        ["-f <file>", "content from a file"],
        ["-", "content from stdin"],
        ["--expect <hash>", "fail with stale_expectation unless the block's hash still matches"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("update requires a <block>");
  const markdown = readContent(content);
  const expect = values.expect ? { content_hash: values.expect } : undefined;
  // Remote: the server pins CAS from current bytes when --expect is absent.
  if (cli.flags.server) {
    return runSugarRemote(cli, "blocks_update", { _id: ref, markdown, ...(expect ? { expect } : {}) }, () => updateBlockEffects(ref, { markdown, expect }).effects, [ref]);
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blockId = block(cli, ws, repo.repoId, ref);
  // CAS (§5.7): scripted callers pass --expect; interactive callers omit it and
  // the planner pins the live hash (protects against concurrent edits, not
  // against edits since a read the caller never made).
  if (!values.expect) {
    cli.io.err(cli.style.dim(`  updating ${ref} (CAS pinned from current bytes)`));
  }
  return runSugar(cli, ws, repo, updateBlockEffects(blockId, { markdown, expect }), actorOf(values));
}

// ---- move -------------------------------------------------------------------

async function runMove(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { to: { type: "string" }, at: { type: "string" }, expect: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "move",
      summary: "Move block(s) under a new parent, identity preserved",
      usage: "move <blocks…|-> --to <parent> [--at end|start|before <id>|after <id>] [--expect <parent_children_hash>] [--actor <s>] [--dry-run]",
      options: [
        ["<blocks…>", "block ids; `-` reads them from stdin, one per line"],
        ["--to <parent>", "destination parent block"],
        ["--at <pos>", "end (default) | start | before <id> | after <id>"],
        ["--expect <hash>", "destination CAS: fail with stale_expectation unless the destination's direct child ids (joined by \",\", sha256 hex) still hash to this"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  if (!values.to) throw new CliUsageError("move requires --to <parent>");
  const refs = expandBlockArgs(positionals);
  if (refs.length === 0) throw new CliUsageError("move requires one or more blocks (or - for stdin)");
  // The destination-parent CAS (spec/mutate §1.2), checked once for the run.
  const expect = values.expect ? { parent_children_hash: values.expect } : undefined;
  const at = parseAt(values);
  const to = values.to;
  if (cli.flags.server) {
    return runSugarRemote(cli, "blocks_move", { blocks: refs, to, at, ...(expect ? { expect } : {}) }, () => moveBlocksEffects(refs, targetOf(to), at, expect).effects, [...refs, to, ...anchorOf(at)]);
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = refs.map((r) => block(cli, ws, repo.repoId, r));
  return runSugar(cli, ws, repo, moveBlocksEffects(blocks, parent(ws, repo.repoId, to), at, expect), actorOf(values));
}

// ---- rm (blocks; --doc handled by the doc-level command) --------------------

async function runRm(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { doc: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "rm",
      summary: "Remove block(s) (the resurrection pool catches regret), or delete a whole document with --doc",
      usage: ["rm <blocks…|-> [--actor <s>] [--dry-run]", "rm --doc <doc> [--actor <s>] [--dry-run]"],
      options: [
        ["<blocks…>", "block ids; `-` reads them from stdin, one per line"],
        ["--doc <doc>", "delete a whole document (id or path) — always explicit"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  if (values.doc !== undefined) {
    // Doc deletion always requires the explicit --doc (11 §5.6).
    return runRmDoc(cli, values.doc, values.actor);
  }
  const refs = expandBlockArgs(positionals);
  if (refs.length === 0) throw new CliUsageError("rm requires one or more blocks (or - for stdin), or --doc");
  if (cli.flags.server) return runSugarRemote(cli, "blocks_remove", { blocks: refs }, () => removeBlocksEffects(refs).effects, refs);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = refs.map((r) => block(cli, ws, repo.repoId, r));
  return runSugar(cli, ws, repo, removeBlocksEffects(blocks), actorOf(values));
}

// ---- done (blocks_check) --------------------------------------------------

async function runDone(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { undo: { type: "boolean" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "done",
      summary: "Check (or uncheck) task blocks",
      usage: "done <blocks…|-> [--undo] [--actor <s>] [--dry-run]",
      options: [
        ["<blocks…>", `task block ids; \`-\` reads them from stdin (\`${cli.prog} q … --ids | ${cli.prog} done -\`)`],
        ["--undo", "uncheck instead"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const refs = expandBlockArgs(positionals);
  if (refs.length === 0) throw new CliUsageError("done requires one or more task blocks (or - for stdin)");
  const checked = !values.undo;
  if (cli.flags.server) return runSugarRemote(cli, "blocks_check", { _ids: refs, ...(values.undo ? { checked: false } : {}) }, () => checkEffects(refs, checked).effects, refs);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = refs.map((r) => taskBlock(ws, r, block(cli, ws, repo.repoId, r)));
  return runSugar(cli, ws, repo, checkEffects(blocks, checked), actorOf(values));
}

// ---- append (blocks_append) --------------------------------------------------

async function runAppend(cli: Cli, args: string[]): Promise<number> {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "append",
      summary: "Append markdown into a block: a heading's section or a container's children",
      usage: "append <block> (-m <markdown> | -f <file> | -) [--actor <s>] [--dry-run]",
      options: [
        ["<block>", "a heading (its section receives the content) or a container — list, item, quote, table (its children do)"],
        ["-m <markdown>", "content inline"],
        ["-f <file>", "content from a file"],
        ["-", "content from stdin"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const target = positionals[0];
  if (!target) throw new CliUsageError("append requires a <block>");
  const markdown = readContent(content);
  // Remote: blocks_append resolves the ref and decides by the block's kind
  // server-side (spec/surface §4); a remote dry run reads the kind first.
  if (cli.flags.server) {
    return runSugarRemote(cli, "blocks_append", { _id: target, text: markdown }, async () => {
      // The block's `_type` decides the effect; `blocks_read` reads it on a full
      // server, a `query` over the blocks target on a minimal one (§2.3).
      const type = (await remoteHasTool(cli, "blocks_read"))
        ? (await remoteCall<{ _type: string }>(cli, "blocks_read", { _id: target, resolution: "skeleton" }))._type
        : (await remoteCall<{ hits: { _type?: string }[] }>(cli, "query", { query: `select _type from blocks where _id == ${JSON.stringify(target)}` })).hits[0]?._type;
      return appendEffects(type === "heading" ? { kind: "section", heading_id: target } : { kind: "block", _id: target }, markdown).effects;
    }, [target]);
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blockId = block(cli, ws, repo.repoId, target);
  return runSugar(cli, ws, repo, appendSugar(ws.store, blockId, markdown), actorOf(values));
}

/** The effect `blocks_append` expands to, by what the block is: a heading → the
 *  end of its section; a container → the end of its children; a leaf →
 *  `block_not_container` (append means into, never a sibling insert). */
function appendSugar(store: Store, blockId: string, markdown: string): Sugar {
  const row = store.db
    .prepare("SELECT b.type AS type, d.format AS format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_commit IS NULL) AS children FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_commit IS NULL")
    .get(blockId) as { type: string; format: string | null; children: number } | undefined;
  if (!row) throw new EngineErrorLike("block_missing", `no block with id ${JSON.stringify(blockId)}`, { data: { _id: blockId } });
  if (row.type === "heading") return appendEffects({ kind: "section", heading_id: blockId }, markdown);
  if (isContainerBlock(row.format ?? "markdown", { type: row.type, children: new Array<unknown>(row.children) })) {
    return appendEffects({ kind: "block", _id: blockId }, markdown);
  }
  throw new EngineErrorLike("block_not_container", `block ${blockId} is a ${row.type}, not a heading or a container; append means into — insert after it with blocks_insert { to: <its parent>, at: { after: ${JSON.stringify(blockId)} } }`, { data: { _id: blockId, _type: row.type } });
}

// ---- split / merge ----------------------------------------------------------

async function runSplit(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { at: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "split",
      summary: "Split a block at character offset(s) into sibling blocks",
      usage: "split <block> --at <n[,n…]> [--actor <s>] [--dry-run]",
      options: [
        ["--at <n[,n…]>", "character offset(s) within the block's markdown"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("split requires a <block>");
  if (!values.at) throw new CliUsageError("split requires --at n[,n…]");
  // Offsets are integers (spec/mutate §2.5); anything else is a usage error
  // here, not a NaN that reaches the kernel.
  const at = values.at.split(",").map((s) => {
    const n = Number(s.trim());
    if (s.trim() === "" || !Number.isInteger(n)) throw new CliUsageError(`bad --at '${values.at}' (offsets must be integers: n[,n…])`);
    return n;
  });
  if (cli.flags.server) return runSugarRemote(cli, "blocks_split", { _id: ref, at }, () => splitEffects(ref, at).effects, [ref]);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blockId = block(cli, ws, repo.repoId, ref);
  // The planner pins the content CAS from the live row.
  return runSugar(cli, ws, repo, splitEffects(blockId, at), actorOf(values));
}

async function runMerge(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { sep: { type: "string" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "merge",
      summary: "Merge adjacent blocks into the first (the first block's identity survives)",
      usage: "merge <blocks…|-> [--sep <s>] [--actor <s>] [--dry-run]",
      options: [
        ["<blocks…>", "two or more adjacent block ids; `-` reads them from stdin"],
        ["--sep <s>", "separator placed between the merged texts"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const refs = expandBlockArgs(positionals);
  if (refs.length < 2) throw new CliUsageError("merge requires at least two blocks");
  if (cli.flags.server) return runSugarRemote(cli, "blocks_merge", { blocks: refs, ...(values.sep !== undefined ? { separator: values.sep } : {}) }, () => mergeEffects(refs, values.sep).effects, refs);
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const blocks = refs.map((r) => block(cli, ws, repo.repoId, r));
  return runSugar(cli, ws, repo, mergeEffects(blocks, values.sep), actorOf(values));
}

// helpers ---------------------------------------------------------------------

function actorOf(values: { actor?: string }): { actor?: string } {
  return values.actor ? { actor: values.actor } : {};
}

export const cmdApply: Command = { name: "apply", summary: "Apply a changeset of effects (the primitive)", run: (c, a) => runApply(c, a) };
export const cmdExecute: Command = { name: "execute", summary: "Commit a frozen plan (from apply --dry-run --json)", run: (c, a) => runExecute(c, a) };
export const cmdInsert: Command = { name: "insert", summary: "Insert blocks under a parent", run: (c, a) => runInsert(c, a) };
export const cmdUpdate: Command = { name: "update", summary: "Replace a block's markdown (CAS)", run: (c, a) => runUpdate(c, a) };
export const cmdMove: Command = { name: "move", summary: "Move blocks under a new parent", run: (c, a) => runMove(c, a) };
export const cmdRm: Command = { name: "rm", summary: "Remove blocks (or --doc a document)", run: (c, a) => runRm(c, a) };
export const cmdDone: Command = { name: "done", summary: "Check/uncheck task blocks", run: (c, a) => runDone(c, a) };
export const cmdAppend: Command = { name: "append", summary: "Append into a heading's section", run: (c, a) => runAppend(c, a) };
export const cmdSplit: Command = { name: "split", summary: "Split a block at offsets", run: (c, a) => runSplit(c, a) };
export const cmdMerge: Command = { name: "merge", summary: "Merge adjacent blocks", run: (c, a) => runMerge(c, a) };
