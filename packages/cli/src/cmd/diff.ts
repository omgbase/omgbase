import { parseArgs } from "node:util";
import { findDoc, requireHistoryReader, type DocDiffUnified, type DiffEntry } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, emitMachine, renderHelp } from "../output.js";
import { remoteCall, docLocator } from "./_remote.js";

// `omg diff <doc>` (11 §5.5) — `docs_diff_unified`: the unified diff, `--json` the
// tool's `{ _id, _path, from, to, diff }` (spec/surface §3, 5.0). With no revisions: current vs previous
// ("what did the last commit do here"). `--blocks` is the block-grain `diff`
// tool: added/removed/changed blocks between the same two revisions.

async function runDiff(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { from: { type: "string" }, to: { type: "string" }, blocks: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "diff",
      summary: "Unified diff of a document between two revisions (default: previous → current)",
      usage: "diff <doc> [--from <rev>] [--to <rev>] [--blocks]",
      options: [
        ["--from <rev>", "older revision id (default: the one before --to)"],
        ["--to <rev>", "newer revision id (default: current)"],
        ["--blocks", "block-grain: which blocks were added, removed or changed (the `docs_diff` tool)"],
      ],
    });
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("diff requires a <doc>");

  let result: DocDiffUnified;
  if (cli.flags.server) {
    result = await remoteCall<DocDiffUnified>(cli, "docs_diff_unified", {
      ...docLocator(ref),
      ...(values.from ? { from_rev: values.from } : {}),
      ...(values.to ? { to_rev: values.to } : {}),
    });
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    const info = ref.startsWith("d_") ? findDoc(ws.store, { docId: ref }) : findDoc(ws.store, { repoId: repo.repoId, path: ref });
    if (!info) throw new EngineErrorLike("doc_missing", `no document ${ref}`);
    // Through the recorder seam (Phase 4a): `capability_unavailable { history, unavailable | disabled }` when the build has no module or nothing was ever captured.
    result = requireHistoryReader(ws.store.db).docDiffUnified(info.docId, {
      ...(values.from ? { fromRev: values.from } : {}),
      ...(values.to ? { toRev: values.to } : {}),
      label: ref,
    });
  }

  const { style, io } = cli;
  if (values.blocks) {
    // Block-grain over the same resolved revision pair.
    let entries: DiffEntry[];
    if (cli.flags.server) entries = await remoteCall<DiffEntry[]>(cli, "docs_diff", { ...docLocator(ref), from_rev: result.from, to_rev: result.to });
    else entries = requireHistoryReader(cli.workspace().store.db).diffBlocks(result._id, result.from, result.to);
    if (cli.flags.mode !== "human") return emitMachine(cli, entries, { items: entries, ids: entries.map((e) => e._id) });
    if (entries.length === 0) {
      io.err(style.dim("  no changes"));
      return EXIT_OK;
    }
    for (const e of entries) {
      const mark = e.kind === "added" ? style.ok("+") : e.kind === "removed" ? style.err("-") : style.warn("~");
      const preview = (e.after ?? e.before ?? "").split("\n")[0] ?? "";
      io.out(`${mark} ${style.id(e._id)}  ${preview}`.trimEnd());
    }
    return EXIT_OK;
  }

  if (cli.flags.mode !== "human") return emitMachine(cli, result);
  if (!result.diff) {
    io.err(style.dim("  no changes"));
    return EXIT_OK;
  }
  for (const line of result.diff.split("\n")) {
    if (line.startsWith("+")) io.out(style.ok(line));
    else if (line.startsWith("-")) io.out(style.err(line));
    else io.out(line);
  }
  return EXIT_OK;
}

export const cmdDiff: Command = { name: "diff", summary: "Unified diff of a document", run: (cli, a) => runDiff(cli, a) };
