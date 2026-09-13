import { freshnessSweep, watchLeaseLive } from "@omgbase/core";
import { NO_WORKSPACE_OK, SKIP_FRESHNESS, type Cli, type GlobalFlags } from "./context.js";
import { CliUsageError, EngineErrorLike, renderError } from "./output.js";
import { resolveCommand } from "./commands.js";

// Split global flags from the command + its residual argv (11 §2.2). Global
// flags are recognized anywhere — before OR after the command. Everything after
// a literal `--` is passed through untouched. Shared by the one-shot entry and
// the shell (each shell line parses like a fresh argv).

export interface Parsed {
  flags: GlobalFlags;
  command: string | null;
  rest: string[];
}

export function parseGlobals(argv: string[]): Parsed {
  const flags: GlobalFlags = {
    mode: "human",
    stale: false,
    noColor: false,
    dryRun: false,
    help: false,
    version: false,
  };
  let command: string | null = null;
  const rest: string[] = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (passthrough) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      passthrough = true;
      if (command) rest.push(a);
      continue;
    }
    switch (a) {
      case "-C":
      case "--directory": {
        const dir = argv[++i];
        if (dir === undefined) throw new CliUsageError(`${a} requires a directory`);
        flags.directory = dir;
        continue;
      }
      case "--repo": {
        const slug = argv[++i];
        if (slug === undefined) throw new CliUsageError("--repo requires a slug");
        flags.repo = slug;
        continue;
      }
      case "--json":
        flags.mode = "json";
        continue;
      case "--jsonl":
        flags.mode = "jsonl";
        continue;
      case "--ids":
        flags.mode = "ids";
        continue;
      case "--stale":
        flags.stale = true;
        continue;
      case "--no-color":
        flags.noColor = true;
        continue;
      case "--dry-run":
        flags.dryRun = true;
        continue;
      case "--help":
      case "-h":
        flags.help = true;
        continue;
      case "--version":
      case "-V":
        flags.version = true;
        continue;
      default:
        if (!command && !a.startsWith("-")) {
          command = a;
          continue;
        }
        // Once the command is known, anything unrecognized is its residual;
        // a stray flag before any command is a usage error.
        if (!command) throw new CliUsageError(`unknown flag ${a}`);
        rest.push(a);
    }
  }
  return { flags, command, rest };
}

// Per-command execution shared by the one-shot entry (main.ts) and the
// interactive shell (cmd/shell.ts). Given a resolved Cli, a command name, and
// its residual argv, this runs the freshness sweep (11 §3.3), dispatches the
// command, and maps thrown errors to exit codes via the output contract. The
// shell reuses this so a shell line behaves exactly like a one-shot invocation.

export async function runCommand(cli: Cli, command: string, rest: string[]): Promise<number> {
  const resolved = resolveCommand(command);
  if (!resolved) {
    return renderError(
      new CliUsageError(`unknown command '${command}'`),
      cli.io,
      cli.style,
      cli.flags.mode !== "human",
    );
  }
  // `--help` after a command → route to help for that command.
  const args = cli.flags.help ? ["--help", ...rest] : rest;

  try {
    // Freshness sweep (11 §3.3): current-by-default, unless --stale, a live
    // watcher holds the lease, or the command manages sync itself.
    if (!cli.flags.stale && !SKIP_FRESHNESS.has(resolved.name) && !NO_WORKSPACE_OK.has(resolved.name)) {
      const ws = cli.workspace();
      if (!watchLeaseLive(ws.omgbaseDir)) {
        // Best-effort: a workspace with no attached repo (or an unresolvable
        // cwd) has nothing to sweep. That's not an error for the command
        // itself — only the sweep is skipped; the command surfaces its own
        // repo_not_found if it truly needs a repo.
        try {
          const repo = cli.repo(ws);
          if (repo.rootPath) freshnessSweep(ws.store, repo.repoId, repo.rootPath);
        } catch (err) {
          if (!(err instanceof EngineErrorLike && err.code === "repo_not_found")) throw err;
        }
      }
    }
    return await resolved.run(cli, args);
  } catch (err) {
    return renderError(err, cli.io, cli.style, cli.flags.mode !== "human");
  }
}
