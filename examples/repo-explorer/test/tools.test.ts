import { describe, expect, it } from "vitest";
import { MINIMAL_TOOLS, capabilities, missingToolsText, profileLabel } from "../src/lib/tools.ts";

const MINIMAL_LISTING = ["docs_read", "docs_tree", "query_syntax", "query", "blocks_resolve", "apply", "plan", "execute", "changes_since", "version"];

describe("capabilities from tools/list (spec/surface §4 Profiles)", () => {
  it("the minimal profile: exactly the ten, no repos picker", () => {
    expect([...MINIMAL_TOOLS].sort()).toEqual([...MINIMAL_LISTING].sort());
    const c = capabilities(MINIMAL_LISTING);
    expect(c).toMatchObject({ minimal: true, missing: [], repos: false, beyondMinimal: [] });
    expect(missingToolsText(c)).toBeNull();
    expect(profileLabel("minimal", c)).toBe("minimal");
    expect(profileLabel(null, c)).toBe("minimal (by its listing)");
  });
  it("the full catalog: minimal is satisfied, repos is offered, the rest is noted", () => {
    const c = capabilities([...MINIMAL_LISTING, "repos", "docs_history", "docs_diff_unified", "docs_set_meta"]);
    expect(c.minimal).toBe(true);
    expect(c.repos).toBe(true);
    expect(c.beyondMinimal).toEqual(["repos", "docs_history", "docs_diff_unified", "docs_set_meta"]);
    expect(profileLabel("full", c)).toBe("full");
    expect(profileLabel(null, c)).toBe("14 tools");
  });
  it("a gateway hiding minimal tools: named with the feature each takes away", () => {
    const c = capabilities(["docs_read", "query", "version"]);
    expect(c.minimal).toBe(false);
    expect(c.missing).toEqual(["docs_tree", "query_syntax", "blocks_resolve", "apply", "plan", "execute", "changes_since"]);
    expect(missingToolsText(c)).toMatch(/does not list `docs_tree` \(the repository tree\), `query_syntax`/);
  });
  it("before the listing arrives everything is assumed", () => {
    const c = capabilities(null);
    expect(c).toMatchObject({ tools: null, minimal: true, repos: true });
    expect(profileLabel(null, c)).toBe("unknown profile");
  });
});
