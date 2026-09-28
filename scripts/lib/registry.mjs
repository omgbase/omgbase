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

/**
 * Published versions of an npm package (empty when never published). Read
 * straight from the registry with caching disabled: `npm view` answers from
 * npm's local cache and a CDN replica, and on 2026-09-27 that lag made the
 * publisher try to republish @omgbase/sync@0.4.1 (a 403 from the registry).
 * Falls back to `npm view` only when the registry is unreachable.
 */
export async function npmVersions(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.npm.install-v1+json", "Cache-Control": "no-cache", Pragma: "no-cache" },
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (res.ok) {
      const body = await res.json();
      return Object.keys(body.versions ?? {});
    }
  } catch {
    // fall through to the CLI
  }
  const r = await run("npm", ["view", name, "versions", "--json", "--prefer-online"]);
  if (r.status !== 0) {
    if (/E404|Not Found/i.test(r.stderr + r.stdout)) return [];
    throw new Error(`npm view ${name} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  return parseNpmJson(r.stdout);
}

/**
 * The registry's own verdict that a version already exists: npm answers a
 * republish with 403 "You cannot publish over the previously published
 * versions: x.y.z"; crates.io with "crate version `x.y.z` is already
 * uploaded". Either means the earlier run's publish landed — idempotent.
 */
export function isAlreadyPublished(output, version) {
  const v = version.replace(/[.+]/g, "\\$&");
  return new RegExp(`cannot publish over the previously published versions?:[^\\n]*\\b${v}\\b`, "i").test(output)
    || new RegExp(`crate version \\x60?${v}\\x60? is already uploaded`, "i").test(output);
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
