//! The commit message of a git history commit (`spec/store` §5.12 "Trailers"):
//! a SUBJECT line, a blank line, then the trailers — `token: value` lines the
//! reader parses back (never through `git interpret-trailers`: both engines
//! parse the same text the same way). The trailers carry what replay and the
//! reader need: the feed position (`omgbase-seq`), the exact instant
//! (`omgbase-ts`), the feed row(s) folded (`omgbase-commit`), the provenance
//! (`omgbase-origin`, `omgbase-actor`, `omgbase-plan`), one `omgbase-doc` per
//! touched document (`<doc_id> <path> <head>`, a deleted document's head `-`)
//! and, on a rescan, `omgbase-rescan: <epoch>:<head>`. Since 17.6 (Phase 6b)
//! a merge commit carries `omgbase-merge: <remote tip>` and a commit of the
//! ids ref `omgbase-content: <content commit sha>` (the content commit it
//! records the identities of).

/// One touched document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocTrailer {
    pub doc_id: String,
    /// The storage path (no leading slash) as of the commit.
    pub path: String,
    /// The head token minted, or `None` for a deleted document (`-` on the wire).
    pub head: Option<String>,
}

/// The trailers of one commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitTrailers {
    pub epoch: String,
    /// The feed seq this commit covers — `from == to` for a single row.
    pub from: i64,
    pub to: i64,
    pub ts: String,
    pub commits: Vec<String>,
    pub origin: Option<String>,
    pub actor: Option<String>,
    pub plan: Option<String>,
    pub docs: Vec<DocTrailer>,
    /// `omgbase-rescan: <epoch>:<head>` — the commit is a full snapshot.
    pub rescan: Option<(String, i64)>,
    /// `omgbase-merge: <remote tip>` (17.6) — the commit merged the remote's tip.
    pub merge: Option<String>,
    /// `omgbase-content: <sha>` (17.6) — on the ids ref: the content commit
    /// this ids commit belongs to.
    pub content: Option<String>,
}

/// Every trailer token begins with it.
pub const TRAILER_PREFIX: &str = "omgbase-";

/// `<epoch>:<seq>` or `<epoch>:<from>-<to>`.
#[must_use]
pub fn seq_value(epoch: &str, from: i64, to: i64) -> String {
    if from == to {
        format!("{epoch}:{from}")
    } else {
        format!("{epoch}:{from}-{to}")
    }
}

/// `^(\S+):(\d+)(?:-(\d+))?$` over the trimmed value.
fn parse_seq(v: &str) -> Option<(String, i64, i64)> {
    let v = v.trim();
    let (epoch, rest) = v.rsplit_once(':')?;
    if epoch.is_empty() || epoch.chars().any(char::is_whitespace) {
        return None;
    }
    let digits = |s: &str| -> Option<i64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<i64>().ok())
            .flatten()
    };
    match rest.split_once('-') {
        Some((a, b)) => {
            let from = digits(a)?;
            Some((epoch.to_owned(), from, digits(b)?))
        }
        None => {
            let from = digits(rest)?;
            Some((epoch.to_owned(), from, from))
        }
    }
}

/// A subject never holds a newline: every whitespace run containing one
/// becomes a single space (the reference's `replace(/\s*\n\s*/g, " ").trim()`).
fn flatten_subject(subject: &str) -> String {
    let mut out = String::with_capacity(subject.len());
    let mut run = String::new();
    for c in subject.chars() {
        if c.is_whitespace() {
            run.push(c);
        } else {
            if !run.is_empty() {
                if run.contains('\n') {
                    out.push(' ');
                } else {
                    out.push_str(&run);
                }
                run.clear();
            }
            out.push(c);
        }
    }
    if !run.is_empty() {
        if run.contains('\n') {
            out.push(' ');
        } else {
            out.push_str(&run);
        }
    }
    out.trim().to_owned()
}

/// Render the message: subject, blank line, trailers in the pinned order, a final newline.
#[must_use]
pub fn render_message(subject: &str, t: &CommitTrailers) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "omgbase-seq: {}",
        seq_value(&t.epoch, t.from, t.to)
    ));
    lines.push(format!("omgbase-ts: {}", t.ts));
    for c in &t.commits {
        lines.push(format!("omgbase-commit: {c}"));
    }
    if let Some(o) = &t.origin {
        lines.push(format!("omgbase-origin: {o}"));
    }
    if let Some(a) = &t.actor {
        lines.push(format!("omgbase-actor: {a}"));
    }
    if let Some(p) = &t.plan {
        lines.push(format!("omgbase-plan: {p}"));
    }
    if let Some((epoch, head)) = &t.rescan {
        lines.push(format!("omgbase-rescan: {epoch}:{head}"));
    }
    if let Some(m) = &t.merge {
        lines.push(format!("omgbase-merge: {m}"));
    }
    if let Some(c) = &t.content {
        lines.push(format!("omgbase-content: {c}"));
    }
    for d in &t.docs {
        lines.push(format!(
            "omgbase-doc: {} {} {}",
            d.doc_id,
            d.path,
            d.head.as_deref().unwrap_or("-")
        ));
    }
    format!("{}\n\n{}\n", flatten_subject(subject), lines.join("\n"))
}

/// The subject line (the first line) of a message.
#[must_use]
pub fn subject_of(message: &str) -> &str {
    message.split('\n').next().unwrap_or("")
}

/// Parse a message's trailers. Every `omgbase-<key>: value` line after the
/// subject is read (other lines are ignored); a message without `omgbase-seq`
/// is not one of ours → `None`.
#[must_use]
pub fn parse_message(message: &str) -> Option<CommitTrailers> {
    let mut seq: Option<(String, i64, i64)> = None;
    let mut ts: Option<String> = None;
    let mut commits = Vec::new();
    let mut origin = None;
    let mut actor = None;
    let mut plan = None;
    let mut docs = Vec::new();
    let mut rescan = None;
    let mut merge = None;
    let mut content = None;
    for line in message.split('\n').skip(1) {
        // `^omgbase-([a-z]+): (.*)$`
        let Some(rest) = line.strip_prefix(TRAILER_PREFIX) else {
            continue;
        };
        let Some((key, value)) = rest.split_once(": ") else {
            continue;
        };
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase()) {
            continue;
        }
        match key {
            "seq" => seq = parse_seq(value),
            "ts" => ts = Some(value.trim().to_owned()),
            "commit" => commits.push(value.trim().to_owned()),
            "origin" => origin = Some(value.trim().to_owned()),
            "actor" => actor = Some(value.trim().to_owned()),
            "plan" => plan = Some(value.trim().to_owned()),
            "rescan" => {
                if let Some((epoch, _from, to)) = parse_seq(value) {
                    rescan = Some((epoch, to));
                }
            }
            "merge" => merge = Some(value.trim().to_owned()),
            "content" => content = Some(value.trim().to_owned()),
            "doc" => {
                // `<doc_id> <path> <head>`: the id is the first token, the head
                // the last; the path is everything between (it may hold spaces).
                let Some(first) = value.find(' ') else {
                    continue;
                };
                let Some(last) = value.rfind(' ') else {
                    continue;
                };
                if last <= first {
                    continue;
                }
                let head = value[last + 1..].trim();
                docs.push(DocTrailer {
                    doc_id: value[..first].to_owned(),
                    path: value[first + 1..last].to_owned(),
                    head: (head != "-").then(|| head.to_owned()),
                });
            }
            _ => {}
        }
    }
    let (epoch, from, to) = seq?;
    Some(CommitTrailers {
        epoch,
        from,
        to,
        ts: ts.unwrap_or_default(),
        commits,
        origin,
        actor,
        plan,
        docs,
        rescan,
        merge,
        content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_pinned_order_and_parses_it_back() {
        let t = CommitTrailers {
            epoch: "ep_0".into(),
            from: 3,
            to: 5,
            ts: "2026-10-20T10:02:00.000Z".into(),
            commits: vec!["c_2".into(), "c_3".into()],
            origin: Some("api".into()),
            actor: Some("human:x".into()),
            plan: Some("ab".repeat(32)),
            docs: vec![
                DocTrailer {
                    doc_id: "d_0".into(),
                    path: "a b/c d.md".into(),
                    head: Some("r_1".into()),
                },
                DocTrailer {
                    doc_id: "d_1".into(),
                    path: "gone.md".into(),
                    head: None,
                },
            ],
            rescan: None,
            merge: None,
            content: None,
        };
        let msg = render_message("subject\nwith newline", &t);
        assert_eq!(
            msg,
            format!(
                "subject with newline\n\nomgbase-seq: ep_0:3-5\nomgbase-ts: 2026-10-20T10:02:00.000Z\nomgbase-commit: c_2\nomgbase-commit: c_3\nomgbase-origin: api\nomgbase-actor: human:x\nomgbase-plan: {}\nomgbase-doc: d_0 a b/c d.md r_1\nomgbase-doc: d_1 gone.md -\n",
                "ab".repeat(32)
            )
        );
        assert_eq!(parse_message(&msg), Some(t));
        assert_eq!(subject_of(&msg), "subject with newline");
        assert_eq!(seq_value("ep_0", 4, 4), "ep_0:4");
        assert_eq!(parse_message("not ours\n\nbody\n"), None);
        assert_eq!(
            parse_message("rescan\n\nomgbase-seq: ep_0:7\nomgbase-rescan: ep_0:7\n")
                .unwrap()
                .rescan,
            Some(("ep_0".into(), 7))
        );
        // 17.6: the merge and content trailers, rendered after rescan and before the docs.
        let m = CommitTrailers {
            epoch: "ep_0".into(),
            from: 4,
            to: 4,
            ts: "2026-10-20T10:06:00.000Z".into(),
            commits: vec![],
            origin: None,
            actor: None,
            plan: None,
            docs: vec![],
            rescan: None,
            merge: Some("a".repeat(40)),
            content: Some("b".repeat(40)),
        };
        let text = render_message("merge origin/omgbase", &m);
        assert_eq!(
            text,
            format!(
                "merge origin/omgbase\n\nomgbase-seq: ep_0:4\nomgbase-ts: 2026-10-20T10:06:00.000Z\nomgbase-merge: {}\nomgbase-content: {}\n",
                "a".repeat(40),
                "b".repeat(40)
            )
        );
        assert_eq!(parse_message(&text), Some(m));
    }
}
