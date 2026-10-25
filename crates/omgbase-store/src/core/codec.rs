//! Canonical encodings every layer shares (`spec/store/README.md` §4.1):
//! canonical attrs JSON (what `blocks.attrs` holds and a tree entry carries)
//! and hex. The tree-entry encoding itself is the recorder's
//! (`history::tree`).

use omgbase_format::Attrs;
use omgbase_format::hash::hex;
use omgbase_format::json::attrs_to_json;
use serde_json::Value;

use crate::error::{Error, Result};

/// JSON with object keys sorted bytewise ascending (recursively) and no
/// whitespace — the reference's `canonicalAttrs`/`canonicalValue`. Scalars
/// print as `serde_json` prints them (booleans, integers and strings agree
/// with `JSON.stringify`; attrs never carry floats).
#[must_use]
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// A block's attrs as canonical JSON (§4.1 `attrs_canonical`; also what this
/// crate writes to `blocks.attrs`).
#[must_use]
pub fn canonical_attrs(attrs: &Attrs) -> String {
    canonical_json(&attrs_to_json(attrs))
}

/// Hex of a 32-byte hash (re-exported convenience).
#[must_use]
pub fn hash_hex(hash: &[u8]) -> String {
    hex(hash)
}

/// Decode lowercase or uppercase hex into bytes.
pub fn from_hex(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return Err(Error::Other(format!("odd-length hex {s:?}")));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|_| Error::Other(format!("invalid hex {s:?}")))
        })
        .collect()
}
