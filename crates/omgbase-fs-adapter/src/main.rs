//! `omgbase-fs-adapter` — the stdio filesystem sync adapter (`spec/sync` §5),
//! wire-compatible with the reference `packages/fs-adapter/src/bin.ts`. The
//! engine spawns it with the source config rendered to flags and speaks
//! NDJSON:
//!
//! ```text
//! handshake  → {"protocol":1,"capabilities":{"identity":"inferred","writeThrough":true,"watch":true}}
//! request    ← {"id":n,"method":"enumerate|fetch|write|remove|watch|unwatch","params":{…}}
//! response   → {"id":n,"result":{…}}  |  {"id":n,"error":"…"}
//! watch feed → {"event":"ready"}                 (once, right after the watch response:
//!                                                the watcher is established synchronously)
//!            → {"event":"batch","paths":[…]}    (unsolicited, while watching)
//! ```
//!
//! stdout carries only protocol JSON; every log line goes to stderr. stdin
//! EOF stops the watcher and exits 0.

use std::io::{BufRead, Write};

use omgbase_fs_adapter::{FsAdapter, Options, WatchHandle, capabilities};
use serde_json::{Map, Value, json};

/// One protocol line on stdout. A failed write means the host is gone:
/// exit quietly.
fn emit(value: &Value) {
    let mut line = value.to_string();
    line.push('\n');
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if out
        .write_all(line.as_bytes())
        .and_then(|()| out.flush())
        .is_err()
    {
        std::process::exit(0);
    }
}

/// JavaScript's `String(v)` over a JSON value (the reference coerces
/// `params.path` / `params.content` this way; a missing member is
/// `"undefined"`).
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| js_string(Some(x)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// `{"id":…,"result":…}` / `{"id":…,"error":…}`, the id echoed only when
/// the request carried one (`JSON.stringify` drops `undefined`).
fn respond(id: Option<&Value>, key: &str, payload: Value) {
    let mut obj = Map::new();
    if let Some(id) = id {
        obj.insert("id".to_owned(), id.clone());
    }
    obj.insert(key.to_owned(), payload);
    emit(&Value::Object(obj));
}

fn handle(adapter: &FsAdapter, watch: &mut Option<WatchHandle>, req: &Value) {
    let id = req.get("id");
    let params = req.get("params");
    let param = |k: &str| params.and_then(|p| p.get(k));
    let method = req.get("method");
    let outcome: Result<Value, String> = match method.and_then(Value::as_str) {
        Some("enumerate") => adapter
            .enumerate()
            .map(|entries| {
                json!({ "entries": entries.iter().map(|e| json!({ "path": e.path, "revision": e.revision })).collect::<Vec<_>>() })
            })
            .map_err(|e| e.to_string()),
        Some("fetch") => adapter
            .fetch(&js_string(param("path")))
            .map(|item| {
                json!({ "item": item.map(|i| json!({ "path": i.path, "revision": i.revision, "content": i.content })) })
            })
            .map_err(|e| e.to_string()),
        Some("write") => adapter
            .write(&js_string(param("path")), &js_string(param("content")))
            .map(|()| json!({ "ok": true }))
            .map_err(|e| e.to_string()),
        Some("remove") => adapter
            .remove(&js_string(param("path")))
            .map(|()| json!({ "ok": true }))
            .map_err(|e| e.to_string()),
        Some("watch") => {
            if watch.is_some() {
                Ok(json!({ "ok": true }))
            } else {
                match adapter.watch(|paths| emit(&json!({ "event": "batch", "paths": paths }))) {
                    Ok(w) => {
                        *watch = Some(w);
                        respond(id, "result", json!({ "ok": true }));
                        // The ack first, then the feed's readiness: notify's
                        // watcher reports every change from `watch()` on.
                        emit(&json!({ "event": "ready" }));
                        return;
                    }
                    Err(e) => Err(e.to_string()),
                }
            }
        }
        Some("unwatch") => {
            if let Some(w) = watch.take() {
                w.stop();
            }
            Ok(json!({ "ok": true }))
        }
        _ => Err(format!("unknown method: {}", js_string(method))),
    };
    match outcome {
        Ok(result) => respond(id, "result", result),
        Err(message) => respond(id, "error", Value::String(message)),
    }
}

fn main() {
    let opts = match Options::parse(std::env::args().skip(1)) {
        Ok(o) => o,
        Err(msg) => {
            eprintln!("omgbase-fs-adapter: {msg}");
            std::process::exit(2);
        }
    };
    let root = opts.root.display().to_string();
    let adapter = FsAdapter::new(opts);
    emit(&json!({ "protocol": 1, "capabilities": capabilities() }));
    eprintln!("[omgbase-fs-adapter] watching {root}");

    let mut watch: Option<WatchHandle> = None;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(req) => handle(&adapter, &mut watch, &req),
            Err(_) => {
                let head: String = trimmed.chars().take(80).collect();
                emit(&json!({ "error": format!("invalid request JSON: {head}") }));
            }
        }
    }
    if let Some(w) = watch.take() {
        w.stop();
    }
    std::process::exit(0);
}
