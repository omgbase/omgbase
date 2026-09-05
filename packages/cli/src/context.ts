import { resolve } from "node:path";
import { Workspace, RepoSelectionError, type RepoRow } from "@omgbase/core";
import { Style } from "./style.js";
import { Renderer, type IO } from "./render.js";
import { CliUsageError, EngineErrorLike } from "./output.js";

// Parsed global flags shared by every command (11 §2.2). Command-specific flags
// are parsed per-command from the residual argv.

export type OutputMode = "human" | "json" | "jsonl" | "ids";

export interface GlobalFlags {
  directory?: string; // -C
  repo?: string; // --repo
  mode: OutputMode; // --json / --jsonl / --ids (default human)
  stale: boolean; // --stale (skip freshness sweep)
  noColor: boolean; // --no-color / NO_COLOR / non-TTY
  dryRun: boolean; // --dry-run (global across mutators)
  help: boolean;
  version: boolean;
}

export interface Cli {
  flags: GlobalFlags;
  io: IO;
  style: Style;
  render: Renderer;
  cwd: string;
  /** Resolve the workspace (walk up from cwd/-C). Throws repo_not_found if none. */
  workspace(): Workspace;
  /** Resolve the active repo within the workspace, honoring --repo. */
  repo(ws: Workspace): RepoRow;
}

export function makeCli(flags: GlobalFlags, io: IO): Cli {
  const cwd = flags.directory ? resolveDir(flags.directory) : process.cwd();
  const noColor = flags.noColor || !io.stdoutTTY || process.env.NO_COLOR != null;
  const style = new Style({ noColor, isTTY: io.stdoutTTY });
  const render = new Renderer(style);

  let cachedWs: Workspace | null = null;
  return {
    flags,
    io,
    style,
    render,
    cwd,
    workspace(): Workspace {
      if (cachedWs) return cachedWs;
      const ws = Workspace.find(cwd);
      if (!ws) {
        throw new EngineErrorLike(
          "repo_not_found",
          `no omgbase workspace found at or above ${cwd}`,
          { hint: "run `omgbase init` to create one" },
        );
      }
      cachedWs = ws;
      return ws;
    },
    repo(ws: Workspace): RepoRow {
      try {
        return ws.selectRepo(cwd, flags.repo);
      } catch (err) {
        if (err instanceof RepoSelectionError) {
          throw new EngineErrorLike(err.code, err.message, { data: { candidates: err.candidates } });
        }
        throw err;
      }
    },
  };
}

function resolveDir(dir: string): string {
  return resolve(dir);
}

// Which commands may run without a workspace (11 §2.1).
export const NO_WORKSPACE_OK = new Set(["init", "attach", "help", "version"]);
// Commands that manage sync themselves — skip the freshness sweep (11 §3.3).
export const SKIP_FRESHNESS = new Set(["sync", "watch", "mcp", "init", "attach", "help", "version"]);

export { CliUsageError };
