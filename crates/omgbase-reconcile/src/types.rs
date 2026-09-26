//! The matcher's types (`spec/reconcile/README.md` §1.2, §2, §6): match
//! blocks, dispositions, the configuration and the result.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use crate::MATCHER_V;

/// A flattened block (§1.2). Old blocks carry their `id`; new blocks do not
/// until assigned. The positional `key` is stable within one tree and lets
/// the phases compare parents and sibling order across the two trees — it is
/// **not** an identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchBlock {
    /// The block's persisted id: present on the old side, `None` on the new.
    pub id: Option<String>,
    /// The block type name — a spec/format §3 kind (`paragraph`, `list`, …).
    pub kind: String,
    /// `sha256(raw)`, lowercase hex (spec/format §4.2).
    pub raw_hash: String,
    /// `sha256(text)`, lowercase hex.
    pub norm_hash: String,
    /// The block's visible text (spec/format §4.1), computed in tree context.
    pub text: String,
    /// Authored `^block-ref` anchors on this block.
    pub anchors: Vec<String>,
    /// The parent's positional key, or `None` at the top level.
    pub parent_key: Option<String>,
    /// Ordinal among its siblings, from 0.
    pub index: usize,
    /// Positional key: `(parent_key ?? "") + "/" + index` (`/0`, `/1/2`).
    pub key: String,
}

impl MatchBlock {
    /// The positional key of the block at `index` under `parent_key`.
    #[must_use]
    pub fn positional_key(parent_key: Option<&str>, index: usize) -> String {
        format!("{}/{index}", parent_key.unwrap_or(""))
    }
}

/// A name that is not one of an enum's spec spellings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownName(pub String);

impl fmt::Display for UnknownName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown name {:?}", self.0)
    }
}

impl std::error::Error for UnknownName {}

macro_rules! spec_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            /// Every value, in spec order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The spec's string form.
            #[must_use]
            pub const fn as_str(&self) -> &'static str {
                match self {
                    $($name::$variant => $s),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = UnknownName;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::ALL
                    .iter()
                    .copied()
                    .find(|v| v.as_str() == s)
                    .ok_or_else(|| UnknownName(s.to_owned()))
            }
        }
    };
}

spec_enum! {
    /// What a disposition records about a block (§2).
    DispositionKind {
        Same => "same",
        Edited => "edited",
        Moved => "moved",
        EditedMoved => "edited_moved",
        Inserted => "inserted",
        Deleted => "deleted",
        SplitFrom => "split_from",
        MergedInto => "merged_into",
        CopiedFrom => "copied_from",
        Resurrected => "resurrected",
        BulkRewrite => "bulk_rewrite",
    }
}

spec_enum! {
    /// Why a decision was made (§2). `Api` is never produced by the matcher:
    /// the reference's mutation kernel stamps it on blocks created through
    /// the API, and a store that persists dispositions needs the spelling.
    Reason {
        ExactHash => "exact_hash",
        NormalizedHash => "normalized_hash",
        Anchor => "anchor",
        ContextUnique => "context_unique",
        ContextChildren => "context_children",
        Scored => "scored",
        Tombstone => "tombstone",
        Api => "api",
    }
}

/// A disposition's `detail` (§2): a JSON object with the reference's key
/// names (§10 "detail key spelling"), `{}` when there is nothing to record.
/// Keys are sorted; fixtures compare with key order ignored.
pub type Detail = BTreeMap<String, DetailValue>;

/// A JSON-like value inside a [`Detail`]. The matcher records strings (ids,
/// keys), integers (child counts), doubles (fractions, scores), lists (keys
/// of a split run, near misses) and objects (one near miss). Kept as a small
/// enum of its own so the core crate needs no serde; the `json` feature
/// converts it to `serde_json::Value`.
#[derive(Clone, Debug, PartialEq)]
pub enum DetailValue {
    Str(String),
    Int(i64),
    Num(f64),
    List(Vec<DetailValue>),
    Map(Detail),
}

impl From<&str> for DetailValue {
    fn from(s: &str) -> Self {
        DetailValue::Str(s.to_owned())
    }
}

impl From<String> for DetailValue {
    fn from(s: String) -> Self {
        DetailValue::Str(s)
    }
}

impl From<i64> for DetailValue {
    fn from(n: i64) -> Self {
        DetailValue::Int(n)
    }
}

impl From<f64> for DetailValue {
    fn from(n: f64) -> Self {
        DetailValue::Num(n)
    }
}

impl From<Vec<DetailValue>> for DetailValue {
    fn from(list: Vec<DetailValue>) -> Self {
        DetailValue::List(list)
    }
}

impl From<Detail> for DetailValue {
    fn from(map: Detail) -> Self {
        DetailValue::Map(map)
    }
}

/// Build a [`Detail`] from `(key, value)` pairs.
pub fn detail<V: Into<DetailValue>, const N: usize>(entries: [(&str, V); N]) -> Detail {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.into()))
        .collect()
}

/// One decision (§2). `block_id` is the old id (carries, deletions, merges),
/// the pool id (resurrections), the minted id (mints) or `"DOC"` for the
/// document-scoped bulk rewrite.
#[derive(Clone, Debug, PartialEq)]
pub struct Disposition {
    pub block_id: String,
    pub kind: DispositionKind,
    /// A number in (0, 1], or `None` when the decision is not a carry.
    pub confidence: Option<f64>,
    pub reason: Option<Reason>,
    /// The matcher version ([`Config::matcher_v`]).
    pub matcher_v: String,
    pub detail: Detail,
}

/// The thresholds and weights (§6), named as the fixtures spell them. The
/// reference's `ReconcileConfig` uses the camelCase spellings.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Stamped on every disposition (`"m" + VERSION`).
    pub matcher_v: String,
    /// Phase 5 acceptance.
    pub theta_accept: f64,
    /// Phase 5 acceptance when the new block has fewer than
    /// `small_block_tokens` tokens.
    pub theta_small: f64,
    /// The tiny-block boundary.
    pub small_block_tokens: usize,
    /// Phase 4a `text_sim` floor.
    pub context_sim_floor: f64,
    /// Phase 4b: fraction of an old container's children that must have
    /// carried into one new container.
    pub children_vouch_frac: f64,
    /// Phase 6a split/merge coverage.
    pub split_coverage: f64,
    /// Phase 6a dominant-fragment inheritance; `1.01` disables it.
    pub split_dominant_share: f64,
    /// Phase 6a copy detection.
    pub copy_sim: f64,
    /// Bulk-rewrite trigger (strictly exceeded).
    pub bulk_unmatched_frac: f64,
    /// Bulk-rewrite minimum document size.
    pub bulk_min_blocks: usize,
    /// Phase 5 skips when the unmatched total exceeds twice this.
    pub max_scored_blocks: usize,
    /// Cross-document acceptance (§7).
    pub theta_xdoc: f64,
}

impl Default for Config {
    /// The §6 defaults.
    fn default() -> Self {
        Self {
            matcher_v: MATCHER_V.to_owned(),
            theta_accept: 0.62,
            theta_small: 0.62,
            small_block_tokens: 8,
            context_sim_floor: 0.35,
            children_vouch_frac: 0.5,
            split_coverage: 0.8,
            split_dominant_share: 0.7,
            copy_sim: 0.95,
            bulk_unmatched_frac: 0.45,
            bulk_min_blocks: 100,
            max_scored_blocks: 2000,
            theta_xdoc: 0.8,
        }
    }
}

/// A resurrection-pool entry (§5 phase 6b): a block deleted in an earlier
/// checkpoint, matched by hash only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolEntry {
    pub id: String,
    /// The block type name.
    pub kind: String,
    /// Lowercase hex.
    pub raw_hash: String,
    /// Lowercase hex.
    pub norm_hash: String,
}

/// The result of reconciling one document (§2).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ReconcileResult {
    /// New key → id: a carried old id, a resurrected pool id or a freshly
    /// minted id. Every new key is assigned exactly once.
    pub assignment: BTreeMap<String, String>,
    /// One per decision.
    pub dispositions: Vec<Disposition>,
    /// Every old id whose disposition kind is `deleted` — phase 7 tombstones
    /// and phase 6a non-dominant split tombstones — in old document order.
    pub deleted: Vec<String>,
    /// The pool ids consumed by phase 6b, in the order consumed.
    pub consumed_pool: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_names_round_trip() {
        for k in DispositionKind::ALL {
            assert_eq!(k.as_str().parse::<DispositionKind>(), Ok(*k));
            assert_eq!(k.to_string(), k.as_str());
        }
        for r in Reason::ALL {
            assert_eq!(r.as_str().parse::<Reason>(), Ok(*r));
        }
        assert_eq!(
            "renamed".parse::<DispositionKind>(),
            Err(UnknownName("renamed".to_owned()))
        );
        assert_eq!(DispositionKind::ALL.len(), 11);
    }

    #[test]
    fn positional_keys() {
        assert_eq!(MatchBlock::positional_key(None, 0), "/0");
        assert_eq!(MatchBlock::positional_key(Some("/1/2"), 0), "/1/2/0");
    }

    #[test]
    fn detail_builder() {
        let d = detail([("a", DetailValue::Int(1)), ("b", "x".into())]);
        assert_eq!(d.len(), 2);
        assert_eq!(d["b"], DetailValue::Str("x".to_owned()));
        assert_eq!(Detail::new(), detail::<DetailValue, 0>([]));
    }
}
