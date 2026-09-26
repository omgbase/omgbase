//! Minting: where fresh block ids come from. The matcher never chooses an
//! id's spelling (§8 "Minted ids are opaque"); it asks a [`Minter`] for one
//! each time a new block is not carried.

/// A source of fresh ids. A store implements this over its CSPRNG (the
/// reference mints `b_` + 7 Crockford base32 characters) and collision-checks
/// what it persists; runners and tests use [`SequentialMinter`]. Any
/// `FnMut() -> String` is a minter too.
pub trait Minter {
    /// The next fresh id.
    fn mint(&mut self) -> String;
}

impl<F: FnMut() -> String> Minter for F {
    fn mint(&mut self) -> String {
        self()
    }
}

/// `<prefix>_0`, `<prefix>_1`, … — deterministic ids for tests and fixture
/// runners (spec §9: the old side of a `source` fixture is `b_0`, `b_1`, …
/// in pre-order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SequentialMinter {
    pub prefix: String,
    pub next: u64,
}

impl SequentialMinter {
    #[must_use]
    pub fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.to_owned(),
            next: 0,
        }
    }
}

impl Minter for SequentialMinter {
    fn mint(&mut self) -> String {
        let id = format!("{}_{}", self.prefix, self.next);
        self.next += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequential_ids() {
        let mut m = SequentialMinter::new("b");
        assert_eq!(m.mint(), "b_0");
        assert_eq!(m.mint(), "b_1");
        let mut n = 0;
        let mut closure = || {
            n += 10;
            format!("x{n}")
        };
        let dynamic: &mut dyn Minter = &mut closure;
        assert_eq!(dynamic.mint(), "x10");
        assert_eq!(dynamic.mint(), "x20");
    }
}
