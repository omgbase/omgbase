import type { HistoryProviderConfig } from "@omgbase/core";

// The git provider's manifest config (spec/store §3.1 `capabilities.config`,
// §5.12): what `history enable --provider git` writes and every later call
// reads. Pinned keys and defaults. `remote` (17.6, Phase 6b) is the remote
// binding `history remote set` writes — `{ name, url, branch, push, fetch }`,
// null until one is bound; nothing is automatic until it is (`push`/`fetch`
// default `off`). The per-document id-map ref `ids_ref` is written by the
// worker since 6b (one commit chain beside the content branch).

export const GIT_PROVIDER = "git";
export const DEFAULT_GIT_DIR = ".omgbase/git";
export const DEFAULT_BRANCH = "omgbase";
export const IDS_REF = "refs/omgbase/ids";

export type GitCadence = "every" | { debounce_ms: number };

export type GitPushPolicy = "off" | "on-checkpoint" | "periodic";
export type GitFetchPolicy = "off" | "periodic" | "webhook";
export const PUSH_POLICIES: readonly GitPushPolicy[] = ["off", "on-checkpoint", "periodic"];
export const FETCH_POLICIES: readonly GitFetchPolicy[] = ["off", "periodic", "webhook"];
export const DEFAULT_REMOTE_NAME = "origin";

/**
 * The remote binding (spec/store §5.12 "The remote binding", 17.6): `name` the
 * git remote's name in the bare repository (`origin`), `url` what `git` is
 * given — never with credentials (`refuseCredentials`) — `branch` the remote
 * branch (the local branch's name by default), `push` when the engine pushes
 * (`off`; `on-checkpoint` after every checkpoint that committed; `periodic` on
 * every freshness sweep), `fetch` when it fetches (`off`; `periodic` on every
 * sweep; `webhook` RESERVED — an external caller runs `history fetch`).
 */
export interface GitRemoteConfig {
  name: string;
  url: string;
  branch: string;
  push: GitPushPolicy;
  fetch: GitFetchPolicy;
}

export interface GitRemoteOptions {
  url: string;
  name?: string;
  branch?: string;
  push?: string;
  fetch?: string;
}

export interface GitHistoryConfig extends HistoryProviderConfig {
  provider: "git";
  git_dir: string;
  branch: string;
  cadence: GitCadence;
  ids_ref: string;
  remote: GitRemoteConfig | null;
}

export interface GitEnableOptions {
  branch?: string;
  cadence?: GitCadence;
}

/** A URL (or anything that looks like one) with embedded credentials is refused everywhere: `git` resolves access through the host. */
export function refuseCredentials(value: string, what: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(value) || /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value)) {
    throw new Error(`${what} carries credentials (a user or password in the URL) — omgbase never stores credentials; let git resolve access through the host (ssh keys, a credential helper)`);
  }
}

/** The config `history enable --provider git` writes, from the verb's options. */
export function gitConfigFor(opts: GitEnableOptions): GitHistoryConfig {
  const branch = opts.branch ?? DEFAULT_BRANCH;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new Error(`not a branch name: ${JSON.stringify(branch)}`);
  }
  const cadence = opts.cadence ?? "every";
  if (cadence !== "every" && (typeof cadence !== "object" || !Number.isInteger(cadence.debounce_ms) || cadence.debounce_ms <= 0)) {
    throw new Error(`cadence must be "every" or { debounce_ms: <positive integer> }`);
  }
  return { provider: "git", git_dir: DEFAULT_GIT_DIR, branch, cadence, ids_ref: IDS_REF, remote: null };
}

/** A git remote name (`git check-ref-format`'s rules, roughly): no spaces, no `..`, no leading `-`, no `/` at either end. */
export function validRemoteName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith("-") && !name.includes("..") && !name.endsWith(".lock");
}

/** The remote binding `history remote set` writes, from the verb's options (defaults: `origin`, the local branch, `off`, `off`); the URL refused when it carries credentials. */
export function remoteConfigFor(opts: GitRemoteOptions, localBranch: string): GitRemoteConfig {
  if (typeof opts.url !== "string" || opts.url.trim() === "") throw new Error("--url is required (a git URL or a local path; credentials never enter omgbase)");
  refuseCredentials(opts.url, "the remote URL");
  const name = opts.name ?? DEFAULT_REMOTE_NAME;
  if (!validRemoteName(name)) throw new Error(`not a remote name: ${JSON.stringify(name)}`);
  const branch = opts.branch ?? localBranch;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) throw new Error(`not a branch name: ${JSON.stringify(branch)}`);
  const push = opts.push ?? "off";
  if (!(PUSH_POLICIES as readonly string[]).includes(push)) throw new Error(`--push must be one of ${PUSH_POLICIES.join("|")} (got ${JSON.stringify(push)})`);
  const fetch = opts.fetch ?? "off";
  if (!(FETCH_POLICIES as readonly string[]).includes(fetch)) throw new Error(`--fetch must be one of ${FETCH_POLICIES.join("|")} (got ${JSON.stringify(fetch)})`);
  return { name, url: opts.url, branch, push: push as GitPushPolicy, fetch: fetch as GitFetchPolicy };
}

/** A row's `remote` member read back: the binding when it is well-formed, else null (a row without one, or one an older engine wrote). */
export function readRemoteConfig(v: unknown): GitRemoteConfig | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Partial<GitRemoteConfig>;
  if (typeof r.name !== "string" || typeof r.url !== "string" || typeof r.branch !== "string") return null;
  return {
    name: r.name, url: r.url, branch: r.branch,
    push: (PUSH_POLICIES as readonly string[]).includes(r.push as string) ? (r.push as GitPushPolicy) : "off",
    fetch: (FETCH_POLICIES as readonly string[]).includes(r.fetch as string) ? (r.fetch as GitFetchPolicy) : "off",
  };
}

/** Parse the `--cadence every|<ms>` flag. */
export function parseCadence(raw: string): GitCadence {
  if (raw === "every") return "every";
  const ms = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`--cadence must be "every" or a positive number of milliseconds (got ${JSON.stringify(raw)})`);
  return { debounce_ms: ms };
}

/** Read a manifest row's config as the git config, defaults filled (a row written by a later 6.x may carry more keys). */
export function readGitConfig(config: HistoryProviderConfig): GitHistoryConfig {
  const c = config as Partial<GitHistoryConfig>;
  const cadence: GitCadence = c.cadence === "every" || c.cadence === undefined ? "every" : typeof c.cadence === "object" && c.cadence !== null && typeof c.cadence.debounce_ms === "number" ? { debounce_ms: c.cadence.debounce_ms } : "every";
  return {
    provider: "git",
    git_dir: typeof c.git_dir === "string" && c.git_dir !== "" ? c.git_dir : DEFAULT_GIT_DIR,
    branch: typeof c.branch === "string" && c.branch !== "" ? c.branch : DEFAULT_BRANCH,
    cadence,
    ids_ref: typeof c.ids_ref === "string" ? c.ids_ref : IDS_REF,
    remote: readRemoteConfig(c.remote),
  };
}
