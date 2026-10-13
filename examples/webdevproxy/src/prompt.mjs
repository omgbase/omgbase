// The terminal's escape hatch for remote mode. Attached by bin/webdevproxy.mjs
// only when stdin is a TTY (never in CI or under the demos' scripts/dev.mjs,
// which call startProxy themselves): line-based keys over readline — no raw
// mode, so it is `a` + Enter.
//
//   a   re-open the sign-in waiting in the browser and print its URL again (for
//       a user over SSH); when none is waiting, drop the tokens (the client
//       registration stays) and start a fresh authorization
//   l   forget this server's token file (= `--logout`) and sign in fresh
//   q   close every session and exit 0
//
// The hint is printed whenever the sign-in state turns `waiting` or `error`
// (and once on attach if it already is).

import { createInterface } from "node:readline";

export const PROMPT_HINT = "press a + Enter to (re)open the sign-in in your browser, l + Enter to forget this server's tokens and sign in fresh, q + Enter to quit";

/**
 * @param {{ remote: import("./remote-auth.mjs").RemoteAuth, proxy: { close: () => Promise<void> }, input?: NodeJS.ReadableStream,
 *   log?: (m: string) => void, exit?: (code: number) => void }} opts
 * @returns {{ close: () => void }}
 */
export function startPrompt({ remote, proxy, input = process.stdin, log = (m) => console.error(`[webdevproxy] ${m}`), exit = (code) => process.exit(code) }) {
  const rl = createInterface({ input, terminal: false });
  const hint = () => log(PROMPT_HINT);
  const unsubscribe = remote.onStatus((s) => { if (s.state === "waiting" || s.state === "error") hint(); });
  if (remote.status.state === "waiting" || remote.status.state === "error") hint();
  let quitting = false;
  rl.on("line", (line) => {
    const key = line.trim().toLowerCase();
    if (!key || quitting) return;
    // RemoteAuth logs the outcome of a sign-in itself; a rejection here is already reported.
    if (key === "a") { void remote.reauthorize().catch(() => undefined); return; }
    if (key === "l") { void remote.reauthorize({ forget: true }).catch(() => undefined); return; }
    if (key === "q") {
      quitting = true;
      log("quitting");
      void proxy.close().then(() => exit(0), () => exit(0));
      return;
    }
    log(`unknown key ${JSON.stringify(key)} — ${PROMPT_HINT}`);
  });
  rl.on("close", unsubscribe);
  return { close: () => { unsubscribe(); rl.close(); } };
}
