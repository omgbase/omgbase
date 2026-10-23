// Feature detection over `tools/list` (spec/surface §4 "Profiles"). The demo
// is built against the MINIMAL profile — the ten tools below are everything it
// needs — and only ever treats anything else as a convenience: `repos` (a
// repository picker; without it the server's default repo is the one browsed),
// `docs_history` / `docs_diff_unified` are NOT used even when present, so the
// same code path runs under both profiles. `apply` is used for exactly one
// thing: a task checkbox toggle (and its undo), one CAS-pinned effect.

/** The ten tools of `omg mcp --tools minimal`, in the catalog's registration order. */
export const MINIMAL_TOOLS: readonly string[] = [
  "docs_read", "docs_tree", "query_syntax", "query", "blocks_resolve", "apply", "plan", "execute", "changes_since", "version",
];

export interface Capabilities {
  /** The tool names as listed; null until listed (then every feature is assumed available). */
  tools: string[] | null;
  /** Every one of the ten minimal tools is listed. */
  minimal: boolean;
  /** Minimal tools the server does NOT list (a gateway hiding some; an older server). */
  missing: string[];
  /** `repos` is listed: a repository picker can be offered. */
  repos: boolean;
  /** More than the ten: the full catalog (or part of it). */
  beyondMinimal: string[];
}

export function capabilities(tools: string[] | null): Capabilities {
  if (tools === null) return { tools: null, minimal: true, missing: [], repos: true, beyondMinimal: [] };
  const set = new Set(tools);
  const missing = MINIMAL_TOOLS.filter((t) => !set.has(t));
  return {
    tools,
    minimal: missing.length === 0,
    missing,
    repos: set.has("repos"),
    beyondMinimal: tools.filter((t) => !MINIMAL_TOOLS.includes(t)),
  };
}

/** Which feature a missing minimal tool takes with it (for the warning banner). */
export const TOOL_FEATURES: Readonly<Record<string, string>> = {
  docs_read: "the document view and time travel",
  docs_tree: "the repository tree",
  query_syntax: "the syntax drawer",
  query: "backlinks, the console, history and the deleted-documents list",
  blocks_resolve: "the search box",
  plan: "frontmatter edits (the preview)",
  execute: "frontmatter edits (the commit)",
  apply: "task checkboxes (toggle, undo); frontmatter edits preview with plan and commit with execute",
  changes_since: "the live feed",
  version: "the surface gate and the profile label",
};

/** The header's profile label: the `version` tool's `profile` when it says one,
 * else what the listing implies. */
export function profileLabel(profile: string | null, caps: Capabilities): string {
  if (profile) return profile;
  if (caps.tools === null) return "unknown profile";
  return caps.beyondMinimal.length === 0 && caps.minimal ? "minimal (by its listing)" : `${caps.tools.length} tools`;
}

/** The banner text when minimal tools are missing; null when none are. */
export function missingToolsText(caps: Capabilities): string | null {
  if (caps.missing.length === 0) return null;
  const parts = caps.missing.map((t) => `\`${t}\` (${TOOL_FEATURES[t] ?? "a feature"})`);
  return `this server does not list ${parts.join(", ")} — those features will fail`;
}
