//! Uniqueness at mint (`spec/store/README.md` §2.1, store 13.5): every id
//! the store hands out goes through [`Mint`], which draws candidates from the
//! inner [`IdMinter`] and redraws while a candidate is **in use** — already
//! issued by this store in this process, or claimed per the store's
//! [`IdentityClaims`] oracle (since 17.0 the `id_claims` table for every
//! core-minted prefix, the prefix's own table for the recorder's `s` —
//! `core::claims`). The claim itself is the writer's, written through
//! [`Mint::claim`] in the row's transaction AFTER the mint, so a mint whose
//! transaction rolls back leaves no claim and the fixture minter's sequence
//! is untouched. 32⁷ candidates make a random collision certain by a few hundred
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
    /// The §2.1 oracle (`core::capabilities::IdentityClaims`): the
    /// `id_claims` table (17.0).
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

    /// The §2.1 oracle itself (the prune and the size line go through it).
    pub(crate) fn claims(&self) -> &dyn IdentityClaims {
        &*self.claims
    }

    /// The minter WITHOUT the oracle — the migration path's (`schema::migrate`):
    /// the reference binds its mint oracle only after `migrate()` returns, so
    /// a migration step's mint (v13's `src`) is checked against the issued
    /// set alone; a pre-17 database has no `id_claims` to probe anyway.
    pub(crate) fn at_unchecked<'a>(&'a mut self, conn: &'a Connection) -> Mint<'a> {
        Mint {
            conn,
            inner: &mut *self.inner,
            claims: &NoClaims,
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

/// The oracle of the migration path ([`IdSource::at_unchecked`]): nothing is
/// claimed, nothing is written.
struct NoClaims;

impl IdentityClaims for NoClaims {
    fn claim(&self, _: &Connection, _: &str, _: &str, _: Option<&str>, _: &str) -> Result<()> {
        Ok(())
    }
    fn hold(&self, _: &Connection, _: &[&str]) -> Result<()> {
        Ok(())
    }
    fn is_claimed(&self, _: &Connection, _: &str, _: &str) -> Result<bool> {
        Ok(false)
    }
    fn prune(
        &self,
        _: &Connection,
        _: &str,
        _: &[crate::core::claims::ClaimScope],
    ) -> Result<usize> {
        Ok(0)
    }
    fn count(&self, _: &Connection) -> Result<u64> {
        Ok(0)
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
            // The claim (`IdentityClaims::claim`, §2.1) is the writer's, not
            // this function's: a mint has no row and may never get one.
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

    /// §2.1 (17.0): the writer's claim of an id this minter issued — written
    /// over the minter's connection (the commit transaction) AFTER the mint,
    /// with the row that carries the id; `repo_id` `None` for a
    /// workspace-scoped `src`, `minted_at` the commit's `ts` (the clock for
    /// `rp`/`src`). Idempotent.
    pub fn claim(
        &self,
        prefix: &str,
        id: &str,
        repo_id: Option<&str>,
        minted_at: &str,
    ) -> Result<()> {
        self.claims.claim(self.conn, prefix, id, repo_id, minted_at)
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
    use crate::core::claims::{CLAIMED_PREFIXES, ID_TABLES};
    use crate::ids::{RandomMinter, RepeatingMinter, SequentialMinter, is_valid_id};
    use rusqlite::params;

    #[test]
    fn the_core_minted_prefixes_probe_id_claims_and_the_rest_their_tables() {
        for p in CLAIMED_PREFIXES {
            assert!(tables_for(p).is_empty(), "{p} is claimed in id_claims");
        }
        assert!(!tables_for("s").is_empty());
        assert!(tables_for("col").is_empty());
        assert!(tables_for("v").is_empty());
        assert!(tables_for("cp").is_empty(), "cp is retired (D4)");
    }

    #[test]
    fn every_checked_table_and_column_exists() {
        let store = Store::open_in_memory().unwrap();
        for (prefix, _) in ID_TABLES {
            assert!(!id_in_use(store.conn(), prefix, "zz_0000000").unwrap());
        }
        let claims = crate::core::claims::IdClaims;
        for p in CLAIMED_PREFIXES {
            assert!(!claims.is_claimed(store.conn(), p, "zz_0000000").unwrap());
        }
    }

    #[test]
    fn a_claim_row_rejects_the_candidate_and_a_planted_row_alone_does_not() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        // Planted directly with its claim, so the issued set has never seen it.
        store
            .conn()
            .execute(
                "INSERT INTO repos (repo_id, slug, epoch) VALUES ('rp_0', 'planted', 'ep_x')",
                [],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES ('rp_0', 'rp_0', 'rp', 't', 1)",
                [],
            )
            .unwrap();
        assert_eq!(
            store.mint("rp").unwrap(),
            "rp_1",
            "rp_0 is claimed; the redraw is rp_1"
        );
        assert_eq!(store.mint("col").unwrap(), "col_0", "col has no table");
        // A `c` is the core's since 3d: claimed in `id_claims` with the feed
        // row, never probed in `commits` (§2.1).
        let repo = store.create_repo("r").unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES ('c_0', ?1, 'c', 't', 1)",
                params![repo],
            )
            .unwrap();
        assert!(
            !id_in_use(store.conn(), "c", "c_0").unwrap(),
            "no table probe"
        );
        assert_eq!(store.mint("c").unwrap(), "c_1");
        // An `s` is still claimed by its `archives` row.
        store
            .conn()
            .execute(
                "INSERT INTO archives (segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes) VALUES ('s_0', ?1, '/x', 1, 1, 't', 0, 0)",
                params![repo],
            )
            .unwrap();
        assert!(id_in_use(store.conn(), "s", "s_0").unwrap());
        assert_eq!(store.mint("s").unwrap(), "s_1");
    }

    #[test]
    fn a_claimed_block_id_stays_in_use_after_every_row_is_gone() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("r").unwrap();
        // The claims of two ids whose rows no longer exist (a deleted block
        // whose pool row expired, one the recorder alone still holds).
        store
            .conn()
            .execute(
                "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES ('b_0', ?1, 'b', 't', 1), ('b_1', ?1, 'b', 't', 2)",
                params![repo],
            )
            .unwrap();
        assert_eq!(
            store.mint("b").unwrap(),
            "b_2",
            "b_0 and b_1 live on as claims"
        );
    }

    #[test]
    fn a_mint_writes_no_claim_and_the_writers_claim_does() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let id = store.mint("b").unwrap();
        let count = |store: &Store| -> i64 {
            store
                .conn()
                .query_row(
                    "SELECT count(*) FROM id_claims WHERE prefix = 'b'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(count(&store), 0, "the mint alone claims nothing");
        store
            .minter()
            .claim("b", &id, Some("rp_x"), "2026-10-25T00:00:00.000Z")
            .unwrap();
        store
            .minter()
            .claim("b", &id, Some("rp_x"), "2026-10-26T00:00:00.000Z")
            .unwrap();
        assert_eq!(count(&store), 1, "idempotent");
        let row: (Option<String>, String, i64) = store
            .conn()
            .query_row(
                "SELECT repo_id, minted_at, holders FROM id_claims WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                Some("rp_x".to_owned()),
                "2026-10-25T00:00:00.000Z".to_owned(),
                1
            ),
            "the first claim's minted_at stays"
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
