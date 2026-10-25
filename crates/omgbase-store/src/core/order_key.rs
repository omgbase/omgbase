//! Fractional order keys (`spec/store/README.md` §4.3): base-62 strings that
//! sort bytewise among siblings; `key_between(a, b)` is strictly between its
//! bounds.

/// The digits, in order: `'0' < 'A' < 'a'` bytewise.
pub const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = 62;
const MID: usize = BASE / 2; // 31 → 'V'

fn digit_val(c: u8) -> usize {
    DIGITS
        .iter()
        .position(|&d| d == c)
        .unwrap_or_else(|| panic!("invalid order-key digit: {:?}", c as char))
}

fn digit(i: usize) -> char {
    DIGITS[i] as char
}

/// A key strictly between `a` and `b`; `None` bounds are open (`a = None` →
/// before `b`, `b = None` → after `a`; both → `"V"`).
///
/// # Panics
///
/// If both bounds are given and `a >= b`, or a key holds a non-digit.
#[must_use]
pub fn key_between(a: Option<&str>, b: Option<&str>) -> String {
    match (a, b) {
        (Some(a), Some(b)) if a >= b => panic!("key_between: a must be < b (got {a}, {b})"),
        (None, None) => digit(MID).to_string(),
        (Some(a), None) => {
            let last = digit_val(*a.as_bytes().last().expect("non-empty key"));
            if last + 1 < BASE {
                format!("{}{}", &a[..a.len() - 1], digit(last + 1))
            } else {
                format!("{a}{}", digit(MID))
            }
        }
        (None, Some(b)) => {
            let first = digit_val(b.as_bytes()[0]);
            if first > 0 {
                digit(first / 2).to_string()
            } else {
                let rest = &b[1..];
                format!("0{}", key_between(None, (!rest.is_empty()).then_some(rest)))
            }
        }
        (Some(a), Some(b)) => {
            let (ab, bb) = (a.as_bytes(), b.as_bytes());
            let mut prefix = String::new();
            let mut i = 0;
            loop {
                let da = ab.get(i).map_or(0, |&c| digit_val(c));
                let db = bb.get(i).map_or(BASE, |&c| digit_val(c));
                if da == db {
                    prefix.push(digit(da));
                    i += 1;
                    continue;
                }
                if db - da > 1 {
                    prefix.push(digit(da + (db - da) / 2));
                    return prefix;
                }
                prefix.push(digit(da));
                let rest = a.get(i + 1..).unwrap_or("");
                prefix.push_str(&key_between((!rest.is_empty()).then_some(rest), None));
                return prefix;
            }
        }
    }
}

/// The first `n` append keys from scratch: `V, W, X, …, z, zV, zW, …`.
#[must_use]
pub fn sequential_keys(n: usize) -> Vec<String> {
    let mut keys: Vec<String> = Vec::with_capacity(n);
    for _ in 0..n {
        let next = key_between(keys.last().map(String::as_str), None);
        keys.push(next);
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequential_append_keys_strictly_increase() {
        let keys = sequential_keys(200);
        for w in keys.windows(2) {
            assert!(w[0] < w[1], "{} < {}", w[0], w[1]);
        }
        assert_eq!(&keys[..3], ["V", "W", "X"]);
        assert_eq!(keys[30], "z");
        assert_eq!(keys[31], "zV");
        assert_eq!(keys[32], "zW");
    }

    #[test]
    fn inserts_strictly_between_adjacent_keys() {
        let keys = sequential_keys(10);
        let mid = key_between(Some(&keys[3]), Some(&keys[4]));
        assert!(keys[3] < mid && mid < keys[4], "{mid}");
        assert_eq!(key_between(Some("V"), Some("W")), "VV");
        assert_eq!(
            key_between(Some("A"), Some("a")),
            "N",
            "10 + (36 - 10) / 2 = 23"
        );
        assert_eq!(key_between(Some("V"), Some("X")), "W");
    }

    #[test]
    fn handles_open_bounds() {
        let first = key_between(None, None);
        assert_eq!(first, "V");
        let before = key_between(None, Some(&first));
        let after = key_between(Some(&first), None);
        assert!(before < first && first < after);
        assert_eq!(before, "F");
        assert_eq!(after, "W");
        assert_eq!(key_between(None, Some("0V")), "0F");
        assert_eq!(key_between(None, Some("0")), "0V");
    }

    #[test]
    #[should_panic(expected = "a must be < b")]
    fn rejects_inverted_bounds() {
        let _ = key_between(Some("Z"), Some("A"));
    }

    #[test]
    fn repeated_midpoint_insertion_stays_ordered() {
        for n in 1..=30 {
            let lo = key_between(None, None);
            let mut hi = key_between(Some(&lo), None);
            for _ in 0..n {
                let mid = key_between(Some(&lo), Some(&hi));
                assert!(lo < mid && mid < hi, "{lo} < {mid} < {hi}");
                hi = mid;
            }
        }
        // And squeezing from the other side.
        let hi = key_between(None, None);
        let mut lo = key_between(None, Some(&hi));
        for _ in 0..30 {
            let mid = key_between(Some(&lo), Some(&hi));
            assert!(lo < mid && mid < hi, "{lo} < {mid} < {hi}");
            lo = mid;
        }
    }
}
