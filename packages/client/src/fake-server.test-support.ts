// A fake omgbase MCP server for the tests: the ten minimal tools (plus `echo`
// under `full`) with the real envelope — `{ content: [{ type: "text", text:
// <JSON> }], isError? }`, errors `{ error, message, data?, retriable }` with a
// `fix` where the engine gives one — over the SDK's in-memory transport pair.
// One tiny repository: documents with frontmatter, a revision and task blocks
// with hashes, so `apply`'s guards (`expect.content_hash`, `expect.revision`)
// can be stale for real. A `lost` switch makes the next POST fail the way a
// proxy that forgot the session does (the SDK's 404), so recovery is testable.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MINIMAL_TOOLS } from "./client.js";

export interface FakeBlock {
  _id: string;
  _hash: string;
  markdown: string;
  checked: boolean | null;
}

export interface FakeDoc {
  _id: string;
  _path: string;
  rev: string;
  frontmatter: Record<string, unknown>;
  blocks: FakeBlock[];
}

export interface Commit {
  commit: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  batch_id: string;
  revisions: { _id: string; _path: string; _hash: string }[];
}

export interface FakeOptions {
  profile?: "full" | "minimal";
  /** The tool names to list (default: the profile's). */
  tools?: string[];
  /** Known repo slugs (default `["notes"]`). */
  repos?: string[];
  /** Script `query` yourself; return undefined to fall back to the built-in (block hash lookups). */
  onQuery?: (args: Record<string, unknown>) => unknown;
}

/** What the proxy's 404 looks like once the SDK has wrapped it. */
export class FakeStreamableHTTPError extends Error {
  constructor(readonly code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
  }
}
export const UNKNOWN_SESSION = new FakeStreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"unknown session (expired or the proxy restarted) — send initialize again"},"id":null}');

class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown, readonly retriable = false) {
    super(message);
  }
}

/** A transport over the in-memory pair that forgets the session on demand. */
class LossyTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: unknown) => void;
  sessionId?: string;
  closed = false;

  constructor(private readonly inner: InMemoryTransport, private readonly state: { lost: boolean }, readonly log: string[]) {}

  async start(): Promise<void> {
    this.inner.onmessage = (m, extra) => this.onmessage?.(m, extra);
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e) => this.onerror?.(e);
    await this.inner.start();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.inner.close();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const m = message as { method?: string };
    if (m.method) this.log.push(m.method);
    if (m.method === "initialize") this.state.lost = false;
    else if (this.state.lost) throw UNKNOWN_SESSION;
    await this.inner.send(message);
  }
}

export class FakeServer {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly state = { lost: false };
  readonly transports: LossyTransport[] = [];
  /** Every JSON-RPC method sent over every session, in order. */
  readonly wire: string[] = [];
  readonly docs = new Map<string, FakeDoc>();
  readonly commits: Commit[] = [];
  readonly plans = new Map<string, Record<string, unknown>>();
  versionCalls = 0;
  private n = 0;
  readonly profile: "full" | "minimal";
  readonly tools: string[];
  readonly repos: string[];

  constructor(readonly opts: FakeOptions = {}) {
    this.profile = opts.profile ?? "minimal";
    this.tools = opts.tools ?? (this.profile === "minimal" ? [...MINIMAL_TOOLS] : [...MINIMAL_TOOLS, "echo", "docs_list"]);
    this.repos = opts.repos ?? ["notes"];
    this.seed();
  }

  /** `OmgClient`'s `transportFactory`: every call is a fresh session against this server. */
  readonly transportFactory = (): Transport => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fake-omgbase", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.map((name) => ({ name, inputSchema: { type: "object" as const } })) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      if (!this.tools.includes(name)) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
      this.calls.push({ name, args });
      try {
        const body = this.dispatch(name, args);
        return { content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body) }] };
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        const envelope = { error: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}), retriable: e.retriable };
        return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
      }
    });
    void server.connect(serverSide);
    const t = new LossyTransport(clientSide, this.state, this.wire);
    this.transports.push(t);
    return t;
  };

  get sessions(): number {
    return this.transports.length;
  }

  doc(path: string): FakeDoc {
    const d = this.docs.get(path);
    if (!d) throw new Error(`fake: no doc ${path}`);
    return d;
  }

  block(id: string): { doc: FakeDoc; block: FakeBlock } {
    for (const doc of this.docs.values()) for (const block of doc.blocks) if (block._id === id) return { doc, block };
    throw new ToolError("block_missing", `no block with id ${JSON.stringify(id)}`, { _id: id });
  }

  /** An edit "someone else" made: a new block hash and document revision. */
  touchBlock(id: string, markdown?: string): void {
    const { doc, block } = this.block(id);
    if (markdown !== undefined) block.markdown = markdown;
    block._hash = this.hash();
    doc.rev = this.rev();
  }

  private seed(): void {
    this.docs.set("/plans/today.md", {
      _id: "d_1", _path: "/plans/today.md", rev: "r_1", frontmatter: { title: "Today", status: "open", tags: ["a"] },
      blocks: [
        { _id: "b_1", _hash: "h_1", markdown: "- [ ] write the client", checked: false },
        { _id: "b_2", _hash: "h_2", markdown: "- [x] read the brief", checked: true },
      ],
    });
    this.docs.set("/plans/later.md", { _id: "d_2", _path: "/plans/later.md", rev: "r_2", frontmatter: { title: "Later" }, blocks: [{ _id: "b_3", _hash: "h_3", markdown: "Soon.", checked: null }] });
  }

  private hash(): string {
    return `h_${++this.n + 100}`;
  }

  private rev(): string {
    return `r_${++this.n + 100}`;
  }

  private repoScope(args: Record<string, unknown>): void {
    if (args.repo !== undefined && !this.repos.includes(args.repo as string)) throw new ToolError("repo_not_found", `no repo '${String(args.repo)}' in this workspace`, { repo: args.repo });
  }

  private locate(args: Record<string, unknown>): FakeDoc {
    const id = args._id as string | undefined;
    const path = args._path as string | undefined;
    if (id === undefined && path === undefined) throw new ToolError("filter_invalid", "pass _id or _path", { reason: "pass _id or _path", hint: "arguments" });
    for (const d of this.docs.values()) if ((id !== undefined && d._id === id) || (path !== undefined && d._path === path)) return d;
    throw new ToolError("doc_missing", `no document with _id or _path ${JSON.stringify(id ?? path)}`, { ...(id !== undefined ? { _id: id } : {}), ...(path !== undefined ? { _path: path } : {}) });
  }

  private raw(doc: FakeDoc): string {
    return `---\n${Object.entries(doc.frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${doc.blocks.map((b) => b.markdown).join("\n\n")}\n`;
  }

  private dispatch(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "version":
        this.versionCalls++;
        return { engine: "fake", version: "0.0.0", components: { "@omgbase/core": "0.29.2" }, specs: { surface: "5.1", oqx: "0.28" }, schema: 16, mcp: { protocol: "2025-06-18" }, runtime: "node", commit: null, built: null, profile: this.profile };
      case "echo":
        return args.text as string; // a non-JSON text body
      case "query_syntax":
        if (args.section === undefined) return { syntax: "card", sections: ["sugar", "follow"] };
        if (args.section === "follow" || args.section === "all") return { section: args.section, syntax: `# ${String(args.section)}` };
        throw new ToolError("filter_invalid", `unknown section \`${String(args.section)}\`; the sections are sugar, follow, all`, { reason: "unknown section", hint: "arguments", fix: JSON.stringify({ section: "all" }) });
      case "query":
        return this.query(args);
      case "docs_read": {
        this.repoScope(args);
        const doc = this.locate(args);
        if (args.at !== undefined) return { _id: doc._id, _path: doc._path, rev: args.at, _raw: this.raw(doc), renderedHashMatch: true };
        const res: Record<string, unknown> = { _id: doc._id, _path: doc._path, rev: doc.rev, properties: { frontmatter: { ...doc.frontmatter }, inline: {}, computed: { $title: doc.frontmatter.title } }, _raw: this.raw(doc) };
        if (args.include_ids) {
          res.ids = doc.blocks.map((b) => b._id);
          res.hashes = Object.fromEntries(doc.blocks.map((b) => [b._id, b._hash]));
          res.parents = Object.fromEntries(doc.blocks.map((b) => [b._id, null]));
        }
        return res;
      }
      case "docs_tree":
        this.repoScope(args);
        return { prefix: args.path ?? "/", depth: args.depth ?? 1, total: { docs: this.docs.size, blocks: 3 }, files_here: 0, entries: [{ _path: "/plans/", docs: 2, blocks: 3 }], truncated: false, cursor: null };
      case "blocks_resolve":
        this.repoScope(args);
        return [{ _id: "b_1", locator: "/plans/today.md#task[0]", preview: "write the client", evidence: { fts: 1 } }].slice(0, (args.limit as number | undefined) ?? 10);
      case "changes_since": {
        this.repoScope(args);
        const cursor = (args.cursor as number | undefined) ?? 0;
        const limit = (args.limit as number | undefined) ?? 50;
        const after = this.commits.filter((c) => c.seq > cursor && (args.origin === undefined || c.origin === args.origin));
        const page = after.slice(0, limit);
        return { digests: page, cursor: page.length ? page[page.length - 1]!.seq : cursor, epoch: "ep_fake", oldest: this.commits.length ? 1 : 0, truncated: after.length > limit, head: this.commits.length ? this.commits[this.commits.length - 1]!.seq : 0 };
      }
      case "apply":
        this.repoScope(args);
        return this.apply(args.effects as Record<string, unknown>[], (args.reason as string | undefined) ?? null);
      case "plan": {
        this.repoScope(args);
        const planId = `p_${++this.n}`;
        const plan = { plan_id: planId, version: 1, planner_v: "p3", effects: args.effects, opset: {}, preconditions: { docs: [], blocks: [], parents: [], absent_paths: [] }, new_ids: [], diagnostics: [], preview: { results: [], revisions: [], summary: ["fake"], ...(args.diffs === true ? { diffs: {} } : {}) } };
        this.plans.set(planId, plan);
        return plan;
      }
      case "execute": {
        this.repoScope(args);
        const idForm = args.plan_id !== undefined && args.effects === undefined && args.plan === undefined;
        if (idForm) {
          const plan = this.plans.get(args.plan_id as string);
          if (!plan) throw new ToolError("plan_unknown", `this server has no plan ${String(args.plan_id)} — re-run plan, or pass the plan (or \`plan_id\` + \`effects\`) with execute`, { plan_id: args.plan_id }, true);
          return this.apply(plan.effects as Record<string, unknown>[], (args.reason as string | undefined) ?? null);
        }
        if (args.plan !== undefined) return this.apply((args.plan as { effects: Record<string, unknown>[] }).effects, null);
        if (args.plan_id === undefined || args.effects === undefined) throw new ToolError("filter_invalid", "the digest form needs both `plan_id` and `effects`", { reason: "digest form", hint: "arguments" });
        return this.apply(args.effects as Record<string, unknown>[], null);
      }
      default:
        throw new ToolError("repo_not_found", `fake: ${name} not implemented`);
    }
  }

  private query(args: Record<string, unknown>): unknown {
    this.repoScope(args);
    const scripted = this.opts.onQuery?.(args);
    if (scripted !== undefined) return scripted;
    const q = args.query as string;
    const m = /^blocks \{ select _hash where _id == "([^"]+)" \}$/.exec(q);
    if (m) {
      const hit = [...this.docs.values()].flatMap((d) => d.blocks.filter((b) => b._id === m[1]).map((b) => ({ _id: b._id, _path: d._path, _hash: b._hash })));
      return { hits: hit, truncated: false, cursor: null, consumer: "collect" };
    }
    if (/\bsemantic\(/.test(q)) throw new ToolError("provider_unavailable", "semantic(...) needs an embedding provider; none is configured", { provider: null });
    if (/^docs count/.test(q)) return { hits: [], truncated: false, cursor: null, consumer: "count", count: this.docs.size };
    if (/^nope/.test(q)) throw new ToolError("filter_invalid", "unexpected 'nope' — expected docs, blocks, nodes or links (at offset 0)", { reason: "parse", hint: "query", fix: JSON.stringify({ query: "docs { select _path }" }) });
    return { hits: [...this.docs.values()].map((d) => ({ _id: d._id, _path: d._path })), truncated: false, cursor: null, consumer: "collect" };
  }

  private apply(effects: Record<string, unknown>[], reason: string | null): unknown {
    // Validate every guard first (one transaction), then write.
    const writes: (() => void)[] = [];
    const touched = new Map<string, FakeDoc>();
    effects.forEach((effect, i) => {
      const op = effect.op;
      if (op !== "set" && op !== "unset") throw new ToolError("filter_invalid", `effects[${i}]: fake supports set/unset only`, { reason: "unsupported", hint: "arguments" });
      const target = effect.target as string | Record<string, string>;
      const field = effect.field as string;
      const expect = (effect.expect ?? {}) as { content_hash?: string; revision?: string };
      if (typeof target === "object" && target.kind === "block") {
        const { doc, block } = this.block(target._id!);
        if (field !== "_attrs.checked" && field !== "markdown") throw new ToolError("filter_invalid", `effects[${i}]: a block's \`field\` is \`markdown\` or \`_attrs.checked\` (got ${field})`, { reason: "field", hint: "arguments" });
        if (expect.content_hash !== undefined && expect.content_hash !== block._hash) {
          throw new ToolError("stale_expectation", `block ${block._id} changed: expected ${expect.content_hash}, found ${block._hash}`, { effect_index: i, expected_content_hash: expect.content_hash, current: { _hash: block._hash, markdown: block.markdown }, retriable: false });
        }
        writes.push(() => {
          if (field === "_attrs.checked") {
            block.checked = effect.value as boolean;
            block.markdown = block.markdown.replace(/^- \[[ x]\]/, block.checked ? "- [x]" : "- [ ]");
          } else block.markdown = effect.value as string;
          block._hash = this.hash();
        });
        touched.set(doc._id, doc);
        return;
      }
      const doc = typeof target === "string" ? this.locate({ _path: target }) : this.locate(target);
      if (expect.revision !== undefined && expect.revision !== doc.rev) {
        const fixed = { effects: effects.map((e, j) => (j === i ? { ...e, expect: { ...expect, revision: doc.rev } } : e)) };
        throw new ToolError("stale_plan", `document ${doc._id} is at revision ${doc.rev}, not ${expect.revision}; re-plan`, { effect_index: i, doc: doc._id, expected_revision: expect.revision, current: { revision: doc.rev, _hash: "x" }, fix: JSON.stringify(fixed), retriable: true }, true);
      }
      const m = /^_frontmatter\.(.+)$/.exec(field);
      if (!m) throw new ToolError("filter_invalid", `effects[${i}]: a document's \`field\` is \`_frontmatter.<key>\` or \`content\` (got ${field})`, { reason: "field", hint: "arguments" });
      writes.push(() => {
        if (op === "set") doc.frontmatter[m[1]!] = effect.value;
        else delete doc.frontmatter[m[1]!];
      });
      touched.set(doc._id, doc);
    });
    for (const w of writes) w();
    const revisions = [...touched.values()].map((d) => { d.rev = this.rev(); return { _id: d._id, _path: d._path, _hash: this.hash() }; });
    const id = `c_${++this.n}`;
    const commit = { commit: id, seq: this.commits.length + 1, ts: new Date(0).toISOString(), origin: "api", actor: "agent:mcp", batch_id: id, summary: reason ?? "", revisions };
    this.commits.push(commit);
    return { plan_id: `p_${this.n}`, commit: commit.commit, revisions, new_ids: {}, committed: true, summary: effects.map((e) => `${String(e.op)} ${String(e.field ?? "")}`.trim()) };
  }
}
