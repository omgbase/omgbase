//! Uniqueness at mint (`spec/store/README.md` §2.1, store 13.5): every id
//! the store hands out goes through [`Mint`], which draws candidates from the
//! inner [`IdMinter`] and redraws while a candidate is **in use** — already
//! issued by this store in this process, or claimed per the store's
//! [`IdentityClaims`] oracle (today the union of the prefix's table(s),
//! `core::claims`). 32⁷ candidates make a random collision certain by a few hundred
//! thousand blocks (§10: a 3,000-document corpus failed at 360,338), so the
//! check is what makes the production minter safe; the fixture minters never
//! collide on a fresh database and pass through unchanged.

use std::collections::HashSet;
use std::fmt;

use rusqlite::Connection;

use crate::core::capabilities::IdentityClaims;
pub use crate::core::claims::{id_in_use, tables_for};
use crate::error::{Error, Result};
use crate::ids::IdMinter;

/// Consecutive rejections after which a mint gives up. The CSPRNG cannot hit
/// this (32⁷ candidates against at most millions in use); only a minter that
/// can never produce a fresh id — a broken fixture minter — does, and it must
/// fail loudly rather than spin forever.
pub const MINT_GIVE_UP_AFTER: usize = 1_000;

/// A store's id source: the inner minter and every id it has issued in this
/// process (the ids of a transaction in flight are not yet rows, and an id
/// the fixture's repeating minter offers again must be caught before the
/// tables know it).
pub(crate) struct IdSource {
    inner: Box<dyn IdMinter>,
    /// The §2.1 oracle (`core::capabilities::IdentityClaims`): today the
    /// table union, in Phase 3 the `id_claims` table.
    claims: Box<dyn IdentityClaims>,
    issued: HashSet<String>,
    /// The planner's view of the `b`/`d` mints (`spec/mutate` §11): `None`
    /// is production.
    capture: Option<Capture>,
}

/// How a plan sees the identities a request creates (`spec/mutate` §11).
/// Only `b` and `d` are captured: `c`, `r`, `x`, `e` are the commit's own.
#[derive(Debug)]
pub(crate) enum Capture {
    /// `plan`: a `b`/`d` mint yields `$new.<n>` and issues nothing — the
    /// kinds minted, in order.
    Symbolic(Vec<&'static str>),
    /// `execute`: a `b`/`d` mint is production, and its id is recorded in
    /// order so the receipt can zip it against the plan's `new_ids`.
    Record(Vec<(&'static str, String)>),
}

impl IdSource {
    pub(crate) fn new(inner: Box<dyn IdMinter>, claims: Box<dyn IdentityClaims>) -> Self {
        Self {
            inner,
            claims,
            issued: HashSet::new(),
            capture: None,
        }
    }

    /// The checking minter over `conn` — the store's connection, or a
    /// transaction on it (a [`rusqlite::Transaction`] derefs to one).
    pub(crate) fn at<'a>(&'a mut self, conn: &'a Connection) -> Mint<'a> {
        Mint {
            conn,
            inner: &mut *self.inner,
            claims: &*self.claims,
            issued: &mut self.issued,
            capture: &mut self.capture,
        }
    }

    /// Install a capture mode; returns the previous one.
    pub(crate) fn set_capture(&mut self, capture: Option<Capture>) -> Option<Capture> {
        std::mem::replace(&mut self.capture, capture)
    }

    /// The kinds of the `b`/`d` mints the installed capture has seen, in
    /// order (`$new.<n>` is the n-th).
    pub(crate) fn captured_kinds(&self) -> Vec<&'static str> {
        match &self.capture {
            Some(Capture::Symbolic(kinds)) => kinds.clone(),
            Some(Capture::Record(ids)) => ids.iter().map(|(k, _)| *k).collect(),
            None => Vec::new(),
        }
    }
}

/// The checking minter (§2.1): what every writer mints through.
pub struct Mint<'a> {
    conn: &'a Connection,
    inner: &'a mut dyn IdMinter,
    claims: &'a dyn IdentityClaims,
    issued: &'a mut HashSet<String>,
    capture: &'a mut Option<Capture>,
}

impl fmt::Debug for Mint<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Mint")
            .field("issued", &self.issued.len())
            .finish_non_exhaustive()
    }
}

impl Mint<'_> {
    /// Mint an id with `prefix`: draw from the inner minter and redraw while
    /// the candidate is in use. Fails with [`Error::MintExhausted`] after
    /// [`MINT_GIVE_UP_AFTER`] consecutive rejections.
    pub fn mint(&mut self, prefix: &str) -> Result<String> {
        let kind: Option<&'static str> = match prefix {
            "b" => Some("block"),
            "d" => Some("document"),
            _ => None,
        };
        if let (Some(kind), Some(Capture::Symbolic(kinds))) = (kind, self.capture.as_mut()) {
            // A plan burns nothing: the n-th new identity is `$new.<n>`.
            kinds.push(kind);
            return Ok(format!("$new.{}", kinds.len() - 1));
        }
        for _ in 0..MINT_GIVE_UP_AFTER {
            let candidate = self.inner.mint(prefix);
            if self.issued.contains(&candidate)
                || self.claims.is_claimed(self.conn, prefix, &candidate)?
            {
                continue;
            }
            self.claims.claim(self.conn, prefix, &candidate)?;
            self.issued.insert(candidate.clone());
            if let (Some(kind), Some(Capture::Record(ids))) = (kind, self.capture.as_mut()) {
                ids.push((kind, candidate.clone()));
            }
            return Ok(candidate);
        }
        Err(Error::MintExhausted {
            prefix: prefix.to_owned(),
            rejected: MINT_GIVE_UP_AFTER,
        })
    }

    /// A shorter-lived handle on the same minter.
    pub fn reborrow(&mut self) -> Mint<'_> {
        Mint {
            conn: self.conn,
            inner: &mut *self.inner,
            claims: self.claims,
            issued: &mut *self.issued,
            capture: &mut *self.capture,
        }
    }

    /// This minter behind the kernels' infallible `mint()` for `prefix`
    /// (see [`Deferred`]).
    pub fn deferred(&mut self, prefix: &'static str) -> Deferred<'_> {
        Deferred {
            mint: self.reborrow(),
            prefix,
            error: None,
        }
    }
}

/// A [`Mint`] behind the infallible [`omgbase_reconcile::Minter`] the
/// reconcile and mutate kernels take: the first failure is kept and an empty
/// id returned in its place; the caller must call [`Deferred::finish`] once
/// the kernel returns, which surfaces that failure so the result minted
/// against it is never written.
pub struct Deferred<'a> {
    mint: Mint<'a>,
    prefix: &'static str,
    error: Option<Error>,
}

impl fmt::Debug for Deferred<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Deferred")
            .field("prefix", &self.prefix)
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl Deferred<'_> {
    /// `Ok` when every mint succeeded, else the first failure.
    pub fn finish(self) -> Result<()> {
        self.error.map_or(Ok(()), Err)
    }
}

impl omgbase_reconcile::Minter for Deferred<'_> {
    fn mint(&mut self) -> String {
        if self.error.is_some() {
            return String::new();
        }
        match self.mint.mint(self.prefix) {
            Ok(id) => id,
            Err(e) => {
                self.error = Some(e);
                String::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use crate::core::claims::ID_TABLES;
    use crate::ids::{RandomMinter, RepeatingMinter, SequentialMinter, is_valid_id};
    use rusqlite::params;

    #[test]
    fn every_prefix_with_a_table_is_checked_and_the_rest_are_not() {
        for p in ["d", "b", "c", "r", "x", "e", "cp", "rp", "src"] {
            assert!(!tables_for(p).is_empty(), "{p}");
        }
        assert!(tables_for("col").is_empty());
        assert!(tables_for("v").is_empty());
        assert_eq!(
            tables_for("b").len(),
            3,
            "blocks, block_changes, resurrection_pool"
        );
    }

    #[test]
    fn every_checked_table_and_column_exists() {
        let store = Store::open_in_memory().unwrap();
        for (prefix, _) in ID_TABLES {
            assert!(!id_in_use(store.conn(), prefix, "zz_0000000").unwrap());
        }
    }

    #[test]
    fn a_row_in_the_table_rejects_the_candidate() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        // Planted directly, so the issued set has never seen it.
        store
            .conn()
            .execute(
                "INSERT INTO repos (repo_id, slug) VALUES ('rp_0', 'planted')",
                [],
            )
            .unwrap();
        assert!(id_in_use(store.conn(), "rp", "rp_0").unwrap());
        assert_eq!(
            store.mint("rp").unwrap(),
            "rp_1",
            "rp_0 is in use; the redraw is rp_1"
        );
        assert_eq!(store.mint("col").unwrap(), "col_0", "col has no table");
    }

    #[test]
    fn a_block_id_in_history_stays_in_use_after_its_row_is_gone() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("r").unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO docs (doc_id, repo_id, path, created_at, updated_at) VALUES ('d_9', ?1, 'a.md', 't', 't')",
                params![repo],
            )
            .unwrap();
        let (commit, _) = store
            .new_commit(&crate::NewCommit::observed(
                &repo,
                "2026-09-26T00:00:00.000Z",
            ))
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO block_changes (block_id, commit_id, kind) VALUES ('b_0', ?1, 'deleted')",
                params![commit],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_commit, expires_ts)
                 VALUES ('b_1', ?1, 'd_9', zeroblob(32), zeroblob(32), 'paragraph', '2026-09-26T00:00:00.000Z', ?2, '2026-10-26T00:00:00.000Z')",
                params![repo, commit],
            )
            .unwrap();
        assert_eq!(
            store.mint("b").unwrap(),
            "b_2",
            "b_0 and b_1 live on in history"
        );
    }

    #[test]
    fn the_issued_set_catches_a_repeat_before_any_row_exists() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(RepeatingMinter::new())).unwrap();
        assert_eq!(store.mint("b").unwrap(), "b_0");
        assert_eq!(
            store.mint("b").unwrap(),
            "b_1",
            "the second b_0 offer is rejected"
        );
        assert_eq!(store.mint("d").unwrap(), "d_0");
        assert_eq!(store.create_repo("fixture").unwrap(), "rp_0");
    }

    #[test]
    fn the_random_minter_is_checked_and_valid() {
        let mut store = Store::open_in_memory().unwrap();
        let ids: HashSet<String> = (0..2000).map(|_| store.mint("b").unwrap()).collect();
        assert_eq!(ids.len(), 2000);
        assert!(ids.iter().all(|id| is_valid_id(id, Some("b"))));
        let _ = RandomMinter;
    }

    #[test]
    fn a_minter_that_cannot_produce_a_fresh_id_fails_after_the_bound() {
        let stuck = |prefix: &str| format!("{prefix}_stuck");
        let mut store = Store::open_in_memory_with_minter(Box::new(stuck)).unwrap();
        assert_eq!(store.mint("b").unwrap(), "b_stuck");
        let err = store.mint("b").unwrap_err();
        assert!(
            matches!(&err, Error::MintExhausted { prefix, rejected } if prefix == "b" && *rejected == MINT_GIVE_UP_AFTER),
            "{err}"
        );
        assert!(err.to_string().contains("1000"), "{err}");
    }

    #[test]
    fn symbolic_capture_mints_symbols_for_b_and_d_only_and_record_lists_them() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        store.ids.set_capture(Some(Capture::Symbolic(Vec::new())));
        assert_eq!(store.mint("b").unwrap(), "$new.0");
        assert_eq!(store.mint("d").unwrap(), "$new.1");
        assert_eq!(store.mint("b").unwrap(), "$new.2");
        assert_eq!(store.mint("c").unwrap(), "c_0", "c is the commit's own");
        let Some(Capture::Symbolic(kinds)) = store.ids.set_capture(None) else {
            panic!("symbolic capture")
        };
        assert_eq!(kinds, ["block", "document", "block"]);
        // Nothing was issued: the production minter resumes at b_0 / d_0.
        store.ids.set_capture(Some(Capture::Record(Vec::new())));
        assert_eq!(store.mint("b").unwrap(), "b_0");
        assert_eq!(store.mint("r").unwrap(), "r_0");
        assert_eq!(store.mint("d").unwrap(), "d_0");
        let Some(Capture::Record(ids)) = store.ids.set_capture(None) else {
            panic!("record capture")
        };
        assert_eq!(
            ids,
            [("block", "b_0".to_owned()), ("document", "d_0".to_owned())]
        );
        assert_eq!(store.mint("b").unwrap(), "b_1");
    }

    #[test]
    fn deferred_keeps_the_first_failure_for_finish() {
        use omgbase_reconcile::Minter as _;
        let stuck = |prefix: &str| format!("{prefix}_stuck");
        let mut store = Store::open_in_memory_with_minter(Box::new(stuck)).unwrap();
        let mut mint = store.minter();
        let mut deferred = mint.deferred("b");
        assert_eq!(deferred.mint(), "b_stuck");
        assert_eq!(deferred.mint(), "", "the failure is deferred");
        assert_eq!(deferred.mint(), "", "and nothing more is drawn");
        assert!(deferred.finish().is_err());
        let mut ok = store.minter();
        let mut deferred = ok.deferred("d");
        assert_eq!(deferred.mint(), "d_stuck");
        assert!(deferred.finish().is_ok());
    }
}
