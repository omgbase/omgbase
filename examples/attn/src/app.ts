// The page: one element composing the focus bar, the intent feed and the
// stream, over module-level signals.
//
//   connect → (whoami) → version (surface ≥ 5.0, the profile) + tools/list →
//   [repos, when listed] → load: the pointer (docs_read), the intents with their
//   cues and the virtual #focus (one query), the pointer's history (one query
//   over revisions + docs_read { at } per revision not yet cached) → the cue
//   engine → changes_since polled: anything under /attn/ reloads and re-evaluates.
//   Writes: ONE apply per switch / interrupt / back / stop / add / add + focus /
//   release / reactivate / edit / cue removal (lib/writes.ts); a new cue is
//   plan { diffs: true } → execute over the intent's whole `cues` list.
//
// Everything runs on the MINIMAL tools profile (lib/tools.ts); `repos` is the one
// optional tool (a picker when listed). The data path is MCP only
// (lib/mcp-client.ts) through the dev proxy at the same-origin /mcp.

import { LitElement, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { WhoAmI } from "webdevproxy";
import "./elements/focus-bar.ts";
import "./elements/intent-feed.ts";
import "./elements/stream-view.ts";
import type { BarMessage, DeclareDetail, ResumeDetail } from "./elements/focus-bar.ts";
import type { CuePlanDetail, CueProblem, CueRemoveDetail, EditingIntent, IntentEditSaveDetail, IntentPathDetail, IntentStatusDetail, PanelMessage } from "./elements/intent-feed.ts";
import type { StreamDayDetail } from "./elements/stream-view.ts";
import { OmgClient, OmgError, fetchWhoAmI, repoArg, type Wire } from "./lib/mcp-client.ts";
import { profileOf, surfaceOf, surfaceProblem } from "./lib/paths.ts";
import { capabilities, missingToolsText, profileLabel, type Capabilities } from "./lib/tools.ts";
import { POINTER_PATH, dayOf, intentPath, nowIso, parseDeclaration, str } from "./lib/model.ts";
import { NO_FOCUS, episodeKey, fetchPointer, type FocusState } from "./lib/pointer.ts";
import { activeCues, feedOf, fetchIntents, findByTitle, setContentEffect, setStatusEffect, type Intent } from "./lib/intents.ts";
import { Delivery, cuedByIntent, dueTimeCues, evaluateFocusCues, firingScope, queryTransitionDelta, setCuesEffect, whyNow, type Cue, type FiredCue } from "./lib/cues.ts";
import { daysOf, episodesOf, episodesOn, fetchPointerHistory, lastFocused, transitionsOf, type HistoryCache, type PointerSnapshot } from "./lib/history.ts";
import { advanceCursor, fetchChanges, pollMs, startCursor, touchesAttn } from "./lib/feed.ts";
import { applyEffects, backEffects, declareAndFocusEffects, declareEffects, executePlan, interruptEffects, planEffects, stopEffects, switchEffects, type Effect, type Plan, type SwitchContext } from "./lib/writes.ts";
import { effect } from "./lib/effect.ts";

const MCP_URL = "/mcp";
const REPO_KEY = "omgbase-attn.repo";
const POLL_KEY = "omgbase-attn.poll";
const TIME_CUE_TICK_MS = 30_000;

// ---- state --------------------------------------------------------------------------

const connection = signal<"idle" | "connecting" | "sign-in" | "ok" | "error">("idle");
const connectionMessage = signal("");
const whoami = signal<WhoAmI | null>(null);
const surface = signal<string | null>(null);
const profile = signal<string | null>(null);
const tools = signal<string[] | null>(null);
const caps = computed<Capabilities>(() => capabilities(tools.get()));
const repos = signal<string[]>([]);
const repo = signal<string>(localStorage.getItem(REPO_KEY) ?? "");
const repoArgValue = computed<string | null>(() => repo.get() || null);

const pointer = signal<FocusState>(NO_FOCUS);
const intents = signal<Intent[]>([]);
const history = signal<PointerSnapshot[]>([]);
const historyCache: HistoryCache = new Map();
const streamDay = signal<string>(dayOf(nowIso()));
const streamLoading = signal(false);
const streamError = signal<string | null>(null);
const clock = signal<string>(nowIso());

const fired = signal<FiredCue[]>([]);
const cueProblems = signal<CueProblem[]>([]);
const delivery = new Delivery(localStorage);

const busy = signal(false);
const barMessage = signal<BarMessage | null>(null);
const panelMessage = signal<PanelMessage | null>(null);
const pendingCue = signal<Plan | null>(null);
const editing = signal<EditingIntent | null>(null);

const feedCursor = signal<number | null>(null);
const feedError = signal<string | null>(null);
const pollSeconds = signal<number>(pollMs(localStorage.getItem(POLL_KEY)) / 1000);
const lastChange = signal<string | null>(null);

const intentsByPath = computed<Map<string, Intent>>(() => new Map(intents.get().map((i) => [i.path, i])));
const titles = computed<Map<string, string>>(() => new Map(intents.get().map((i) => [i.path, i.title])));
const focusedIntent = computed<Intent | null>(() => { const f = pointer.get().focused; return f ? intentsByPath.get().get(f) ?? null : null; });
const transitions = computed(() => transitionsOf(history.get()));
const recent = computed<Map<string, string>>(() => lastFocused(transitions.get()));
const allEpisodes = computed(() => episodesOf(transitions.get(), clock.get()));
const episodes = computed(() => episodesOn(allEpisodes.get(), streamDay.get()));
const streamDays = computed(() => daysOf(transitions.get(), clock.get()));
const feed = computed(() => feedOf(intents.get(), pointer.get().focused, cuedByIntent(fired.get())));

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

function fixOf(e: unknown): string | null {
  const data = e instanceof OmgError ? (e.data as Record<string, unknown> | undefined) : undefined;
  return typeof data?.fix === "string" ? data.fix : null;
}

// ---- loading -------------------------------------------------------------------------------

let loadGeneration = 0;

async function loadAll(): Promise<void> {
  const gen = ++loadGeneration;
  const r = repoArgValue.get();
  try {
    const [p, is] = await Promise.all([fetchPointer(client, r), fetchIntents(client, r), loadHistory(gen)]);
    if (gen !== loadGeneration) return;
    pointer.set(p);
    intents.set(is);
  } catch (e) {
    if (gen === loadGeneration) connectionMessage.set(`load failed: ${describe(e)}`);
  }
}

/** The pointer's revisions → every state (cached by rev; only new revisions are read). */
async function loadHistory(gen = loadGeneration): Promise<void> {
  streamLoading.set(true);
  streamError.set(null);
  try {
    const states = await fetchPointerHistory(client, repoArgValue.get(), historyCache);
    if (gen === loadGeneration) history.set(states);
  } catch (e) {
    if (gen === loadGeneration) streamError.set(describe(e));
  } finally {
    if (gen === loadGeneration) streamLoading.set(false);
  }
}

function pickDay(day: string): void {
  streamDay.set(day);
}

// ---- the cue engine ------------------------------------------------------------------------

let lastEpisode: string | null | undefined;

function offer(cue: Cue, scope: string, reason: string): void {
  const episode = episodeKey(pointer.get());
  if (!delivery.shouldOffer(cue, scope, episode)) return;
  if (fired.get().some((f) => f.cue.intent === cue.intent && f.cue.id === cue.id && f.scope === scope)) return;
  const now = nowIso();
  delivery.markFired(cue, scope, now);
  fired.set([...fired.get(), { cue, scope, reason, firedAt: now }]);
}

function setProblem(cue: Cue, error: CueProblem["error"] | null): void {
  const rest = cueProblems.get().filter((p) => !(p.cue.intent === cue.intent && p.cue.id === cue.id));
  cueProblems.set(error ? [...rest, { cue, error }] : rest);
}

/** On a focus change: every `on: focus` cue of the active intents against the newly focused intent (one query each, membership). */
async function evaluateFocus(): Promise<void> {
  const p = pointer.get();
  const episode = episodeKey(p);
  if (episode === lastEpisode) return;
  lastEpisode = episode;
  // Focus cues offered for an earlier episode are no longer relevant; time and query cues stay.
  fired.set(fired.get().filter((f) => !f.scope.startsWith("episode:")));
  cueProblems.set(cueProblems.get().filter((pr) => pr.cue.on !== "focus"));
  if (!p.focused) return;
  const focused = { path: p.focused, id: intentsByPath.get().get(p.focused)?.id ?? null };
  const results = await evaluateFocusCues(client, activeCues(intents.get()), focused, repoArgValue.get());
  if (episodeKey(pointer.get()) !== episode) return;
  for (const r of results) {
    setProblem(r.cue, r.error);
    if (!r.error && r.matched) offer(r.cue, firingScope(r.cue, episode), whyNow(r.cue));
  }
}

/** The `on: time` cues whose `at` has passed (the client clock). */
function evaluateTime(): void {
  const now = nowIso();
  clock.set(now);
  for (const cue of dueTimeCues(activeCues(intents.get()), now)) offer(cue, firingScope(cue, null), whyNow(cue));
}

/** The `query-enter` / `query-exit` cues: run each query, diff the ids against the browser-side checkpoint. */
async function evaluateQueries(): Promise<void> {
  for (const cue of activeCues(intents.get())) {
    if (cue.on !== "query-enter" && cue.on !== "query-exit") continue;
    const d = await queryTransitionDelta(client, cue, delivery.checkpoint(cue), repoArgValue.get());
    setProblem(cue, d.error);
    if (d.error) continue;
    delivery.setCheckpoint(cue, d.ids);
    for (const h of d.fires) offer(cue, firingScope(cue, null, h.id), whyNow(cue, h.path ?? h.id));
  }
}

async function runCueEngine(): Promise<void> {
  evaluateTime();
  await Promise.all([evaluateFocus(), evaluateQueries()]);
}

/** Snooze every firing of an intent until the next focus boundary (app-local). */
function snoozeIntent(path: string): void {
  const episode = episodeKey(pointer.get());
  for (const f of fired.get()) if (f.cue.intent === path) delivery.snooze(f.cue, episode);
  fired.set(fired.get().filter((f) => f.cue.intent !== path));
}

// ---- writes ---------------------------------------------------------------------------------

function switchContext(): SwitchContext {
  return { pointer: pointer.get(), now: nowIso() };
}

/** One `apply`; `stale_plan` shows the fix and reloads the pointer rather than taking it. */
async function write(build: (ctx: SwitchContext) => Effect[] | null, reason: string, target: "bar" | "panel" = "bar"): Promise<boolean> {
  if (busy.get()) return false;
  const say = (m: BarMessage | null) => (target === "bar" ? barMessage : panelMessage).set(m);
  busy.set(true);
  say(null);
  try {
    const effects = build(switchContext());
    if (!effects) return false;
    const receipt = await applyEffects(client, effects, repoArgValue.get(), reason);
    say({ kind: "info", text: receipt.commit ? receipt.summary.join(" · ") : "nothing to commit" });
    await loadAll();
    void runCueEngine();
    return true;
  } catch (e) {
    const code = e instanceof OmgError ? e.code : "error";
    const stale = code === "stale_plan" || code === "stale_expectation";
    say({ kind: "error", text: `${reason}: ${code} — ${describe(e)}${stale ? " (the pointer moved under us — reloaded; try again)" : ""}`, fix: fixOf(e) });
    if (stale) await loadAll();
    return false;
  } finally {
    busy.set(false);
  }
}

function doResume(path: string, interrupt: boolean): void {
  void write((ctx) => (interrupt ? interruptEffects(ctx, path) : switchEffects(ctx, path)), interrupt ? "attn interrupt" : "attn switch");
}

/** Add Intent: Enter adds (the feed's top), ⌘/⌃Enter adds and focuses, Shift+Enter adds and interrupts. */
function doDeclare(text: string, focus: boolean, interrupt: boolean): void {
  const d = parseDeclaration(text);
  if (!d.title) return;
  const existing = findByTitle(intents.get().filter((i) => i.status === "active"), d.title);
  if (existing) {
    if (focus) doResume(existing.path, interrupt);
    else barMessage.set({ kind: "info", text: `"${existing.title}" is already an active intent` });
    return;
  }
  const now = nowIso();
  const path = intentPath(d.title, now, intents.get().map((i) => i.path));
  const intent = { path, title: d.title, tags: d.tags };
  if (!focus) { void write(() => declareEffects(intent), "attn add intent"); return; }
  void write((ctx) => declareAndFocusEffects({ ...ctx, now }, intent, interrupt ? "interrupt" : "switch"), interrupt ? "attn add + interrupt" : "attn add + focus");
}

function doBack(): void {
  void write((ctx) => backEffects(ctx), "attn back");
}

function doStop(): void {
  void write((ctx) => stopEffects(ctx), "attn stop");
}

function doStatus(path: string, status: "active" | "released"): void {
  void write(() => [setStatusEffect(path, status)], `attn ${status === "released" ? "release" : "reactivate"}`, "panel");
}

function doRemoveCue(path: string, id: string): void {
  const intent = intentsByPath.get().get(path);
  if (!intent) return;
  void write(() => [setCuesEffect(path, intent.cues.filter((c) => c.id !== id))], "attn remove cue", "panel");
}

async function openEditor(path: string): Promise<void> {
  panelMessage.set(null);
  try {
    const doc = await client.call<Wire>("docs_read", { _path: path, ...repoArg(repoArgValue.get()) });
    editing.set({ path, raw: str(doc._raw) });
  } catch (e) {
    panelMessage.set({ kind: "error", text: `docs_read: ${describe(e)}` });
  }
}

function doSaveEdit(path: string, content: string): void {
  void write(() => [setContentEffect(path, content)], "attn edit intent", "panel").then((ok) => { if (ok) editing.set(null); });
}

async function planCue(detail: CuePlanDetail): Promise<void> {
  busy.set(true);
  panelMessage.set(null);
  pendingCue.set(null);
  try {
    pendingCue.set(await planEffects(client, [setCuesEffect(detail.path, detail.cues)], repoArgValue.get()));
  } catch (e) {
    panelMessage.set({ kind: "error", text: `plan: ${e instanceof OmgError ? e.code : "error"} — ${describe(e)}`, fix: fixOf(e) });
  } finally {
    busy.set(false);
  }
}

async function executeCue(): Promise<void> {
  const plan = pendingCue.get();
  if (!plan) return;
  busy.set(true);
  try {
    const receipt = await executePlan(client, plan, repoArgValue.get(), "attn define cue");
    pendingCue.set(null);
    panelMessage.set({ kind: "info", text: receipt.commit ? `committed ${receipt.commit}: ${receipt.summary.join("; ")}` : "nothing to commit" });
    await loadAll();
    void runCueEngine();
  } catch (e) {
    panelMessage.set({ kind: "error", text: `execute: ${e instanceof OmgError ? e.code : "error"} — ${describe(e)}`, fix: fixOf(e) });
    if (e instanceof OmgError && (e.code === "stale_plan" || e.code === "plan_mismatch")) pendingCue.set(null);
  } finally {
    busy.set(false);
  }
}

// ---- live -------------------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let feedGeneration = 0;
let polling = false;

function schedulePoll(delayMs = pollSeconds.get() * 1000): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, delayMs);
}

async function poll(): Promise<void> {
  if (polling || connection.get() !== "ok") return;
  const gen = feedGeneration;
  polling = true;
  try {
    const c = feedCursor.get();
    const page = await fetchChanges(client, repoArgValue.get(), c);
    if (gen !== feedGeneration) return;
    const next = advanceCursor(page);
    feedCursor.set(next.cursor);
    feedError.set(next.reset ? `the cursor (${c}) was beyond this repo's head (${page.head}) — restarted from the head` : null);
    if (page.digests.length) {
      lastChange.set(page.digests[page.digests.length - 1]!.summary);
      if (touchesAttn(page.digests)) {
        await loadAll();
        void runCueEngine();
      }
    }
    if (page.truncated) { polling = false; void poll(); return; }
  } catch (e) {
    if (gen === feedGeneration) feedError.set(`changes_since: ${describe(e)}`);
  } finally {
    polling = false;
  }
  if (gen === feedGeneration) schedulePoll();
}

async function startFeed(): Promise<void> {
  feedGeneration++;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  feedCursor.set(null);
  feedError.set(null);
  try {
    const head = await fetchChanges(client, repoArgValue.get(), null, 1);
    feedCursor.set(startCursor(head));
    schedulePoll();
  } catch (e) {
    feedError.set(`changes_since: ${describe(e)}`);
  }
}

setInterval(() => { if (connection.get() === "ok") evaluateTime(); }, TIME_CUE_TICK_MS);
setInterval(() => { clock.set(nowIso()); }, 1000);

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
      repos.set([]);
      repo.set("");
    }
    localStorage.setItem(REPO_KEY, repo.get());
    connection.set("ok");
    connectionMessage.set(`surface ${v} · ${profileLabel(profile.get(), c)}${w.auth.recovered ? " · signed in again" : ""}`);
    await refreshWhoAmI();
    lastEpisode = undefined;
    await Promise.all([loadAll(), startFeed()]);
    void runCueEngine();
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
  fired.set([]);
  historyCache.clear();
  lastEpisode = undefined;
  void Promise.all([loadAll(), startFeed()]).then(() => runCueEngine());
}

effect(() => { localStorage.setItem(POLL_KEY, String(pollSeconds.get())); });

// ---- the element ----------------------------------------------------------------------------

@customElement("attn-app")
export class AttnApp extends SignalWatcher(LitElement) {
  static override styles = css`
    :host { display: grid; grid-template-rows: auto auto auto 1fr; min-height: 100vh; font: 14px/1.45 system-ui, sans-serif; color: #1e2430; background: #fbfbf9; }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 6px 18px; border-bottom: 1px solid #e3e6ec; background: #fff; font-size: 12.5px; color: #5a6270; }
    header h1 { font-size: 15px; margin: 0; font-weight: 700; color: #1e2430; letter-spacing: 0.02em; }
    header .msg.err { color: #b3261e; }
    header .spacer { flex: 1; }
    header select, header button, header input { font: inherit; font-size: 12px; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; }
    header input { width: 3em; }
    header a { color: #1565c0; }
    .banner { padding: 6px 18px; font-size: 12.5px; background: #fff8e1; color: #6d4c00; border-bottom: 1px solid #ffe082; }
    .bar { background: #fff; border-bottom: 1px solid #e3e6ec; position: sticky; top: 0; z-index: 3; }
    main { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 18px; padding: 16px 18px 24px; align-items: start; }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
    .col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    section { background: #fff; border: 1px solid #e3e6ec; border-radius: 10px; padding: 12px 14px; }
    .welcome { color: #5a6270; max-width: 64ch; padding: 24px 18px; }
    .welcome code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0f1f4; padding: 0 3px; border-radius: 3px; }
    .live { color: #8a94a6; font-size: 11.5px; }
    .live .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2e7d32; margin-right: 4px; animation: blink 1.6s infinite; }
    @keyframes blink { 50% { opacity: 0.35; } }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void connect();
  }

  override render() {
    const state = connection.get();
    const c = caps.get();
    const missing = missingToolsText(c);
    const ok = state === "ok";
    return html`
      <header>
        <h1>attn</h1>
        <span>${headerLabel.get()}</span>
        <span class="msg ${state === "error" ? "err" : ""}">${connectionMessage.get()}${state === "sign-in" && whoami.get()?.auth.authorizationUrl
          ? html` (<a href=${whoami.get()!.auth.authorizationUrl!} target="_blank" rel="noopener">open the sign-in page</a>)` : nothing}</span>
        <span class="spacer"></span>
        ${ok ? html`<span class="live"><span class="dot"></span>live · every <input type="number" min="1" max="3600" .value=${String(pollSeconds.get())} @change=${(e: Event) => { pollSeconds.set(pollMs((e.target as HTMLInputElement).value) / 1000); schedulePoll(); }}> s${lastChange.get() ? ` · last: ${lastChange.get()}` : ""}${feedError.get() ? ` · ${feedError.get()}` : ""}</span>` : nothing}
        ${repos.get().length > 0 ? html`<label>repo
          <select .value=${repo.get()} @change=${(e: Event) => switchRepo((e.target as HTMLSelectElement).value)}>
            ${repos.get().map((slug) => html`<option value=${slug} ?selected=${slug === repo.get()}>${slug}</option>`)}
          </select></label>` : html`<span title="the minimal profile has no repos tool: the server's default repository is used">default repo</span>`}
        <button type="button" ?disabled=${state === "connecting"} @click=${() => { void connect(); }}>reconnect</button>
      </header>
      ${missing ? html`<div class="banner">${missing}</div>` : nothing}
      <div class="bar">
        ${ok ? html`<focus-bar .pointer=${pointer.get()} .intent=${focusedIntent.get()} .intents=${intents.get()} .recent=${recent.get()} .titles=${titles.get()} ?busy=${busy.get()} .message=${barMessage.get()}
          @attn-declare=${(e: CustomEvent<DeclareDetail>) => doDeclare(e.detail.text, e.detail.focus, e.detail.interrupt)}
          @attn-resume=${(e: CustomEvent<ResumeDetail>) => doResume(e.detail.path, e.detail.interrupt)}
          @attn-back=${doBack}
          @attn-stop=${doStop}></focus-bar>` : html`<div class="welcome">${connectionMessage.get() || "connecting…"}</div>`}
      </div>
      ${ok ? html`<main>
        <div class="col">
          <section>
            <intent-feed .feed=${feed.get()} .problems=${cueProblems.get()} ?busy=${busy.get()} .pending=${pendingCue.get()} .editing=${editing.get()} .message=${panelMessage.get()}
              @intent-focus=${(e: CustomEvent<IntentPathDetail>) => doResume(e.detail.path, false)}
              @intent-status=${(e: CustomEvent<IntentStatusDetail>) => doStatus(e.detail.path, e.detail.status)}
              @cue-snooze=${(e: CustomEvent<IntentPathDetail>) => snoozeIntent(e.detail.path)}
              @cue-plan=${(e: CustomEvent<CuePlanDetail>) => { void planCue(e.detail); }}
              @cue-execute=${() => { void executeCue(); }}
              @cue-cancel=${() => { pendingCue.set(null); panelMessage.set(null); }}
              @cue-remove=${(e: CustomEvent<CueRemoveDetail>) => doRemoveCue(e.detail.path, e.detail.id)}
              @intent-edit-open=${(e: CustomEvent<IntentPathDetail>) => { void openEditor(e.detail.path); }}
              @intent-edit-save=${(e: CustomEvent<IntentEditSaveDetail>) => doSaveEdit(e.detail.path, e.detail.content)}
              @intent-edit-cancel=${() => { editing.set(null); panelMessage.set(null); }}></intent-feed>
          </section>
        </div>
        <div class="col">
          <section>
            <stream-view .days=${streamDays.get()} .day=${streamDay.get()} .episodes=${episodes.get()} .intents=${intentsByPath.get()} ?loading=${streamLoading.get()} .error=${streamError.get()} .revisions=${history.get().length}
              @stream-day=${(e: CustomEvent<StreamDayDetail>) => pickDay(e.detail.day)}></stream-view>
          </section>
          <section class="welcome" style="padding: 10px 14px">
            <p style="margin:0">Built on <code>omg mcp --tools minimal</code>: the pointer <code>${POINTER_PATH}</code> is <code>docs_read</code>; the feed is one <code>query</code> (each intent with its <code>cues</code> list; the focused one found by a join against the pointer, never a tag); the stream is reconstructed from the pointer's <code>revisions</code> with <code>docs_read { at }</code>; every switch writes the pointer only, one <code>apply</code> under <code>expect.revision</code>; a new cue is <code>plan</code> → <code>execute</code> over the intent's whole <code>cues</code> list; other windows are seen through <code>changes_since</code>.</p>
          </section>
        </div>
      </main>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "attn-app": AttnApp }
}
