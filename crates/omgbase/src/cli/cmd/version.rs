//! `version` (§6, cli 1.1): the surface's `version` tool, rendered. Which
//! engine and which component versions a host or a shell is talking to —
//! with `--server` it is the *remote* engine's answer, which is how a user
//! tells a TypeScript `omg mcp` from a Rust `omgbase mcp`. Needs no repo; the
//! workspace is opened only for `schema` (`—` without one). `--version`
//! (§2.5) stays the one-line form.

use serde_json::Value as Json;

use crate::cli::argv::parse_args;
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{EXIT_OK, Result};
use crate::cli::render::pad_end;

/// The `version` result: the remote engine's with `--server`, else this
/// binary's over the workspace's store when there is one.
fn info(cli: &mut Cli) -> Result<Json> {
    if cli.remote_mode() {
        return cli.call("version", Json::Object(serde_json::Map::new()));
    }
    // `schema` is the open database's user_version; without a workspace the
    // command still answers (§3.7: version ∈ NO_WORKSPACE_OK), and a
    // workspace that cannot be opened is reported as none.
    let build = crate::cli::build_info();
    let store = cli.workspace().ok().and_then(|_| cli.store().ok());
    Ok(omgbase_surface::version_info(store, &build)?)
}

/// A leaf as the human tier prints it: strings verbatim, numbers as JSON,
/// `null` as the dash.
fn cell(v: &Json, dash: &str) -> String {
    match v {
        Json::Null => dash.to_owned(),
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn version(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "version");
    }
    parse_args(args, &[])?;
    let info = info(cli)?;
    cli.capture(&info); // shell: the object
    if let Some(code) = super::machine_out(cli, &info, None, None) {
        return code;
    }

    let style = cli.style;
    const KEYS: [&str; 8] = [
        "engine", "version", "specs", "schema", "mcp", "runtime", "commit", "built",
    ];
    let width = KEYS.iter().map(|k| k.len()).max().unwrap_or(0);
    let dash = style.dim("—");
    let line = |key: &str, value: &Json| {
        cli.io.out(&format!(
            "{}  {}",
            style.dim(&pad_end(key, width)),
            cell(value, &dash)
        ));
    };
    let field = |k: &str| info.get(k).cloned().unwrap_or(Json::Null);
    line("engine", &field("engine"));
    line("version", &field("version"));
    if let Some(components) = info.get("components").and_then(Json::as_object) {
        let name_width = components.keys().map(String::len).max().unwrap_or(0);
        for (name, v) in components {
            cli.io.out(&format!(
                "  {}  {}",
                style.accent(&pad_end(name, name_width)),
                cell(v, &dash)
            ));
        }
    }
    let specs = info
        .get("specs")
        .and_then(Json::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("{k} {}", cell(v, &dash)))
                .collect::<Vec<_>>()
                .join(" · ")
        })
        .unwrap_or_default();
    line("specs", &Json::String(specs));
    line("schema", &field("schema"));
    let mcp = info.get("mcp").cloned().unwrap_or(Json::Null);
    let protocol = cell(mcp.get("protocol").unwrap_or(&Json::Null), &dash);
    let mcp_line = match mcp.get("sdk").and_then(Json::as_str) {
        Some(sdk) => format!("{protocol} (sdk {sdk})"),
        None => protocol,
    };
    line("mcp", &Json::String(mcp_line));
    line("runtime", &field("runtime"));
    line("commit", &field("commit"));
    line("built", &field("built"));
    Ok(EXIT_OK)
}
