// What the local bridge — the `webdevproxy` workspace package started by
// scripts/dev.mjs — says about itself on GET /whoami: which upstream it serves
// (the local sample, or a remote gateway it signed in to on the user's behalf)
// and where its sign-in stands. The page uses it to label the connection and
// to show "waiting for sign-in in your browser". The shape is the proxy's own
// (`WhoAmI` in webdevproxy's index.d.ts; a type-only import, nothing of the
// proxy reaches the browser bundle).

import type { WhoAmI } from "webdevproxy";

export type BridgeAuth = WhoAmI["auth"];
export type BridgeInfo = WhoAmI;

/** The bridge's status endpoint for an MCP endpoint URL: same origin, path `/whoami`. */
export function whoamiUrl(bridgeUrl: string, base?: string): string {
  const u = new URL(bridgeUrl, base);
  u.pathname = "/whoami";
  u.search = "";
  u.hash = "";
  return u.href;
}

export async function fetchBridgeInfo(bridgeUrl: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<BridgeInfo> {
  const res = await fetchFn(whoamiUrl(bridgeUrl, typeof location === "undefined" ? undefined : location.href), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`whoami: HTTP ${res.status}`);
  return (await res.json()) as BridgeInfo;
}
