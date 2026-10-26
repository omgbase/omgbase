import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  AuthRequiredError, MINIMAL_TOOLS, OmgClient, OmgError, classifyError, isAuthRequired, isRepoNotFound, isSessionLost, isStale, isUnknownTool,
} from "./client.js";
import { setBlockAttr, setFrontmatter } from "./effects.js";
import { FakeServer, FakeStreamableHTTPError, UNKNOWN_SESSION, type FakeOptions } from "./fake-server.test-support.js";

function harness(opts: FakeOptions & { repo?: string; onSessionLost?: (e: Error) => void } = {}) {
  const { repo, onSessionLost, ...fake } = opts;
  const server = new FakeServer(fake);
  const lost: string[] = [];
  const client = new OmgClient({
    url: "/mcp",
    transportFactory: server.transportFactory,
    ...(repo !== undefined ? { repo } : {}),
    onSessionLost: onSessionLost ?? ((e) => lost.push(e.message)),
  });
  return { server, client, lost, last: () => server.calls[server.calls.length - 1]! };
}

describe("envelope", () => {
  it("decodes the JSON text body, hands a non-JSON body through as text", async () => {
    const h = harness({ profile: "full" });
    const v = await h.client.version();
    expect(v.profile).toBe("full");
    expect(v.specs.surface).toBe("5.1");
    expect(await h.client.call("echo", { text: "plain words" })).toBe("plain words");
  });

  it("an isError result is an OmgError with code, data, retriable, tool and fix", async () => {
    const h = harness();
    const err = await h.client.apply({ effects: [setFrontmatter("/plans/today.md", "status", "done", { revision: "r_0" })] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OmgError);
    const e = err as OmgError;
    expect(e.code).toBe("stale_plan");
    expect(e.message).toBe("document d_1 is at revision r_1, not r_0; re-plan");
    expect(e.retriable).toBe(true);
    expect(e.tool).toBe("apply");
    expect((e.data as { current: { revision: string } }).current.revision).toBe("r_1");
    expect(e.fix).toBe(JSON.stringify({ effects: [{ op: "set", target: { kind: "document", _path: "/plans/today.md" }, field: "_frontmatter.status", value: "done", expect: { revision: "r_1" } }] }));
    expect(isStale(e)).toBe(true);
    expect(classifyError(e)).toBe("stale");
    // Nothing was written.
    expect((await h.client.docsRead({ _path: "/plans/today.md" })).properties.frontmatter.status).toBe("open");
  });

  it("an error without a fix has fix null; the body text is the message when the body is not JSON", async () => {
    const h = harness();
    const e = (await h.client.docsRead({ _path: "/nope.md" }).catch((x: unknown) => x)) as OmgError;
    expect(e.code).toBe("doc_missing");
    expect(e.fix).toBeNull();
    expect(e.data).toEqual({ _path: "/nope.md" });
    expect(e.retriable).toBe(false);
  });
});

describe("session", () => {
  it("connect() opens the session once; close() drops it; calls reopen on demand", async () => {
    const h = harness();
    expect(h.client.connected).toBe(false);
    await h.client.connect();
    await h.client.connect();
    expect(h.client.connected).toBe(true);
    expect(h.server.sessions).toBe(1);
    await h.client.close();
    expect(h.client.connected).toBe(false);
    await h.client.version();
    expect(h.server.sessions).toBe(2);
  });

  it("re-initializes against the same URL and retries the call once when the session is gone", async () => {
    const h = harness();
    await h.client.version();
    expect(h.server.sessions).toBe(1);
    h.server.state.lost = true;
    const v = await h.client.version();
    expect(v.engine).toBe("fake");
    expect(h.server.sessions).toBe(2);
    expect(h.server.transports[0]!.closed).toBe(true);
    expect(h.client.recoveries).toBe(1);
    expect(h.lost).toEqual([UNKNOWN_SESSION.message]);
    // The fresh session serves what follows without another handshake.
    await h.client.version();
    expect(h.server.sessions).toBe(2);
    expect(h.server.wire.filter((m) => m === "initialize")).toHaveLength(2);
  });

  it("shares one reconnect among concurrent failures and gives up after the second loss", async () => {
    const h = harness();
    await h.client.version();
    h.server.state.lost = true;
    const [a, b, tools] = await Promise.all([h.client.version(), h.client.docsTree(), h.client.tools()]);
    expect(a.engine).toBe("fake");
    expect(b.prefix).toBe("/");
    expect(tools).toEqual([...MINIMAL_TOOLS]);
    expect(h.server.sessions).toBe(2);
    expect(h.client.recoveries).toBe(1);

    // Lost, and the fresh session is forgotten again right after initialize.
    const t2 = h.server.transports[1]!;
    const sendOrig = t2.send.bind(t2);
    h.server.state.lost = true;
    let armed = false;
    const factory = h.server.transportFactory;
    (h.client.options as { transportFactory?: typeof factory }).transportFactory = () => {
      const t = factory();
      const inner = t.send.bind(t);
      t.send = async (m) => {
        if ((m as { method?: string }).method === "tools/call" && armed) throw UNKNOWN_SESSION;
        return inner(m);
      };
      armed = true;
      return t;
    };
    void sendOrig;
    await expect(h.client.version()).rejects.toThrow(/unknown session/);
    expect(h.client.recoveries).toBe(2);
  });

  it("a tool error is not a lost session: no reconnect", async () => {
    const h = harness();
    await expect(h.client.query("nope")).rejects.toBeInstanceOf(OmgError);
    expect(h.server.sessions).toBe(1);
    expect(h.client.recoveries).toBe(0);
  });
});

describe("capabilities", () => {
  it("minimal: the ten tools, canWrite and canPlan; cached per session", async () => {
    const h = harness();
    const c = await h.client.capabilities();
    expect(c).toEqual({ engine: "fake", version: "0.0.0", surface: "5.1", profile: "minimal", tools: [...MINIMAL_TOOLS], minimal: true, canWrite: true, canPlan: true });
    await h.client.capabilities();
    expect(h.server.versionCalls).toBe(1);
    expect(h.server.wire.filter((m) => m === "tools/list")).toHaveLength(1);
    // A recovered session asks again.
    h.server.state.lost = true;
    await h.client.version();
    await h.client.capabilities();
    expect(h.server.versionCalls).toBe(3);
  });

  it("full: more tools listed, minimal false", async () => {
    const h = harness({ profile: "full" });
    const c = await h.client.capabilities();
    expect(c.minimal).toBe(false);
    expect(c.profile).toBe("full");
    expect(c.tools).toContain("docs_list");
  });

  it("a read-only gateway: no apply → canWrite false; no execute → canPlan false", async () => {
    const h = harness({ tools: ["query", "docs_read", "version", "plan"] });
    const c = await h.client.capabilities();
    expect(c.canWrite).toBe(false);
    expect(c.canPlan).toBe(false);
  });
});

describe("the default repo", () => {
  it("is added to every repo-scoped call, never to version/query_syntax, and a call's own repo (or null) wins", async () => {
    const h = harness({ repo: "notes", repos: ["notes", "work"] });
    await h.client.query("docs { select _path }");
    expect(h.last().args).toEqual({ query: "docs { select _path }", repo: "notes" });
    await h.client.query("docs { select _path }", { repo: "work" });
    expect(h.last().args.repo).toBe("work");
    await h.client.query("docs { select _path }", { repo: null });
    expect(h.last().args).toEqual({ query: "docs { select _path }" });
    await h.client.version();
    expect(h.last().args).toEqual({});
    await h.client.querySyntax();
    expect(h.last().args).toEqual({});
    await h.client.call("docs_tree", {});
    expect(h.last().args).toEqual({ repo: "notes" });
    await h.client.call("docs_tree", { repo: undefined });
    expect(h.last().args).toEqual({ repo: "notes" });
  });

  it("no default: the argument is omitted (the server's default repo)", async () => {
    const h = harness();
    await h.client.docsTree();
    expect(h.last().args).toEqual({});
  });

  it("an unknown slug is repo_not_found", async () => {
    const h = harness({ repo: "elsewhere" });
    const e = await h.client.docsTree().catch((x: unknown) => x);
    expect(isRepoNotFound(e)).toBe(true);
    expect(classifyError(e)).toBe("capability");
    expect((e as OmgError).data).toEqual({ repo: "elsewhere" });
  });
});

describe("typed methods send exactly the wire arguments", () => {
  it("query / queryAll", async () => {
    const h = harness();
    const r = await h.client.query("docs { select _path }", { limit: 5, cursor: "c1", bare: true });
    expect(h.last().args).toEqual({ query: "docs { select _path }", limit: 5, cursor: "c1", bare: true });
    expect(r.consumer).toBe("collect");
    expect(r.hits.map((x) => x._path)).toEqual(["/plans/today.md", "/plans/later.md"]);
    const count = await h.client.query("docs count { }");
    expect(count.consumer === "count" && count.count).toBe(2);

    // queryAll follows the cursor and honours max.
    const pages: Record<string, unknown>[] = [];
    const paged = harness({
      onQuery: (args) => {
        pages.push(args);
        const page = args.cursor === undefined ? 0 : Number(args.cursor);
        const hits = Array.from({ length: Number(args.limit) }, (_, i) => ({ _id: `d_${page}_${i}`, _path: `/p${page}/${i}.md` }));
        return { hits, truncated: page < 2, cursor: String(page + 1), consumer: "collect" };
      },
    });
    const all = await paged.client.queryAll("docs { }", { max: 7, pageSize: 3 });
    expect(all).toHaveLength(7);
    expect(pages.map((p) => [p.limit, p.cursor])).toEqual([[3, undefined], [3, "1"], [1, "2"]]);
  });

  it("query_syntax", async () => {
    const h = harness();
    expect(await h.client.querySyntax()).toEqual({ syntax: "card", sections: ["sugar", "follow"] });
    expect(await h.client.querySyntax("follow")).toEqual({ section: "follow", syntax: "# follow" });
    expect(h.last().args).toEqual({ section: "follow" });
    const e = (await h.client.querySyntax("folow").catch((x: unknown) => x)) as OmgError;
    expect(e.code).toBe("filter_invalid");
    expect(e.fix).toBe('{"section":"all"}');
  });

  it("docs_read / docs_read at", async () => {
    const h = harness();
    const d = await h.client.docsRead({ _path: "/plans/today.md" }, { includeIds: true });
    expect(h.last().args).toEqual({ _path: "/plans/today.md", include_ids: true });
    expect(d.rev).toBe("r_1");
    expect(d.ids).toEqual(["b_1", "b_2"]);
    expect(d.hashes).toEqual({ b_1: "h_1", b_2: "h_2" });
    expect(d.parents).toEqual({ b_1: null, b_2: null });
    expect(d.properties.frontmatter).toEqual({ title: "Today", status: "open", tags: ["a"] });
    await h.client.docsRead({ _id: "d_2" });
    expect(h.last().args).toEqual({ _id: "d_2" });
    const at = await h.client.docsReadAt({ _id: "d_1" }, "r_1");
    expect(h.last().args).toEqual({ _id: "d_1", at: "r_1" });
    expect(at.renderedHashMatch).toBe(true);
    expect(at._raw.startsWith("---\n")).toBe(true);
  });

  it("docs_tree", async () => {
    const h = harness();
    await h.client.docsTree({ path: "/plans/", depth: 2, files: true, updated: true, limit: 10, cursor: "k", budgetTokens: 500 });
    expect(h.last().args).toEqual({ path: "/plans/", depth: 2, files: true, updated: true, limit: 10, cursor: "k", budget_tokens: 500 });
    const t = await h.client.docsTree();
    expect(h.last().args).toEqual({});
    expect(t.entries[0]!._path).toBe("/plans/");
  });

  it("blocks_resolve returns the bare array", async () => {
    const h = harness();
    const hits = await h.client.blocksResolve("client", { limit: 3 });
    expect(h.last().args).toEqual({ query: "client", limit: 3 });
    expect(Array.isArray(hits)).toBe(true);
    expect(hits[0]).toEqual({ _id: "b_1", locator: "/plans/today.md#task[0]", preview: "write the client", evidence: { fts: 1 } });
  });

  it("changes_since", async () => {
    const h = harness();
    const empty = await h.client.changesSince();
    expect(h.last().args).toEqual({});
    expect(empty).toEqual({ digests: [], cursor: 0, epoch: "ep_fake", oldest: 0, truncated: false, head: 0 });
    await h.client.apply({ effects: [setFrontmatter("/plans/today.md", "status", "done")], reason: "finish" });
    await h.client.apply({ effects: [setFrontmatter("/plans/later.md", "status", "soon")] });
    const page = await h.client.changesSince({ cursor: 0, limit: 1, origin: "api" });
    expect(h.last().args).toEqual({ cursor: 0, limit: 1, origin: "api" });
    expect(page.digests).toHaveLength(1);
    expect(page.digests[0]!.summary).toBe("finish");
    expect(page.digests[0]!.revisions[0]!._path).toBe("/plans/today.md");
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBe(1);
    expect(page.head).toBe(2);
    const rest = await h.client.changesSince({ cursor: page.cursor });
    expect(rest.digests).toHaveLength(1);
    expect(rest.cursor).toBe(rest.head);
  });

  it("apply / plan / execute (three forms)", async () => {
    const h = harness();
    const effects = [setBlockAttr("b_1", "checked", true, { contentHash: "h_1" })];
    const receipt = await h.client.apply({ effects, reason: "done" });
    expect(h.last().args).toEqual({ effects, reason: "done" });
    expect(receipt.committed).toBe(true);
    expect(receipt.revisions).toEqual([{ _id: "d_1", _path: "/plans/today.md", _hash: expect.any(String) }]);
    expect(receipt.summary).toEqual(["set _attrs.checked"]);

    await h.client.apply({ effects: [{ op: "set", field: "_attrs.checked", value: true } as never], select: 'blocks { _type == "task" }', expect: { max: 10 } }).catch(() => undefined);
    expect(h.last().args).toEqual({ effects: [{ op: "set", field: "_attrs.checked", value: true }], select: 'blocks { _type == "task" }', expect: { max: 10 } });

    const fm = [setFrontmatter("/plans/today.md", "status", "done")];
    const plan = await h.client.plan({ effects: fm, diffs: true });
    expect(h.last().args).toEqual({ effects: fm, diffs: true });
    expect(plan.preview?.summary).toEqual(["fake"]);
    expect(plan.preview?.diffs).toEqual({});

    await h.client.execute({ plan_id: plan.plan_id, reason: "go" });
    expect(h.last().args).toEqual({ plan_id: plan.plan_id, reason: "go" });
    await h.client.execute({ plan_id: plan.plan_id, effects: fm, expect: { max: 1 } });
    expect(h.last().args).toEqual({ plan_id: plan.plan_id, effects: fm, expect: { max: 1 } });
    await h.client.execute({ plan });
    expect(h.last().args).toEqual({ plan });
    const unknown = (await h.client.execute({ plan_id: "0".repeat(64) }).catch((x: unknown) => x)) as OmgError;
    expect(unknown.code).toBe("plan_unknown");
    expect(unknown.retriable).toBe(true);
    expect(isStale(unknown)).toBe(true);
  });

  it("the stale-hash guard refuses a block write; the same write with the current hash commits", async () => {
    const h = harness();
    const e = (await h.client.apply({ effects: [setBlockAttr("b_1", "checked", true, { contentHash: "h_old" })] }).catch((x: unknown) => x)) as OmgError;
    expect(e.code).toBe("stale_expectation");
    expect(classifyError(e)).toBe("stale");
    expect((e.data as { current: { _hash: string } }).current._hash).toBe("h_1");
    await h.client.apply({ effects: [setBlockAttr("b_1", "checked", true, { contentHash: "h_1" })] });
    expect(h.server.block("b_1").block.checked).toBe(true);
  });
});

describe("error classification", () => {
  it("unknown tool: the McpError becomes OmgError unknown_tool → capability", async () => {
    const h = harness();
    const e = await h.client.call("docs_list", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OmgError);
    expect((e as OmgError).code).toBe("unknown_tool");
    expect((e as OmgError).tool).toBe("docs_list");
    expect(isUnknownTool(e)).toBe(true);
    expect(isUnknownTool(new McpError(-32602, "unknown tool docs_list"))).toBe(true);
    expect(classifyError(e)).toBe("capability");
    expect(classifyError(new McpError(-32602, "unknown tool x"))).toBe("capability");
  });

  it("codes by family, read-shaped codes from a write tool are write", async () => {
    const h = harness();
    const parse = await h.client.query("nope").catch((x: unknown) => x);
    expect(classifyError(parse)).toBe("query");
    expect((parse as OmgError).fix).toBe('{"query":"docs { select _path }"}');
    const semantic = await h.client.query('docs { order by semantic("x") desc }').catch((x: unknown) => x);
    expect(classifyError(semantic)).toBe("capability");
    const missingRead = await h.client.docsRead({ _path: "/gone.md" }).catch((x: unknown) => x);
    expect(classifyError(missingRead)).toBe("query");
    const missingWrite = await h.client.apply({ effects: [setFrontmatter("/gone.md", "a", 1)] }).catch((x: unknown) => x);
    expect((missingWrite as OmgError).code).toBe("doc_missing");
    expect(classifyError(missingWrite)).toBe("write");
    const badEffect = await h.client.apply({ effects: [{ op: "split", target: "b_1", at: [1] }] }).catch((x: unknown) => x);
    expect((badEffect as OmgError).code).toBe("filter_invalid");
    expect(classifyError(badEffect)).toBe("write");
    expect(classifyError(new OmgError("conflicting_effects", "x"))).toBe("write");
    expect(classifyError(new OmgError("plan_mismatch", "x"))).toBe("stale");
    expect(classifyError(new OmgError("repo_not_found", "x"))).toBe("capability");
    expect(classifyError(new OmgError("never_heard_of", "x"))).toBe("unknown");
    expect(classifyError(new OmgError("never_heard_of", "x", { tool: "apply" }))).toBe("write");
  });

  it("transport, auth, session loss, unknown", () => {
    expect(classifyError(new TypeError("fetch failed"))).toBe("transport");
    expect(classifyError(UNKNOWN_SESSION)).toBe("transport");
    expect(classifyError(new McpError(-32603, "internal"))).toBe("unknown");
    expect(classifyError("a string")).toBe("unknown");
    expect(classifyError(new AuthRequiredError())).toBe("auth");
    expect(classifyError(new UnauthorizedError("401"))).toBe("auth");
    expect(isAuthRequired(new UnauthorizedError("401"))).toBe(true);
    expect(isAuthRequired(new Error("401"))).toBe(false);
    expect(isSessionLost(UNKNOWN_SESSION)).toBe(true);
    expect(isSessionLost(new FakeStreamableHTTPError(404, "Error POSTing to endpoint (HTTP 404): Not Found"))).toBe(true);
    expect(isSessionLost(new Error('Error POSTing to endpoint: {"code":-32000,"message":"unknown session"}'))).toBe(true);
    expect(isSessionLost(new FakeStreamableHTTPError(500, "Error POSTing to endpoint: boom"))).toBe(false);
    expect(isSessionLost(new Error("network down"))).toBe(false);
    expect(isSessionLost("unknown session")).toBe(false);
  });
});
