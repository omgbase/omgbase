//! The `omg` verbs rendered by the `omgbase` binary (`spec/cli`): the
//! invocation model (§2), the output contract (§3), the shared renderers
//! (§4), help (§5) and the verbs (§6), each a small function in [`cmd`].
//!
//! Layout: [`argv`] parses the global flags and per-command options;
//! [`context`] is the [`Cli`] every verb receives (cwd, workspace, repo,
//! surface, sweep); [`output`] renders errors and JSON; [`render`] the
//! human tier; [`help`] the catalog and cards; [`commands`] the registry;
//! [`seams`] the conformance seams and the store plumbing.

pub mod argv;
pub mod cmd;
pub mod commands;
pub mod context;
pub mod help;
pub mod output;
pub mod render;
pub mod seams;

use std::ffi::OsStr;
use std::path::Path;

use argv::{Globals, parse_globals};
use commands::{resolve, unknown_command_error};
use context::{Cli, NO_WORKSPACE_OK, REMOTE_OK, SKIP_FRESHNESS};
use output::{CliError, EXIT_OK, Io, Result, render_error};
use render::Style;

/// The CLI's own version (`spec/cli` §2.5, §9 Fixed: the package's version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// §2.4: the name to quote the binary as — `basename(argv[0])`; `omg` for a
/// bare script run or nothing.
pub fn prog_name(argv0: Option<&OsStr>) -> String {
    let Some(a) = argv0 else {
        return "omg".to_owned();
    };
    let base = Path::new(a)
        .file_name()
        .map(|b| b.to_string_lossy().into_owned())
        .unwrap_or_default();
    if base.is_empty() || base.ends_with(".js") || base.ends_with(".cjs") || base.ends_with(".mjs")
    {
        "omg".to_owned()
    } else {
        base
    }
}

/// The one-shot entry: argv (without the program) → exit code.
pub fn run(argv: &[String], prog: &str) -> i32 {
    let parsed = match parse_globals(argv) {
        Ok(p) => p,
        Err((flags, err)) => {
            let style = Style::detect(flags.no_color, Io.stdout_tty());
            return render_error(&err, Io, &style, flags.machine());
        }
    };
    let flags: Globals = parsed.flags;
    let mut command = parsed.command;

    // --version / --help without a command; --version before the seams.
    if flags.version && command.is_none() {
        Io.out(VERSION);
        return EXIT_OK;
    }
    if command.is_none() {
        command = Some("help".to_owned());
    }
    let command = command.unwrap_or_default();

    let machine = flags.machine();
    let seams = match seams::read_env_seams() {
        Ok(s) => s,
        Err(e) => {
            let style = Style::detect(flags.no_color, Io.stdout_tty());
            return render_error(&e, Io, &style, machine);
        }
    };
    let mut cli = Cli::new(flags, prog, seams);
    if resolve(&command).is_none() {
        let err = unknown_command_error(prog, &command);
        return render_error(&err, cli.io, &cli.style, machine);
    }
    let code = match run_command(&mut cli, &command, &parsed.rest) {
        Ok(code) => code,
        Err(e) => render_error(&e, cli.io, &cli.style, machine),
    };
    cli.close();
    code
}

/// §2.3: the `-H` checks a remote command runs before connecting.
fn check_headers(flags: &Globals) -> Result<()> {
    let Some(server) = flags.server.as_deref() else {
        return Ok(());
    };
    if flags.headers.is_empty() {
        return Ok(());
    }
    let is_http = server.starts_with("http://") || server.starts_with("https://");
    if !is_http {
        return Err(CliError::usage(
            "-H/--header only applies to an http(s) --server url",
        ));
    }
    for h in &flags.headers {
        if !h.contains(':') {
            return Err(CliError::usage(format!(
                "invalid header {} — expected \"Name: value\"",
                output::js_string(h)
            )));
        }
    }
    Ok(())
}

/// §5: help is documentation, not work — it never needs a workspace, so the
/// sweep and the `--server` gate are skipped for `--help` and for the help
/// *words* (`config help`, `embed help`, a bare `node`, a bare `source`).
fn asks_for_help(flag: bool, name: &str, rest: &[String]) -> bool {
    if flag {
        return true;
    }
    let first = rest.first().map(String::as_str);
    match name {
        "config" | "embed" => first == Some("help"),
        "node" => first.is_none_or(|f| f == "help"),
        "source" => first.is_none_or(|f| f == "help" || f == "--help"),
        _ => false,
    }
}

/// Dispatch one command: the `--server` gate, the freshness sweep (§3.7),
/// the verb. Shared with the shell's per-line path.
pub fn run_command(cli: &mut Cli, command: &str, rest: &[String]) -> Result<i32> {
    let Some(resolved) = resolve(command) else {
        return Err(unknown_command_error(&cli.prog, command));
    };
    let help = asks_for_help(cli.flags.help, resolved.name, rest);
    if cli.flags.server.is_some() && !help {
        if !REMOTE_OK.contains(&resolved.name) {
            return Err(CliError::usage(format!(
                "--server is not supported for '{}' — it needs local ref resolution or a working tree; run it against a local workspace",
                resolved.name
            )));
        }
        check_headers(&cli.flags)?;
        // The remote client (the catalog of spec/surface §4 called from an
        // MCP client) is a later wave of this binary.
        return Err(CliError::engine(
            "remote_unavailable",
            "--server is not yet implemented in this binary; run against a local workspace",
        ));
    }
    let mut args: Vec<String> = Vec::with_capacity(rest.len() + 1);
    if cli.flags.help {
        args.push("--help".to_owned());
    }
    args.extend(rest.iter().cloned());

    if !help
        && !cli.flags.stale
        && !SKIP_FRESHNESS.contains(&resolved.name)
        && !NO_WORKSPACE_OK.contains(&resolved.name)
    {
        cli.freshness()?;
    }
    match (resolved.run)(cli, &args) {
        // §9 Fixed: an unknown per-command option is a usage error pointing at the card.
        Err(CliError::Usage {
            message,
            hint: None,
        }) if message.starts_with("unknown option '") => Err(CliError::usage_hint(
            message,
            format!(
                "run '{} {} --help' for the options",
                cli.prog, resolved.name
            ),
        )),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_name() {
        assert_eq!(prog_name(None), "omg");
        assert_eq!(prog_name(Some(OsStr::new("/usr/bin/omgbase"))), "omgbase");
        assert_eq!(prog_name(Some(OsStr::new("/x/bin/omg"))), "omg");
        assert_eq!(prog_name(Some(OsStr::new("dist/src/main.js"))), "omg");
    }
}
