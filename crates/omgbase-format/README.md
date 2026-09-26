# omgbase-format

**The omgbase format layer — Rust implementation.**

omgbase turns an authored file into a **block tree**: source-backed blocks with
byte spans, trailing trivia, typed attributes and normalized visible text,
which the rest of the engine hashes, reconciles, mutates and splices back into
the identical bytes:

```rust
use omgbase_format::{BlockKind, parse_markdown, render};

let source = "# Title\n\n- [x] done\n- open\n";
let tree = parse_markdown(source);
assert_eq!(render(&tree), source);                     // byte for byte
assert_eq!(tree.children[0].kind, BlockKind::Heading);
assert_eq!(tree.children[0].text, "Title");
assert_eq!(tree.children[1].children[0].kind, BlockKind::Task);
```

This crate is the second implementation of the block model. The reference is
the TypeScript engine
[`@omgbase/core`](https://github.com/omgbase/omgbase/tree/main/packages/core)
(`src/core/parse` + `src/format`). Both conform to the language-neutral
specification and fixtures at
[`spec/format`](https://github.com/omgbase/omgbase/tree/main/spec/format) in
the same repository; `omgbase_format::SPEC_VERSION` reports the block-model
version this crate implements, and the crate version tracks it as
`<major>.<minor>.<patch>`.

## Status

Conformance-first, and conformant for Markdown: `tests/spec.rs` runs every
fixture in `spec/format/cases` (82 cases in 3 files at block-model version 0.1)
and all of them pass, so `cargo test -p omgbase-format` requires every case to
pass. `tests/roundtrip.rs` additionally parses every file of the reference's
round-trip corpus (`packages/core/corpus/roundtrip`) and asserts the §1
invariants directly. YAML and JSON adapters exist in the reference and are not
ported yet; they will arrive with their `format` values in the spec. Not yet
published.

The runner keeps an allowlist mechanism for the periods when the spec runs
ahead of the port (from `spec/format/README.md` §5): if `tests/spec-passing.txt`
exists, it names the case ids (`<file-stem>::<name>`, one per line) that must
pass; a listed case that fails fails the build, an unlisted case that passes
fails the build with a message asking for it to be added, and a listed id that
no longer exists is an error too. When the file is absent — the current state —
every case must pass. `cargo test -p omgbase-format` prints `spec: N passed, M
failed, K listed` on stderr and, on failure, the offending case ids grouped by
fixture file with a one-line reason each (the first differing field, with both
values).

To (re)generate the allowlist from the currently passing set — for example
after new fixtures land in `spec/format/cases` before the port catches up — run:

```sh
FORMAT_SPEC_UPDATE=1 cargo test -p omgbase-format --test spec
```

This writes the list (and prints any listed case that now fails, so nothing is
blessed silently), or deletes the file once every case passes.

Both integration tests skip with a note when the fixtures or the corpus are
not present (the published crate is built outside the monorepo).

## Layering

Mirrors the spec so the two can be read side by side:

- `block` — `BlockTree`, `Block`, `Span`, `BlockKind`, `Attrs`/`AttrValue`
  (README §1, §3): byte spans, `raw` never ending in a line ending, trivia on
  top-level blocks only, attributes as a sorted map of bool / i64 / string.
- `text` — `normalize_visible_text` (§4.1): kind-aware marker stripping (ATX
  hashes; list markers and task checkboxes, anchored at the start of the whole
  raw), line split on `\r\n` | `\r` | `\n`, the **JavaScript trim set**
  (Unicode `White_Space` plus U+FEFF — Rust's `str::trim` alone is not it),
  `[ \t]+` collapse, empty-line drop, NFC.
- `hash` — `raw_hash` / `norm_hash` (§4.2): SHA-256 over UTF-8 bytes, plus a
  lowercase hex helper.
- `render` — the splice renderer (`leading_trivia + Σ(raw + trivia)`) and the
  `full_coverage` tiling check (§1 inv. 1–2). Nothing is ever re-serialized
  from a syntax tree.
- `markdown` — mdast → blocks (§3) over
  [`markdown-rs`](https://crates.io/crates/markdown) (wooorm's micromark port,
  GFM constructs plus YAML frontmatter, the same construct set as the
  reference), trailing-attach trivia (§2), the single-paragraph fold, and the
  host normalizations below. `MarkdownAdapter` implements the small
  `FormatAdapter` trait (`format`, `extensions`, `parse`, `render`).

### Host divergences normalized

`markdown-rs` and micromark agree on which blocks exist and on their
attributes; they disagree on where some spans begin and end. The spec (§1
inv. 4, §6) picks micromark's answer, and `markdown.rs` brings every span
there rather than special-casing fixtures:

- **Block ends.** `markdown-rs` ends a loose list item, a list whose last item
  is loose, and a footnote definition *after* the line ending, and includes
  any blank lines that follow — including the `>`-prefixed blank lines of an
  enclosing blockquote (`- a\n>` inside a quote). micromark ends them at the
  last content byte. Every span is trimmed of trailing line endings; lists and
  footnote definitions also drop trailing whitespace-only lines; items also
  drop trailing `[ \t>]*` lines. A trailing `>` line that really is an empty
  blockquote child is kept (a parent never ends before its last child).
  Blockquotes themselves keep a trailing blank `>` line in both parsers.
- **Block starts.** micromark starts a block at its first non-blank byte:
  leading indentation (up to three spaces at the top level, any extra
  indentation inside a container) is a line prefix, not part of the block, so
  `  - a` is a list at byte 2. `markdown-rs` starts at the first byte the
  container did not fully consume, which also makes a tab that straddles the
  container's content column (`- a\n\t- b`: the item's content column is 2,
  inside the tab) part of the nested list. Both parsers keep the indentation
  of `html_block` and indented code, but micromark still assigns a straddling
  tab to the container. The port skips the straddling tab for every kind and
  the remaining indentation for every kind but those two.
- **BOM.** `markdown-rs` tokenizes a leading U+FEFF and reports offsets from
  the true start of the file, so a BOM lands in `leading_trivia` with no
  adjustment (§1 inv. 6).

Everything else the spec lists in §6 (UTF-16 vs bytes, the trim set, ASCII
digits in list markers, CRLF) is handled where the spec says.

## Features

- `json` — the fixture shape of §5 as `serde_json` values: `Block::to_json`
  (exactly the seven fixture fields), `BlockTree::to_json`
  (`{ leading_trivia, blocks }`), `attrs_to_json`, and `From<AttrValue> for
  serde_json::Value`. For tooling that diffs a tree against a fixture; the
  conformance runner does not need it and cross-checks it when it is on.

## License

MIT
