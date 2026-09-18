import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectHttpEngine, type McpEngineClient } from "./mcp-engine-client.js";

// connectHttpEngine (client Streamable-HTTP transport). Stands up a real MCP
// server over HTTP mounted at an arbitrary secret-prefixed base path, then
// proves the client (a) reaches it through that full path and (b) forwards
// custom `-H` headers on every request.

describe("connectHttpEngine (Streamable HTTP)", () => {
  let http: Server;
  let baseUrl: string;
  let engine: McpEngineClient | null = null;
  const seenAuth: (string | undefined)[] = [];

  beforeEach(async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    // Echoes back the custom header the request carried, so the client can
    // assert its `-H` value survived the round-trip.
    server.registerTool(
      "whoami",
      { description: "echo the request's X-Test header", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ seen: seenAuth.at(-1) ?? null }) }] }),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // Cast past the SDK's exactOptionalPropertyTypes friction (onclose etc.).
    await server.connect(transport as unknown as Transport);

    http = createServer((req, res) => {
      seenAuth.push(typeof req.headers["x-test"] === "string" ? (req.headers["x-test"] as string) : undefined);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? (JSON.parse(raw) as unknown) : undefined;
        void transport.handleRequest(req, res, body);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    // Arbitrary secret-prefixed base path — the whole URL must be used verbatim.
    baseUrl = `http://127.0.0.1:${port}/k/biguglysecret/mcp`;
  });

  afterEach(async () => {
    await engine?.close();
    engine = null;
    await new Promise<void>((resolve) => http.close(() => resolve()));
    seenAuth.length = 0;
  });

  it("connects through the secret base path and forwards -H headers", async () => {
    engine = await connectHttpEngine({ url: baseUrl, headers: { "X-Test": "hi" } });
    const res = await engine.callTool<{ seen: string | null }>("whoami", {});
    expect(res.seen).toBe("hi");
    // Every request the client made carried the custom header (initialize + call).
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((h) => h === "hi")).toBe(true);
  });

  it("connects with no extra headers", async () => {
    engine = await connectHttpEngine({ url: baseUrl });
    const res = await engine.callTool<{ seen: string | null }>("whoami", {});
    expect(res.seen).toBeNull();
  });
});
