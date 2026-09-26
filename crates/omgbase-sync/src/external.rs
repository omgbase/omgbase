//! The adapter protocol client (`spec/sync/README.md` §5): spawn an adapter
//! command with `args + render_config_flags(config)` and the source's `env`,
//! then speak newline-delimited JSON over its stdio — a handshake line, then
//! id-matched requests and responses with ids from 1, plus the unsolicited
//! `{"event":"batch"}` stream while a watch is live. stdout is the protocol;
//! stderr is inherited for logs.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::PROTOCOL_VERSION;
use crate::error::{Error, Result};
use crate::registry::{AdapterRow, SourceRow, render_config_flags};
use crate::source::{SourceCapabilities, SourceEntry, SourceItem, SyncSource};

/// A connected adapter.
pub struct ExternalSource {
    command: String,
    caps: SourceCapabilities,
    stdin: Option<Box<dyn Write + Send>>,
    responses: Receiver<String>,
    batches: Option<Receiver<Vec<String>>>,
    /// Set while a watch is live; a batch event arriving otherwise is dropped
    /// (§9: never buffered as a response).
    watching: Arc<AtomicBool>,
    next_id: u64,
    child: Option<Child>,
    reader: Option<JoinHandle<()>>,
    /// Every request line sent, without the newline (for tests and traces).
    pub sent: Vec<String>,
    /// Keep the trace (off by default: production sends are not retained).
    pub trace: bool,
}

impl std::fmt::Debug for ExternalSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalSource")
            .field("command", &self.command)
            .field("caps", &self.caps)
            .finish_non_exhaustive()
    }
}

/// Demultiplex adapter stdout: `{"event":"batch"}` lines go to `batches`
/// while `watching` (dropped otherwise), every other non-empty line to
/// `responses`. Ends at EOF.
fn route(
    reader: Box<dyn Read + Send>,
    responses: Sender<String>,
    batches: Sender<Vec<String>>,
    watching: Arc<AtomicBool>,
) {
    let buf = BufReader::new(reader);
    for line in buf.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(trimmed) {
            if obj.get("event").and_then(Value::as_str) == Some("batch") {
                let paths: Vec<String> = obj
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                if watching.load(Ordering::SeqCst) {
                    let _ = batches.send(paths);
                }
                continue;
            }
        }
        // Non-JSON on stdout is a protocol violation; surfaced as a response
        // so the awaiting call fails instead of hanging.
        if responses.send(trimmed.to_owned()).is_err() {
            break;
        }
    }
}

impl ExternalSource {
    /// Spawn `command args…` with `env` merged over the parent's and connect.
    pub fn spawn(command: &str, args: &[String], env: &BTreeMap<String, String>) -> Result<Self> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|e| Error::AdapterSpawn {
            command: command.to_owned(),
            message: e.to_string(),
        })?;
        let stdin = child.stdin.take().ok_or_else(|| Error::AdapterSpawn {
            command: command.to_owned(),
            message: "no stdin pipe".to_owned(),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| Error::AdapterSpawn {
            command: command.to_owned(),
            message: "no stdout pipe".to_owned(),
        })?;
        Self::connect_inner(command, Box::new(stdout), Box::new(stdin), Some(child))
    }

    /// Spawn a registry source: the adapter's `command`, its fixed `args`,
    /// then `render_config_flags(source.config)`; the source's `env`.
    pub fn spawn_source(source: &SourceRow, adapter: &AdapterRow) -> Result<Self> {
        let mut args = adapter.args.clone();
        args.extend(render_config_flags(&source.config));
        Self::spawn(&adapter.command, &args, &source.env)
    }

    /// The argv an adapter is spawned with (§5), for callers that log it.
    #[must_use]
    pub fn argv(source: &SourceRow, adapter: &AdapterRow) -> Vec<String> {
        let mut argv = vec![adapter.command.clone()];
        argv.extend(adapter.args.iter().cloned());
        argv.extend(render_config_flags(&source.config));
        argv
    }

    /// Connect over an arbitrary pair of streams (the adapter's stdout to
    /// read, its stdin to write) — a test or a runner playing a scripted
    /// adapter over pipes. `label` names the adapter in errors.
    pub fn connect(
        label: &str,
        from_adapter: impl Read + Send + 'static,
        to_adapter: impl Write + Send + 'static,
    ) -> Result<Self> {
        Self::connect_inner(label, Box::new(from_adapter), Box::new(to_adapter), None)
    }

    fn connect_inner(
        command: &str,
        from_adapter: Box<dyn Read + Send>,
        to_adapter: Box<dyn Write + Send>,
        child: Option<Child>,
    ) -> Result<Self> {
        let (resp_tx, resp_rx) = channel();
        let (batch_tx, batch_rx) = channel();
        let watching = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&watching);
        let reader = std::thread::spawn(move || route(from_adapter, resp_tx, batch_tx, flag));
        let mut source = Self {
            command: command.to_owned(),
            caps: SourceCapabilities::default(),
            stdin: Some(to_adapter),
            responses: resp_rx,
            batches: Some(batch_rx),
            watching,
            next_id: 1,
            child,
            reader: Some(reader),
            sent: Vec::new(),
            trace: false,
        };
        // Handshake: the first line declares protocol + capabilities.
        let line = match source.responses.recv() {
            Ok(l) => l,
            Err(_) => {
                let err = Error::AdapterExited {
                    command: command.to_owned(),
                };
                let _ = source.close();
                return Err(err);
            }
        };
        let parsed: Option<Value> = serde_json::from_str(&line).ok();
        let protocol_ok = parsed
            .as_ref()
            .and_then(|v| v.get("protocol"))
            .and_then(Value::as_u64)
            == Some(PROTOCOL_VERSION);
        let Some(hs) = parsed.filter(|_| protocol_ok) else {
            let err = Error::AdapterHandshake {
                command: command.to_owned(),
                line,
            };
            let _ = source.close();
            return Err(err);
        };
        source.caps = SourceCapabilities::from_json(hs.get("capabilities"));
        Ok(source)
    }

    /// The label/command this source was spawned as.
    #[must_use]
    pub fn command(&self) -> &str {
        &self.command
    }

    /// One request/response round trip: `{"id":n,"method":m,"params":{…}}`,
    /// then responses until the one with our id (others are dropped, as the
    /// reference does); `{"error": …}` fails.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::json!({ "id": id, "method": method, "params": params }).to_string();
        if self.trace {
            self.sent.push(line.clone());
        }
        let stdin = self.stdin.as_mut().ok_or_else(|| Error::AdapterExited {
            command: self.command.clone(),
        })?;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|_| Error::AdapterExited {
                command: self.command.clone(),
            })?;
        loop {
            let raw = self.responses.recv().map_err(|_| Error::AdapterExited {
                command: self.command.clone(),
            })?;
            let msg: Value = serde_json::from_str(&raw)?;
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error").filter(|e| !e.is_null()) {
                let message = match err {
                    Value::String(s) if s.is_empty() => continue,
                    Value::String(s) => s.clone(),
                    Value::Bool(false) => continue,
                    other => other.to_string(),
                };
                return Err(Error::AdapterError {
                    method: method.to_owned(),
                    message,
                });
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Whether the child (if any) is still running.
    pub fn alive(&mut self) -> bool {
        match &mut self.child {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => self.reader.as_ref().is_some_and(|r| !r.is_finished()),
        }
    }
}

impl SyncSource for ExternalSource {
    fn capabilities(&self) -> SourceCapabilities {
        self.caps
    }

    fn enumerate(&mut self) -> Result<Vec<SourceEntry>> {
        let r = self.call("enumerate", Value::Object(Map::new()))?;
        Ok(r.get("entries")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(SourceEntry::from_json).collect())
            .unwrap_or_default())
    }

    fn fetch(&mut self, path: &str) -> Result<Option<SourceItem>> {
        let r = self.call("fetch", serde_json::json!({ "path": path }))?;
        Ok(SourceItem::from_json(r.get("item")))
    }

    fn write(&mut self, path: &str, content: &str) -> Result<()> {
        if !self.caps.write_through {
            return Err(Error::Unsupported("write".to_owned()));
        }
        self.call(
            "write",
            serde_json::json!({ "path": path, "content": content }),
        )?;
        Ok(())
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        if !self.caps.write_through {
            return Err(Error::Unsupported("remove".to_owned()));
        }
        self.call("remove", serde_json::json!({ "path": path }))?;
        Ok(())
    }

    fn watch(&mut self) -> Result<Receiver<Vec<String>>> {
        if !self.caps.watch {
            return Err(Error::Unsupported("watch".to_owned()));
        }
        let rx = self
            .batches
            .take()
            .ok_or_else(|| Error::Other("the watch stream was already taken".to_owned()))?;
        // The listener is live before the request goes out (as the reference).
        self.watching.store(true, Ordering::SeqCst);
        if let Err(e) = self.call("watch", Value::Object(Map::new())) {
            self.watching.store(false, Ordering::SeqCst);
            self.batches = Some(rx);
            return Err(e);
        }
        Ok(rx)
    }

    /// Stop listening, then `unwatch`; a failure (the process may be
    /// exiting) is ignored.
    fn unwatch(&mut self) -> Result<()> {
        self.watching.store(false, Ordering::SeqCst);
        let _ = self.call("unwatch", Value::Object(Map::new()));
        Ok(())
    }

    /// Close stdin (EOF), give the adapter a moment to exit, then SIGTERM,
    /// then SIGKILL; reap it.
    fn close(&mut self) -> Result<()> {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + Duration::from_millis(500);
            let mut exited = false;
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    exited = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if !exited {
                crate::lock::send_sigterm(i64::from(child.id()));
                let deadline = Instant::now() + Duration::from_millis(500);
                while Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        exited = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            if !exited {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        Ok(())
    }
}

impl Drop for ExternalSource {
    fn drop(&mut self) {
        if self.child.is_some() || self.stdin.is_some() {
            let _ = self.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceIdentity;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    /// A writer that collects everything written.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn lines(sink: &Sink) -> Vec<String> {
        String::from_utf8(sink.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn scripted(adapter_lines: &str) -> (ExternalSource, Sink) {
        let sink = Sink::default();
        let src =
            ExternalSource::connect("fake", Cursor::new(adapter_lines.to_owned()), sink.clone())
                .unwrap();
        (src, sink)
    }

    #[test]
    fn handshake_and_calls() {
        use crate::pipe::{Dir, ScriptedAdapter};
        let t = |d: Dir, l: &str| (d, l.to_owned());
        let transcript = vec![
            t(
                Dir::In,
                r#"{"protocol":1,"capabilities":{"identity":"inferred","writeThrough":true,"watch":true}}"#,
            ),
            t(Dir::In, ""),
            t(Dir::In, r#"{"event":"batch","paths":["early.md"]}"#),
            t(Dir::Out, r#"{"id":1,"method":"enumerate","params":{}}"#),
            t(
                Dir::In,
                r#"{"id":1,"result":{"entries":[{"path":"a.md","revision":"1:2"}]}}"#,
            ),
            t(
                Dir::Out,
                r#"{"id":2,"method":"fetch","params":{"path":"a.md"}}"#,
            ),
            t(Dir::In, r#"{"id":99,"result":{}}"#),
            t(
                Dir::In,
                r##"{"id":2,"result":{"item":{"path":"a.md","revision":"1:2","content":"# A\n"}}}"##,
            ),
            t(
                Dir::Out,
                r#"{"id":3,"method":"fetch","params":{"path":"gone.md"}}"#,
            ),
            t(Dir::In, r#"{"id":3,"result":{"item":null}}"#),
            t(
                Dir::Out,
                r#"{"id":4,"method":"write","params":{"path":"b.md","content":"x\n"}}"#,
            ),
            t(Dir::In, r#"{"id":4,"result":{"ok":true}}"#),
            t(
                Dir::Out,
                r#"{"id":5,"method":"remove","params":{"path":"b.md"}}"#,
            ),
            t(Dir::In, r#"{"id":5,"error":"nope"}"#),
            t(Dir::Out, r#"{"id":6,"method":"watch","params":{}}"#),
            t(Dir::In, r#"{"id":6,"result":{"ok":true}}"#),
            t(Dir::In, r#"{"event":"batch","paths":["a.md","b.md"]}"#),
            t(Dir::Out, r#"{"id":7,"method":"unwatch","params":{}}"#),
            t(Dir::In, r#"{"id":7,"result":{"ok":true}}"#),
        ];
        let expected_out: Vec<String> = transcript
            .iter()
            .filter(|(d, _)| *d == Dir::Out)
            .map(|(_, l)| l.clone())
            .collect();
        let (adapter, from_adapter, to_adapter) = ScriptedAdapter::spawn(transcript);
        let mut src = ExternalSource::connect("fake", from_adapter, to_adapter).unwrap();
        src.trace = true;
        assert_eq!(
            src.capabilities(),
            SourceCapabilities {
                identity: SourceIdentity::Inferred,
                write_through: true,
                watch: true
            }
        );
        let entries = src.enumerate().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].revision, "1:2");
        let item = src.fetch("a.md").unwrap().unwrap();
        assert_eq!(
            item.content,
            "# A
"
        );
        assert!(
            src.fetch("gone.md").unwrap().is_none(),
            "a stray response (id 99) was skipped"
        );
        src.write(
            "b.md", "x
",
        )
        .unwrap();
        let err = src.remove("b.md").unwrap_err();
        assert!(
            matches!(err, Error::AdapterError { ref method, ref message } if method == "remove" && message == "nope"),
            "{err}"
        );
        let rx = src.watch().unwrap();
        assert_eq!(
            rx.recv().unwrap(),
            ["a.md", "b.md"],
            "the pre-watch event was dropped"
        );
        src.unwatch().unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(src.sent, expected_out);
        assert!(src.alive());
        src.close().unwrap();
        assert!(!src.alive());
        assert_eq!(adapter.received(), expected_out);
    }

    #[test]
    fn eof_after_the_script_reports_the_adapter_gone() {
        let (mut src, sink) = scripted("{\"protocol\":1,\"capabilities\":{}}\n");
        assert!(matches!(src.fetch("x"), Err(Error::AdapterExited { .. })));
        assert_eq!(
            lines(&sink),
            [r#"{"id":1,"method":"fetch","params":{"path":"x"}}"#]
        );
        src.close().unwrap();
    }

    #[test]
    fn bad_handshakes_fail() {
        for bad in [
            "",
            "not json\n",
            "{\"protocol\":2,\"capabilities\":{}}\n",
            "{\"capabilities\":{}}\n",
        ] {
            let sink = Sink::default();
            let err =
                ExternalSource::connect("fake", Cursor::new(bad.to_owned()), sink).expect_err(bad);
            if bad.is_empty() {
                assert!(
                    matches!(err, Error::AdapterExited { .. }),
                    "{bad:?} → {err}"
                );
            } else {
                assert!(
                    matches!(err, Error::AdapterHandshake { .. }),
                    "{bad:?} → {err}"
                );
            }
        }
    }

    #[test]
    fn read_only_sources_refuse_writes_and_watch() {
        let (mut src, _sink) = scripted("{\"protocol\":1,\"capabilities\":{}}\n");
        assert!(matches!(src.write("a", "b"), Err(Error::Unsupported(_))));
        assert!(matches!(src.remove("a"), Err(Error::Unsupported(_))));
        assert!(matches!(src.watch(), Err(Error::Unsupported(_))));
    }

    #[test]
    fn spawns_a_real_process_and_closes_it() {
        // `cat` echoes stdin; a handshake we write ourselves comes back.
        let err = ExternalSource::spawn("definitely-not-a-command-xyz", &[], &BTreeMap::new())
            .err()
            .unwrap();
        assert!(matches!(err, Error::AdapterSpawn { .. }), "{err}");
        let script = "printf '%s\\n' '{\"protocol\":1,\"capabilities\":{\"watch\":true}}'; while IFS= read -r line; do case \"$line\" in *enumerate*) echo '{\"id\":1,\"result\":{\"entries\":[]}}';; *) echo \"{\\\"id\\\":${line#*\\\"id\\\":}\" | sed 's/,.*//;s/$/,\"result\":{}}/';; esac; done";
        let env: BTreeMap<String, String> = [("OMGBASE_TEST_ENV".to_owned(), "1".to_owned())]
            .into_iter()
            .collect();
        let mut src =
            ExternalSource::spawn("sh", &["-c".to_owned(), script.to_owned()], &env).unwrap();
        assert!(src.capabilities().watch);
        assert!(src.enumerate().unwrap().is_empty());
        assert!(src.alive());
        src.close().unwrap();
        assert!(!src.alive());
    }

    #[test]
    fn argv_is_command_args_then_flags() {
        let adapter = AdapterRow {
            name: "fs".into(),
            command: "omgbase-fs-adapter".into(),
            args: vec!["--v".into()],
        };
        let source = SourceRow {
            source_id: "src_0".into(),
            name: "x-fs".into(),
            adapter: "fs".into(),
            config: serde_json::json!({"root": "/r", "debounce": 750})
                .as_object()
                .cloned()
                .unwrap(),
            env: BTreeMap::new(),
        };
        assert_eq!(
            ExternalSource::argv(&source, &adapter),
            [
                "omgbase-fs-adapter",
                "--v",
                "--root",
                "/r",
                "--debounce",
                "750"
            ]
        );
    }
}
