// The connection's mode and label FOLLOW THE BRIDGE. The page cannot know
// whether the bridge at `/mcp` serves the local sample or proxies a remote it
// signed in to — the bridge says so on GET /whoami (`mode: "local" | "remote"`,
// lib/bridge-info.ts). A persisted `local` setting must not keep labelling a
// remote session "local sample" (observed: the header said `local sample` while
// the bridge proxied Brendan's gateway). So:
//
//   - `modeForBridge` — the settings mode the bridge's report implies: `proxy`
//     for a remote upstream, `local` for the sample; `direct` is the user's own
//     choice and is never touched; without a report the mode stays as it is;
//   - `headerLabel` — the header text: `via local proxy → <upstream host>` for a
//     remote upstream, `local sample · <bridge url>` for the sample, `direct ·
//     <server url>` for direct mode.

import type { BridgeInfo } from "./bridge-info.ts";
import type { McpMode } from "./mcp-client.ts";

export const MODE_LABEL: Record<McpMode, string> = { local: "local sample", proxy: "via local proxy", direct: "direct" };

/** The mode the bridge's self-description implies; `current` when it implies nothing. */
export function modeForBridge(current: McpMode, info: Pick<BridgeInfo, "mode"> | null): McpMode {
  if (current === "direct" || !info) return current;
  return info.mode === "remote" ? "proxy" : "local";
}

/** The host of an upstream URL (`https://mcp.example.com/omg` → `mcp.example.com`),
 * or the string itself when it is not a URL (`omg mcp -C …`). */
export function upstreamHost(upstream: string): string {
  try {
    return new URL(upstream).host;
  } catch {
    return upstream;
  }
}

/** The header's connection label (the identity and status are appended by the page). */
export function headerLabel(mode: McpMode, info: Pick<BridgeInfo, "mode" | "upstream"> | null, url: string): string {
  if (mode === "direct") return `direct · ${url}`;
  if (info?.mode === "remote") return `via local proxy → ${upstreamHost(info.upstream)}`;
  return `${MODE_LABEL.local} · ${url}`;
}
