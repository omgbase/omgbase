// Generates the round-trip corpus (03 §2.4). Deterministic; run:
//   node corpus/roundtrip/generate.mjs
// Files are committed; regenerate only when adding coverage. Exact bytes matter
// (CRLF, missing trailing newline) so we write Buffers, never editor-touched.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const write = (rel, content) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(content, "utf8"));
};

// ---- edge/ : the hard bytes-level cases ------------------------------------
const edge = {
  "crlf.md": "# CRLF Doc\r\n\r\nBody with Windows line endings.\r\n\r\n- a\r\n- b\r\n",
  "no-trailing-newline.md": "# No Trailing Newline\n\nThe file ends without a newline.",
  "conflict-markers.md":
    "# Conflicted\n\nIntro.\n\n<<<<<<< HEAD\nour version\n=======\ntheir version\n>>>>>>> feature-branch\n\nOutro.\n",
  "empty.md": "",
  "blanks-only.md": "\n\n\n",
  "leading-blank-lines.md": "\n\n# After Blanks\n\nBody.\n",
  "trailing-whitespace.md": "line with trailing spaces   \n\nanother   \n",
  "multiple-blank-runs.md": "para a\n\n\n\n\npara b\n\n\npara c\n",
  "tabs-and-spaces.md": "# Mixed\n\n\tindented with tab\n\n    indented with spaces\n",
  "crlf-no-trailing.md": "# CRLF no trailing\r\n\r\nlast line no newline",
  "bom.md": "﻿# Doc with BOM\n\nBody.\n",
  "unicode.md": "# Ünïcödé — 日本語 — emoji 🎯\n\nMixed scripts: café, naïve, Москва.\n",
  "only-frontmatter.md": "---\ntitle: only frontmatter\ntags: [a, b]\n---\n",
  "html-comment.md": "# H\n\n<!-- a standalone comment -->\n\nPara after comment.\n",
};
for (const [name, body] of Object.entries(edge)) write(`edge/${name}`, body);

// ---- spec/ : CommonMark & GFM construct coverage ---------------------------
const spec = {
  "atx-headings.md": "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n",
  "setext-headings.md": "Title One\n=========\n\nBody.\n\nTitle Two\n---------\n\nMore.\n",
  "paragraphs.md": "First paragraph across\nmultiple soft-wrapped lines.\n\nSecond paragraph.\n",
  "thematic-breaks.md": "above\n\n---\n\nmiddle\n\n***\n\nbelow\n",
  "blockquotes.md": "> level one\n> still one\n>\n> > nested two\n\nafter\n",
  "fenced-code.md": "```js\nconst x = 1;\nconsole.log(x);\n```\n\n```\nno lang\n```\n",
  "fenced-code-meta.md": "```ts title=example.ts {1,3}\nlet a = 1;\nlet b = 2;\n```\n",
  "indented-code.md": "para\n\n    indented code\n    second line\n\nafter\n",
  "unordered-lists.md": "- one\n- two\n- three\n\n* star one\n* star two\n",
  "ordered-lists.md": "1. first\n2. second\n3. third\n\n5. starts at five\n6. six\n",
  "nested-lists.md": "- a\n  - a1\n  - a2\n    - a2a\n- b\n  1. b1\n  2. b2\n",
  "loose-list.md": "- item one\n\n- item two\n\n- item three\n",
  "task-lists.md": "- [ ] open task\n- [x] done task\n- [ ] another\n- plain item\n",
  "inline-emphasis.md": "Text with *italic*, **bold**, ***both***, `code`, ~~strike~~.\n",
  "links.md": "A [link](https://example.com) and a [ref][1].\n\n[1]: https://ref.example\n",
  "images.md": "![alt text](https://example.com/img.png \"title\")\n\nInline ![x](y.png).\n",
  "autolinks.md": "Visit <https://example.com> or email <a@b.com>.\n",
  "tables.md": "| Name | Value |\n| ---- | ----- |\n| a | 1 |\n| b | 2 |\n",
  "tables-aligned.md": "| L | C | R |\n| :-- | :-: | --: |\n| x | y | z |\n",
  "html-block.md": "<div class=\"note\">\n  <p>raw html</p>\n</div>\n\nmarkdown after\n",
  "escapes.md": "Escaped \\*not italic\\* and \\`not code\\` and \\# not heading.\n",
  "reference-defs.md": "See [alpha][a] and [beta][b].\n\n[a]: https://a.example\n[b]: https://b.example\n",
  "hard-breaks.md": "line one  \nline two after hard break\n\nnext para\n",
  "mixed-constructs.md":
    "# Title\n\nIntro paragraph.\n\n## Section\n\n- point one\n- point two\n\n> a quote\n\n```py\nprint('hi')\n```\n\nClosing.\n",
};
for (const [name, body] of Object.entries(spec)) write(`spec/${name}`, body);

// ---- real/ : worknotes / Obsidian / README-style documents ----------------
const real = {};

// A batch of frontmatter+wikilink+inlinefield+task notes (worknotes style).
for (let i = 1; i <= 18; i++) {
  const tags = ["arch", "impl", "review", "ops", "design"][i % 5];
  const layer = ["draft", "proposed", "working", "canon"][i % 4];
  real[`note-${String(i).padStart(2, "0")}.md`] =
    `---\ntitle: Note ${i}\nlayer: ${layer}\ntopics:\n  - ${tags}\n  - omgbase\n---\n\n` +
    `# Note ${i}\n\nThis references [[Other Note ${i + 1}]] and links to ` +
    `[the hub](/projects/omgbase.md).\n\n` +
    `Related:: [[Concept ${i}]]\nstatus:: ${layer}\n\n` +
    `## Open loops\n\n- [ ] resolve question ${i}\n- [x] closed item ${i}\n\n` +
    `## Notes\n\nParagraph with some **bold** and a \`code span\`. See ${i} for context.\n`;
}

real["readme-style.md"] =
  "# my-project\n\n> A one-line description.\n\n## Install\n\n```bash\nnpm install my-project\n```\n\n## Usage\n\n```js\nimport { thing } from 'my-project';\nthing();\n```\n\n## Contributing\n\nPRs welcome. See [CONTRIBUTING](./CONTRIBUTING.md).\n\n## License\n\nMIT\n";

real["changelog-style.md"] =
  "# Changelog\n\n## [1.2.0] - 2026-01-01\n\n### Added\n\n- Feature A\n- Feature B\n\n### Fixed\n\n- Bug X\n\n## [1.1.0] - 2025-12-01\n\n### Changed\n\n- Behavior Y\n";

real["meeting-notes.md"] =
  "---\ntype: meeting\ndate: 2026-09-03\nattendees: [alice, bob]\n---\n\n# Sync Meeting\n\n## Agenda\n\n1. Status\n2. Blockers\n3. Next steps\n\n## Decisions\n\n- [x] Ship on Friday\n- [ ] Follow up with design\n\n## Notes\n\nDiscussed [[Roadmap Q4]] at length.\n";

real["deeply-nested.md"] =
  "# Outline\n\n- L1\n  - L2\n    - L3\n      - L4\n        - L5\n- back to L1\n\n> quote\n> > nested\n> > > deep\n";

real["long-prose.md"] =
  "# Essay\n\n" +
  Array.from({ length: 6 }, (_, i) =>
    `Paragraph ${i + 1}. ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3),
  ).join("\n\n") +
  "\n";

real["code-heavy.md"] =
  "# API\n\n```ts\ninterface Foo {\n  bar: string;\n  baz: number;\n}\n```\n\nUse it:\n\n```ts\nconst f: Foo = { bar: 'x', baz: 1 };\n```\n\n```json\n{\n  \"key\": \"value\"\n}\n```\n";

for (const [name, body] of Object.entries(real)) write(`real/${name}`, body);

console.log("corpus generated");
