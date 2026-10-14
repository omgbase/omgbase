#!/usr/bin/env node
// Build the demo's omgbase workspace from the attn SAMPLE CORPUS — a week in
// the life of a fictional alchemist under `corpus/attn/` (nine intents with
// their embedded cues, the focus pointer) — with the omg CLI from packages/cli
// (run `pnpm build` at the repo root first). The corpus is COPIED to
// <workspace>/attn and that copy is the repo's source, so every switch,
// declaration and cue made in the page lands in the copy, not in the checked-in
// sample. Then, because the Stream is reconstructed from the POINTER'S
// REVISIONS, a few focus switches are made THROUGH THE ENGINE — the app's own
// effect builders (src/lib/writes.ts, imported directly: Node ≥ 22.18 strips
// types) fed to `omg apply` as the page would feed `apply` — so the stream has
// history on first open. Idempotent: an existing workspace is kept unless
// --force (which also resets the copy). Prints the workspace path.
//
//   node scripts/dev-workspace.mjs [--force]
//   env: OMG (path to omg's main.js), ATTN_WORKSPACE (target dir)
//
// (After examples/repo-explorer/scripts/dev-workspace.mjs; the sample and the seeding differ.)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerOf } from "../src/lib/pointer.ts";
import { backEffects, interruptEffects, switchEffects } from "../src/lib/writes.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, "..");
export const OMG = process.env.OMG ?? resolve(PACKAGE_ROOT, "../../packages/cli/dist/src/main.js");
export const WORKSPACE = process.env.ATTN_WORKSPACE ?? resolve(PACKAGE_ROOT, ".dev-workspace");
/** The corpus the workspace is built from (the `attn/` folder inside it is the app's root). */
export const CORPUS = resolve(PACKAGE_ROOT, "corpus");
/** The repo slug the copy is attached under. */
export const REPO = "attn";

const INTENTS = "/attn/intents/2026/10";
const DEW = `${INTENTS}/2026-10-09-distil-the-dew.md`;
const LETTER = `${INTENTS}/2026-10-10-write-to-nicolas.md`;
const LUNCH = `${INTENTS}/2026-10-08-enjoy-lunch.md`;
const SALT = `${INTENTS}/2026-10-12-calcine-the-salt.md`;

function omg(args, cwd, input) {
  const r = spawnSync(process.execPath, [OMG, ...args], { cwd, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`omg ${args.join(" ")} failed (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  }
  return r.stdout;
}

/** The pointer as the page reads it (`docs_read` → `pointerOf`): here through `omg --json show`. */
function readPointer(workspace) {
  return pointerOf(JSON.parse(omg(["--json", "-C", workspace, "show", "/attn/focus.md"], PACKAGE_ROOT)));
}

/**
 * The seeded history, as hours before `now`: yesterday's pointer from the
 * corpus, then today a switch to the dew, lunch as an interrupt, back to the
 * dew, and the salt — each ONE `apply` of the app's own effect list.
 * @returns {{ reason: string, build: (ctx: { pointer: import("../src/lib/pointer.ts").FocusState, now: string }) => Record<string, unknown>[] | null, hoursAgo: number }[]}
 */
export function seedSteps() {
  return [
    { reason: "attn switch", hoursAgo: 3, build: (ctx) => switchEffects(ctx, DEW) },
    { reason: "attn interrupt", hoursAgo: 2.25, build: (ctx) => interruptEffects(ctx, LUNCH) },
    { reason: "attn back", hoursAgo: 1.75, build: (ctx) => backEffects(ctx) },
    { reason: "attn interrupt", hoursAgo: 1.25, build: (ctx) => interruptEffects(ctx, LETTER) },
    { reason: "attn back", hoursAgo: 1, build: (ctx) => backEffects(ctx) },
    { reason: "attn switch", hoursAgo: 0.5, build: (ctx) => switchEffects(ctx, SALT) },
  ];
}

/** Make the seeded switches against the workspace, through `omg apply` (one commit each; the pointer re-read before each for its CAS token). */
export function seedHistory(workspace, { log = () => {}, now = Date.now() } = {}) {
  for (const step of seedSteps()) {
    const pointer = readPointer(workspace);
    const at = new Date(now - step.hoursAgo * 3_600_000).toISOString();
    const effects = step.build({ pointer, now: at });
    if (!effects) continue;
    omg(["-C", workspace, "apply", "-f", "-", "--reason", step.reason, "--actor", "attn:seed"], PACKAGE_ROOT, JSON.stringify({ effects }));
    log(`${step.reason.padEnd(15)} ${at}`);
  }
}

/** Ensure the workspace exists and is populated; returns its path. */
export function ensureWorkspace({ force = false, log = () => {} } = {}) {
  if (!existsSync(OMG)) {
    throw new Error(`omg is not built at ${OMG} — run \`pnpm build\` at the repository root first`);
  }
  if (existsSync(resolve(WORKSPACE, ".omgbase")) && !force) {
    log(`workspace ok  ${WORKSPACE}`);
    return WORKSPACE;
  }
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  const copy = resolve(WORKSPACE, REPO);
  log(`copy ${CORPUS} → ${copy}`);
  cpSync(CORPUS, copy, { recursive: true });
  log(`omg init ${WORKSPACE}`);
  omg(["init", WORKSPACE, "--yes", "--no-embedder"], PACKAGE_ROOT);
  log(`omg source add ${copy} --repo ${REPO}`);
  omg(["-C", WORKSPACE, "source", "add", copy, "--repo", REPO, "-y"], PACKAGE_ROOT);
  log("seeding the pointer's history through `omg apply` (the app's own effect lists):");
  seedHistory(WORKSPACE, { log });
  log(`workspace built  ${WORKSPACE}`);
  return WORKSPACE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    ensureWorkspace({ force: process.argv.includes("--force"), log: (m) => console.error(m) });
    console.log(WORKSPACE);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
