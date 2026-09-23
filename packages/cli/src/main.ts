#!/usr/bin/env node
import { VERSION } from "@omgbase/core";
import { processIO, type IO } from "./render.js";
import { makeCli, progName, type Cli } from "./context.js";
import { renderError, EXIT_OK, EXIT_USAGE } from "./output.js";
import { resolveCommand, unknownCommandError } from "./commands.js";
import { runCommand, parseGlobals, type Parsed } from "./dispatch.js";
import { closeRemote } from "./cmd/_remote.js";

// Hand-rolled router (11 §8: no commander). Splits global flags from the
// command + its residual argv (parseGlobals, in dispatch.ts), resolves the
// command (with aliases), then delegates to runCommand for the freshness sweep +
// dispatch + error mapping — the same path the shell reuses per line.

export async function run(argv: string[], io: IO = processIO, prog = "omg"): Promise<number> {
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

  const cli: Cli = makeCli(flags, io, { prog });
  if (!resolveCommand(command)) {
    return renderError(unknownCommandError(prog, command), io, cli.style, flags.mode !== "human");
  }
  try {
    return await runCommand(cli, command, parsed.rest);
  } finally {
    // Tear down the remote (`--server`) MCP connection if the command opened one.
    await closeRemote();
  }
}

// Entry point.
//
// Exit quietly when a downstream consumer closes our stdout early (`omg … | head`,
// or `… --ids | omg done -` where `done` stops reading): a broken-pipe write
// otherwise surfaces as an unhandled 'error' event and crashes with a stack
// trace. Standard pipe-friendly behavior for a CLI that advertises composing
// with grep/head/xargs (§1).
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

// Quote the binary back to the user as they invoked it (`omg` vs `omgbase`).
run(process.argv.slice(2), processIO, progName(process.argv[1])).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exitCode = 1;
  },
);
