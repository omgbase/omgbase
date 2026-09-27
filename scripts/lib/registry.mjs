// Registry lookups: which versions of a package are already published.
//   npm:    `npm view <name> versions --json` (what publish-npm.mjs used)
//   crates: the crates.io API (cargo search/info are unreliable for "is this
//           exact version up"); crates.io asks for an identifying User-Agent.
import { execFile } from "node:child_process";

const USER_AGENT = "omgbase-release (https://github.com/omgbase/omgbase)";

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error ? (error.code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "", error });
    });
  });
}

/** Parse JSON out of npm's stdout even when a wrapper printed a banner before it. */
export function parseNpmJson(stdout) {
  const start = stdout.search(/[[{"]/);
  if (start < 0) return [];
  const parsed = JSON.parse(stdout.slice(start));
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Published versions of an npm package (empty when never published). */
export async function npmVersions(name) {
  const r = await run("npm", ["view", name, "versions", "--json"]);
  if (r.status !== 0) {
    if (/E404|Not Found/i.test(r.stderr + r.stdout)) return [];
    throw new Error(`npm view ${name} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  return parseNpmJson(r.stdout);
}

/** Published (non-yanked) versions of a crate (empty when never published). */
export async function crateVersions(name) {
  const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}/versions`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`crates.io ${name}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.versions ?? [])
    .filter((v) => !v.yanked)
    .map((v) => v.num)
    .reverse();
}

export function versionsOf(p) {
  return p.kind === "npm" ? npmVersions(p.name) : crateVersions(p.name);
}

export async function npmWhoami() {
  const r = await run("npm", ["whoami"]);
  if (r.status !== 0) return null;
  const line = r.stdout.trim().split("\n").at(-1);
  return line ? line.trim() : null;
}

/**
 * Registry status for every package: key → `{ versions }` or `{ error }`.
 * Lookups run concurrently.
 */
export async function registryStatus(packages) {
  const results = await Promise.all(
    packages.map(async (p) => {
      try {
        return [p.key, { versions: await versionsOf(p) }];
      } catch (e) {
        return [p.key, { error: e.message.split("\n")[0], versions: [] }];
      }
    }),
  );
  return new Map(results);
}
