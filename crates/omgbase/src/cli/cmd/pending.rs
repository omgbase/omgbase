//! Verbs not yet rendered by this binary: their cards print (§5), running
//! them is `error[not_implemented]`. A later wave replaces each stub in
//! `commands.rs` with the real verb (`cmd/mutate.rs`, `cmd/docs.rs`,
//! `cmd/shell.rs`, `cmd/admin.rs`).

use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, Result};

fn pending(cli: &mut Cli, name: &str, args: &[String]) -> Result<i32> {
    // `--help`; `config help` / `embed help`; a bare `node` (§5, §9 Fixed:
    // the help words need no workspace).
    let help_word =
        args.first().is_some_and(|a| a == "help") && matches!(name, "config" | "embed" | "node");
    if wants_help(args) || help_word || (name == "node" && args.is_empty()) {
        return render_help_for(cli, name);
    }
    Err(CliError::engine(
        "not_implemented",
        format!("'{name}' is not yet implemented in this binary (spec/cli §6 `{name}`)"),
    ))
}

macro_rules! stubs {
    ($($f:ident => $name:literal),* $(,)?) => {
        $(pub fn $f(cli: &mut Cli, args: &[String]) -> Result<i32> { pending(cli, $name, args) })*
    };
}

stubs! {
    apply => "apply",
    insert => "insert",
    update => "update",
    edit => "edit",
    r#move => "move",
    rm => "rm",
    done => "done",
    append => "append",
    retarget => "retarget",
    node => "node",
    split => "split",
    merge => "merge",
    new => "new",
    mv => "mv",
    meta => "meta",
    shell => "shell",
    rebuild_index => "rebuild-index",
    gc => "gc",
    doctor => "doctor",
    config => "config",
    embed => "embed",
}
