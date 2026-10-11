import { describe, expect, it } from "vitest";
import { allowOrigin, corsHeaders, originMatches } from "../src/cors.mjs";

describe("origins", () => {
  it("matches exact origins and `*` ports", () => {
    expect(originMatches("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(originMatches("http://localhost:5173", "http://localhost:*")).toBe(true);
    expect(originMatches("http://localhost", "http://localhost:*")).toBe(true); // the default port carries no colon
    expect(originMatches("http://localhost:5173", "http://localhost:5174")).toBe(false);
    expect(originMatches("http://localhost.evil.com:5173", "http://localhost:*")).toBe(false);
    expect(originMatches("https://localhost:5173", "http://localhost:*")).toBe(false);
    expect(originMatches("http://localhost:51x3", "http://localhost:*")).toBe(false);
  });
  it("always allows loopback dev servers, adds --origin values, and answers null otherwise", () => {
    expect(allowOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(allowOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(allowOrigin("http://[::1]:4000")).toBe("http://[::1]:4000");
    expect(allowOrigin("https://app.example.com")).toBeNull();
    expect(allowOrigin("https://app.example.com", ["https://app.example.com"])).toBe("https://app.example.com");
    expect(allowOrigin("http://dev.local:3001", ["http://dev.local:*"])).toBe("http://dev.local:3001");
    expect(allowOrigin(undefined)).toBeNull(); // same-origin (via Vite) or curl: no CORS needed
  });
  it("exposes the MCP session headers", () => {
    const h = corsHeaders("http://localhost:5173");
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(h["Vary"]).toBe("Origin");
    expect(h["Access-Control-Allow-Headers"]).toMatch(/mcp-session-id/);
    expect(h["Access-Control-Expose-Headers"]).toMatch(/mcp-session-id/);
    expect(h["Access-Control-Allow-Methods"]).toBe("GET, POST, DELETE, OPTIONS");
  });
});
