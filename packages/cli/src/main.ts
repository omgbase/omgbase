#!/usr/bin/env node
import { VERSION } from "@omgbase/core";
import { processIO, type IO } from "./render.js";
import { makeCli, type Cli } from "./context.js";
import { CliUsageError, renderError, EXIT_OK, EXIT_USAGE } from "./output.js";
import { resolveCommand } from "./commands.js";
import { runCommand, parseGlobals, type Parsed } from "./dispatch.js";

// Hand-rolled router (11 §8: no commander). Splits global flags from the
// command + its residual argv (parseGlobals, in dispatch.ts), resolves the
// command (with aliases), then delegates to runCommand for the freshness sweep +
// dispatch + error mapping — the same path the shell reuses per line.

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

  const cli: Cli = makeCli(flags, io);
  if (!resolveCommand(command)) {
    return renderError(new CliUsageError(`unknown command '${command}'`), io, cli.style, flags.mode !== "human");
  }
  return runCommand(cli, command, parsed.rest);
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
