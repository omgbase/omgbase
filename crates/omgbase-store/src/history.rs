//! The change feed (`spec/sync/README.md` §6, the reference's
//! `graph/history.ts` `changesSince`): the repo's commits after a cursor as
//! digests, each with the revisions it wrote. `seq` is a dense per-repo
//! total order, so a cursor is only meaningful against the repo it came from;
//! `head` (the repo's current max `seq`) tells "no new changes" from "cursor
//! beyond this repo's feed".

use omgbase_format::hash::hex;
use rusqlite::{Connection, params};

use crate::error::Result;

/// One revision a commit wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DigestRevision {
    pub doc: String,
    pub path: String,
    /// Hex of the revision's `rendered_hash`.
    pub content_hash: String,
}

/// One commit of the feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitDigest {
    pub commit: String,
    pub seq: i64,
    pub ts: String,
    pub origin: String,
    pub actor: Option<String>,
    /// A human line (the fixtures do not pin it).
    pub summary: String,
    pub revisions: Vec<DigestRevision>,
}

/// A page of the feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangesPage {
    pub digests: Vec<CommitDigest>,
    /// The last digest's `seq`, or the input cursor when the page is empty.
    pub cursor: i64,
    /// More commits follow.
    pub truncated: bool,
    /// The repo's max `seq` (0 when it has no commits).
    pub head: i64,
}

impl ChangesPage {
    /// The page as the MCP surface renders it (`camelCase` as the reference).
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "digests": self.digests.iter().map(CommitDigest::to_json).collect::<Vec<_>>(),
            "cursor": self.cursor,
            "truncated": self.truncated,
            "head": self.head,
        })
    }
}

impl CommitDigest {
    /// The digest as the MCP surface renders it.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "commit": self.commit,
            "seq": self.seq,
            "ts": self.ts,
            "origin": self.origin,
            "actor": self.actor,
            "summary": self.summary,
            "revisions": self.revisions.iter().map(|r| serde_json::json!({
                "doc": r.doc, "path": r.path, "contentHash": r.content_hash,
            })).collect::<Vec<_>>(),
        })
    }
}

/// What a commit that wrote no revision did: a document deletion (observed
/// or api) names the tombstoned paths, a move its `move <from> -> <to>`
/// reason.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SummaryExtra {
    deleted: Vec<String>,
    moved: Option<(String, String)>,
}

/// The reference's `renderSummary`: `<origin>(<actor ?? ?>): <paths> — <n
/// kind>, …` for `api`/`import`, `observed: <paths> — …` otherwise (`same`
/// dispositions omitted). A commit with no revision says `deleted <paths>`
/// or `moved <from> → <to>` instead (`spec/cli` §6 `log`).
fn render_summary(
    origin: &str,
    actor: Option<&str>,
    paths: &[&str],
    dispositions: &[(String, i64)],
    extra: &SummaryExtra,
) -> String {
    let mut paths = paths.join(", ");
    if paths.is_empty() {
        if !extra.deleted.is_empty() {
            paths = format!("deleted {}", extra.deleted.join(", "));
        } else if let Some((from, to)) = &extra.moved {
            paths = format!("moved {from} → {to}");
        }
    }
    let parts: Vec<String> = dispositions
        .iter()
        .filter(|(kind, _)| kind != "same")
        .map(|(kind, n)| format!("{n} {kind}"))
        .collect();
    let detail = if parts.is_empty() {
        String::new()
    } else {
        format!(" — {}", parts.join(", "))
    };
    if origin == "api" || origin == "import" {
        format!("{origin}({}): {paths}{detail}", actor.unwrap_or("?"))
    } else {
        format!("observed: {paths}{detail}")
    }
}

/// `move <from> -> <to>` (a `docs_move` commit's reason) → `(from, to)`.
fn parse_move(reason: &str) -> Option<(String, String)> {
    let rest = reason.strip_prefix("move ")?;
    let (from, to) = rest.split_once(" -> ")?;
    if from.is_empty() || to.is_empty() {
        return None;
    }
    Some((from.to_owned(), to.to_owned()))
}

/// The repo's commits with `seq > cursor` (optionally of one `origin`) in
/// `seq` order, `limit + 1` fetched to set `truncated`; each digest's
/// revisions are the commit's `revisions` rows in row order.
pub fn changes_since(
    conn: &Connection,
    repo_id: &str,
    cursor: i64,
    limit: usize,
    origin: Option<&str>,
) -> Result<ChangesPage> {
    let head: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM commits WHERE repo_id = ?1",
        params![repo_id],
        |r| r.get(0),
    )?;
    let fetch = i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1);
    type Row = (String, i64, String, String, Option<String>, Option<String>);
    let mut commits: Vec<Row> = match origin {
        Some(o) => {
            let mut stmt = conn.prepare(
                "SELECT commit_id, seq, ts, origin, actor, reason FROM commits
                 WHERE repo_id = ?1 AND seq > ?2 AND origin = ?3 ORDER BY seq LIMIT ?4",
            )?;
            let rows = stmt.query_map(params![repo_id, cursor, o, fetch], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT commit_id, seq, ts, origin, actor, reason FROM commits
                 WHERE repo_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![repo_id, cursor, fetch], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    let truncated = commits.len() > limit;
    commits.truncate(limit);

    let mut revs_stmt = conn.prepare(
        "SELECT doc_id, path, rendered_hash FROM revisions WHERE commit_id = ?1 ORDER BY rowid",
    )?;
    let mut disp_stmt =
        conn.prepare("SELECT kind, count(*) FROM dispositions WHERE commit_id = ?1 GROUP BY kind")?;
    // A deletion or a move writes no revision: the tombstone names the commit
    // (`docs.deleted_commit`), a move only its reason (`move <from> -> <to>`).
    let mut deleted_stmt =
        conn.prepare("SELECT path FROM docs WHERE deleted_commit = ?1 ORDER BY path")?;
    let mut digests = Vec::with_capacity(commits.len());
    for (commit_id, seq, ts, origin, actor, reason) in commits {
        let revisions: Vec<DigestRevision> = revs_stmt
            .query_map(params![commit_id], |r| {
                Ok(DigestRevision {
                    doc: r.get(0)?,
                    path: r.get(1)?,
                    content_hash: hex(&r.get::<_, Vec<u8>>(2)?),
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        let dispositions: Vec<(String, i64)> = disp_stmt
            .query_map(params![commit_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        let paths: Vec<&str> = revisions.iter().map(|r| r.path.as_str()).collect();
        let extra = if revisions.is_empty() {
            SummaryExtra {
                deleted: deleted_stmt
                    .query_map(params![commit_id], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<_, _>>()?,
                moved: reason.as_deref().and_then(parse_move),
            }
        } else {
            SummaryExtra::default()
        };
        let summary = render_summary(&origin, actor.as_deref(), &paths, &dispositions, &extra);
        digests.push(CommitDigest {
            commit: commit_id,
            seq,
            ts,
            origin,
            actor,
            summary,
            revisions,
        });
    }
    let next = digests.last().map_or(cursor, |d| d.seq);
    Ok(ChangesPage {
        digests,
        cursor: next,
        truncated,
        head,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BatchItem, SequentialMinter, Store};
    use omgbase_reconcile::Config;

    fn store_with_commits(n: usize) -> (Store, String) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("r").unwrap();
        for i in 0..n {
            let items = [BatchItem::observed("a.md", &format!("# T\n\nv{i}\n"))];
            store
                .observe_batch(
                    &repo,
                    &items,
                    "2026-09-26T10:00:00.000Z",
                    &Config::default(),
                )
                .unwrap();
        }
        (store, repo)
    }

    #[test]
    fn pages_in_seq_order_with_truncation_and_head() {
        let (store, repo) = store_with_commits(3);
        let page = store.changes_since(&repo, 0, 2, None).unwrap();
        assert_eq!(page.digests.len(), 2);
        assert!(page.truncated);
        assert_eq!(page.cursor, 2);
        assert_eq!(page.head, 3);
        assert_eq!(page.digests[0].seq, 1);
        assert_eq!(page.digests[0].commit, "c_0");
        assert_eq!(page.digests[0].origin, "observed");
        assert_eq!(page.digests[0].revisions.len(), 1);
        assert_eq!(page.digests[0].revisions[0].path, "a.md");
        assert_eq!(page.digests[0].revisions[0].doc, "d_0");
        assert_eq!(page.digests[0].revisions[0].content_hash.len(), 64);
        assert!(page.digests[0].summary.starts_with("observed: a.md"));

        let rest = store.changes_since(&repo, page.cursor, 2, None).unwrap();
        assert_eq!(rest.digests.len(), 1);
        assert!(!rest.truncated);
        assert_eq!(rest.cursor, 3);

        let empty = store.changes_since(&repo, 3, 50, None).unwrap();
        assert!(empty.digests.is_empty());
        assert_eq!(empty.cursor, 3, "the input cursor when the page is empty");
        assert_eq!(empty.head, 3);
    }

    #[test]
    fn filters_by_origin() {
        let (store, repo) = store_with_commits(2);
        let api = store.changes_since(&repo, 0, 50, Some("api")).unwrap();
        assert!(api.digests.is_empty());
        assert_eq!(api.cursor, 0);
        assert_eq!(api.head, 2);
        let observed = store.changes_since(&repo, 0, 50, Some("observed")).unwrap();
        assert_eq!(observed.digests.len(), 2);
    }

    #[test]
    fn summary_follows_the_reference_shape() {
        assert_eq!(
            render_summary(
                "api",
                Some("agent"),
                &["a.md"],
                &[("same".into(), 3), ("edited".into(), 1)],
                &SummaryExtra::default(),
            ),
            "api(agent): a.md — 1 edited"
        );
        assert_eq!(
            render_summary(
                "import",
                None,
                &["a.md", "b.md"],
                &[],
                &SummaryExtra::default()
            ),
            "import(?): a.md, b.md"
        );
        assert_eq!(
            render_summary(
                "observed",
                None,
                &[],
                &[("inserted".into(), 2)],
                &SummaryExtra::default()
            ),
            "observed:  — 2 inserted"
        );
        let deleted = SummaryExtra {
            deleted: vec!["a.md".into()],
            moved: None,
        };
        assert_eq!(
            render_summary("observed", None, &[], &[], &deleted),
            "observed: deleted a.md"
        );
        let moved = SummaryExtra {
            deleted: vec![],
            moved: parse_move("move a.md -> b/a.md"),
        };
        assert_eq!(
            render_summary("api", Some("human:spec"), &[], &[], &moved),
            "api(human:spec): moved a.md → b/a.md"
        );
        assert_eq!(parse_move("nope"), None);
        let (store, repo) = store_with_commits(1);
        let page = store.changes_since(&repo, 0, 50, None).unwrap();
        let json = page.to_json();
        assert_eq!(
            json["digests"][0]["revisions"][0]["contentHash"],
            page.digests[0].revisions[0].content_hash
        );
        assert_eq!(json["head"], 1);
    }
}
