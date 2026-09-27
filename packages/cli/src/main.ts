#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@omgbase/core";
import { processIO, type IO } from "./render.js";
import { makeCli, progName, type Cli } from "./context.js";
import { renderError, EXIT_OK } from "./output.js";
import { resolveCommand, unknownCommandError } from "./commands.js";
import { runCommand, parseGlobals } from "./dispatch.js";
import { closeRemote } from "./cmd/_remote.js";
import { installSpecSeams } from "./seams.js";

// Hand-rolled router (11 §8: no commander). Splits global flags from the
// command + its residual argv (parseGlobals, in dispatch.ts), resolves the
// command (with aliases), then delegates to runCommand for the freshness sweep +
// dispatch + error mapping — the same path the shell reuses per line.

/**
 * `--version` prints THIS package's version (spec/cli §2.5), read from the
 * nearest `package.json` named `omgbase` above the running module (the source
 * tree and the built `dist/src/` sit at different depths). The engine's own
 * `VERSION` is the fallback only if the package file cannot be found.
 */
export function cliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "omgbase" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return VERSION;
    dir = parent;
  }
}

export async function run(argv: string[], io: IO = processIO, prog = "omg"): Promise<number> {
  const parsed = parseGlobals(argv);
  const { flags } = parsed;
  let command = parsed.command;

  // --version / --help without a command.
  if (flags.version && !command && !parsed.error) {
    io.out(cliVersion());
    return EXIT_OK;
  }
  if (flags.help && !command) command = "help";
  if (!command) command = "help";

  const cli: Cli = makeCli(flags, io, { prog });
  // A malformed global flag is a usage error like any other (spec/cli §2.2):
  // rendered with the `usage:` prefix, in the mode the argv selected.
  if (parsed.error) return renderError(parsed.error, io, cli.style, flags.mode !== "human");
  // The conformance seams (spec/cli §2.6) apply to every verb: install them
  // before any command can open the workspace, mint an id or read the clock.
  try {
    installSpecSeams();
  } catch (err) {
    return renderError(err, io, cli.style, flags.mode !== "human");
  }
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
