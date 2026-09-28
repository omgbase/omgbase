//! The verbs (`spec/cli` §6), one module per group. Each verb is
//! `fn(&mut Cli, &[String]) -> Result<i32>`: it renders its own card when
//! the first argument is `--help`, parses its options with
//! [`super::argv::parse_args`], calls the surface, and prints per the mode.

pub mod admin;
pub mod bootstrap;
pub mod cat;
pub mod diff;
pub mod docs;
pub mod find;
pub mod help;
pub mod hist;
pub mod links;
pub mod log;
pub mod ls;
pub mod mcp;
pub mod mutate;
pub mod node;
pub mod outline;
pub mod query;
pub mod retarget;
pub mod shell;
pub mod show;
pub mod source;
pub mod status;
pub mod sync;
pub mod version;

use serde_json::Value as Json;

use super::argv::Mode;
use super::context::Cli;
use super::output::{EXIT_OK, Result, js_json};

/// The one machine-mode rule (§9 Fixed): `--json` prints the document;
/// `--jsonl` prints one line per item of `items` when the result is a list,
/// else the document; `--ids` prints `ids` when the result carries an id
/// list, else the document. Returns `None` in the human mode.
pub fn machine_out(
    cli: &Cli,
    doc: &Json,
    items: Option<&[Json]>,
    ids: Option<&[String]>,
) -> Option<Result<i32>> {
    match cli.flags.mode {
        Mode::Human => None,
        Mode::Json => {
            cli.io.out(&js_json(doc));
            Some(Ok(EXIT_OK))
        }
        Mode::Jsonl => {
            match items {
                Some(items) => {
                    for it in items {
                        cli.io.out(&js_json(it));
                    }
                }
                None => cli.io.out(&js_json(doc)),
            }
            Some(Ok(EXIT_OK))
        }
        Mode::Ids => {
            match ids {
                Some(ids) => {
                    for id in ids {
                        cli.io.out(id);
                    }
                }
                None => cli.io.out(&js_json(doc)),
            }
            Some(Ok(EXIT_OK))
        }
    }
}

/// A string field of a JSON object, `""` when absent.
pub fn str_of(v: &Json, key: &str) -> String {
    v.get(key)
        .and_then(Json::as_str)
        .map(str::to_owned)
        .unwrap_or_default()
}

/// An integer field of a JSON object, 0 when absent.
pub fn i64_of(v: &Json, key: &str) -> i64 {
    v.get(key).and_then(Json::as_i64).unwrap_or(0)
}

/// A value as `show` prints it: strings verbatim, else compact JSON.
pub fn fmt_value(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        other => js_json(other),
    }
}
