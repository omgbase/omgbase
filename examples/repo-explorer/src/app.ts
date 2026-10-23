// The page: one element composing the panes with module-level signals.
//
//   connect → (whoami: proxy mode + sign-in state) → version (surface ≥ 5.0, the
//   profile) + tools/list (what is served) → [repos, when listed] → the tree's
//   root level → the route (#doc=…) → the document (docs_read include_ids),
//   its links (two queries over `links`), its history (`revisions { … }`), the
//   live feed (changes_since polled) and the query console (query, query_syntax).
//   Writes: plan { effects, diffs: true } → confirm → execute { plan_id, effects };
//   a task checkbox: ONE apply { set _attrs.checked, expect: { content_hash } } →
//   re-read; undo/redo = a compensating apply, refused unless the block's hash
//   is still the one the toggle left (lib/tasks.ts).
//
// Everything runs on the MINIMAL tools profile (lib/tools.ts): `repos` is the
// one optional tool (a picker when it is listed; otherwise the server's default
// repository is the one browsed, and nothing names a `repo`). The data path is
// MCP only (lib/mcp-client.ts) through the dev proxy at the same-origin /mcp.

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
import type { TreeOpenDetail, TreeToggleDetail } from "./elements/repo-tree.ts";
import type { DocViewMode, OpenDocDetail, OpenWikiDetail, TaskPending, TaskToggleDetail, ViewChangeDetail, WritePlanDetail } from "./elements/doc-view.ts";
import type { ConsoleOpenDetail, ConsoleRunDetail } from "./elements/query-console.ts";
import type { HistorySelectDetail } from "./elements/history-panel.ts";
import { OmgClient, OmgError, applyEffects, fetchWhoAmI, type Wire } from "./lib/mcp-client.ts";
import { EMPTY_LOG, MOVED_ON_MESSAGE, afterCompensation, compensation, isMovedOn, nextToggle, pushToggle, setCheckedEffect, toggleLabel, type Direction, type ToggleLog } from "./lib/tasks.ts";
import { docLocator, profileOf, surfaceOf, surfaceProblem } from "./lib/paths.ts";
import { capabilities, missingToolsText, profileLabel, type Capabilities } from "./lib/tools.ts";
import { fetchLevel, prefixesToOpen, type LevelState } from "./lib/tree.ts";
import { fetchDocument, fetchDocumentAt, splitFrontmatter, type DocAt, type DocRead } from "./lib/document.ts";
import { renderBody, type Rendered } from "./lib/markdown.ts";
import { fetchLinks, resolveWikilink, type DocLinks } from "./lib/links.ts";
import { STARTER_QUERY, describeToolError, fetchSyntax, locatorQuery, nextPage, runConsole, type CellLink, type ToolErrorInfo } from "./lib/console.ts";
import { runQuery, type QueryOptions, type QueryResult } from "./lib/query.ts";
import { deletedRevisionsQuery, fetchDeleted, fetchRevisions, revisionsQuery, type DeletedDoc, type RevisionRow } from "./lib/history.ts";
import { advanceCursor, fetchChanges, pollMs, prependDigests, startCursor, touchedPaths, type FeedEntry } from "./lib/feed.ts";
import { executePlan, parseValue, planEffects, receiptOf, setFrontmatterEffect, unsetFrontmatterEffect, type Plan } from "./lib/writes.ts";
import { DEFAULT_ROUTE, openDocRoute, parseRoute, routeHash, type Route, type Tab } from "./lib/route.ts";
import { effect } from "./lib/effect.ts";
import { hitPath, rooted } from "./lib/paths.ts";

const MCP_URL = "/mcp";
const REPO_KEY = "omgbase-repo-explorer.repo";
const QUERY_KEY = "omgbase-repo-explorer.query";
const VIEW_KEY = "omgbase-repo-explorer.view";
const POLL_KEY = "omgbase-repo-explorer.poll";
const SPLIT_KEY = "omgbase-repo-explorer.split";

// ---- state --------------------------------------------------------------------------

const connection = signal<"idle" | "connecting" | "sign-in" | "ok" | "error">("idle");
const connectionMessage = signal("");
const whoami = signal<WhoAmI | null>(null);
const surface = signal<string | null>(null);
const profile = signal<string | null>(null);
const tools = signal<string[] | null>(null);
const caps = computed<Capabilities>(() => capabilities(tools.get()));
const repos = signal<string[]>([]);
/** The repo slug passed to every tool; "" = the server's default (the only choice without `repos`). */
const repo = signal<string>(localStorage.getItem(REPO_KEY) ?? "");
const repoArgValue = computed<string | null>(() => repo.get() || null);
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
const consoleRows = signal<Record<string, unknown>[]>([]);
const consoleError = signal<ToolErrorInfo | null>(null);
const consoleRunning = signal(false);
const consoleOpts = signal<QueryOptions>({});
const syntax = signal<string | null>(null);

const feed = signal<FeedEntry[]>([]);
const feedLive = signal(true);
const feedPolling = signal(false);
const feedCursor = signal<number | null>(null);
const feedError = signal<string | null>(null);
const pollSeconds = signal<number>(pollMs(localStorage.getItem(POLL_KEY)) / 1000);

const pendingPlan = signal<Plan | null>(null);
const writing = signal(false);
const writeMessage = signal<{ kind: "error" | "info"; text: string; fix?: string | null } | null>(null);

/** The session's completed task toggles (lib/tasks.ts): undo/redo stacks, in memory only. */
const taskLog = signal<ToggleLog>(EMPTY_LOG);
/** The task write in flight (a toggle or a compensation), or null. */
const taskPending = signal<TaskPending | null>(null);
const undoLabel = computed(() => toggleLabel(nextToggle(taskLog.get(), "undo"), "undo"));
const redoLabel = computed(() => toggleLabel(nextToggle(taskLog.get(), "redo"), "redo"));

const splitPosition = signal<number>(Number(localStorage.getItem(SPLIT_KEY) ?? 24) || 24);

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
  try {
    const d = await fetchDocument(client, docLocator(path), repoArgValue.get());
    if (gen !== docGeneration) return;
    doc.set(d);
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
    consoleRows.set(append ? [...consoleRows.get(), ...r.hits] : r.hits);
    consoleOpts.set(opts);
  } catch (e) {
    consoleError.set(describeToolError(e));
    if (!append) { consoleResult.set(null); consoleRows.set([]); }
  } finally {
    consoleRunning.set(false);
  }
}

function onConsoleRun(query: string): void {
  consoleQuery.set(query);
  void runConsoleQuery(query, { repo: repoArgValue.get() }, false);
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

async function executePending(): Promise<void> {
  const plan = pendingPlan.get();
  const d = doc.get();
  if (!plan || !d) return;
  writing.set(true);
  try {
    const receipt = await executePlan(client, plan, repoArgValue.get(), "repo-explorer frontmatter edit");
    pendingPlan.set(null);
    writeMessage.set({ kind: "info", text: receipt.commit ? `committed ${receipt.commit}: ${receipt.summary.join("; ")}` : "nothing to commit" });
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

// ---- task checkboxes --------------------------------------------------------------------------

/** The document re-read after a task write: the open document reloaded (so the
 * rendering, property table, history and links are the truth again, as after a
 * frontmatter edit) when it is the one written, else a plain read — either way
 * the fresh `blockIds` for the block's new hash. */
async function rereadAfterTaskWrite(path: string): Promise<DocRead | null> {
  if (doc.get()?.path === path) {
    await loadDocument(path);
    const d = doc.get();
    if (d?.path === path) return d;
  }
  try { return await fetchDocument(client, docLocator(path), repoArgValue.get()); } catch { return null; }
}

/** A checkbox changed: ONE `apply` with `set _attrs.checked` pinned to the block's hash from the read; then re-read. */
async function toggleTask(detail: TaskToggleDetail): Promise<void> {
  const d = doc.get();
  if (!d || taskPending.get() || !canApply.get()) return;
  const from = !detail.checked;
  taskPending.set({ blockId: detail.blockId, checked: detail.checked });
  writeMessage.set(null);
  try {
    const receipt = receiptOf(await applyEffects(client, [setCheckedEffect(detail.blockId, detail.checked, detail.contentHash)], { repo: repoArgValue.get(), reason: "repo-explorer task toggle" }));
    const after = await rereadAfterTaskWrite(d.path);
    const hashAfter = after?.blockIds?.hashes[detail.blockId];
    refreshLevels([d.path]);
    if (hashAfter === undefined) {
      writeMessage.set({ kind: "info", text: `${detail.checked ? "checked" : "unchecked"} ${detail.blockId}: committed ${receipt.commit ?? "nothing"} — but the re-read no longer has the block, so this toggle cannot be undone` });
      return;
    }
    taskLog.set(pushToggle(taskLog.get(), { blockId: detail.blockId, path: d.path, from, to: detail.checked, hashBefore: detail.contentHash, hashAfter, receipt }));
    writeMessage.set({ kind: "info", text: receipt.commit ? `${detail.checked ? "checked" : "unchecked"} ${detail.blockId}: committed ${receipt.commit} (${receipt.summary.join("; ")}) — undo with the button or ⌘Z` : `nothing to commit (${detail.blockId} already ${detail.checked ? "checked" : "unchecked"})` });
  } catch (e) {
    if (isMovedOn(e)) {
      await rereadAfterTaskWrite(d.path);
      writeMessage.set({ kind: "error", text: `${e.code}: ${MOVED_ON_MESSAGE}` });
    } else {
      const info = describeToolError(e);
      writeMessage.set({ kind: "error", text: `apply: ${info.code} — ${info.message}`, fix: info.fix });
    }
  } finally {
    taskPending.set(null);
  }
}

/** Undo (or redo) the last task toggle: re-read the block's CURRENT hash, refuse
 * unless it is the one the toggle left, else apply the compensating `set`
 * pinned to that hash, re-read, and move the record to the other stack. */
async function compensateTask(dir: Direction): Promise<void> {
  const rec = nextToggle(taskLog.get(), dir);
  if (!rec || taskPending.get() || !canApply.get()) return;
  taskPending.set({ blockId: rec.blockId, checked: dir === "undo" ? rec.from : rec.to });
  writeMessage.set(null);
  try {
    const current = await fetchDocument(client, docLocator(rec.path), repoArgValue.get()).then((d) => d.blockIds?.hashes[rec.blockId], () => undefined);
    const c = compensation(rec, current, dir);
    if (!c.ok) {
      // Refused: the record stays where it is (a later undo re-checks), the page says why.
      writeMessage.set({ kind: "error", text: c.reason });
      if (doc.get()?.path === rec.path) await loadDocument(rec.path);
      return;
    }
    const receipt = receiptOf(await applyEffects(client, [c.effect], { repo: repoArgValue.get(), reason: `repo-explorer task ${dir}` }));
    const after = await rereadAfterTaskWrite(rec.path);
    const hashNow = after?.blockIds?.hashes[rec.blockId];
    refreshLevels([rec.path]);
    if (hashNow === undefined) {
      // The block vanished under the compensation (unlikely): drop the record rather than keep a hash we cannot vouch for.
      taskLog.set({ done: taskLog.get().done.filter((r) => r !== rec), undone: taskLog.get().undone.filter((r) => r !== rec) });
    } else {
      taskLog.set(afterCompensation(taskLog.get(), rec, dir, hashNow));
    }
    writeMessage.set({ kind: "info", text: `${dir}: ${c.value ? "checked" : "unchecked"} ${rec.blockId} in ${rec.path} — committed ${receipt.commit ?? "nothing"}` });
  } catch (e) {
    if (isMovedOn(e)) {
      await rereadAfterTaskWrite(rec.path);
      writeMessage.set({ kind: "error", text: `${dir} refused — ${e.code}: the block changed between the check and the write; nothing was overwritten` });
    } else {
      const info = describeToolError(e);
      writeMessage.set({ kind: "error", text: `${dir}: ${info.code} — ${info.message}`, fix: info.fix });
    }
  } finally {
    taskPending.set(null);
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
      try {
        const r = await client.call<{ repos: { slug: string }[] }>("repos", {});
        const slugs = r.repos.map((x) => x.slug);
        repos.set(slugs);
        if (!slugs.includes(repo.get())) repo.set(slugs[0] ?? "");
      } catch { repos.set([]); }
    } else {
      // Without `repos` the only addressable repository is the server's default: never name one.
      repos.set([]);
      repo.set("");
    }
    localStorage.setItem(REPO_KEY, repo.get());
    connection.set("ok");
    connectionMessage.set(`surface ${v} · ${profileLabel(profile.get(), c)}${w.auth.recovered ? " · signed in again" : ""}`);
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

function switchRepo(slug: string): void {
  repo.set(slug);
  localStorage.setItem(REPO_KEY, slug);
  taskLog.set(EMPTY_LOG); // the toggles were in another repository
  doc.set(null);
  rendered.set(null);
  levels.set(new Map());
  consoleResult.set(null);
  consoleRows.set([]);
  void Promise.all([loadLevel("/"), startFeed()]);
  applyRoute(route.get());
}

/** The route decides what the main pane shows. */
let appliedDoc: string | null = null;
let appliedRev: string | null = null;
function applyRoute(r: Route): void {
  if (connection.get() !== "ok") return;
  if (r.deleted) { void loadDeleted(); appliedDoc = null; return; }
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

effect(() => { localStorage.setItem(QUERY_KEY, consoleQuery.get()); });
effect(() => { localStorage.setItem(VIEW_KEY, view.get()); });
effect(() => { localStorage.setItem(SPLIT_KEY, String(splitPosition.get())); });
effect(() => { applyRoute(route.get()); });

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
    header select, header button { font: inherit; font-size: 12.5px; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; }
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
    .main { overflow: auto; padding: 10px 16px; min-height: 0; }
    .console { border-top: 1px solid #e3e6ec; padding: 8px 16px 10px; max-height: 45vh; display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; background: #fafbfc; }
    .console query-console { flex: 1; min-height: 0; }
    .welcome { color: #5a6270; max-width: 64ch; }
    .welcome code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0f1f4; padding: 0 3px; border-radius: 3px; }
    .err { color: #b3261e; }
    sl-tab-group::part(body) { padding-top: 10px; }
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

  private renderMain() {
    const r = route.get();
    if (connection.get() !== "ok") return html`<div class="welcome">${connectionMessage.get() || "connecting…"}</div>`;
    if (r.deleted) return this.renderDeleted();
    const d = doc.get();
    if (!r.doc) {
      const c = caps.get();
      return html`<div class="welcome">
        <p>Pick a document in the tree, run a query below, or follow the live strip above.</p>
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
        <sl-tab-panel name="document" ?active=${r.tab === "document"}>
          <doc-view .doc=${d} .rendered=${rendered.get()} .view=${view.get()} ?canWrite=${canWrite.get()} .pending=${pendingPlan.get()} .writeMessage=${writeMessage.get()} ?writing=${writing.get()} .highlight=${r.block}
            .taskPending=${taskPending.get()} .undoLabel=${undoLabel.get()} .redoLabel=${redoLabel.get()}
            @task-toggle=${(e: CustomEvent<TaskToggleDetail>) => { void toggleTask(e.detail); }}
            @task-undo=${() => { void compensateTask("undo"); }}
            @task-redo=${() => { void compensateTask("redo"); }}
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
          <select .value=${repo.get()} @change=${(e: Event) => switchRepo((e.target as HTMLSelectElement).value)}>
            ${repos.get().map((slug) => html`<option value=${slug} ?selected=${slug === repo.get()}>${slug}</option>`)}
          </select></label>` : html`<span class="label" title="the minimal profile has no repos tool: the server's default repository is browsed">default repo</span>`}
        <button type="button" ?disabled=${state === "connecting"} @click=${() => { void connect(); }}>reconnect</button>
      </header>
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
          <div class="right" slot="end">
            <div class="main">${this.renderMain()}</div>
            <div class="console">
              <query-console .query=${consoleQuery.get()} .result=${consoleResult.get()} .rows=${consoleRows.get()} .error=${consoleError.get()} ?running=${consoleRunning.get()} .syntax=${syntax.get()}
                @console-input=${(e: CustomEvent<{ query: string }>) => consoleQuery.set(e.detail.query)}
                @console-run=${(e: CustomEvent<ConsoleRunDetail>) => onConsoleRun(e.detail.query)}
                @console-more=${onConsoleMore}
                @console-open=${(e: CustomEvent<ConsoleOpenDetail>) => { void openLink(e.detail.link); }}
                @console-syntax=${() => { void loadSyntax(); }}></query-console>
            </div>
          </div>
        </sl-split-panel>
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "repo-explorer-app": RepoExplorerApp }
}
