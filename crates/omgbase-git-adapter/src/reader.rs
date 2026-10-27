//! The read half over the bare repository (`spec/surface` §3 "The git
//! provider", 6.4; modular-core Phase 6a). A VERSION of a document is a
//! commit whose trailers name it (`omgbase-doc: <doc_id> <path> <head>`),
//! found with `git log --grep` on that fixed string, and rendered under the
//! native shape so the wire is one shape: `_rev` the head token the trailer
//! recorded, `_seq` the feed seq of the trailer, `_commit` the GIT SHA (what
//! `docs_read { at }` takes back), `_ts` the `omgbase-ts` trailer,
//! `_origin`/`_actor` the trailers, `_hash` the sha256 of the blob's bytes
//! (never git's sha1), `_archived` false, `retained` true; the current head is
//! listed unretained (resolution 11) while no commit names it — the worker
//! has not run since. Tokens of the provider's own form — a 40-hex sha — are
//! decided HERE (`spec/surface` §3's table for `provider: git`): an object git
//! does not have → `pruned`; a commit whose `omgbase-ts` falls outside the
//! coverage → `outside_coverage`; a commit not naming the document →
//! `target_missing`; a head token the commits do not name → `None`, and the
//! core's claim-based table settles it; anything else → `None` too (an unknown
//! token is nobody's). Block lineage does not exist here: `blocks_history` and
//! `docs_diff` are `unsupported`.

use omgbase_format::hash::{hex, sha256};
use omgbase_store::diff::unified_diff;
use omgbase_store::{
    BlockChange, DiffEntry, DocVersion, Error, HistoryReader, Result, RevisionQueryRow,
    RevisionRead, in_coverage, read_capability,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::config::{GIT_PROVIDER, GitHistoryConfig};
use crate::git::{GitRepo, is_sha};
use crate::trailers::{CommitTrailers, DocTrailer, parse_message, subject_of};
use crate::worker::tip_position;

/// One commit naming one document.
#[derive(Clone, Debug)]
struct GitVersion {
    sha: String,
    trailers: CommitTrailers,
    doc: DocTrailer,
    subject: String,
    /// The blob's sha256, hex.
    hash: String,
}

/// The provider's [`HistoryReader`] over one repository's bare repository.
pub struct GitHistoryReader {
    repo_id: String,
    git: GitRepo,
    config: GitHistoryConfig,
}

impl GitHistoryReader {
    #[must_use]
    pub fn new(repo_id: &str, git: GitRepo, config: GitHistoryConfig) -> Self {
        Self {
            repo_id: repo_id.to_owned(),
            git,
            config,
        }
    }

    /// The versions in `records` (every commit, or those naming `doc_id`),
    /// without their hashes.
    fn parse(
        &self,
        records: &[crate::git::LogRecord],
        doc_id: Option<&str>,
    ) -> Vec<(String, CommitTrailers, DocTrailer, String)> {
        let mut out = Vec::new();
        for r in records {
            let Some(t) = parse_message(&r.message) else {
                continue;
            };
            for d in &t.docs {
                if doc_id.is_some_and(|id| id != d.doc_id) {
                    continue;
                }
                // A deletion mints no version.
                if d.head.is_none() {
                    continue;
                }
                out.push((
                    r.sha.clone(),
                    t.clone(),
                    d.clone(),
                    subject_of(&r.message).to_owned(),
                ));
            }
        }
        out
    }

    /// Every version with the blob's sha256 (versions whose path is not in the
    /// commit's tree — superseded within a pending span — are dropped).
    fn with_hashes(
        &self,
        versions: Vec<(String, CommitTrailers, DocTrailer, String)>,
    ) -> Result<Vec<GitVersion>> {
        let specs: Vec<String> = versions
            .iter()
            .map(|(sha, _, d, _)| format!("{sha}:{}", d.path))
            .collect();
        let blobs = self.git.blobs_at(&specs)?;
        Ok(versions
            .into_iter()
            .zip(blobs)
            .filter_map(|((sha, trailers, doc, subject), blob)| {
                blob.map(|b| GitVersion {
                    sha,
                    trailers,
                    doc,
                    subject,
                    hash: hex(&sha256(&b)),
                })
            })
            .collect())
    }

    /// Every version of one document, oldest first.
    fn versions_of(&self, doc_id: &str) -> Result<Vec<GitVersion>> {
        if !self.git.exists() {
            return Ok(Vec::new());
        }
        let records = self.git.log(
            &self.config.branch,
            Some(&format!("omgbase-doc: {doc_id} ")),
            None,
        )?;
        self.with_hashes(self.parse(&records, Some(doc_id)))
    }

    fn to_version(v: &GitVersion, head: Option<&str>) -> DocVersion {
        DocVersion {
            rev: v.doc.head.clone().unwrap_or_default(),
            seq: Some(v.trailers.to),
            commit: Some(v.sha.clone()),
            ts: v.trailers.ts.clone(),
            origin: v.trailers.origin.clone(),
            actor: v.trailers.actor.clone(),
            hash: v.hash.clone(),
            is_current: v.doc.head.as_deref() == head,
            archived: false,
            retained: true,
        }
    }

    fn to_row(v: &GitVersion, head: Option<&str>) -> RevisionQueryRow {
        RevisionQueryRow {
            rev_id: v.doc.head.clone().unwrap_or_default(),
            doc_id: v.doc.doc_id.clone(),
            seq: v.trailers.to,
            rendered_hash: omgbase_store::from_hex(&v.hash).unwrap_or_default(),
            path: v.doc.path.clone(),
            commit_id: v.sha.clone(),
            ts: v.trailers.ts.clone(),
            origin: v
                .trailers
                .origin
                .clone()
                .unwrap_or_else(|| "observed".to_owned()),
            actor: v.trailers.actor.clone(),
            reason: Some(v.subject.clone()),
            is_current: v.doc.head.as_deref() == head,
            archived: false,
        }
    }

    fn head_of(conn: &Connection, doc_id: &str) -> Result<Option<String>> {
        Ok(conn
            .query_row(
                "SELECT head FROM docs WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// The bytes of `doc_id` at `rev` (`(path, bytes)`), or `None` when `rev`
    /// is a head token (or an unknown form) the commits do not name; the
    /// table's answer for a sha is the error.
    fn bytes_at(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev: &str,
        fix: Option<String>,
    ) -> Result<Option<(String, Vec<u8>)>> {
        if is_sha(rev) {
            let pruned = || Error::HistoryPruned {
                rev: rev.to_owned(),
                fix: fix.clone(),
            };
            let target_missing = || Error::TargetMissingRevision {
                rev: rev.to_owned(),
                doc: Some(doc_id.to_owned()),
            };
            if !self.git.exists() {
                return Err(pruned());
            }
            let Some(kind) = self.git.object_type(rev)? else {
                return Err(pruned());
            };
            if kind != "commit" {
                return Err(target_missing());
            }
            let Some(t) = parse_message(&self.git.message(rev)?) else {
                return Err(target_missing());
            };
            let coverage = read_capability(conn, &self.repo_id, "history")?
                .map(|r| r.coverage)
                .unwrap_or_default();
            if !coverage.is_empty() && !in_coverage(&coverage, &t.ts) {
                return Err(Error::HistoryOutsideCoverage {
                    rev: rev.to_owned(),
                    coverage_from: coverage[0].from.clone(),
                    fix,
                });
            }
            let Some(d) = t
                .docs
                .iter()
                .find(|d| d.doc_id == doc_id && d.head.is_some())
            else {
                return Err(target_missing());
            };
            let bytes = self
                .git
                .blobs_at(&[format!("{rev}:{}", d.path)])?
                .into_iter()
                .next()
                .flatten();
            return match bytes {
                Some(b) => Ok(Some((d.path.clone(), b))),
                None => Err(pruned()),
            };
        }
        if rev.starts_with("r_") {
            let versions = self.versions_of(doc_id)?;
            let Some(v) = versions.iter().find(|v| v.doc.head.as_deref() == Some(rev)) else {
                return Ok(None);
            };
            let bytes = self
                .git
                .blobs_at(&[format!("{}:{}", v.sha, v.doc.path)])?
                .into_iter()
                .next()
                .flatten();
            return Ok(bytes.map(|b| (v.doc.path.clone(), b)));
        }
        Ok(None)
    }
}

impl HistoryReader for GitHistoryReader {
    fn read_at_revision(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> Result<Option<RevisionRead>> {
        let fix = format!("docs_read {}", json!({ "_id": doc_id }));
        let Some((path, bytes)) = self.bytes_at(conn, doc_id, rev_id, Some(fix))? else {
            return Ok(None);
        };
        Ok(Some(RevisionRead {
            path,
            content: String::from_utf8_lossy(&bytes).into_owned(),
            rendered_hash_match: true,
        }))
    }

    fn blocks_history(
        &self,
        _conn: &Connection,
        _block_id: &str,
        _limit: Option<i64>,
    ) -> Result<Vec<BlockChange>> {
        Err(Error::HistoryUnsupported {
            provider: GIT_PROVIDER.to_owned(),
            tool: "blocks_history".to_owned(),
            fix: "docs_history".to_owned(),
        })
    }

    fn diff_blocks(
        &self,
        _conn: &Connection,
        _doc_id: &str,
        _from_rev: &str,
        _to_rev: &str,
    ) -> Result<Vec<DiffEntry>> {
        Err(Error::HistoryUnsupported {
            provider: GIT_PROVIDER.to_owned(),
            tool: "docs_diff".to_owned(),
            fix: "docs_diff_unified".to_owned(),
        })
    }

    fn diff_unified(
        &self,
        conn: &Connection,
        doc_id: &str,
        from_rev: &str,
        to_rev: &str,
    ) -> Result<String> {
        let text = |rev: &str| -> Result<String> {
            match self.bytes_at(conn, doc_id, rev, None)? {
                Some((_, bytes)) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
                None => Err(Error::TargetMissingRevision {
                    rev: rev.to_owned(),
                    doc: Some(doc_id.to_owned()),
                }),
            }
        };
        Ok(unified_diff(&text(from_rev)?, &text(to_rev)?))
    }

    /// The two latest commits naming the document, newest first.
    fn latest_revisions(&self, _conn: &Connection, doc_id: &str) -> Result<Vec<String>> {
        let versions = self.versions_of(doc_id)?;
        Ok(versions
            .iter()
            .rev()
            .take(2)
            .map(|v| v.sha.clone())
            .collect())
    }

    fn doc_versions(
        &self,
        _conn: &Connection,
        doc_id: &str,
        head: Option<&str>,
    ) -> Result<Vec<DocVersion>> {
        Ok(self
            .versions_of(doc_id)?
            .iter()
            .map(|v| Self::to_version(v, head))
            .collect())
    }

    fn disposition_counts(
        &self,
        _conn: &Connection,
        _commit_id: &str,
    ) -> Result<Option<Vec<(String, i64)>>> {
        Ok(None)
    }

    fn revision_rows(&self, conn: &Connection, repo_id: &str) -> Result<Vec<RevisionQueryRow>> {
        if !self.git.exists() {
            return Ok(Vec::new());
        }
        let heads: std::collections::HashMap<String, Option<String>> = {
            let mut stmt = conn.prepare("SELECT doc_id, head FROM docs WHERE repo_id = ?1")?;
            let rows = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let records = self.git.log(&self.config.branch, None, None)?;
        let parsed = self
            .parse(&records, None)
            .into_iter()
            .filter(|(_, _, d, _)| heads.contains_key(&d.doc_id))
            .collect();
        let mut rows: Vec<RevisionQueryRow> = self
            .with_hashes(parsed)?
            .iter()
            .map(|v| Self::to_row(v, heads.get(&v.doc.doc_id).and_then(|h| h.as_deref())))
            .collect();
        rows.sort_by(|a, b| {
            a.path
                .as_bytes()
                .cmp(b.path.as_bytes())
                .then_with(|| a.rev_id.as_bytes().cmp(b.rev_id.as_bytes()))
        });
        Ok(rows)
    }

    fn doc_revision_rows(&self, conn: &Connection, doc_id: &str) -> Result<Vec<RevisionQueryRow>> {
        let head = Self::head_of(conn, doc_id)?;
        Ok(self
            .versions_of(doc_id)?
            .iter()
            .map(|v| Self::to_row(v, head.as_deref()))
            .collect())
    }

    fn has_revision(&self, _conn: &Connection, rev_id: &str) -> Result<bool> {
        if !self.git.exists() {
            return Ok(false);
        }
        if is_sha(rev_id) {
            return Ok(self.git.object_type(rev_id)?.as_deref() == Some("commit")
                && parse_message(&self.git.message(rev_id)?).is_some());
        }
        let head_token = rev_id.starts_with("r_")
            && rev_id[2..]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && rev_id.len() > 2;
        if head_token {
            return Ok(!self
                .git
                .log(
                    &self.config.branch,
                    None,
                    Some(&format!("^omgbase-doc: .* {rev_id}$")),
                )?
                .is_empty());
        }
        Ok(false)
    }

    fn uncaptured_heads(&self, conn: &Connection, repo_id: &str, since: &str) -> Result<i64> {
        let position = if self.git.exists() {
            tip_position(&self.git, &self.config.branch)?
        } else {
            None
        };
        match position {
            None => Ok(conn.query_row(
                "SELECT count(*) FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND head IS NOT NULL AND updated_at >= ?2",
                params![repo_id, since],
                |r| r.get(0),
            )?),
            Some(p) => Ok(conn.query_row(
                "SELECT count(*) FROM docs d WHERE d.repo_id = ?1 AND d.deleted_at IS NULL AND d.head IS NOT NULL AND d.updated_at >= ?2 AND EXISTS (SELECT 1 FROM feed_entries e WHERE e.repo_id = d.repo_id AND e.head = d.head AND e.seq > ?3)",
                params![repo_id, since, p.seq],
                |r| r.get(0),
            )?),
        }
    }
}
