import type { Cli } from "./context.js";

// Command registry (11 §8: the catalog is data in the router). Each command is a
// pure function (Cli, residual args) → exit code. CLI-A ships the read surface +
// bootstrap + sync; CLI-B adds the write surface, graph, run, watch, mcp, admin.

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  /** false → hidden from the default help listing (dev/advanced). */
  listed?: boolean;
  run(cli: Cli, args: string[]): number | Promise<number>;
}

import { cmdInit, cmdAttach, cmdRepos } from "./cmd/bootstrap.js";
import { cmdStatus } from "./cmd/status.js";
import { cmdLs } from "./cmd/ls.js";
import { cmdOutline } from "./cmd/outline.js";
import { cmdCat } from "./cmd/cat.js";
import { cmdShow } from "./cmd/show.js";
import { cmdFind } from "./cmd/find.js";
import { cmdQuery } from "./cmd/query.js";
import { cmdLog } from "./cmd/log.js";
import { cmdHist } from "./cmd/hist.js";
import { cmdDiff } from "./cmd/diff.js";
import { cmdLinks } from "./cmd/links.js";
import { cmdSync } from "./cmd/sync.js";
import { cmdHelp } from "./cmd/help.js";

export const COMMANDS: Command[] = [
  cmdInit,
  cmdAttach,
  cmdRepos,
  cmdStatus,
  cmdLs,
  cmdOutline,
  cmdCat,
  cmdShow,
  cmdFind,
  cmdQuery,
  cmdLog,
  cmdHist,
  cmdDiff,
  cmdLinks,
  cmdSync,
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
