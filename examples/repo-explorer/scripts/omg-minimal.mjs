#!/usr/bin/env node
// A stand-in `omg` that serves the MINIMAL tools profile: webdevproxy spawns
// its `--omg` entry as `omg mcp -C <dir>` and has no flag for `--tools`, so
// this wrapper runs the real CLI with `--tools minimal` appended to an `mcp`
// invocation (any other verb passes through unchanged). The real `omg` is the
// monorepo's build (`pnpm build` at the root) unless OMG names another entry.
//
//   node scripts/omg-minimal.mjs mcp -C <workspace>     ≡  omg mcp -C <workspace> --tools minimal

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OMG = process.env.OMG ?? resolve(here, "../../../packages/cli/dist/src/main.js");

/** The argv the real CLI gets: `--tools minimal` added to an `mcp` call that names no profile. */
export function minimalArgv(argv) {
  if (argv[0] !== "mcp" || argv.includes("--tools") || argv.some((a) => a.startsWith("--tools="))) return argv;
  return [...argv, "--tools", "minimal"];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, [OMG, ...minimalArgv(process.argv.slice(2))], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
}
