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
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: "boolean" }, prompt: { type: "string" } },
  });
  if (values.help) {
    cli.io.out("  shell [--prompt <str>]  — persistent session with typed bindings (@1/@_/@name; unset/bindings)");
    cli.io.out("    --prompt <str>  emit <str> before reading each piped line, so a driver (e.g. recital) can sync on it");
    cli.io.out("    (also read from $OMG_SHELL_PROMPT; --prompt wins)");
    return EXIT_OK;
  }

  // An explicit prompt string, if any: --prompt wins, else $OMG_SHELL_PROMPT.
  // In piped mode this switches on the prompt-emitting line runner; on a TTY it
  // overrides the interactive prompt. (An empty env value is treated as unset.)
  const promptOpt = values.prompt ?? (process.env.OMG_SHELL_PROMPT || undefined);

  // Local mode: resolve the workspace once and hold it open for the session's
  // lifetime. Remote mode (`--server`): no local store — every line routes over
  // MCP through the shared connection, so we hold no workspace.
  const ws = cli.flags.server ? undefined : cli.workspace();
  const session = new ShellSession({
    ...(ws ? { workspace: ws } : {}),
    cwd: cli.cwd,
    io: cli.io,
    noColor: cli.style.tier === "plain",
    ...(cli.flags.server ? { server: cli.flags.server } : {}),
    ...(cli.flags.headers ? { headers: cli.flags.headers } : {}),
  });

  const interactive = cli.io.stdoutTTY && Boolean(process.stdin.isTTY);
  if (!interactive) {
    // Piped mode. With a prompt configured, act like the interactive REPL for a
    // machine driver: emit the prompt (no trailing newline) before each line so
    // a tool like recital can treat its reappearance as the end-of-command
    // signal. Without one, keep the batch script runner (read all, run all).
    if (promptOpt !== undefined) return await runPromptedScript(cli, session, promptOpt);
    const script = await readAll();
    let code = EXIT_OK;
    for (const line of script.split(/\r?\n/)) {
      const c = await session.exec(line);
      if (c !== EXIT_OK) code = c;
      if (session.exited) break;
    }
    return code;
  }

  // Interactive REPL. A configured prompt overrides the default prompt string.
  const prompt =
    promptOpt ?? (cli.style.tier === "plain" ? "omg> " : cli.style.accent("omg") + cli.style.dim("> "));
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

/**
 * Piped session that emits `promptStr` before each line, so a machine driver
 * (e.g. recital's prompt mode) can sync on the prompt reappearing. The prompt is
 * written straight to stdout with no trailing newline; command output flows
 * through the normal IO in between. Ends on stdin EOF or an `exit` command.
 */
function runPromptedScript(cli: Cli, session: ShellSession, promptStr: string): Promise<number> {
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  let processing = false;
  let inputClosed = false;
  let code = EXIT_OK;

  return new Promise<number>((resolve) => {
    // Serialize command execution: `readline` can emit several buffered `line`
    // events before any pause takes hold, so run one command fully — output and
    // the next prompt — before starting the next, whatever pace lines arrive at.
    const pump = async (): Promise<void> => {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const line = queue.shift()!;
        try {
          const c = await session.exec(line);
          if (c !== EXIT_OK) code = c;
        } catch (err) {
          cli.io.err(cli.style.err(String((err as Error)?.message ?? err)));
        }
        if (session.exited) {
          rl.close();
          resolve(code);
          return;
        }
        process.stdout.write(promptStr);
      }
      processing = false;
      if (inputClosed) resolve(code);
    };

    process.stdout.write(promptStr);
    rl.on("line", (line) => {
      queue.push(line);
      void pump();
    });
    rl.on("close", () => {
      inputClosed = true;
      if (!processing && queue.length === 0) resolve(code);
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
