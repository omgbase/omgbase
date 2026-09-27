//! `shell` (`spec/cli` §7): a persistent in-process session. One open
//! workspace/store is reused across every command (no per-invocation
//! startup cost), and typed command results become ephemeral bindings
//! (`@1`/`@_`/`@name`). Three drivers share one [`ShellSession`] runtime:
//! the **script runner** when stdin is piped (read to EOF, one command per
//! line — what the fixtures pin), the **prompted runner** (`--prompt` /
//! `$OMG_SHELL_PROMPT`, §7.1: the prompt written before each line so a
//! machine driver can sync on it), and a plain line REPL on a TTY (unpinned).

use std::io::{BufRead, Write};

use crate::cli::argv::{Opt, parse_args, read_stdin};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{EXIT_OK, Io, Result};
use crate::cli::render::Style;
use crate::cli::shell::session::ShellSession;

/// Write `prompt` to stdout verbatim — no trailing newline — and flush.
fn emit_prompt(prompt: &str) {
    let mut h = std::io::stdout().lock();
    let _ = h.write_all(prompt.as_bytes());
    let _ = h.flush();
}

/// One line of stdin without its terminator; `None` at EOF.
fn read_line() -> Option<String> {
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => {
            while line.ends_with('\n') || line.ends_with('\r') {
                line.pop();
            }
            Some(line)
        }
    }
}

/// §7: the batch script runner — read everything first, run every line in
/// order, exit with the last non-zero code; `exit`/`quit` stop the run.
fn run_script(session: &mut ShellSession<'_>) -> i32 {
    let script = read_stdin();
    let mut code = EXIT_OK;
    for line in script.split('\n') {
        let c = session.exec(line.strip_suffix('\r').unwrap_or(line));
        if c != EXIT_OK {
            code = c;
        }
        if session.exited {
            break;
        }
    }
    code
}

/// §7.1: the prompted runner — the prompt before each line (so once at
/// start, and once after each command's output), each line run to
/// completion before the next is read; `exit` ends the run without a
/// further prompt, as does EOF.
fn run_prompted(session: &mut ShellSession<'_>, prompt: &str) -> i32 {
    let mut code = EXIT_OK;
    emit_prompt(prompt);
    while let Some(line) = read_line() {
        let c = session.exec(&line);
        if c != EXIT_OK {
            code = c;
        }
        if session.exited {
            return code;
        }
        emit_prompt(prompt);
    }
    code
}

/// The interactive loop on a TTY (unpinned): a prompt, a line, its output.
fn run_interactive(
    style: Style,
    io: Io,
    session: &mut ShellSession<'_>,
    prompt: Option<&str>,
) -> i32 {
    let prompt = prompt.map_or_else(
        || {
            if style.plain() {
                "omg> ".to_owned()
            } else {
                format!("{}{}", style.accent("omg"), style.dim("> "))
            }
        },
        str::to_owned,
    );
    io.err(&style.dim("  omg shell — type `?` for session-binding help, `exit` to leave"));
    loop {
        emit_prompt(&prompt);
        let Some(line) = read_line() else {
            io.err("");
            return EXIT_OK;
        };
        session.exec(&line);
        if session.exited {
            return EXIT_OK;
        }
    }
}

pub fn shell(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "shell");
    }
    let a = parse_args(args, &[Opt::value("prompt")])?;
    // An explicit prompt string, if any: --prompt wins, else $OMG_SHELL_PROMPT
    // (an empty env value is unset). In piped mode this switches on the
    // prompted runner; on a TTY it overrides the interactive prompt.
    let prompt = a.value("prompt").map(str::to_owned).or_else(|| {
        std::env::var("OMG_SHELL_PROMPT")
            .ok()
            .filter(|s| !s.is_empty())
    });

    // Local mode: resolve the workspace once and hold it open for the
    // session's lifetime. Remote mode (`--server`): no local store — every
    // line routes over MCP (once this binary has the client).
    if cli.flags.server.is_none() {
        cli.workspace()?;
    }

    let interactive = cli.io.stdout_tty() && cli.io.stdin_tty();
    // The session borrows the Cli; the TTY loop takes copies of the style and IO.
    let (style, io) = (cli.style, cli.io);
    let mut session = ShellSession::new(cli);
    if !interactive {
        return Ok(match prompt {
            Some(p) => run_prompted(&mut session, &p),
            None => run_script(&mut session),
        });
    }
    Ok(run_interactive(style, io, &mut session, prompt.as_deref()))
}
