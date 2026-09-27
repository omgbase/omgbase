import { freshnessSweep, watchLeaseLive } from "@omgbase/core";
import { NO_WORKSPACE_OK, SKIP_FRESHNESS, REMOTE_OK, asksForHelp, type Cli, type GlobalFlags } from "./context.js";
import { CliUsageError, EngineErrorLike, renderError, usageFromParseArgs } from "./output.js";
import { resolveCommand, unknownCommandError } from "./commands.js";

// Split global flags from the command + its residual argv (11 §2.2). Global
// flags are recognized anywhere — before OR after the command. Everything after
// a literal `--` is passed through untouched. Shared by the one-shot entry and
// the shell (each shell line parses like a fresh argv).
//
// A malformed global flag (a missing value, an empty `--server`, a stray flag
// before any command) does not throw: it is returned as `error` alongside the
// flags parsed so far, so the caller can render it as every other usage error is
// rendered — with the `usage:` prefix, in the mode the argv asked for.

export interface Parsed {
  flags: GlobalFlags;
  command: string | null;
  rest: string[];
  /** the first malformed global flag, when any (exit 2) */
  error?: CliUsageError;
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
  let error: CliUsageError | undefined;
  // Record the first malformed flag and keep parsing (a later `--json` still
  // selects the mode the error is rendered in).
  const fail = (message: string): void => {
    error ??= new CliUsageError(message);
  };

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
        if (dir === undefined) fail(`${a} requires a directory`);
        else flags.directory = dir;
        continue;
      }
      case "--repo": {
        const slug = argv[++i];
        if (slug === undefined) fail("--repo requires a slug");
        else flags.repo = slug;
        continue;
      }
      case "--server": {
        // An empty value is a mistake, not "local": the flag was given.
        const s = argv[++i];
        if (s === undefined || s === "") fail("--server requires a command or url");
        else flags.server = s;
        continue;
      }
      case "-H":
      case "--header": {
        const h = argv[++i];
        if (h === undefined) fail(`${a} requires a "Name: value" header`);
        else (flags.headers ??= []).push(h);
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
        if (!command) {
          fail(`unknown flag ${a}`);
          continue;
        }
        rest.push(a);
    }
  }
  return { flags, command, rest, ...(error ? { error } : {}) };
}

// Per-command execution shared by the one-shot entry (main.ts) and the
// interactive shell (cmd/shell.ts). Given a resolved Cli, a command name, and
// its residual argv, this runs the freshness sweep (11 §3.3), dispatches the
// command, and maps thrown errors to exit codes via the output contract. The
// shell reuses this so a shell line behaves exactly like a one-shot invocation.

export async function runCommand(cli: Cli, command: string, rest: string[]): Promise<number> {
  const resolved = resolveCommand(command);
  if (!resolved) {
    return renderError(unknownCommandError(cli.prog, command), cli.io, cli.style, cli.flags.mode !== "human");
  }
  // `--help` after a command → route to help for that command. Help is
  // documentation, not work: it must never need a workspace, so it also skips
  // the freshness sweep below (which would otherwise fail with repo_not_found
  // from any directory without a `.omgbase/`). The help *words* (`config help`,
  // a bare `node`, …) are the same request spelled differently (spec/cli §5).
  const args = cli.flags.help ? ["--help", ...rest] : rest;
  const help = asksForHelp(cli.flags, resolved.name, rest);

  // Global `--server` (remote/MCP mode) is only implemented by some commands so
  // far (REMOTE_OK); reject it elsewhere rather than silently running locally.
  if (cli.flags.server !== undefined && !help && !REMOTE_OK.has(resolved.name)) {
    return renderError(
      new CliUsageError(`--server is not supported for '${resolved.name}' — it needs local ref resolution or a working tree; run it against a local workspace`),
      cli.io,
      cli.style,
      cli.flags.mode !== "human",
    );
  }

  try {
    // Freshness sweep (11 §3.3): current-by-default, unless --stale, a live
    // watcher holds the lease, remote (`--server`) mode (no local tree to sweep),
    // or the command manages sync itself.
    if (!help && !cli.flags.stale && cli.flags.server === undefined && !SKIP_FRESHNESS.has(resolved.name) && !NO_WORKSPACE_OK.has(resolved.name)) {
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
    // A command's own `parseArgs` rejecting an option is a usage error (exit 2),
    // rendered here once for every verb rather than in each parser.
    return renderError(usageFromParseArgs(err, cli.prog, resolved.name), cli.io, cli.style, cli.flags.mode !== "human");
  }
}
