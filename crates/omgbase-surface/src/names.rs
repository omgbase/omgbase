//! Unknown names (`spec/surface` §1.5, 4.6; one tier since 5.0; port of the
//! reference's `oqx-js/names.ts`). A query that projects, filters or orders by
//! a name no row of the scope's kind can carry — `select _path, target from
//! links` (links have `_dst_path`), `where preview != ""` on blocks — used to
//! run silently: an absent column in every row, a predicate true or false of
//! every row. This pass judges every name the query reads (`oqx`'s
//! `references`, AST.md §5b) against the row kind it is read from, statically
//! — before any row is read, so the verdict never depends on the query's own
//! filter — and either records a hint or refuses the query.
//!
//! The name rule (§1.2, 5.0) makes the judgement two-sided:
//!   * an UNDERSCORE-prefixed name is an engine name — an attribute, a
//!     reach-through, a source handle or a relation of the kind, a CLOSED set
//!     — so a `_x` that is none of them is `filter_invalid` naming the kind's
//!     engine names (the one loud error of this pass; both modes);
//!   * a BARE name is the author's — on a document a frontmatter or inline
//!     key, on a block or node a key of its `attrs` — and is judged against
//!     the VOCABULARY of the kind in this repository: a name at least one live
//!     object carries is known (however partial: `stage` on three processes
//!     out of twenty documents is the data model working); a name no object
//!     carries is the complaint — on a read the result carries one hint per
//!     offending name and the rows still come back; a write selector (the AST
//!     entry, [`UnknownNames::Refuse`]) is refused, since a name no row
//!     carries would select every row. The hint's nearest match is drawn from
//!     the authored keys AND the engine names, so a bare `title` / `id` /
//!     `path` / `tags` / `format` that spells an engine attribute without its
//!     prefix says "did you mean `_title`?". A `links` or `revisions` row
//!     carries no authored data at all, so a bare name there is
//!     `filter_invalid` either way (closed row shape).
//!
//! A repository with no live object of an open kind has no vocabulary: the
//! check is skipped for that kind. The vocabulary is read once per
//! (repository, kind) and cached on the repository's head commit
//! (`MAX(commits.seq)`), the one thing every property or attrs change moves —
//! the cache ([`VocabularyCache`]) lives beside the store it describes (the
//! `Surface` holds one; a bare `query` call judges with a cache of its own).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use omgbase_store::Store;
use oqx::{Expr, Follow, FollowDestination, OpNode, Query, ReferenceStep, StepExpr, references};
use rusqlite::params;

use crate::context::{SOURCE_HANDLES, Target, attributes, reach_throughs};
use crate::error::{Result, SurfaceError};
use crate::planner;

/// What to do with an unknown bare name on an open kind: record it in `hints`
/// (every read) or refuse the query (a write selector).
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
            ("_blocks", Target::Blocks),
            ("_nodes", Target::Nodes),
            ("_out_links", Target::Links),
            ("_in_links", Target::Links),
            ("_revisions", Target::Revisions),
        ],
        Target::Blocks => &[
            ("_children", Target::Blocks),
            ("_nodes", Target::Nodes),
            ("_out_links", Target::Links),
            ("_section", Target::Nodes),
        ],
        Target::Nodes => &[
            ("_blocks", Target::Blocks),
            ("_subsections", Target::Nodes),
            ("_children", Target::Nodes),
        ],
        Target::Links | Target::Revisions => &[],
    }
}

/// The reach-through handles of a kind and the kind of the row each reaches
/// (§1.2; the self aliases are gone in 5.0 — `$it` is the self).
#[must_use]
pub fn handles(t: Target) -> &'static [(&'static str, Target)] {
    match t {
        Target::Docs => &[],
        Target::Blocks => &[("_doc", Target::Docs)],
        Target::Nodes => &[("_doc", Target::Docs), ("_block", Target::Blocks)],
        // `_block` reaches the SOURCE block (4.11), absent for a frontmatter link
        Target::Links => &[
            ("_doc", Target::Docs),
            ("_dst", Target::Docs),
            ("_block", Target::Blocks),
        ],
        // `_doc` reaches the document's current row (4.7)
        Target::Revisions => &[("_doc", Target::Docs)],
    }
}

/// Every engine name of a kind, in the §1.2 table's order: attributes,
/// reach-throughs, source handles (docs), relations — the list the messages
/// carry and the candidates a nearest match is drawn from.
#[must_use]
pub fn engine_names(t: Target) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = attributes(t).to_vec();
    out.extend(reach_throughs(t));
    if t == Target::Docs {
        out.extend(SOURCE_HANDLES);
    }
    out.extend(relations(t).iter().map(|(n, _)| *n));
    out
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

// seam: feed sequence separate from archive retention (Phase 3, M5/D7 — the
// cache keys on the feed's `(epoch, seq)`; inventory-rust.md §2.7
// `names.rs:168-174`, §3.6).
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
/// (`$title`, `$tags`) are the attributes `_title`/`_tags`, not authored keys.
fn authored_keys(store: &Store, repo_id: &str, target: Target) -> Result<Vec<String>> {
    let sql = match target {
        Target::Docs => "SELECT DISTINCT key FROM properties WHERE repo_id = ? AND source IN ('frontmatter', 'inline') ORDER BY key".to_owned(),
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
/// keys in `key` order (the SQL runs only when a name is not an engine name).
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

/// `Root` is the root scope; `Group(k)` a GROUP scope (oqx 0.24): the groups
/// of rows of kind `k` (`None` when the rows' kind is unknown), whose only
/// row-yielding name is `rows`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowKind {
    Root,
    Of(Target),
    Group(Option<Target>),
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

/// Follow a dotted path from a row kind through reach-throughs and relations
/// (`_doc._blocks` on a link → blocks).
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
            // At a group scope `rows` yields the grouped rows (their kind); a
            // key is a value the language built, not a row of any kind.
            RowKind::Group(k) => {
                if *seg != "rows" || i != 0 {
                    return None;
                }
                cur = k.map(RowKind::Of);
            }
        }
    }
    match cur? {
        RowKind::Root | RowKind::Group(_) => None,
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
        let rows_kind = match cur {
            Some(RowKind::Of(t)) => Some(t),
            _ => None,
        };
        cur = match step.expr {
            StepExpr::Follow(f) => {
                kind_of_frontier(rows_kind, f, read_depth, &by_depth).map(RowKind::Of)
            }
            // A `group by` step (oqx 0.24): the rows at this depth become groups of them.
            StepExpr::GroupBy(_) => Some(RowKind::Group(rows_kind)),
            StepExpr::Expr(e) => kind_of_expr(e, cur, read_depth, &by_depth).map(RowKind::Of),
        };
        by_depth.insert(step.depth, cur);
        read_depth = step.depth;
    }
    match cur? {
        RowKind::Root | RowKind::Group(_) => None,
        RowKind::Of(t) => Some(t),
    }
}

// ---- judging a name --------------------------------------------------------

/// Why a judged name is unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Why {
    /// An underscore name that is no engine name of the kind.
    Engine,
    /// A bare name on a kind that carries no authored data.
    Closed,
    /// A bare name no object of the kind carries.
    Authored,
}

struct Verdict {
    target: Target,
    /// The dotted name judged (the path after any reach-through or relation).
    name: String,
    why: Why,
    /// The source handle the name was read through (`_data`, `_frontmatter`,
    /// `_inline`), when it was.
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
        if head.starts_with('_') {
            // An engine attribute: what follows it (`_attrs.checked`,
            // `_tags.size`) is the value's own navigation.
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
            if let Some(via) =
                lookup(handles(target), head).or_else(|| lookup(relations(target), head))
            {
                return if rest.is_empty() {
                    Ok(None)
                } else {
                    self.judge(via, rest)
                };
            }
            // Not an engine name of this kind: the closed set is the whole set.
            return Ok(Some(Verdict {
                target,
                name: (*head).to_owned(),
                why: Why::Engine,
                handle: None,
            }));
        }
        // A bare target name on a row is the context's own loud error
        // (`crate::query`); not doubled here.
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
                why: Why::Closed,
                handle: handle.map(str::to_owned),
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
            why: Why::Authored,
            handle: handle.map(str::to_owned),
        }))
    }

    /// The candidates of a bare name: the kind's engine names (so `title`
    /// finds `_title`) and, on an open kind, its authored keys.
    fn candidates(&self, target: Target) -> Result<Vec<String>> {
        let mut out: Vec<String> = engine_names(target)
            .into_iter()
            .map(str::to_owned)
            .collect();
        if !closed(target) {
            out.extend(self.vocabulary(target)?.list.iter().cloned());
        }
        Ok(out)
    }

    /// The error of an unknown engine name: `` `_target` is not an engine name
    /// of links (engine names: _id, _path, …); did you mean `_dst_path`? `` —
    /// the nearest match drawn from the engine names and the authored keys, so
    /// a `_layer` written for the authored `layer` is pointed at it.
    fn engine_name_error_message(&self, target: Target, name: &str) -> Result<String> {
        Ok(format!(
            "`{name}` is not an engine name of {} (engine names: {}){}",
            target.as_str(),
            engine_names(target).join(", "),
            suggestion(name, &self.candidates(target)?)
        ))
    }

    /// The hint of an open kind: `` no block in this repository carries a
    /// property `preview`; did you mean `_text`? ``. Under a source handle the
    /// name is shown with it — `` no document in this repository carries a
    /// property `x` (`_data.x`); did you mean `y`? `` — and the nearest match
    /// is drawn from the authored keys alone.
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
            "no {} in this repository carries a property `{name}`{}",
            noun(target),
            suggestion(name, &self.candidates(target)?)
        ))
    }
}

/// The error of a bare name on a closed kind: `` `target` reads an authored
/// property, and a link carries none (engine names: _id, _path, …); did you
/// mean `_dst_path`? `` — the nearest match drawn from the engine names.
#[must_use]
pub fn closed_kind_error_message(target: Target, name: &str, handle: Option<&str>) -> String {
    let shown = handle.map_or(String::new(), |h| format!(" (`{h}.{name}`)"));
    let names: Vec<String> = engine_names(target)
        .into_iter()
        .map(str::to_owned)
        .collect();
    format!(
        "`{name}`{shown} reads an authored property, and a {} carries none (engine names: {}){}",
        noun(target),
        names.join(", "),
        suggestion(name, &names)
    )
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

/// The nearest match of `name` among `candidates` (§1.5). First, the one hint
/// the name rule makes certain: a candidate that is exactly `name` with the
/// engine prefix added or removed (`id` → `_id`, `_layer` → `layer`) wins
/// outright, whatever its length. Otherwise case-insensitive and
/// **prefix-blind** — the `_` is a declaration, not spelling, so `commited` is
/// one edit from `_commit` and `titel` one from `_title` as from `title`: a
/// candidate qualifies when its distance is ≤ 2, or when one of the two is a
/// substring of the other and the shorter has at least three characters. One
/// typo (distance 1) wins first; then a substring match outranks a distance-2
/// match (`_via` → `_via_id`, not `_id`; `_dst_pth` → `_dst_path`, not
/// `_dst`); within a class the lowest distance, then the shorter candidate (so
/// the bare authored `title` beats `_title` when both are one edit away), then
/// alphabetical. A name under three characters gets no suggestion apart from
/// the prefix rule (it is within distance 2 of nearly anything, and too short
/// for the substring rule). `None` when nothing qualifies.
#[must_use]
pub fn nearest<'c>(name: &str, candidates: impl IntoIterator<Item = &'c str>) -> Option<String> {
    let candidates: Vec<&str> = candidates.into_iter().collect();
    let lower = name.to_lowercase();
    let prefixed = format!("_{lower}");
    let unprefixed = lower.strip_prefix('_');
    for c in &candidates {
        let hay = c.to_lowercase();
        if hay == prefixed || unprefixed == Some(hay.as_str()) {
            return Some((*c).to_owned());
        }
    }
    let needle = lower.strip_prefix('_').unwrap_or(&lower).to_owned();
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
        let hay_full = c.to_lowercase();
        let hay = hay_full.strip_prefix('_').unwrap_or(&hay_full);
        if hay == needle {
            continue;
        }
        let d = edit_distance(&needle, hay);
        let hay_len = hay.chars().count();
        let (shorter, shorter_len, longer) = if needle_len <= hay_len {
            (needle.as_str(), needle_len, hay)
        } else {
            (hay, hay_len, needle.as_str())
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

/// Judge every name the query reads. Returns the hints (one per unknown bare
/// name of an open kind, first-reference order, deduplicated) under
/// [`UnknownNames::Hint`]; fails with `filter_invalid` for an unknown engine
/// name (`_x`) and for a bare name on a closed kind in either mode, and for an
/// unknown bare name on an open kind under [`UnknownNames::Refuse`].
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
        match verdict.why {
            Why::Engine => {
                return Err(SurfaceError::filter_invalid(
                    judge.engine_name_error_message(verdict.target, &verdict.name)?,
                    "OQX",
                ));
            }
            Why::Closed => {
                return Err(SurfaceError::filter_invalid(
                    closed_kind_error_message(
                        verdict.target,
                        &verdict.name,
                        verdict.handle.as_deref(),
                    ),
                    "OQX",
                ));
            }
            Why::Authored => {}
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

    const DOCS_NAMES: &str = "_id, _path, _raw, _hash, _updated_at, _created_at, _title, _tags, _format, _data, _frontmatter, _inline, _blocks, _nodes, _out_links, _in_links, _revisions";
    const BLOCKS_NAMES: &str = "_id, _path, _raw, _hash, _updated_at, _created_at, _doc_id, _type, _text, _attrs, _depth, _ordinal, _doc, _children, _nodes, _out_links, _section";
    const LINKS_NAMES: &str = "_id, _path, _doc_id, _block_id, _via_id, _dst_id, _dst_path, _uri, _field, _dst_kind, _predicate, _provenance, _anchor, _doc, _dst, _block";
    const REVISIONS_NAMES: &str = "_id, _path, _rev, _seq, _doc_id, _commit, _ts, _origin, _actor, _reason, _hash, _is_current, _archived, _doc";

    #[test]
    fn engine_names_are_the_table_in_order() {
        assert_eq!(engine_names(Target::Docs).join(", "), DOCS_NAMES);
        assert_eq!(engine_names(Target::Blocks).join(", "), BLOCKS_NAMES);
        assert_eq!(
            engine_names(Target::Nodes).join(", "),
            "_id, _path, _doc_id, _block_id, _kind, _name, _value, _attrs, _doc, _block, _blocks, _subsections, _children"
        );
        assert_eq!(engine_names(Target::Links).join(", "), LINKS_NAMES);
        assert_eq!(engine_names(Target::Revisions).join(", "), REVISIONS_NAMES);
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
    fn the_name_rule() {
        let (store, repo) = fixture();
        // engine names — attributes, handles and relations — are silent
        assert!(hints(&store, &repo, "select _title, _tags, _path, _blocks, d: $it._id from docs where _nodes exists { where _kind == \"md:task\" }").is_empty());
        assert!(
            hints(
                &store,
                &repo,
                "select _type, _text, _attrs, _children, _section.level, _doc._title from blocks"
            )
            .is_empty()
        );
        assert!(
            hints(
                &store,
                &repo,
                "select _dst_path, s: _doc._title, t: _dst._title from links"
            )
            .is_empty()
        );
        // a bare property some objects carry is silent; a dotted prefix of a key is known
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
        // a bare name no object carries is one hint per name, first-reference
        // order, deduplicated
        assert_eq!(
            hints(
                &store,
                &repo,
                "select stag, kynd from docs where stag == \"x\" order by kynd"
            ),
            [
                "no document in this repository carries a property `stag`; did you mean `stage`?",
                "no document in this repository carries a property `kynd`; did you mean `kind`?",
            ]
        );
        assert_eq!(
            hints(&store, &repo, "select meta.ownr, stage.x from docs"),
            [
                "no document in this repository carries a property `meta.ownr`; did you mean `meta.owner`?",
                "no document in this repository carries a property `stage.x`; did you mean `stage`?",
            ]
        );
        // a bare name that spells an engine attribute without its prefix is
        // pointed at the engine name outright
        assert_eq!(
            hints(
                &store,
                &repo,
                "select id, title, path, tags, format from docs"
            ),
            [
                "no document in this repository carries a property `id`; did you mean `_id`?",
                "no document in this repository carries a property `title`; did you mean `_title`?",
                "no document in this repository carries a property `path`; did you mean `_path`?",
                "no document in this repository carries a property `tags`; did you mean `_tags`?",
                "no document in this repository carries a property `format`; did you mean `_format`?",
            ]
        );
        assert_eq!(
            hints(&store, &repo, "select text, preview from blocks"),
            [
                "no block in this repository carries a property `text`; did you mean `_text`?",
                "no block in this repository carries a property `preview`",
            ]
        );
        // under a source handle the name is shown with the handle, the
        // authored keys alone as candidates
        assert_eq!(
            hints(
                &store,
                &repo,
                "select p: _data.path, k: _frontmatter.kynd from docs"
            ),
            [
                "no document in this repository carries a property `path` (`_data.path`)",
                "no document in this repository carries a property `kynd` (`_frontmatter.kynd`); did you mean `kind`?",
            ]
        );
    }

    #[test]
    fn an_unknown_engine_name_is_loud_in_either_mode() {
        let (store, repo) = fixture();
        let docs_err = format!(
            "`_nope` is not an engine name of docs (engine names: {DOCS_NAMES}); did you mean `_nodes`?"
        );
        for mode in [UnknownNames::Hint, UnknownNames::Refuse] {
            let e = refusal(&store, &repo, "select _nope from docs", mode);
            assert_eq!(
                (e.code.as_str(), e.message.as_str()),
                ("filter_invalid", docs_err.as_str())
            );
        }
        // the nearest match is drawn from the engine names and the authored
        // keys: a `_kind` written for the authored `kind` is pointed at it
        assert_eq!(
            refusal(
                &store,
                &repo,
                "from docs where _kind == \"x\"",
                UnknownNames::Hint
            )
            .message,
            format!(
                "`_kind` is not an engine name of docs (engine names: {DOCS_NAMES}); did you mean `kind`?"
            )
        );
        assert_eq!(
            refusal(
                &store,
                &repo,
                "select _tittle from blocks",
                UnknownNames::Hint
            )
            .message,
            format!("`_tittle` is not an engine name of blocks (engine names: {BLOCKS_NAMES})")
        );
        // behind a reach-through the name is judged against the reached kind
        assert!(
            refusal(
                &store,
                &repo,
                "select _doc._nope from blocks",
                UnknownNames::Hint
            )
            .message
            .starts_with("`_nope` is not an engine name of docs")
        );
    }

    #[test]
    fn closed_kinds_refuse_a_bare_name_and_dst_reaches_docs() {
        let (store, repo) = fixture();
        let err = format!(
            "`target` reads an authored property, and a link carries none (engine names: {LINKS_NAMES})"
        );
        let e = refusal(
            &store,
            &repo,
            "select target from links",
            UnknownNames::Hint,
        );
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("filter_invalid", err.as_str())
        );
        let e = refusal(
            &store,
            &repo,
            "from docs where _out_links exists { where target == \"x\" }",
            UnknownNames::Hint,
        );
        assert_eq!(e.message, err);
        assert_eq!(
            refusal(
                &store,
                &repo,
                "select dst_path from links",
                UnknownNames::Hint
            )
            .message,
            format!(
                "`dst_path` reads an authored property, and a link carries none (engine names: {LINKS_NAMES}); did you mean `_dst_path`?"
            )
        );
        assert_eq!(
            refusal(
                &store,
                &repo,
                "select rev from revisions",
                UnknownNames::Hint
            )
            .message,
            format!(
                "`rev` reads an authored property, and a revision carries none (engine names: {REVISIONS_NAMES}); did you mean `_rev`?"
            )
        );
        assert_eq!(
            hints(&store, &repo, "select _dst.kynd from links"),
            ["no document in this repository carries a property `kynd`; did you mean `kind`?"]
        );
        // `_block` (4.11) reaches the source block: its engine names read
        // clean, a misspelling is judged as a block's; the handle is not an
        // attribute, so the closed-row list names it after the attributes.
        assert!(
            hints(
                &store,
                &repo,
                "select _block._text, _block._type, _block._doc._path from links"
            )
            .is_empty()
        );
        assert_eq!(
            hints(&store, &repo, "select _block.typ from links"),
            ["no block in this repository carries a property `typ`; did you mean `_type`?"]
        );
    }

    #[test]
    fn refuse_mode_is_the_hint_text_as_filter_invalid() {
        let (store, repo) = fixture();
        let e = refusal(&store, &repo, "select stag from docs", UnknownNames::Refuse);
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "no document in this repository carries a property `stag`; did you mean `stage`?"
        );
        assert_eq!(e.data.unwrap()["hint"], "OQX");
    }

    #[test]
    fn what_is_not_judged() {
        let (store, repo) = fixture();
        for q in [
            "select s: stage, n: s from docs where s == \"x\"",
            // a group scope (oqx 0.24): a key is never a row property; `rows`
            // yields the grouped rows, so names under it are judged as docs/blocks
            "select stage, n: count(), kynd: collect(kind) from docs group by stage having n > 1 order by count() desc",
            "select kind, open: rows count { where _nodes exists { where _kind == \"md:task\" } } from docs group by kind",
            "select p: _path, open from docs where _nodes collect { ^open: _value where _kind == \"md:task\" }",
            "select $key: _id from docs where $depth > 0 and has(stage) and size(list(kind)) > 0",
            "select a: _attrs.whatever from blocks",
            "select n: _tags.size() from docs",
            "select t: (_blocks, _nodes) collect { select kynd } from docs",
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
        // under a group scope, `rows` is still the docs: an unknown bare name through it hints
        assert_eq!(
            hints(
                &store,
                &repo,
                "select stage, t: rows collect { select kynd } from docs group by stage"
            ),
            ["no document in this repository carries a property `kynd`; did you mean `kind`?"]
        );
        assert_eq!(
            hints(
                &store,
                &repo,
                "select lang, n: rows count { where chekced } from blocks group by lang"
            ),
            ["no block in this repository carries a property `chekced`; did you mean `checked`?"]
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
            .contains("reads an authored property, and a link carries none")
        );
        // the engine-name check still runs
        assert!(
            refusal(&store, &repo, "select _nope from docs", UnknownNames::Hint)
                .message
                .starts_with("`_nope` is not an engine name of docs")
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
            "_id",
            "_path",
            "_doc_id",
            "_block_id",
            "_via_id",
            "_dst_id",
            "_dst_path",
            "_uri",
            "_field",
            "_dst_kind",
            "_predicate",
            "_provenance",
            "_anchor",
        ];
        let n = |name: &str, c: &[&str]| nearest(name, c.iter().copied());
        // the one certain hint: a name that is a candidate with the engine
        // prefix added or removed wins outright, whatever its length
        assert_eq!(n("id", &links).as_deref(), Some("_id"));
        assert_eq!(n("dst_path", &links).as_deref(), Some("_dst_path"));
        assert_eq!(n("title", &["titel", "_title"]).as_deref(), Some("_title"));
        assert_eq!(n("_kind", &["kinds", "kind"]).as_deref(), Some("kind"));
        assert_eq!(n("dst_pth", &links).as_deref(), Some("_dst_path"));
        assert_eq!(n("target", &links), None);
        assert_eq!(n("DST", &links).as_deref(), Some("_dst_id"));
        assert_eq!(n("via", &links).as_deref(), Some("_via_id"));
        assert_eq!(n("x", &links), None);
        assert_eq!(n("in", &["_id", "_in_links", "_out_links"]), None);
        assert_eq!(
            n("tag", &["_id", "_path", "_tags", "_title"]).as_deref(),
            Some("_tags")
        );
        assert_eq!(
            n(
                "preview",
                &[
                    "_id",
                    "_path",
                    "_type",
                    "_text",
                    "_attrs",
                    "_depth",
                    "_ordinal",
                    "_children"
                ]
            ),
            None
        );
        assert_eq!(n("predicat", &links).as_deref(), Some("_predicate"));
        // prefix-blind: the bare authored key wins a tie by length
        assert_eq!(n("titel", &["_title", "title"]).as_deref(), Some("title"));
        assert_eq!(n("commited", &["_commit"]).as_deref(), Some("_commit"));
        assert_eq!(n("abc", &["acb", "abc_x", "abd"]).as_deref(), Some("abd"));
        assert_eq!(n("abcd", &["abxy", "abcd_x"]).as_deref(), Some("abcd_x"));
        assert_eq!(n("abc", &["abcd", "xabc"]).as_deref(), Some("abcd"));
    }
}
