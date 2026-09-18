import type { Cli } from "./context.js";

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
import { cmdWatch, cmdRebuild, cmdGc, cmdDoctor, cmdConfig, cmdImport, cmdEmbed } from "./cmd/admin.js";
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
  cmdWatch,
  cmdMcp,
  cmdRebuild,
  cmdGc,
  cmdDoctor,
  cmdConfig,
  cmdImport,
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
