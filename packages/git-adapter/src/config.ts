import type { HistoryProviderConfig } from "@omgbase/core";

// The git provider's manifest config (spec/store §3.1 `capabilities.config`,
// §5.12): what `history enable --provider git` writes and every later call
// reads. Pinned keys and defaults; `remote` is null in 6a (6b wires it) and the
// per-document id-map ref `ids_ref` is RESERVED — named here and in the spec,
// nothing is written to it yet.

export const GIT_PROVIDER = "git";
export const DEFAULT_GIT_DIR = ".omgbase/git";
export const DEFAULT_BRANCH = "omgbase";
export const IDS_REF = "refs/omgbase/ids";

export type GitCadence = "every" | { debounce_ms: number };

export interface GitRemoteConfig {
  name: string;
  branch: string;
  push: "off" | "on-checkpoint" | "periodic";
  fetch: "off" | "periodic" | "webhook";
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
    remote: c.remote ?? null,
  };
}
