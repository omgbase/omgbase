// The page: composes the four elements with signals —
//   source → ast → rows → candidates ─┬→ view → (edges → layout inside <oqx-graph>)
//                      └→ projection ─┘   (which fields the node cards show)
// — plus the MCP settings (three ways to reach omgbase: the local bridge over
// the sample, the local bridge proxying a remote it signed in to, or the remote
// directly with the browser as the OAuth client) and a status line.
//
// Chrome: Shoelace, imported per component — `<sl-split-panel>` between the side
// panel and the graph (position persisted; the graph refits itself on resize),
// `<sl-details>` for the side panel's stacked sections (open state persisted).
// Shoelace is Lit-built and registers its own `sl-*` tags; its light theme sets
// the `--sl-*` tokens on `:root`, which shadow roots inherit.

import { LitElement, css, html, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { Signal, SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { Query } from "@omgbase/oqx";
import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/details/details.js";
import "@shoelace-style/shoelace/dist/components/split-panel/split-panel.js";
import type SlSplitPanel from "@shoelace-style/shoelace/dist/components/split-panel/split-panel.js";
import "./elements/oqx-query-editor.ts";
import "./elements/oqx-relationship-picker.ts";
import "./elements/oqx-projection-picker.ts";
import "./elements/oqx-graph.ts";
import type { QueryChangeDetail } from "./elements/oqx-query-editor.ts";
import type { ArmedChangeDetail, OqxRelationshipPicker, ViewChangeDetail } from "./elements/oqx-relationship-picker.ts";
import type { FieldHoverDetail, ProjectionChangeDetail } from "./elements/oqx-projection-picker.ts";
import type { AxisRequestDetail, EdgeToggleDetail, GraphNode, GraphStateDetail, PendingEdge } from "./elements/oqx-graph.ts";
import { inferCandidates, type Candidate, type Row } from "./lib/candidates.ts";
import { NO_PROJECTION_OVERRIDES, defaultView, resolveProjection, type ProjectionOverrides, type View } from "./lib/view.ts";
import { projectionOf, type Projection } from "./lib/projection.ts";
import { edgeQueries, edgesFromRows, type GraphEdge } from "./lib/edges.ts";
import { describePatch, editability, projectedFields, type Editability, type EmptyListBehavior, type FrontmatterEffect } from "./lib/edit.ts";
import { PerKeyQueue, applyToggle, describeMutationError, prepareToggle, type TogglePlan } from "./lib/mutations.ts";
import { AuthRequiredError, OmgClient, serverUrlFor, type McpMode, type McpSettings } from "./lib/mcp-client.ts";
import { BrowserOAuthProvider, callbackParams, discover, type Discovery, type Identity } from "./lib/oauth.ts";
import { fetchBridgeInfo, type BridgeInfo } from "./lib/bridge-info.ts";
import { effect } from "./lib/effect.ts";
import { DEFAULT_LABEL_FIT, LABEL_FITS, isLabelFit, type LabelFit } from "./lib/card-size.ts";
import { describeQueryError, type OqxErrorInfo } from "./lib/errors.ts";
import { docLocator, hitId, hitPath, namesFor, rooted, surfaceOf, surfaceProblem, unrooted } from "./lib/paths.ts";
import { DEFAULT_QUERY } from "./lib/default-query.ts";
import { MODE_LABEL, headerLabel, modeForBridge } from "./lib/connection.ts";
import { SAMPLE_PROBE_PATH, chooseQuery, existsQuery, isStarterQuery, starterQuery, timelineStarter, type RepositoryShape } from "./lib/starter-query.ts";
import { emptyStateText, firstWhereText, missingPathLiterals, pathLiterals, type EmptyState } from "./lib/empty-state.ts";

const SETTINGS_KEY = "omgbase-graph-ui.settings";
const QUERY_KEY = "omgbase-graph-ui.query";
const PENDING_KEY = "omgbase-graph-ui.oauth.pending";
const EDIT_KEY = "omgbase-graph-ui.edit";
const UI_KEY = "omgbase-graph-ui.ui";
/** How long the query or the edge fetch may be in flight before the graph area says so. */
const SPINNER_DELAY_MS = 300;

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

/** The side panel's sections, top to bottom. */
export type SectionId = "query" | "relationships" | "projection" | "settings";
export const SECTIONS: readonly SectionId[] = ["query", "relationships", "projection", "settings"];
/** Open by default: everything but the MCP settings (which open themselves on an error or a sign-in). */
const DEFAULT_SECTIONS: Record<SectionId, boolean> = { query: true, relationships: true, projection: true, settings: false };
/** The side panel's share of the width, in percent (the split panel's `position`). */
export const DEFAULT_SPLIT = 40;

/** The page chrome's settings (persisted under UI_KEY). */
export interface UiSettings {
  /** Keep the previous result drawn when a query matches nothing (default: clear it,
   * so an empty result is never mistaken for a stale graph). */
  keepLastGraph: boolean;
  /** How a node card fits its label: one line with an ellipsis (the default), wrapped
   * within the card's width, or the card widened to the label (lib/card-size.ts). */
  labelFit: LabelFit;
  /** Which side-panel sections are open. */
  sections: Record<SectionId, boolean>;
  /** The side panel's width as a percentage of the main area. */
  splitPosition: number;
}

/** Read the persisted UI settings back, filling in defaults for anything missing or malformed. */
export function parseUiSettings(raw: string | null): UiSettings {
  const fallback: UiSettings = { keepLastGraph: false, labelFit: DEFAULT_LABEL_FIT, sections: { ...DEFAULT_SECTIONS }, splitPosition: DEFAULT_SPLIT };
  try {
    const saved = JSON.parse(raw ?? "{}") as { keepLastGraph?: unknown; labelFit?: unknown; sections?: Record<string, unknown>; splitPosition?: unknown };
    const sections = { ...DEFAULT_SECTIONS };
    for (const id of SECTIONS) if (typeof saved.sections?.[id] === "boolean") sections[id] = saved.sections[id];
    const pos = typeof saved.splitPosition === "number" && Number.isFinite(saved.splitPosition) ? Math.min(90, Math.max(10, saved.splitPosition)) : DEFAULT_SPLIT;
    return { keepLastGraph: saved.keepLastGraph === true, labelFit: isLabelFit(saved.labelFit) ? saved.labelFit : DEFAULT_LABEL_FIT, sections, splitPosition: pos };
  } catch {
    return fallback;
  }
}

function loadUiSettings(): UiSettings {
  return parseUiSettings(localStorage.getItem(UI_KEY));
}

/** The stored query, or the sample default (lib/default-query.ts, in the
 * native 5.0 spelling) — the repository is not known before connecting; once
 * it is, `chooseQuery` (lib/starter-query.ts) swaps a preset for the sample
 * default or the starter in the server's spelling, never a user's edit. */
function loadQuery(): string {
  return localStorage.getItem(QUERY_KEY) ?? DEFAULT_QUERY;
}

/** The bridge sits behind Vite's proxy at the same origin; `pnpm dev` starts both. */
const DEFAULT_SETTINGS: McpSettings = { mode: "local", bridgeUrl: "/mcp", directUrl: "", repo: "" };

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
    // `?repo=<slug>` in the page URL names the repository for this visit (a
    // hosted deployment or a shared link whose server has no `repos` tool);
    // it is kept in the settings like a typed one.
    const fromUrl = typeof location === "undefined" ? null : new URL(location.href).searchParams.get("repo");
    if (fromUrl !== null && fromUrl.trim()) s.repo = fromUrl.trim();
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
const source = signal<string>(loadQuery());
const ast = signal<Query | null>(null);
const parseError = signal<OqxErrorInfo | null>(null);
const rows = signal<Row[]>([]);
const truncated = signal(false);
const queryError = signal<string | null>(null);
/** The repository designation sent as the `repo` argument of every call: the
 * settings' override, else the one the bridge was started for (`/whoami`
 * `repo`, from `--repo`), else "" — the server's default repo. The minimal
 * profile has no `repos` tool, so the page never lists repositories. */
const repoInUse = computed<string>(() => settings.get().repo || bridge.get()?.repo || "");
const connection = signal<"idle" | "connecting" | "ok" | "error" | "sign-in">("idle");
const connectionMessage = signal<string>("");
const identity = signal<Identity | null>(null);
const discovery = signal<Discovery | null>(null);
const bridge = signal<BridgeInfo | null>(null);
const bridgeError = signal<string | null>(null);
/** The connected server's surface version from its `version` tool (`specs.surface`,
 * "major.minor"), shown in the header; null until known — and set only once the
 * server has passed the gate (lib/paths.ts `surfaceProblem`: this demo speaks
 * surface 3.0 and later), so a non-null value also means "connected to a server we understand". */
const serverSurface = signal<string | null>(null);
/** How the connected server spells the engine names (lib/paths.ts `namesFor`):
 * `_path`/`_title`/`_in_links`/`{ _id | _path }` from surface 5.0 ("underscore =
 * engine"), the bare 3.x/4.x names before. Every query, argument and builtin
 * candidate name the page generates goes through it; what it reads takes both. */
const names = computed(() => namesFor(serverSurface.get()));
const candidates = computed<Candidate[]>(() => inferCandidates(ast.get(), rows.get(), names.get()));
/** The relationship picker's resolved view (edges + layout); the projection joins it below. */
const relationshipView = signal<View>(defaultView([]));
/** The projected fields, by reflection over the query (or the rows for an empty projection). */
const projection = computed<Projection>(() => projectionOf(ast.get(), rows.get()));
/** The user's card choices (label radio, show checkboxes); vanished fields are dropped on resolve. */
const projectionOverrides = signal<ProjectionOverrides>(NO_PROJECTION_OVERRIDES);
/** The view record the graph draws: `{ edges, layout, projection }`. */
const view = computed<View>(() => {
  const p = projection.get();
  return { ...relationshipView.get(), projection: resolveProjection(p.fields, p.defaults, projectionOverrides.get()) };
});
// Nodes are keyed by the `/`-rooted path (what the server returns; rooted again
// defensively). The node's `label` is the FALLBACK title line (the de-rooted
// path); the card's actual title comes from the projection's label field
// (lib/cards.ts). The hit's identity is read through `hitId`/`hitPath`
// (lib/paths.ts): the envelope's `_id`/`_path` (a 4.x server's `id`/`path`).
const nodes = computed<GraphNode[]>(() => rows.get().map((row) => {
  const rawPath = hitPath(row);
  const path = rawPath !== null ? rooted(rawPath) : hitId(row) ?? "";
  return { id: hitId(row) ?? path, path, label: unrooted(path).replace(/\.md$/, ""), row };
}));
const graphState = signal<GraphStateDetail | null>(null);
/** The query is in flight (the spinner and the empty state key off it). */
const querying = signal(false);
/** The last run matched nothing: what to tell the user (null while rows are shown or the query failed). */
const emptyResult = signal<EmptyState | null>(null);
/** Set once the query or the edges have been in flight for SPINNER_DELAY_MS. */
const showSpinner = signal(false);
const uiSettings = signal<UiSettings>(loadUiSettings());
/** Which repository the connection is looking at (the sample, or not) — null
 * until probed; decides the preset query (lib/starter-query.ts). */
const repoShape = signal<RepositoryShape | null>(null);

// ---- edge editing -----------------------------------------------------------------

/** The server's tool names (null until listed, or when listing failed — then assume the full set). */
const tools = signal<string[] | null>(null);
const canWrite = computed<boolean>(() => tools.get()?.includes("apply") ?? true);
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
    client = new OmgClient({
      url,
      authProvider: providerFor(url),
      // The proxy forgot our session (idle timeout, or it restarted): the client
      // has already opened a fresh one and retried; just say so in the status line.
      onSessionLost: () => { if (connection.get() === "ok") connectionMessage.set("session expired at the server — reconnected"); },
    });
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
    // The mode follows the bridge: it knows whether it proxies a remote or
    // serves the sample; a persisted label must not contradict it (direct mode
    // is the user's choice and never touched).
    const mode = modeForBridge(settings.get().mode, info);
    if (mode !== settings.get().mode) settings.set({ ...settings.get(), mode });
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
      void connectServer();
    }
  }, 1500);
}

async function connectServer(): Promise<void> {
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
    // The surface version first (one `version` call per connection): this demo
    // speaks surface 3.0 and later (5.0's `_`-prefixed engine names, the bare
    // ones before — `names`) and says so, loudly, when the server does not —
    // instead of drawing a silently empty graph. A server without the tool is older still.
    const surface = await c.version().then(surfaceOf, () => null);
    const problem = surfaceProblem(surface);
    if (problem) {
      connection.set("error");
      connectionMessage.set(problem);
      return;
    }
    serverSurface.set(surface);
    // Which tools the server (or the gateway in front of it) offers decides whether edges can be edited (`apply`).
    c.tools().then((names) => tools.set(names), () => tools.set(null));
    if (s.mode === "direct") identity.set(providerFor(url).identity());
    else { const info = await refreshBridge(); if (info?.identity) identity.set(info.identity); }
    connection.set("ok");
    const repo = repoInUse.get();
    connectionMessage.set(`${repo ? `repo ${repo}` : "default repo"} · surface ${surface}`);
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
  rows.set([]);
  emptyResult.set(null);
  repoShape.set(null);
  tools.set(null);
  serverSurface.set(null);
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

/** Does `path` exist in the current repository? null when the probe failed. */
async function docExists(path: string): Promise<boolean | null> {
  try {
    const r = await clientFor(serverUrl.get()).query(existsQuery(path, names.get()), { repo: repoInUse.get(), limit: 1 });
    return r.hits.length > 0;
  } catch {
    return null;
  }
}

let probeGeneration = 0;
/** Which repository this is: the sample (its timeline start document present
 * — one `limit 1` query) or another one. The slug is only a designation: with
 * no `repos` tool (the minimal profile) the probe document is what decides. */
async function detectRepository(repo: string): Promise<void> {
  const gen = ++probeGeneration;
  const hasProbeDoc = await docExists(SAMPLE_PROBE_PATH);
  if (gen !== probeGeneration) return;
  repoShape.set({ slug: repo, hasProbeDoc });
}

let runGeneration = 0;
async function runQuery(): Promise<void> {
  const q = ast.get();
  const url = serverUrl.get();
  const text = source.get();
  if (!q || !url || serverSurface.get() === null) return;
  const gen = ++runGeneration;
  queryError.set(null);
  querying.set(true);
  let empty: EmptyState | null = null;
  try {
    const result = await clientFor(url).query(text, { repo: repoInUse.get(), limit: 200 });
    if (gen !== runGeneration) return;
    truncated.set(result.truncated);
    // An empty result clears the graph (an empty result must not look like a
    // stale one) unless the user asked to keep the last graph.
    if (result.hits.length > 0 || !uiSettings.get().keepLastGraph) rows.set(result.hits);
    empty = result.hits.length === 0 ? { where: firstWhereText(text, q), missing: [] } : null;
    emptyResult.set(empty);
  } catch (e) {
    if (gen !== runGeneration || e instanceof AuthRequiredError) return;
    queryError.set(describeError(e));
    emptyResult.set(null);
  } finally {
    if (gen === runGeneration) querying.set(false);
  }
  if (!empty) return;
  // Then say WHY, when the query names a document: probe its `_path == "…"` literals.
  const missing = await missingPathLiterals(pathLiterals(q), docExists);
  if (gen === runGeneration && missing.length > 0) emptyResult.set({ ...empty, missing });
}

/** The graph's edge source: generated OQX over the link rows (`links { … }`) via the `query` tool. */
async function fetchEdges(candidate: Candidate, paths: string[]): Promise<GraphEdge[]> {
  const url = serverUrl.get();
  const all: Record<string, unknown>[] = [];
  for (const q of edgeQueries(candidate, paths, names.get())) all.push(...(await clientFor(url).queryAll(q, { repo: repoInUse.get() })));
  return edgesFromRows(candidate, all, new Set(paths));
}

/** The edit tools with the document argument spelled for the server (`{ _id }`
 * or `{ _path }` — `{ id }`/`{ path }` on 4.x; lib/paths.ts `docLocator`); the
 * plans and the graph speak rooted paths. A write is one `apply` whose effects
 * target the owner document (`{ kind: "document", … }`). */
function metaClientFor(url: string) {
  const c = clientFor(url);
  return {
    docsRead: (doc: string, repo?: string) => c.docsRead(docLocator(doc, names.get()), repo),
    applyFrontmatter: (doc: string, effects: FrontmatterEffect[], repo?: string) =>
      c.apply(effects.map((e) => ({ ...e, target: { kind: "document", ...docLocator(doc, names.get()) } })), { ...(repo ? { repo } : {}), reason: "graph-ui edge toggle" }),
  };
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
  editBusy.set(true);
  try {
    const plan = await prepareToggle(metaClientFor(serverUrl.get()), {
      owner: { id: owner.id, path: owner.path },
      target: { id: target.id, path: target.path },
      field: candidate.name,
      present,
      form: ed.form,
      options: { shape: ed.shape, emptyListBehavior: editSettings.get().emptyListBehavior },
      row: owner.row,
      projected: projectedFields(ast.get()).includes(candidate.name),
      ...(repoInUse.get() ? { repo: repoInUse.get() } : {}),
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
    await applyToggle(metaClientFor(serverUrl.get()), mutations, plan, repoInUse.get() || undefined);
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
  effect(() => { localStorage.setItem(UI_KEY, JSON.stringify(uiSettings.get())); });
  let last = "";
  effect(() => {
    // `local` and `proxy` are the same bridge (the bridge decides which it is),
    // so flipping between them is not a new connection.
    const key = `${settings.get().mode === "direct" ? "direct" : "bridge"} ${serverUrl.get()}`;
    if (key === last) return;
    last = key;
    discovery.set(null);
    serverSurface.set(null); // unknown until the new server answers `version`
    void connectServer();
  });
  // Which repository: re-probed whenever the repo designation or the connection changes.
  effect(() => {
    const repo = repoInUse.get();
    const surface = serverSurface.get();
    repoShape.set(null);
    if (surface === null) return;
    void detectRepository(repo);
  });
  // The preset query follows the repository AND the server's spelling: the
  // sample default for the sample workspace, the starter elsewhere, each in
  // the connected server's engine names — only while the editor holds a preset
  // (the default or the starter, in either spelling), never a user's edit. It
  // runs when the connection or the repository changes, not on edits (`source`
  // is read untracked): a sample query PASTED into the editor later stays, and
  // the empty state says why it matches nothing.
  effect(() => {
    const repo = repoShape.get();
    if (serverSurface.get() === null || repo === null) return;
    const want = chooseQuery(Signal.subtle.untrack(() => source.get()), repo, names.get());
    if (want !== null) source.set(want);
  });
  // Loading feedback: the spinner appears once the query or the edge fetch has
  // been in flight for SPINNER_DELAY_MS, and goes the moment both settle.
  let spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  effect(() => {
    const busy = querying.get() || (graphState.get()?.busy ?? false);
    if (spinnerTimer) { clearTimeout(spinnerTimer); spinnerTimer = null; }
    if (busy) spinnerTimer = setTimeout(() => showSpinner.set(true), SPINNER_DELAY_MS);
    else showSpinner.set(false);
  });
  effect(() => {
    const q = ast.get();
    repoInUse.get(); // a changed designation re-runs the query
    if (!q || serverSurface.get() === null) return;
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
    header input.repo { font: inherit; width: 11em; margin-left: 4px; }
    header .conn { font-size: 12px; color: #5a6270; }
    header .conn.error { color: #c62828; }
    header .conn.sign-in { color: #b26a00; }
    main { display: grid; min-height: 0; padding: 8px 14px 12px; }
    /* The split: the side panel (start) and the graph (end); both keep a readable minimum. */
    sl-split-panel { height: 100%; min-height: 0; --min: 360px; --max: calc(100% - 360px); --divider-width: 4px; --divider-hit-area: 16px; }
    sl-split-panel::part(divider) { background: #e3e6ec; border-radius: 2px; }
    sl-split-panel::part(divider):hover, sl-split-panel::part(divider):focus-visible { background: #1565c0; }
    sl-split-panel::part(panel) { min-width: 0; min-height: 0; }
    /* The side panel scrolls as a whole; every block in it keeps its own height
       (a flex child with overflow would otherwise be free to shrink to nothing). */
    .left { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; overflow: auto; padding-right: 10px; box-sizing: border-box; }
    .left > * { flex: none; }
    sl-details { --sl-spacing-medium: 10px; }
    sl-details::part(base) { border: 1px solid #e3e6ec; border-radius: 6px; background: #fff; }
    sl-details::part(header) { padding: 7px 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #5a6270; font-weight: 600; }
    sl-details::part(summary-icon) { color: #8a94a6; }
    sl-details::part(content) { padding: 0 10px 10px; }
    sl-details .sub { font-size: 12px; color: #5a6270; text-transform: none; letter-spacing: 0; font-weight: normal; margin-left: 8px; }
    /* The cards panel's label-fit control, under the field list. */
    .fit { display: flex; gap: 6px; align-items: center; margin-top: 8px; font-size: 12px; color: #5a6270; }
    .fit select { font: inherit; padding: 2px 4px; }
    .graph-area { position: relative; height: 100%; min-height: 0; display: grid; padding-left: 10px; box-sizing: border-box; }
    oqx-graph { height: 100%; min-height: 0; }
    .try { font-size: 12px; color: #5a6270; margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .try pre { margin: 0; white-space: pre-wrap; font: 11px ui-monospace, monospace; background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 4px; padding: 6px 8px; }
    .try button { font: inherit; align-self: flex-start; }
    .empty-state { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: min(560px, 90%); display: flex; flex-direction: column; gap: 8px; padding: 14px 18px; border-radius: 8px; background: #fff; border: 1px solid #d0d4dc; box-shadow: 0 4px 18px rgba(30, 36, 48, 0.08); color: #1e2430; font-size: 13px; }
    .empty-state.banner { top: 8px; transform: translate(-50%, 0); max-width: min(720px, 94%); background: #fff8e1; border-color: #ffe082; color: #6d4c00; }
    .empty-state b { font-size: 14px; }
    .empty-state code.where { display: block; font: 12px ui-monospace, monospace; background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 4px; padding: 4px 8px; white-space: pre-wrap; word-break: break-all; color: #1e2430; }
    .empty-state .missing { color: #c62828; }
    .empty-state .missing code { font-family: ui-monospace, monospace; }
    .empty-state .note { color: #5a6270; font-size: 12px; }
    .empty-state .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 12px; color: #5a6270; }
    .empty-state .actions button { font: inherit; }
    .empty-state .actions label { display: inline-flex; gap: 4px; align-items: center; }
    .loading { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); display: inline-flex; gap: 8px; align-items: center; padding: 5px 12px; border-radius: 16px; background: rgba(255,255,255,0.95); border: 1px solid #d0d4dc; color: #1e2430; font-size: 12px; box-shadow: 0 2px 10px rgba(30, 36, 48, 0.08); }
    .loading .spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #c5cbd6; border-top-color: #1565c0; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .loading .spinner { animation: none; border-top-color: #c5cbd6; } }
    footer .empty { color: #b26a00; }
    footer { padding: 6px 14px; border-top: 1px solid #e3e6ec; font-size: 12px; color: #5a6270; display: flex; gap: 14px; flex-wrap: wrap; }
    footer .err { color: #c62828; }
    footer .err code { font-family: ui-monospace, monospace; color: #1e2430; background: #f7f8fa; padding: 0 3px; border-radius: 3px; }
    .settings form { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; padding: 8px 0; }
    .settings input[type="text"], .settings select, .settings button { font: inherit; padding: 3px 6px; }
    .settings .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .settings .modes { display: flex; gap: 12px; flex-wrap: wrap; }
    .settings .modes label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
    .settings .auth, .settings .hint { grid-column: 1 / -1; color: #5a6270; font-size: 12px; }
    .settings .hint.warn { color: #b26a00; }
    .settings code { font-family: ui-monospace, monospace; }
    /* The selected row as JSON: at least one line tall, growing with the content, scrolling only past 40vh. */
    .selection { font-size: 12px; line-height: 1.4; background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 6px; padding: 8px 10px; }
    .selection pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; font: 11px/1.5 ui-monospace, monospace; min-height: calc(11px * 1.5 + 2px); max-height: 40vh; overflow: auto; }
    .try pre { line-height: 1.5; min-height: calc(11px * 1.5 + 12px); max-height: 40vh; overflow: auto; }
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
  @query("oqx-relationship-picker") private picker!: OqxRelationshipPicker | null;

  /** A section's open state, persisted. */
  private setSection(id: SectionId, open: boolean): void {
    const ui = uiSettings.get();
    if (ui.sections[id] === open) return;
    uiSettings.set({ ...ui, sections: { ...ui.sections, [id]: open } });
  }

  /** `<sl-details>` fires `sl-show` / `sl-hide` on the element itself; nested
   * Shoelace elements would bubble theirs too, so only the section's own count. */
  private onSectionToggle(id: SectionId, open: boolean) {
    return (e: Event) => {
      if (e.target !== e.currentTarget) return;
      this.setSection(id, open);
    };
  }

  private onSplitReposition(e: Event): void {
    const panel = e.currentTarget as SlSplitPanel;
    const ui = uiSettings.get();
    const pos = Math.round(panel.position * 10) / 10;
    if (Number.isFinite(pos) && pos !== ui.splitPosition) uiSettings.set({ ...ui, splitPosition: pos });
  }

  /** The graph's empty-axis banner asked for another axis: the picker owns the overrides. */
  private onAxisRequest(e: CustomEvent<AxisRequestDetail>): void {
    this.picker?.setAxis(e.detail.axis);
  }

  private onQueryChange(e: CustomEvent<QueryChangeDetail>): void {
    source.set(e.detail.source);
    parseError.set(e.detail.error);
    if (e.detail.query) ast.set(e.detail.query);
  }

  private onViewChange(e: CustomEvent<ViewChangeDetail>): void {
    relationshipView.set(e.detail.view);
  }

  private onProjectionChange(e: CustomEvent<ProjectionChangeDetail>): void {
    projectionOverrides.set(e.detail.overrides);
  }

  private setMode(mode: McpMode): void {
    this.urlDraft = null;
    const s = settings.get();
    if (mode === s.mode) return;
    settings.set({ ...s, mode }); // to or from direct: the URL effect reconnects
    // local ↔ proxy is the same bridge: ask it again who it is — the mode
    // follows its answer, so picking the wrong one of the two snaps back.
    if (mode !== "direct" && s.mode !== "direct") void connectServer();
  }

  private connect(): void {
    const s = settings.get();
    const current = s.mode === "direct" ? s.directUrl : s.bridgeUrl;
    const url = (this.urlDraft ?? current).trim();
    this.urlDraft = null;
    if (url !== current) settings.set(s.mode === "direct" ? { ...s, directUrl: url } : { ...s, bridgeUrl: url }); // the URL effect reconnects
    else void connectServer();
  }

  private renderBridgeHint(info: BridgeInfo | null, mode: McpMode) {
    const err = bridgeError.get();
    if (!info) {
      return html`<div class="hint warn">no bridge answered <code>/whoami</code>${err ? ` (${err})` : ""} — start it with
        <code>pnpm --filter graph-ui dev${mode === "proxy" ? " --remote &lt;mcp-url&gt;" : ""}</code></div>`;
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

  /** Under the editor while it holds the starter: the timeline suggestion,
   * rooted at the first shown document (or a placeholder). */
  private renderStarterHint() {
    if (!isStarterQuery(source.get())) return nothing;
    const first = rows.get().map(hitPath).find((p) => p !== null) ?? null;
    const suggestion = timelineStarter(first, names.get());
    return html`<div class="try" data-starter-hint>
      <span>for a timeline, start from one document and walk its <code>before</code> / <code>after</code> frontmatter:</span>
      <pre>${suggestion}</pre>
      <button type="button" @click=${() => source.set(suggestion)}>use this query</button>
    </div>`;
  }

  /** The graph area's empty state: a query ran and matched nothing — say so,
   * quote its first `where`, name the path literals that are not in the
   * repository, and offer the starter. */
  private renderEmptyState() {
    const es = emptyResult.get();
    if (!es || querying.get()) return nothing;
    const s = settings.get();
    const t = emptyStateText(es, s.repo);
    const ui = uiSettings.get();
    const stale = ui.keepLastGraph && rows.get().length > 0;
    return html`<div class="empty-state ${stale ? "banner" : ""}" role="status" data-empty-state>
      <b>${t.title}</b>
      ${es.where
        ? html`<code class="where">${es.where}</code>`
        : html`<span>the query has no <code>where</code> clause — the repository seems to hold no documents</span>`}
      ${t.details.map((d) => html`<div class="missing" data-missing>${d}</div>`)}
      ${stale ? html`<div class="note">the graph below is the previous result</div>` : nothing}
      <div class="actions">
        ${isStarterQuery(source.get()) ? nothing : html`<button type="button" data-action="starter" @click=${() => source.set(starterQuery(names.get()))}>show recent documents</button>`}
        <label><input type="checkbox" .checked=${ui.keepLastGraph} @change=${(e: Event) => uiSettings.set({ ...ui, keepLastGraph: (e.target as HTMLInputElement).checked })}> keep the last graph when a query matches nothing</label>
      </div>
    </div>`;
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
        <span>write <code>${describePatch(p.owner, p.field, p.patch, p.previous)}</code> via <code>apply</code>${p.revision ? html` (expecting revision <code>${p.revision}</code>)` : ""}?</span>
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
    const proj = projection.get();
    const gs = graphState.get();
    const r = rows.get();
    const pe = parseError.get();
    const qeRaw = queryError.get();
    const qe = qeRaw === null ? null : describeQueryError(qeRaw, ast.get());
    const who = identity.get();
    const disc = discovery.get();
    const info = bridge.get();
    const es = emptyResult.get();
    const ui = uiSettings.get();
    const shownUrl = s.mode === "direct" ? s.directUrl : s.bridgeUrl;
    const connText = conn === "ok" ? connectionMessage.get() : conn === "error" ? `error: ${connectionMessage.get()}` : conn === "sign-in" ? connectionMessage.get() : conn;
    return html`
      <header>
        <h1>omgbase graph UI</h1>
        <span class="conn ${conn === "error" ? "error" : conn === "sign-in" ? "sign-in" : ""}">${headerLabel(s.mode, info, shownUrl)} · ${connText}${who?.email ? ` · ${who.email}` : ""}</span>
        <span class="spacer"></span>
        <label title="the repository sent as the repo argument of every call; empty = what the bridge was started for (--repo), else the server's default">repo
          <input class="repo" type="text" .value=${s.repo} placeholder=${info?.repo ?? "server default"} spellcheck="false"
            @change=${(e: Event) => settings.set({ ...settings.get(), repo: (e.target as HTMLInputElement).value.trim() })}>
        </label>
      </header>
      <main>
        <sl-split-panel position=${ui.splitPosition} @sl-reposition=${this.onSplitReposition}>
        <div class="left" slot="start">
          <sl-details data-section="query" ?open=${ui.sections.query} @sl-show=${this.onSectionToggle("query", true)} @sl-hide=${this.onSectionToggle("query", false)}>
            <span slot="summary">query<span class="sub">${pe ? "parse error" : qe ? "query error" : `${r.length} row${r.length === 1 ? "" : "s"}`}</span></span>
            <oqx-query-editor .value=${source.get()} .highlights=${this.highlights} @query-change=${this.onQueryChange}></oqx-query-editor>
            ${this.renderStarterHint()}
          </sl-details>
          <sl-details data-section="relationships" ?open=${ui.sections.relationships} @sl-show=${this.onSectionToggle("relationships", true)} @sl-hide=${this.onSectionToggle("relationships", false)}>
            <span slot="summary">relationships<span class="sub">${v.edges.length ? v.edges.join(", ") : "none drawn"} · ${v.layout.axis ? `along ${v.layout.axis}` : "force"}</span></span>
            <oqx-relationship-picker .candidates=${cands} .editable=${editable.get()} .armed=${armed.get()?.name ?? null}
              .edgeCounts=${gs?.edgeCounts ?? {}} .nodeCount=${r.length}
              @view-change=${this.onViewChange}
              @armed-change=${(e: CustomEvent<ArmedChangeDetail>) => { armed.set(e.detail.candidate); proposal.set(null); }}
              @candidate-hover=${(e: CustomEvent<{ candidate: Candidate | null }>) => { this.highlights = e.detail.candidate?.spans ?? []; }}>
            </oqx-relationship-picker>
          </sl-details>
          <sl-details data-section="projection" ?open=${ui.sections.projection} @sl-show=${this.onSectionToggle("projection", true)} @sl-hide=${this.onSectionToggle("projection", false)}>
            <span slot="summary">cards<span class="sub">${v.projection.label ?? "path"}${v.projection.shown.filter((f) => f !== v.projection.label).map((f) => ` + ${f}`).join("")}${ui.labelFit === "truncate" ? "" : ` · ${ui.labelFit}`}</span></span>
            <oqx-projection-picker .fields=${proj.fields} .defaults=${proj.defaults} .overrides=${projectionOverrides.get()}
              @projection-change=${this.onProjectionChange}
              @field-hover=${(e: CustomEvent<FieldHoverDetail>) => { this.highlights = e.detail.field?.span ? [e.detail.field.span] : []; }}>
            </oqx-projection-picker>
            <label class="fit" title="how a card fits its label: one line with an ellipsis; wrapped within the card's width (up to 4 lines); or the card widened to the label, wrapping past the maximum width">label fit
              <select data-label-fit .value=${ui.labelFit} @change=${(e: Event) => { const fit = (e.target as HTMLSelectElement).value; if (isLabelFit(fit)) uiSettings.set({ ...uiSettings.get(), labelFit: fit }); }}>
                ${LABEL_FITS.map((f) => html`<option value=${f} ?selected=${f === ui.labelFit}>${LABEL_FIT_LABEL[f]}</option>`)}
              </select>
            </label>
          </sl-details>
          ${this.renderEdit()}
          ${this.selected ? html`<section class="selection" data-selection>
            <b>${this.selected.path}</b>
            <pre>${JSON.stringify(this.selected.row, null, 1)}</pre>
          </section>` : nothing}
          <sl-details class="settings" data-section="settings" ?open=${ui.sections.settings || conn === "error" || conn === "sign-in"} @sl-show=${this.onSectionToggle("settings", true)} @sl-hide=${this.onSectionToggle("settings", false)}>
            <span slot="summary">MCP settings<span class="sub">${MODE_LABEL[s.mode]}${conn === "error" ? " · error" : conn === "sign-in" ? " · sign-in" : ""}</span></span>
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
          </sl-details>
        </div>
        <div class="graph-area" slot="end">
          <oqx-graph .nodes=${nodes.get()} .view=${v} .candidates=${cands} .fetchEdges=${fetchEdges}
            .armed=${armed.get()} .writable=${writable.get()} .pending=${pending.get()} .labelFit=${ui.labelFit}
            @node-select=${(e: CustomEvent<{ node: GraphNode | null }>) => { this.selected = e.detail.node; proposal.set(null); }}
            @edge-toggle=${(e: CustomEvent<EdgeToggleDetail>) => { void proposeToggle(e.detail); }}
            @axis-request=${this.onAxisRequest}
            @graph-state=${(e: CustomEvent<GraphStateDetail>) => onGraphState(e.detail)}></oqx-graph>
          ${this.renderEmptyState()}
          ${showSpinner.get() ? html`<div class="loading" role="status" data-loading><span class="spinner"></span>${querying.get() ? "running the query…" : "fetching edges and laying out…"}</div>` : nothing}
        </div>
        </sl-split-panel>
      </main>
      <footer>
        <span class=${es ? "empty" : ""}>${r.length} row${r.length === 1 ? "" : "s"}${truncated.get() ? " (truncated at 200)" : ""}${es && !querying.get() ? ` · ${emptyStateText(es, s.repo).footer}` : ""}</span>
        <span>${cands.length} candidate${cands.length === 1 ? "" : "s"}</span>
        <span>edges: ${v.edges.length ? v.edges.join(", ") : "none"}</span>
        <span>layout: ${v.layout.axis ? `${v.layout.axis} (${v.layout.direction}${gs?.axisEdges !== null && gs?.axisEdges !== undefined ? `, ${gs.axisEdges} edge${gs.axisEdges === 1 ? "" : "s"}` : ""})` : "force"}</span>
        <span>cards: ${v.projection.label ?? "path"}${v.projection.shown.filter((f) => f !== v.projection.label).map((f) => ` + ${f}`).join("")}</span>
        ${gs ? html`<span>${gs.busy ? "laying out…" : `${gs.edges} edges drawn${gs.cycles.length ? `, ${gs.cycles.length} cycle(s)` : ""}`}</span>` : nothing}
        ${pe ? html`<span class="err">parse: ${pe.message}</span>` : nothing}
        ${qe ? html`<span class="err" data-query-error>query: ${qe.message}${qe.suggestion ? html` · try <code>${qe.suggestion}</code>` : nothing}</span>` : nothing}
      </footer>
    `;
  }
}

/** The label-fit select's option texts. */
const LABEL_FIT_LABEL: Record<LabelFit, string> = {
  truncate: "truncate — one line",
  wrap: "wrap — up to 4 lines",
  expand: "expand — widen, then wrap",
};

const MODE_TITLE: Record<McpMode, string> = {
  local: "the local bridge serving ./sample over `omg mcp` (pnpm dev)",
  proxy: "the local bridge signed in to a remote omg MCP on your behalf (pnpm dev --remote <url>); no CORS or Auth0 setup needed",
  direct: "the browser connects to the remote itself and is the OAuth client; needs CORS on the gateway and web origins in Auth0",
};

declare global {
  interface HTMLElementTagNameMap { "graph-ui-app": GraphUiApp }
}
