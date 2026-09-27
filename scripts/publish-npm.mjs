#!/usr/bin/env node
// Publish every public workspace package whose package.json version is not on
// the npm registry yet, in dependency order (a package publishes after every
// workspace package it depends on, so pnpm's `workspace:^` rewrite resolves to
// a version that exists).
//
//   pnpm publish:npm              # publish what is missing (prompts for the OTP)
//   pnpm publish:npm --dry-run    # only report what would publish
//   pnpm publish:npm --otp 123456 # pass the OTP through to every publish
//
// Requires `npm whoami` to succeed; exits 1 on the first failed publish so the
// dependency order is never violated.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const otpIndex = args.indexOf("--otp");
const otp = otpIndex >= 0 ? args[otpIndex + 1] : undefined;
if (otpIndex >= 0 && !otp) {
  console.error("usage: --otp requires a code");
  process.exit(2);
}

/** Every non-private workspace package: { name, version, dir, deps: workspace dep names }. */
function workspacePackages() {
  const pkgs = [];
  for (const entry of readdirSync(join(ROOT, "packages"))) {
    const file = join(ROOT, "packages", entry, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.private) continue;
    pkgs.push({ name: pkg.name, version: pkg.version, dir: join(ROOT, "packages", entry), pkg });
  }
  const names = new Set(pkgs.map((p) => p.name));
  for (const p of pkgs) {
    const all = { ...(p.pkg.dependencies ?? {}), ...(p.pkg.optionalDependencies ?? {}), ...(p.pkg.peerDependencies ?? {}) };
    p.deps = Object.keys(all).filter((d) => names.has(d));
  }
  return pkgs;
}

/** Dependencies before dependents; stable within a level (alphabetical). */
function topoSort(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const out = [];
  const state = new Map(); // name -> "visiting" | "done"
  const visit = (p, trail) => {
    if (state.get(p.name) === "done") return;
    if (state.get(p.name) === "visiting") throw new Error(`dependency cycle: ${[...trail, p.name].join(" -> ")}`);
    state.set(p.name, "visiting");
    for (const d of [...p.deps].sort()) visit(byName.get(d), [...trail, p.name]);
    state.set(p.name, "done");
    out.push(p);
  };
  for (const p of [...pkgs].sort((a, b) => a.name.localeCompare(b.name))) visit(p, []);
  return out;
}

/** Published versions of a package (empty when it has never been published). */
function publishedVersions(name) {
  const r = spawnSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8" });
  if (r.status !== 0) {
    if (/E404|Not Found/i.test(r.stderr + r.stdout)) return [];
    throw new Error(`npm view ${name} failed:\n${r.stderr || r.stdout}`);
  }
  const parsed = JSON.parse(r.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function whoami() {
  const r = spawnSync("npm", ["whoami"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const user = whoami();
if (!user && !dryRun) {
  console.error("npm whoami failed — run `npm login` first (publishing needs your account and its OTP).");
  process.exit(1);
}

const ordered = topoSort(workspacePackages());
const plan = [];
for (const p of ordered) {
  const versions = publishedVersions(p.name);
  const latest = versions.at(-1) ?? "—";
  const missing = !versions.includes(p.version);
  plan.push({ ...p, latest, missing });
  console.log(`${missing ? "publish " : "current "} ${p.name.padEnd(22)} local ${p.version.padEnd(8)} registry ${latest}`);
}

const todo = plan.filter((p) => p.missing);
if (todo.length === 0) {
  console.log("\nnothing to publish — every package version is on the registry.");
  process.exit(0);
}
if (dryRun) {
  console.log(`\n--dry-run: would publish ${todo.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  process.exit(0);
}

console.log(`\npublishing as ${user}: ${todo.map((p) => `${p.name}@${p.version}`).join(" → ")}\n`);
for (const p of todo) {
  const publishArgs = ["publish", "--access", "public", "--no-git-checks", ...(otp ? ["--otp", otp] : [])];
  console.log(`\n== ${p.name}@${p.version}  (cd ${p.dir.replace(ROOT + "/", "")} && pnpm ${publishArgs.join(" ")})`);
  const r = spawnSync("pnpm", publishArgs, { cwd: p.dir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${p.name}@${p.version} did not publish (exit ${r.status}); stopping so dependents are not published against a missing dependency.`);
    process.exit(1);
  }
  const now = publishedVersions(p.name);
  if (!now.includes(p.version)) {
    console.error(`\n${p.name}@${p.version} is still not on the registry after publish; stopping.`);
    process.exit(1);
  }
}
console.log("\ndone — every package version is on the registry.");
