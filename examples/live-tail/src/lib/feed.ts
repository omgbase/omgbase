// The pure side of the live tail: the change feed's cursor, a `changes_since`
// digest as the page shows it, which two revisions to diff for a change, the
// recent-documents query and its hits (either envelope), the OQX filter (the
// queries it shapes and what it hides), and the diff's lines. Nothing here
// touches the network or the DOM.
//
// Tool shapes, as this module keeps them (the 2.x spellings; a 3.0 server's
// `{ id, path, hash, updated_at, raw }` are read into these by lib/shapes.ts
// per the connected server's surface version). The queries this module
// generates spell the attributes per server too (lib/paths.ts `attr`: `path`/
// `title`/`updated_at` on ≥ 3.0, `$path`/`$title`/`$updated_at` before):
//   changes_since → { digests: [{ commit, seq, ts, origin, actor, summary, revisions: [{ doc, path, contentHash }] }], cursor, truncated, head }
//   docs_history  → { docs: [{ docId, path, deleted, currentRev, versions: [{ rev, seq, commit, ts, origin, actor, contentHash, isCurrent }] }], truncated }
//   diff_unified  → { doc, path, from, to, diff }
//   docs_read_at  → { path, docId, rev, content, … }

import { attr, hitId, hitPath, rooted } from "./paths.ts";

export interface Revision { doc: string; path: string; contentHash: string }
export interface Digest {
  commit: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  revisions: Revision[];
}
export interface ChangesSince { digests: Digest[]; cursor: number; truncated: boolean; head: number }

export interface DocVersion { rev: string; seq: number; commit: string; ts: string; origin: string; actor: string | null; contentHash: string; isCurrent: boolean }
export interface DocVersions { docId: string; path: string; deleted: boolean; currentRev: string | null; versions: DocVersion[] }

export const RECENT_LIMIT = 25;

/** The recent query's first line — the projection — in the server's spelling
 * (`title` on 3.0 is the computed title attribute; `$title` before). */
export function recentSelect(surface: string | null = null): string {
  return `select ${attr(surface, "path")}, ${attr(surface, "title")}, ${attr(surface, "updated_at")} from docs`;
}
/** Its last line — newest first, the page's cap. */
export function recentTail(surface: string | null = null): string {
  return `order by ${attr(surface, "updated_at")} desc limit ${RECENT_LIMIT}`;
}

/** The query behind the initial view, narrowed by the filter (an OQX `where`
 * predicate over `docs`) when there is one; one line, for the server of
 * surface `surface` (unknown → the 2.x spelling). With a filter its tokens are
 * exactly the framed field's (`frameFor`, which lays the same text out on three
 * lines); without one the `where` clause is omitted (an empty `where` would not
 * parse). */
export function recentQuery(filter = "", surface: string | null = null): string {
  const f = filter.trim();
  const select = recentSelect(surface);
  const tail = recentTail(surface);
  return f ? `${select} where ${f} ${tail}` : `${select} ${tail}`;
}

/** The read-only frame the field shows around the hole when there is a `where`
 * line — the `select … from docs` line, `where ` + the hole, the `order by …
 * limit` line. */
export function frameBefore(surface: string | null = null): string {
  return `${recentSelect(surface)}\nwhere `;
}
export function frameAfter(surface: string | null = null): string {
  return `\n${recentTail(surface)}`;
}

export interface Frame {
  text: string;
  /** The editable range (UTF-16 offsets, as CodeMirror counts). */
  hole: { from: number; to: number };
  /** Whether the `where` line is shown (the hole lives on it); without it nothing is editable. */
  where: boolean;
}

/** The framed field's text and the hole in it. With a filter, or while the
 * field is being edited, three lines: the filter between `frameBefore` and
 * `frameAfter`, so the second line is `where <filter>` (an empty filter is an
 * empty hole after `where `, where the caret waits). Idle and empty, two lines
 * with no `where` at all and a closed, zero-width hole at the end of the first.
 * Joined with spaces instead of its newlines the text is `recentQuery(filter,
 * surface)` in every state. */
export function frameFor(filter: string, { editing = false, surface = null }: { editing?: boolean; surface?: string | null } = {}): Frame {
  const select = recentSelect(surface);
  const after = frameAfter(surface);
  if (filter === "" && !editing) {
    const at = select.length;
    return { text: `${select}${after}`, hole: { from: at, to: at }, where: false };
  }
  const before = frameBefore(surface);
  const from = before.length;
  return { text: `${before}${filter}${after}`, hole: { from, to: from + filter.length }, where: true };
}

// ---- the cursor --------------------------------------------------------------------

/** Where the live feed starts: the repo's `head` (what happened before the page
 * opened is the recent-documents view's business, not a "change"). */
export function startCursor(r: Pick<ChangesSince, "head">): number {
  return r.head;
}

/** The cursor after a poll. A cursor beyond `head` belongs to another repo or
 * server (the tool's own contract): start over from `head` and say so. */
export function advanceCursor(r: Pick<ChangesSince, "cursor" | "head">): { cursor: number; reset: boolean } {
  return r.cursor > r.head ? { cursor: r.head, reset: true } : { cursor: r.cursor, reset: false };
}

// ---- digests → entries -------------------------------------------------------------

/** What is being diffed for one changed document. */
export type DiffPair =
  | { kind: "created"; rev: string }
  | { kind: "changed"; from: string; to: string };

export interface EntryChange {
  doc: string;
  /** `/`-rooted whatever the server returned. */
  path: string;
  /** The document's `title` from the poll's lookup query; null when it has none or is gone (deleted, moved away). */
  title: string | null;
  contentHash: string;
}

export interface FeedEntry {
  /** The commit id (unique per repo); the list is deduped by it. */
  key: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  changes: EntryChange[];
}

/** `titles` is the poll's lookup (`titlesByPath`), keyed by rooted path; a document it lacks has no title. */
export function entryFromDigest(d: Digest, titles: ReadonlyMap<string, string | null> = new Map()): FeedEntry {
  return {
    key: d.commit,
    seq: d.seq,
    ts: d.ts,
    origin: d.origin,
    actor: d.actor,
    summary: d.summary,
    changes: d.revisions.map((r) => { const path = rooted(r.path); return { doc: r.doc, path, title: titles.get(path) ?? null, contentHash: r.contentHash }; }),
  };
}

/** A page of digests (ascending `seq`) put in front of the entries shown
 * (newest first), without repeating a commit already there. */
export function prependDigests(entries: readonly FeedEntry[], digests: readonly Digest[], titles?: ReadonlyMap<string, string | null>): FeedEntry[] {
  const seen = new Set(entries.map((e) => e.key));
  const fresh: FeedEntry[] = [];
  for (const d of digests) {
    if (seen.has(d.commit)) continue;
    seen.add(d.commit);
    fresh.push(entryFromDigest(d, titles));
  }
  fresh.sort((a, b) => b.seq - a.seq);
  return [...fresh, ...entries];
}

/** Who made the change, once: `origin · actor`; the origin alone when there is
 * no actor (observed changes), the actor alone when it already carries the
 * origin (`api` + `api:cli` → `api:cli`). */
export function byline(e: Pick<FeedEntry, "origin" | "actor">): string {
  if (!e.actor) return e.origin;
  if (e.actor === e.origin || e.actor.startsWith(`${e.origin}:`)) return e.actor;
  return `${e.origin} · ${e.actor}`;
}

// ---- which revisions to diff --------------------------------------------------------

/** The pair for a document's LATEST change: its last two versions, or
 * "created" when it has only one. Null without versions. */
export function latestPair(versions: readonly DocVersion[]): DiffPair | null {
  const n = versions.length;
  if (n === 0) return null;
  if (n === 1) return { kind: "created", rev: versions[0]!.rev };
  return { kind: "changed", from: versions[n - 2]!.rev, to: versions[n - 1]!.rev };
}

/** The pair for the revision a given commit produced (a digest's change):
 * that version against its predecessor, "created" when it is the first.
 * Null when the commit wrote no version of this document. */
export function pairForCommit(versions: readonly DocVersion[], commit: string): DiffPair | null {
  const i = versions.findIndex((v) => v.commit === commit);
  if (i < 0) return null;
  if (i === 0) return { kind: "created", rev: versions[0]!.rev };
  return { kind: "changed", from: versions[i - 1]!.rev, to: versions[i]!.rev };
}

// ---- recent documents ---------------------------------------------------------------

/** A document's latest change, from `docs_history`'s last version (for a recent card's header). */
export interface LatestChange { seq: number; commit: string; origin: string; actor: string | null }

export interface RecentDoc {
  id: string | null;
  /** `/`-rooted. */
  path: string;
  title: string | null;
  updatedAt: string | null;
  /** Filled once the document's history is fetched (with its diff pair). */
  latest: LatestChange | null;
}

export function latestChange(versions: readonly DocVersion[]): LatestChange | null {
  const v = versions[versions.length - 1];
  return v ? { seq: v.seq, commit: v.commit, origin: v.origin, actor: v.actor } : null;
}

/** The projected title of a hit — `title` (a 3.0 server) or `$title` (before);
 * the recent and lookup queries project exactly one of the two. */
function hitTitle(hit: Record<string, unknown>): string | null {
  const title = hit.title ?? hit.$title;
  return typeof title === "string" && title.trim() ? title : null;
}

/** The recent-documents hits as the page shows them; a hit without a path is skipped. */
export function recentFromHits(hits: readonly Record<string, unknown>[]): RecentDoc[] {
  const out: RecentDoc[] = [];
  for (const hit of hits) {
    const path = hitPath(hit);
    if (path === null) continue;
    const updated = hit.updated_at ?? hit.$updated_at;
    out.push({
      id: hitId(hit),
      path: rooted(path),
      title: hitTitle(hit),
      updatedAt: typeof updated === "string" ? updated : null,
      latest: null,
    });
  }
  return out;
}

// ---- the card -----------------------------------------------------------------------
//
// Both card kinds — a recent document and a feed entry — are one view model: a
// header that carries every value exactly once (the update's time, `title`
// prominent, `path` secondary — or the path alone when the title is null or
// the same —, the change's `seq` and commit id, who made it, the lines added
// and removed), with no label words ("latest change", "created", the digest's
// summary) that restate what is already there. A change touching several
// documents keeps the digest's values in the header and gives each document a
// slim row of its own (title/path and its own +N −M only).

export interface Stats { added: number; removed: number }

export interface CardRow { title: string | null; path: string; stats: Stats | null }

export interface Card {
  /** The update's time: a recent document's `updated_at`, a digest's `ts`. */
  ts: string | null;
  /** The document, when the card is about one (null for a multi-document digest; a deletion names nothing). */
  title: string | null;
  path: string | null;
  seq: number | null;
  commit: string | null;
  by: string | null;
  /** The lines added/removed — the total over the rows for a multi-document digest; null while unknown. */
  stats: Stats | null;
  /** One per document when the change touched several; otherwise empty. */
  rows: CardRow[];
  /** The server's summary — kept ONLY when the digest has no revisions (a deletion or a move), where it is the sole statement of what happened. */
  note: string | null;
}

/** Add up the stats that are known; null until at least one is. */
export function sumStats(parts: readonly (Stats | null)[]): Stats | null {
  const known = parts.filter((s): s is Stats => s !== null);
  if (known.length === 0) return null;
  return known.reduce((a, s) => ({ added: a.added + s.added, removed: a.removed + s.removed }), { added: 0, removed: 0 });
}

/** A recent document's card: the document, its latest change (once the history is in), the diff's stats. */
export function recentCard(doc: RecentDoc, stats: Stats | null): Card {
  return {
    ts: doc.updatedAt, title: doc.title, path: doc.path,
    seq: doc.latest?.seq ?? null, commit: doc.latest?.commit ?? null, by: doc.latest ? byline(doc.latest) : null,
    stats, rows: [], note: null,
  };
}

/** A feed entry's card; `statsByDoc` has each change's stats (by `doc`) as far as its diff is in. */
export function entryCard(e: FeedEntry, statsByDoc: ReadonlyMap<string, Stats | null>): Card {
  const stats = e.changes.map((ch) => statsByDoc.get(ch.doc) ?? null);
  const one = e.changes.length === 1 ? e.changes[0]! : null;
  return {
    ts: e.ts, title: one?.title ?? null, path: one?.path ?? null,
    seq: e.seq, commit: e.key, by: byline(e),
    stats: sumStats(stats),
    rows: e.changes.length > 1 ? e.changes.map((ch, i) => ({ title: ch.title, path: ch.path, stats: stats[i]! })) : [],
    note: e.changes.length === 0 ? e.summary : null,
  };
}

export function formatStats(s: Stats): string {
  return `+${s.added} −${s.removed}`;
}

/** Everything a card shows, flat and in reading order — the header, then each
 * row — so a test can assert no value is rendered twice. The title is omitted
 * when it is null or equals the path (the path is then shown once). */
export function cardFields(card: Card, now: Date = new Date()): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const doc = (title: string | null, path: string | null, prefix = "") => {
    if (title !== null && title !== path) out.push({ label: `${prefix}title`, value: title });
    if (path !== null) out.push({ label: `${prefix}path`, value: path });
  };
  if (card.ts !== null) out.push({ label: "time", value: formatTime(card.ts, now) });
  doc(card.title, card.path);
  if (card.seq !== null) out.push({ label: "seq", value: `seq ${card.seq}` });
  if (card.commit !== null) out.push({ label: "commit", value: card.commit });
  if (card.by !== null) out.push({ label: "by", value: card.by });
  if (card.stats !== null) out.push({ label: "stats", value: formatStats(card.stats) });
  if (card.note !== null) out.push({ label: "note", value: card.note });
  card.rows.forEach((r, i) => {
    doc(r.title, r.path, `row ${i + 1} `);
    if (r.stats !== null) out.push({ label: `row ${i + 1} stats`, value: formatStats(r.stats) });
  });
  return out;
}

// ---- the filter ---------------------------------------------------------------------

/** How the filter stands: absent, applied, or refused by the server (`filter_invalid`)
 * — while invalid nothing is hidden and the page says so. */
export type FilterState =
  | { kind: "off" }
  | { kind: "on"; filter: string }
  | { kind: "invalid"; filter: string; message: string };

/** The state after running a query with `filter`: empty → off; the server took
 * it → on; it refused it → invalid with its message. Any other failure (the
 * network, the repo) says nothing about the filter, so it is taken as `on`. */
export function filterStateAfter(filter: string, error: { code?: string; message: string } | null): FilterState {
  const f = filter.trim();
  if (f === "") return { kind: "off" };
  if (error && error.code === "filter_invalid") return { kind: "invalid", filter: f, message: error.message };
  return { kind: "on", filter: f };
}

/** ONE query per poll over the documents a page of digests touches: their
 * `path` and `title` (in the server's spelling) — the title lookup for the
 * cards — narrowed to the documents the filter admits when there is one (the
 * filter and-ed with the paths or-ed together; OQX has no array literal). Paths
 * are `/`-rooted and deduped; null when there is nothing to ask about. Read
 * the hits with `hitPath`/`titlesByPath`. A deleted or moved-away document is
 * not in `docs` and so is not returned. */
export function matchQuery(filter: string, paths: readonly string[], surface: string | null = null): string | null {
  const unique = [...new Set(paths.map(rooted))];
  if (unique.length === 0) return null;
  const path = attr(surface, "path");
  const alternatives = unique.map((p) => `${path} == ${JSON.stringify(p)}`).join(" or ");
  const f = filter.trim();
  return `select ${path}, ${attr(surface, "title")} from docs where ${f ? `(${f}) and ` : ""}(${alternatives})`;
}

/** The lookup query's hits as rooted path → title (null for a blank or
 * missing title); a hit without a path is skipped. Its keys are the documents
 * the query returned — under a filter, the ones it admits. */
export function titlesByPath(hits: readonly Record<string, unknown>[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const hit of hits) {
    const path = hitPath(hit);
    if (path === null) continue;
    out.set(rooted(path), hitTitle(hit));
  }
  return out;
}

/** The paths a page of digests touches (`/`-rooted, deduped, in order). */
export function digestPaths(digests: readonly Digest[]): string[] {
  return [...new Set(digests.flatMap((d) => d.revisions.map((r) => rooted(r.path))))];
}

/** Digests through the filter: a revision stays when its document is in
 * `matching` (the match query's paths, rooted), the rest are dropped; a
 * digest left without revisions — including one that had none, a deletion or a
 * move, whose documents are no longer in `docs` to be evaluated — is hidden
 * and counted. */
export function partitionByFilter(digests: readonly Digest[], matching: ReadonlySet<string>): { kept: Digest[]; hidden: number } {
  const kept: Digest[] = [];
  let hidden = 0;
  for (const d of digests) {
    const revisions = d.revisions.filter((r) => matching.has(rooted(r.path)));
    if (revisions.length === 0) hidden++;
    else kept.push({ ...d, revisions });
  }
  return { kept, hidden };
}

/** The muted line under the feed heading. */
export function hiddenLine(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `${hidden} change${hidden === 1 ? "" : "s"} hidden by the filter`;
}

// ---- rendering helpers -------------------------------------------------------------

/** A created document's content as a pure-addition unified diff: one
 * `@@ -0,0 +1,N @@` hunk with every line prefixed `+`, so content that itself
 * starts with `-` (frontmatter fences, YAML items, dash bullets) or `+` is
 * never read as a subtraction or a context line by `diffLineKind`. A single
 * trailing newline is the file's, not an empty last line. Empty content is "". */
export function createdDiff(content: string): string {
  if (content === "") return "";
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

export type DiffLineKind = "hunk" | "add" | "del" | "ctx";

/** Classify a unified-diff line by its first character (no file header is
 * ever present: `diff_unified` emits hunks only). */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** `+n −m` for a unified diff (hunk headers excluded). */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (diff === "") return { added, removed };
  for (const line of diff.split("\n")) {
    const kind = diffLineKind(line);
    if (kind === "add") added++;
    else if (kind === "del") removed++;
  }
  return { added, removed };
}

/** A timestamp for the feed: `HH:MM:SS` when it is today (by `now`), else `YYYY-MM-DD HH:MM`; the input when unparsable. */
export function formatTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `${hm}:${pad(d.getSeconds())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** How a diff is shown: the plain unified text (the default), or rendered as
 * Markdown with the removed/added elements coloured (`<unified-markdown-diff>`). */
export type DiffView = "text" | "markdown";

export const DIFF_VIEW_KEY = "omgbase-live-tail.view";

/** The view a stored value names; anything but `markdown` is the default text view. */
export function diffViewOf(stored: string | null | undefined): DiffView {
  return stored === "markdown" ? "markdown" : "text";
}

/** The persisted view (`localStorage`, or anything with `getItem`). */
export function loadDiffView(storage: Pick<Storage, "getItem">): DiffView {
  return diffViewOf(storage.getItem(DIFF_VIEW_KEY));
}

export function saveDiffView(storage: Pick<Storage, "setItem">, view: DiffView): void {
  storage.setItem(DIFF_VIEW_KEY, view);
}

/** The poll interval the user typed, in milliseconds: whole seconds, 1..3600, else the fallback. */
export function pollMs(input: string | number | null | undefined, fallback = 2000): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n < 1 || n > 3600) return fallback;
  return Math.round(n) * 1000;
}
