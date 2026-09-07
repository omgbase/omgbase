#!/usr/bin/env node
import { VERSION, freshnessSweep, watchLeaseLive } from "@omgbase/core";
import { processIO, type IO } from "./render.js";
import {
  makeCli,
  NO_WORKSPACE_OK,
  SKIP_FRESHNESS,
  type Cli,
  type GlobalFlags,
} from "./context.js";
import { CliUsageError, renderError, EXIT_OK, EXIT_USAGE } from "./output.js";
import { resolveCommand } from "./commands.js";

// Hand-rolled router (11 §8: no commander). Splits global flags from the
// command + its residual argv, resolves the command (with aliases), runs the
// freshness sweep unless exempt, dispatches, and maps thrown errors to exit
// codes. Each command is a pure function (Cli, args) → exit code | Promise.

interface Parsed {
  flags: GlobalFlags;
  command: string | null;
  rest: string[];
}

// Global flags are recognized anywhere in argv — before OR after the command
// (§2.2 treats --json/--ids/etc. as global). We scan the whole argv, pull out
// recognized global flags (and their values), take the first leftover token as
// the command, and hand the remaining tokens to the command as its residual.
// Everything after a literal `--` is passed through untouched.
function parseGlobals(argv: string[]): Parsed {
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

export async function run(argv: string[], io: IO = processIO): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseGlobals(argv);
  } catch (err) {
    // No Cli/style yet — render minimally.
    io.err(String((err as Error).message ?? err));
    return EXIT_USAGE;
  }

  const { flags } = parsed;
  let command = parsed.command;

  // --version / --help without a command.
  if (flags.version && !command) {
    io.out(VERSION);
    return EXIT_OK;
  }
  if (flags.help && !command) command = "help";
  if (!command) command = "help";

  const resolved = resolveCommand(command);
  if (!resolved) {
    const cli = makeCli(flags, io);
    return renderError(new CliUsageError(`unknown command '${command}'`), io, cli.style, flags.mode !== "human");
  }
  // `--help` after a command → route to help for that command.
  if (flags.help) parsed.rest.unshift("--help");

  const cli: Cli = makeCli(flags, io);

  try {
    // Freshness sweep (11 §3.3): current-by-default, unless --stale, a live
    // watcher holds the lease, or the command manages sync itself.
    if (!flags.stale && !SKIP_FRESHNESS.has(resolved.name) && !NO_WORKSPACE_OK.has(resolved.name)) {
      const ws = cli.workspace();
      if (!watchLeaseLive(ws.omgbaseDir)) {
        const repo = cli.repo(ws);
        // Freshness is the filesystem fast-path; sourceless/non-fs repos skip it.
        if (repo.rootPath) freshnessSweep(ws.store, repo.repoId, repo.rootPath);
      }
    }
    const code = await resolved.run(cli, parsed.rest);
    return code;
  } catch (err) {
    return renderError(err, io, cli.style, flags.mode !== "human");
  }
}

// Entry point.
run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exitCode = 1;
  },
);
