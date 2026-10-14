// The page: one element composing the focus bar, the cue feed, the intents
// panel and the stream, over module-level signals.
//
//   connect → (whoami) → version (surface ≥ 4.4, the profile) + tools/list →
//   [repos, when listed] → load: the pointer (docs_read), the intents (one
//   query with the virtual #focus join), the cues (one query), the stream days
//   (docs_tree) and the chosen day (docs_read) → the cue engine → changes_since
//   polled: anything under /attn/ reloads and re-evaluates.
//   Writes: ONE apply per switch / interrupt / back / stop / declare / release /
//   dismiss (lib/writes.ts); a new cue is plan { diffs: true } → execute.
//
// Everything runs on the MINIMAL tools profile (lib/tools.ts); `repos` is the one
// optional tool (a picker when listed). The data path is MCP only
// (lib/mcp-client.ts) through the dev proxy at the same-origin /mcp.

import { LitElement, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { SignalWatcher, computed, signal } from "@lit-labs/signals";
import type { WhoAmI } from "webdevproxy";
import "./elements/focus-bar.ts";
import "./elements/cue-feed.ts";
import "./elements/stream-view.ts";
import "./elements/intents-panel.ts";
import type { BarMessage, DeclareDetail, ResumeDetail } from "./elements/focus-bar.ts";
import type { CueActionDetail, CueProblem } from "./elements/cue-feed.ts";
import type { StreamDayDetail } from "./elements/stream-view.ts";
import type { CuePathDetail, CuePlanDetail, IntentFocusDetail, IntentStatusDetail, PanelMessage } from "./elements/intents-panel.ts";
import { OmgClient, OmgError, fetchWhoAmI, type Wire } from "./lib/mcp-client.ts";
import { profileOf, surfaceOf, surfaceProblem } from "./lib/paths.ts";
import { capabilities, missingToolsText, profileLabel, type Capabilities } from "./lib/tools.ts";
import { dayOf, nowIso, parseDeclaration, intentPath } from "./lib/model.ts";
import { NO_FOCUS, episodeKey, fetchPointer, type FocusState } from "./lib/pointer.ts";
import { fetchIntents, findByTitle, setStatusEffect, type Intent } from "./lib/intents.ts";
import { Delivery, dismissCueEffect, dueTimeCues, evaluateFocusCues, fetchCues, firingScope, queryCueDelta, type Cue, type FiredCue } from "./lib/cues.ts";
import { episodesOf, fetchStreamDay, fetchStreamDays, lastFocused, type Transition } from "./lib/stream.ts";
import { advanceCursor, fetchChanges, pollMs, startCursor, touchesAttn } from "./lib/feed.ts";
import { applyEffects, backEffects, createCueEffect, declareEffects, executePlan, interruptEffects, planEffects, stopEffects, switchEffects, type Effect, type Plan, type SwitchContext } from "./lib/writes.ts";
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
const cues = signal<Cue[]>([]);
const streamDays = signal<string[]>([]);
const streamDay = signal<string>(dayOf(nowIso()));
const transitions = signal<Transition[]>([]);
const todayTransitions = signal<Transition[]>([]);
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

const feedCursor = signal<number | null>(null);
const feedError = signal<string | null>(null);
const pollSeconds = signal<number>(pollMs(localStorage.getItem(POLL_KEY)) / 1000);
const lastChange = signal<string | null>(null);

const intentsByPath = computed<Map<string, Intent>>(() => new Map(intents.get().map((i) => [i.path, i])));
const titles = computed<Map<string, string>>(() => new Map(intents.get().map((i) => [i.path, i.title])));
const focusedIntent = computed<Intent | null>(() => { const f = pointer.get().focused; return f ? intentsByPath.get().get(f) ?? null : null; });
const recent = computed<Map<string, string>>(() => lastFocused([...transitions.get(), ...todayTransitions.get()]));
const episodes = computed(() => episodesOf(transitions.get(), streamDay.get(), { now: clock.get(), pointer: pointer.get() }));

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
    const [p, is, cs, days] = await Promise.all([fetchPointer(client, r), fetchIntents(client, r), fetchCues(client, r), fetchStreamDays(client, r)]);
    if (gen !== loadGeneration) return;
    pointer.set(p);
    intents.set(is);
    cues.set(cs);
    streamDays.set(days);
    await Promise.all([loadDay(streamDay.get(), gen), loadToday(gen)]);
  } catch (e) {
    if (gen === loadGeneration) connectionMessage.set(`load failed: ${describe(e)}`);
  }
}

async function loadDay(day: string, gen = loadGeneration): Promise<void> {
  streamLoading.set(true);
  streamError.set(null);
  try {
    const t = await fetchStreamDay(client, day, repoArgValue.get());
    if (gen === loadGeneration && streamDay.get() === day) transitions.set(t);
  } catch (e) {
    if (gen === loadGeneration) streamError.set(describe(e));
  } finally {
    if (gen === loadGeneration) streamLoading.set(false);
  }
}

/** Today's lines feed the chooser's recency even while another day is shown. */
async function loadToday(gen = loadGeneration): Promise<void> {
  const today = dayOf(nowIso());
  if (today === streamDay.get()) { todayTransitions.set([]); return; }
  try {
    const t = await fetchStreamDay(client, today, repoArgValue.get());
    if (gen === loadGeneration) todayTransitions.set(t);
  } catch { /* the chooser just loses recency */ }
}

function pickDay(day: string): void {
  streamDay.set(day);
  void loadDay(day);
}

// ---- the cue engine ------------------------------------------------------------------------

let lastEpisode: string | null | undefined;

function offer(cue: Cue, scope: string, reason: string): void {
  const episode = episodeKey(pointer.get());
  if (!delivery.shouldOffer(cue, scope, episode)) return;
  if (fired.get().some((f) => f.cue.path === cue.path && f.scope === scope)) return;
  const now = nowIso();
  delivery.markFired(cue, scope, now);
  fired.set([...fired.get(), { cue, scope, reason, firedAt: now }]);
}

/** On a focus change: the `trigger: focus` cues against the newly focused intent (one query each). */
async function evaluateFocus(): Promise<void> {
  const p = pointer.get();
  const episode = episodeKey(p);
  if (episode === lastEpisode) return;
  lastEpisode = episode;
  // Focus cues offered for an earlier episode are no longer relevant; time and query cues stay.
  fired.set(fired.get().filter((f) => !f.scope.startsWith("episode:")));
  cueProblems.set([]);
  if (!p.focused) return;
  const results = await evaluateFocusCues(client, cues.get(), p.focused, repoArgValue.get());
  if (episodeKey(pointer.get()) !== episode) return;
  const problems: CueProblem[] = [];
  for (const r of results) {
    if (r.error) problems.push({ cuePath: r.cue.path, title: r.cue.title, error: r.error });
    else if (r.fired) offer(r.cue, firingScope(r.cue, episode), `focus matched \`${r.cue.when}\``);
  }
  cueProblems.set(problems);
}

/** The `trigger: time` cues whose `at` has passed (the client clock). */
function evaluateTime(): void {
  const now = nowIso();
  clock.set(now);
  for (const cue of dueTimeCues(cues.get(), now)) offer(cue, firingScope(cue, null), `due at ${cue.at}`);
}

/** The `trigger: query` cues: run each fence, diff the ids against the browser-side checkpoint. */
async function evaluateQueries(): Promise<void> {
  for (const cue of cues.get()) {
    if (cue.trigger !== "query" || cue.status !== "active") continue;
    const d = await queryCueDelta(client, cue, delivery.checkpoint(cue), repoArgValue.get());
    if (d.error) { cueProblems.set([...cueProblems.get().filter((p) => p.cuePath !== cue.path), { cuePath: cue.path, title: cue.title, error: d.error }]); continue; }
    delivery.setCheckpoint(cue, d.ids);
    for (const h of d.enteredHits) offer(cue, firingScope(cue, null, h.id), `${h.path} entered the watched query`);
  }
}

async function runCueEngine(): Promise<void> {
  evaluateTime();
  await Promise.all([evaluateFocus(), evaluateQueries()]);
}

function snoozeCue(path: string): void {
  const cue = cues.get().find((c) => c.path === path);
  if (cue) delivery.snooze(cue, episodeKey(pointer.get()));
  fired.set(fired.get().filter((f) => f.cue.path !== path));
}

// ---- writes ---------------------------------------------------------------------------------

function switchContext(): SwitchContext {
  return { pointer: pointer.get(), now: nowIso(), streamDays: new Set(streamDays.get()) };
}

/** One `apply`; on `path_taken` (a stream day created meanwhile) reload and retry once; `stale_plan` shows the fix and reloads. */
async function write(build: (ctx: SwitchContext) => Effect[] | null, reason: string, target: "bar" | "panel" = "bar"): Promise<boolean> {
  if (busy.get()) return false;
  const say = (m: BarMessage | null) => (target === "bar" ? barMessage : panelMessage).set(m);
  busy.set(true);
  say(null);
  try {
    let effects = build(switchContext());
    if (!effects) return false;
    let receipt;
    try {
      receipt = await applyEffects(client, effects, repoArgValue.get(), reason);
    } catch (e) {
      if (!(e instanceof OmgError && e.code === "path_taken")) throw e;
      streamDays.set(await fetchStreamDays(client, repoArgValue.get()));
      effects = build(switchContext());
      if (!effects) return false;
      receipt = await applyEffects(client, effects, repoArgValue.get(), reason);
    }
    say({ kind: "info", text: receipt.commit ? `${receipt.summary.join(" · ")}` : "nothing to commit" });
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

function doDeclare(text: string, interrupt: boolean): void {
  const d = parseDeclaration(text);
  if (!d.title) return;
  const existing = findByTitle(intents.get().filter((i) => i.status === "active"), d.title);
  if (existing) { doResume(existing.path, interrupt); return; }
  const path = intentPath(d.title, intents.get().map((i) => i.path));
  void write((ctx) => declareEffects(ctx, { path, title: d.title, tags: d.tags }, interrupt ? "interrupt" : "switch"), interrupt ? "attn declare + interrupt" : "attn declare + focus");
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

function doDismiss(path: string): void {
  fired.set(fired.get().filter((f) => f.cue.path !== path));
  void write(() => [dismissCueEffect(path)], "attn dismiss cue", "panel");
}

async function planCue(detail: CuePlanDetail): Promise<void> {
  busy.set(true);
  panelMessage.set(null);
  pendingCue.set(null);
  try {
    pendingCue.set(await planEffects(client, [createCueEffect(detail.cue)], repoArgValue.get()));
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
    const receipt = await executePlan(client, plan, repoArgValue.get(), "attn new cue");
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
          @attn-declare=${(e: CustomEvent<DeclareDetail>) => doDeclare(e.detail.text, e.detail.interrupt)}
          @attn-resume=${(e: CustomEvent<ResumeDetail>) => doResume(e.detail.path, e.detail.interrupt)}
          @attn-back=${doBack}
          @attn-stop=${doStop}></focus-bar>` : html`<div class="welcome">${connectionMessage.get() || "connecting…"}</div>`}
      </div>
      ${ok ? html`<main>
        <div class="col">
          <section>
            <cue-feed .fired=${fired.get()} .titles=${titles.get()} .problems=${cueProblems.get()} ?busy=${busy.get()}
              @cue-focus=${(e: CustomEvent<CueActionDetail>) => doResume(e.detail.path, false)}
              @cue-snooze=${(e: CustomEvent<CueActionDetail>) => snoozeCue(e.detail.path)}
              @cue-dismiss=${(e: CustomEvent<CueActionDetail>) => doDismiss(e.detail.path)}></cue-feed>
          </section>
          <section>
            <intents-panel .intents=${intents.get()} .cues=${cues.get()} .focused=${pointer.get().focused} ?busy=${busy.get()} .pending=${pendingCue.get()} .message=${panelMessage.get()}
              @intent-focus=${(e: CustomEvent<IntentFocusDetail>) => doResume(e.detail.path, false)}
              @intent-status=${(e: CustomEvent<IntentStatusDetail>) => doStatus(e.detail.path, e.detail.status)}
              @cue-plan=${(e: CustomEvent<CuePlanDetail>) => { void planCue(e.detail); }}
              @cue-execute=${() => { void executeCue(); }}
              @cue-cancel=${() => { pendingCue.set(null); panelMessage.set(null); }}
              @cue-dismiss=${(e: CustomEvent<CuePathDetail>) => doDismiss(e.detail.path)}></intents-panel>
          </section>
        </div>
        <div class="col">
          <section>
            <stream-view .days=${streamDays.get()} .day=${streamDay.get()} .episodes=${episodes.get()} .intents=${intentsByPath.get()} ?loading=${streamLoading.get()} .error=${streamError.get()}
              @stream-day=${(e: CustomEvent<StreamDayDetail>) => pickDay(e.detail.day)}></stream-view>
          </section>
          <section class="welcome" style="padding: 10px 14px">
            <p style="margin:0">Built on <code>omg mcp --tools minimal</code>: the pointer is <code>docs_read</code>, intents and cues one <code>query</code> each (the focused intent found by a join against the pointer, never a tag), the stream <code>docs_tree</code> + <code>docs_read</code>, every switch one <code>apply</code> under <code>expect.revision</code>, a new cue <code>plan</code> → <code>execute</code>, other windows seen through <code>changes_since</code>.</p>
          </section>
        </div>
      </main>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "attn-app": AttnApp }
}
