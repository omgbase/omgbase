// The page: composes the three elements with signals —
//   source → ast → rows → candidates → view → (edges → layout inside <oqx-graph>)
// — plus the MCP settings (three ways to reach omgbase: the local bridge over
// the sample, the local bridge proxying a remote it signed in to, or the remote
// directly with the browser as the OAuth client) and a status line.

import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { Query } from "@omgbase/oqx";
import "./elements/oqx-query-editor.ts";
import "./elements/oqx-relationship-picker.ts";
import "./elements/oqx-graph.ts";
import type { QueryChangeDetail } from "./elements/oqx-query-editor.ts";
import type { ArmedChangeDetail, ViewChangeDetail } from "./elements/oqx-relationship-picker.ts";
import type { EdgeToggleDetail, GraphNode, GraphStateDetail, PendingEdge } from "./elements/oqx-graph.ts";
import { inferCandidates, type Candidate, type Row } from "./lib/candidates.ts";
import { defaultView, type View } from "./lib/view.ts";
import { edgeQueries, edgesFromRows, type GraphEdge } from "./lib/edges.ts";
import { describePatch, editability, projectedFields, type Editability, type EmptyListBehavior } from "./lib/edit.ts";
import { PerKeyQueue, applyToggle, describeMutationError, prepareToggle, type TogglePlan } from "./lib/mutations.ts";
import { AuthRequiredError, OmgClient, serverUrlFor, type McpMode, type McpSettings } from "./lib/mcp-client.ts";
import { BrowserOAuthProvider, callbackParams, discover, type Discovery, type Identity } from "./lib/oauth.ts";
import { fetchBridgeInfo, type BridgeInfo } from "./lib/bridge-info.ts";
import { effect } from "./lib/effect.ts";
import type { OqxErrorInfo } from "./lib/errors.ts";

const SETTINGS_KEY = "omgbase-graph-ui.settings";
const QUERY_KEY = "omgbase-graph-ui.query";
const PENDING_KEY = "omgbase-graph-ui.oauth.pending";
const EDIT_KEY = "omgbase-graph-ui.edit";

/** How edge edits are written (persisted under EDIT_KEY). */
interface EditSettings {
  /** Show the confirm strip (which file and field change) before every write. */
  confirm: boolean;
  /** What a list that lost its last member becomes. */
  emptyListBehavior: EmptyListBehavior;
}

const DEFAULT_EDIT: EditSettings = { confirm: true, emptyListBehavior: "unset" };

function loadEditSettings(): EditSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(EDIT_KEY) ?? "{}") as Partial<EditSettings>;
    return { confirm: saved.confirm ?? DEFAULT_EDIT.confirm, emptyListBehavior: saved.emptyListBehavior === "keep" ? "keep" : "unset" };
  } catch {
    return DEFAULT_EDIT;
  }
}

export const DEFAULT_QUERY = `select $path, title, phase, before, after
from docs
where $path == "timeline/kickoff.md"
follow $repo.docs collect { where after.contains("/" + ^$path) }
order by $ordinal`;

/** The bridge sits behind Vite's proxy at the same origin; `pnpm dev` starts both. */
const DEFAULT_SETTINGS: McpSettings = { mode: "local", bridgeUrl: "/mcp", directUrl: "", repo: "" };

const MODE_LABEL: Record<McpMode, string> = { local: "local sample", proxy: "via local proxy", direct: "direct" };

function loadSettings(): McpSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<McpSettings> & { url?: string }) : {};
    const s: McpSettings = {
      mode: saved.mode ?? DEFAULT_SETTINGS.mode,
      bridgeUrl: saved.bridgeUrl ?? DEFAULT_SETTINGS.bridgeUrl,
      directUrl: saved.directUrl ?? DEFAULT_SETTINGS.directUrl,
      repo: saved.repo ?? DEFAULT_SETTINGS.repo,
    };
    // Settings written before modes existed had one `url`.
    if (saved.url && saved.mode === undefined) {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(saved.url)) s.bridgeUrl = saved.url;
      else { s.mode = "direct"; s.directUrl = saved.url; }
    }
    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ---- the dataflow (module-level signals; one page) ---------------------------

const settings = signal<McpSettings>(loadSettings());
const serverUrl = computed<string>(() => {
  try { return serverUrlFor(settings.get()); } catch { return ""; }
});
const source = signal<string>(localStorage.getItem(QUERY_KEY) ?? DEFAULT_QUERY);
const ast = signal<Query | null>(null);
const parseError = signal<OqxErrorInfo | null>(null);
const rows = signal<Row[]>([]);
const truncated = signal(false);
const queryError = signal<string | null>(null);
const repos = signal<string[]>([]);
const connection = signal<"idle" | "connecting" | "ok" | "error" | "sign-in">("idle");
const connectionMessage = signal<string>("");
const identity = signal<Identity | null>(null);
const discovery = signal<Discovery | null>(null);
const bridge = signal<BridgeInfo | null>(null);
const bridgeError = signal<string | null>(null);
const candidates = computed<Candidate[]>(() => inferCandidates(ast.get(), rows.get()));
const view = signal<View>(defaultView([]));
const nodes = computed<GraphNode[]>(() => rows.get().map((row) => {
  const path = typeof row.path === "string" ? row.path : String(row.id ?? "");
  const title = typeof row.title === "string" ? row.title : null;
  return { id: String(row.id ?? path), path, label: title ?? path.replace(/\.md$/, ""), row };
}));
const graphState = signal<GraphStateDetail | null>(null);

// ---- edge editing -----------------------------------------------------------------

/** The server's tool names (null until listed, or when listing failed — then assume the full set). */
const tools = signal<string[] | null>(null);
const canWrite = computed<boolean>(() => tools.get()?.includes("docs_set_meta") ?? true);
const editable = computed<Record<string, Editability>>(() =>
  Object.fromEntries(candidates.get().map((c) => [c.name, editability(c, rows.get(), canWrite.get())])));
const writable = computed<string[]>(() => Object.entries(editable.get()).filter(([, e]) => e.writable).map(([name]) => name));
const armed = signal<Candidate | null>(null);
const editSettings = signal<EditSettings>(loadEditSettings());
/** Optimistic edges while a write is in flight. */
const pending = signal<PendingEdge[]>([]);
/** The toggle waiting for the user's confirmation. */
const proposal = signal<TogglePlan | null>(null);
const editMessage = signal<{ kind: "error" | "info"; text: string } | null>(null);
const editBusy = signal(false);
const mutations = new PerKeyQueue();
/** Set after a write: the next settled graph layout clears the optimistic edges. */
let settlePending = false;

// ---- MCP client + OAuth -----------------------------------------------------------

/** This page is its own redirect URI (the query string carries the code back). */
const REDIRECT_URL = `${location.origin}${location.pathname}`;

const providers = new Map<string, BrowserOAuthProvider>();
function providerFor(url: string): BrowserOAuthProvider {
  let p = providers.get(url);
  if (!p) {
    p = new BrowserOAuthProvider(url, {
      redirectUrl: REDIRECT_URL,
      onBeforeRedirect: () => {
        // The query is already persisted under QUERY_KEY; remember which server
        // the round trip is for so the callback can finish the right exchange.
        localStorage.setItem(PENDING_KEY, JSON.stringify({ serverUrl: url }));
        connection.set("sign-in");
        connectionMessage.set("redirecting to sign in…");
      },
    });
    providers.set(url, p);
  }
  return p;
}

let client: OmgClient | null = null;

function clientFor(url: string): OmgClient {
  if (!client || client.options.url !== url) {
    void client?.close();
    client = new OmgClient({ url, authProvider: providerFor(url) });
  }
  return client;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- the bridge's status (local and proxy modes) ------------------------------------

let bridgePoll: ReturnType<typeof setTimeout> | null = null;

/** Ask the bridge who it is; in proxy mode its sign-in state drives the status line. */
async function refreshBridge(): Promise<BridgeInfo | null> {
  const s = settings.get();
  if (s.mode === "direct") { bridge.set(null); return null; }
  try {
    const info = await fetchBridgeInfo(s.bridgeUrl);
    bridge.set(info);
    bridgeError.set(null);
    return info;
  } catch (e) {
    bridge.set(null);
    bridgeError.set(describeError(e));
    return null;
  }
}

/** While the bridge waits for the user's consent in their browser, poll it and reconnect once it is in. */
function watchBridgeSignIn(): void {
  if (bridgePoll) clearTimeout(bridgePoll);
  bridgePoll = setTimeout(async () => {
    bridgePoll = null;
    const info = await refreshBridge();
    if (!info || settings.get().mode === "direct") return;
    if (info.auth.state === "waiting") {
      connection.set("sign-in");
      connectionMessage.set("waiting for sign-in in your browser");
      watchBridgeSignIn();
    } else if (info.auth.state === "error") {
      connection.set("error");
      connectionMessage.set(`bridge sign-in failed: ${info.auth.error ?? "unknown error"}`);
    } else if (connection.get() !== "ok") {
      void refreshRepos();
    }
  }, 1500);
}

async function refreshRepos(): Promise<void> {
  const s = settings.get();
  const url = serverUrl.get();
  if (!url) {
    connection.set("error");
    connectionMessage.set(s.mode === "direct" ? "enter the remote server URL" : "enter the bridge URL");
    return;
  }
  connection.set("connecting");
  connectionMessage.set("");
  identity.set(s.mode === "direct" ? providerFor(url).identity() : null);
  if (s.mode !== "direct") {
    const info = await refreshBridge();
    if (info?.auth.state === "waiting") {
      connection.set("sign-in");
      connectionMessage.set("waiting for sign-in in your browser");
      watchBridgeSignIn();
      return;
    }
    if (info?.identity) identity.set(info.identity);
  }
  try {
    const c = clientFor(url);
    const { repos: list } = await c.repos();
    repos.set(list.map((r) => r.slug));
    // Which tools the server (or the gateway in front of it) offers decides whether edges can be edited.
    c.tools().then((names) => tools.set(names), () => tools.set(null));
    if (!list.some((r) => r.slug === s.repo)) settings.set({ ...settings.get(), repo: list[0]?.slug ?? "" });
    if (s.mode === "direct") identity.set(providerFor(url).identity());
    else { const info = await refreshBridge(); if (info?.identity) identity.set(info.identity); }
    connection.set("ok");
    connectionMessage.set(`${list.length} repo${list.length === 1 ? "" : "s"}`);
  } catch (e) {
    if (e instanceof AuthRequiredError) return; // the browser is on its way to the authorization server
    if (s.mode !== "direct") {
      // The bridge may have opened the user's browser while our request waited; keep polling it.
      const info = await refreshBridge();
      if (info?.auth.state === "waiting") {
        connection.set("sign-in");
        connectionMessage.set("waiting for sign-in in your browser");
        watchBridgeSignIn();
        return;
      }
    }
    connection.set("error");
    connectionMessage.set(describeError(e));
    // Show what sign-in would involve (issuer, scopes) — harmless if there is none.
    if (s.mode === "direct") discover(url).then((d) => discovery.set(d), () => discovery.set(null));
  }
}

function disconnect(): void {
  const url = serverUrl.get();
  if (url) providerFor(url).clear();
  void client?.close();
  client = null;
  identity.set(null);
  repos.set([]);
  rows.set([]);
  tools.set(null);
  connection.set("idle");
  connectionMessage.set("signed out");
}

/** Back from the authorization server with `?code=…&state=…` (or `?error=…`) — direct mode only. */
async function finishSignIn(): Promise<boolean> {
  const cb = callbackParams(location.href);
  if (!cb.code && !cb.error) return false;
  const pendingRaw = localStorage.getItem(PENDING_KEY);
  localStorage.removeItem(PENDING_KEY);
  history.replaceState(null, "", location.pathname);
  const pending = pendingRaw ? (JSON.parse(pendingRaw) as { serverUrl?: string }) : {};
  const url = pending.serverUrl ?? serverUrl.get();
  const provider = providerFor(url);
  const expectedState = provider.consumeState();
  connection.set("connecting");
  try {
    if (cb.error) throw new Error(`${cb.error}${cb.errorDescription ? `: ${cb.errorDescription}` : ""}`);
    if (expectedState && cb.state !== expectedState) throw new Error("OAuth state mismatch — the sign-in did not start from this page");
    await clientFor(url).finishAuth(cb.code!);
    settings.set({ ...settings.get(), mode: "direct", directUrl: url });
    identity.set(provider.identity());
    return true;
  } catch (e) {
    connection.set("error");
    connectionMessage.set(`sign-in failed: ${describeError(e)}`);
    return false;
  }
}

let runGeneration = 0;
async function runQuery(): Promise<void> {
  const q = ast.get();
  const s = settings.get();
  const url = serverUrl.get();
  const text = source.get();
  if (!q || !s.repo || !url) return;
  const gen = ++runGeneration;
  queryError.set(null);
  try {
    const result = await clientFor(url).query(text, { repo: s.repo, limit: 200 });
    if (gen !== runGeneration) return;
    rows.set(result.hits);
    truncated.set(result.truncated);
  } catch (e) {
    if (gen !== runGeneration || e instanceof AuthRequiredError) return;
    queryError.set(describeError(e));
  }
}

/** The graph's edge source: generated OQX over the `edges` target via the `query` tool. */
async function fetchEdges(candidate: Candidate, paths: string[]): Promise<GraphEdge[]> {
  const s = settings.get();
  const url = serverUrl.get();
  const all: Record<string, unknown>[] = [];
  for (const q of edgeQueries(candidate, paths)) all.push(...(await clientFor(url).queryAll(q, { repo: s.repo })));
  return edgesFromRows(candidate, all, new Set(paths));
}

// ---- edge editing: plan, confirm, write, refresh ----------------------------------------

/** A ⌘-click arrived: work out the exact patch (reading the owner if the query
 * did not project the field), then either show it for confirmation or write it. */
async function proposeToggle(detail: EdgeToggleDetail): Promise<void> {
  const { candidate, from: owner, to: target, present } = detail;
  const ed = editable.get()[candidate.name];
  editMessage.set(null);
  if (!ed?.writable) {
    editMessage.set({ kind: "error", text: `${candidate.name} is read-only: ${ed?.reason ?? "unknown relationship"}` });
    return;
  }
  const s = settings.get();
  editBusy.set(true);
  try {
    const plan = await prepareToggle(clientFor(serverUrl.get()), {
      owner: { id: owner.id, path: owner.path },
      target: { id: target.id, path: target.path },
      field: candidate.name,
      present,
      form: ed.form,
      options: { shape: ed.shape, emptyListBehavior: editSettings.get().emptyListBehavior },
      row: owner.row,
      projected: projectedFields(ast.get()).includes(candidate.name),
      ...(s.repo ? { repo: s.repo } : {}),
    });
    if (plan.patch.kind === "noop" || plan.patch.kind === "refuse") {
      editMessage.set({ kind: plan.patch.kind === "noop" ? "info" : "error", text: describePatch(plan.owner, plan.field, plan.patch, plan.previous) });
      if (plan.patch.kind === "noop") void runQuery(); // the drawing was stale — refresh it
      return;
    }
    if (editSettings.get().confirm) proposal.set(plan);
    else await writeToggle(plan);
  } catch (e) {
    editMessage.set({ kind: "error", text: describeMutationError(e, "docs_read") });
  } finally {
    editBusy.set(false);
  }
}

/** Write the plan with an optimistic dashed edge; on failure revert and say why. */
async function writeToggle(plan: TogglePlan): Promise<void> {
  proposal.set(null);
  const preview: PendingEdge = { src: plan.owner.path, dst: plan.target.path, rel: plan.field, action: plan.present ? "remove" : "add" };
  pending.set([...pending.get(), preview]);
  editBusy.set(true);
  try {
    await applyToggle(clientFor(serverUrl.get()), mutations, plan, settings.get().repo || undefined);
    editMessage.set({ kind: "info", text: describePatch(plan.owner, plan.field, plan.patch, plan.previous) });
    settlePending = true;
    await runQuery();
    // The graph refetches edges for the new rows and reports a settled layout; if
    // that never comes (the query failed, rows unchanged), drop the preview anyway.
    setTimeout(() => { if (settlePending) { settlePending = false; pending.set([]); } }, 4000);
  } catch (e) {
    pending.set(pending.get().filter((p) => p !== preview));
    editMessage.set({ kind: "error", text: describeMutationError(e) });
  } finally {
    editBusy.set(false);
  }
}

function onGraphState(detail: GraphStateDetail): void {
  graphState.set(detail);
  if (settlePending && !detail.busy) {
    settlePending = false;
    pending.set([]);
  }
}

// Boot: finish a pending sign-in first, then install the effects (persist
// settings + query; reconnect on URL change; re-run on ast/repo).
void (async () => {
  await finishSignIn();
  effect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.get())); });
  effect(() => { localStorage.setItem(QUERY_KEY, source.get()); });
  effect(() => { localStorage.setItem(EDIT_KEY, JSON.stringify(editSettings.get())); });
  let last = "";
  effect(() => {
    const key = `${settings.get().mode} ${serverUrl.get()}`;
    if (key === last) return;
    last = key;
    discovery.set(null);
    void refreshRepos();
  });
  effect(() => {
    const q = ast.get();
    const repo = settings.get().repo;
    if (!q || !repo) return;
    void runQuery();
  });
})();

// ---- the page element ---------------------------------------------------------

@customElement("graph-ui-app")
export class GraphUiApp extends SignalWatcher(LitElement) {
  static override styles = css`
    :host { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; font: 14px/1.4 system-ui, sans-serif; color: #1e2430; background: #fff; }
    header { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid #e3e6ec; }
    header h1 { font-size: 15px; margin: 0; font-weight: 600; }
    header .spacer { flex: 1; }
    header .conn { font-size: 12px; color: #5a6270; }
    header .conn.error { color: #c62828; }
    header .conn.sign-in { color: #b26a00; }
    main { display: grid; grid-template-columns: minmax(360px, 2fr) minmax(0, 3fr); gap: 12px; padding: 12px 14px; min-height: 0; }
    .left { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; }
    .left h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #5a6270; margin: 0 0 6px; }
    oqx-graph { height: 100%; min-height: 420px; }
    footer { padding: 6px 14px; border-top: 1px solid #e3e6ec; font-size: 12px; color: #5a6270; display: flex; gap: 14px; flex-wrap: wrap; }
    footer .err { color: #c62828; }
    details.settings { font-size: 13px; }
    details.settings summary { cursor: pointer; color: #5a6270; }
    .settings form { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; padding: 8px 0; }
    .settings input[type="text"], .settings select, .settings button { font: inherit; padding: 3px 6px; }
    .settings .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .settings .modes { display: flex; gap: 12px; flex-wrap: wrap; }
    .settings .modes label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
    .settings .auth, .settings .hint { grid-column: 1 / -1; color: #5a6270; font-size: 12px; }
    .settings .hint.warn { color: #b26a00; }
    .settings code { font-family: ui-monospace, monospace; }
    .selection { font-size: 12px; background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 6px; padding: 8px 10px; max-height: 200px; overflow: auto; }
    .selection pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px ui-monospace, monospace; }
    .edit { font-size: 12px; color: #5a6270; display: flex; flex-direction: column; gap: 6px; }
    .edit .opts { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
    .edit .opts label { display: inline-flex; gap: 4px; align-items: center; }
    .edit select { font: inherit; }
    .strip { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 10px; border-radius: 6px; border: 1px solid #ffe082; background: #fff8e1; color: #6d4c00; }
    .strip code, .msg code { font-family: ui-monospace, monospace; word-break: break-all; }
    .strip button { font: inherit; }
    .msg { padding: 6px 10px; border-radius: 6px; border: 1px solid #e3e6ec; background: #f7f8fa; }
    .msg.error { border-color: #ef9a9a; background: #fff5f5; color: #c62828; }
  `;

  @state() private highlights: [number, number][] = [];
  @state() private selected: GraphNode | null = null;
  @state() private urlDraft: string | null = null;

  private onQueryChange(e: CustomEvent<QueryChangeDetail>): void {
    source.set(e.detail.source);
    parseError.set(e.detail.error);
    if (e.detail.query) ast.set(e.detail.query);
  }

  private onViewChange(e: CustomEvent<ViewChangeDetail>): void {
    view.set(e.detail.view);
  }

  private setMode(mode: McpMode): void {
    this.urlDraft = null;
    if (mode !== settings.get().mode) settings.set({ ...settings.get(), mode }); // the URL effect reconnects
  }

  private connect(): void {
    const s = settings.get();
    const current = s.mode === "direct" ? s.directUrl : s.bridgeUrl;
    const url = (this.urlDraft ?? current).trim();
    this.urlDraft = null;
    if (url !== current) settings.set(s.mode === "direct" ? { ...s, directUrl: url } : { ...s, bridgeUrl: url }); // the URL effect reconnects
    else void refreshRepos();
  }

  private renderBridgeHint(info: BridgeInfo | null, mode: McpMode) {
    const err = bridgeError.get();
    if (!info) {
      return html`<div class="hint warn">no bridge answered <code>/whoami</code>${err ? ` (${err})` : ""} — start it with
        <code>pnpm --filter graph-ui dev${mode === "proxy" ? " --remote &lt;mcp-url&gt;" : ""}</code></div>`;
    }
    if (mode === "proxy" && info.mode !== "remote") {
      return html`<div class="hint warn">the bridge is serving the local sample (<code>${info.upstream}</code>) — restart it with
        <code>pnpm --filter graph-ui dev --remote &lt;mcp-url&gt;</code> (or <code>GRAPH_UI_REMOTE=&lt;mcp-url&gt;</code>)</div>`;
    }
    if (mode === "local" && info.mode !== "local") {
      return html`<div class="hint warn">the bridge is proxying <code>${info.upstream}</code>, not the local sample — pick <i>via local proxy</i>, or restart it without <code>--remote</code></div>`;
    }
    if (info.mode === "remote") {
      const who = info.identity;
      const a = info.auth;
      return html`<div class="hint">upstream <code>${info.upstream}</code>
        ${a.state === "waiting" ? html` · <b>waiting for sign-in in your browser</b>${a.authorizationUrl ? html` (<a href=${a.authorizationUrl} target="_blank" rel="noopener">open the sign-in page</a>)` : nothing}` : nothing}
        ${a.state === "error" ? html` · <span class="warn">sign-in failed: ${a.error}</span>` : nothing}
        ${a.state === "ok" ? html` · signed in${who ? html` as <b>${who.email ?? who.name ?? who.subject}</b>` : ""}` : nothing}
        ${a.issuer ? html` · issuer <code>${a.issuer}</code>` : nothing}
        ${info.tokenFile ? html` · tokens in <code>${info.tokenFile}</code> (<code>pnpm --filter graph-ui logout</code> forgets them)` : nothing}</div>`;
    }
    return html`<div class="hint">bridge serving <code>${info.upstream}</code> · no sign-in</div>`;
  }

  /** The edge-editing panel: the confirm strip, the last message, the two settings. */
  private renderEdit() {
    const a = armed.get();
    const p = proposal.get();
    const m = editMessage.get();
    const es = editSettings.get();
    const busy = editBusy.get();
    if (!a && !p && !m && Object.keys(editable.get()).length === 0) return nothing;
    return html`<section class="edit">
      ${p ? html`<div class="strip">
        <span>write <code>${describePatch(p.owner, p.field, p.patch, p.previous)}</code> via <code>docs_set_meta</code>?</span>
        <button ?disabled=${busy} @click=${() => { void writeToggle(p); }}>apply</button>
        <button ?disabled=${busy} @click=${() => proposal.set(null)}>cancel</button>
      </div>` : nothing}
      ${m ? html`<div class="msg ${m.kind}">${m.text} <button @click=${() => editMessage.set(null)}>dismiss</button></div>` : nothing}
      <div class="opts">
        <span>${busy ? "writing…" : a ? html`editing <code>${a.name}</code>` : "arm a relationship (edit column) to toggle edges"}</span>
        <label><input type="checkbox" .checked=${es.confirm} @change=${(e: Event) => editSettings.set({ ...es, confirm: (e.target as HTMLInputElement).checked })}> confirm before writing</label>
        <label>emptied list
          <select .value=${es.emptyListBehavior} @change=${(e: Event) => editSettings.set({ ...es, emptyListBehavior: (e.target as HTMLSelectElement).value as EmptyListBehavior })}>
            <option value="unset">unset the field</option>
            <option value="keep">keep []</option>
          </select>
        </label>
      </div>
    </section>`;
  }

  protected override render() {
    const s = settings.get();
    const url = serverUrl.get();
    const conn = connection.get();
    const cands = candidates.get();
    const v = view.get();
    const gs = graphState.get();
    const r = rows.get();
    const pe = parseError.get();
    const qe = queryError.get();
    const who = identity.get();
    const disc = discovery.get();
    const info = bridge.get();
    const shownUrl = s.mode === "direct" ? s.directUrl : s.bridgeUrl;
    const connText = conn === "ok" ? connectionMessage.get() : conn === "error" ? `error: ${connectionMessage.get()}` : conn === "sign-in" ? connectionMessage.get() : conn;
    return html`
      <header>
        <h1>omgbase graph UI</h1>
        <span class="conn ${conn === "error" ? "error" : conn === "sign-in" ? "sign-in" : ""}">${MODE_LABEL[s.mode]} · ${s.mode === "proxy" && info?.mode === "remote" ? info.upstream : shownUrl} · ${connText}${who?.email ? ` · ${who.email}` : ""}</span>
        <span class="spacer"></span>
        <label>repo
          <select .value=${s.repo} @change=${(e: Event) => settings.set({ ...settings.get(), repo: (e.target as HTMLSelectElement).value })}>
            ${repos.get().map((slug) => html`<option value=${slug} ?selected=${slug === s.repo}>${slug}</option>`)}
          </select>
        </label>
      </header>
      <main>
        <div class="left">
          <section>
            <h2>query</h2>
            <oqx-query-editor .value=${source.get()} .highlights=${this.highlights} @query-change=${this.onQueryChange}></oqx-query-editor>
          </section>
          <section>
            <h2>relationships</h2>
            <oqx-relationship-picker .candidates=${cands} .editable=${editable.get()} .armed=${armed.get()?.name ?? null}
              @view-change=${this.onViewChange}
              @armed-change=${(e: CustomEvent<ArmedChangeDetail>) => { armed.set(e.detail.candidate); proposal.set(null); }}
              @candidate-hover=${(e: CustomEvent<{ candidate: Candidate | null }>) => { this.highlights = e.detail.candidate?.spans ?? []; }}>
            </oqx-relationship-picker>
          </section>
          ${this.renderEdit()}
          ${this.selected ? html`<section class="selection">
            <b>${this.selected.path}</b>
            <pre>${JSON.stringify(this.selected.row, null, 1)}</pre>
          </section>` : nothing}
          <details class="settings" ?open=${conn === "error" || conn === "sign-in"}>
            <summary>MCP settings</summary>
            <form @submit=${(e: Event) => { e.preventDefault(); this.connect(); }}>
              <label>mode</label>
              <span class="modes">
                ${(["local", "proxy", "direct"] as McpMode[]).map((m) => html`<label title=${MODE_TITLE[m]}>
                  <input type="radio" name="mode" .checked=${s.mode === m} @change=${() => this.setMode(m)}> ${MODE_LABEL[m]}</label>`)}
              </span>
              <label for="url">${s.mode === "direct" ? "server" : "bridge"}</label>
              <input id="url" type="text" .value=${this.urlDraft ?? shownUrl} @input=${(e: Event) => { this.urlDraft = (e.target as HTMLInputElement).value; }}
                placeholder=${s.mode === "direct" ? "https://host/omg" : "/mcp or http://localhost:8787/mcp"}>
              <span></span>
              <span class="row">
                <button type="submit">connect</button>
                ${s.mode === "direct" && url && (who || providerFor(url).hasTokens()) ? html`<button type="button" @click=${disconnect}>disconnect</button>` : nothing}
                ${s.mode === "direct" ? (who
                  ? html`<span>signed in as <b>${who.email ?? who.name ?? who.subject}</b></span>`
                  : html`<span>the browser is the OAuth client: the gateway must send CORS headers for this origin and Auth0 must allow it as a web origin — see the README</span>`) : nothing}
              </span>
              ${s.mode === "direct" && disc ? html`<div class="auth">sign-in would use <code>${disc.authorizationServerUrl}</code>${disc.scope ? html` with scopes <code>${disc.scope}</code>` : nothing}${disc.authorizationServer.registration_endpoint ? " (dynamic registration available)" : " (no dynamic registration!)"}</div>` : nothing}
              ${s.mode !== "direct" ? this.renderBridgeHint(info, s.mode) : nothing}
            </form>
          </details>
        </div>
        <oqx-graph .nodes=${nodes.get()} .view=${v} .candidates=${cands} .fetchEdges=${fetchEdges}
          .armed=${armed.get()} .writable=${writable.get()} .pending=${pending.get()}
          @node-select=${(e: CustomEvent<{ node: GraphNode | null }>) => { this.selected = e.detail.node; proposal.set(null); }}
          @edge-toggle=${(e: CustomEvent<EdgeToggleDetail>) => { void proposeToggle(e.detail); }}
          @graph-state=${(e: CustomEvent<GraphStateDetail>) => onGraphState(e.detail)}></oqx-graph>
      </main>
      <footer>
        <span>${r.length} row${r.length === 1 ? "" : "s"}${truncated.get() ? " (truncated at 200)" : ""}</span>
        <span>${cands.length} candidate${cands.length === 1 ? "" : "s"}</span>
        <span>edges: ${v.edges.length ? v.edges.join(", ") : "none"}</span>
        <span>layout: ${v.layout.axis ? `${v.layout.axis} (${v.layout.direction})` : "force"}</span>
        ${gs ? html`<span>${gs.busy ? "laying out…" : `${gs.edges} edges drawn${gs.cycles.length ? `, ${gs.cycles.length} cycle(s)` : ""}`}</span>` : nothing}
        ${pe ? html`<span class="err">parse: ${pe.message}</span>` : nothing}
        ${qe ? html`<span class="err">query: ${qe}</span>` : nothing}
      </footer>
    `;
  }
}

const MODE_TITLE: Record<McpMode, string> = {
  local: "the local bridge serving ./sample over `omg mcp` (pnpm dev)",
  proxy: "the local bridge signed in to a remote omg MCP on your behalf (pnpm dev --remote <url>); no CORS or Auth0 setup needed",
  direct: "the browser connects to the remote itself and is the OAuth client; needs CORS on the gateway and web origins in Auth0",
};

declare global {
  interface HTMLElementTagNameMap { "graph-ui-app": GraphUiApp }
}
