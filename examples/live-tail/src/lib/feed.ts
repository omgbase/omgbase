// The pure side of the live tail: the change feed's cursor, a `changes_since`
// digest as the page shows it, which two revisions to diff for a change, the
// recent-documents query and its hits (either envelope), the OQX filter (the
// queries it shapes and what it hides), and the diff's lines. Nothing here
// touches the network or the DOM.
//
// Tool shapes (packages/core/src/mcp/server.ts, graph/history.ts):
//   changes_since → { digests: [{ commit, seq, ts, origin, actor, summary, revisions: [{ doc, path, contentHash }] }], cursor, truncated, head }
//   docs_history  → { docs: [{ docId, path, deleted, currentRev, versions: [{ rev, seq, commit, ts, origin, actor, contentHash, isCurrent }] }], truncated }
//   diff_unified  → { doc, path, from, to, diff }
//   docs_read_at  → { path, docId, rev, content, … }

import { hitId, hitPath, rooted } from "./paths.ts";

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

const RECENT_SELECT = "select $path, $title, $updated_at from docs";
const RECENT_TAIL = `order by $updated_at desc limit ${RECENT_LIMIT}`;

/** The query behind the initial view, narrowed by the filter (an OQX `where`
 * predicate over `docs`) when there is one; one line, for the server. With a
 * filter its tokens are exactly the framed field's (`frameFor`, which lays the
 * same text out on three lines); without one the `where` clause is omitted (an
 * empty `where` would not parse). `$title`/`$updated_at` are projected under
 * both envelopes. */
export function recentQuery(filter = ""): string {
  const f = filter.trim();
  return f ? `${RECENT_SELECT} where ${f} ${RECENT_TAIL}` : `${RECENT_SELECT} ${RECENT_TAIL}`;
}
/** The unfiltered initial view. */
export const RECENT_QUERY = recentQuery();

/** The read-only frame the field shows around the hole when there is a `where`
 * line — the `select … from docs` line, `where ` + the hole, the `order by …
 * limit` line. */
export const FRAME_BEFORE = `${RECENT_SELECT}\nwhere `;
export const FRAME_AFTER = `\n${RECENT_TAIL}`;

export interface Frame {
  text: string;
  /** The editable range (UTF-16 offsets, as CodeMirror counts). */
  hole: { from: number; to: number };
  /** Whether the `where` line is shown (the hole lives on it); without it nothing is editable. */
  where: boolean;
}

/** The framed field's text and the hole in it. With a filter, or while the
 * field is being edited, three lines: the filter between `FRAME_BEFORE` and
 * `FRAME_AFTER`, so the second line is `where <filter>` (an empty filter is an
 * empty hole after `where `, where the caret waits). Idle and empty, two lines
 * with no `where` at all and a closed, zero-width hole at the end of the first.
 * Joined with spaces instead of its newlines the text is `recentQuery(filter)`
 * in every state. */
export function frameFor(filter: string, { editing = false }: { editing?: boolean } = {}): Frame {
  if (filter === "" && !editing) {
    const at = RECENT_SELECT.length;
    return { text: `${RECENT_SELECT}${FRAME_AFTER}`, hole: { from: at, to: at }, where: false };
  }
  const from = FRAME_BEFORE.length;
  return { text: `${FRAME_BEFORE}${filter}${FRAME_AFTER}`, hole: { from, to: from + filter.length }, where: true };
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
  /** The document's `$title` from the poll's lookup query; null when it has none or is gone (deleted, moved away). */
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

/** `origin · actor` for the entry's byline (`actor` is often null for observed changes). */
export function byline(e: Pick<FeedEntry, "origin" | "actor">): string {
  return e.actor ? `${e.origin} · ${e.actor}` : e.origin;
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

export interface RecentDoc {
  id: string | null;
  /** `/`-rooted. */
  path: string;
  title: string | null;
  updatedAt: string | null;
}

/** The recent-documents hits as the page shows them; a hit without a path is skipped. */
export function recentFromHits(hits: readonly Record<string, unknown>[]): RecentDoc[] {
  const out: RecentDoc[] = [];
  for (const hit of hits) {
    const path = hitPath(hit);
    if (path === null) continue;
    const title = hit.$title;
    const updated = hit.$updated_at;
    out.push({
      id: hitId(hit),
      path: rooted(path),
      title: typeof title === "string" && title.trim() ? title : null,
      updatedAt: typeof updated === "string" ? updated : null,
    });
  }
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
 * `$path` and `$title` — the title lookup for the cards — narrowed to the
 * documents the filter admits when there is one (the filter and-ed with the
 * paths or-ed together; OQX has no array literal). Paths are `/`-rooted and
 * deduped; null when there is nothing to ask about. The hits come back under
 * either envelope — read them with `hitPath`/`titlesByPath`. A deleted or
 * moved-away document is not in `docs` and so is not returned. */
export function matchQuery(filter: string, paths: readonly string[]): string | null {
  const unique = [...new Set(paths.map(rooted))];
  if (unique.length === 0) return null;
  const alternatives = unique.map((p) => `$path == ${JSON.stringify(p)}`).join(" or ");
  const f = filter.trim();
  return `select $path, $title from docs where ${f ? `(${f}) and ` : ""}(${alternatives})`;
}

/** The lookup query's hits as rooted path → `$title` (null for a blank or
 * missing title); a hit without a path is skipped. Its keys are the documents
 * the query returned — under a filter, the ones it admits. */
export function titlesByPath(hits: readonly Record<string, unknown>[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const hit of hits) {
    const path = hitPath(hit);
    if (path === null) continue;
    const title = hit.$title;
    out.set(rooted(path), typeof title === "string" && title.trim() ? title : null);
  }
  return out;
}

/** The paths a page of digests touches (`/`-rooted, deduped, in order). */
export function digestPaths(digests: readonly Digest[]): string[] {
  return [...new Set(digests.flatMap((d) => d.revisions.map((r) => rooted(r.path))))];
}

/** Digests through the filter: a revision stays when its document is in
 * `matching` (the match query's `$path`s, rooted), the rest are dropped; a
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

/** The poll interval the user typed, in milliseconds: whole seconds, 1..3600, else the fallback. */
export function pollMs(input: string | number | null | undefined, fallback = 2000): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n < 1 || n > 3600) return fallback;
  return Math.round(n) * 1000;
}
