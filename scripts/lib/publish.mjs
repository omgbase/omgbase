// Publish every package whose current version is not on its registry, in
// dependency order: crates first (`cargo publish -p <crate>`, which waits for
// the index between dependents), then npm (`pnpm publish --access public
// --no-git-checks` with stdio inherited so the OTP prompt reaches the terminal).
// Verifies each publish on the registry and stops at the first failure so a
// dependent is never published against a missing dependency.
import { spawn } from "node:child_process";
import { relative } from "node:path";
import { topoSort } from "./workspace.mjs";
import { isAlreadyPublished, npmWhoami, registryStatus, versionsOf } from "./registry.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the publish command with stdin inherited (the OTP prompt), stdout and
 * stderr forwarded live to the terminal AND captured, so the registry's
 * "already published" answer can be recognized after a non-zero exit.
 */
function runPublishCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { output += d; process.stderr.write(d); });
    child.on("error", (e) => resolve({ status: 1, output: output + String(e) }));
    child.on("close", (status) => resolve({ status: status ?? 1, output }));
  });
}

// npm's read replicas can lag a publish by a minute or more (2026-09-27:
// @omgbase/core@0.4.1 took over 30 s to appear); poll for up to five minutes.
// While polling, a TTY shows a spinner with the elapsed time on one line
// (rewritten in place); a pipe gets one dot per poll so a log still shows life.
async function waitForRegistry(p, label, deadlineMs = 5 * 60_000) {
  const start = Date.now();
  const tty = process.stderr.isTTY;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let tick = 0;
  const show = () => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (tty) process.stderr.write(`\r   ${frames[tick++ % frames.length]} waiting for the registry to show ${label}… ${elapsed}s (up to ${Math.round(deadlineMs / 60_000)} min)`);
    else if (tick++ % 6 === 0) process.stderr.write(".");
  };
  const clear = () => {
    if (tty) process.stderr.write("\r" + " ".repeat(90) + "\r");
    else process.stderr.write("\n");
  };
  show();
  const spinner = tty ? setInterval(show, 120) : null;
  try {
    while (Date.now() - start < deadlineMs) {
      if ((await versionsOf(p)).includes(p.version)) return true;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (!tty) show();
      }
    }
    return false;
  } finally {
    if (spinner) clearInterval(spinner);
    clear();
  }
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
    // A fresh, uncached read right before publishing: an earlier run may have
    // published this one after the plan was printed.
    if ((await versionsOf(p)).includes(p.version)) {
      log(`\n== ${describe(p)} is already on the registry — skipping.`);
      continue;
    }
    log(`\n== ${describe(p)}  (cd ${relative(ws.root, p.dir)} && ${cmd} ${args.join(" ")})`);
    const r = await runPublishCommand(cmd, args, p.dir);
    if (r.status !== 0) {
      if (isAlreadyPublished(r.output, p.version)) {
        log(`\n   the registry says ${describe(p)} is already published (an earlier run landed it) — continuing.`);
        continue;
      }
      log(`\n${describe(p)} did not publish (exit ${r.status}); stopping so dependents are not published against a missing dependency.`);
      return 1;
    }
    // The publish command exited 0, so the version is published; the registry
    // read is advisory (replication lag) — warn and go on rather than stop.
    // A rerun is safe either way: a published version is skipped as current.
    if (await waitForRegistry(p, describe(p))) log(`   ${describe(p)} is on the registry.`);
    else log(`   warning: ${describe(p)} published (exit 0) but is not yet visible on the registry after 5 min of polling; continuing — verify later with \`release plan\`.`);
  }
  log("\ndone — every version is on its registry.");
  return 0;
}
