//! Canonical encodings (`spec/store/README.md` §4.1): tree-node entries,
//! canonical attrs JSON and the Merkle node hash.

use omgbase_format::Attrs;
use omgbase_format::hash::{hex, sha256};
use omgbase_format::json::attrs_to_json;
use serde_json::Value;

use crate::error::{Error, Result};

/// One entry of a tree node: the six-element array of §4.1.
#[derive(Clone, Debug, PartialEq)]
pub struct TreeEntry {
    pub block_id: String,
    /// `sha256(raw)`, lowercase hex.
    pub raw_hash_hex: String,
    /// The children's node hash, or `None` for a leaf.
    pub child_tree_hash_hex: Option<String>,
    /// The spec/format §3 kind name.
    pub kind: String,
    /// The block's attrs as a JSON object.
    pub attrs: Value,
    /// The trailing trivia blob's hash, or `None` when the trivia is empty.
    pub trivia_hash_hex: Option<String>,
}

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

/// The canonical entries serialization: an array of six-element arrays, no
/// whitespace, `null` for a missing child tree or trivia.
#[must_use]
pub fn serialize_tree_entries(entries: &[TreeEntry]) -> String {
    let mut out = String::from("[");
    for (i, e) in entries.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&Value::String(e.block_id.clone()).to_string());
        out.push(',');
        out.push_str(&Value::String(e.raw_hash_hex.clone()).to_string());
        out.push(',');
        match &e.child_tree_hash_hex {
            Some(h) => out.push_str(&Value::String(h.clone()).to_string()),
            None => out.push_str("null"),
        }
        out.push(',');
        out.push_str(&Value::String(e.kind.clone()).to_string());
        out.push(',');
        out.push_str(&canonical_json(&e.attrs));
        out.push(',');
        match &e.trivia_hash_hex {
            Some(h) => out.push_str(&Value::String(h.clone()).to_string()),
            None => out.push_str("null"),
        }
        out.push(']');
    }
    out.push(']');
    out
}

/// `sha256(serialize_tree_entries(entries))`.
#[must_use]
pub fn tree_hash(entries: &[TreeEntry]) -> [u8; 32] {
    sha256(serialize_tree_entries(entries).as_bytes())
}

/// Parse a stored `tree_nodes.entries` text back into entries.
pub fn parse_tree_entries(text: &str) -> Result<Vec<TreeEntry>> {
    let rows: Vec<Value> = serde_json::from_str(text)?;
    rows.into_iter()
        .map(|row| {
            let arr = row
                .as_array()
                .filter(|a| a.len() == 6)
                .ok_or_else(|| Error::Other("tree entry is not a six-element array".to_owned()))?;
            let string = |i: usize| -> Result<String> {
                arr[i]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| Error::Other(format!("tree entry field {i} is not a string")))
            };
            let optional = |i: usize| -> Result<Option<String>> {
                match &arr[i] {
                    Value::Null => Ok(None),
                    Value::String(s) => Ok(Some(s.clone())),
                    _ => Err(Error::Other(format!(
                        "tree entry field {i} is neither a string nor null"
                    ))),
                }
            };
            if !arr[4].is_object() {
                return Err(Error::Other("tree entry attrs is not an object".to_owned()));
            }
            Ok(TreeEntry {
                block_id: string(0)?,
                raw_hash_hex: string(1)?,
                child_tree_hash_hex: optional(2)?,
                kind: string(3)?,
                attrs: arr[4].clone(),
                trivia_hash_hex: optional(5)?,
            })
        })
        .collect()
}

/// Hex of a 32-byte hash (re-exported convenience).
#[must_use]
pub fn hash_hex(hash: &[u8]) -> String {
    hex(hash)
}

/// Decode lowercase or uppercase hex into bytes.
pub fn from_hex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
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

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_format::AttrValue;
    use serde_json::json;

    fn entry() -> TreeEntry {
        TreeEntry {
            block_id: "b_k7z2p9q".to_owned(),
            raw_hash_hex: "deadbeef".to_owned(),
            child_tree_hash_hex: None,
            kind: "paragraph".to_owned(),
            attrs: json!({}),
            trivia_hash_hex: None,
        }
    }

    #[test]
    fn canonical_attrs_sorts_keys_without_whitespace() {
        assert_eq!(
            canonical_json(&json!({ "b": 1, "a": 2 })),
            r#"{"a":2,"b":1}"#
        );
        assert_eq!(canonical_json(&json!({})), "{}");
        assert_eq!(
            canonical_json(&json!({ "z": [3, 1], "a": { "y": 1, "x": 2 } })),
            r#"{"a":{"x":2,"y":1},"z":[3,1]}"#
        );
        let mut attrs = Attrs::new();
        attrs.insert("level".to_owned(), AttrValue::Int(2));
        attrs.insert("checked".to_owned(), AttrValue::Bool(true));
        attrs.insert("lang".to_owned(), AttrValue::Str("a \"q\" \n".to_owned()));
        assert_eq!(
            canonical_attrs(&attrs),
            r#"{"checked":true,"lang":"a \"q\" \n","level":2}"#
        );
        // Bytewise: uppercase sorts before lowercase, as JavaScript's sort().
        assert_eq!(
            canonical_json(&json!({ "b": 1, "B": 2 })),
            r#"{"B":2,"b":1}"#
        );
    }

    #[test]
    fn serializes_positional_entries_canonically() {
        assert_eq!(
            serialize_tree_entries(&[entry()]),
            r#"[["b_k7z2p9q","deadbeef",null,"paragraph",{},null]]"#
        );
        let mut two = entry();
        two.child_tree_hash_hex = Some("aa".to_owned());
        two.trivia_hash_hex = Some("bb".to_owned());
        two.attrs = json!({ "ordered": true, "level": 1 });
        assert_eq!(
            serialize_tree_entries(&[entry(), two]),
            r#"[["b_k7z2p9q","deadbeef",null,"paragraph",{},null],["b_k7z2p9q","deadbeef","aa","paragraph",{"level":1,"ordered":true},"bb"]]"#
        );
        assert_eq!(serialize_tree_entries(&[]), "[]");
    }

    #[test]
    fn tree_hash_matches_the_reference_golden_vector() {
        assert_eq!(
            hex(&tree_hash(&[entry()])),
            "1d1679899502cbd6996749f2eb8f2ebdc4f786fbb144edd4bec82a3dbd4cd4c1"
        );
        assert_eq!(tree_hash(&[entry()]), tree_hash(&[entry().clone()]));
    }

    #[test]
    fn parses_what_it_serializes() {
        let mut two = entry();
        two.child_tree_hash_hex = Some("aa".to_owned());
        two.attrs = json!({ "level": 1 });
        let text = serialize_tree_entries(&[entry(), two.clone()]);
        let parsed = parse_tree_entries(&text).unwrap();
        assert_eq!(parsed, vec![entry(), two]);
        assert!(parse_tree_entries("[[1,2]]").is_err());
        assert!(parse_tree_entries("not json").is_err());
        assert!(parse_tree_entries(r#"[["b","h",null,"paragraph",[],null]]"#).is_err());
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(from_hex("00ff1a").unwrap(), vec![0x00, 0xff, 0x1a]);
        assert_eq!(hash_hex(&[0x00, 0xff, 0x1a]), "00ff1a");
        assert!(from_hex("abc").is_err());
        assert!(from_hex("zz").is_err());
    }
}
