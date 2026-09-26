//! Text similarity (`spec/reconcile/README.md` §4): token 3-gram shingles and
//! the Dice coefficient over visible text. Deterministic; no clock or RNG.

use std::collections::BTreeSet;

use omgbase_format::text::is_js_whitespace;

/// A set of shingles (token 3-grams joined by one space).
pub type Shingles = BTreeSet<String>;

/// Lowercase with Unicode default case mapping (no locale), split on runs of
/// the JavaScript `\s` set (Unicode `White_Space` minus U+0085, plus U+FEFF),
/// drop empty tokens.
#[must_use]
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(is_js_whitespace)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `|tokenize(text)|`.
#[must_use]
pub fn token_count(text: &str) -> usize {
    tokenize(text).len()
}

/// The set of token 3-grams, each the three tokens joined by one space. No
/// tokens → the empty set; one or two tokens → a single shingle of all the
/// tokens (so short texts still have one).
#[must_use]
pub fn shingles(text: &str) -> Shingles {
    const N: usize = 3;
    let tokens = tokenize(text);
    let mut out = Shingles::new();
    if tokens.is_empty() {
        return out;
    }
    if tokens.len() < N {
        out.insert(tokens.join(" "));
        return out;
    }
    for window in tokens.windows(N) {
        out.insert(window.join(" "));
    }
    out
}

/// `2|A ∩ B| / (|A| + |B|)`; both empty → 1; exactly one empty → 0.
#[must_use]
pub fn dice(a: &Shingles, b: &Shingles) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.iter().filter(|s| b.contains(*s)).count();
    (2.0 * inter as f64) / ((a.len() + b.len()) as f64)
}

/// 1 when the strings are identical, else `dice(shingles(a), shingles(b))`.
#[must_use]
pub fn text_sim(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    dice(&shingles(a), &shingles(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> Shingles {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn tokenize_lowercases_and_splits_on_the_js_whitespace_set() {
        assert_eq!(
            tokenize("  Hello\tWorld\u{00A0}x\u{3000}Y "),
            ["hello", "world", "x", "y"]
        );
        // U+0085 (NEL) is not JavaScript whitespace; U+FEFF is.
        assert_eq!(tokenize("a\u{0085}b\u{FEFF}c"), ["a\u{0085}b", "c"]);
        assert_eq!(tokenize("a\u{2028}b\u{1680}c"), ["a", "b", "c"]);
        // Zero-width space and the Mongolian vowel separator are content.
        assert_eq!(tokenize("a\u{200B}b\u{180E}c"), ["a\u{200B}b\u{180E}c"]);
        // Default case mapping: final sigma, dotted capital I.
        assert_eq!(tokenize("ΟΔΥΣΣΕΥΣ"), ["οδυσσευς"]);
        assert_eq!(tokenize("İ"), ["i\u{0307}"]);
        assert_eq!(tokenize(""), Vec::<String>::new());
        assert_eq!(token_count("one two  three"), 3);
    }

    #[test]
    fn shingles_pad_short_texts() {
        assert_eq!(shingles(""), Shingles::new());
        assert_eq!(shingles("One"), set(&["one"]));
        assert_eq!(shingles("one two"), set(&["one two"]));
        assert_eq!(shingles("one two three"), set(&["one two three"]));
        assert_eq!(shingles("a b c d"), set(&["a b c", "b c d"]));
        // Repeated 3-grams collapse (a set).
        assert_eq!(shingles("a b a b a b"), set(&["a b a", "b a b"]));
    }

    #[test]
    fn dice_and_text_sim() {
        assert_eq!(dice(&Shingles::new(), &Shingles::new()), 1.0);
        assert_eq!(dice(&set(&["x"]), &Shingles::new()), 0.0);
        assert_eq!(dice(&set(&["a", "b"]), &set(&["b", "c"])), 0.5);
        assert_eq!(text_sim("same text here", "same text here"), 1.0);
        assert_eq!(text_sim("", ""), 1.0);
        // Two thematic breaks: identical empty texts.
        assert_eq!(text_sim("cat dog", "cat fish"), 0.0);
        let s = text_sim(
            "stable block identity is difficult.",
            "stable block identity is quite difficult.",
        );
        assert!((s - 4.0 / 7.0).abs() < 1e-12, "{s}");
    }
}
