// The Monaco adapter registers the language, tokenizer and configuration.

import { describe, expect, it } from "vitest";
import { oqxMonarchGrammar } from "../src/monarch.js";
import { registerOqx, type MonacoLanguagesLike } from "../src/monaco.js";

describe("Monaco adapter", () => {
  it("registerOqx wires the three registrations", () => {
    const calls: Array<[string, unknown]> = [];
    const languages: MonacoLanguagesLike = {
      register: (l) => calls.push(["register", l]),
      setMonarchTokensProvider: (id, g) => calls.push(["tokens", [id, g]]),
      setLanguageConfiguration: (id, c) => calls.push(["config", [id, c]]),
    };
    expect(registerOqx({ languages })).toBe("oqx");
    expect(calls.map((c) => c[0])).toEqual(["register", "tokens", "config"]);
    expect(calls[0]![1]).toMatchObject({ id: "oqx", extensions: [".oqx"], mimetypes: ["text/x-oqx"] });
    expect(calls[1]![1]).toEqual(["oqx", oqxMonarchGrammar]);
    const [, config] = calls[2]![1] as [string, { wordPattern: RegExp; brackets: unknown[] }];
    expect(config.wordPattern).toBeInstanceOf(RegExp);
    expect("abc$1 x".match(config.wordPattern)).toEqual(["abc$1", "x"]);
    expect(config.brackets).toHaveLength(3);
  });

  it("the Monarch grammar has Monaco's required shape", () => {
    expect(oqxMonarchGrammar.tokenizer.root).toBeDefined();
    expect(oqxMonarchGrammar.tokenPostfix).toBe(".oqx");
    expect(oqxMonarchGrammar.ignoreCase).toBe(false);
    for (const b of oqxMonarchGrammar.brackets) expect(b.token).toMatch(/^delimiter\./);
  });
});
