import { describe, expect, it } from "vitest";
import { CARDS_KEY, DEFAULT_CARD, DEFAULT_CARD_SETTINGS, allCardFields, computedFields, parseCardSettings, serializeCardSettings, templateFor, valueKey, valuesPresent } from "../src/lib/cards.ts";

const P = "/terms/types/project.md";

describe("card settings", () => {
  it("parses the stored JSON, tolerating a bare template, garbage and malformed shapes; no variation by default", () => {
    expect(CARDS_KEY).toBe("omgbase-repo-explorer.cards");
    expect(parseCardSettings(null)).toEqual({ default: DEFAULT_CARD, expression: "", by: null });
    expect(DEFAULT_CARD).toBe("{card|_title}");
    expect(parseCardSettings("")).toEqual(DEFAULT_CARD_SETTINGS);
    expect(parseCardSettings("not json")).toEqual(DEFAULT_CARD_SETTINGS);
    expect(parseCardSettings("[1]")).toEqual(DEFAULT_CARD_SETTINGS);
    expect(parseCardSettings('"{_title}\\n{status}"')).toEqual({ default: "{_title}\n{status}", expression: "", by: null });
    expect(parseCardSettings(`{"default":"{title}","by":{"field":"kind","templates":{"person":"{name}","empty":"  ","bad":3}}}`)).toEqual({ default: "{title}", expression: "", by: { field: "kind", templates: { person: "{name}" } } });
    expect(parseCardSettings('{"default":"","by":{"field":"  ","templates":{"a":"{x}"}}}')).toEqual({ default: DEFAULT_CARD, expression: "", by: null });
    expect(parseCardSettings('{"default":"{t}","by":null}')).toEqual({ default: "{t}", expression: "", by: null });
  });

  it("migrates the earlier { byType } shape into a variation by `type`", () => {
    expect(parseCardSettings(`{"default":"{_display|_title}","byType":{"${P}":"{title}\\n{status}"}}`)).toEqual({ default: DEFAULT_CARD, expression: "", by: { field: "type", templates: { [P]: "{title}\n{status}" } } });
    expect(parseCardSettings('{"default":"{t}","byType":{}}')).toEqual({ default: "{t}", expression: "", by: null });
  });

  it("serialises compactly, dropping empty templates, an empty default and a blank field", () => {
    const s = serializeCardSettings({ default: " ", expression: "", by: { field: "kind", templates: { a: "{x}", b: "" } } });
    expect(JSON.parse(s)).toEqual({ default: DEFAULT_CARD, expression: "", by: { field: "kind", templates: { a: "{x}" } } });
    expect(parseCardSettings(s)).toEqual({ default: DEFAULT_CARD, expression: "", by: { field: "kind", templates: { a: "{x}" } } });
    expect(JSON.parse(serializeCardSettings({ default: "{t}", expression: "", by: { field: " ", templates: { a: "{x}" } } }))).toEqual({ default: "{t}", expression: "", by: null });
  });

  it("templateFor reads the row's discriminator field (first entry of a list, scalars stringified, dotted paths) and falls back to the default", () => {
    const s = { default: "{_title}", expression: "", by: { field: "type", templates: { [P]: "{title}\n{status}", "3": "{n}", blank: "  " } } };
    expect(templateFor(s, { type: P })).toBe("{title}\n{status}");
    expect(templateFor(s, { type: "/terms/types/person.md" })).toBe("{_title}");
    expect(templateFor(s, { type: [P, "x"] })).toBe("{title}\n{status}");
    expect(templateFor(s, { type: 3 })).toBe("{n}");
    expect(templateFor(s, { type: "blank" })).toBe("{_title}");
    expect(templateFor(s, { type: null })).toBe("{_title}");
    expect(templateFor(s, {})).toBe("{_title}");
    expect(templateFor({ default: "{_title}", expression: "", by: null }, { type: P })).toBe("{_title}");
    expect(templateFor({ default: "{_title}", expression: "", by: { field: "meta.kind", templates: { x: "{k}" } } }, { meta: { kind: "x" } })).toBe("{k}");
    expect(valueKey(["a", "b"])).toBe("a");
    expect(valueKey(true)).toBe("true");
    expect(valueKey({ a: 1 })).toBeNull();
    expect(valueKey([])).toBeNull();
  });

  it("allCardFields is the union over every template plus the discriminator, the default's fields first; nothing extra without a variation", () => {
    expect(allCardFields(DEFAULT_CARD_SETTINGS)).toEqual(["card", "_title"]);
    expect(computedFields(DEFAULT_CARD_SETTINGS)).toEqual({});
    expect(computedFields({ ...DEFAULT_CARD_SETTINGS, expression: ' _title + " · " + status ' })).toEqual({ card: '_title + " · " + status' });
    expect(parseCardSettings(serializeCardSettings({ ...DEFAULT_CARD_SETTINGS, expression: "status" }))).toEqual({ default: DEFAULT_CARD, expression: "status", by: null });
    // A default saved in the `_display` days is the current default.
    expect(parseCardSettings('{"default":"{_display|_title}","by":null}').default).toBe(DEFAULT_CARD);
    expect(allCardFields({ default: "{_display|_title}", expression: "", by: { field: "type", templates: { p: "{title}\n{status} · {_title}", q: "{owner.name}" } } })).toEqual(["_display", "_title", "type", "title", "status", "owner.name"]);
    expect(allCardFields({ default: "{type|_title}", expression: "", by: { field: "type", templates: {} } })).toEqual(["type", "_title"]);
    expect(allCardFields({ default: "{_title}", expression: "", by: { field: "  ", templates: { a: "{x}" } } })).toEqual(["_title"]);
  });

  it("valuesPresent lists the distinct values of the chosen field among rows, sorted (lists spread); nothing for an empty field", () => {
    const rows = [{ type: "/b.md" }, { type: "/a.md" }, { type: ["/c.md", "/a.md"] }, { type: "" }, { type: 3 }, { type: { x: 1 } }, {}];
    expect(valuesPresent(rows, "type")).toEqual(["/a.md", "/b.md", "/c.md", "3"]);
    expect(valuesPresent(rows, "")).toEqual([]);
    expect(valuesPresent([{ meta: { kind: "k" } }], "meta.kind")).toEqual(["k"]);
  });
});
