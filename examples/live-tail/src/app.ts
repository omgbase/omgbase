// The page: one element, module-level signals.
//
//   connect → (whoami: proxy mode + sign-in state) → version + repos → pick a repo
//     → recent documents (query) with the unified diff of each one's latest change
//     → the change feed: `changes_since` from the repo's head, polled every N seconds,
//       every digest prepended as it lands with its revisions' diffs (fetched when shown)
//     → one lookup query per poll over the documents a page of digests touches gives the
//       cards their `$title`; an OQX filter (a `where` fragment over docs) narrows the
//       recent list and, through that same query, which arriving revisions are shown
//
// The data path is MCP only (lib/mcp-client.ts) through the dev proxy at the
// same-origin /mcp; the pure parts (cursor, digests → entries, which revisions
// to diff, hits under either envelope, the filter's queries and partition, diff
// lines) are lib/feed.ts.

import { LitElement, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { WhoAmI } from "webdevproxy";
import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/details/details.js";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import type SlSwitch from "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "./elements/oqx-framed-filter.ts";
import type { FilterDetail } from "./elements/oqx-framed-filter.ts";
import { OmgClient, OmgError, fetchWhoAmI } from "./lib/mcp-client.ts";
import {
  RECENT_LIMIT, advanceCursor, byline, createdDiff, diffLineKind, diffStats, digestPaths, filterStateAfter, formatTime, hiddenLine, latestPair, matchQuery, pairForCommit, partitionByFilter, pollMs, prependDigests, recentFromHits, recentQuery, startCursor, titlesByPath,
  type Digest, type DiffPair, type EntryChange, type FeedEntry, type FilterState, type RecentDoc,
} from "./lib/feed.ts";
import { LEGACY_SURFACE, surfaceOf } from "./lib/paths.ts";

const MCP_URL = "/mcp";
const REPO_KEY = "omgbase-live-tail.repo";
const POLL_KEY = "omgbase-live-tail.poll";
const FILTER_KEY = "omgbase-live-tail.filter";
const WRAP_KEY = "omgbase-live-tail.wrap";
/** How long after the last keystroke the filter is applied (Enter, blur and clear apply at once). */
const FILTER_DEBOUNCE_MS = 600;
const FILTER_PLACEHOLDER = 'status == "active"';
/** How many recent documents' diffs are fetched at once. */
const DIFF_CONCURRENCY = 4;
/** The first N recent cards start open; the rest open on click. */
const OPEN_RECENT = 3;

/** One diff, as far as it has got. */
export type DiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; pair: DiffPair; text: string }
  | { status: "none"; note: string }
  | { status: "error"; message: string };

// ---- state --------------------------------------------------------------------------

const connection = signal<"idle" | "connecting" | "sign-in" | "ok" | "error">("idle");
const connectionMessage = signal("");
const whoami = signal<WhoAmI | null>(null);
const surface = signal<string | null>(null);
const repos = signal<string[]>([]);
const repo = signal<string>(localStorage.getItem(REPO_KEY) ?? "");
const pollSeconds = signal<number>(pollMs(localStorage.getItem(POLL_KEY)) / 1000);
/** The OQX `where` fragment over docs the user typed (trimmed; "" = no filter). */
const filter = signal<string>((localStorage.getItem(FILTER_KEY) ?? "").trim());
/** Whether the server took the filter; `invalid` carries its message and hides nothing. */
const filterState = signal<FilterState>(filter.get() ? { kind: "on", filter: filter.get() } : { kind: "off" });
/** Digests the filter dropped since it was last changed. */
const hiddenCount = signal(0);
/** Word-wrap in every diff view. */
const wrap = signal<boolean>(localStorage.getItem(WRAP_KEY) === "1");

const recent = signal<RecentDoc[]>([]);
const recentLoading = signal(false);
/** Diffs by key: a recent card's document id/path, or `<commit>:<doc>` for a feed change. */
const diffs = signal<Record<string, DiffState>>({});

const entries = signal<FeedEntry[]>([]);
const live = signal(true);
const polling = signal(false);
const lastPoll = signal<string | null>(null);
const feedError = signal<string | null>(null);
const cursor = signal<number | null>(null);

const headerLabel = computed(() => {
  const w = whoami.get();
  if (!w) return `proxy at ${MCP_URL}`;
  if (w.mode === "remote") {
    let host = w.upstream;
    try { host = new URL(w.upstream).host; } catch { /* not a URL */ }
    const who = w.identity?.email ?? w.identity?.name ?? w.identity?.subject;
    return `via local proxy → ${host}${who ? ` · ${who}` : ""}`;
  }
  return `local · ${w.upstream}`;
});

// ---- the client ----------------------------------------------------------------------

const client = new OmgClient({
  url: MCP_URL,
  onSessionLost: () => { if (connection.get() === "ok") connectionMessage.set("session expired at the server — reconnected"); },
});

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setDiff(key: string, state: DiffState): void {
  diffs.set({ ...diffs.get(), [key]: state });
}

/** Fetch what a pair names: the unified diff between two revisions, or the created revision's content. */
async function fetchPair(doc: string, pair: DiffPair): Promise<DiffState> {
  const r = repo.get();
  if (pair.kind === "created") {
    // The content as a pure-addition diff: a content line starting with `-` is not a subtraction.
    const text = createdDiff((await client.docsReadAt(doc, pair.rev, r)).content);
    return text === "" ? { status: "none", note: "created empty" } : { status: "ready", pair, text };
  }
  const d = await client.diffUnified(doc, pair.from, pair.to, r);
  return d.diff === "" ? { status: "none", note: "no textual change between the two revisions" } : { status: "ready", pair, text: d.diff };
}

/** The diff for a document's latest change (a recent card). */
async function loadLatestDiff(doc: RecentDoc): Promise<void> {
  const key = doc.id ?? doc.path;
  setDiff(key, { status: "loading" });
  try {
    const history = await client.docsHistory(key, repo.get());
    const pair = history ? latestPair(history.versions) : null;
    if (!pair) { setDiff(key, { status: "none", note: "no stored revisions" }); return; }
    setDiff(key, await fetchPair(key, pair));
  } catch (e) {
    setDiff(key, { status: "error", message: describe(e) });
  }
}

/** The diff for one change of a feed entry: that commit's revision against its predecessor. */
async function loadChangeDiff(entry: FeedEntry, change: EntryChange): Promise<void> {
  const key = `${entry.key}:${change.doc}`;
  const current = diffs.get()[key];
  if (current && current.status !== "idle" && current.status !== "error") return;
  setDiff(key, { status: "loading" });
  try {
    const history = await client.docsHistory(change.doc, repo.get());
    const pair = history ? pairForCommit(history.versions, entry.key) : null;
    if (!pair) { setDiff(key, { status: "none", note: "this commit wrote no revision of the document (deleted or moved)" }); return; }
    setDiff(key, await fetchPair(change.doc, pair));
  } catch (e) {
    setDiff(key, { status: "error", message: describe(e) });
  }
}

let recentGeneration = 0;

/** The recent list under the current filter. This is also how the filter is
 * validated: a `filter_invalid` answer marks it invalid (its message shows
 * under the field, the list on screen is kept); any other answer marks it on. */
async function loadRecent(): Promise<void> {
  const generation = ++recentGeneration;
  const f = filter.get();
  recentLoading.set(true);
  try {
    const result = await client.query(recentQuery(f), repo.get(), RECENT_LIMIT);
    if (generation !== recentGeneration) return; // the filter or repo changed meanwhile
    filterState.set(filterStateAfter(f, null));
    const docs = recentFromHits(result.hits);
    recent.set(docs);
    // A few at a time: 25 documents are 50 calls.
    const queue = [...docs];
    await Promise.all(Array.from({ length: DIFF_CONCURRENCY }, async () => {
      for (let d = queue.shift(); d; d = queue.shift()) await loadLatestDiff(d);
    }));
  } catch (e) {
    if (generation !== recentGeneration) return;
    if (e instanceof OmgError && e.code === "filter_invalid") filterState.set(filterStateAfter(f, e));
    else feedError.set(`recent documents: ${describe(e)}`);
  } finally {
    if (generation === recentGeneration) recentLoading.set(false);
  }
}

/** A new filter: persist it, forget the hidden count, re-run the recent view
 * (which validates it). The feed's cursor is untouched — the filter is a view
 * over what arrives, not a position in the log. */
function applyFilter(value: string): void {
  const f = value.trim();
  if (f === filter.get()) return;
  filter.set(f);
  localStorage.setItem(FILTER_KEY, f);
  hiddenCount.set(0);
  if (f === "") filterState.set({ kind: "off" });
  if (connection.get() === "ok") void loadRecent();
}

/** The digests of one poll, looked up: ONE query over the documents they touch
 * (`matchQuery`) gives their `$title`s for the cards and, when the filter is
 * on, is narrowed to the documents it admits — revisions of the rest are
 * dropped and a digest left empty is counted as hidden. While the filter is
 * off or invalid everything passes; a `filter_invalid` answer here marks it
 * invalid too (the titles are then looked up unfiltered). */
async function lookupDigests(digests: Digest[]): Promise<{ digests: Digest[]; titles: Map<string, string | null> }> {
  const paths = digestPaths(digests);
  const state = filterState.get();
  const filter = state.kind === "on" ? state.filter : "";
  const q = matchQuery(filter, paths);
  if (q === null) return { digests, titles: new Map() };
  let titles: Map<string, string | null>;
  try {
    titles = titlesByPath((await client.query(q, repo.get(), paths.length)).hits);
  } catch (e) {
    if (!(e instanceof OmgError && e.code === "filter_invalid") || filter === "") throw e;
    filterState.set(filterStateAfter(filter, e));
    return lookupDigests(digests); // once more, unfiltered, for the titles
  }
  if (filter === "") return { digests, titles };
  const { kept, hidden } = partitionByFilter(digests, new Set(titles.keys()));
  if (hidden) hiddenCount.set(hiddenCount.get() + hidden);
  return { digests: kept, titles };
}

function setWrap(on: boolean): void {
  wrap.set(on);
  localStorage.setItem(WRAP_KEY, on ? "1" : "0");
}

// ---- the feed ------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let feedGeneration = 0;

function schedulePoll(delayMs = pollSeconds.get() * 1000): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, delayMs);
}

async function poll(): Promise<void> {
  if (!live.get() || polling.get() || connection.get() !== "ok") return;
  const generation = feedGeneration;
  polling.set(true);
  try {
    const c = cursor.get();
    const page = await client.changesSince(repo.get(), c ?? undefined);
    if (generation !== feedGeneration) return; // the repo changed meanwhile
    const next = advanceCursor(page);
    cursor.set(next.cursor);
    if (next.reset) feedError.set(`the cursor (${c}) was beyond this repo's head (${page.head}) — restarted from the head`);
    else feedError.set(null);
    let digests = page.digests;
    let titles: Map<string, string | null> | undefined;
    if (digests.length) {
      try {
        ({ digests, titles } = await lookupDigests(digests));
      } catch (e) {
        // The lookup failed for a reason other than the filter: say so and show the page unfiltered, paths only.
        feedError.set(`lookup: ${describe(e)}`);
      }
      if (generation !== feedGeneration) return;
    }
    if (digests.length) {
      const before = new Set(entries.get().map((e) => e.key));
      const merged = prependDigests(entries.get(), digests, titles);
      entries.set(merged);
      // New entries arrive open: fetch their diffs now.
      for (const e of merged) if (!before.has(e.key)) for (const ch of e.changes) void loadChangeDiff(e, ch);
    }
    lastPoll.set(new Date().toISOString());
    if (page.truncated) { polling.set(false); void poll(); return; }
  } catch (e) {
    if (generation === feedGeneration) feedError.set(`changes_since: ${describe(e)}`);
  } finally {
    polling.set(false);
  }
  if (generation === feedGeneration && live.get()) schedulePoll();
}

async function startFeed(): Promise<void> {
  feedGeneration++;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  entries.set([]);
  cursor.set(null);
  feedError.set(null);
  try {
    // One tiny call for the head: the feed starts at "now".
    const head = await client.changesSince(repo.get(), undefined, 1);
    cursor.set(startCursor(head));
    lastPoll.set(new Date().toISOString());
    if (live.get()) schedulePoll();
  } catch (e) {
    feedError.set(`changes_since: ${describe(e)}`);
  }
}

function setLive(on: boolean): void {
  live.set(on);
  if (on) void poll();
  else if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ---- connecting ----------------------------------------------------------------------

let whoamiPoll: ReturnType<typeof setTimeout> | null = null;

async function refreshWhoAmI(): Promise<WhoAmI | null> {
  try {
    const w = await fetchWhoAmI(MCP_URL);
    whoami.set(w);
    return w;
  } catch (e) {
    whoami.set(null);
    connection.set("error");
    connectionMessage.set(`the proxy did not answer /whoami: ${describe(e)} — is \`pnpm dev\` running?`);
    return null;
  }
}

/** While the proxy waits for the user's consent in their browser, poll it and connect once it is in. */
function watchSignIn(): void {
  if (whoamiPoll) clearTimeout(whoamiPoll);
  whoamiPoll = setTimeout(async () => {
    whoamiPoll = null;
    const w = await refreshWhoAmI();
    if (!w) return;
    if (w.auth.state === "waiting") { connectionMessage.set("waiting for sign-in in your browser"); watchSignIn(); }
    else if (w.auth.state === "error") { connection.set("error"); connectionMessage.set(`proxy sign-in failed: ${w.auth.error ?? "unknown error"}`); }
    else void connect();
  }, 1500);
}

async function connect(): Promise<void> {
  connection.set("connecting");
  connectionMessage.set("");
  const w = await refreshWhoAmI();
  if (!w) return;
  if (w.auth.state === "waiting") {
    connection.set("sign-in");
    connectionMessage.set("waiting for sign-in in your browser");
    watchSignIn();
    return;
  }
  try {
    const [{ repos: list }, v] = await Promise.all([client.repos(), client.version().then(surfaceOf, () => LEGACY_SURFACE)]);
    surface.set(v);
    repos.set(list.map((r) => r.slug));
    if (!list.some((r) => r.slug === repo.get())) repo.set(list[0]?.slug ?? "");
    localStorage.setItem(REPO_KEY, repo.get());
    connection.set("ok");
    connectionMessage.set(`${list.length} repo${list.length === 1 ? "" : "s"} · surface ${v}`);
    await refreshWhoAmI();
    await Promise.all([loadRecent(), startFeed()]);
  } catch (e) {
    const again = await refreshWhoAmI();
    if (again?.auth.state === "waiting") { connection.set("sign-in"); connectionMessage.set("waiting for sign-in in your browser"); watchSignIn(); return; }
    connection.set("error");
    connectionMessage.set(describe(e));
  }
}

function switchRepo(slug: string): void {
  repo.set(slug);
  localStorage.setItem(REPO_KEY, slug);
  recent.set([]);
  diffs.set({});
  void Promise.all([loadRecent(), startFeed()]);
}

// ---- the element ---------------------------------------------------------------------

@customElement("live-tail-app")
export class LiveTailApp extends SignalWatcher(LitElement) {
  static override styles = css`
    :host { display: block; font: 14px/1.45 system-ui, sans-serif; color: #222; max-width: 960px; margin: 0 auto; padding: 16px 20px 48px; box-sizing: border-box; }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 14px; }
    h1 { font-size: 18px; margin: 0; }
    .label { color: #5a6270; font-size: 13px; }
    .msg { color: #5a6270; font-size: 13px; }
    .msg.err { color: #b3261e; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: #e8eaef; color: #4a5160; }
    .pill.live { background: #e6f4ea; color: #1e6b2e; }
    .pill.live .dot { width: 8px; height: 8px; border-radius: 50%; background: #2e7d32; animation: blink 1.6s infinite; }
    .pill.paused { background: #fff3e0; color: #8a5a00; }
    .pill.polling .dot { background: #1565c0; animation: none; }
    .pill.invalid { background: #fdecea; color: #8c1d18; }
    @keyframes blink { 50% { opacity: 0.35; } }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-left: auto; font-size: 13px; }
    select, input { font: inherit; font-size: 13px; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; }
    input[type=number] { width: 4em; }
    button { font: inherit; font-size: 13px; padding: 3px 10px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; cursor: pointer; }
    button:hover { background: #f4f6fa; }
    .banner { padding: 8px 12px; border-radius: 6px; margin: 0 0 12px; font-size: 13px; }
    .banner.err { background: #fdecea; color: #8c1d18; border: 1px solid #f3c4c0; }
    .filterbar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0 0 12px; }
    .filterbar oqx-framed-filter { flex: 1 1 100%; }
    .filterbar .hint { flex: 1 0 100%; color: #6a7382; font-size: 12.5px; }
    .filterbar .hint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .filterbar .hint.err { color: #b3261e; }
    .hidden-line { color: #6a7382; font-size: 12.5px; margin: -4px 0 8px; }
    sl-switch { font-size: 13px; }
    sl-switch::part(label) { font-size: 13px; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #5a6270; margin: 22px 0 8px; }
    .empty { color: #6a7382; font-size: 13px; padding: 14px; border: 1px dashed #d4d8e0; border-radius: 6px; background: #fff; }
    .entry { background: #fff; border: 1px solid #e3e6ec; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
    .entry.fresh { animation: arrive 1.5s ease-out; }
    @keyframes arrive { from { box-shadow: 0 0 0 3px #a5d6a7; } to { box-shadow: 0 0 0 0 transparent; } }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; font-size: 13px; }
    .meta .time { font-variant-numeric: tabular-nums; color: #1565c0; font-weight: 600; }
    .meta .by { color: #5a6270; }
    .meta .seq { color: #8a94a6; font-size: 12px; }
    .summary { margin: 4px 0 6px; }
    .card { background: #fff; border: 1px solid #e3e6ec; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
    .card .title { font-weight: 600; }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #333; }
    .when { color: #5a6270; font-size: 12.5px; }
    sl-details { margin-top: 6px; }
    sl-details::part(base) { border: 1px solid #e8eaef; border-radius: 5px; background: #fafbfc; }
    sl-details::part(header) { padding: 5px 9px; font-size: 12.5px; }
    sl-details [slot=summary] { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
    sl-details .title { font-weight: 600; color: #222; }
    sl-details::part(content) { padding: 0; }
    .stats { margin-left: 8px; font-size: 12px; }
    .stats .add { color: #1e6b2e; }
    .stats .del { color: #b3261e; }
    .kind { margin-left: 8px; font-size: 11px; padding: 0 6px; border-radius: 9px; background: #e8eaef; color: #4a5160; }
    .kind.created { background: #e6f4ea; color: #1e6b2e; }
    pre { margin: 0; padding: 8px 10px; overflow-x: auto; white-space: pre; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #fff; border-top: 1px solid #e8eaef; }
    pre.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
    pre .add { background: #e6ffed; color: #1a4d1f; display: block; }
    pre .del { background: #ffeef0; color: #7a1c1c; display: block; }
    pre .hunk { color: #6f42c1; display: block; }
    pre .ctx { display: block; }
    .note { padding: 8px 10px; color: #6a7382; font-size: 12.5px; border-top: 1px solid #e8eaef; }
    .note.err { color: #b3261e; }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void connect();
  }

  override render() {
    const state = connection.get();
    const err = feedError.get();
    return html`
      <header>
        <h1>live tail</h1>
        <span class="label">${headerLabel.get()}${surface.get() ? ` · surface ${surface.get()}` : ""}</span>
        <span class="msg ${state === "error" ? "err" : ""}">${connectionMessage.get()}</span>
        <div class="controls">
          <label>repo
            <select .value=${repo.get()} @change=${(e: Event) => switchRepo((e.target as HTMLSelectElement).value)} ?disabled=${state !== "ok"}>
              ${repos.get().map((slug) => html`<option value=${slug} ?selected=${slug === repo.get()}>${slug}</option>`)}
            </select>
          </label>
          <label>every
            <input type="number" min="1" max="3600" .value=${String(pollSeconds.get())} @change=${(e: Event) => {
              const s = pollMs((e.target as HTMLInputElement).value) / 1000;
              pollSeconds.set(s);
              localStorage.setItem(POLL_KEY, String(s));
              (e.target as HTMLInputElement).value = String(s);
              if (live.get()) schedulePoll();
            }} /> s
          </label>
          <sl-switch size="small" ?checked=${wrap.get()} @sl-change=${(e: Event) => setWrap((e.target as SlSwitch).checked)}>wrap</sl-switch>
          <button @click=${() => setLive(!live.get())} ?disabled=${state !== "ok"}>${live.get() ? "pause" : "resume"}</button>
          ${this.renderPill()}
        </div>
      </header>
      ${this.renderFilter()}
      ${err ? html`<div class="banner err">${err}</div>` : nothing}

      <h2>changes since the page opened${entries.get().length ? ` (${entries.get().length})` : ""}</h2>
      ${hiddenLine(hiddenCount.get()) ? html`<div class="hidden-line">${hiddenLine(hiddenCount.get())}</div>` : nothing}
      ${entries.get().length
        ? repeat(entries.get(), (e) => e.key, (e) => this.renderEntry(e))
        : html`<div class="empty">${state === "ok"
            ? html`nothing yet — edit a document in <span class="path">${repo.get()}</span> and the commit appears here${cursor.get() !== null ? html` <span class="seq">(watching from seq ${cursor.get()})</span>` : nothing}`
            : "not connected"}</div>`}

      <h2>recently updated${recentLoading.get() ? " · loading…" : ""}</h2>
      ${recent.get().length
        ? repeat(recent.get(), (d) => d.id ?? d.path, (d, i) => this.renderRecent(d, i))
        : html`<div class="empty">${state === "ok" && !recentLoading.get() ? "no documents" : "…"}</div>`}
    `;
  }

  private renderPill() {
    const state = connection.get();
    if (state !== "ok") return html`<span class="pill">${state}</span>`;
    if (!live.get()) return html`<span class="pill paused">paused</span>`;
    const last = lastPoll.get();
    const title = last ? `last poll ${formatTime(last)}` : "";
    if (filterState.get().kind === "invalid") return html`<span class="pill invalid" title=${title}>filter invalid — showing everything</span>`;
    return html`<span class="pill live ${polling.get() ? "polling" : ""}" title=${title}><span class="dot"></span>live · ${pollSeconds.get()} s</span>`;
  }

  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  /** The OQX filter: the recent query with an editable `where` hole, applied on Enter, blur, clear, or a pause in typing. */
  private renderFilter() {
    const fs = filterState.get();
    const apply = (value: string) => { if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; } applyFilter(value); };
    return html`
      <div class="filterbar">
        <oqx-framed-filter .value=${filter.get()} ?invalid=${fs.kind === "invalid"} placeholder=${FILTER_PLACEHOLDER}
          @filter-input=${(e: CustomEvent<FilterDetail>) => {
            const { value } = e.detail;
            if (this.filterTimer) clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => { this.filterTimer = null; applyFilter(value); }, FILTER_DEBOUNCE_MS);
          }}
          @filter-change=${(e: CustomEvent<FilterDetail>) => apply(e.detail.value)}></oqx-framed-filter>
        ${fs.kind === "invalid"
          ? html`<span class="hint err">${fs.message}</span>`
          : html`<span class="hint">click into the query to add a <code>where</code> predicate — an OQX expression over <code>docs</code> such as <code>${FILTER_PLACEHOLDER}</code> or <code>$path.startsWith("/notes/")</code>; it narrows the recent list and what arrives from now on (Enter applies, Escape leaves)</span>`}
      </div>
    `;
  }

  private renderEntry(e: FeedEntry) {
    return html`
      <article class="entry fresh">
        <div class="meta">
          <span class="time">${formatTime(e.ts)}</span>
          <span class="by">${byline(e)}</span>
          <span class="seq">seq ${e.seq} · ${e.key}</span>
        </div>
        <div class="summary">${e.summary}</div>
        ${e.changes.map((ch) => this.renderDiff(`${e.key}:${ch.doc}`, ch.title === null ? html`<span class="path">${ch.path}</span>` : html`<span class="title">${ch.title}</span><span class="path">${ch.path}</span>`, true, () => loadChangeDiff(e, ch)))}
      </article>
    `;
  }

  private renderRecent(d: RecentDoc, index: number) {
    const key = d.id ?? d.path;
    return html`
      <article class="card">
        <div class="meta">
          <span class="title">${d.title ?? d.path}</span>
          <span class="path">${d.path}</span>
          <span class="when">${d.updatedAt ? `updated ${formatTime(d.updatedAt)}` : ""}</span>
        </div>
        ${this.renderDiff(key, html`<span class="path">latest change</span>`, index < OPEN_RECENT, () => loadLatestDiff(d))}
      </article>
    `;
  }

  /** A collapsible diff under `label` (a feed change's title + path, or a recent card's "latest change"); `load` runs when it is first shown (and again after an error). */
  private renderDiff(key: string, label: unknown, open: boolean, load: () => Promise<void>) {
    const state = diffs.get()[key] ?? { status: "idle" as const };
    const summary = state.status === "ready"
      ? state.pair.kind === "created"
        ? html`${label}<span class="kind created">created</span>${this.renderStats(state.text)}`
        : html`${label}${this.renderStats(state.text)}`
      : html`${label}${state.status === "loading" ? html`<span class="kind">loading…</span>` : nothing}`;
    return html`
      <sl-details ?open=${open} @sl-show=${() => { const s = diffs.get()[key]; if (!s || s.status === "idle" || s.status === "error") void load(); }}>
        <span slot="summary">${summary}</span>
        ${state.status === "ready"
          ? html`<pre class=${wrap.get() ? "wrap" : ""}>${state.text.split("\n").map((line) => html`<span class=${diffLineKind(line)}>${line}</span>`)}</pre>`
          : state.status === "none" ? html`<div class="note">${state.note}</div>`
          : state.status === "error" ? html`<div class="note err">${state.message}</div>`
          : html`<div class="note">${state.status === "loading" ? "fetching…" : "open to fetch"}</div>`}
      </sl-details>
    `;
  }

  private renderStats(diff: string) {
    const { added, removed } = diffStats(diff);
    return html`<span class="stats"><span class="add">+${added}</span> <span class="del">−${removed}</span></span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { "live-tail-app": LiveTailApp }
}
