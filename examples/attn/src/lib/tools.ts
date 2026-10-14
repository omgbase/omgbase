// Feature detection over `tools/list` (spec/surface §4 "Profiles"). attn is
// built against the MINIMAL profile — the ten tools below are everything it
// needs — and treats anything else as a convenience only: `repos` offers a
// repository picker when a full server lists it; nothing else beyond the ten
// is ever called, so the same code path runs under both profiles.
// (After examples/repo-explorer/src/lib/tools.ts.)

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
  docs_read: "the focus pointer and the stream days",
  docs_tree: "the stream's date picker",
  query_syntax: "nothing here (the cue editor links to it)",
  query: "the intents list, the virtual #focus, every cue evaluation",
  blocks_resolve: "nothing here",
  plan: "the cue editor's preview",
  execute: "the cue editor's commit",
  apply: "every focus switch, declaration, release and dismissal",
  changes_since: "staying in sync with other windows and the CLI",
  version: "the surface gate and the profile label",
};

/** The header's profile label: the `version` tool's `profile` when it says one, else what the listing implies. */
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
