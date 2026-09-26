//! Code masking with **byte**-preserving spans (§1).
//!
//! `spec/properties` §3.2 defines `mask_code`; `omgbase-properties`
//! implements it one space per *character*, which the field scan cannot tell
//! apart but which shifts byte offsets after any masked non-ASCII character.
//! Node spans are bytes into the block's UTF-8 `raw` (§2.3), so the graph
//! scanners run over this wrapper: the same masking decisions, with every
//! masked character widened to as many spaces as its UTF-8 encoding is long.
//! Offsets into the result are then offsets into `raw`.

use omgbase_properties::mask_code;

/// [`mask_code`] with `masked.len() == raw.len()` in bytes: a masked
/// character of *n* UTF-8 bytes becomes *n* spaces; everything else is `raw`.
#[must_use]
pub fn mask_code_bytes(raw: &str) -> String {
    let masked = mask_code(raw);
    if masked == raw {
        return masked;
    }
    let mut out = String::with_capacity(raw.len());
    for (orig, m) in raw.chars().zip(masked.chars()) {
        if m == orig {
            out.push(orig);
        } else {
            debug_assert_eq!(m, ' ', "mask_code only blanks");
            for _ in 0..orig.len_utf8() {
                out.push(' ');
            }
        }
    }
    debug_assert_eq!(out.len(), raw.len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_byte_length() {
        assert_eq!(mask_code_bytes("plain"), "plain");
        assert_eq!(mask_code_bytes("a `é` b"), "a      b");
        assert_eq!(mask_code_bytes("a `é` b").len(), "a `é` b".len());
        assert_eq!(
            mask_code_bytes("```\nk:: v\n```\nafter"),
            "   \n     \n   \nafter"
        );
        let raw = "x `日本` [t](/p)";
        let m = mask_code_bytes(raw);
        assert_eq!(m.len(), raw.len());
        assert_eq!(m.find("[t](/p)"), raw.find("[t](/p)"));
    }
}
