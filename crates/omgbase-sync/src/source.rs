//! The sync source contract (`spec/sync/README.md` §5): the in-engine view
//! of an adapter — capabilities, `enumerate`/`fetch`, `write`/`remove` when
//! it writes through, a `watch` stream when it can watch. Every call crosses
//! a pipe in production ([`crate::external::ExternalSource`]); an in-memory
//! source serves tests.

use std::collections::BTreeMap;
use std::sync::mpsc::Receiver;

use serde_json::Value;

use crate::error::{Error, Result};

/// How a source's identity relates to omgbase block identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceIdentity {
    /// Anonymous bytes; the reconciler infers continuity.
    Inferred,
    /// Stable per-member ids upstream (no adapter exists; §9).
    Borne,
}

impl SourceIdentity {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            SourceIdentity::Inferred => "inferred",
            SourceIdentity::Borne => "borne",
        }
    }
}

/// The handshake's capabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceCapabilities {
    pub identity: SourceIdentity,
    pub write_through: bool,
    pub watch: bool,
}

impl Default for SourceCapabilities {
    fn default() -> Self {
        Self {
            identity: SourceIdentity::Inferred,
            write_through: false,
            watch: false,
        }
    }
}

/// JavaScript truthiness (the reference's `Boolean(c.writeThrough)`).
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

impl SourceCapabilities {
    /// From the handshake's `capabilities` object: `identity` is `borne`
    /// only when it says so; the booleans by JavaScript truthiness.
    #[must_use]
    pub fn from_json(v: Option<&Value>) -> Self {
        let obj = v.and_then(Value::as_object);
        Self {
            identity: match obj.and_then(|o| o.get("identity")).and_then(Value::as_str) {
                Some("borne") => SourceIdentity::Borne,
                _ => SourceIdentity::Inferred,
            },
            write_through: js_truthy(obj.and_then(|o| o.get("writeThrough"))),
            watch: js_truthy(obj.and_then(|o| o.get("watch"))),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "identity": self.identity.as_str(),
            "writeThrough": self.write_through,
            "watch": self.watch,
        })
    }
}

/// A member of the scope: its storage key and cheap change token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceEntry {
    /// The repo-relative canonical path (`docs.path`).
    pub path: String,
    /// The source's change token (the fs adapter: `"<mtime_ns>:<size>"`).
    pub revision: String,
    /// The source locator when it differs from `path`.
    pub source_id: Option<String>,
}

impl SourceEntry {
    /// From a protocol `entries[]` element; `None` when `path` is missing.
    #[must_use]
    pub fn from_json(v: &Value) -> Option<Self> {
        Some(Self {
            path: v.get("path")?.as_str()?.to_owned(),
            revision: match v.get("revision") {
                Some(Value::String(s)) => s.clone(),
                Some(other) if !other.is_null() => other.to_string(),
                _ => String::new(),
            },
            source_id: v.get("sourceId").and_then(Value::as_str).map(str::to_owned),
        })
    }
}

impl SourceEntry {
    /// `{ path, revision, sourceId? }` as the protocol carries it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::json!({ "path": self.path, "revision": self.revision });
        if let Some(id) = &self.source_id {
            v["sourceId"] = Value::String(id.clone());
        }
        v
    }
}

/// A hydrated member: the entry plus its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceItem {
    pub entry: SourceEntry,
    /// The engine hashes this itself (§5).
    pub content: String,
}

impl SourceItem {
    /// From a protocol `item`; `None` for `null`/missing or no `path`.
    #[must_use]
    pub fn from_json(v: Option<&Value>) -> Option<Self> {
        let v = v?;
        if v.is_null() {
            return None;
        }
        let entry = SourceEntry::from_json(v)?;
        let content = match v.get("content") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        Some(Self { entry, content })
    }

    /// `{ path, revision, sourceId?, content }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut v = self.entry.to_json();
        v["content"] = Value::String(self.content.clone());
        v
    }
}

/// The in-engine handle to a source.
pub trait SyncSource {
    fn capabilities(&self) -> SourceCapabilities;

    /// The full current scope.
    fn enumerate(&mut self) -> Result<Vec<SourceEntry>>;

    /// One member's current state, or `None` when it left the scope.
    fn fetch(&mut self, path: &str) -> Result<Option<SourceItem>>;

    /// Persist engine-authored bytes (write-through sources only).
    fn write(&mut self, _path: &str, _content: &str) -> Result<()> {
        Err(Error::Unsupported("write".to_owned()))
    }

    /// Remove a member (write-through sources only).
    fn remove(&mut self, _path: &str) -> Result<()> {
        Err(Error::Unsupported("remove".to_owned()))
    }

    /// Subscribe to change batches: each received value is one batch of
    /// changed paths (watching sources only).
    fn watch(&mut self) -> Result<Receiver<Vec<String>>> {
        Err(Error::Unsupported("watch".to_owned()))
    }

    /// Stop the batches.
    fn unwatch(&mut self) -> Result<()> {
        Ok(())
    }

    /// Release the process / resources.
    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

/// An in-memory source for tests: a `path → content` map with a configurable
/// capability set; writes and removes are applied to the map and logged.
#[derive(Debug, Default)]
pub struct MemSource {
    pub caps: SourceCapabilities,
    pub files: BTreeMap<String, String>,
    /// `("write", path, content)` / `("remove", path, "")` in call order.
    pub log: Vec<(&'static str, String, String)>,
    /// Revision counter per path (bumped on every write).
    revisions: BTreeMap<String, u64>,
    batches: Option<std::sync::mpsc::Sender<Vec<String>>>,
}

impl MemSource {
    #[must_use]
    pub fn new(caps: SourceCapabilities) -> Self {
        Self {
            caps,
            ..Self::default()
        }
    }

    /// A source with `path → content` files and every capability.
    #[must_use]
    pub fn with_files(files: &[(&str, &str)]) -> Self {
        let mut s = Self::new(SourceCapabilities {
            identity: SourceIdentity::Inferred,
            write_through: true,
            watch: true,
        });
        for (p, c) in files {
            s.files.insert((*p).to_owned(), (*c).to_owned());
        }
        s
    }

    /// Set a file from "outside" (as if the human edited it).
    pub fn set(&mut self, path: &str, content: &str) {
        self.files.insert(path.to_owned(), content.to_owned());
        *self.revisions.entry(path.to_owned()).or_insert(0) += 1;
    }

    /// Emit a watch batch (a no-op when nothing watches).
    pub fn emit(&self, paths: &[&str]) {
        if let Some(tx) = &self.batches {
            let _ = tx.send(paths.iter().map(|p| (*p).to_owned()).collect());
        }
    }

    fn entry(&self, path: &str) -> SourceEntry {
        SourceEntry {
            path: path.to_owned(),
            revision: self.revisions.get(path).copied().unwrap_or(0).to_string(),
            source_id: None,
        }
    }
}

impl SyncSource for MemSource {
    fn capabilities(&self) -> SourceCapabilities {
        self.caps
    }

    fn enumerate(&mut self) -> Result<Vec<SourceEntry>> {
        Ok(self.files.keys().map(|p| self.entry(p)).collect())
    }

    fn fetch(&mut self, path: &str) -> Result<Option<SourceItem>> {
        Ok(self.files.get(path).map(|content| SourceItem {
            entry: self.entry(path),
            content: content.clone(),
        }))
    }

    fn write(&mut self, path: &str, content: &str) -> Result<()> {
        if !self.caps.write_through {
            return Err(Error::Unsupported("write".to_owned()));
        }
        self.set(path, content);
        self.log
            .push(("write", path.to_owned(), content.to_owned()));
        Ok(())
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        if !self.caps.write_through {
            return Err(Error::Unsupported("remove".to_owned()));
        }
        self.files.remove(path);
        self.log.push(("remove", path.to_owned(), String::new()));
        Ok(())
    }

    fn watch(&mut self) -> Result<Receiver<Vec<String>>> {
        if !self.caps.watch {
            return Err(Error::Unsupported("watch".to_owned()));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        self.batches = Some(tx);
        Ok(rx)
    }

    fn unwatch(&mut self) -> Result<()> {
        self.batches = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn capabilities_parse_with_js_truthiness() {
        let c = SourceCapabilities::from_json(Some(
            &json!({"identity": "borne", "writeThrough": "yes", "watch": 0}),
        ));
        assert_eq!(c.identity, SourceIdentity::Borne);
        assert!(c.write_through);
        assert!(!c.watch);
        let c = SourceCapabilities::from_json(Some(&json!({"identity": "weird", "watch": true})));
        assert_eq!(c.identity, SourceIdentity::Inferred);
        assert!(c.watch && !c.write_through);
        assert_eq!(
            SourceCapabilities::from_json(None),
            SourceCapabilities::default()
        );
        assert_eq!(
            SourceCapabilities::from_json(Some(&json!(null))),
            SourceCapabilities::default()
        );
        assert_eq!(
            c.to_json(),
            json!({"identity": "inferred", "writeThrough": false, "watch": true})
        );
    }

    #[test]
    fn entries_and_items_parse() {
        let e =
            SourceEntry::from_json(&json!({"path": "a.md", "revision": "1:2", "sourceId": "x"}))
                .unwrap();
        assert_eq!(
            (e.path.as_str(), e.revision.as_str(), e.source_id.as_deref()),
            ("a.md", "1:2", Some("x"))
        );
        assert_eq!(
            SourceEntry::from_json(&json!({"path": "a.md", "revision": 7}))
                .unwrap()
                .revision,
            "7"
        );
        assert_eq!(SourceEntry::from_json(&json!({"revision": "1"})), None);
        let it = SourceItem::from_json(Some(
            &json!({"path": "a.md", "revision": "r", "content": "# A\n"}),
        ))
        .unwrap();
        assert_eq!(it.content, "# A\n");
        assert_eq!(
            it.to_json(),
            json!({"path": "a.md", "revision": "r", "content": "# A\n"})
        );
        assert_eq!(
            e.to_json(),
            json!({"path": "a.md", "revision": "1:2", "sourceId": "x"})
        );
        assert_eq!(SourceItem::from_json(Some(&json!(null))), None);
        assert_eq!(SourceItem::from_json(None), None);
    }

    #[test]
    fn mem_source_behaves() {
        let mut s = MemSource::with_files(&[("a.md", "A")]);
        assert_eq!(s.enumerate().unwrap()[0].path, "a.md");
        assert_eq!(s.fetch("a.md").unwrap().unwrap().content, "A");
        assert!(s.fetch("b.md").unwrap().is_none());
        s.write("b.md", "B").unwrap();
        s.remove("a.md").unwrap();
        assert_eq!(s.log.len(), 2);
        let rx = s.watch().unwrap();
        s.emit(&["b.md"]);
        assert_eq!(rx.recv().unwrap(), ["b.md"]);
        s.unwatch().unwrap();
        s.close().unwrap();
        let mut ro = MemSource::new(SourceCapabilities::default());
        assert!(matches!(ro.write("x", "y"), Err(Error::Unsupported(_))));
        assert!(matches!(ro.remove("x"), Err(Error::Unsupported(_))));
        assert!(matches!(ro.watch(), Err(Error::Unsupported(_))));
    }
}
