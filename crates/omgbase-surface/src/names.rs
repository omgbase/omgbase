//! Unknown names (`spec/surface` §1.5, 4.6; port of the reference's
//! `oqx-js/names.ts`). A query that projects, filters or orders by a name no
//! row of the scope's kind can carry — `select path, target from links`
//! (links have `dst_path`), `where preview != ""` on blocks — used to run
//! silently: an absent column in every row, a predicate true or false of
//! every row. This pass judges every name the query reads (`oqx`'s
//! `references`, AST.md §5b) against the VOCABULARY of the row kind it is read
//! from, statically — before any row is read, so the verdict never depends on
//! the query's own filter — and either records a hint or refuses the query.
//!
//! The three tiers of a name at a scope whose kind is known:
//!   1. an engine attribute, handle or relation of the kind — known;
//!   2. an authored property at least one live object of the kind in this
//!      repository carries (docs: a frontmatter or inline key — `stage` on three
//!      processes is enough; blocks and nodes: a key of a live row's `attrs`,
//!      the bare-name read of those kinds) — known, however partial;
//!   3. a name no object of the kind carries — the complaint.
//!
//! Severity: `links` has a closed row shape (no authored data reaches a link
//! row), so a tier-3 name there is `filter_invalid`; docs, blocks and nodes are
//! open — on a read the result carries one hint per offending name and the
//! rows still come back; a write selector (the AST entry,
//! [`UnknownNames::Refuse`]) is refused, since a name no row carries would
//! select every row. A repository with no live object of the kind has no
//! vocabulary: the check is skipped for that kind. The vocabulary is read once
//! per (repository, kind) and cached on the repository's head commit
//! (`MAX(commits.seq)`), the one thing every property or attrs change moves —
//! the cache ([`VocabularyCache`]) lives beside the store it describes (the
//! `Surface` holds one; a bare `query` call judges with a cache of its own).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use omgbase_store::Store;
use oqx::{Expr, Follow, FollowDestination, OpNode, Query, ReferenceStep, StepExpr, references};
use rusqlite::params;

use crate::context::{SOURCE_HANDLES, Target, attributes};
use crate::error::{Result, SurfaceError};
use crate::planner;

/// What to do with a tier-3 name on an open kind: record it in `hints` (every
/// read) or refuse the query (a write selector).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownNames {
    Hint,
    Refuse,
}

/// The relations of a kind, in the §1.2 order, and the kind of the rows each yields.
#[must_use]
pub fn relations(t: Target) -> &'static [(&'static str, Target)] {
    match t {
        Target::Docs => &[
            ("blocks", Target::Blocks),
            ("nodes", Target::Nodes),
            ("out_links", Target::Links),
            ("in_links", Target::Links),
            ("revisions", Target::Revisions),
        ],
        Target::Blocks => &[
            ("children", Target::Blocks),
            ("nodes", Target::Nodes),
            ("out_links", Target::Links),
            ("section", Target::Nodes),
        ],
        Target::Nodes => &[
            ("blocks", Target::Blocks),
            ("subsections", Target::Nodes),
            ("children", Target::Nodes),
        ],
        Target::Links | Target::Revisions => &[],
    }
}

/// The self and reach-through handles of a kind and the kind of the row each reaches (§1.2).
#[must_use]
pub fn handles(t: Target) -> &'static [(&'static str, Target)] {
    match t {
        Target::Docs => &[("doc", Target::Docs)],
        Target::Blocks => &[("block", Target::Blocks), ("doc", Target::Docs)],
        Target::Nodes => &[
            ("section", Target::Nodes),
            ("doc", Target::Docs),
            ("block", Target::Blocks),
        ],
        Target::Links => &[("doc", Target::Docs), ("dst", Target::Docs)],
        // `doc` reaches the document's current row (4.7)
        Target::Revisions => &[("doc", Target::Docs)],
    }
}

fn lookup(table: &[(&str, Target)], name: &str) -> Option<Target> {
    table.iter().find(|(n, _)| *n == name).map(|(_, t)| *t)
}

/// The kinds whose row shape is closed: no authored data reaches a row by bare
/// name — `links`, and `revisions` since 4.7.
fn closed(t: Target) -> bool {
    matches!(t, Target::Links | Target::Revisions)
}

fn noun(t: Target) -> &'static str {
    match t {
        Target::Docs => "document",
        Target::Blocks => "block",
        Target::Nodes => "node",
        Target::Links => "link",
        Target::Revisions => "revision",
    }
}

// ---- vocabulary ------------------------------------------------------------

/// The authored vocabulary of one kind in one repository.
#[derive(Debug)]
pub struct Vocabulary {
    /// Whether the repository has a live object of the kind at all.
    pub present: bool,
    /// The authored keys (flattened, dotted) and every dotted prefix of them.
    keys: HashSet<String>,
    /// The authored keys alone, in `key` order — the nearest-match candidates.
    pub list: Vec<String>,
}

struct RepoCache {
    head: i64,
    vocab: HashMap<Target, Rc<Vocabulary>>,
}

/// The vocabulary cache of one store: per repository, keyed on the head
/// commit. Keep it beside the store it was read from.
#[derive(Default)]
pub struct VocabularyCache {
    repos: RefCell<HashMap<String, RepoCache>>,
}

impl std::fmt::Debug for VocabularyCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VocabularyCache").finish_non_exhaustive()
    }
}

fn head_seq(store: &Store, repo_id: &str) -> Result<i64> {
    Ok(store.conn().query_row(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM commits WHERE repo_id = ?",
        params![repo_id],
        |r| r.get::<_, i64>(0),
    )?)
}

/// The authored vocabulary of a kind: docs — every live frontmatter or inline
/// key (the merged read a bare name performs); blocks and nodes — every key a
/// live row's `attrs` holds (the bare-name read of those kinds). Computed keys
/// (`$title`, `$tags`) are the intrinsics `title`/`tags`, not authored keys.
fn authored_keys(store: &Store, repo_id: &str, target: Target) -> Result<Vec<String>> {
    let sql = match target {
        Target::Docs => "SELECT DISTINCT key FROM properties WHERE repo_id = ? AND deleted_commit IS NULL AND source IN ('frontmatter', 'inline') ORDER BY key".to_owned(),
        Target::Blocks | Target::Nodes => {
            let alias = if target == Target::Blocks { "b" } else { "n" };
            format!(
                "SELECT DISTINCT j.key AS key FROM {}, json_each({alias}.attrs) j WHERE {} ORDER BY key",
                planner::from_clause(target),
                planner::guards(target)
            )
        }
        Target::Links | Target::Revisions => return Ok(Vec::new()),
    };
    let mut stmt = store.conn().prepare(&sql)?;
    let rows = stmt.query_map(params![repo_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn present(store: &Store, repo_id: &str, target: Target) -> Result<bool> {
    // A closed kind has no authored vocabulary to be absent; the question never reaches it.
    if target == Target::Revisions {
        return Ok(true);
    }
    let sql = format!(
        "SELECT 1 FROM {} WHERE {} LIMIT 1",
        planner::from_clause(target),
        planner::guards(target)
    );
    let mut stmt = store.conn().prepare(&sql)?;
    Ok(stmt.exists(params![repo_id])?)
}

/// The vocabulary of a kind in a repository: `(present, keys)` — the authored
/// keys in `key` order (the SQL runs only when a name is not intrinsic).
pub fn vocabulary(store: &Store, repo_id: &str, target: Target) -> Result<(bool, Vec<String>)> {
    let cache = VocabularyCache::default();
    let v = cache.vocabulary_of(store, repo_id, target)?;
    Ok((v.present, v.list.clone()))
}

impl VocabularyCache {
    /// The vocabulary of `target` in `repo_id`, read once per head commit.
    pub fn vocabulary_of(
        &self,
        store: &Store,
        repo_id: &str,
        target: Target,
    ) -> Result<Rc<Vocabulary>> {
        let head = head_seq(store, repo_id)?;
        let mut repos = self.repos.borrow_mut();
        let c = repos.entry(repo_id.to_owned()).or_insert(RepoCache {
            head,
            vocab: HashMap::new(),
        });
        if c.head != head {
            c.head = head;
            c.vocab.clear();
        }
        if let Some(v) = c.vocab.get(&target) {
            return Ok(Rc::clone(v));
        }
        let list = authored_keys(store, repo_id, target)?;
        let mut keys = HashSet::new();
        for k in &list {
            let segs: Vec<&str> = k.split('.').collect();
            for i in 1..=segs.len() {
                keys.insert(segs[..i].join("."));
            }
        }
        let present = !list.is_empty() || present(store, repo_id, target)?;
        let v = Rc::new(Vocabulary {
            present,
            keys,
            list,
        });
        c.vocab.insert(target, Rc::clone(&v));
        Ok(v)
    }
}

// ---- the kind of a scope ---------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowKind {
    Root,
    Of(Target),
}

type ByDepth = HashMap<usize, Option<RowKind>>;

/// The kind of the rows an expression yields when read on rows of `on`
/// (`Root`: the root scope), or `None` when unknown.
fn kind_of_expr(
    e: &Expr,
    on: Option<RowKind>,
    read_depth: usize,
    by_depth: &ByDepth,
) -> Option<Target> {
    match e {
        Expr::Ident { name, .. } => kind_of_path(on, &[name]),
        Expr::Outer { levels, name, .. } => {
            kind_of_path(outer_base(read_depth, *levels, by_depth), &[name])
        }
        Expr::Member { .. } => {
            let (head, rest) = dotted(e)?;
            let (base, name) = match head {
                Expr::Ident { name, .. } => (on, name.as_str()),
                Expr::Outer { levels, name, .. } => {
                    (outer_base(read_depth, *levels, by_depth), name.as_str())
                }
                _ => return None,
            };
            let mut path = vec![name];
            path.extend(rest);
            kind_of_path(base, &path)
        }
        // `refs(x)` resolves document references to live document rows (§1.3).
        Expr::Call {
            recv: None, name, ..
        } if name == "refs" => Some(Target::Docs),
        // A value-position block with no projection passes its receiver's rows through (then its own `from`).
        Expr::Op(op) => kind_of_op(op, on, read_depth, by_depth),
        _ => None, // a literal, a binding, a tuple (mixed), a template, an operator, a call
    }
}

fn kind_of_op(
    op: &OpNode,
    on: Option<RowKind>,
    read_depth: usize,
    by_depth: &ByDepth,
) -> Option<Target> {
    if op.sub.select.iter().any(|it| it.name() != "$key") || op.sub.values {
        return None;
    }
    let mut k = kind_of_expr(&op.receiver, on, read_depth, by_depth);
    for f in &op.sub.from {
        k = k.and_then(|k| kind_of_expr(f, Some(RowKind::Of(k)), read_depth + 1, by_depth));
    }
    k
}

/// The scope an outer reference reads: `levels` out of the read depth; past the root is the root.
fn outer_base(read_depth: usize, levels: usize, by_depth: &ByDepth) -> Option<RowKind> {
    if levels >= read_depth {
        Some(RowKind::Root)
    } else {
        by_depth.get(&(read_depth - levels)).copied().flatten()
    }
}

/// A dotted navigation headed by a name: the head and the path after it.
fn dotted(e: &Expr) -> Option<(&Expr, Vec<&str>)> {
    match e {
        Expr::Ident { .. } | Expr::Outer { .. } => Some((e, Vec::new())),
        Expr::Member { recv, name, .. } => {
            let (head, mut rest) = dotted(recv)?;
            rest.push(name);
            Some((head, rest))
        }
        _ => None,
    }
}

/// Follow a dotted path from a row kind through handles and relations (`doc.blocks` on a link → blocks).
fn kind_of_path(on: Option<RowKind>, path: &[&str]) -> Option<Target> {
    let mut cur = on;
    for (i, seg) in path.iter().enumerate() {
        match cur? {
            RowKind::Root => {
                if *seg == "$it" {
                    continue;
                }
                cur = Some(RowKind::Of(Target::parse(seg)?));
            }
            RowKind::Of(t) => {
                if *seg == "$it" && i == 0 {
                    continue;
                }
                let next = lookup(handles(t), seg).or_else(|| lookup(relations(t), seg))?;
                cur = Some(RowKind::Of(next));
            }
        }
    }
    match cur? {
        RowKind::Root => None,
        RowKind::Of(t) => Some(t),
    }
}

/// The kind of the frontier rows of a walk: the seeds' kind when every
/// destination yields rows of that same kind, else unknown.
fn kind_of_frontier(
    seed: Option<Target>,
    f: &Follow,
    read_depth: usize,
    by_depth: &ByDepth,
) -> Option<Target> {
    let seed = seed?;
    let on = Some(RowKind::Of(seed));
    // A destination block is a value-position `op`: its receiver on the frontier row, then its own `from`.
    for d in &f.destinations {
        let k = match d {
            FollowDestination::Relation(e) => kind_of_expr(e, on, read_depth, by_depth),
            FollowDestination::Block(op) => kind_of_op(op, on, read_depth, by_depth),
        };
        if k != Some(seed) {
            return None;
        }
    }
    Some(seed)
}

/// The kind of the rows a scope holds, from its row chain (AST.md §5b); `None`
/// when the chain reaches a value no kind describes.
#[must_use]
pub fn kind_of_scope(steps: &[ReferenceStep<'_>]) -> Option<Target> {
    if steps.is_empty() {
        return None; // the root scope: root names are judged elsewhere
    }
    let mut by_depth: ByDepth = HashMap::from([(0, Some(RowKind::Root))]);
    let mut cur: Option<RowKind> = Some(RowKind::Root);
    let mut read_depth = 0;
    for step in steps {
        let k = match step.expr {
            StepExpr::Follow(f) => {
                let seed = match cur {
                    Some(RowKind::Of(t)) => Some(t),
                    _ => None,
                };
                kind_of_frontier(seed, f, read_depth, &by_depth)
            }
            StepExpr::Expr(e) => kind_of_expr(e, cur, read_depth, &by_depth),
        };
        cur = k.map(RowKind::Of);
        by_depth.insert(step.depth, cur);
        read_depth = step.depth;
    }
    match cur? {
        RowKind::Root => None,
        RowKind::Of(t) => Some(t),
    }
}

// ---- judging a name --------------------------------------------------------

struct Verdict {
    target: Target,
    /// The dotted name judged (the path after any handle or relation).
    name: String,
    closed: bool,
    /// The source handle the name was read through (`data`, `frontmatter`, `inline`), when it was.
    handle: Option<String>,
}

struct Judge<'a> {
    store: &'a Store,
    repo_id: &'a str,
    cache: &'a VocabularyCache,
}

impl Judge<'_> {
    fn vocabulary(&self, target: Target) -> Result<Rc<Vocabulary>> {
        self.cache.vocabulary_of(self.store, self.repo_id, target)
    }

    /// Judge a dotted name read on rows of `target`; `None` = known.
    fn judge(&self, target: Target, path: &[&str]) -> Result<Option<Verdict>> {
        let (head, rest) = path.split_first().expect("a name has a head");
        // An engine attribute wins on collision; what follows it (`attrs.checked`, `tags.size`) is the value's own navigation.
        if attributes(target).contains(head) {
            return Ok(None);
        }
        // The source handles reach the authored data under them.
        if target == Target::Docs && SOURCE_HANDLES.contains(head) {
            return if rest.is_empty() {
                Ok(None)
            } else {
                self.judge_authored(Target::Docs, rest, Some(head))
            };
        }
        if let Some(via) = lookup(handles(target), head).or_else(|| lookup(relations(target), head))
        {
            return if rest.is_empty() {
                Ok(None)
            } else {
                self.judge(via, rest)
            };
        }
        // A bare target name on a row is the context's own loud error (`crate::query`); not doubled here.
        if Target::parse(head).is_some() {
            return Ok(None);
        }
        self.judge_authored(target, path, None)
    }

    fn judge_authored(
        &self,
        target: Target,
        path: &[&str],
        handle: Option<&str>,
    ) -> Result<Option<Verdict>> {
        let name = path.join(".");
        if closed(target) {
            return Ok(Some(Verdict {
                target,
                name,
                closed: true,
                handle: None,
            }));
        }
        let v = self.vocabulary(target)?;
        if !v.present {
            return Ok(None); // no object of the kind: no vocabulary to judge by
        }
        if v.keys.contains(&name) {
            return Ok(None);
        }
        Ok(Some(Verdict {
            target,
            name,
            closed: false,
            handle: handle.map(str::to_owned),
        }))
    }

    /// The names a kind knows, for the nearest match: attributes, handles,
    /// relations, the authored keys.
    fn candidates(&self, target: Target) -> Result<Vec<String>> {
        let mut out: Vec<String> = attributes(target).iter().map(|s| (*s).to_owned()).collect();
        out.extend(handles(target).iter().map(|(n, _)| (*n).to_owned()));
        if target == Target::Docs {
            out.extend(SOURCE_HANDLES.iter().map(|s| (*s).to_owned()));
        }
        out.extend(relations(target).iter().map(|(n, _)| (*n).to_owned()));
        if !closed(target) {
            out.extend(self.vocabulary(target)?.list.iter().cloned());
        }
        Ok(out)
    }

    /// The error of a closed kind: `` `target` is not a field of links (fields: id, path, …); did you mean `…`? ``.
    fn field_error_message(&self, target: Target, name: &str) -> Result<String> {
        Ok(format!(
            "`{name}` is not a field of {} (fields: {}){}",
            target.as_str(),
            attributes(target).join(", "),
            suggestion(name, &self.candidates(target)?)
        ))
    }

    /// The hint of an open kind: `` `preview` is not a field of blocks and no
    /// block in this repository carries a property by that name; did you mean
    /// `…`? ``. Under a source handle the name is an authored lookup by
    /// construction, so the hint says only that: `` no document in this
    /// repository carries a property `path` (`data.path`); did you mean `…`? ``,
    /// the nearest match drawn from the authored keys alone.
    fn property_hint_message(
        &self,
        target: Target,
        name: &str,
        handle: Option<&str>,
    ) -> Result<String> {
        if let Some(h) = handle {
            return Ok(format!(
                "no {} in this repository carries a property `{name}` (`{h}.{name}`){}",
                noun(target),
                suggestion(name, &self.vocabulary(target)?.list)
            ));
        }
        Ok(format!(
            "`{name}` is not a field of {} and no {} in this repository carries a property by that name{}",
            target.as_str(),
            noun(target),
            suggestion(name, &self.candidates(target)?)
        ))
    }
}

// ---- messages --------------------------------------------------------------

/// Optimal string alignment distance (Damerau–Levenshtein with adjacent
/// transpositions, each edit 1), over code points.
#[must_use]
pub fn edit_distance(a: &str, b: &str) -> usize {
    let s: Vec<char> = a.chars().collect();
    let t: Vec<char> = b.chars().collect();
    let (m, n) = (s.len(), t.len());
    let mut d = vec![vec![0usize; n + 1]; m + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=m {
        for j in 1..=n {
            let cost = usize::from(s[i - 1] != t[j - 1]);
            let mut v = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && s[i - 1] == t[j - 2] && s[i - 2] == t[j - 1] {
                v = v.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
        }
    }
    d[m][n]
}

/// The nearest match of `name` among `candidates` (§1.5): case-insensitive; a
/// candidate qualifies when its distance is ≤ 2, or when one of the two is a
/// substring of the other and the shorter has at least three characters. One
/// typo (distance 1) wins first; then a substring match outranks a distance-2
/// match (`via` → `via_id`, not `id`; `dst_pth` → `dst_path`, not `dst`);
/// within a class the lowest distance, then the shorter candidate, then
/// alphabetical. A name under three characters gets no suggestion (it is
/// within distance 2 of nearly anything, and too short for the substring
/// rule). `None` when nothing qualifies.
#[must_use]
pub fn nearest<'c>(name: &str, candidates: impl IntoIterator<Item = &'c str>) -> Option<String> {
    let needle = name.to_lowercase();
    let needle_len = needle.chars().count();
    if needle_len < 3 {
        return None;
    }
    struct Best {
        c: String,
        d: usize,
        sub: bool,
    }
    let rank = |d: usize, sub: bool| -> u8 {
        if d == 1 {
            0
        } else if sub {
            1
        } else {
            2
        }
    };
    let mut best: Option<Best> = None;
    let mut seen: HashSet<&str> = HashSet::new();
    for c in candidates {
        if !seen.insert(c) {
            continue;
        }
        let hay = c.to_lowercase();
        if hay == needle {
            continue;
        }
        let d = edit_distance(&needle, &hay);
        let hay_len = hay.chars().count();
        let (shorter, shorter_len, longer) = if needle_len <= hay_len {
            (needle.as_str(), needle_len, hay.as_str())
        } else {
            (hay.as_str(), hay_len, needle.as_str())
        };
        let sub = shorter_len >= 3 && longer.contains(shorter);
        if !(d <= 2 || sub) {
            continue;
        }
        let better = match &best {
            None => true,
            Some(b) => {
                let (r, rb) = (rank(d, sub), rank(b.d, b.sub));
                r < rb
                    || (r == rb
                        && (d < b.d
                            || (d == b.d
                                && (c.chars().count() < b.c.chars().count()
                                    || (c.chars().count() == b.c.chars().count()
                                        && c < b.c.as_str())))))
            }
        };
        if better {
            best = Some(Best {
                c: c.to_owned(),
                d,
                sub,
            });
        }
    }
    best.map(|b| b.c)
}

fn suggestion(name: &str, candidates: &[String]) -> String {
    match nearest(name, candidates.iter().map(String::as_str)) {
        Some(c) => format!("; did you mean `{c}`?"),
        None => String::new(),
    }
}

// ---- the pass --------------------------------------------------------------

/// Judge every name the query reads. Returns the hints (one per offending name
/// of an open kind, first-reference order, deduplicated) under
/// [`UnknownNames::Hint`]; fails with `filter_invalid` for a tier-3 name on a
/// closed kind in either mode, and for one on an open kind under
/// [`UnknownNames::Refuse`].
pub fn check_names(
    store: &Store,
    repo_id: &str,
    raw: &Query,
    mode: UnknownNames,
    cache: &VocabularyCache,
) -> Result<Vec<String>> {
    let judge = Judge {
        store,
        repo_id,
        cache,
    };
    let mut hints: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in references(raw) {
        if r.scope.steps.is_empty() {
            continue; // a root name
        }
        let Some(kind) = kind_of_scope(&r.scope.steps) else {
            continue;
        };
        let path: Vec<&str> = r.name.split('.').collect();
        let Some(verdict) = judge.judge(kind, &path)? else {
            continue;
        };
        if verdict.closed {
            return Err(SurfaceError::filter_invalid(
                judge.field_error_message(verdict.target, &verdict.name)?,
                "OQX",
            ));
        }
        let message = judge.property_hint_message(
            verdict.target,
            &verdict.name,
            verdict.handle.as_deref(),
        )?;
        if mode == UnknownNames::Refuse {
            return Err(SurfaceError::filter_invalid(message, "OQX"));
        }
        if seen.insert(message.clone()) {
            hints.push(message);
        }
    }
    Ok(hints)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_reconcile::Config;
    use omgbase_store::BatchItem;

    const TS: &str = "2026-10-13T00:00:00.000Z";

    fn repo_with(docs: &[(&str, &str)]) -> (Store, String) {
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("names").unwrap();
        if !docs.is_empty() {
            let items: Vec<BatchItem> = docs
                .iter()
                .map(|(p, s)| BatchItem::observed(p, s))
                .collect();
            store
                .observe_batch(&repo, &items, TS, &Config::default())
                .unwrap();
        }
        (store, repo)
    }

    fn fixture() -> (Store, String) {
        repo_with(&[
            (
                "a.md",
                "---\nkind: x\nmeta:\n  owner: bb\n---\n\n# A\n\n- [ ] a task\n\n```js\nlet x;\n```\n",
            ),
            ("b.md", "---\nkind: y\n---\n\n# B\n\nstage:: calcination\n"),
        ])
    }

    fn hints(store: &Store, repo: &str, q: &str) -> Vec<String> {
        let raw = oqx::parse_string(q).unwrap();
        check_names(
            store,
            repo,
            &raw,
            UnknownNames::Hint,
            &VocabularyCache::default(),
        )
        .unwrap()
    }

    fn refusal(store: &Store, repo: &str, q: &str, mode: UnknownNames) -> SurfaceError {
        let raw = oqx::parse_string(q).unwrap();
        check_names(store, repo, &raw, mode, &VocabularyCache::default()).unwrap_err()
    }

    #[test]
    fn vocabulary_per_kind() {
        let (store, repo) = fixture();
        assert_eq!(
            vocabulary(&store, &repo, Target::Docs).unwrap(),
            (
                true,
                vec![
                    "kind".to_owned(),
                    "meta.owner".to_owned(),
                    "stage".to_owned()
                ]
            )
        );
        assert_eq!(
            vocabulary(&store, &repo, Target::Blocks).unwrap(),
            (
                true,
                ["checked", "lang", "level", "ordered"]
                    .map(str::to_owned)
                    .to_vec()
            )
        );
        assert_eq!(
            vocabulary(&store, &repo, Target::Nodes).unwrap(),
            (
                true,
                ["checked", "first_ordinal", "last_ordinal", "level"]
                    .map(str::to_owned)
                    .to_vec()
            )
        );
        assert_eq!(
            vocabulary(&store, &repo, Target::Links).unwrap(),
            (false, vec![])
        );
    }

    #[test]
    fn cache_refreshes_on_a_new_commit() {
        let (mut store, repo) = repo_with(&[("a.md", "---\nkind: x\n---\n\n# A\n")]);
        let cache = VocabularyCache::default();
        assert_eq!(
            cache
                .vocabulary_of(&store, &repo, Target::Docs)
                .unwrap()
                .list,
            ["kind"]
        );
        store
            .observe_batch(
                &repo,
                &[BatchItem::observed("b.md", "---\ncolor: red\n---\n\n# B\n")],
                TS,
                &Config::default(),
            )
            .unwrap();
        assert_eq!(
            cache
                .vocabulary_of(&store, &repo, Target::Docs)
                .unwrap()
                .list,
            ["color", "kind"]
        );
    }

    #[test]
    fn tiers() {
        let (store, repo) = fixture();
        // tier 1
        assert!(hints(&store, &repo, "select title, tags, path, blocks, d: doc.id from docs where nodes exists { where kind == \"md:task\" }").is_empty());
        assert!(
            hints(
                &store,
                &repo,
                "select type, text, attrs, children, section.level, doc.title from blocks"
            )
            .is_empty()
        );
        assert!(
            hints(
                &store,
                &repo,
                "select dst_path, s: doc.title, t: dst.title from links"
            )
            .is_empty()
        );
        // tier 2
        assert!(
            hints(
                &store,
                &repo,
                "select stage, kind from docs where meta.owner == \"bb\""
            )
            .is_empty()
        );
        assert!(hints(&store, &repo, "select meta from docs").is_empty());
        assert!(
            hints(
                &store,
                &repo,
                "select checked from blocks where lang == \"js\""
            )
            .is_empty()
        );
        // tier 3
        assert_eq!(
            hints(
                &store,
                &repo,
                "select stag, kynd from docs where stag == \"x\" order by kynd"
            ),
            [
                "`stag` is not a field of docs and no document in this repository carries a property by that name; did you mean `stage`?",
                "`kynd` is not a field of docs and no document in this repository carries a property by that name; did you mean `kind`?",
            ]
        );
        assert_eq!(
            hints(&store, &repo, "select meta.ownr, stage.x from docs"),
            [
                "`meta.ownr` is not a field of docs and no document in this repository carries a property by that name; did you mean `meta.owner`?",
                "`stage.x` is not a field of docs and no document in this repository carries a property by that name; did you mean `stage`?",
            ]
        );
        assert_eq!(
            hints(
                &store,
                &repo,
                "select p: data.path, k: frontmatter.kynd from docs"
            ),
            [
                "no document in this repository carries a property `path` (`data.path`)",
                "no document in this repository carries a property `kynd` (`frontmatter.kynd`); did you mean `kind`?",
            ]
        );
    }

    #[test]
    fn links_are_closed_and_dst_reaches_docs() {
        let (store, repo) = fixture();
        let err = "`target` is not a field of links (fields: id, path, doc_id, block_id, via_id, dst_id, dst_path, uri, field, dst_kind, predicate, provenance, anchor)";
        let e = refusal(
            &store,
            &repo,
            "select target from links",
            UnknownNames::Hint,
        );
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("filter_invalid", err)
        );
        let e = refusal(
            &store,
            &repo,
            "from docs where out_links exists { where target == \"x\" }",
            UnknownNames::Hint,
        );
        assert_eq!(e.message, err);
        assert_eq!(
            hints(&store, &repo, "select dst.kynd from links"),
            [
                "`kynd` is not a field of docs and no document in this repository carries a property by that name; did you mean `kind`?"
            ]
        );
    }

    #[test]
    fn refuse_mode_is_the_hint_text_as_filter_invalid() {
        let (store, repo) = fixture();
        let e = refusal(&store, &repo, "select stag from docs", UnknownNames::Refuse);
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "`stag` is not a field of docs and no document in this repository carries a property by that name; did you mean `stage`?"
        );
        assert_eq!(e.data.unwrap()["hint"], "OQX");
    }

    #[test]
    fn what_is_not_judged() {
        let (store, repo) = fixture();
        for q in [
            "select s: stage, n: s from docs where s == \"x\"",
            "select p: path, open from docs where nodes collect { ^open: value where kind == \"md:task\" }",
            "select $key: id from docs where $depth > 0 and has(stage) and size(list(kind)) > 0",
            "select a: attrs.whatever from blocks",
            "select n: tags.size() from docs",
            "select t: (blocks, nodes) collect { select kynd } from docs",
        ] {
            assert!(hints(&store, &repo, q).is_empty(), "{q}");
        }
        assert_eq!(
            hints(
                &store,
                &repo,
                "select r: refs(stage) collect { select kynd } from docs"
            )
            .len(),
            1
        );
    }

    #[test]
    fn an_empty_repository_has_no_vocabulary() {
        let (store, repo) = repo_with(&[]);
        assert!(hints(&store, &repo, "select titel from docs where layr == \"x\"").is_empty());
        assert!(hints(&store, &repo, "select preview from blocks").is_empty());
        assert!(
            refusal(
                &store,
                &repo,
                "select target from links",
                UnknownNames::Hint
            )
            .message
            .contains("is not a field of links")
        );
    }

    #[test]
    fn edit_distance_is_optimal_string_alignment() {
        assert_eq!(edit_distance("title", "titel"), 1);
        assert_eq!(edit_distance("stag", "stage"), 1);
        assert_eq!(edit_distance("value", "text"), 5);
        assert_eq!(edit_distance("via", "via_id"), 3);
        assert_eq!(edit_distance("x", "id"), 2);
    }

    #[test]
    fn nearest_match_rule() {
        let links = [
            "id",
            "path",
            "doc_id",
            "block_id",
            "via_id",
            "dst_id",
            "dst_path",
            "uri",
            "field",
            "dst_kind",
            "predicate",
            "provenance",
            "anchor",
        ];
        let n = |name: &str, c: &[&str]| nearest(name, c.iter().copied());
        assert_eq!(n("dst_pth", &links).as_deref(), Some("dst_path"));
        assert_eq!(n("target", &links), None);
        assert_eq!(n("DST", &links).as_deref(), Some("dst_id"));
        assert_eq!(n("via", &links).as_deref(), Some("via_id"));
        assert_eq!(n("x", &links), None);
        assert_eq!(n("in", &["id", "in_links", "out_links"]), None);
        assert_eq!(
            n("tag", &["id", "path", "tags", "title"]).as_deref(),
            Some("tags")
        );
        assert_eq!(
            n(
                "preview",
                &[
                    "id", "path", "type", "text", "attrs", "depth", "ordinal", "children"
                ]
            ),
            None
        );
        assert_eq!(n("predicat", &links).as_deref(), Some("predicate"));
        assert_eq!(n("abc", &["acb", "abc_x", "abd"]).as_deref(), Some("abd"));
        assert_eq!(n("abcd", &["abxy", "abcd_x"]).as_deref(), Some("abcd_x"));
        assert_eq!(n("abc", &["abcd", "xabc"]).as_deref(), Some("abcd"));
    }
}
