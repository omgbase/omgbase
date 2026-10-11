import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { constName, rawString, render } from "./gen-tool-descriptions.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("a raw string literal grows its hash run until the text cannot close it early", () => {
  assert.equal(rawString("plain"), 'r#"plain"#');
  assert.equal(rawString('has "# inside'), 'r##"has "# inside"##');
  assert.equal(rawString('"#"##'), 'r###""#"##"###');
});

test("tool names become SCREAMING_SNAKE constants in file order", () => {
  assert.equal(constName("docs_read"), "DOCS_READ");
  const text = render({ docs_read: "Read.", blocks_read: "Get." });
  assert.match(text, /pub const DOCS_READ: &str = r#"Read\."#;\n\n\/\/\/ `blocks_read`\npub const BLOCKS_GET/);
});

test("the checked-in descriptions.rs is generated from spec/surface/tool-descriptions.json", () => {
  const descriptions = JSON.parse(readFileSync(join(root, "spec/surface/tool-descriptions.json"), "utf8"));
  const current = readFileSync(join(root, "crates/omgbase-surface/src/descriptions.rs"), "utf8");
  assert.equal(current, render(descriptions), "run node scripts/gen-tool-descriptions.mjs");
});
