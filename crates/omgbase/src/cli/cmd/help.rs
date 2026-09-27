//! `help` (§5): the catalog.

use crate::cli::context::Cli;
use crate::cli::help::render_catalog;
use crate::cli::output::Result;

pub fn help(cli: &mut Cli, _args: &[String]) -> Result<i32> {
    render_catalog(cli)
}
