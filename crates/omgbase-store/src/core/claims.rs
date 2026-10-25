//! Identity claims (`spec/store` §2.1 "Uniqueness at mint", 17.0 —
//! modular-core M3/D5): the core's default [`IdentityClaims`] over the
//! `id_claims(id, repo_id, prefix, minted_at, holders)` table. One row per id
//! the core has minted, written in the transaction that writes the row the id
//! lands in (§5.4: `d` with the doc row, `r` with the head, `b` with the block
//! rows, `x`/`e` with the graph rows, `rp`/`src` with the registry rows) —
//! AFTER the minter yielded, so the fixture minter's ids never move. The
//! probe is one statement over the table; a claim outlives every row that
//! carried the id, which is what replaced the `blocks ∪ block_changes ∪
//! resurrection_pool` union of 13.5–16.x and the squash's
//! earliest-`block_changes`-row rule.
//!
//! `holders` is a bitmask: bit 0 the CORE (set at mint, released by the
//! claims prune, §7.3), bit 1 the RECORDER (set when the capture first names
//! the id — a `revisions`/`block_changes` row; `history purge` releases it,
//! Phase 3e). A row leaves only when no holder remains, so with history on a
//! pruned id can never be re-minted; with history off it can, once nothing
//! names it and the installation's `identity.claims_retain_days` has passed —
//! the documented consequence (D5): a reused id can only misdirect an
//! unguarded read by name.
//!
//! Port of `packages/core/src/core/capabilities/claims.ts`.

use rusqlite::{Connection, params};
use serde_json::{Map, Value as Json};

use crate::core::capabilities::IdentityClaims;
use crate::core::time::plus_ms;
use crate::error::{Error, Result};

/// bit 0: the core's hold on a claim.
pub const HOLDER_CORE: i64 = 1;
/// bit 1: the recorder's hold on a claim.
pub const HOLDER_RECORDER: i64 = 2;

/// The prefixes the core mints and claims in `id_claims` (§2.1).
pub const CLAIMED_PREFIXES: &[&str] = &["d", "b", "r", "x", "e", "rp", "src"];

/// §2.1: the prefixes whose claim is still the row the id lands in — `c` is
/// minted by the recorder's `new_commit` and `s` by its export (their
/// `commits`/`archives` rows are the recorder's own claim evidence); `cp`
/// probes `checkpoints` until D4 retires the prefix (Phase 3e). `col` and `v`
/// have no table and no check.
pub(crate) const ID_TABLES: &[(&str, &[(&str, &str)])] = &[
    ("c", &[("commits", "commit_id")]),
    ("cp", &[("checkpoints", "id")]),
    ("s", &[("archives", "segment_id")]),
];

/// The settings key of the claims prune (§7.3): `identity.claims_retain_days`,
/// default null = never.
pub const CLAIMS_RETAIN_SETTINGS_KEY: &str = "identity";
pub const CLAIMS_RETAIN_DAYS_KEY: &str = "claims_retain_days";

const DAY_MS: i64 = 86_400_000;

/// The tables an id with `prefix` is still probed in by table (`c`, `cp`,
/// `s`); empty for every prefix claimed in `id_claims` and for `col`/`v`.
#[must_use]
pub fn tables_for(prefix: &str) -> &'static [(&'static str, &'static str)] {
    ID_TABLES
        .iter()
        .find(|(p, _)| *p == prefix)
        .map_or(&[], |(_, tables)| tables)
}

/// §2.1: does `id` name a row of the prefix's own table(s) ([`tables_for`])
/// on `conn`? The legacy probe, for `c`/`cp`/`s` alone since 17.0. The
/// statements are cached on the connection.
pub fn id_in_use(conn: &Connection, prefix: &str, id: &str) -> Result<bool> {
    for (table, column) in tables_for(prefix) {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT 1 FROM {table} WHERE {column} = ?1 LIMIT 1"
        ))?;
        if stmt.exists(params![id])? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `identity.claims_retain_days` out of a settings blob: `None` when unset
/// (never prune); a non-negative integer otherwise. Anything else is a
/// malformed policy and refused — a prune that silently did nothing would be
/// worse than one that complains.
pub fn claims_retain_days(settings: &Map<String, Json>) -> Result<Option<i64>> {
    let v = settings
        .get(CLAIMS_RETAIN_SETTINGS_KEY)
        .and_then(Json::as_object)
        .and_then(|identity| identity.get(CLAIMS_RETAIN_DAYS_KEY));
    let Some(v) = v else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    let n = v
        .as_f64()
        .filter(|f| f.is_finite() && f.fract() == 0.0 && *f >= 0.0)
        .ok_or_else(|| {
            Error::Other(format!(
                "identity.claims_retain_days must be a non-negative integer or null (got {v})"
            ))
        })?;
    #[allow(clippy::cast_possible_truncation)]
    Ok(Some(n as i64))
}

/// One settings layer the prune judges claims under (§7.3): a repository's
/// effective settings (`repo_id` set) or the workspace's own (`None` — the
/// scope of a workspace-scoped `src` claim).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaimScope {
    pub repo_id: Option<String>,
    pub settings: Map<String, Json>,
}

// The core rows an id may still name (§7.3): a claim is prunable only when
// none of them does. `docs` keeps a tombstone forever, so a `d` is never
// released; a `b` once its row, its pool entry and its tombstone are gone; an
// `r` once it is no head and no pending row renders it; `x`/`e` once the node
// or edge row is gone; `rp`/`src` while the registry rows exist.
const NAMES_NO_CORE_ROW_SQL: &str = "
  NOT EXISTS (SELECT 1 FROM docs WHERE doc_id = id_claims.id OR head = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM blocks WHERE block_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM resurrection_pool WHERE block_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM pending_materializations WHERE head = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM external_nodes WHERE node_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM edges WHERE edge_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM sources WHERE source_id = id_claims.id)";

/// The recorder's hold (bit 1) on every id named — an id with no claim row
/// is left alone. The recorder calls this from its capture
/// (`record_revision`: the head and the document; `record_dispositions`:
/// every persisted block id); [`IdClaims::hold`] is the same statement.
pub fn hold(conn: &Connection, ids: &[&str]) -> Result<()> {
    let mut stmt = conn.prepare_cached(&format!(
        "UPDATE id_claims SET holders = holders | {HOLDER_RECORDER} WHERE id = ?1 AND (holders & {HOLDER_RECORDER}) = 0"
    ))?;
    for id in ids {
        stmt.execute(params![id])?;
    }
    Ok(())
}

/// The [`IdentityClaims`] over `id_claims` (§2.1, 17.0): `claim` inserts the
/// core's row (idempotent — a second claim of the same id adds nothing but
/// the core bit), `hold` sets the recorder's bit, `is_claimed` is one probe
/// for every core-minted prefix and the legacy table probe for the
/// recorder's own (`c`, `s`) and `cp`, `prune` is §7.3's release under
/// `identity.claims_retain_days`.
#[derive(Clone, Copy, Debug, Default)]
pub struct IdClaims;

impl IdentityClaims for IdClaims {
    fn claim(
        &self,
        conn: &Connection,
        prefix: &str,
        id: &str,
        repo_id: Option<&str>,
        minted_at: &str,
    ) -> Result<()> {
        let mut stmt = conn.prepare_cached(&format!(
            "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES (?1, ?2, ?3, ?4, {HOLDER_CORE})
             ON CONFLICT(id) DO UPDATE SET holders = holders | {HOLDER_CORE}"
        ))?;
        stmt.execute(params![id, repo_id, prefix, minted_at])?;
        Ok(())
    }

    fn hold(&self, conn: &Connection, ids: &[&str]) -> Result<()> {
        hold(conn, ids)
    }

    fn is_claimed(&self, conn: &Connection, prefix: &str, id: &str) -> Result<bool> {
        if CLAIMED_PREFIXES.contains(&prefix) {
            let mut stmt = conn.prepare_cached("SELECT 1 FROM id_claims WHERE id = ?1 LIMIT 1")?;
            return Ok(stmt.exists(params![id])?);
        }
        id_in_use(conn, prefix, id)
    }

    /// The claims prune (§7.3): for every scope whose effective
    /// `identity.claims_retain_days` is set, release the core's hold on each
    /// of its claims minted before `now − days` that names no core row; then
    /// delete every claim with no holder left. A workspace-scoped claim
    /// (`repo_id` NULL — a `src`) is judged by the workspace layer alone.
    /// Returns the number of holds released. Runs in the caller's
    /// transaction (`Store::gc_at`).
    fn prune(&self, conn: &Connection, now: &str, scopes: &[ClaimScope]) -> Result<usize> {
        let mut release = conn.prepare(&format!(
            "UPDATE id_claims SET holders = holders & ~{HOLDER_CORE}
             WHERE repo_id IS ?1 AND (holders & {HOLDER_CORE}) != 0 AND minted_at < ?2 AND {NAMES_NO_CORE_ROW_SQL}"
        ))?;
        let mut released = 0usize;
        for scope in scopes {
            let Some(days) = claims_retain_days(&scope.settings)? else {
                continue;
            };
            let cutoff = plus_ms(now, -(days.saturating_mul(DAY_MS)))?;
            released += release.execute(params![scope.repo_id, cutoff])?;
        }
        if released > 0 {
            conn.execute("DELETE FROM id_claims WHERE holders = 0", [])?;
        }
        Ok(released)
    }

    /// `count(*)` of `id_claims` — the size report's line (§7.2).
    fn count(&self, conn: &Connection) -> Result<u64> {
        let n: i64 = conn.query_row("SELECT count(*) FROM id_claims", [], |r| r.get(0))?;
        Ok(u64::try_from(n).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(v: Json) -> Map<String, Json> {
        match v {
            Json::Object(m) => m,
            _ => unreachable!(),
        }
    }

    #[test]
    fn retain_days_is_null_unset_or_a_non_negative_integer() {
        assert_eq!(claims_retain_days(&Map::new()).unwrap(), None);
        assert_eq!(
            claims_retain_days(&settings(json!({ "identity": {} }))).unwrap(),
            None
        );
        assert_eq!(
            claims_retain_days(&settings(
                json!({ "identity": { "claims_retain_days": null } })
            ))
            .unwrap(),
            None
        );
        assert_eq!(
            claims_retain_days(&settings(
                json!({ "identity": { "claims_retain_days": 0 } })
            ))
            .unwrap(),
            Some(0)
        );
        assert_eq!(
            claims_retain_days(&settings(
                json!({ "identity": { "claims_retain_days": 30 } })
            ))
            .unwrap(),
            Some(30)
        );
        for bad in [json!(-1), json!(1.5), json!("30"), json!(true), json!([30])] {
            let err = claims_retain_days(&settings(
                json!({ "identity": { "claims_retain_days": bad } }),
            ))
            .unwrap_err();
            assert!(
                err.to_string()
                    .contains("identity.claims_retain_days must be a non-negative integer or null"),
                "{err}"
            );
        }
        // `identity` that is not an object reads as unset (the reference's rule).
        assert_eq!(
            claims_retain_days(&settings(json!({ "identity": 7 }))).unwrap(),
            None
        );
    }

    #[test]
    fn the_legacy_table_probe_covers_the_recorders_prefixes_and_cp_only() {
        for p in ["c", "cp", "s"] {
            assert!(!tables_for(p).is_empty(), "{p}");
        }
        for p in CLAIMED_PREFIXES.iter().chain(["col", "v"].iter()) {
            assert!(tables_for(p).is_empty(), "{p}");
        }
    }
}
