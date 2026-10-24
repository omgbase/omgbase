// The page: one element composing the panes with module-level signals.
//
//   connect → (whoami: proxy mode + sign-in state) → version (surface ≥ 5.0, the
//   profile) + tools/list (what is served) → [repos, when listed] → the tree's
//   root level → the route (#doc=…) → the document (docs_read include_ids),
//   its links (two queries over `links`), its history (`revisions { … }`), the
//   live feed (changes_since polled) and the query console (query, query_syntax).
//   The graph: a document's neighbourhood (#doc=…&tab=graph) or an arbitrary
//   query's rows (#graph=<query>: the query re-run with limit 200, then ONE
//   `links … where _path in (…) and _dst_path in (…)` for the edges among them).
//   Writes: plan { effects, diffs: true } → confirm → execute { plan_id, effects };
//   a task checkbox: ONE apply { set _attrs.checked, expect: { content_hash } } →
//   re-read. Every write runs as a command on the shared `CommandLog`
//   (@omgbase/client): undo/redo is a compensating apply computed against the
//   repository's CURRENT state and refused when the block or key moved on.
//
// Everything runs on the MINIMAL tools profile (lib/tools.ts). The repository
// is a DESIGNATION, as in graph-ui: the header field (persisted; `?repo=` in the
// page URL seeds it), else the one the proxy was started for (`/whoami` `repo`,
// from `--repo`), else the server's default (no `repo` argument at all); `repos`
// is the one optional tool — a picker when it is listed. The data path is MCP
// only (lib/mcp-client.ts, the shared `OmgClient`) through the dev proxy at the
// same-origin /mcp.

import { LitElement, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { WhoAmI } from "webdevproxy";
import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/split-panel/split-panel.js";
import "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import "@shoelace-style/shoelace/dist/components/tab/tab.js";
import "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js";
import "./elements/repo-tree.ts";
import "./elements/doc-view.ts";
import "./elements/links-panel.ts";
import "./elements/query-console.ts";
import "./elements/history-panel.ts";
import "./elements/feed-strip.ts";
import "@omgbase/elements";
import type {
  GraphConnectDetail, GraphConnectEmptyDetail, GraphEdgeDeleteDetail, GraphEdgeSelectDetail, GraphIdDetail, GraphPinDetail, GraphSelectDetail, GraphUnpinDetail,
  PaletteAction, PaletteItem, RelationKindItem, RelationPickDetail,
} from "@omgbase/elements";
import { findQuery, itemsFor, parseInput } from "@omgbase/elements/palette";
import { DEFAULT_LIMIT as GRAPH_LIMIT, GRAPH_QUERY_LIMIT, collapseNode, emptyModel, fetchDocLinks, fetchFields, fetchLinksAmong, invalidateFields, listFieldsOf, queryModel, setPin, toView, withNeighborhood, type GraphModel } from "./lib/graph.ts";
import { CARDS_KEY, CARD_KEY, DEFAULT_CARD, allCardFields, computedFields, parseCardSettings, serializeCardSettings, templateFor, valuesPresent, type CardSettings } from "./lib/cards.ts";
import { collapseCommand, expandCommand, pinCommand, unpinCommand, type ModelAccessor } from "./lib/graph-commands.ts";
import type { TreeOpenDetail, TreeToggleDetail } from "./elements/repo-tree.ts";
import type { DocViewMode, OpenDocDetail, OpenWikiDetail, TaskPending, TaskToggleDetail, ViewChangeDetail, WritePlanDetail } from "./elements/doc-view.ts";
import type { ConsoleOpenDetail, ConsoleRunDetail } from "./elements/query-console.ts";
import type { HistorySelectDetail } from "./elements/history-panel.ts";
import {
  CommandLog, attachRelationCommand, createDocumentCommand, creationError, defaultMarkdown, describeDetach, describeRelation, detachRelationCommand, fieldCounts, relationKinds, taskCheckCommand,
  type HistoryEntry, type RelationKind,
} from "@omgbase/client";
import { OmgClient, OmgError, fetchWhoAmI, type Wire } from "./lib/mcp-client.ts";
import { MOVED_ON_MESSAGE, isMovedOn } from "./lib/tasks.ts";
import { docLocator, profileOf, surfaceOf, surfaceProblem } from "./lib/paths.ts";
import { capabilities, missingToolsText, profileLabel, type Capabilities } from "./lib/tools.ts";
import { fetchLevel, prefixesToOpen, type LevelState } from "./lib/tree.ts";
import { fetchDocument, fetchDocumentAt, splitFrontmatter, type DocAt, type DocRead } from "./lib/document.ts";
import { renderBody, type Rendered } from "./lib/markdown.ts";
import { fetchLinks, resolveWikilink, type DocLinks } from "./lib/links.ts";
import { STARTER_QUERY, canGraph, describeToolError, fetchSyntax, footerText, locatorQuery, nextPage, runConsole, type CellLink, type ToolErrorInfo } from "./lib/console.ts";
import { runQuery, type QueryOptions, type QueryResult } from "./lib/query.ts";
import { deletedRevisionsQuery, fetchDeleted, fetchRevisions, revisionsQuery, type DeletedDoc, type RevisionRow } from "./lib/history.ts";
import { advanceCursor, fetchChanges, pollMs, prependDigests, startCursor, touchedPaths, type FeedEntry } from "./lib/feed.ts";
import { frontmatterPlanCommand, parseValue, planEffects, setFrontmatterEffect, unsetFrontmatterEffect, type Plan } from "./lib/writes.ts";
import { DEFAULT_ROUTE, graphRoute, openDocRoute, parseRoute, routeHash, type Route, type Tab } from "./lib/route.ts";
import { effect } from "./lib/effect.ts";
import { hitPath, rooted } from "./lib/paths.ts";

const MCP_URL = "/mcp";
const REPO_KEY = "omgbase-repo-explorer.repo";
const QUERY_KEY = "omgbase-repo-explorer.query";
const VIEW_KEY = "omgbase-repo-explorer.view";
const POLL_KEY = "omgbase-repo-explorer.poll";
const SPLIT_KEY = "omgbase-repo-explorer.split";
const CONSOLE_KEY = "omgbase-repo-explorer.console";
const CONSOLE_SPLIT_KEY = "omgbase-repo-explorer.console-split";

// ---- state --------------------------------------------------------------------------

const connection = signal<"idle" | "connecting" | "sign-in" | "ok" | "error">("idle");
const connectionMessage = signal("");
const whoami = signal<WhoAmI | null>(null);
const surface = signal<string | null>(null);
const profile = signal<string | null>(null);
const tools = signal<string[] | null>(null);
const caps = computed<Capabilities>(() => capabilities(tools.get()));
const repos = signal<string[]>([]);
/** The user's repository designation (the header field; `?repo=` in the page URL seeds it), "" = none. */
const repoOverride = signal<string>(repoFromUrl() ?? localStorage.getItem(REPO_KEY) ?? "");
/** The repo slug passed to every repo-scoped tool: the override, else the proxy's `--repo`, else "" (the server's default). */
const repoInUse = computed<string>(() => repoOverride.get() || whoami.get()?.repo || "");
const repoArgValue = computed<string | null>(() => repoInUse.get() || null);

function repoFromUrl(): string | null {
  try { return new URL(location.href).searchParams.get("repo")?.trim() || null; } catch { return null; }
}
/** Writes are possible when plan + execute are listed. */
const canWrite = computed<boolean>(() => { const t = tools.get(); return t === null || (t.includes("plan") && t.includes("execute")); });
/** Task checkboxes toggle when `apply` is listed (read-only servers render them disabled, saying why). */
const canApply = computed<boolean>(() => { const t = tools.get(); return t === null || t.includes("apply"); });

const route = signal<Route>(parseRoute(location.hash));

const levels = signal<Map<string, LevelState>>(new Map());
const open = signal<Set<string>>(new Set(["/"]));

const doc = signal<DocRead | null>(null);
const docError = signal<string | null>(null);
const docLoading = signal(false);
const rendered = signal<Rendered | null>(null);
const view = signal<DocViewMode>(localStorage.getItem(VIEW_KEY) === "raw" ? "raw" : "rendered");
const links = signal<DocLinks | null>(null);
const linksError = signal<string | null>(null);

const revisions = signal<RevisionRow[] | null>(null);
const historyError = signal<string | null>(null);
const at = signal<DocAt | null>(null);
const atLoading = signal(false);
const deleted = signal<DeletedDoc[] | null>(null);
const deletedError = signal<string | null>(null);

const consoleQuery = signal<string>(localStorage.getItem(QUERY_KEY) ?? STARTER_QUERY);
const consoleResult = signal<QueryResult | null>(null);
/** The query the last result came from (the textarea may have been edited since). */
const consoleRan = signal<string | null>(null);
const consoleRows = signal<Record<string, unknown>[]>([]);
const consoleError = signal<ToolErrorInfo | null>(null);
const consoleRunning = signal(false);
const consoleOpts = signal<QueryOptions>({});
const syntax = signal<string | null>(null);
/** The console is a collapsible drawer under the main pane: closed, it is one bar. */
const consoleOpen = signal<boolean>(localStorage.getItem(CONSOLE_KEY) === "open");
const consoleSplit = signal<number>(Number(localStorage.getItem(CONSOLE_SPLIT_KEY) ?? 62) || 62);

const feed = signal<FeedEntry[]>([]);
const feedLive = signal(true);
const feedPolling = signal(false);
const feedCursor = signal<number | null>(null);
const feedError = signal<string | null>(null);
const pollSeconds = signal<number>(pollMs(localStorage.getItem(POLL_KEY)) / 1000);

const pendingPlan = signal<Plan | null>(null);
const writing = signal(false);
const writeMessage = signal<{ kind: "error" | "info"; text: string; fix?: string | null } | null>(null);

/** The task write in flight (a toggle or a compensation), or null. */
const taskPending = signal<TaskPending | null>(null);
/** Bumped on every command-log event so the computed labels below re-read the log. */
const logVersion = signal(0);
const undoLabel = computed(() => { logVersion.get(); const e = log.nextUndo; return e ? `undo: ${e.label}` : null; });
const redoLabel = computed(() => { logVersion.get(); const e = log.nextRedo; return e ? `redo: ${e.label}` : null; });

const splitPosition = signal<number>(Number(localStorage.getItem(SPLIT_KEY) ?? 24) || 24);

/** The command palette (⌘K): find a document by path or title (one `query` per
 * keystroke, debounced in the element), `>` for the page's actions, `+` to create. */
const paletteOpen = signal(false);
const paletteText = signal("");
const paletteItems = signal<PaletteItem[]>([]);
const paletteLoading = signal(false);
const paletteError = signal<string | null>(null);
const paletteMode = signal<"navigate" | "pick">("navigate");
const paletteHeading = signal<string | null>(null);
/** Pick mode's caller (the graph's find-or-create destination): resolved with the picked item, or null when the palette closes. */
let palettePick: ((item: PaletteItem | null) => void) | null = null;

/** The graph tab: the open document's neighbourhood (lib/graph.ts), expanded node
 * by node; pins are presentation state on the model, every change a command on
 * the log (so ⌘Z undoes a drop or an expansion like a write). */
const graph = signal<GraphModel | null>(null);
const graphSelected = signal<string | null>(null);
const graphBusy = signal(false);
const graphError = signal<string | null>(null);
/** A connector in progress: its source and destination, the relation kinds the rendered graph offers (the picker's rows) and where to show the picker (the drop point). */
const relationPick = signal<{ from: string; to: string; toTitle: string | null; kinds: RelationKindItem[]; anchor: { x: number; y: number } | null } | null>(null);
/** The edge selected in the graph (`graph-edge-select`), by its model key; its ✕ or Delete severs it. */
const graphSelectedEdge = signal<string | null>(null);
const graphModel: ModelAccessor = { get: () => graph.get() ?? emptyModel("/"), set: (m) => graph.set(m) };
/** The card templates (`<omg-graph>`'s template language): a default, optionally varied by a row field of the user's choosing, persisted as JSON (lib/cards.ts). */
const graphCards = signal<CardSettings>(parseCardSettings(localStorage.getItem(CARDS_KEY)));
/** The fields every template reads — what the rows are fetched with. */
const graphFields = computed(() => allCardFields(graphCards.get()));
/** The per-type editor open. */
const graphCardsOpen = signal(false);

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
  clientInfo: { name: "omgbase-repo-explorer", version: "0.0.0" },
  onSessionLost: () => { if (connection.get() === "ok") connectionMessage.set("session expired at the server — reconnected"); },
});

/** The session's commands (@omgbase/client): every write the page makes, with its compensating undo. In memory only. */
const log = new CommandLog({ client });
log.subscribe(() => logVersion.set(logVersion.get() + 1));

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setRoute(r: Route): void {
  const hash = routeHash(r);
  if (location.hash !== hash) location.hash = hash; // the hashchange listener sets the signal
  else route.set(r);
}

function openDoc(path: string, opts: { keepTab?: boolean; block?: string | null } = {}): void {
  setRoute(openDocRoute(route.get(), rooted(path), opts));
}

// ---- the tree --------------------------------------------------------------------------

async function loadLevel(prefix: string): Promise<void> {
  const current = levels.get().get(prefix);
  if (current && current.status !== "error") return;
  levels.set(new Map(levels.get()).set(prefix, { status: "loading" }));
  try {
    const level = await fetchLevel(client, prefix, repoArgValue.get());
    levels.set(new Map(levels.get()).set(prefix, { status: "ready", level }));
  } catch (e) {
    levels.set(new Map(levels.get()).set(prefix, { status: "error", message: describe(e) }));
  }
}

function toggleLevel(prefix: string, on: boolean): void {
  const next = new Set(open.get());
  if (on) next.add(prefix); else next.delete(prefix);
  open.set(next);
  if (on) void loadLevel(prefix);
}

/** Open every folder above a document and load them. */
function revealPath(path: string): void {
  const next = new Set(open.get());
  for (const p of prefixesToOpen(path)) { next.add(p); void loadLevel(p); }
  open.set(next);
}

/** After a write or a feed digest touched documents: reload their folders' levels (counts change). */
function refreshLevels(paths: readonly string[]): void {
  const prefixes = new Set(paths.flatMap((p) => prefixesToOpen(p)));
  const next = new Map(levels.get());
  for (const p of prefixes) if (open.get().has(p)) next.delete(p);
  levels.set(next);
  for (const p of prefixes) if (open.get().has(p)) void loadLevel(p);
}

// ---- the document ----------------------------------------------------------------------

let docGeneration = 0;

async function loadDocument(path: string): Promise<void> {
  const gen = ++docGeneration;
  docLoading.set(true);
  docError.set(null);
  links.set(null);
  linksError.set(null);
  revisions.set(null);
  historyError.set(null);
  at.set(null);
  pendingPlan.set(null);
  writeMessage.set(null);
  if (graph.get()?.root !== path) { graph.set(null); relationPick.set(null); graphSelectedEdge.set(null); }
  try {
    const d = await fetchDocument(client, docLocator(path), repoArgValue.get());
    if (gen !== docGeneration) return;
    doc.set(d);
    if (route.get().tab === "graph" && graph.get()?.root !== path) void loadGraph(path);
    rendered.set(null);
    const r = await renderBody(splitFrontmatter(d.raw).body, d.blockIds, { canApply: canApply.get() });
    if (gen !== docGeneration) return;
    rendered.set(r);
    void loadLinks(d.path, gen);
    void loadHistory(d.id, gen);
  } catch (e) {
    if (gen !== docGeneration) return;
    doc.set(null);
    rendered.set(null);
    docError.set(describe(e));
  } finally {
    if (gen === docGeneration) docLoading.set(false);
  }
}

async function loadLinks(path: string, gen: number): Promise<void> {
  try {
    const l = await fetchLinks(client, path, repoArgValue.get());
    if (gen === docGeneration) links.set(l);
  } catch (e) {
    if (gen === docGeneration) linksError.set(describe(e));
  }
}

async function loadHistory(docId: string, gen: number): Promise<void> {
  try {
    const rows = await fetchRevisions(client, docId, repoArgValue.get());
    if (gen !== docGeneration) return;
    revisions.set(rows);
    const rev = route.get().rev;
    if (rev) void loadAt(rev, gen);
  } catch (e) {
    if (gen === docGeneration) historyError.set(describe(e));
  }
}

async function loadAt(rev: string, gen: number): Promise<void> {
  const d = doc.get();
  if (!d) return;
  atLoading.set(true);
  at.set(null);
  try {
    const r = await fetchDocumentAt(client, { _id: d.id }, rev, repoArgValue.get());
    if (gen === docGeneration) at.set(r);
  } catch (e) {
    if (gen === docGeneration) historyError.set(describe(e));
  } finally {
    if (gen === docGeneration) atLoading.set(false);
  }
}

async function loadDeleted(): Promise<void> {
  deleted.set(null);
  deletedError.set(null);
  try {
    deleted.set(await fetchDeleted(client, repoArgValue.get()));
  } catch (e) {
    deletedError.set(describe(e));
  }
}

async function openWiki(name: string): Promise<void> {
  try {
    const paths = await resolveWikilink(client, name, repoArgValue.get());
    if (paths.length === 0) { docError.set(`[[${name}]] names no document (a dangling wikilink)`); return; }
    const first = paths[0]!;
    openDoc(first);
    if (paths.length > 1) writeMessage.set({ kind: "info", text: `[[${name}]] matched ${paths.length} documents; opened ${first}` });
  } catch (e) {
    docError.set(describe(e));
  }
}

// ---- the console -------------------------------------------------------------------------

async function runConsoleQuery(query: string, opts: QueryOptions, append: boolean): Promise<void> {
  consoleRunning.set(true);
  consoleError.set(null);
  try {
    const r = await runConsole(client, query, opts);
    consoleResult.set(r);
    consoleRan.set(query);
    consoleRows.set(append ? [...consoleRows.get(), ...r.hits] : r.hits);
    consoleOpts.set(opts);
  } catch (e) {
    consoleError.set(describeToolError(e));
    if (!append) { consoleResult.set(null); consoleRan.set(null); consoleRows.set([]); }
  } finally {
    consoleRunning.set(false);
  }
}

function onConsoleRun(query: string): void {
  consoleQuery.set(query);
  consoleOpen.set(true);
  void runConsoleQuery(query, { repo: repoArgValue.get() }, false);
}

function toggleConsole(open = !consoleOpen.get()): void {
  consoleOpen.set(open);
}

/** The console's "graph" (or `>graph these rows`): the LAST RUN query's rows as a
 * graph, through the route (`#graph=<query>`, so it is a link one can reload or
 * share). The same query again re-runs it. */
function graphConsoleRows(): void {
  const q = consoleRan.get() ?? consoleQuery.get();
  if (!q.trim()) return;
  appliedGraphQuery = null;
  setRoute(graphRoute(q));
}

/** The graph toolbar's query line clicked: the query into the console, the drawer open. */
function queryToConsole(query: string): void {
  consoleQuery.set(query);
  consoleOpen.set(true);
}

function onConsoleMore(): void {
  const r = consoleResult.get();
  if (!r) return;
  const next = nextPage(r, consoleOpts.get());
  if (next) void runConsoleQuery(consoleQuery.get(), next, true);
}

async function loadSyntax(): Promise<void> {
  if (syntax.get() !== null) return;
  try { syntax.set(await fetchSyntax(client)); } catch (e) { syntax.set(`query_syntax failed: ${describe(e)}`); }
}

/** A clicked cell: a path opens the document; an id is located with one query (lib/console.ts). */
async function openLink(link: CellLink): Promise<void> {
  if (link.kind === "doc") { openDoc(link.path); return; }
  if (link.of === "doc") { openDoc(link.id); return; }
  const q = locatorQuery(link.id);
  if (!q) return;
  try {
    const r = await runQuery(client, q, { repo: repoArgValue.get(), limit: 1 });
    const hit = r.hits[0];
    const path = hitPath(hit);
    if (!hit || path === null) { consoleError.set({ code: "not_found", message: `${link.id} names no live row`, fix: null, hint: null, retriable: false }); return; }
    if (link.of === "revision") setRoute({ ...openDocRoute(route.get(), rooted(path)), rev: link.id, tab: "history" });
    else openDoc(path, { block: link.of === "block" ? link.id : null });
  } catch (e) {
    consoleError.set(describeToolError(e));
  }
}

// ---- the feed -------------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let feedGeneration = 0;

function schedulePoll(delayMs = pollSeconds.get() * 1000): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, delayMs);
}

async function poll(): Promise<void> {
  if (!feedLive.get() || feedPolling.get() || connection.get() !== "ok") return;
  const gen = feedGeneration;
  feedPolling.set(true);
  try {
    const c = feedCursor.get();
    const page = await fetchChanges(client, repoArgValue.get(), c);
    if (gen !== feedGeneration) return;
    const next = advanceCursor(page);
    feedCursor.set(next.cursor);
    feedError.set(next.reset ? `the cursor (${c}) was beyond this repo's head (${page.head}) — restarted from the head` : null);
    if (page.digests.length) {
      feed.set(prependDigests(feed.get(), page.digests));
      const touched = touchedPaths(page.digests);
      refreshLevels(touched.length ? touched : ["/"]);
      // The open document changed under us (or was deleted): reload it.
      const d = doc.get();
      if (d && (touched.includes(d.path) || page.digests.some((dg) => dg.revisions.length === 0))) void loadDocument(d.path);
    }
    if (page.truncated) { feedPolling.set(false); void poll(); return; }
  } catch (e) {
    if (gen === feedGeneration) feedError.set(`changes_since: ${describe(e)}`);
  } finally {
    feedPolling.set(false);
  }
  if (gen === feedGeneration && feedLive.get()) schedulePoll();
}

async function startFeed(): Promise<void> {
  feedGeneration++;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  feed.set([]);
  feedCursor.set(null);
  feedError.set(null);
  try {
    const head = await fetchChanges(client, repoArgValue.get(), null, 1);
    feedCursor.set(startCursor(head));
    if (feedLive.get()) schedulePoll();
  } catch (e) {
    feedError.set(`changes_since: ${describe(e)}`);
  }
}

function setLive(on: boolean): void {
  feedLive.set(on);
  if (on) void poll();
  else if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ---- writes ---------------------------------------------------------------------------------

async function planFrontmatter(detail: WritePlanDetail): Promise<void> {
  const d = doc.get();
  if (!d) return;
  writing.set(true);
  writeMessage.set(null);
  pendingPlan.set(null);
  try {
    const effect = detail.unset ? unsetFrontmatterEffect(d.path, detail.key) : setFrontmatterEffect(d.path, detail.key, parseValue(detail.value));
    pendingPlan.set(await planEffects(client, [effect], repoArgValue.get()));
  } catch (e) {
    const info = describeToolError(e);
    writeMessage.set({ kind: "error", text: `plan: ${info.code} — ${info.message}`, fix: info.fix });
  } finally {
    writing.set(false);
  }
}

/** The confirmed plan commits as a command on the log, so it can be undone (a
 * compensating `set`/`unset` of the key, refused when the key moved on since). */
async function executePending(): Promise<void> {
  const plan = pendingPlan.get();
  const d = doc.get();
  if (!plan || !d) return;
  const first = plan.effects[0] ?? {};
  const key = typeof first.field === "string" ? first.field.replace(/^_frontmatter\./, "") : "";
  const fm = d.properties.frontmatter;
  const existed = Object.prototype.hasOwnProperty.call(fm, key);
  writing.set(true);
  try {
    const entry = await log.run(frontmatterPlanCommand({
      plan, path: d.path, key, value: first.op === "unset" ? undefined : first.value, previous: fm[key], existed,
      repo: repoArgValue.get(), reason: "repo-explorer frontmatter edit",
    }));
    if (entry.state !== "applied") throw entry.error;
    const receipt = entry.steps[0]?.applied?.receipts[0];
    pendingPlan.set(null);
    writeMessage.set({ kind: "info", text: receipt?.commit ? `committed ${receipt.commit}: ${receipt.summary.join("; ")} — undo with the button or ⌘Z` : "nothing to commit" });
    await loadDocument(d.path);
    refreshLevels([d.path]);
  } catch (e) {
    const info = describeToolError(e);
    writeMessage.set({ kind: "error", text: `execute: ${info.code} — ${info.message}${info.retriable ? " (retriable: plan again)" : ""}`, fix: info.fix });
    if (e instanceof OmgError && (e.code === "stale_plan" || e.code === "plan_mismatch")) pendingPlan.set(null);
  } finally {
    writing.set(false);
  }
}

// ---- task checkboxes and the command log ------------------------------------------------------

/** The document re-read after a write: the open document reloaded (so the
 * rendering, property table, history and links are the truth again) when it is
 * the one written, else nothing (its folder's counts are refreshed either way). */
async function rereadAfterWrite(path: string): Promise<void> {
  if (doc.get()?.path === path) await loadDocument(path);
  refreshLevels([path]);
}

/** A checkbox changed: ONE `apply` with `set _attrs.checked` pinned to the
 * block's hash from the read, as the shared `taskCheckCommand` on the log (its
 * undo re-reads the block's hash and refuses when it is not the one the toggle
 * left); then re-read. */
async function toggleTask(detail: TaskToggleDetail): Promise<void> {
  const d = doc.get();
  if (!d || taskPending.get() || !canApply.get()) return;
  taskPending.set({ blockId: detail.blockId, checked: detail.checked });
  writeMessage.set(null);
  const verb = detail.checked ? "check" : "uncheck";
  try {
    const entry = await log.run(taskCheckCommand({
      blockId: detail.blockId, checked: detail.checked, contentHash: detail.contentHash, repo: repoArgValue.get(),
      label: `${verb} ${detail.blockId} in ${d.path}`,
    }));
    await rereadAfterWrite(d.path);
    if (entry.state !== "applied") throw entry.error;
    const receipt = entry.steps[0]?.applied?.receipts[0];
    writeMessage.set({ kind: "info", text: receipt?.commit ? `${verb}ed ${detail.blockId}: committed ${receipt.commit} (${receipt.summary.join("; ")}) — undo with the button or ⌘Z` : `nothing to commit (${detail.blockId} already ${detail.checked ? "checked" : "unchecked"})` });
  } catch (e) {
    if (isMovedOn(e)) writeMessage.set({ kind: "error", text: `${e.code}: ${MOVED_ON_MESSAGE}` });
    else {
      const info = describeToolError(e);
      writeMessage.set({ kind: "error", text: `apply: ${info.code} — ${info.message}`, fix: info.fix });
    }
  } finally {
    taskPending.set(null);
  }
}

/** The documents a log entry touched (its receipts' revisions), rooted. */
function touchedByEntry(entry: HistoryEntry): string[] {
  const paths = new Set<string>();
  for (const step of entry.steps) for (const r of step.applied?.revisions ?? []) paths.add(rooted(r._path));
  for (const r of entry.compensation?.revisions ?? []) paths.add(rooted(r._path));
  return [...paths];
}

/** Undo (or redo) the last command on the log: a compensating `apply` computed
 * against the repository's CURRENT state — refused, with the reason shown, when
 * what the command wrote has moved on since. Local commands (pins, views) just
 * restore state. */
async function compensate(dir: "undo" | "redo"): Promise<void> {
  const next = dir === "undo" ? log.nextUndo : log.nextRedo;
  if (!next || taskPending.get()) return;
  if (next.kind === "repository" && !canApply.get()) return;
  if (next.kind === "repository") taskPending.set({ blockId: "", checked: false });
  writeMessage.set(null);
  try {
    const entry = dir === "undo" ? await log.undo() : await log.redo();
    if (!entry) return;
    const touched = touchedByEntry(entry);
    for (const p of touched) await rereadAfterWrite(p);
    if (entry.state === "refused") { writeMessage.set({ kind: "error", text: `${dir} refused — ${entry.refusal ?? "the repository moved on"}; nothing was overwritten` }); return; }
    if (entry.error) throw entry.error;
    if (entry.kind !== "repository") return;
    const commit = dir === "undo" ? entry.compensation?.commit : entry.steps[entry.steps.length - 1]?.applied?.receipts[0]?.commit;
    writeMessage.set({ kind: "info", text: `${dir}: ${entry.label} — committed ${commit ?? "nothing"}` });
  } catch (e) {
    if (isMovedOn(e)) writeMessage.set({ kind: "error", text: `${dir} refused — ${e.code}: the document changed between the check and the write; nothing was overwritten` });
    else {
      const info = describeToolError(e);
      writeMessage.set({ kind: "error", text: `${dir}: ${info.code} — ${info.message}`, fix: info.fix });
    }
  } finally {
    taskPending.set(null);
  }
}

// ---- the palette -------------------------------------------------------------------------------

const PALETTE_LIMIT = 20;
let paletteGeneration = 0;

/** The actions `>` offers, for the page as it is now. */
function paletteActions(): PaletteAction[] {
  const r = route.get();
  const d = doc.get();
  const out: PaletteAction[] = [
    { id: "console", label: consoleOpen.get() ? "collapse the query console" : "expand the query console", shortcut: "⌘J", keywords: ["oqx", "query", "drawer"] },
    { id: "console-run", label: "run the console query", hint: consoleQuery.get().replace(/\s+/g, " ").trim().slice(0, 60), shortcut: "⌘⏎", keywords: ["oqx", "query"] },
    ...(canGraph(consoleResult.get()) && consoleRan.get() ? [{ id: "console-graph", label: "graph these rows", hint: consoleRan.get()!.replace(/\s+/g, " ").trim().slice(0, 60), keywords: ["graph", "query", "rows", "links"] } satisfies PaletteAction] : []),
    { id: "create", label: "new document…", hint: d ? `in ${d.path.slice(0, d.path.lastIndexOf("/") + 1)}` : "at /", shortcut: "+", keywords: ["create", "add"] },
    { id: "deleted", label: "deleted documents", hint: "revisions { _doc == null }", keywords: ["history", "removed"] },
    { id: "feed", label: feedLive.get() ? "pause the live strip" : "resume the live strip", keywords: ["changes_since", "poll"] },
    { id: "reconnect", label: "reconnect", keywords: ["version", "tools"] },
  ];
  if (undoLabel.get()) out.push({ id: "undo", label: undoLabel.get()!, shortcut: "⌘Z" });
  if (redoLabel.get()) out.push({ id: "redo", label: redoLabel.get()!, shortcut: "⇧⌘Z" });
  if (d) {
    out.push({ id: "view", label: view.get() === "raw" ? "show the rendered document" : "show the raw source", keywords: ["markdown", "raw", "rendered"] });
    for (const tab of ["document", "history", "links", "graph"] as const) if (tab !== r.tab) out.push({ id: `tab:${tab}`, label: `${tab} of ${d.path}`, keywords: ["tab", tab] });
  }
  return out;
}

function openPalette(mode: "navigate" | "pick" = "navigate", heading: string | null = null, text = ""): void {
  paletteMode.set(mode);
  paletteHeading.set(heading);
  paletteText.set(text);
  paletteError.set(null);
  paletteOpen.set(true);
}

function closePalette(): void {
  paletteOpen.set(false);
  paletteLoading.set(false);
  const resolve = palettePick;
  palettePick = null;
  resolve?.(null);
}

/** The graph's find-or-create destination: the palette in pick mode; the picked item, or null when dismissed. */
export function pickDestination(heading: string): Promise<PaletteItem | null> {
  const previous = palettePick;
  previous?.(null);
  return new Promise((resolve) => {
    palettePick = resolve;
    openPalette("pick", heading);
  });
}

async function paletteSearch(text: string): Promise<void> {
  paletteText.set(text);
  const input = parseInput(text);
  const gen = ++paletteGeneration;
  const ctx = { actions: paletteActions(), currentDoc: doc.get()?.path ?? null };
  if (input.kind !== "find") { paletteItems.set(itemsFor(input, { ...ctx, docs: [] })); paletteLoading.set(false); return; }
  paletteLoading.set(true);
  paletteError.set(null);
  try {
    const r = await client.query(findQuery(input.text, PALETTE_LIMIT), { repo: repoArgValue.get(), limit: PALETTE_LIMIT });
    if (gen !== paletteGeneration) return;
    paletteItems.set(itemsFor(input, { ...ctx, docs: r.hits }));
  } catch (e) {
    if (gen !== paletteGeneration) return;
    paletteError.set(describeToolError(e).message);
    paletteItems.set(itemsFor(input, { ...ctx, docs: [] }));
  } finally {
    if (gen === paletteGeneration) paletteLoading.set(false);
  }
}

/** `+path` or the create suggestion: ONE `apply { create }` as a command on the log
 * (its undo removes the document, refused when it was edited since), then open it. */
async function createDocument(path: string): Promise<void> {
  if (!canApply.get()) { paletteError.set("read-only: this server does not list `apply`"); return; }
  paletteLoading.set(true);
  paletteError.set(null);
  try {
    const entry = await log.run(createDocumentCommand({ path, markdown: defaultMarkdown(path), repo: repoArgValue.get() }));
    if (entry.state !== "applied") { paletteError.set(creationError(entry.error, path)); return; }
    const receipt = entry.steps[0]?.applied?.receipts[0];
    closePalette();
    refreshLevels([path]);
    openDoc(path);
    writeMessage.set({ kind: "info", text: `created ${path}${receipt?.commit ? ` — committed ${receipt.commit}` : ""} — undo with the button or ⌘Z` });
  } finally {
    paletteLoading.set(false);
  }
}

function runPaletteAction(id: string): void {
  closePalette();
  const r = route.get();
  switch (id) {
    case "console": toggleConsole(); return;
    case "console-run": onConsoleRun(consoleQuery.get()); return;
    case "console-graph": graphConsoleRows(); return;
    case "create": { const d = doc.get(); openPalette("navigate", null, `+${d ? d.path.slice(0, d.path.lastIndexOf("/") + 1) : "/"}`); return; }
    case "deleted": setRoute({ ...DEFAULT_ROUTE, deleted: true }); return;
    case "feed": setLive(!feedLive.get()); return;
    case "reconnect": void connect(); return;
    case "undo": void compensate("undo"); return;
    case "redo": void compensate("redo"); return;
    case "view": view.set(view.get() === "raw" ? "rendered" : "raw"); return;
    default:
      if (id.startsWith("tab:") && r.doc) setRoute({ ...r, tab: id.slice(4) as Tab });
  }
}

function onPaletteSelect(item: PaletteItem): void {
  if (paletteMode.get() === "pick") {
    const resolve = palettePick;
    palettePick = null;
    paletteOpen.set(false);
    resolve?.(item);
    return;
  }
  switch (item.kind) {
    case "doc": closePalette(); openDoc(item.path); return;
    case "action": runPaletteAction(item.id); return;
    case "create": void createDocument(item.path); return;
  }
}

// ---- the graph ----------------------------------------------------------------------------------

let graphGeneration = 0;

/** The neighbourhood of `path` added to `model`: its links (two `links` queries), then the rows the model lacks (one `docs` query over the cards' fields). */
async function expanded(model: GraphModel, path: string): Promise<GraphModel> {
  const links = await fetchDocLinks(client, path, { repo: repoArgValue.get() });
  return fetchFields(client, withNeighborhood(model, path, links, { limit: GRAPH_LIMIT }), graphFields.get(), { repo: repoArgValue.get(), computed: computedFields(graphCards.get()) });
}

/** The card templates changed: persist them and fetch whatever fields the rows now lack (not a log entry — the model's rows, not the user's graph). */
let fieldsGeneration = 0;
async function refetchGraphFields(): Promise<void> {
  const before = graph.get();
  if (!before) return;
  const gen = ++fieldsGeneration;
  try {
    const after = await fetchFields(client, before, graphFields.get(), { repo: repoArgValue.get(), computed: computedFields(graphCards.get()) });
    if (gen === fieldsGeneration && graph.get() === before && after !== before) graph.set(after);
  } catch (e) {
    graphError.set(describe(e));
  }
}

function setGraphCards(next: CardSettings): void {
  // A changed expression recomputes `card` on every row: forget it, then refetch.
  if (next.expression.trim() !== graphCards.get().expression.trim()) { const m = graph.get(); if (m) graph.set(invalidateFields(m, [CARD_KEY])); }
  graphCards.set(next);
  localStorage.setItem(CARDS_KEY, serializeCardSettings(next));
  void refetchGraphFields();
}

/** The graph tab opened (or the document changed): a fresh model around the open
 * document, which starts PINNED at the layout's centre (graph origin; the pane
 * centres it) — the initial state, not a log entry; unpin it like any other. */
async function loadGraph(path: string): Promise<void> {
  const gen = ++graphGeneration;
  graphBusy.set(true);
  graphError.set(null);
  relationPick.set(null);
  graphSelectedEdge.set(null);
  try {
    const m = await expanded(emptyModel(path), path);
    if (gen !== graphGeneration) return;
    graph.set(setPin(m, path, { x: 0, y: 0 }));
    graphSelected.set(path);
  } catch (e) {
    if (gen === graphGeneration) graphError.set(describe(e));
  } finally {
    if (gen === graphGeneration) graphBusy.set(false);
  }
}

/** The route `#graph=<query>`: the query re-run with `limit: GRAPH_QUERY_LIMIT`
 * (the console's pages beyond it are not graphed), its rows the nodes
 * (`queryModel`: one per distinct `_path`, each row kept so the query's own
 * projection drives the cards), then ONE `links` query for the edges among the
 * set and one `docs` query for whatever card fields the query did not project.
 * Nothing is pinned or expanded; the element auto-fits the whole set. */
async function loadQueryGraph(query: string): Promise<void> {
  const gen = ++graphGeneration;
  graphBusy.set(true);
  graphError.set(null);
  relationPick.set(null);
  graphSelectedEdge.set(null);
  graph.set(null);
  graphSelected.set(null);
  try {
    const r = await runQuery(client, query, { repo: repoArgValue.get(), limit: GRAPH_QUERY_LIMIT });
    if (gen !== graphGeneration) return;
    if (!canGraph(r)) {
      graphError.set(r.hits.length === 0 && !r.values && r.consumer === "collect" ? "the query has no rows to graph" : "the query answers with a scalar or with values, not rows that name documents — graph a docs, nodes or blocks query");
      graph.set(queryModel(query, [], { limit: GRAPH_QUERY_LIMIT, truncated: false }));
      return;
    }
    const built = queryModel(query, r.hits, { limit: GRAPH_QUERY_LIMIT, truncated: r.truncated });
    const linked = await fetchLinksAmong(client, built, { repo: repoArgValue.get() });
    const m = await fetchFields(client, linked, graphFields.get(), { repo: repoArgValue.get(), computed: computedFields(graphCards.get()) });
    if (gen !== graphGeneration) return;
    graph.set(m);
  } catch (e) {
    if (gen === graphGeneration) graphError.set(describeToolError(e).message);
  } finally {
    if (gen === graphGeneration) graphBusy.set(false);
  }
}

/** ⊕ / `e`: one more neighbourhood, as an undoable query command. */
async function expandGraph(path: string): Promise<void> {
  const before = graph.get();
  if (!before || graphBusy.get()) return;
  graphBusy.set(true);
  graphError.set(null);
  try {
    const after = await expanded(before, path);
    if (graph.get() !== before) return; // the model moved on meanwhile (an undo, a reload)
    await log.run(expandCommand(graphModel, path, before, after));
  } catch (e) {
    graphError.set(describe(e));
  } finally {
    graphBusy.set(false);
  }
}

/** ⊖ / `e` on an expanded node: its neighbourhood leaves (what nothing else explains), as an undoable query command. */
async function collapseGraph(path: string): Promise<void> {
  const before = graph.get();
  if (!before || graphBusy.get()) return;
  const after = collapseNode(before, path);
  if (after === before) return;
  await log.run(collapseCommand(graphModel, path, before, after));
}

/** A drop: one pin command per drag (sealed, so two drags are two undo steps). */
async function pinGraphNode(d: GraphPinDetail): Promise<void> {
  await log.run(pinCommand(graphModel, d.id, { x: d.x, y: d.y }, d.previous));
  log.seal();
}

/** A connector landed on a document (or the palette picked one): the relation
 * kinds the RENDERED graph already uses — the frontmatter fields of its edges by
 * frequency, then the source's own list-of-paths fields (one `docs_read`), then
 * the body link — offered in a picker at the drop point. Nothing is written yet. */
async function startConnect(from: string, to: string, anchor: { x: number; y: number } | null = null): Promise<void> {
  if (!canApply.get() || from === to) return;
  graphError.set(null);
  try {
    const d = await client.docsRead({ _path: from }, { repo: repoArgValue.get() });
    const m = graph.get();
    const edges = m ? [...m.edges.values()] : [];
    const counts = fieldCounts(edges);
    const kinds = relationKinds(edges, listFieldsOf(d.properties.frontmatter)).map((k): RelationKindItem =>
      k.kind === "frontmatter"
        ? { kind: "frontmatter", field: k.field, label: `add to \`${k.field}\``, ...(counts.has(k.field) ? { count: counts.get(k.field)! } : {}) }
        : { kind: "body-link", label: "a link in the body" });
    const toNode = m?.nodes.get(to);
    const toTitle = toNode && typeof toNode.row._title === "string" ? toNode.row._title : null;
    relationPick.set({ from, to, toTitle, kinds, anchor });
  } catch (e) {
    graphError.set(describe(e));
  }
}

/** A connector dropped on open canvas: the palette picks (or creates) the destination, then the picker. */
async function connectToPicked(from: string, anchor: { x: number; y: number } | null = null): Promise<void> {
  const item = await pickDestination(`connect ${from} to…`);
  if (!item) return;
  if (item.kind === "doc") { void startConnect(from, item.path, anchor); return; }
  if (item.kind === "create") {
    const entry = await log.run(createDocumentCommand({ path: item.path, markdown: defaultMarkdown(item.path), repo: repoArgValue.get() }));
    if (entry.state !== "applied") { graphError.set(creationError(entry.error, item.path)); return; }
    refreshLevels([item.path]);
    void startConnect(from, item.path, anchor);
  }
}

/** A relation command's error in one line: the engine's code and message (a stale guard says what to do), else the command's own refusal. */
function relationError(e: unknown): string {
  if (e instanceof OmgError) { const info = describeToolError(e); return `${info.code}: ${info.message}${isMovedOn(e) ? ` — ${MOVED_ON_MESSAGE}` : ""}`; }
  return describe(e);
}

/** After a relation write: the open document re-read, then the source's neighbourhood re-read into the model (the edge is authored — or gone — now). */
async function rebuildAround(path: string): Promise<void> {
  await rereadAfterWrite(path);
  const before = graph.get();
  if (before) graph.set(await expanded(before, path));
}

/** A relation kind picked: ONE additive write as a command on the log (the list
 * gains the destination; a scalar path becomes a list; nothing is replaced —
 * "already related" and a non-path scalar fail before writing), then the source's
 * neighbourhood re-read. */
async function attachPicked(item: RelationKindItem): Promise<void> {
  const c = relationPick.get();
  if (!c) return;
  const how: RelationKind = item.kind === "frontmatter" ? { kind: "frontmatter", field: (item.field ?? "").trim() } : { kind: "body-link" };
  if (how.kind === "frontmatter" && how.field === "") { graphError.set("the new frontmatter field needs a name"); return; }
  relationPick.set(null);
  graphBusy.set(true);
  graphError.set(null);
  try {
    const entry = await log.run(attachRelationCommand({ from: c.from, to: c.to, toTitle: c.toTitle, how, repo: repoArgValue.get() }));
    if (entry.state !== "applied") throw entry.error;
    const receipt = entry.steps[0]?.applied?.receipts[0];
    writeMessage.set({ kind: "info", text: `${entry.label}${receipt?.commit ? ` — committed ${receipt.commit}` : ""} — undo with the button or ⌘Z` });
    await rebuildAround(c.from);
  } catch (e) {
    graphError.set(`${describeRelation(how, c.from, c.to)} failed — ${relationError(e)}`);
  } finally {
    graphBusy.set(false);
  }
}

/** ✕ on the selected edge, or Delete / Backspace: the sever — the frontmatter
 * field without the destination (unset when that empties it) or the body link's
 * block removed by its hash — as a command on the log, then the source re-read.
 * An external edge (a URL destination) is not deletable from the graph. */
async function deleteGraphEdge(key: string): Promise<void> {
  const m = graph.get();
  const edge = m?.edges.get(key);
  if (!m || !edge || !canApply.get() || graphBusy.get()) return;
  graphError.set(null);
  if (edge.provenance === "external") { graphError.set(`${edge.from} → ${edge.uri ?? edge.to} is an external link; it is not deletable from the graph — edit the document`); return; }
  const how: RelationKind = edge.provenance === "frontmatter" && edge.field ? { kind: "frontmatter", field: edge.field } : { kind: "body-link" };
  if (how.kind === "body-link" && !edge.blockId) { graphError.set(`${edge.from} → ${edge.to}: the body link's block is unknown; it is not deletable from the graph`); return; }
  graphBusy.set(true);
  try {
    const entry = await log.run(detachRelationCommand({ from: edge.from, to: edge.to, how, blockId: edge.blockId, repo: repoArgValue.get() }));
    if (entry.state !== "applied") throw entry.error;
    graphSelectedEdge.set(null);
    const receipt = entry.steps[0]?.applied?.receipts[0];
    writeMessage.set({ kind: "info", text: `${entry.label}${how.kind === "body-link" ? " (its block)" : ""}${receipt?.commit ? ` — committed ${receipt.commit}` : ""} — undo with the button or ⌘Z` });
    // The edge is gone from the repository: drop it from the model before the neighbourhood is re-read (a re-read only adds).
    const before = graph.get();
    if (before) graph.set({ ...before, edges: new Map([...before.edges].filter(([k]) => k !== key)) });
    await rebuildAround(edge.from);
  } catch (e) {
    graphError.set(`${describeDetach(how, edge.from, edge.to)} failed — ${relationError(e)}`);
  } finally {
    graphBusy.set(false);
  }
}

// ---- connecting -----------------------------------------------------------------------------

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
    // The surface first (one `version` call): this demo speaks 5.0 — the
    // underscore engine names (`_id`/`_path` arguments, `_title`, `_doc_id`,
    // …) — and says so loudly otherwise (lib/paths.ts `surfaceProblem`).
    const [versionResult, names] = await Promise.all([
      client.call<Wire>("version", {}).catch(() => null),
      client.tools().catch(() => null),
    ]);
    const v = surfaceOf(versionResult);
    const problem = surfaceProblem(v);
    if (problem) { connection.set("error"); connectionMessage.set(problem); return; }
    surface.set(v);
    profile.set(profileOf(versionResult));
    tools.set(names);
    const c = capabilities(names);
    if (c.repos) {
      // Listed: the picker; a designation the server does not know is replaced by its first repo.
      try {
        const r = await client.call<{ repos: { slug: string }[] }>("repos", {});
        const slugs = r.repos.map((x) => x.slug);
        repos.set(slugs);
        if (slugs.length > 0 && !slugs.includes(repoInUse.get())) setRepoOverride(slugs[0]!);
      } catch { repos.set([]); }
    } else {
      // The minimal profile: the designation is whatever the header says (or the proxy's --repo), unchecked until a call answers `repo_not_found`.
      repos.set([]);
    }
    connection.set("ok");
    connectionMessage.set(`surface ${v} · ${profileLabel(profile.get(), c)}${repoInUse.get() ? ` · repo ${repoInUse.get()}` : ""}${w.auth.recovered ? " · signed in again" : ""}`);
    await refreshWhoAmI();
    levels.set(new Map());
    await Promise.all([loadLevel("/"), startFeed()]);
    applyRoute(route.get());
  } catch (e) {
    const again = await refreshWhoAmI();
    if (again?.auth.state === "waiting") { connection.set("sign-in"); connectionMessage.set("waiting for sign-in in your browser"); watchSignIn(); return; }
    connection.set("error");
    connectionMessage.set(describe(e));
  }
}

function setRepoOverride(slug: string): void {
  repoOverride.set(slug);
  localStorage.setItem(REPO_KEY, slug);
}

/** A new designation: everything read so far was another repository's. */
function switchRepo(slug: string): void {
  if (slug === repoOverride.get()) return;
  setRepoOverride(slug);
  log.clear(); // the commands were in another repository
  doc.set(null);
  rendered.set(null);
  levels.set(new Map());
  consoleResult.set(null);
  consoleRan.set(null);
  consoleRows.set([]);
  appliedGraphQuery = null;
  void Promise.all([loadLevel("/"), startFeed()]);
  applyRoute(route.get());
}

/** The route decides what the main pane shows. */
let appliedDoc: string | null = null;
let appliedRev: string | null = null;
let appliedGraphQuery: string | null = null;
function applyRoute(r: Route): void {
  if (connection.get() !== "ok") return;
  if (r.deleted) { void loadDeleted(); appliedDoc = null; appliedGraphQuery = null; return; }
  if (r.graphQuery) {
    // A query graph: the main pane is the graph alone — no document is open.
    appliedDoc = null;
    doc.set(null);
    rendered.set(null);
    if (r.graphQuery !== appliedGraphQuery) { appliedGraphQuery = r.graphQuery; void loadQueryGraph(r.graphQuery); }
    return;
  }
  appliedGraphQuery = null;
  if (r.doc) {
    if (r.doc !== appliedDoc) {
      appliedDoc = r.doc;
      appliedRev = r.rev;
      revealPath(r.doc);
      void loadDocument(r.doc);
    } else if (r.rev !== appliedRev) {
      appliedRev = r.rev;
      if (r.rev) void loadAt(r.rev, docGeneration);
      else at.set(null);
    }
  } else {
    appliedDoc = null;
    doc.set(null);
    rendered.set(null);
  }
}

window.addEventListener("hashchange", () => { route.set(parseRoute(location.hash)); });
// Page-wide keys: ⌘K / Ctrl+K opens the palette, ⌘J / Ctrl+J toggles the console drawer.
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "k") { e.preventDefault(); if (paletteOpen.get()) closePalette(); else openPalette(); }
  else if (k === "j") { e.preventDefault(); toggleConsole(); }
});

effect(() => { localStorage.setItem(QUERY_KEY, consoleQuery.get()); });
effect(() => { localStorage.setItem(VIEW_KEY, view.get()); });
effect(() => { localStorage.setItem(SPLIT_KEY, String(splitPosition.get())); });
effect(() => { localStorage.setItem(CONSOLE_KEY, consoleOpen.get() ? "open" : "closed"); });
effect(() => { localStorage.setItem(CONSOLE_SPLIT_KEY, String(consoleSplit.get())); });
effect(() => { applyRoute(route.get()); });
// The graph tab shown for a loaded document whose neighbourhood is not built yet.
effect(() => { const r = route.get(); const d = doc.get(); if (r.tab === "graph" && d && r.doc === d.path && graph.get()?.root !== d.path && !graphBusy.get()) void loadGraph(d.path); });

// ---- the element ----------------------------------------------------------------------------

@customElement("repo-explorer-app")
export class RepoExplorerApp extends SignalWatcher(LitElement) {
  static override styles = css`
    :host { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; font: 14px/1.45 system-ui, sans-serif; color: #1e2430; background: #fff; }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 6px 14px; border-bottom: 1px solid #e3e6ec; }
    header h1 { font-size: 15px; margin: 0; font-weight: 600; }
    header .label { color: #5a6270; font-size: 12.5px; }
    header .msg { color: #5a6270; font-size: 12.5px; }
    header .msg.err { color: #b3261e; }
    header .spacer { flex: 1; }
    header select, header button, header input { font: inherit; font-size: 12.5px; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; }
    header input.repo { width: 11em; }
    header a { color: #1565c0; font-size: 12.5px; }
    .banner { padding: 6px 14px; font-size: 12.5px; background: #fff8e1; color: #6d4c00; border-bottom: 1px solid #ffe082; }
    .banner code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .strip { padding: 4px 14px; border-bottom: 1px solid #e3e6ec; background: #fafbfc; }
    main { min-height: 0; }
    sl-split-panel { height: 100%; min-height: 0; --min: 220px; --max: 60%; --divider-width: 4px; --divider-hit-area: 14px; }
    sl-split-panel::part(divider) { background: #e3e6ec; }
    sl-split-panel::part(panel) { min-width: 0; min-height: 0; }
    .left { height: 100%; overflow: auto; padding: 8px 8px 8px 10px; box-sizing: border-box; }
    .left .deleted-link { display: block; margin-top: 12px; font-size: 12px; color: #1565c0; cursor: pointer; }
    .right { display: grid; grid-template-rows: minmax(0, 1fr) auto; height: 100%; min-height: 0; min-width: 0; }
    .right.open { grid-template-rows: minmax(0, 1fr); }
    .right sl-split-panel.vertical { --min: 120px; --max: 85%; }
    .main { overflow: auto; padding: 10px 16px; min-height: 0; height: 100%; box-sizing: border-box; }
    /* The console drawer: one bar when closed; the bar plus the console, in a resizable split, when open. */
    .console { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; background: #fafbfc; border-top: 1px solid #e3e6ec; height: 100%; box-sizing: border-box; }
    .console-bar { display: flex; align-items: center; gap: 10px; padding: 4px 16px; font-size: 12px; color: #5a6270; cursor: pointer; user-select: none; flex: none; }
    .console-bar:hover { background: #f0f2f5; }
    .console-bar .title { text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .console-bar .caret { font-size: 11px; color: #8a94a6; width: 1em; }
    .console-bar .summary { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #8a94a6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .console-bar kbd { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #c9cdd6; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: #fff; color: #5a6270; }
    .console query-console { flex: 1; min-height: 0; padding: 0 16px 10px; }
    .welcome { color: #5a6270; max-width: 64ch; }
    .welcome code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0f1f4; padding: 0 3px; border-radius: 3px; }
    .err { color: #b3261e; }
    sl-tab-group::part(body) { padding-top: 10px; }
    .graph { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
    .graph omg-graph { height: 62vh; min-height: 320px; border: 1px solid #e3e6ec; border-radius: 6px; background: #fff; }
    .graph-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: #5a6270; }
    .graph-tools label { display: inline-flex; gap: 6px; align-items: center; }
    .graph-tools input { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; width: 22em; }
    .graph-tools input.field { width: 10em; }
    .graph-tools details { font-size: 12px; }
    .graph-tools details summary { cursor: pointer; color: #1565c0; }
    .graph-tools .per-type { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; margin-top: 4px; align-items: center; }
    .graph-tools .per-type code { font-size: 11.5px; color: #5a6270; }
    .graph-tools .per-type input { width: 100%; box-sizing: border-box; }
    .graph-hint { font-size: 12px; color: #8a94a6; }
    .graph-query { display: block; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #1e2430; background: #f0f1f4; border: 1px solid #e3e6ec; border-radius: 4px; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; max-width: 100%; box-sizing: border-box; }
    .graph-query:hover { background: #e8eaef; }
    .deleted h2 { font-size: 16px; margin: 0 0 8px; }
    .deleted .query { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a94a6; margin-bottom: 8px; }
    .deleted table { border-collapse: collapse; font-size: 12.5px; }
    .deleted th, .deleted td { text-align: left; padding: 3px 10px 3px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; }
    .deleted .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .deleted .note { color: #6d4c00; background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px; padding: 6px 10px; font-size: 12.5px; margin-bottom: 10px; }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void connect();
  }

  private onTab(e: Event): void {
    const name = (e as CustomEvent<{ name: string }>).detail.name as Tab;
    const r = route.get();
    if (name !== r.tab) setRoute({ ...r, tab: name });
  }

  private renderDeleted() {
    const list = deleted.get();
    return html`<div class="deleted" data-deleted>
      <h2>deleted documents</h2>
      <div class="query">${deletedRevisionsQuery()}</div>
      <div class="note">history is history: a deleted document's revisions stay queryable rows (<code>_doc</code> is absent on them), but <code>docs_read { at }</code> needs a live document — the body of a deleted revision is <code>doc_missing</code> on every profile, so this list is read-only.</div>
      ${deletedError.get() ? html`<div class="err">${deletedError.get()}</div>` : nothing}
      ${list === null ? html`<div>loading…</div>` : list.length === 0 ? html`<div>none — every revision belongs to a live document</div>` : html`<table>
        <thead><tr><th>path (as of the revision)</th><th>doc</th><th>seq</th><th>when</th><th>by</th><th>reason</th><th>rev</th></tr></thead>
        <tbody>${list.flatMap((d) => d.revisions.map((r) => html`<tr>
          <td class="mono">${r.path}</td><td class="mono">${d.docId}</td><td>${r.seq}</td><td title=${r.ts}>${r.ts.replace("T", " ").slice(0, 19)}</td><td>${r.actor ?? r.origin}</td><td>${r.reason ?? ""}</td><td class="mono">${r.rev}</td>
        </tr>`))}</tbody>
      </table>`}
    </div>`;
  }

  /** The drawer's handle: open/close, the last result in a line, the shortcut. */
  private renderConsoleBar() {
    const open = consoleOpen.get();
    const r = consoleResult.get();
    const err = consoleError.get();
    const summary = err ? `${err.code}: ${err.message}` : r ? `${consoleRunning.get() ? "running… " : ""}${footerText(r, consoleRows.get().length)} · ${consoleQuery.get().replace(/\s+/g, " ").trim()}` : consoleQuery.get().replace(/\s+/g, " ").trim();
    return html`<div class="console-bar" role="button" tabindex="0" aria-expanded=${open} data-console-bar title=${open ? "collapse the query console (⌘J / Ctrl+J)" : "expand the query console (⌘J / Ctrl+J)"}
      @click=${() => toggleConsole()} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleConsole(); } }}>
      <span class="caret">${open ? "▾" : "▸"}</span>
      <span class="title">query console</span>
      <span class="summary">${summary}</span>
      <kbd>⌘J</kbd>
    </div>`;
  }

  /** The connector's picker (`<omg-relation-picker>`, anchored at the drop point): WHICH relation is from → to, from the kinds the rendered graph uses; picking is the whole gesture. */
  private renderRelationPicker() {
    const c = relationPick.get();
    return html`<omg-relation-picker ?open=${c !== null} .kinds=${c?.kinds ?? []} .from=${c?.from ?? ""} .to=${c?.to ?? ""} allowNew .anchor=${c?.anchor ?? null}
      @relation-pick=${(e: CustomEvent<RelationPickDetail>) => { void attachPicked(e.detail.item); }}
      @relation-cancel=${() => relationPick.set(null)}></omg-relation-picker>`;
  }

  /** The card control: the default template, the field the cards vary by (the user's — empty is off), and one template per value present. */
  private renderGraphTools(m: GraphModel | null) {
    const cards = graphCards.get();
    const by = cards.by;
    const rows = m ? [...m.nodes.values()].filter((n) => n.kind === "document").map((n) => n.row) : [];
    const present = by ? valuesPresent(rows, by.field) : [];
    const all = by ? [...present, ...Object.keys(by.templates).filter((v) => !present.includes(v)).sort()] : [];
    const q = m?.source.kind === "query" ? m.source.query : null;
    return html`${q !== null ? html`<code class="graph-query" data-graph-query role="button" tabindex="0" title="the query these rows come from — click to copy it into the console" @click=${() => queryToConsole(q)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); queryToConsole(q); } }}>${q.replace(/\s+/g, " ").trim()}</code>` : nothing}
    <div class="graph-tools">
      <label>card <input type="text" .value=${cards.default} placeholder=${DEFAULT_CARD} title="the card template: {field}, {a|b} first present, one line per row line; e.g. {_title}&#10;{status}" spellcheck="false"
        @change=${(e: Event) => setGraphCards({ ...cards, default: (e.target as HTMLInputElement).value.trim() || DEFAULT_CARD })}></label>
      <label>card: <input type="text" class="expr" .value=${cards.expression} placeholder='_title + " · " + status' spellcheck="false" title="an OQX expression computing the row key card for every document (a projection alias: docs { select …, card: <expression> }); empty = an authored card key is read as is"
        @change=${(e: Event) => setGraphCards({ ...cards, expression: (e.target as HTMLInputElement).value.trim() })}></label>
      <label>vary by <input type="text" class="field" .value=${by?.field ?? ""} placeholder="field, e.g. type" title="a row field whose value picks a template (empty: every card uses the default)" spellcheck="false"
        @change=${(e: Event) => { const field = (e.target as HTMLInputElement).value.trim(); setGraphCards({ ...cards, by: field ? { field, templates: by?.field === field ? by.templates : {} } : null }); }}></label>
      ${by ? html`<details ?open=${graphCardsOpen.get()} @toggle=${(e: Event) => graphCardsOpen.set((e.target as HTMLDetailsElement).open)}>
        <summary>by <code>${by.field}</code>… (${Object.keys(by.templates).length})</summary>
        ${all.length === 0 ? html`<div class="graph-hint">no document in this graph carries <code>${by.field}</code></div>` : html`<div class="per-type">
          ${all.map((v) => html`<code title=${v}>${v}</code><input type="text" .value=${by.templates[v] ?? ""} placeholder=${`inherit: ${cards.default}`} spellcheck="false"
            @change=${(e: Event) => { const t = (e.target as HTMLInputElement).value.trim(); const templates = { ...by.templates }; if (t) templates[v] = t; else delete templates[v]; setGraphCards({ ...cards, by: { field: by.field, templates } }); }}>`)}
        </div>`}
      </details>` : nothing}
    </div>`;
  }

  /** The hint's first clause: what the graph is of. */
  private graphOfText(m: GraphModel | null): string {
    if (!m) return graphBusy.get() ? "reading…" : "";
    if (m.source.kind === "doc") return `${m.nodes.size} nodes · ${m.edges.size} edges around ${m.source.path}`;
    const rows = [...m.nodes.values()].filter((n) => n.origin === "query").length;
    const more = m.source.truncated ? ` (the first ${GRAPH_QUERY_LIMIT} — the console's "more" pages beyond are not graphed)` : "";
    const skipped = m.source.skipped ? ` · ${m.source.skipped} row${m.source.skipped === 1 ? "" : "s"} without a _path skipped` : "";
    return `graph of ${rows} row${rows === 1 ? "" : "s"}${more}: ${m.source.query.replace(/\s+/g, " ").trim()} · ${m.nodes.size} nodes · ${m.edges.size} links among them${skipped}`;
  }

  /** Both kinds of graph — a document's neighbourhood or a query's rows — share the hint, the card controls and the element. */
  private renderGraph() {
    const m = graph.get();
    const cards = graphCards.get();
    const view = m ? toView(m) : null;
    return html`<div class="graph">
      <div class="graph-hint">${this.graphOfText(m)}${m && m.truncated.size ? ` · ${[...m.truncated.values()].reduce((a, b) => a + b, 0)} more not shown (⊕ expands a node, ${GRAPH_LIMIT} per direction)` : ""} · card: ${cards.default}${cards.by ? ` · vary by ${cards.by.field} (+${Object.keys(cards.by.templates).length})` : ""} — drag to pin, ✕/u unpins, ⊕/⊖ (or e) expands/collapses, wheel zooms, drag the canvas to pan, ⌘-drag or the ⟶ handle connects${canApply.get() ? ", a selected edge's ✕ or Delete removes it" : " (read-only: no apply)"}, double-click opens</div>
      ${this.renderGraphTools(m)}
      ${graphError.get() ? html`<div class="err">${graphError.get()}</div>` : nothing}
      ${view ? html`<omg-graph .nodes=${view.nodes} .edges=${view.edges} .card=${cards.default} .renderCard=${(node: { row: Record<string, unknown> }) => templateFor(cards, node.row)} .selected=${graphSelected.get()} ?canWrite=${canApply.get()} .connectSource=${null} .limit=${GRAPH_LIMIT} .autoFit=${m!.source.kind === "query"}
        @graph-select=${(e: CustomEvent<GraphSelectDetail>) => graphSelected.set(e.detail.id)}
        @graph-open=${(e: CustomEvent<GraphIdDetail>) => openDoc(e.detail.id)}
        @graph-expand=${(e: CustomEvent<GraphIdDetail>) => { void expandGraph(e.detail.id); }}
        @graph-collapse=${(e: CustomEvent<GraphIdDetail>) => { void collapseGraph(e.detail.id); }}
        @graph-pin=${(e: CustomEvent<GraphPinDetail>) => { void pinGraphNode(e.detail); }}
        @graph-unpin=${(e: CustomEvent<GraphUnpinDetail>) => { void log.run(unpinCommand(graphModel, e.detail.id, e.detail.previous)); }}
        @graph-connect=${(e: CustomEvent<GraphConnectDetail>) => { void startConnect(e.detail.from, e.detail.to, { x: e.detail.clientX, y: e.detail.clientY }); }}
        @graph-connect-empty=${(e: CustomEvent<GraphConnectEmptyDetail>) => { void connectToPicked(e.detail.from, { x: e.detail.clientX, y: e.detail.clientY }); }}
        @graph-edge-select=${(e: CustomEvent<GraphEdgeSelectDetail>) => graphSelectedEdge.set(e.detail.key)}
        @graph-edge-delete=${(e: CustomEvent<GraphEdgeDeleteDetail>) => { void deleteGraphEdge(e.detail.key); }}></omg-graph>` : nothing}
      ${this.renderRelationPicker()}
    </div>`;
  }

  private renderMain() {
    const r = route.get();
    if (connection.get() !== "ok") return html`<div class="welcome">${connectionMessage.get() || "connecting…"}</div>`;
    if (r.deleted) return this.renderDeleted();
    if (r.graphQuery) return html`<div data-query-graph>${this.renderGraph()}</div>`;
    const d = doc.get();
    if (!r.doc) {
      const c = caps.get();
      return html`<div class="welcome">
        <p>Pick a document in the tree, press <code>⌘K</code> to find or create one, run a query in the console below (<code>⌘J</code>) — its footer's <em>graph</em> draws the rows as a graph (<code>#graph=…</code>) — or follow the live strip above.</p>
        <p>This page is built against <code>omg mcp --tools minimal</code>: the tree is <code>docs_tree</code>, a document <code>docs_read { include_ids }</code>, its links and history <code>query</code> over <code>links</code> and <code>revisions</code>, time travel <code>docs_read { at }</code>, the strip <code>changes_since</code>, edits <code>plan</code> → <code>execute</code>.</p>
        ${c.tools ? html`<p>This server lists ${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}${c.beyondMinimal.length ? ` (${c.beyondMinimal.length} beyond the minimal ten; only \`repos\` is used, for the picker)` : " — the minimal profile"}.</p>` : nothing}
      </div>`;
    }
    if (docError.get() && !d) return html`<div class="err">${docError.get()}</div>`;
    if (!d) return html`<div class="welcome">${docLoading.get() ? "loading…" : ""}</div>`;
    return html`
      ${docError.get() ? html`<div class="err">${docError.get()}</div>` : nothing}
      <sl-tab-group @sl-tab-show=${this.onTab}>
        <sl-tab slot="nav" panel="document" ?active=${r.tab === "document"}>document</sl-tab>
        <sl-tab slot="nav" panel="history" ?active=${r.tab === "history"}>history${revisions.get() ? ` (${revisions.get()!.length})` : ""}</sl-tab>
        <sl-tab slot="nav" panel="links" ?active=${r.tab === "links"}>links${links.get() ? ` (${links.get()!.inbound.length} in · ${links.get()!.outbound.length} out)` : ""}</sl-tab>
        <sl-tab slot="nav" panel="graph" ?active=${r.tab === "graph"}>graph${graph.get() ? ` (${graph.get()!.nodes.size})` : ""}</sl-tab>
        <sl-tab-panel name="document" ?active=${r.tab === "document"}>
          <doc-view .doc=${d} .rendered=${rendered.get()} .view=${view.get()} ?canWrite=${canWrite.get()} .pending=${pendingPlan.get()} .writeMessage=${writeMessage.get()} ?writing=${writing.get()} .highlight=${r.block}
            .taskPending=${taskPending.get()} .undoLabel=${undoLabel.get()} .redoLabel=${redoLabel.get()}
            @task-toggle=${(e: CustomEvent<TaskToggleDetail>) => { void toggleTask(e.detail); }}
            @log-undo=${() => { void compensate("undo"); }}
            @log-redo=${() => { void compensate("redo"); }}
            @open-doc=${(e: CustomEvent<OpenDocDetail>) => openDoc(e.detail.path)}
            @open-wiki=${(e: CustomEvent<OpenWikiDetail>) => { void openWiki(e.detail.name); }}
            @view-change=${(e: CustomEvent<ViewChangeDetail>) => view.set(e.detail.view)}
            @write-plan=${(e: CustomEvent<WritePlanDetail>) => { void planFrontmatter(e.detail); }}
            @write-execute=${() => { void executePending(); }}
            @write-cancel=${() => { pendingPlan.set(null); writeMessage.set(null); }}></doc-view>
        </sl-tab-panel>
        <sl-tab-panel name="history" ?active=${r.tab === "history"}>
          <history-panel .revisions=${revisions.get()} .selected=${r.rev} .current=${d.raw} .at=${at.get()} ?loading=${atLoading.get()} .error=${historyError.get()} .query=${revisionsQuery(d.id)}
            @history-select=${(e: CustomEvent<HistorySelectDetail>) => setRoute({ ...route.get(), rev: e.detail.rev, tab: "history" })}></history-panel>
        </sl-tab-panel>
        <sl-tab-panel name="links" ?active=${r.tab === "links"}>
          <links-panel .links=${links.get()} .path=${d.path} .error=${linksError.get()} @open-doc=${(e: CustomEvent<OpenDocDetail>) => openDoc(e.detail.path)}></links-panel>
        </sl-tab-panel>
        <sl-tab-panel name="graph" ?active=${r.tab === "graph"}>${r.tab === "graph" ? this.renderGraph() : nothing}</sl-tab-panel>
      </sl-tab-group>
    `;
  }

  override render() {
    const state = connection.get();
    const c = caps.get();
    const missing = missingToolsText(c);
    const r = route.get();
    return html`
      <header>
        <h1>repo explorer</h1>
        <span class="label">${headerLabel.get()}</span>
        <span class="msg ${state === "error" ? "err" : ""}">${connectionMessage.get()}${state === "sign-in" && whoami.get()?.auth.authorizationUrl
          ? html` (<a href=${whoami.get()!.auth.authorizationUrl!} target="_blank" rel="noopener">open the sign-in page</a>)` : nothing}</span>
        <span class="spacer"></span>
        ${repos.get().length > 0 ? html`<label>repo
          <select .value=${repoInUse.get()} @change=${(e: Event) => switchRepo((e.target as HTMLSelectElement).value)}>
            ${repos.get().map((slug) => html`<option value=${slug} ?selected=${slug === repoInUse.get()}>${slug}</option>`)}
          </select></label>` : html`<label title="the repository sent as the repo argument of every call; empty = what the proxy was started for (--repo), else the server's default">repo
          <input class="repo" type="text" .value=${repoOverride.get()} placeholder=${whoami.get()?.repo ?? "server default"} spellcheck="false" data-repo
            @change=${(e: Event) => switchRepo((e.target as HTMLInputElement).value.trim())}></label>`}
        <button type="button" title="find a document, run an action, create one (⌘K / Ctrl+K)" ?disabled=${state !== "ok"} @click=${() => openPalette()}>⌘K</button>
        <button type="button" ?disabled=${state === "connecting"} @click=${() => { void connect(); }}>reconnect</button>
      </header>
      <omg-palette ?open=${paletteOpen.get()} .text=${paletteText.get()} .items=${paletteItems.get()} ?loading=${paletteLoading.get()} .error=${paletteError.get()} .mode=${paletteMode.get()} .heading=${paletteHeading.get()}
        @palette-search=${(e: CustomEvent<{ text: string }>) => { void paletteSearch(e.detail.text); }}
        @palette-open-doc=${(e: CustomEvent<{ path: string }>) => onPaletteSelect({ kind: "doc", id: "", path: e.detail.path, title: "" })}
        @palette-action=${(e: CustomEvent<{ id: string }>) => runPaletteAction(e.detail.id)}
        @palette-create=${(e: CustomEvent<{ path: string }>) => { void createDocument(e.detail.path); }}
        @palette-pick=${(e: CustomEvent<{ item: PaletteItem }>) => onPaletteSelect(e.detail.item)}
        @palette-close=${() => closePalette()}></omg-palette>
      ${missing ? html`<div class="banner">${missing}</div>` : nothing}
      <div class="strip">
        <feed-strip .entries=${feed.get()} ?live=${feedLive.get()} ?polling=${feedPolling.get()} .pollSeconds=${pollSeconds.get()} .error=${feedError.get()} .cursor=${feedCursor.get()}
          @open-doc=${(e: CustomEvent<OpenDocDetail>) => openDoc(e.detail.path)}
          @feed-live=${(e: CustomEvent<{ on: boolean }>) => setLive(e.detail.on)}
          @feed-interval=${(e: CustomEvent<{ seconds: number }>) => { const s = pollMs(e.detail.seconds) / 1000; pollSeconds.set(s); localStorage.setItem(POLL_KEY, String(s)); if (feedLive.get()) schedulePoll(); }}></feed-strip>
      </div>
      <main>
        <sl-split-panel position=${splitPosition.get()} @sl-reposition=${(e: Event) => { const p = (e.currentTarget as unknown as { position: number }).position; if (Number.isFinite(p)) splitPosition.set(Math.round(p * 10) / 10); }}>
          <div class="left" slot="start">
            <repo-tree .levels=${levels.get()} .open=${open.get()} .selected=${r.doc}
              @tree-toggle=${(e: CustomEvent<TreeToggleDetail>) => toggleLevel(e.detail.prefix, e.detail.open)}
              @tree-open=${(e: CustomEvent<TreeOpenDetail>) => openDoc(e.detail.path)}></repo-tree>
            <a class="deleted-link" href="#deleted" @click=${(e: Event) => { e.preventDefault(); setRoute({ ...DEFAULT_ROUTE, deleted: true }); }}>deleted documents (revisions { _doc == null })</a>
          </div>
          <div class="right ${consoleOpen.get() ? "open" : ""}" slot="end">
            ${consoleOpen.get()
              ? html`<sl-split-panel class="vertical" vertical position=${consoleSplit.get()} @sl-reposition=${(e: Event) => { const p = (e.currentTarget as unknown as { position: number }).position; if (Number.isFinite(p)) consoleSplit.set(Math.round(p * 10) / 10); }}>
                  <div class="main" slot="start">${this.renderMain()}</div>
                  <div class="console" slot="end" data-console>
                    ${this.renderConsoleBar()}
                    <query-console .query=${consoleQuery.get()} .result=${consoleResult.get()} .rows=${consoleRows.get()} .error=${consoleError.get()} ?running=${consoleRunning.get()} .syntax=${syntax.get()}
                      @console-input=${(e: CustomEvent<{ query: string }>) => consoleQuery.set(e.detail.query)}
                      @console-run=${(e: CustomEvent<ConsoleRunDetail>) => onConsoleRun(e.detail.query)}
                      @console-more=${onConsoleMore}
                      @console-graph=${() => graphConsoleRows()}
                      @console-open=${(e: CustomEvent<ConsoleOpenDetail>) => { void openLink(e.detail.link); }}
                      @console-syntax=${() => { void loadSyntax(); }}></query-console>
                  </div>
                </sl-split-panel>`
              : html`<div class="main">${this.renderMain()}</div><div class="console" data-console>${this.renderConsoleBar()}</div>`}
          </div>
        </sl-split-panel>
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "repo-explorer-app": RepoExplorerApp }
}
