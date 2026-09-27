// Publish every package whose current version is not on its registry, in
// dependency order: crates first (`cargo publish -p <crate>`, which waits for
// the index between dependents), then npm (`pnpm publish --access public
// --no-git-checks` with stdio inherited so the OTP prompt reaches the terminal).
// Verifies each publish on the registry and stops at the first failure so a
// dependent is never published against a missing dependency.
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { topoSort } from "./workspace.mjs";
import { npmWhoami, registryStatus, versionsOf } from "./registry.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRegistry(p, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    if ((await versionsOf(p)).includes(p.version)) return true;
    await sleep(3000);
  }
  return false;
}

/**
 * `{ npmOnly, cratesOnly, otp, dryRun, log }` → exit code. `log` receives
 * every line meant for the terminal.
 */
export async function runPublish(ws, { npmOnly = false, cratesOnly = false, otp, dryRun = false, log = console.log } = {}) {
  const groups = [];
  if (!npmOnly) groups.push({ kind: "crate", items: topoSort(ws.crates) });
  if (!cratesOnly) groups.push({ kind: "npm", items: topoSort(ws.npm) });

  const status = await registryStatus(groups.flatMap((g) => g.items));
  const todo = [];
  for (const g of groups) {
    for (const p of g.items) {
      const r = status.get(p.key);
      if (r.error) {
        log(`error    ${p.name.padEnd(22)} ${g.kind.padEnd(5)} local ${p.version.padEnd(8)} registry lookup failed: ${r.error}`);
        return 1;
      }
      const latest = r.versions.at(-1) ?? "—";
      const missing = !r.versions.includes(p.version);
      log(`${missing ? "publish " : "current "} ${p.name.padEnd(22)} ${g.kind.padEnd(5)} local ${p.version.padEnd(8)} registry ${latest}`);
      if (missing) todo.push({ ...p, kind: g.kind });
    }
  }
  if (!todo.length) {
    log("\nnothing to publish — every version is on its registry.");
    return 0;
  }
  const describe = (p) => `${p.kind === "npm" ? "npm " : "crate "}${p.name}@${p.version}`;
  if (dryRun) {
    log(`\n--dry-run: would publish ${todo.map(describe).join(", ")}`);
    return 0;
  }

  let user = null;
  if (todo.some((p) => p.kind === "npm")) {
    user = await npmWhoami();
    if (!user) {
      log("npm whoami failed — run `npm login` first (publishing needs your account and its OTP).");
      return 1;
    }
  }
  log(`\npublishing${user ? ` (npm as ${user})` : ""}: ${todo.map(describe).join(" → ")}\n`);

  for (const p of todo) {
    let cmd;
    let args;
    if (p.kind === "crate") {
      cmd = "cargo";
      args = ["publish", "-p", p.name];
    } else {
      cmd = "pnpm";
      args = ["publish", "--access", "public", "--no-git-checks", ...(otp ? ["--otp", otp] : [])];
    }
    log(`\n== ${describe(p)}  (cd ${relative(ws.root, p.dir)} && ${cmd} ${args.join(" ")})`);
    const r = spawnSync(cmd, args, { cwd: p.dir, stdio: "inherit" });
    if (r.status !== 0) {
      log(`\n${describe(p)} did not publish (exit ${r.status}); stopping so dependents are not published against a missing dependency.`);
      return 1;
    }
    if (!(await waitForRegistry(p))) {
      log(`\n${describe(p)} is still not on the registry after publish; stopping.`);
      return 1;
    }
    log(`   ${describe(p)} is on the registry.`);
  }
  log("\ndone — every version is on its registry.");
  return 0;
}
