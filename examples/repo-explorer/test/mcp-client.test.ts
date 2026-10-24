// The page's own slice of the client: the `/whoami` URL, the `repo` argument
// rule, `apply` over a Caller — and that the shared `OmgError` carries what the
// console reads (`code`, `data`, `retriable`, `fix`). The session, its
// recovery and the envelope are `@omgbase/client`'s and tested there.

import { describe, expect, it } from "vitest";
import { OmgError, applyArgs, applyEffects, isSessionLost, isUnknownTool, repoArg, whoamiUrl } from "../src/lib/mcp-client.ts";
import { ScriptedCaller } from "./scripted.ts";

describe("the shared client, re-exported", () => {
  it("OmgError carries code, data, retriable and the engine's fix", () => {
    const e = new OmgError("stale_plan", "moved on", { data: { fix: "{}" }, retriable: true });
    expect(e).toMatchObject({ code: "stale_plan", message: "moved on", data: { fix: "{}" }, retriable: true, fix: "{}" });
    expect(new OmgError("x", "y").retriable).toBe(false);
  });
  it("isSessionLost / isUnknownTool recognise the proxy's body and the JSON-RPC unknown-tool text", () => {
    expect(isSessionLost(new Error('Error POSTing to endpoint: {"code":-32000,"message":"unknown session"}'))).toBe(true);
    expect(isSessionLost("unknown session")).toBe(false);
    expect(isUnknownTool(new Error("MCP error -32602: unknown tool repos"))).toBe(true);
    expect(isUnknownTool(new Error("network down"))).toBe(false);
  });
});

describe("the page's helpers", () => {
  it("repoArg names a repo only when one is chosen; whoamiUrl derives /whoami on the proxy's origin", () => {
    expect(repoArg(null)).toEqual({});
    expect(repoArg("")).toEqual({});
    expect(repoArg("alchemy")).toEqual({ repo: "alchemy" });
    expect(whoamiUrl("/mcp", "http://localhost:5175/#doc=/a.md")).toBe("http://localhost:5175/whoami");
    expect(whoamiUrl("http://127.0.0.1:8789/mcp?x=1")).toBe("http://127.0.0.1:8789/whoami");
  });

  it("applyArgs / applyEffects send apply { effects, reason, repo } — a key only when it has a value", async () => {
    const effect = { op: "set", target: { kind: "block", _id: "b_1" }, field: "_attrs.checked", value: true, expect: { content_hash: "h1" } };
    expect(applyArgs([effect])).toEqual({ effects: [effect] });
    expect(applyArgs([effect], { reason: "r", repo: null })).toEqual({ effects: [effect], reason: "r" });
    expect(applyArgs([effect], { repo: "alchemy" })).toEqual({ effects: [effect], repo: "alchemy" });
    const s = new ScriptedCaller({ apply: () => ({ plan_id: "p", commit: "c_1", revisions: [], new_ids: {}, committed: true, summary: ["set"] }) });
    const receipt = await applyEffects(s, [effect], { reason: "repo-explorer task toggle" });
    expect(receipt.commit).toBe("c_1");
    expect(s.argsOf("apply")).toEqual({ effects: [effect], reason: "repo-explorer task toggle" });
  });
});
