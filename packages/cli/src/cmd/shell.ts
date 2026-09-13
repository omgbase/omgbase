import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK } from "../output.js";
import { ShellSession } from "../shell/session.js";

// `omg shell` (11 shell) — a persistent in-process session. One open
// Workspace/store is reused across every command (no per-invocation startup
// cost), and typed command results become ephemeral bindings (@1/@_/@name). Two
// drive modes share one ShellSession runtime: an interactive readline REPL on a
// TTY, and a script runner when stdin is piped (one line per command) — the
// latter is also what a Markdown CLI-session test would feed.

async function runShell(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) {
    cli.io.out("  shell  — persistent session with typed bindings (@1/@_/@name; let/unset/bindings)");
    return EXIT_OK;
  }

  // Resolve the workspace once and hold it open for the session's lifetime.
  const ws = cli.workspace();
  const session = new ShellSession({
    workspace: ws,
    cwd: cli.cwd,
    io: cli.io,
    noColor: cli.style.tier === "plain",
  });

  const interactive = cli.io.stdoutTTY && Boolean(process.stdin.isTTY);
  if (!interactive) {
    // Piped/script mode: run every line, stop on `exit`. Exit code is the last
    // non-zero code (so a failing line in a test script surfaces).
    const script = await readAll();
    let code = EXIT_OK;
    for (const line of script.split(/\r?\n/)) {
      const c = await session.exec(line);
      if (c !== EXIT_OK) code = c;
      if (session.exited) break;
    }
    return code;
  }

  // Interactive REPL.
  const prompt = cli.style.tier === "plain" ? "omg> " : cli.style.accent("omg") + cli.style.dim("> ");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt });
  cli.io.err(cli.style.dim("  omg shell — type `?` for session-binding help, `exit` to leave"));
  rl.prompt();

  return await new Promise<number>((resolve) => {
    rl.on("line", (line) => {
      // Pause while a command runs so the next prompt appears after its output.
      rl.pause();
      session
        .exec(line)
        .catch((err) => cli.io.err(cli.style.err(String((err as Error)?.message ?? err))))
        .finally(() => {
          if (session.exited) {
            rl.close();
          } else {
            rl.resume();
            rl.prompt();
          }
        });
    });
    rl.on("close", () => {
      cli.io.err("");
      resolve(EXIT_OK);
    });
  });
}

function readAll(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

export const cmdShell: Command = {
  name: "shell",
  summary: "Persistent session with typed bindings (@1/@_/@name)",
  run: (cli, a) => runShell(cli, a),
};
