//! Identifiers (`spec/store/README.md` §2.1–§2.2): `<prefix>_<7 chars>` of
//! lowercase Crockford base32 from a CSPRNG, and the minter seam that lets a
//! fixture runner replace the CSPRNG with per-prefix counters.

use std::collections::BTreeMap;

/// Crockford base32, lowercased: no `i`, `l`, `o`, `u`.
pub const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Suffix length of a minted id.
pub const ID_LEN: usize = 7;

/// The id prefixes the store mints (§2.1). `v` is reserved.
pub const PREFIXES: [&str; 11] = ["d", "b", "c", "r", "x", "col", "cp", "e", "rp", "v", "src"];

/// Where ids come from. The store owns one; production uses [`RandomMinter`],
/// fixture runners install a [`SequentialMinter`] (§2.2).
pub trait IdMinter {
    /// A fresh id with `prefix` (`b`, `d`, `c`, `r`, `rp`, `src`, …).
    fn mint(&mut self, prefix: &str) -> String;
}

impl<F: FnMut(&str) -> String> IdMinter for F {
    fn mint(&mut self, prefix: &str) -> String {
        self(prefix)
    }
}

/// The production minter: 7 CSPRNG-drawn Crockford characters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RandomMinter;

impl IdMinter for RandomMinter {
    fn mint(&mut self, prefix: &str) -> String {
        format!("{prefix}_{}", random_suffix())
    }
}

/// `<prefix>_0, <prefix>_1, …` per prefix, each counting from 0 (§2.2).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SequentialMinter {
    counters: BTreeMap<String, u64>,
}

impl SequentialMinter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The next counter value for `prefix` (how many ids it has minted).
    #[must_use]
    pub fn next(&self, prefix: &str) -> u64 {
        self.counters.get(prefix).copied().unwrap_or(0)
    }
}

impl IdMinter for SequentialMinter {
    fn mint(&mut self, prefix: &str) -> String {
        let n = self.counters.entry(prefix.to_owned()).or_insert(0);
        let id = format!("{prefix}_{n}");
        *n += 1;
        id
    }
}

/// `ID_LEN` characters of [`ALPHABET`] from the OS CSPRNG. 32 divides 256, so
/// masking a byte to five bits is unbiased.
///
/// # Panics
///
/// If the operating system's random source is unavailable.
#[must_use]
pub fn random_suffix() -> String {
    let mut bytes = [0u8; ID_LEN];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    bytes
        .iter()
        .map(|b| ALPHABET[usize::from(b & 0x1f)] as char)
        .collect()
}

/// `^[a-z]+_[alphabet]{7}$`, optionally with a given prefix (§2.1).
#[must_use]
pub fn is_valid_id(id: &str, prefix: Option<&str>) -> bool {
    match prefix_of(id) {
        Some(p) => prefix.is_none_or(|want| want == p),
        None => false,
    }
}

/// The prefix of a well-formed id, or `None` when `id` is not one.
#[must_use]
pub fn prefix_of(id: &str) -> Option<&str> {
    let (prefix, suffix) = id.split_once('_')?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    if suffix.len() != ID_LEN || !suffix.bytes().all(|b| ALPHABET.contains(&b)) {
        return None;
    }
    Some(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn mints_prefixed_seven_char_crockford_ids() {
        let id = RandomMinter.mint("b");
        assert!(is_valid_id(&id, Some("b")), "{id}");
        assert_eq!(prefix_of(&id), Some("b"));
        assert_eq!(id.len(), 2 + ID_LEN);
        for _ in 0..100 {
            let s = random_suffix();
            assert_eq!(s.len(), ID_LEN);
            assert!(!s.contains(['i', 'l', 'o', 'u']), "{s}");
        }
    }

    #[test]
    fn validates_prefix_mismatches() {
        assert!(!is_valid_id("b_k7z2p9q", Some("d")));
        assert!(is_valid_id("b_k7z2p9q", Some("b")));
        assert!(is_valid_id("b_k7z2p9q", None));
        assert!(!is_valid_id("nope", None));
        assert!(!is_valid_id("b_TOOLONGX", None));
        assert!(!is_valid_id("b_k7z2p9", None));
        assert!(!is_valid_id("b_k7z2p9i", None), "i is not Crockford");
        assert!(!is_valid_id("B_k7z2p9q", None), "prefix is lowercase");
        assert!(!is_valid_id("_k7z2p9q", None));
        assert_eq!(prefix_of("col_k7z2p9q"), Some("col"));
        assert_eq!(prefix_of("b_0"), None, "fixture ids are not production ids");
    }

    #[test]
    fn supports_multi_char_prefixes() {
        assert!(is_valid_id(&RandomMinter.mint("col"), Some("col")));
        assert!(is_valid_id(&RandomMinter.mint("cp"), Some("cp")));
        assert!(is_valid_id(&RandomMinter.mint("src"), Some("src")));
    }

    #[test]
    fn mints_with_high_uniqueness() {
        let seen: HashSet<String> = (0..5000).map(|_| RandomMinter.mint("b")).collect();
        assert_eq!(seen.len(), 5000);
    }

    #[test]
    fn sequential_minter_counts_per_prefix_from_zero() {
        let mut m = SequentialMinter::new();
        assert_eq!(m.mint("rp"), "rp_0");
        assert_eq!(m.mint("b"), "b_0");
        assert_eq!(m.mint("b"), "b_1");
        assert_eq!(m.mint("d"), "d_0");
        assert_eq!(m.mint("b"), "b_2");
        assert_eq!(m.next("b"), 3);
        assert_eq!(m.next("c"), 0);
        let mut closure = |p: &str| format!("{p}_x");
        let dynamic: &mut dyn IdMinter = &mut closure;
        assert_eq!(dynamic.mint("q"), "q_x");
    }
}
