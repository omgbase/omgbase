import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { pinClock } from "../core/clock.js";
import { raiseAlert } from "../core/store/alerts.js";
import { buildServer } from "./server.js";

// The alert channel on the wire (spec/surface §4 "Alerts", 6.0 — spec/store
// §3.1 `alerts`): every successful object result of every tool carries the
// call's repository's ACTIVE alerts as a top-level `alerts` member, only when
// there are any; an error envelope never does; a `repo`-scoped call carries
// that repository's. `reads::alerts` pins the backlog case end to end; this
// test pins the attachment rule itself.

const T0 = "2026-09-26T10:00:00.000Z";
const LATER = "2026-09-26T11:00:00.000Z";

let store: Store | undefined;
let client: Client | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await client?.close(); client = undefined; store?.close(); store = undefined; restore?.(); restore = undefined; });

async function serve(): Promise<{ call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: unknown }>; repoId: string; other: string }> {
  restore = pinClock(LATER);
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "fixture", null);
  const other = ensureRepo(store, "other", null);
  ingestFile(store, repoId, "a.md", "# A\n\nbody\n", { ts: T0 });
  ingestFile(store, other, "b.md", "# B\n\nbody\n", { ts: T0 });
  const server = buildServer({ store, repoId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "alerts-test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: unknown }> => {
    const r = (await client!.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) as unknown };
  };
  return { call, repoId, other };
}

describe("the alerts member", () => {
  it("is absent on a quiet repository, present (last) on every object result while an alert is active, absent on errors, scoped by repo", async () => {
    const { call, repoId, other } = await serve();
    const quiet = (await call("query", { query: "docs { select _path }" })).body as Record<string, unknown>;
    expect("alerts" in quiet).toBe(false);

    raiseAlert(store!.db, repoId, { code: "writer_refused", severity: "error", message: "m", detail: { capability: "history" } }, T0);
    const alerts = [{ code: "writer_refused", severity: "error", message: "m", since: T0, detail: { capability: "history" } }];
    for (const [tool, args] of [["query", { query: "docs { select _path }" }], ["docs_read", { _path: "/a.md" }], ["docs_tree", {}], ["version", {}], ["changes_since", {}]] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(false);
      const body = r.body as Record<string, unknown>;
      expect(body.alerts, tool).toEqual(alerts);
      expect(Object.keys(body).at(-1), tool).toBe("alerts");
    }
    // An error envelope never carries it.
    const missing = await call("docs_read", { _path: "/missing.md" });
    expect(missing.isError).toBe(true);
    expect("alerts" in (missing.body as Record<string, unknown>)).toBe(false);
    // A repo-scoped call carries THAT repository's alerts (none here); the default repo's stay on its own calls.
    const scoped = (await call("docs_read", { _path: "/b.md", repo: "other" })).body as Record<string, unknown>;
    expect("alerts" in scoped).toBe(false);
    raiseAlert(store!.db, other, { code: "materialization_failed", severity: "error", message: "n" }, T0);
    expect(((await call("docs_read", { _path: "/b.md", repo: "other" })).body as { alerts: unknown[] }).alerts).toEqual([{ code: "materialization_failed", severity: "error", message: "n", since: T0 }]);
    expect(((await call("docs_read", { _path: "/a.md" })).body as { alerts: unknown[] }).alerts).toEqual(alerts);
    // A result that is a JSON array has no member to carry.
    const many = await call("observe_many", { files: [{ path: "c.md", content: "# C\n" }] });
    expect(many.isError).toBe(false);
    expect(Array.isArray(many.body)).toBe(true);
  });
});
