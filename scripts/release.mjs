#!/usr/bin/env node
// The release tool for the omgbase monorepo (plain Node ≥ 22, no dependencies).
//
//   pnpm release check [--base <ref>]          every changed package has a pending change note
//   pnpm release plan [--offline]              pending bumps, next versions, publish order
//   pnpm release version [--no-commit] [--allow-dirty] [--dry-run]
//                                              apply the plan: bump, rewrite pins, changelogs, commit
//   pnpm release publish [--npm-only|--crates-only] [--otp <code>] [--dry-run]
//                                              publish every version missing from its registry
//
// Change notes live in changes/<slug>.md (see changes/README.md). Usage errors exit 2.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadWorkspace, labelOf, ownerOf } from "./lib/workspace.mjs";
import { loadNotes } from "./lib/notes.mjs";
import { computePlan, renderPlan } from "./lib/plan.mjs";
import { applyPlan } from "./lib/apply.mjs";
import { registryStatus } from "./lib/registry.mjs";
import { runPublish } from "./lib/publish.mjs";

const USAGE = `usage: release <command> [options]

  check   [--base <ref>]                     every file changed under packages/*/ or crates/*/
                                             belongs to a package named by a pending change note
  plan    [--offline]                        pending notes → levels, next versions, publish order
  version [--no-commit] [--allow-dirty] [--dry-run]
                                             apply the plan and commit "release: …"
  publish [--npm-only|--crates-only] [--otp <code>] [--dry-run]
                                             cargo publish, then pnpm publish (OTP prompt inherited)

Change notes: changes/<slug>.md — see changes/README.md.`;

const IGNORED = [
  /(^|\/)tests?\//, // **/test/**, **/tests/**
  /\.test\.ts$/,
  /(^|\/)corpus\//,
  /(^|\/)README\.md$/,
  /(^|\/)CHANGELOG\.md$/,
];

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (["base", "otp"].includes(name)) {
        const v = argv[++i];
        if (!v || v.startsWith("--")) fail(`usage: --${name} requires a value`, 2);
        flags[name] = v;
      } else if (["offline", "no-commit", "allow-dirty", "dry-run", "npm-only", "crates-only", "help"].includes(name)) {
        flags[name] = true;
      } else fail(`usage: unknown option ${a}\n\n${USAGE}`, 2);
    } else positional.push(a);
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFailure) fail(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r;
}

function report(plan, ws) {
  for (const w of plan.warnings) console.log(`warning: ${w}`);
  if (plan.errors.length) {
    console.error(`\n${plan.errors.length} problem${plan.errors.length > 1 ? "s" : ""} with the plan:`);
    for (const e of plan.errors) console.error(`  - ${e}`);
    return false;
  }
  return true;
}

function loadPlan(ws) {
  const { notes, errors } = loadNotes(ws);
  if (errors.length) fail(errors.join("\n\n"));
  return { notes, plan: computePlan(ws, notes) };
}

function sequenceLines(plan, ws) {
  if (!plan.sequence.length) return ["publish sequence: nothing to publish"];
  const fmt = (list) => list.map((e) => `${labelOf(e.key, ws)}@${e.next}`).join(" → ");
  const out = ["publish sequence:"];
  if (plan.crateOrder.length) out.push(`  crates: ${fmt(plan.crateOrder)}`);
  if (plan.npmOrder.length) out.push(`  npm:    ${fmt(plan.npmOrder)}`);
  return out;
}

// ---------------------------------------------------------------- check

function defaultBase() {
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const mb = git(["merge-base", "HEAD", "origin/main"], { allowFailure: true });
  const base = mb.status === 0 ? mb.stdout.trim() : null;
  if (!base) return "HEAD~1";
  return base === head ? "HEAD~1" : base;
}

function changedFiles(base) {
  const diff = git(["diff", "--name-only", base]).stdout.split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).stdout.split("\n");
  return [...new Set([...diff, ...untracked])].filter(Boolean).sort();
}

function check(ws, flags) {
  const base = flags.base ?? defaultBase();
  const files = changedFiles(base);
  const { notes, errors } = loadNotes(ws);
  const noted = new Set(notes.flatMap((n) => n.bumps.map((b) => b.key)));
  const owners = new Map(); // key -> [files]
  const ignored = [];
  for (const f of files) {
    const key = ownerOf(f, ws);
    if (!key) continue;
    if (IGNORED.some((re) => re.test(f))) {
      ignored.push(f);
      continue;
    }
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(f);
  }
  console.log(`release check: ${files.length} file${files.length === 1 ? "" : "s"} changed since ${base} (working tree included)`);
  console.log(`  ${owners.size} package${owners.size === 1 ? "" : "s"} touched, ${ignored.length} test/corpus/README/CHANGELOG file${ignored.length === 1 ? "" : "s"} ignored`);
  console.log(`  ${notes.length} pending note${notes.length === 1 ? "" : "s"} in changes/${notes.length ? ": " + notes.map((n) => n.slug).join(", ") : ""}`);
  const missing = [...owners.keys()].filter((k) => !noted.has(k)).sort();
  for (const [key, list] of [...owners.entries()].sort()) {
    console.log(`  ${noted.has(key) ? "ok     " : "MISSING"} ${labelOf(key, ws).padEnd(24)} ${list.length} file${list.length === 1 ? "" : "s"}`);
  }
  let ok = true;
  if (errors.length) {
    console.error("\n" + errors.join("\n\n"));
    ok = false;
  }
  if (missing.length) {
    console.error(`\nno pending change note names: ${missing.map((k) => labelOf(k, ws)).join(", ")}`);
    console.error("write changes/<slug>.md naming each (level none is fine for docs/tests-only changes) — see changes/README.md");
    ok = false;
  }
  const plan = computePlan(ws, notes);
  if (!report(plan, ws)) ok = false;
  if (!ok) process.exit(1);
  console.log("\nrelease check passed.");
}

// ---------------------------------------------------------------- plan

async function showPlan(ws, flags) {
  const { plan } = loadPlan(ws);
  const registry = flags.offline ? null : await registryStatus(ws.all);
  console.log(renderPlan(plan, ws, registry));
  console.log("");
  const ok = report(plan, ws);
  for (const line of sequenceLines(plan, ws)) console.log(line);
  if (registry) {
    const stale = ws.all.filter((p) => {
      const r = registry.get(p.key);
      return r && !r.error && !r.versions.includes(p.version);
    });
    if (stale.length) console.log(`not yet on the registry at the current version: ${stale.map((p) => `${labelOf(p.key, ws)}@${p.version}`).join(", ")} — \`release publish\` would publish them`);
  }
  return ok;
}

// ---------------------------------------------------------------- version

async function version(ws, flags) {
  if (!flags["allow-dirty"] && !flags["dry-run"]) {
    const status = git(["status", "--porcelain"]).stdout.trim();
    if (status) fail(`the working tree is dirty; commit or stash first (or pass --allow-dirty):\n${status}`);
  }
  const { notes, plan } = loadPlan(ws);
  console.log(renderPlan(plan, ws, null));
  console.log("");
  if (!report(plan, ws)) process.exit(1);
  for (const line of sequenceLines(plan, ws)) console.log(line);
  if (!plan.sequence.length) {
    console.log("nothing to version.");
    return;
  }
  if (flags["dry-run"]) {
    const preview = applyPlan(ws, plan, notes, { dryRun: true });
    console.log(`\n--dry-run: would edit ${preview.touched.join(", ")} and remove ${preview.removed.join(", ") || "no notes"}`);
    return;
  }
  const result = applyPlan(ws, plan, notes);
  console.log("");
  for (const s of result.summary) console.log(`  ${s}`);
  const toAdd = [...result.touched, "changes"];
  if (plan.crateOrder.length && existsSync(join(ROOT, "Cargo.lock"))) {
    const r = spawnSync("cargo", ["update", "--workspace", "--offline"], { cwd: ROOT, encoding: "utf8" });
    if (r.status === 0) {
      toAdd.push("Cargo.lock");
      console.log("  Cargo.lock: workspace entries refreshed");
    } else console.log(`  warning: cargo update --workspace --offline failed (${(r.stderr || "").trim().split("\n").at(-1)}); Cargo.lock left as is`);
  }
  git(["add", "-A", "--", ...toAdd.filter((p) => existsSync(join(ROOT, p)) || p === "changes")]);
  const message = `release: ${plan.sequence.map((e) => `${labelOf(e.key, ws)}@${e.next}`).join(", ")}`;
  if (flags["no-commit"]) {
    console.log(`\nstaged (--no-commit). Suggested message:\n  ${message}`);
    return;
  }
  git(["commit", "-q", "-m", message]);
  console.log(`\ncommitted: ${message}`);
}

// ---------------------------------------------------------------- publish

async function publish(ws, flags) {
  if (flags["npm-only"] && flags["crates-only"]) fail("usage: --npm-only and --crates-only are exclusive", 2);
  const { notes } = loadNotes(ws);
  if (notes.length) console.log(`note: ${notes.length} pending change note${notes.length > 1 ? "s" : ""} in changes/ — run \`release version\` first if they belong in this release.\n`);
  const code = await runPublish(ws, { npmOnly: flags["npm-only"], cratesOnly: flags["crates-only"], otp: flags.otp, dryRun: flags["dry-run"] });
  process.exit(code);
}

// ---------------------------------------------------------------- main

const { command, flags } = parseArgs(process.argv.slice(2));
if (!command || flags.help) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
}
const ws = loadWorkspace(ROOT);
switch (command) {
  case "check":
    check(ws, flags);
    break;
  case "plan":
    process.exit((await showPlan(ws, flags)) ? 0 : 1);
    break;
  case "version":
    await version(ws, flags);
    break;
  case "publish":
    await publish(ws, flags);
    break;
  default:
    fail(`usage: unknown command ${command}\n\n${USAGE}`, 2);
}
