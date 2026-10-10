import { describe, expect, it } from "vitest";
import { headerLabel, modeForBridge, upstreamHost } from "../src/lib/connection.ts";

const REMOTE = { mode: "remote" as const, upstream: "https://mcp.example.com/omg" };
const LOCAL = { mode: "local" as const, upstream: "omg mcp -C /tmp/ws" };

describe("modeForBridge", () => {
  it("follows the bridge: a remote upstream is proxy mode, the sample is local mode", () => {
    expect(modeForBridge("local", REMOTE)).toBe("proxy"); // the persisted `local sample` label was wrong
    expect(modeForBridge("proxy", REMOTE)).toBe("proxy");
    expect(modeForBridge("proxy", LOCAL)).toBe("local");
    expect(modeForBridge("local", LOCAL)).toBe("local");
  });

  it("never overrides the user's direct mode and changes nothing without a report", () => {
    expect(modeForBridge("direct", REMOTE)).toBe("direct");
    expect(modeForBridge("direct", LOCAL)).toBe("direct");
    expect(modeForBridge("local", null)).toBe("local");
    expect(modeForBridge("proxy", null)).toBe("proxy");
  });
});

describe("headerLabel", () => {
  it("names the upstream host behind the proxy, the sample for the local bridge, the URL for direct", () => {
    expect(headerLabel("proxy", REMOTE, "/mcp")).toBe("via local proxy → mcp.example.com");
    expect(headerLabel("local", LOCAL, "/mcp")).toBe("local sample · /mcp");
    expect(headerLabel("direct", null, "https://mcp.example.com/omg")).toBe("direct · https://mcp.example.com/omg");
  });

  it("labels by what the bridge reports, not by the stale setting", () => {
    expect(headerLabel("local", REMOTE, "/mcp")).toBe("via local proxy → mcp.example.com");
    expect(headerLabel("proxy", LOCAL, "/mcp")).toBe("local sample · /mcp");
    expect(headerLabel("proxy", null, "/mcp")).toBe("local sample · /mcp"); // no bridge answered yet
  });

  it("upstreamHost keeps a non-URL upstream as it is", () => {
    expect(upstreamHost("https://mcp.example.com:8443/omg")).toBe("mcp.example.com:8443");
    expect(upstreamHost("omg mcp -C /tmp/ws")).toBe("omg mcp -C /tmp/ws");
  });
});
