//! `omgbase` — the Rust rendering of the `omg` CLI (`spec/cli`) over
//! `omgbase-surface`, `omgbase-sync` and `omgbase-store`.
//!
//! ```text
//! omgbase [--json|--jsonl|--ids] [-C dir] [--repo slug] <command> [args]
//! omgbase mcp [-C <workspace-dir>] [--repo <slug>] [--no-watch]
//! ```
//!
//! The invocation model, the output contract, help and the verbs live in
//! [`cli`]; the MCP stdio transport in [`mcp`]; the filesystem watcher and
//! the background embed drain `omgbase mcp` runs in [`watch`] and [`drain`].
//!
//! Two environment variables are the conformance seams of `spec/surface`
//! §7.1 / `spec/cli` §2.6, honored by every verb: `OMGBASE_SPEC_MINTER=sequential`
//! installs the fixture minter (`d_0, d_1, …`, counters fresh at process
//! start and shared by every thread), and `OMGBASE_SPEC_CLOCK=<RFC 3339>`
//! makes that instant "now" for every commit a verb stamps and every
//! relative time it renders. `mcp` announces both on stderr.

// The CLI's error carries a code, a message, a hint and an optional JSON
// payload (~150 bytes); every failure is a cold path at the process boundary,
// so the `Result` size is not worth boxing (the surface crate takes the same
// stance).
#![allow(clippy::result_large_err)]

mod cli;
mod drain;
mod mcp;
mod watch;

use std::process::ExitCode;

pub(crate) use cli::seams::{MinterSource, open_store, stamp};

fn main() -> ExitCode {
    let mut args = std::env::args_os();
    let argv0 = args.next();
    let prog = cli::prog_name(argv0.as_deref());
    let argv: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    let code = cli::run(&argv, &prog);
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
