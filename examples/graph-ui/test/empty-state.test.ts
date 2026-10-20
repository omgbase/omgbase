import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { DEFAULT_QUERY, defaultQuery } from "../src/lib/default-query.ts";
import { NAMES_4 } from "../src/lib/paths.ts";
import { emptyStateText, firstWhereText, missingPathLiterals, pathLiterals } from "../src/lib/empty-state.ts";

describe("firstWhereText", () => {
  it("quotes the top-level where clause as written", () => {
    expect(firstWhereText(DEFAULT_QUERY, parse(DEFAULT_QUERY))).toBe(`_path == "/timeline/kickoff.md"`);
    expect(firstWhereText(defaultQuery(NAMES_4), parse(defaultQuery(NAMES_4)))).toBe(`path == "/timeline/kickoff.md"`);
    const multi = `select path from docs where phase == "plan" && (owner == "/people/ada.md" || tags.contains("x"))`;
    expect(firstWhereText(multi, parse(multi))).toBe(`phase == "plan" && (owner == "/people/ada.md" || tags.contains("x"))`);
  });

  it("is null without a where clause or a parse, and survives non-BMP characters before it", () => {
    expect(firstWhereText("select path from docs", parse("select path from docs"))).toBeNull();
    expect(firstWhereText("nonsense", null)).toBeNull();
    const src = `select path, t: "😀" from docs where path == "/a.md"`;
    expect(firstWhereText(src, parse(src))).toBe(`path == "/a.md"`);
  });
});

describe("pathLiterals", () => {
  it("collects every `_path == \"…\"` literal (a 4.x query's `path ==`), either side, nested blocks included, deduped in source order", () => {
    expect(pathLiterals(parse(DEFAULT_QUERY))).toEqual(["/timeline/kickoff.md"]);
    expect(pathLiterals(parse(defaultQuery(NAMES_4)))).toEqual(["/timeline/kickoff.md"]);
    const q = parse(`select _path from docs where _path == "/a.md" || "b.md" == _path || _path == "/a.md" follow ^docs collect { where _path == "/c.md" }`);
    expect(pathLiterals(q)).toEqual(["/a.md", "b.md", "/c.md"]);
    const old = parse(`select path from docs where path == "/a.md" || "b.md" == path || path == "/a.md" follow ^docs collect { where path == "/c.md" }`);
    expect(pathLiterals(old)).toEqual(["/a.md", "b.md", "/c.md"]);
  });
  it("ignores other comparisons and other attributes", () => {
    expect(pathLiterals(parse(`select _path from docs where _path != "/a.md" && _path.startsWith("/t/") && _dst_path == "/x.md" && owner == "/p.md"`))).toEqual([]);
    expect(pathLiterals(parse(`select path from docs where path != "/a.md" && path.startsWith("/t/") && dst_path == "/x.md" && owner == "/p.md"`))).toEqual([]);
    expect(pathLiterals(null)).toEqual([]);
  });
});

describe("missingPathLiterals", () => {
  it("reports the literals the repository does not have, skipping unanswered probes, at most three", async () => {
    const asked: string[] = [];
    const exists = async (p: string): Promise<boolean | null> => {
      asked.push(p);
      if (p === "/gone.md") return false;
      if (p === "/unknown.md") return null;
      if (p === "/boom.md") throw new Error("server down");
      return true;
    };
    await expect(missingPathLiterals(["/here.md", "/gone.md", "/unknown.md"], exists)).resolves.toEqual(["/gone.md"]);
    await expect(missingPathLiterals(["/boom.md"], exists)).resolves.toEqual([]);
    asked.length = 0;
    await expect(missingPathLiterals(["/a.md", "/b.md", "/c.md", "/gone.md"], exists)).resolves.toEqual([]);
    expect(asked).toEqual(["/a.md", "/b.md", "/c.md"]);
    await expect(missingPathLiterals([], exists)).resolves.toEqual([]);
  });
});

describe("emptyStateText", () => {
  it("names the repository, and each missing path, in the panel and the footer", () => {
    const t = emptyStateText({ where: `path == "/timeline/kickoff.md"`, missing: ["/timeline/kickoff.md"] }, "notes");
    expect(t.title).toBe("the query matched nothing in repo notes");
    expect(t.details).toEqual(["/timeline/kickoff.md is not in repo notes"]);
    expect(t.footer).toBe("matched nothing — /timeline/kickoff.md is not in this repo");
  });

  it("roots a bare literal, and stays short when nothing is missing", () => {
    expect(emptyStateText({ where: `path == "timeline/kickoff.md"`, missing: ["timeline/kickoff.md"] }, "notes").details).toEqual(["/timeline/kickoff.md is not in repo notes"]);
    const t = emptyStateText({ where: `phase == "nope"`, missing: [] }, "notes");
    expect(t.details).toEqual([]);
    expect(t.footer).toBe("matched nothing");
    expect(emptyStateText({ where: null, missing: [] }, "").title).toBe("the query matched nothing");
  });
});
