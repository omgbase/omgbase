// The client is the shared `@omgbase/client` (its session recovery, envelope
// and errors are tested in packages/client); what this module adds is the
// three connection modes and the URL a mode uses.
import { describe, expect, it } from "vitest";
import { AuthRequiredError, OmgClient, OmgError, isSessionLost, serverUrlFor } from "../src/lib/mcp-client.ts";

describe("mcp-client", () => {
  it("re-exports the shared client's classes and predicates", () => {
    expect(typeof OmgClient).toBe("function");
    expect(new OmgError("x", "m").code).toBe("x");
    expect(new AuthRequiredError().name).toBe("AuthRequiredError");
    expect(isSessionLost(new Error("unknown session"))).toBe(true);
  });

  it("serverUrlFor: the bridge URL for the two bridge modes, the remote for direct, absolute against the page", () => {
    const base = "http://localhost:5173/";
    expect(serverUrlFor({ mode: "local", bridgeUrl: "/mcp", directUrl: "https://host/omg" }, base)).toBe("http://localhost:5173/mcp");
    expect(serverUrlFor({ mode: "proxy", bridgeUrl: "http://127.0.0.1:8787/mcp", directUrl: "https://host/omg" }, base)).toBe("http://127.0.0.1:8787/mcp");
    expect(serverUrlFor({ mode: "direct", bridgeUrl: "/mcp", directUrl: "https://host/omg" }, base)).toBe("https://host/omg");
  });
});
