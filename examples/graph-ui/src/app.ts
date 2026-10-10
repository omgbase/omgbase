// The page: composes the three elements with signals —
//   source → ast → rows → candidates → view → (edges → layout inside <oqx-graph>)
// — plus the MCP settings (server URL / repo, OAuth sign-in for a remote) and a
// status line.

import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { Query } from "@omgbase/oqx";
import "./elements/oqx-query-editor.ts";
import "./elements/oqx-relationship-picker.ts";
import "./elements/oqx-graph.ts";
import type { QueryChangeDetail } from "./elements/oqx-query-editor.ts";
import type { ViewChangeDetail } from "./elements/oqx-relationship-picker.ts";
import type { GraphNode, GraphStateDetail } from "./elements/oqx-graph.ts";
import { inferCandidates, type Candidate, type Row } from "./lib/candidates.ts";
import { defaultView, type View } from "./lib/view.ts";
import { edgeQueries, edgesFromRows, type GraphEdge } from "./lib/edges.ts";
import { AuthRequiredError, OmgClient, type McpSettings } from "./lib/mcp-client.ts";
import { BrowserOAuthProvider, callbackParams, discover, type Discovery, type Identity } from "./lib/oauth.ts";
import { effect } from "./lib/effect.ts";
import type { OqxErrorInfo } from "./lib/errors.ts";

const SETTINGS_KEY = "omgbase-graph-ui.settings";
const QUERY_KEY = "omgbase-graph-ui.query";
const PENDING_KEY = "omgbase-graph-ui.oauth.pending";

export const DEFAULT_QUERY = `select $path, title, phase, before, after
from docs
where $path == "timeline/kickoff.md"
follow $repo.docs collect { where after.contains("/" + ^$path) }
order by $ordinal`;

const DEFAULT_SETTINGS: McpSettings = { url: "http://localhost:8787/mcp", repo: "" };

function loadSettings(): McpSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<McpSettings>) : {};
    return { url: saved.url ?? DEFAULT_SETTINGS.url, repo: saved.repo ?? DEFAULT_SETTINGS.repo };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ---- the dataflow (module-level signals; one page) ---------------------------

const settings = signal<McpSettings>(loadSettings());
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
const candidates = computed<Candidate[]>(() => inferCandidates(ast.get(), rows.get()));
const view = signal<View>(defaultView([]));
const nodes = computed<GraphNode[]>(() => rows.get().map((row) => {
  const path = typeof row.path === "string" ? row.path : String(row.id ?? "");
  const title = typeof row.title === "string" ? row.title : null;
  return { id: String(row.id ?? path), path, label: title ?? path.replace(/\.md$/, ""), row };
}));
const graphState = signal<GraphStateDetail | null>(null);

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

function clientFor(s: Pick<McpSettings, "url">): OmgClient {
  if (!client || client.options.url !== s.url) {
    void client?.close();
    client = new OmgClient({ url: s.url, authProvider: providerFor(s.url) });
  }
  return client;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function refreshRepos(): Promise<void> {
  const s = settings.get();
  connection.set("connecting");
  identity.set(providerFor(s.url).identity());
  try {
    const c = clientFor(s);
    const { repos: list } = await c.repos();
    repos.set(list.map((r) => r.slug));
    if (!list.some((r) => r.slug === s.repo)) settings.set({ ...s, repo: list[0]?.slug ?? "" });
    identity.set(providerFor(s.url).identity());
    connection.set("ok");
    connectionMessage.set(`${list.length} repo${list.length === 1 ? "" : "s"}`);
  } catch (e) {
    if (e instanceof AuthRequiredError) return; // the browser is on its way to the authorization server
    connection.set("error");
    connectionMessage.set(describeError(e));
    // Show what sign-in would involve (issuer, scopes) — harmless if there is none.
    discover(s.url).then((d) => discovery.set(d), () => discovery.set(null));
  }
}

function disconnect(): void {
  const s = settings.get();
  providerFor(s.url).clear();
  void client?.close();
  client = null;
  identity.set(null);
  repos.set([]);
  rows.set([]);
  connection.set("idle");
  connectionMessage.set("signed out");
}

/** Back from the authorization server with `?code=…&state=…` (or `?error=…`). */
async function finishSignIn(): Promise<boolean> {
  const cb = callbackParams(location.href);
  if (!cb.code && !cb.error) return false;
  const pendingRaw = localStorage.getItem(PENDING_KEY);
  localStorage.removeItem(PENDING_KEY);
  history.replaceState(null, "", location.pathname);
  const pending = pendingRaw ? (JSON.parse(pendingRaw) as { serverUrl?: string }) : {};
  const serverUrl = pending.serverUrl ?? settings.get().url;
  const provider = providerFor(serverUrl);
  const expectedState = provider.consumeState();
  connection.set("connecting");
  try {
    if (cb.error) throw new Error(`${cb.error}${cb.errorDescription ? `: ${cb.errorDescription}` : ""}`);
    if (expectedState && cb.state !== expectedState) throw new Error("OAuth state mismatch — the sign-in did not start from this page");
    await clientFor({ url: serverUrl }).finishAuth(cb.code!);
    settings.set({ ...settings.get(), url: serverUrl });
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
  const text = source.get();
  if (!q || !s.repo) return;
  const gen = ++runGeneration;
  queryError.set(null);
  try {
    const result = await clientFor(s).query(text, { repo: s.repo, limit: 200 });
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
  const all: Record<string, unknown>[] = [];
  for (const q of edgeQueries(candidate, paths)) all.push(...(await clientFor(s).queryAll(q, { repo: s.repo })));
  return edgesFromRows(candidate, all, new Set(paths));
}

// Boot: finish a pending sign-in first, then install the effects (persist
// settings + query; reconnect on URL change; re-run on ast/repo).
void (async () => {
  await finishSignIn();
  effect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.get())); });
  effect(() => { localStorage.setItem(QUERY_KEY, source.get()); });
  let lastUrl = "";
  effect(() => {
    const { url } = settings.get();
    if (url === lastUrl) return;
    lastUrl = url;
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
    main { display: grid; grid-template-columns: minmax(360px, 2fr) minmax(0, 3fr); gap: 12px; padding: 12px 14px; min-height: 0; }
    .left { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; }
    .left h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #5a6270; margin: 0 0 6px; }
    oqx-graph { height: 100%; min-height: 420px; }
    footer { padding: 6px 14px; border-top: 1px solid #e3e6ec; font-size: 12px; color: #5a6270; display: flex; gap: 14px; flex-wrap: wrap; }
    footer .err { color: #c62828; }
    details.settings { font-size: 13px; }
    details.settings summary { cursor: pointer; color: #5a6270; }
    .settings form { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; padding: 8px 0; }
    .settings input, .settings select, .settings button { font: inherit; padding: 3px 6px; }
    .settings .row { display: flex; gap: 8px; align-items: center; }
    .settings .auth { grid-column: 1 / -1; color: #5a6270; font-size: 12px; }
    .settings .auth code { font-family: ui-monospace, monospace; }
    .selection { font-size: 12px; background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 6px; padding: 8px 10px; max-height: 200px; overflow: auto; }
    .selection pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px ui-monospace, monospace; }
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

  private connect(): void {
    const url = (this.urlDraft ?? settings.get().url).trim();
    this.urlDraft = null;
    if (url !== settings.get().url) settings.set({ ...settings.get(), url }); // the URL effect reconnects
    else void refreshRepos();
  }

  protected override render() {
    const s = settings.get();
    const conn = connection.get();
    const cands = candidates.get();
    const v = view.get();
    const gs = graphState.get();
    const r = rows.get();
    const pe = parseError.get();
    const qe = queryError.get();
    const who = identity.get();
    const disc = discovery.get();
    return html`
      <header>
        <h1>omgbase graph UI</h1>
        <span class="conn ${conn === "error" ? "error" : ""}">${s.url} · ${conn === "ok" ? connectionMessage.get() : conn === "error" ? `error: ${connectionMessage.get()}` : conn === "sign-in" ? connectionMessage.get() : conn}${who?.email ? ` · ${who.email}` : ""}</span>
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
            <oqx-relationship-picker .candidates=${cands} @view-change=${this.onViewChange}
              @candidate-hover=${(e: CustomEvent<{ candidate: Candidate | null }>) => { this.highlights = e.detail.candidate?.spans ?? []; }}>
            </oqx-relationship-picker>
          </section>
          ${this.selected ? html`<section class="selection">
            <b>${this.selected.path}</b>
            <pre>${JSON.stringify(this.selected.row, null, 1)}</pre>
          </section>` : nothing}
          <details class="settings" ?open=${conn === "error"}>
            <summary>MCP settings</summary>
            <form @submit=${(e: Event) => { e.preventDefault(); this.connect(); }}>
              <label for="url">server</label>
              <input id="url" .value=${this.urlDraft ?? s.url} @input=${(e: Event) => { this.urlDraft = (e.target as HTMLInputElement).value; }}
                placeholder="http://localhost:8787/mcp or https://host/omg">
              <span></span>
              <span class="row">
                <button type="submit">connect</button>
                ${who || providerFor(s.url).hasTokens() ? html`<button type="button" @click=${disconnect}>disconnect</button>` : nothing}
                ${who ? html`<span>signed in as <b>${who.email ?? who.name ?? who.subject}</b></span>` : html`<span>local bridge: no sign-in; a remote that answers 401 starts OAuth (PKCE, dynamic registration)</span>`}
              </span>
              ${disc ? html`<div class="auth">sign-in would use <code>${disc.authorizationServerUrl}</code>${disc.scope ? html` with scopes <code>${disc.scope}</code>` : nothing}${disc.authorizationServer.registration_endpoint ? " (dynamic registration available)" : " (no dynamic registration!)"}</div>` : nothing}
            </form>
          </details>
        </div>
        <oqx-graph .nodes=${nodes.get()} .view=${v} .candidates=${cands} .fetchEdges=${fetchEdges}
          @node-select=${(e: CustomEvent<{ node: GraphNode | null }>) => { this.selected = e.detail.node; }}
          @graph-state=${(e: CustomEvent<GraphStateDetail>) => graphState.set(e.detail)}></oqx-graph>
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

declare global {
  interface HTMLElementTagNameMap { "graph-ui-app": GraphUiApp }
}
