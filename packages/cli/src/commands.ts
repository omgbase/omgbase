import type { Cli } from "./context.js";
import { CliUsageError } from "./output.js";

// Command registry (11 §8: the catalog is data in the router). Each command is a
// pure function (Cli, residual args) → exit code. CLI-A ships the read surface +
// bootstrap + sync; CLI-B adds the write surface, run, watch, mcp, admin.

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  /** false → hidden from the default help listing (dev/advanced). */
  listed?: boolean;
  run(cli: Cli, args: string[]): number | Promise<number>;
}

import { cmdInit, cmdRepos } from "./cmd/bootstrap.js";
import { cmdStatus } from "./cmd/status.js";
import { cmdLs } from "./cmd/ls.js";
import { cmdOutline } from "./cmd/outline.js";
import { cmdCat } from "./cmd/cat.js";
import { cmdShow } from "./cmd/show.js";
import { cmdFind } from "./cmd/find.js";
import { cmdOqx } from "./cmd/oqx.js";
import { cmdLog } from "./cmd/log.js";
import { cmdHist } from "./cmd/hist.js";
import { cmdDiff } from "./cmd/diff.js";
import { cmdLinks } from "./cmd/links.js";
import { cmdSync } from "./cmd/sync.js";
import { cmdMcp } from "./cmd/mcp.js";
import { cmdApply, cmdInsert, cmdMove, cmdRm, cmdDone, cmdAppend, cmdSplit, cmdMerge } from "./cmd/mutate.js";
import { cmdEdit } from "./cmd/edit.js";
import { cmdRetarget } from "./cmd/retarget.js";
import { cmdNode } from "./cmd/node.js";
import { cmdNew, cmdMv, cmdMeta } from "./cmd/docs.js";
import { cmdUpdateDoc } from "./cmd/update.js";
import { cmdRun } from "./cmd/run.js";
import { cmdRebuild, cmdGc, cmdDoctor, cmdConfig, cmdEmbed } from "./cmd/admin.js";
import { cmdShell } from "./cmd/shell.js";
import { cmdSource } from "./cmd/source.js";
import { cmdHelp } from "./cmd/help.js";

export const COMMANDS: Command[] = [
  cmdInit,
  cmdRepos,
  cmdStatus,
  cmdLs,
  cmdOutline,
  cmdCat,
  cmdShow,
  cmdFind,
  cmdOqx,
  cmdLog,
  cmdHist,
  cmdDiff,
  cmdLinks,
  cmdApply,
  cmdInsert,
  cmdUpdateDoc,
  cmdEdit,
  cmdMove,
  cmdRm,
  cmdDone,
  cmdAppend,
  cmdRetarget,
  cmdNode,
  cmdSplit,
  cmdMerge,
  cmdNew,
  cmdMv,
  cmdMeta,
  cmdRun,
  cmdShell,
  cmdSource,
  cmdSync,
  cmdMcp,
  cmdRebuild,
  cmdGc,
  cmdDoctor,
  cmdConfig,
  cmdEmbed,
  cmdHelp,
];

const BY_NAME = new Map<string, Command>();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases ?? []) BY_NAME.set(a, c);
}

export function resolveCommand(name: string): Command | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * The usage error for an unrecognized command: names the typo, points at the
 * command list (quoting the binary as it was invoked), and — when one listed
 * command or alias is within two edits — offers it as "did you mean".
 */
export function unknownCommandError(prog: string, name: string): CliUsageError {
  const hint = `run '${prog} --help' for the command list`;
  const guess = didYouMean(name);
  return new CliUsageError(`unknown command '${name}'`, guess ? `did you mean '${guess}'? ${hint}` : hint);
}

function didYouMean(name: string): string | null {
  // Two edits for a real word, one for something short — `statsu` → status,
  // `lz` → ls, but a lone `x` suggests nothing rather than `q`.
  const maxEdits = name.length <= 3 ? 1 : 2;
  let best: { name: string; d: number } | null = null;
  for (const candidate of BY_NAME.keys()) {
    const d = editDistance(name.toLowerCase(), candidate);
    if (d <= maxEdits && (!best || d < best.d)) best = { name: candidate, d };
  }
  return best?.name ?? null;
}

// Levenshtein distance; the inputs are short command names, so the plain
// two-row DP is plenty.
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}
