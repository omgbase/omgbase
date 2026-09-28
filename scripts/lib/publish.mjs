// Publish every package whose current version is not on its registry, in
// dependency order: crates first (`cargo publish -p <crate>`, which waits for
// the index between dependents), then npm (`pnpm publish --access public
// --no-git-checks --otp <code>`). Verifies each publish on the registry and
// stops at the first failure so a dependent is never published against a
// missing dependency.
//
// The OTP. A one-time password lives ~30 s, and the registry wait between two
// npm packages can run minutes, so one code cannot cover a release: on a TTY the
// tool asks for a fresh code right before EACH npm publish (after the registry
// wait, after the "already published" check) and asks again when npm rejects
// the code as expired (EOTP). `--otp <code>` covers the first npm publish only.
// Without a TTY and without `--otp`, stdin is inherited and npm's own prompt
// (or its lack) applies.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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

/** npm refused the publish for want of a (valid, unexpired) one-time password. */
export function otpRejected(output) {
  return /\bEOTP\b|one-time pass/i.test(output);
}

/**
 * Ask the terminal for a one-time password; `null` when there is no TTY to ask
 * (the caller then leaves the prompt to npm) or the answer is empty.
 */
export function promptOtpOnTty(question) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

/** How many one-time passwords one npm publish may be asked for before giving up. */
const OTP_ATTEMPTS = 3;

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
 * `{ npmOnly, cratesOnly, otp, dryRun, log, promptOtp }` → exit code. `log`
 * receives every line meant for the terminal; `promptOtp(question)` asks for a
 * one-time password (`null` = nobody to ask; the default asks the TTY).
 */
export async function runPublish(ws, { npmOnly = false, cratesOnly = false, otp, dryRun = false, log = console.log, promptOtp = promptOtpOnTty } = {}) {
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
  const npmCount = todo.filter((p) => p.kind === "npm").length;
  if (npmCount > 1 && process.stdin.isTTY) log(`${npmCount} npm packages: you will be asked for a fresh one-time password before each (a code outlives neither the registry wait nor two publishes).\n`);

  // `--otp` is spent on the first npm publish; every later one asks anew.
  let pendingOtp = otp ?? null;
  for (const p of todo) {
    // A fresh, uncached read right before publishing: an earlier run may have
    // published this one after the plan was printed.
    if ((await versionsOf(p)).includes(p.version)) {
      log(`\n== ${describe(p)} is already on the registry — skipping.`);
      continue;
    }
    let r;
    if (p.kind === "crate") {
      const args = ["publish", "-p", p.name];
      log(`\n== ${describe(p)}  (cd ${relative(ws.root, p.dir)} && cargo ${args.join(" ")})`);
      r = await runPublishCommand("cargo", args, p.dir);
    } else {
      const base = ["publish", "--access", "public", "--no-git-checks"];
      let code = pendingOtp;
      pendingOtp = null;
      for (let attempt = 1; ; attempt++) {
        if (!code) {
          code = await promptOtp(`   one-time password for ${describe(p)}${attempt > 1 ? " (fresh — the last one was rejected)" : ""}: `);
          if (!code && attempt > 1) break; // nobody to ask, or nothing typed: give up on this one
        }
        const args = [...base, ...(code ? ["--otp", code] : [])];
        log(`\n== ${describe(p)}  (cd ${relative(ws.root, p.dir)} && pnpm ${args.map((a, i) => (args[i - 1] === "--otp" ? "<otp>" : a)).join(" ")})`);
        r = await runPublishCommand("pnpm", args, p.dir);
        if (r.status === 0 || !otpRejected(r.output) || attempt >= OTP_ATTEMPTS) break;
        log(`\n   npm rejected the one-time password (expired or mistyped) — attempt ${attempt} of ${OTP_ATTEMPTS}.`);
        code = null;
      }
    }
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
