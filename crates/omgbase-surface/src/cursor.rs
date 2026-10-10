//! Keyset cursors (`spec/surface/README.md` §1.4): `base64url(JSON
//! [parts...])`, one encoding for every paged surface — `[path, id]` for
//! `query`, `[path]` for `docs_list`/`docs_tree`. Decoding requires exactly
//! `arity` string parts; anything else is [`SurfaceError::cursor_invalid`]
//! naming the surface.

use serde_json::Value;

use crate::error::{Result, SurfaceError};

const URL_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url of `bytes` (Node's `Buffer#toString("base64url")`).
#[must_use]
pub fn base64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let count = chunk.len() + 1;
        for i in 0..count {
            let idx = (n >> (18 - 6 * i)) & 0x3f;
            out.push(URL_ALPHABET[idx as usize] as char);
        }
    }
    out
}

fn sextet(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        // Both alphabets decode, as Node's lenient decoder accepts.
        b'-' | b'+' => Some(62),
        b'_' | b'/' => Some(63),
        _ => None,
    }
}

/// Decode base64 or base64url, padding optional. `None` on a foreign byte.
#[must_use]
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in text.as_bytes() {
        if c == b'=' {
            break;
        }
        let v = sextet(c)?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// Encode a keyset position as an opaque cursor.
#[must_use]
pub fn encode_cursor(parts: &[&str]) -> String {
    let json = Value::Array(
        parts
            .iter()
            .map(|p| Value::String((*p).to_owned()))
            .collect(),
    );
    base64url_encode(json.to_string().as_bytes())
}

/// Decode a cursor issued by [`encode_cursor`], requiring exactly `arity`
/// string parts; `surface` names the caller for the error.
pub fn decode_cursor(cursor: &str, surface: &str, arity: usize) -> Result<Vec<String>> {
    let invalid = || SurfaceError::cursor_invalid(surface);
    let bytes = base64url_decode(cursor).ok_or_else(invalid)?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let parsed: Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    let Value::Array(items) = parsed else {
        return Err(invalid());
    };
    if items.len() != arity {
        return Err(invalid());
    }
    items
        .into_iter()
        .map(|v| match v {
            Value::String(s) => Ok(s),
            _ => Err(invalid()),
        })
        .collect()
}

/// [`decode_cursor`] for the keysets whose FIRST part is a document path
/// (`query`'s `[path, id]`, `docs_list`/`docs_tree`'s `[path]`). Since
/// `spec/surface` 2.0 the surface speaks the reference form, so an issued
/// cursor's path is `/`-rooted; a bare path can only come from a 1.x cursor,
/// whose keyset would sort before every rooted row and silently replay the
/// first page — it is refused with a reason that names the cause.
pub fn decode_path_cursor(cursor: &str, surface: &str, arity: usize) -> Result<Vec<String>> {
    let parts = decode_cursor(cursor, surface, arity)?;
    if !parts[0].starts_with('/') {
        return Err(SurfaceError::cursor_invalid_reason(&format!(
            "cursor was issued before surface 2.0 (its path {} is not /-rooted); start the page sequence again without a cursor",
            Value::String(parts[0].clone())
        )));
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_from_1x_is_refused_by_the_path_decoder() {
        let rooted = encode_cursor(&["/a.md", "d_1"]);
        assert_eq!(
            decode_path_cursor(&rooted, "query", 2).unwrap(),
            ["/a.md", "d_1"]
        );
        let bare = encode_cursor(&["a.md", "d_1"]);
        let e = decode_path_cursor(&bare, "query", 2).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert!(e.message.contains("not /-rooted"), "{}", e.message);
        assert!(e.message.starts_with("invalid cursor: "));
        assert_eq!(
            e.data.as_ref().unwrap()["reason"],
            e.message["invalid cursor: ".len()..]
        );
        // the generic decoder is unchanged (the cursor.json suite pins it)
        assert_eq!(decode_cursor(&bare, "query", 2).unwrap(), ["a.md", "d_1"]);
    }

    #[test]
    fn base64url_round_trips_and_matches_node() {
        assert_eq!(base64url_encode(b""), "");
        assert_eq!(base64url_encode(b"f"), "Zg");
        assert_eq!(base64url_encode(b"fo"), "Zm8");
        assert_eq!(base64url_encode(b"foo"), "Zm9v");
        assert_eq!(base64url_encode(&[0xfb, 0xff]), "-_8");
        for s in ["", "a", "ab", "abc", "abcd", "hello world!"] {
            assert_eq!(
                base64url_decode(&base64url_encode(s.as_bytes())).unwrap(),
                s.as_bytes()
            );
        }
        assert_eq!(base64url_decode("Zm9v=").unwrap(), b"foo");
        assert_eq!(base64url_decode("+/8").unwrap(), [0xfb, 0xff]);
        assert!(base64url_decode("a b").is_none());
    }

    #[test]
    fn cursors_encode_json_tuples() {
        let c = encode_cursor(&["a.md", "d_1"]);
        assert_eq!(base64url_encode(br#"["a.md","d_1"]"#), c);
        assert_eq!(decode_cursor(&c, "query", 2).unwrap(), ["a.md", "d_1"]);
        assert_eq!(
            decode_cursor(&c, "query", 1).unwrap_err().code,
            "filter_invalid"
        );
        let bad = decode_cursor("not base64!", "docs_list", 1).unwrap_err();
        assert_eq!(bad.message, "invalid cursor");
        assert_eq!(
            bad.data.unwrap()["reason"],
            "cursor was not issued by docs_list"
        );
        let non_string = base64url_encode(br"[1]");
        assert!(decode_cursor(&non_string, "x", 1).is_err());
        let not_array = base64url_encode(br#"{"a":1}"#);
        assert!(decode_cursor(&not_array, "x", 1).is_err());
    }
}
