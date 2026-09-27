//! A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with the
//! four methods a tool host needs — `initialize`, `tools/list`, `tools/call`,
//! `ping` — plus the `notifications/initialized` notification. Hand-rolled
//! rather than `rmcp` to keep the binary dependency-light and synchronous
//! (the catalog is a plain `Surface::call`); every tool result is one text
//! content item holding JSON, an error result carries `isError: true`
//! (`spec/surface` §4).
//!
//! A tool that can commit ([`Surface::is_write_tool`]) runs under the
//! workspace writer lock (`spec/sync` §7) when the server knows the
//! `.omgbase/` directory, so it never interleaves with a watcher checkpoint
//! (this process's or another's); a lock held past the timeout is the
//! reference's `WriterLockTimeout`, which reaches the client as the
//! catch-all envelope (`spec/surface` §9).

use std::io::{BufRead, Write};
use std::path::PathBuf;

use omgbase_surface::{Surface, SurfaceError};
use omgbase_sync::{WriterLock, WriterLockOptions};
use serde_json::{Value as Json, json};

/// The MCP protocol revision this server speaks.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

fn response(id: &Json, result: Json) -> Json {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Json, code: i64, message: &str) -> Json {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// What the loop needs beyond the surface.
#[derive(Clone, Debug, Default)]
pub struct ServeOptions {
    /// `<workspace>/.omgbase`: write tools take `writer.lock` here. `None`
    /// (an in-memory surface) runs them unlocked.
    pub omgbase_dir: Option<PathBuf>,
}

/// One tool result as MCP frames it.
fn tool_result(body: &Json, is_error: bool) -> Json {
    let mut result = json!({
        "content": [{ "type": "text", "text": body.to_string() }],
    });
    if is_error {
        result["isError"] = Json::Bool(true);
    }
    result
}

/// Handle one request; `None` for a notification (no reply).
pub fn handle(
    surface: &mut Surface,
    version: &str,
    req: &Json,
    opts: &ServeOptions,
) -> Option<Json> {
    let Some(obj) = req.as_object() else {
        return Some(error(
            &Json::Null,
            INVALID_REQUEST,
            "request must be an object",
        ));
    };
    let id = obj.get("id").cloned();
    let method = obj.get("method").and_then(Json::as_str).unwrap_or("");
    let params = obj.get("params").cloned().unwrap_or(Json::Null);
    if method.starts_with("notifications/") {
        return None;
    }
    let id = id?;
    Some(match method {
        "initialize" => response(
            &id,
            json!({
                "protocolVersion": params.get("protocolVersion").cloned().unwrap_or_else(|| json!(PROTOCOL_VERSION)),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "omgbase", "version": version },
            }),
        ),
        "ping" => response(&id, json!({})),
        "tools/list" => response(
            &id,
            json!({
                "tools": surface.tools().iter().map(|t| json!({
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.input_schema,
                })).collect::<Vec<_>>(),
            }),
        ),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Json::as_str) else {
                return Some(error(&id, INVALID_PARAMS, "tools/call needs a tool `name`"));
            };
            if !surface.tools().iter().any(|t| t.name == name) {
                return Some(error(&id, INVALID_PARAMS, &format!("unknown tool {name}")));
            }
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let lock = match &opts.omgbase_dir {
                Some(dir) if Surface::is_write_tool(name) => {
                    match WriterLock::acquire(dir, WriterLockOptions::default()) {
                        Ok(l) => Some(l),
                        Err(e) => {
                            let env = SurfaceError::other(e.to_string()).to_json();
                            return Some(response(&id, tool_result(&env, true)));
                        }
                    }
                }
                _ => None,
            };
            let out = surface.call(name, args);
            drop(lock);
            response(&id, tool_result(&out.body, out.is_error))
        }
        other => error(&id, METHOD_NOT_FOUND, &format!("method not found: {other}")),
    })
}

/// Serve until stdin closes.
pub fn serve(surface: &mut Surface, version: &str, opts: &ServeOptions) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Json>(&line) {
            Ok(req) => handle(surface, version, &req, opts),
            Err(e) => Some(error(
                &Json::Null,
                PARSE_ERROR,
                &format!("parse error: {e}"),
            )),
        };
        if let Some(r) = reply {
            // Straight to the locked stdout (no intermediate `String` of the
            // whole frame); the compact form `Display` would print.
            serde_json::to_writer(&mut out, &r)?;
            out.write_all(b"\n")?;
            out.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_store::Store;

    fn surface() -> Surface {
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("r").unwrap();
        Surface::new(store, &repo, None)
    }

    fn handle(surface: &mut Surface, version: &str, req: &Json) -> Option<Json> {
        super::handle(surface, version, req, &ServeOptions::default())
    }

    #[test]
    fn initialize_list_call_ping() {
        let mut s = surface();
        let init = handle(&mut s, "0.1.0", &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "omgbase");
        assert!(
            handle(
                &mut s,
                "0.1.0",
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            )
            .is_none()
        );
        let list = handle(
            &mut s,
            "0.1.0",
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .unwrap();
        assert!(
            list["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "query")
        );
        let call = handle(&mut s, "0.1.0", &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "docs_list", "arguments": {} } })).unwrap();
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Json>(text).unwrap()["items"],
            json!([])
        );
        assert!(call["result"].get("isError").is_none());
        let bad = handle(&mut s, "0.1.0", &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "docs_read", "arguments": { "doc": "nope" } } })).unwrap();
        assert_eq!(bad["result"]["isError"], true);
        let ping = handle(
            &mut s,
            "0.1.0",
            &json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" }),
        )
        .unwrap();
        assert_eq!(ping["result"], json!({}));
        let nf = handle(
            &mut s,
            "0.1.0",
            &json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/list" }),
        )
        .unwrap();
        assert_eq!(nf["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn write_tools_take_and_release_the_writer_lock() {
        let tmp = omgbase_sync::fs::TempDir::new("mcp-lock");
        let dir = tmp.path().join(".omgbase");
        let opts = ServeOptions {
            omgbase_dir: Some(dir.clone()),
        };
        let mut s = surface();
        // A sourceless repo cannot create a document, but the lock is taken
        // around the attempt and released afterwards either way.
        let out = super::handle(&mut s, "0.1.0", &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "docs_create", "arguments": { "path": "a.md", "content": "# A\n" } } }), &opts).unwrap();
        assert_eq!(out["result"]["isError"], true);
        assert!(WriterLock::is_free(&dir));
        assert!(!WriterLock::path_in(&dir).exists());
        // A read never touches the lock directory.
        let out = super::handle(&mut s, "0.1.0", &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "docs_list", "arguments": {} } }), &opts).unwrap();
        assert!(out["result"].get("isError").is_none());
        assert!(Surface::is_write_tool("apply") && !Surface::is_write_tool("docs_read"));
    }
}
