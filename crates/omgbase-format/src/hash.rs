//! Hashes (`spec/format/README.md` §4.2): SHA-256 over UTF-8 bytes.

use sha2::{Digest, Sha256};

/// SHA-256 of `bytes`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// `raw_hash`: SHA-256 of a block's raw bytes (the UTF-8 encoding of its
/// span).
#[must_use]
pub fn raw_hash(raw: &str) -> [u8; 32] {
    sha256(raw.as_bytes())
}

/// `norm_hash`: SHA-256 of the UTF-8 encoding of a block's normalized text.
#[must_use]
pub fn norm_hash(text: &str) -> [u8; 32] {
    sha256(text.as_bytes())
}

/// Lowercase hex, as fixtures carry `raw_hash` (64 characters for SHA-256).
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&raw_hash("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hex(&raw_hash("abc")), hex(&norm_hash("abc")));
    }

    #[test]
    fn hashes_utf8_bytes_not_chars() {
        // "é" is two bytes; the digest must be of the encoding.
        assert_eq!(raw_hash("é"), sha256(&[0xc3, 0xa9]));
        assert_eq!(hex(&[0x00, 0xff, 0x1a]), "00ff1a");
    }
}
