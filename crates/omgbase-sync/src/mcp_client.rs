//! The MCP engine client (`spec/sync/README.md` §6; the reference's
//! `McpEngineClient` in `@omgbase/sync`): reaches "the omgbase side" over
//! the Model Context Protocol, so the [`Coordinator`](crate::Coordinator)
//! runs unchanged against a remote engine, and the CLI's `--server` mode
//! calls any catalog tool (`spec/surface` §4) and renders the result it
//! would have computed locally.
//!
//! Two transports, one JSON-RPC 2.0 client on top:
//!
//! - **stdio** — spawn a command (`omg mcp -C /vault`, `omgbase mcp …`) and
//!   speak newline-delimited JSON-RPC over its stdin/stdout (the framing of
//!   [`omgbase mcp`](https://github.com/omgbase/omgbase) and of the SDK's
//!   `StdioServerTransport`); stderr is inherited.
//! - **Streamable HTTP** (feature `http`) — `POST` each message to the URL
//!   with `Accept: application/json, text/event-stream`, read the reply from
//!   a JSON body or an SSE stream, round-trip `Mcp-Session-Id`, and send
//!   `MCP-Protocol-Version` once negotiated; extra headers ride on every
//!   request (auth beyond a secret path); `DELETE` ends the session.
//!
//! The one rule for a `--server` value lives in [`parse_engine_spec`]: an
//! `http(s)://` value is an HTTP endpoint (used verbatim, base path and
//! all), anything else is whitespace-split and spawned — a URL is never
//! spawned. Synchronous like the rest of the crate: one request in flight,
//! a bounded wait per reply.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use omgbase_format::hash::{hex, sha256};
use omgbase_store::{ChangesPage, CommitDigest, DeleteOutcome, DigestRevision, ObserveOutcome};
use serde_json::{Map, Value, json};

use crate::engine::{DocBytes, EngineClient, FileBytes};
use crate::error::{Error, Result};

/// The MCP protocol revision this client proposes in `initialize` (the
/// server may answer with the one it speaks; the reply is what is sent as
/// `MCP-Protocol-Version` afterwards).
pub const PROTOCOL_VERSION: &str = "2025-03-26";

/// `clientInfo.name` (the reference's).
pub const CLIENT_NAME: &str = "omgbase-sync";

/// How long one request may wait for its reply (the SDK's default request
/// timeout).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// After stdin EOF a spawned server gets this long to exit before it is
/// killed.
const EXIT_GRACE: Duration = Duration::from_secs(5);

// ---- the spec ---------------------------------------------------------------------------

/// Where a `--server` value points.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineSpec {
    /// An http(s) endpoint reached over Streamable HTTP, with extra request
    /// headers (`-H "Name: value"`, in flag order).
    Http {
        url: String,
        headers: Vec<(String, String)>,
    },
    /// A command to spawn and speak stdio to.
    Stdio { command: String, args: Vec<String> },
}

/// Whether `s` starts with `http://` or `https://` (case-insensitive).
#[must_use]
pub fn is_http_url(s: &str) -> bool {
    let lower: String = s.chars().take(8).collect::<String>().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Classify a raw `--server` value (the reference's `parseEngineSpec`): an
/// `http(s)://` value is an HTTP endpoint (verbatim; `headers` ride along);
/// anything else is split on whitespace and spawned. Errors: an empty
/// value, or headers for a command (they have nowhere to go).
pub fn parse_engine_spec(raw: &str, headers: &[(String, String)]) -> Result<EngineSpec> {
    let spec = raw.trim();
    if is_http_url(spec) {
        return Ok(EngineSpec::Http {
            url: spec.to_owned(),
            headers: headers.to_vec(),
        });
    }
    if !headers.is_empty() {
        return Err(Error::Other(
            "extra headers only apply to an http(s) server url, not a command to spawn".to_owned(),
        ));
    }
    let mut argv = spec.split_whitespace().map(str::to_owned);
    let Some(command) = argv.next() else {
        return Err(Error::Other(
            "server spec is empty — expected a command to spawn (e.g. \"omg mcp -C /vault\") or an http(s) URL".to_owned(),
        ));
    };
    Ok(EngineSpec::Stdio {
        command,
        args: argv.collect(),
    })
}

// ---- tool results ----------------------------------------------------------------------

/// One `tools/call` outcome: the JSON the tool's text content held, and
/// whether the server flagged it (`isError`; the body is then the error
/// envelope of `spec/surface` §4 — `{ error, message, data?, retriable }`).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub body: Value,
    pub is_error: bool,
}

impl ToolResult {
    /// The body, or the envelope as an [`Error::Other`] carrying the code
    /// and message (the reference's `tool <name> failed: <code> — <message>`).
    pub fn into_result(self, tool: &str) -> Result<Value> {
        if !self.is_error {
            return Ok(self.body);
        }
        let code = self
            .body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("error");
        let message = self
            .body
            .get("message")
            .and_then(Value::as_str)
            .map_or_else(|| clip(&self.body.to_string(), 200), str::to_owned);
        Err(Error::Other(format!(
            "tool {tool} failed: {code} — {message}"
        )))
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        s.chars().take(max).collect()
    }
}

// ---- the client -------------------------------------------------------------------------

enum Transport {
    Stdio(StdioTransport),
    #[cfg(feature = "http")]
    Http(HttpTransport),
}

/// A connected MCP client: `initialize` done, ready for `tools/call`.
pub struct McpEngineClient {
    transport: Transport,
    next_id: i64,
    timeout: Duration,
    protocol_version: String,
    server_info: Value,
}

impl std::fmt::Debug for McpEngineClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpEngineClient")
            .field("protocol_version", &self.protocol_version)
            .field("server_info", &self.server_info)
            .finish_non_exhaustive()
    }
}

impl McpEngineClient {
    /// Connect over the transport `spec` selects and run the handshake.
    pub fn connect(spec: &EngineSpec) -> Result<Self> {
        Self::connect_with(spec, DEFAULT_TIMEOUT)
    }

    /// [`Self::connect`] with a per-request timeout.
    pub fn connect_with(spec: &EngineSpec, timeout: Duration) -> Result<Self> {
        match spec {
            EngineSpec::Stdio { command, args } => Self::connect_stdio(command, args, timeout),
            #[cfg(feature = "http")]
            EngineSpec::Http { url, headers } => Self::connect_http(url, headers, timeout),
            #[cfg(not(feature = "http"))]
            EngineSpec::Http { url, .. } => Err(Error::Other(format!(
                "cannot reach {url}: this build has no HTTP transport (omgbase-sync feature `http`)"
            ))),
        }
    }

    /// Spawn `command args…` (stderr inherited) and connect over its stdio.
    pub fn connect_stdio(command: &str, args: &[String], timeout: Duration) -> Result<Self> {
        let transport = StdioTransport::spawn(command, args)?;
        Self::handshake(Transport::Stdio(transport), timeout)
    }

    /// Connect to a Streamable HTTP endpoint; `headers` are sent on every
    /// request.
    #[cfg(feature = "http")]
    pub fn connect_http(
        url: &str,
        headers: &[(String, String)],
        timeout: Duration,
    ) -> Result<Self> {
        let transport = HttpTransport::new(url, headers, timeout);
        Self::handshake(Transport::Http(transport), timeout)
    }

    fn handshake(transport: Transport, timeout: Duration) -> Result<Self> {
        let mut client = Self {
            transport,
            next_id: 0,
            timeout,
            protocol_version: PROTOCOL_VERSION.to_owned(),
            server_info: Value::Null,
        };
        let init = client.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
        );
        let init = match init {
            Ok(v) => v,
            Err(e) => {
                let _ = client.close();
                return Err(e);
            }
        };
        if let Some(v) = init.get("protocolVersion").and_then(Value::as_str) {
            client.protocol_version = v.to_owned();
            #[cfg(feature = "http")]
            if let Transport::Http(h) = &mut client.transport {
                h.protocol_version = Some(v.to_owned());
            }
        }
        client.server_info = init.get("serverInfo").cloned().unwrap_or(Value::Null);
        client.notify("notifications/initialized", Value::Null)?;
        Ok(client)
    }

    /// The protocol revision the server answered with.
    #[must_use]
    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    /// The server's `serverInfo` (`{ name, version }`).
    #[must_use]
    pub fn server_info(&self) -> &Value {
        &self.server_info
    }

    /// One JSON-RPC request; the `result`, or the server's error as
    /// [`Error::Other`].
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = json!(self.next_id);
        let mut msg = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        let reply = match &mut self.transport {
            Transport::Stdio(t) => t.request(&msg, &id, self.timeout)?,
            #[cfg(feature = "http")]
            Transport::Http(t) => t.post(&msg, Some(&id))?.ok_or_else(|| {
                Error::Other(format!(
                    "{method}: the server accepted the request without a reply"
                ))
            })?,
        };
        if let Some(err) = reply.get("error") {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(Error::Other(format!(
                "{method} failed: {message} (JSON-RPC {code})"
            )));
        }
        reply
            .get("result")
            .cloned()
            .ok_or_else(|| Error::Other(format!("{method}: reply without result")))
    }

    /// One JSON-RPC notification (no reply).
    pub fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let mut msg = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        match &mut self.transport {
            Transport::Stdio(t) => t.send(&msg),
            #[cfg(feature = "http")]
            Transport::Http(t) => t.post(&msg, None).map(|_| ()),
        }
    }

    /// `tools/list`: the catalog as the server describes it.
    pub fn list_tools(&mut self) -> Result<Vec<Value>> {
        let res = self.request("tools/list", Value::Null)?;
        Ok(res
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `tools/call`: the tool's JSON body and its error flag. A reply whose
    /// text content is not JSON is an error (the reference's
    /// `tool <name> returned non-JSON`).
    pub fn call_tool(&mut self, name: &str, args: Value) -> Result<ToolResult> {
        let res = self.request("tools/call", json!({ "name": name, "arguments": args }))?;
        let text = res
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            })
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let body: Value = serde_json::from_str(text).map_err(|_| {
            Error::Other(format!(
                "tool {name} returned non-JSON: {}",
                clip(text, 200)
            ))
        })?;
        Ok(ToolResult {
            body,
            is_error: res.get("isError").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// [`Self::call_tool`] with an error result turned into an error.
    pub fn call(&mut self, name: &str, args: Value) -> Result<Value> {
        self.call_tool(name, args)?.into_result(name)
    }

    /// End the session: stdio — stdin EOF, wait, kill after the grace
    /// period; HTTP — `DELETE` with the session id. Idempotent.
    pub fn close(&mut self) -> Result<()> {
        match &mut self.transport {
            Transport::Stdio(t) => t.close(),
            #[cfg(feature = "http")]
            Transport::Http(t) => {
                t.delete_session();
                Ok(())
            }
        }
    }
}

impl Drop for McpEngineClient {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

// ---- the engine seam --------------------------------------------------------------------

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn opt_str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_field(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// An `observe_many` member as the wire carries it → the store's outcome.
/// Hashes are not on the wire (`old_hash_hex` is `None`, `new_hash_hex`
/// empty); the coordinator reads `echo`/`conflicted`/`path` only.
fn observe_outcome(v: &Value) -> ObserveOutcome {
    let dispositions: BTreeMap<String, u64> = v
        .get("dispositions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    Some((
                        d.get("kind")?.as_str()?.to_owned(),
                        d.get("count")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    ObserveOutcome {
        path: str_field(v, "path"),
        doc_id: str_field(v, "docId"),
        rev: opt_str_field(v, "rev"),
        commit_id: opt_str_field(v, "commitId"),
        converged: bool_field(v, "converged"),
        echo: bool_field(v, "echo"),
        conflicted: bool_field(v, "conflicted"),
        dispositions,
        old_hash_hex: None,
        new_hash_hex: String::new(),
    }
}

/// A `changes_since` page as the wire carries it (`camelCase`).
fn changes_page(v: &Value, cursor: i64) -> ChangesPage {
    let digests = v
        .get("digests")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|d| CommitDigest {
                    commit: str_field(d, "commit"),
                    seq: d.get("seq").and_then(Value::as_i64).unwrap_or(0),
                    ts: str_field(d, "ts"),
                    origin: str_field(d, "origin"),
                    actor: opt_str_field(d, "actor"),
                    summary: str_field(d, "summary"),
                    revisions: d
                        .get("revisions")
                        .and_then(Value::as_array)
                        .map(|rs| {
                            rs.iter()
                                .map(|r| DigestRevision {
                                    doc: str_field(r, "doc"),
                                    path: str_field(r, "path"),
                                    content_hash: str_field(r, "contentHash"),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    ChangesPage {
        digests,
        cursor: v.get("cursor").and_then(Value::as_i64).unwrap_or(cursor),
        truncated: bool_field(v, "truncated"),
        head: v.get("head").and_then(Value::as_i64).unwrap_or(0),
    }
}

impl EngineClient for McpEngineClient {
    fn observe_many(&mut self, files: &[FileBytes]) -> Result<Vec<ObserveOutcome>> {
        let files: Vec<Value> = files
            .iter()
            .map(|f| json!({ "path": f.path, "content": f.content }))
            .collect();
        let out = self.call("observe_many", json!({ "files": files }))?;
        let items = out.as_array().ok_or_else(|| {
            Error::Other(format!(
                "observe_many returned {} instead of an array",
                clip(&out.to_string(), 200)
            ))
        })?;
        Ok(items.iter().map(observe_outcome).collect())
    }

    fn observe_delete(&mut self, path: &str) -> Result<DeleteOutcome> {
        let out = self.call("observe_delete", json!({ "path": path }))?;
        Ok(DeleteOutcome {
            path: opt_str_field(&out, "path").unwrap_or_else(|| path.to_owned()),
            doc_id: opt_str_field(&out, "docId"),
            old_hash_hex: None,
        })
    }

    fn changes_since(
        &mut self,
        cursor: i64,
        limit: Option<usize>,
        origin: Option<&str>,
    ) -> Result<ChangesPage> {
        let mut args = Map::new();
        args.insert("cursor".to_owned(), json!(cursor));
        if let Some(l) = limit {
            args.insert("limit".to_owned(), json!(l));
        }
        if let Some(o) = origin {
            args.insert("origin".to_owned(), json!(o));
        }
        let out = self.call("changes_since", Value::Object(args))?;
        Ok(changes_page(&out, cursor))
    }

    /// `docs_read` by path; a tool error (`doc_missing`, …) reads as absent,
    /// as the reference treats it. The hash is computed here: the wire
    /// carries the bytes, not the store's `file_hash`.
    fn read_doc(&mut self, path: &str) -> Result<Option<DocBytes>> {
        let res = self.call_tool("docs_read", json!({ "path": path }))?;
        if res.is_error {
            return Ok(None);
        }
        let Some(content) = res.body.get("content").and_then(Value::as_str) else {
            return Ok(None);
        };
        Ok(Some(DocBytes {
            content: content.to_owned(),
            content_hash: hex(&sha256(content.as_bytes())),
        }))
    }

    fn close(&mut self) -> Result<()> {
        McpEngineClient::close(self)
    }
}

// ---- stdio ------------------------------------------------------------------------------

/// A spawned server and the line reader over its stdout.
struct StdioTransport {
    command: String,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
}

impl StdioTransport {
    fn spawn(command: &str, args: &[String]) -> Result<Self> {
        let spawn_err = |message: String| {
            Error::Other(format!(
                "cannot start the MCP server `{}`: {message}",
                std::iter::once(command)
                    .chain(args.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" ")
            ))
        };
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| spawn_err(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| spawn_err("no stdin pipe".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| spawn_err("no stdout pipe".to_owned()))?;
        let (tx, lines) = channel();
        let reader = std::thread::Builder::new()
            .name("omgbase-mcp-client".to_owned())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| spawn_err(format!("cannot spawn the reader thread: {e}")))?;
        Ok(Self {
            command: command.to_owned(),
            child: Some(child),
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
        })
    }

    fn send(&mut self, msg: &Value) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| Error::Other(format!("MCP server `{}` is closed", self.command)))?;
        serde_json::to_writer(&mut *stdin, msg)
            .map_err(std::io::Error::other)
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|e| Error::Other(format!("MCP server `{}`: write failed: {e}", self.command)))
    }

    /// Send and wait for the reply carrying `id`; every other line (a
    /// notification, a stray reply) is skipped.
    fn request(&mut self, msg: &Value, id: &Value, timeout: Duration) -> Result<Value> {
        self.send(msg)?;
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("?");
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = self.lines.recv_timeout(remaining).map_err(|e| match e {
                RecvTimeoutError::Timeout => Error::Other(format!(
                    "MCP server `{}`: no reply to {method} within {timeout:?}",
                    self.command
                )),
                RecvTimeoutError::Disconnected => Error::Other(format!(
                    "MCP server `{}` exited while waiting for {method}",
                    self.command
                )),
            })?;
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                return Err(Error::Other(format!(
                    "MCP server `{}` wrote non-JSON to stdout: {}",
                    self.command,
                    clip(&line, 200)
                )));
            };
            if reply.get("id") == Some(id) {
                return Ok(reply);
            }
        }
    }

    fn close(&mut self) -> Result<()> {
        drop(self.stdin.take());
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + EXIT_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Ok(None) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Err(_) => break,
                }
            }
        }
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
        Ok(())
    }
}

// ---- Streamable HTTP --------------------------------------------------------------------

#[cfg(feature = "http")]
struct HttpTransport {
    agent: ureq::Agent,
    url: String,
    headers: Vec<(String, String)>,
    session_id: Option<String>,
    protocol_version: Option<String>,
}

#[cfg(feature = "http")]
impl HttpTransport {
    fn new(url: &str, headers: &[(String, String)], timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            url: url.to_owned(),
            headers: headers.to_vec(),
            session_id: None,
            protocol_version: None,
        }
    }

    fn fail(&self, what: impl std::fmt::Display) -> Error {
        Error::Other(format!("MCP server {}: {what}", self.url))
    }

    fn common_headers<B>(&self, mut req: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(sid) = &self.session_id {
            req = req.header("mcp-session-id", sid.as_str());
        }
        if let Some(pv) = &self.protocol_version {
            req = req.header("mcp-protocol-version", pv.as_str());
        }
        req
    }

    /// `POST` one message. With `want_id`, the reply carrying that id from
    /// a JSON body or an SSE stream; `None` for a notification (or a 202).
    fn post(&mut self, msg: &Value, want_id: Option<&Value>) -> Result<Option<Value>> {
        let req = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        let req = self.common_headers(req);
        let mut res = req.send(msg.to_string()).map_err(|e| self.fail(e))?;
        if let Some(sid) = res
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session_id = Some(sid.to_owned());
        }
        let status = res.status().as_u16();
        if status >= 400 {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            return Err(self.fail(format!(
                "HTTP {status} posting to endpoint: {}",
                clip(text.trim(), 300)
            )));
        }
        let Some(id) = want_id else {
            return Ok(None);
        };
        if status == 202 {
            return Ok(None);
        }
        let media = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|ct| {
                ct.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
            })
            .unwrap_or_default();
        match media.as_str() {
            "application/json" => {
                let text = res.body_mut().read_to_string().map_err(|e| self.fail(e))?;
                let body: Value = serde_json::from_str(&text)
                    .map_err(|e| self.fail(format!("non-JSON body: {e}")))?;
                let found = match body {
                    Value::Array(items) => items.into_iter().find(|m| m.get("id") == Some(id)),
                    other if other.get("id") == Some(id) => Some(other),
                    _ => None,
                };
                found
                    .map(Some)
                    .ok_or_else(|| self.fail("the JSON body carried no reply to the request"))
            }
            "text/event-stream" => {
                let reader = BufReader::new(res.body_mut().as_reader());
                let found = sse_find(reader, id).map_err(|e| self.fail(e))?;
                found
                    .map(Some)
                    .ok_or_else(|| self.fail("the SSE stream ended without a reply to the request"))
            }
            other => Err(self.fail(format!("unexpected content type: {other:?}"))),
        }
    }

    /// `DELETE` the session (best effort; a 405 means the server keeps no
    /// sessions).
    fn delete_session(&mut self) {
        if self.session_id.is_none() {
            return;
        }
        let req = self.agent.delete(&self.url);
        let req = self.common_headers(req);
        let _ = req.call();
        self.session_id = None;
    }
}

/// Read SSE events from `reader` until one's `data` is the JSON-RPC message
/// carrying `id` (returned), or the stream ends (`None`). Events are blank
/// line separated; `data:` lines of one event join with `\n`; other fields
/// (`event`, `id`, `retry`) and comments are skipped.
#[cfg(feature = "http")]
fn sse_find(reader: impl BufRead, id: &Value) -> std::io::Result<Option<Value>> {
    let mut data: Vec<String> = Vec::new();
    let mut lines = reader.lines();
    loop {
        let line = match lines.next() {
            Some(l) => Some(l?),
            None => None,
        };
        let end_of_event = line.as_deref().is_none_or(|l| l.is_empty());
        if end_of_event {
            if !data.is_empty() {
                let payload = data.join("\n");
                data.clear();
                if let Ok(msg) = serde_json::from_str::<Value>(&payload) {
                    let hit = match &msg {
                        Value::Array(items) => {
                            items.iter().find(|m| m.get("id") == Some(id)).cloned()
                        }
                        m if m.get("id") == Some(id) => Some(msg.clone()),
                        _ => None,
                    };
                    if hit.is_some() {
                        return Ok(hit);
                    }
                }
            }
            if line.is_none() {
                return Ok(None);
            }
            continue;
        }
        let line = line.unwrap_or_default();
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line.as_str(), ""),
        };
        if field == "data" {
            data.push(value.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_specs_follow_the_one_rule() {
        let h = |k: &str, v: &str| (k.to_owned(), v.to_owned());
        assert_eq!(
            parse_engine_spec("  https://host/k/secret/mcp ", &[h("X-A", "1")]).unwrap(),
            EngineSpec::Http {
                url: "https://host/k/secret/mcp".into(),
                headers: vec![h("X-A", "1")],
            }
        );
        assert_eq!(
            parse_engine_spec("HTTP://host/mcp", &[]).unwrap(),
            EngineSpec::Http {
                url: "HTTP://host/mcp".into(),
                headers: vec![],
            }
        );
        assert_eq!(
            parse_engine_spec("omg   mcp -C /vault", &[]).unwrap(),
            EngineSpec::Stdio {
                command: "omg".into(),
                args: vec!["mcp".into(), "-C".into(), "/vault".into()],
            }
        );
        assert!(
            parse_engine_spec("omg mcp", &[h("X", "y")]).is_err(),
            "headers need a url"
        );
        assert!(parse_engine_spec("   ", &[]).is_err(), "an empty spec");
        assert!(!is_http_url("httpx://nope") && !is_http_url("http:/one-slash"));
    }

    #[test]
    fn tool_results_turn_envelopes_into_errors() {
        let ok = ToolResult {
            body: json!({ "items": [] }),
            is_error: false,
        };
        assert_eq!(ok.into_result("docs_list").unwrap(), json!({ "items": [] }));
        let bad = ToolResult {
            body: json!({ "error": "doc_missing", "message": "no document for a.md", "retriable": false }),
            is_error: true,
        };
        let msg = bad.into_result("docs_read").unwrap_err().to_string();
        assert_eq!(
            msg,
            "tool docs_read failed: doc_missing — no document for a.md"
        );
    }

    #[test]
    fn wire_shapes_map_to_store_outcomes() {
        let o = observe_outcome(&json!({
            "docId": "d_0", "path": "a.md", "rev": "r_0", "commitId": "c_0",
            "converged": true, "echo": false, "conflicted": false,
            "dispositions": [{ "kind": "same", "count": 2 }, { "kind": "edited", "count": 1 }],
        }));
        assert_eq!((o.doc_id.as_str(), o.path.as_str()), ("d_0", "a.md"));
        assert_eq!(o.dispositions["same"], 2);
        assert!(o.converged && !o.echo);
        let echo = observe_outcome(
            &json!({ "docId": "d_0", "path": "a.md", "rev": null, "commitId": null, "converged": true, "echo": true, "conflicted": false, "dispositions": [] }),
        );
        assert!(echo.echo && echo.rev.is_none());
        let page = changes_page(
            &json!({
                "digests": [{ "commit": "c_1", "seq": 1, "ts": "t", "origin": "api", "actor": null, "summary": "s",
                              "revisions": [{ "doc": "d_0", "path": "a.md", "contentHash": "ab" }] }],
                "cursor": 1, "truncated": false, "head": 1,
            }),
            0,
        );
        assert_eq!(page.digests[0].revisions[0].content_hash, "ab");
        assert_eq!(page.cursor, 1);
        assert_eq!(
            changes_page(&json!({}), 7).cursor,
            7,
            "an empty page keeps the input cursor"
        );
    }

    /// A `sh` MCP server: replies to `initialize` and to `tools/call` by id,
    /// swallows notifications, writes one stray notification first.
    fn sh_server() -> String {
        r##"
printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"hi"}}'
while IFS= read -r line; do
  case "$line" in
    *'"id":'*) ;;
    *) continue ;;
  esac
  id="${line#*\"id\":}"; id="${id%%,*}"
  case "$line" in
    *'"initialize"'*) printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"sh\",\"version\":\"0\"}}}" ;;
    *'"docs_list"'*) printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"items\\\":[]}\"}]}}" ;;
    *'"docs_read"'*) printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"{\\\"error\\\":\\\"doc_missing\\\",\\\"message\\\":\\\"nope\\\",\\\"retriable\\\":false}\"}]}}" ;;
    *'"tools/list"'*) printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"tools\":[{\"name\":\"docs_list\"}]}}" ;;
    *) printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"error\":{\"code\":-32601,\"message\":\"method not found\"}}" ;;
  esac
done
"##
        .to_owned()
    }

    #[test]
    fn stdio_handshake_calls_and_closes() {
        let spec = EngineSpec::Stdio {
            command: "sh".into(),
            args: vec!["-c".into(), sh_server()],
        };
        let mut c = McpEngineClient::connect_with(&spec, Duration::from_secs(10)).unwrap();
        assert_eq!(c.protocol_version(), "2024-11-05");
        assert_eq!(c.server_info()["name"], "sh");
        assert_eq!(c.list_tools().unwrap()[0]["name"], "docs_list");
        assert_eq!(
            c.call("docs_list", json!({})).unwrap(),
            json!({ "items": [] })
        );
        let r = c.call_tool("docs_read", json!({ "doc": "x" })).unwrap();
        assert!(r.is_error);
        assert_eq!(r.body["error"], "doc_missing");
        assert!(
            c.read_doc("x.md").unwrap().is_none(),
            "a tool error reads as absent"
        );
        let err = c
            .request("resources/list", Value::Null)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("method not found") && err.contains("-32601"),
            "{err}"
        );
        c.close().unwrap();
        c.close().unwrap();
        assert!(c.call("docs_list", json!({})).is_err(), "closed");
    }

    #[test]
    fn a_missing_command_and_a_silent_server_fail_cleanly() {
        let spec = EngineSpec::Stdio {
            command: "definitely-not-an-mcp-server-xyz".into(),
            args: vec![],
        };
        let err = McpEngineClient::connect(&spec).unwrap_err().to_string();
        assert!(err.contains("cannot start the MCP server"), "{err}");
        // A server that never answers: the bounded wait, then the error.
        let spec = EngineSpec::Stdio {
            command: "sh".into(),
            args: vec!["-c".into(), "cat >/dev/null".into()],
        };
        let err = McpEngineClient::connect_with(&spec, Duration::from_millis(300))
            .unwrap_err()
            .to_string();
        assert!(err.contains("no reply to initialize"), "{err}");
        // A server that exits at once.
        let spec = EngineSpec::Stdio {
            command: "sh".into(),
            args: vec!["-c".into(), "exit 0".into()],
        };
        let err = McpEngineClient::connect_with(&spec, Duration::from_secs(5))
            .unwrap_err()
            .to_string();
        assert!(err.contains("exited while waiting"), "{err}");
    }

    #[cfg(feature = "http")]
    mod http {
        use super::*;
        use std::io::Read;
        use std::net::TcpListener;

        /// A one-connection-at-a-time HTTP server that answers `n` requests:
        /// `initialize` → JSON with `Mcp-Session-Id: s1`; a notification →
        /// 202; `tools/call` → an SSE stream (a comment, an unrelated event,
        /// then the reply); `DELETE` → 200. Records every request's headers.
        fn serve(n: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/k/secret/mcp", listener.local_addr().unwrap());
            let h = std::thread::spawn(move || {
                let mut seen = Vec::new();
                for _ in 0..n {
                    let (mut s, _) = listener.accept().unwrap();
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let (head, body_len) = loop {
                        let k = s.read(&mut tmp).unwrap();
                        buf.extend_from_slice(&tmp[..k]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..pos]).into_owned();
                            let len = head
                                .lines()
                                .find_map(|l| {
                                    let (k, v) = l.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse::<usize>().ok())?
                                })
                                .unwrap_or(0);
                            buf.drain(..pos + 4);
                            break (head, len);
                        }
                    };
                    while buf.len() < body_len {
                        let k = s.read(&mut tmp).unwrap();
                        buf.extend_from_slice(&tmp[..k]);
                    }
                    let body = String::from_utf8_lossy(&buf[..body_len]).into_owned();
                    seen.push(format!("{head}\n\n{body}"));
                    let req: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                    let id = req.get("id").cloned().unwrap_or(Value::Null);
                    let reply = if head.starts_with("DELETE") {
                        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_owned()
                    } else if method == "initialize" {
                        let b = json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": { "name": "tcp", "version": "1" } } }).to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nMcp-Session-Id: s1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
                            b.len()
                        )
                    } else if id.is_null() {
                        "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_owned()
                    } else {
                        let b = json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": "{\"items\":[{\"path\":\"a.md\"}]}" }] } }).to_string();
                        let sse = format!(
                            ": keep-alive\n\nevent: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{{}}}}\n\nid: 7\nevent: message\ndata: {b}\n\n"
                        );
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
                            sse.len()
                        )
                    };
                    s.write_all(reply.as_bytes()).unwrap();
                }
                seen
            });
            (url, h)
        }

        #[test]
        fn streamable_http_round_trips_session_headers_json_and_sse() {
            let (url, server) = serve(4);
            let spec = EngineSpec::Http {
                url: url.clone(),
                headers: vec![("X-Auth".to_owned(), "t0k".to_owned())],
            };
            let mut c = McpEngineClient::connect_with(&spec, Duration::from_secs(10)).unwrap();
            assert_eq!(c.server_info()["name"], "tcp");
            let out = c.call("docs_list", json!({})).unwrap();
            assert_eq!(out["items"][0]["path"], "a.md");
            c.close().unwrap();
            let seen = server.join().unwrap();
            assert_eq!(seen.len(), 4, "initialize, initialized, tools/call, DELETE");
            let lower: Vec<String> = seen.iter().map(|s| s.to_ascii_lowercase()).collect();
            assert!(
                lower[0].starts_with("post /k/secret/mcp "),
                "the url is used verbatim"
            );
            assert!(lower[0].contains("accept: application/json, text/event-stream"));
            assert!(
                lower[0].contains("x-auth: t0k"),
                "extra headers on every request"
            );
            assert!(
                !lower[0].contains("mcp-session-id"),
                "no session before initialize"
            );
            assert!(
                lower[1].contains("mcp-session-id: s1"),
                "the session id rides after"
            );
            assert!(lower[1].contains("mcp-protocol-version: 2025-03-26"));
            assert!(
                lower[2].contains("\"method\":\"tools/call\"") && lower[2].contains("x-auth: t0k")
            );
            assert!(lower[3].starts_with("delete ") && lower[3].contains("mcp-session-id: s1"));
        }

        #[test]
        fn http_errors_are_reported() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/mcp", listener.local_addr().unwrap());
            std::thread::spawn(move || {
                let (mut s, _) = listener.accept().unwrap();
                let mut tmp = [0u8; 4096];
                let _ = s.read(&mut tmp);
                s.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\nnot ok").unwrap();
            });
            let spec = EngineSpec::Http {
                url,
                headers: vec![],
            };
            let err = McpEngineClient::connect_with(&spec, Duration::from_secs(5))
                .unwrap_err()
                .to_string();
            assert!(err.contains("HTTP 401") && err.contains("not ok"), "{err}");
        }

        #[test]
        fn sse_parsing_finds_the_reply() {
            let stream = ": hello\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"n\"}\n\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":3,\"result\":{}}\n\n";
            let found = sse_find(stream.as_bytes(), &json!(3)).unwrap().unwrap();
            assert_eq!(found["result"], json!({}));
            assert!(sse_find(stream.as_bytes(), &json!(4)).unwrap().is_none());
            // No trailing blank line: the final event still counts.
            let tail = "data: {\"id\":1,\"result\":1}";
            assert_eq!(
                sse_find(tail.as_bytes(), &json!(1)).unwrap().unwrap()["result"],
                1
            );
        }
    }
}
