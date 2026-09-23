import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRef, nodesGet, type Op } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, renderHelp } from "../output.js";
import { runOps } from "./_mutate.js";

// `omg edit <block>` (11 §5.6, §5.7): read the block's raw markdown → open it in
// $EDITOR → update with the PRE-READ hash pinned as CAS. A mid-edit change by
// someone else lands as a clean stale_expectation (with current truth), never a
// lost write. The human structural-edit loop.

function rawHashOf(ws: ReturnType<Cli["workspace"]>, blockId: string): string | null {
  const row = ws.store.db
    .prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
    .get(blockId) as { h: string } | undefined;
  return row?.h ?? null;
}

function runEdit(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "edit",
      summary: "Open a block's markdown in $EDITOR and write it back with compare-and-swap pinned to what you saw",
      usage: "edit <block> [--actor <s>] [--dry-run]",
      options: [["--actor <s>", "commit actor (default human:$USER)"]],
    });
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("edit requires a <block>");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved || resolved.kind !== "block") throw new EngineErrorLike("block_missing", `not a block: ${ref}`);
  const blockId = resolved.blockId!;

  const node = nodesGet(ws.store, resolved.docId, blockId, { resolution: "raw" });
  const before = node?.raw ?? "";
  const preHash = rawHashOf(ws, blockId); // pin BEFORE the editor opens

  const editor = process.env.OMG_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) throw new EngineErrorLike("target_missing", "no $EDITOR set (or $VISUAL/$OMG_EDITOR)");
  if (!cli.io.stdoutTTY && !process.env.OMG_EDITOR) {
    // Interactive editors need a terminal; OMG_EDITOR (e.g. a script) is the
    // scripted/test escape hatch.
    throw new EngineErrorLike("target_missing", "edit needs a TTY; set OMG_EDITOR to a non-interactive editor for scripts");
  }

  const dir = mkdtempSync(join(tmpdir(), "omg-edit-"));
  const file = join(dir, "block.md");
  try {
    writeFileSync(file, before);
    const [cmd, ...preArgs] = editor.split(/\s+/);
    const res = spawnSync(cmd!, [...preArgs, file], { stdio: "inherit" });
    if (res.status !== 0) throw new EngineErrorLike("target_missing", `editor exited ${res.status ?? "abnormally"}`);
    const after = readFileSync(file, "utf8");
    if (after === before) {
      cli.io.err(cli.style.dim("  no changes"));
      return EXIT_OK;
    }
    const op: Op = { op: "update", block: blockId, markdown: after, ...(preHash ? { expect: { content_hash: preHash } } : {}) };
    return runOps(cli, ws, repo, [op], values.actor ? { actor: values.actor } : {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const cmdEdit: Command = { name: "edit", summary: "Edit a block in $EDITOR (CAS pinned)", run: (c, a) => runEdit(c, a) };
