# The omgbase format specification

omgbase turns an authored file into a **block tree**: a flat list of
source-backed blocks with byte spans, trailing trivia, typed attributes and
normalized visible text, which the rest of the engine hashes, reconciles,
mutates and splices back into bytes. This directory specifies that mapping so
that more than one implementation can produce the same tree from the same
bytes. It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/core/parse` + `packages/core/src/format` | **Reference.** Block-model decisions land here first. |
| `omgbase-format` (Rust, crates.io) | `crates/omgbase-format` | Conformance-first port. Passes the same fixtures. |

The spec is two artifacts, versioned together by `VERSION`:

- this `README.md` — the block model, the round-trip law, the text
  normalization and hashing rules, and the fixture contract;
- `cases/*.json` — the executable fixtures. **When prose and fixtures
  disagree, the fixtures win**, and the prose gets fixed.

The first format is Markdown (CommonMark + GFM tables, task lists and
strikethrough, plus YAML frontmatter). YAML and JSON adapters exist in the
reference and will join the spec as further `format` values; nothing here is
Markdown-specific except §3.

## Versioning

`VERSION` holds the block-model version as `major.minor`. The `omgbase-format`
crate is versioned `<major>.<minor>.<patch>` with the patch digit free for
bug fixes and packaging, exactly as `oqx` tracks `spec/oqx/VERSION`. The
reference lives inside `@omgbase/core`, which has its own version line; it
conforms to the `VERSION` committed alongside it. A behavioral change (any
fixture added or changed that alters an expected tree) bumps the minor here
and in the crate at once.

## The rule for changing the block model

**Fixture first, TypeScript (reference) second, Rust third.** A behavior
change without a fixture is not done. The fixtures are *generated* from the
reference (see §5) — so the sequence for a change is: decide the rule in this
README, change the reference, regenerate, review the fixture diff as the
statement of the change, then bring the port up. A divergence found by the
port is adjudicated by the prose here: when the prose is silent, write the
rule, and fix whichever implementation disagrees with it (the reference is not
automatically right — §6 records the reference bugs the port has surfaced).

## 1. The block tree

```text
BlockTree
  source          the decoded source text
  leading_trivia  bytes before the first block ("" when a block starts at 0)
  children        top-level blocks in document order

Block
  type            one of the kinds in §3 (unqualified, e.g. "heading")
  span            [start, end) byte offsets into the UTF-8 encoding of source
  raw             source bytes at span — never carries a trailing line ending
  text            normalized visible text (§4.1)
  attrs           typed attributes (§3), an object with sorted keys
  children        nested blocks (parser nesting only: lists, list items,
                  blockquotes, tables)
  trivia          bytes between this block's end and the next block's start
                  (top level only; nested blocks carry "")
```

Invariants every implementation must hold for every input, and that every
runner checks for every case:

1. **Round trip.** `render(parse(source)) == source`, byte for byte.
   `render` is the splice renderer: `leading_trivia + Σ(block.raw + block.trivia)`
   over the top-level blocks, in order, verbatim. Nothing is ever
   re-serialized from a syntax tree.
2. **Full coverage.** The top-level blocks and their trivia tile the source
   exactly: no gaps, no overlaps, the first block starts where
   `leading_trivia` ends, the last block's trivia ends at the end of the
   source.
3. **Nesting.** A nested block's span lies within its parent's span and its
   `raw` is a substring of the parent's `raw`. Nested blocks are **not**
   tiled: the bytes of a parent that belong to no child (list markers,
   blockquote `>` prefixes, table pipes) are simply the parent's own.
4. **Spans exclude the terminating line ending.** A block's `raw` never ends
   in `\n` or `\r`; the line ending that closes a block's last line — and any
   blank lines after it — belongs to the trivia that follows. Trailing
   spaces or tabs on the last line *are* part of `raw`. Parsers hand out
   spans that include line endings in places (micromark for a construct that
   runs unclosed to end of file; `markdown-rs` for loose list items), so an
   implementation trims the trailing run of `\r`/`\n` off every span,
   nested ones included.
5. **Offsets are bytes.** Spans are offsets into the UTF-8 bytes of the
   source. An implementation whose strings are UTF-16 (the reference)
   converts before emitting or comparing a fixture.
6. **A byte-order mark is leading trivia.** A source that begins with U+FEFF
   has `leading_trivia` beginning with those three bytes and every span
   counted from the true start of the file.
7. **Spans start at content.** A block's span begins at its first
   non-blank byte — leading indentation belongs to the trivia (top level) or
   to the parent (nested) — except `html_block` and indented code, whose
   indentation is part of `raw`. A tab that straddles a container's content
   column (`- a\n\t- b`: the tab covers both the item's indent and the
   nested list's) belongs to the container, not the child. This is what
   micromark does; `markdown-rs` includes the indentation and a port skips
   it.
8. **Parsing never fails.** Any source is a valid block tree; a block-level
   syntax-tree node of a kind not listed in §3 becomes an `opaque` block.
   (This is about node kinds, not about content that merely looks odd: a
   `=======` conflict marker makes the line above it a setext heading and
   `>>>>>>>` opens a blockquote nest, exactly as CommonMark says.)

## 2. Trivia attachment

Inter-block bytes — line endings, blank lines, stray whitespace — attach to
the **preceding** top-level block's `trivia` (trailing-attach). (A standalone
HTML comment is not trivia: CommonMark makes it an `html_block`.) Bytes before the
first block are `leading_trivia`. A source with no blocks is all
`leading_trivia`. Rationale (`docs/reconciliation-spec.md` §2.3): deleting a
block takes its following separator with it, and inserting after a block
inherits a sane separator.

## 3. Markdown block kinds and attributes

`format: "markdown"`. The parser is CommonMark with the GFM extensions
(tables, task list items, strikethrough, autolink literals, footnotes) and
YAML frontmatter (`---` fences at the very start of the file). Block kinds
map from the syntax tree as follows; everything else at block level is
`opaque`.

| Kind | Source construct | `attrs` |
| --- | --- | --- |
| `frontmatter` | leading `---` YAML fence block | `{}` |
| `heading` | ATX or setext heading | `{ "level": 1..6 }` |
| `paragraph` | paragraph | `{}` |
| `list` | list | `{ "ordered": bool }`; ordered lists always also carry `"start": n` (1 when the first item is `1.`). The `.` vs `)` delimiter is not carried. |
| `list_item` | list item without a task checkbox | `{}` |
| `task` | list item with a `[ ]`/`[x]` checkbox | `{ "checked": bool }` |
| `blockquote` | blockquote | `{}` |
| `code_fence` | fenced **or indented** code | `"lang"` when an info string's first word exists; `"info"` for the rest of the info string, when present |
| `table` | GFM table | `{}` |
| `table_row` | a row of a GFM table: the header row and each body row; **not** the delimiter row, whose bytes belong to the `table` alone. A non-blank line directly after a table with no pipes is still a body row (GFM). | `{}` |
| `thematic_break` | `---`, `***`, `___` | `{}` |
| `html_block` | HTML block | `{}` |
| `opaque` | anything else (link reference definitions, footnote definitions, math, …) | `{}` |

Nesting: `list` → items (`list_item`/`task`) → the item's blocks;
`blockquote` → its blocks; `table` → `table_row`s (cells are not blocks).
**Single-paragraph fold:** a `list_item`/`task` whose only child would be a
single `paragraph` has no children — the item carries the text itself (the
frozen outline format), whether the list is tight or loose. Items with any
other child structure (several blocks, a nested list, a code fence) keep
their children.

Attribute values are booleans, integers or strings. `attrs` is compared as
JSON with key order ignored.

**Nested `raw` is a source slice**, never a re-serialization: a paragraph
inside a blockquote keeps the `> ` prefixes of its continuation lines
(`"level one\n> still one"`), a nested list item keeps its indentation, and
their `text` follows from that (`"level one > still one"`). A port that
builds nested content from its syntax tree instead of slicing will differ.

## 4. Text and hashes

### 4.1 Normalized text (`text`)

Type-aware, from the block's `raw`:

1. For `heading`: remove one leading run of `[ \t]*#{1,6}[ \t]+` and one
   trailing run of `[ \t]+#*[ \t]*` at the very end of the string.
   For `list_item`/`task`: at the very start of the string remove
   `[ \t]*([-*+]|[0-9]+[.)])[ \t]+`, then an optional `\[[ xX]\][ \t]+`.
   Other kinds: nothing. (These anchor at the start/end of the whole raw
   string, not per line.)
2. Split into lines on `\r\n`, `\r` or `\n`.
3. Trim each line at both ends using the **JavaScript trim set**: Unicode
   `White_Space` plus U+FEFF. (Rust's `str::trim` omits U+FEFF; a port adds
   it.)
4. Within each line collapse every run of spaces and tabs (`[ \t]+`) to one
   space.
5. Drop empty lines; join the rest with a single space.
6. Apply Unicode NFC normalization.

Inline Markdown characters (emphasis markers, backticks, link syntax) are
content and stay. The kind-specific stripping in step 1 is the only syntax
removal: a `code_fence`'s text keeps its fence lines and info string, a
setext heading keeps its underline, frontmatter keeps its `---` fences
(see the open questions). U+00A0 and U+FEFF *inside* a line survive — only
line ends are trimmed and only `[ \t]` runs collapse. `raw_hash` is over the
source bytes as written (NFD stays NFD there); `text` is NFC.

### 4.2 Hashes

- `raw_hash` = SHA-256 of the block's `raw` bytes (the UTF-8 encoding of the
  span), 64 lowercase hex characters in fixtures. The engine's `raw_hash`
  column and the `sha256(file) == rendered hash` invariant rest on this.
- `norm_hash` = SHA-256 of the UTF-8 encoding of `text`. Not carried in
  fixtures (it is determined by `text`), but a port exposes it.

## 5. Fixtures

`cases/<suite>.json`:

```jsonc
{
  "suite": "edge",              // = file stem
  "format": "markdown",
  "cases": [
    {
      "name": "bom",            // unique within the file; the case id is `<suite>::<name>`
      "notes": "optional prose for the reader",
      "source": "﻿# Doc with BOM\n\nBody.\n",
      "expect": {
        "leading_trivia": "﻿",
        "blocks": [
          {
            "type": "heading",
            "span": [3, 17],
            "text": "Doc with BOM",
            "attrs": { "level": 1 },
            "trivia": "\n\n",
            "raw_hash": "…64 hex…",
            "children": []
          },
          …
        ]
      }
    }
  ]
}
```

- `source` is the exact file content as a JSON string; its UTF-8 encoding is
  the byte sequence the spans index. Sources are embedded, never sidecar
  files, so CRLF, BOMs, trailing-newline absence and trailing whitespace
  survive editors and checkouts.
- `raw` is not carried: it is the source bytes at `span`, and the runner
  checks the implementation's `raw` against that slice.
- Every block, nested or not, carries all seven fields; nested blocks have
  `"trivia": ""`.
- A runner checks, per case: invariants 1–8 of §1 on the implementation's
  tree; then `leading_trivia` and the block list deep-equal the fixture
  (spans exact, strings exact, `attrs` as JSON with key order ignored,
  `children` recursively).

**Generation.** The fixtures are produced by the reference from the
round-trip corpus at `packages/core/corpus/roundtrip` (one suite per corpus
directory: `edge`, `spec`, `real`; the case name is the file name without
`.md`). `packages/core/corpus/format/spec.test.ts` asserts the reference
matches the committed fixtures and, with `FORMAT_SPEC_UPDATE=1`, rewrites
them from the current corpus; the diff is reviewed like code. New coverage is
added as a corpus file (`corpus/roundtrip/generate.mjs`), then regenerated.

**Allowlist (Rust).** While the port runs behind the fixtures,
`crates/omgbase-format/tests/spec-passing.txt` names the case ids that must
pass (a listed case failing, an unlisted case passing, or a stale id all fail
the build); `FORMAT_SPEC_UPDATE=1 cargo test -p omgbase-format --test spec`
rewrites it from the passing set and deletes it once everything passes. When
the file is absent, every case must pass. Same mechanism as `spec/oqx`.

## 6. Portability notes and reference bugs surfaced

Places a second implementation diverges from the reference by accident of the
host, with the rule this spec picks:

- **UTF-16 vs bytes.** micromark positions are JS string indices (UTF-16 code
  units). The spec uses bytes (§1 inv. 5); the reference converts.
- **BOM.** micromark drops a leading U+FEFF in its preprocessor (first chunk
  only; a second BOM is content) and reports positions relative to the
  stripped text; the reference used those offsets against the unstripped
  string, so every block in a BOM file was shifted one code unit (a heading's
  `raw` began with the BOM and lost its last character). Round trip still
  held because the shift was uniform. Fixed in the reference under §1 inv. 6;
  `edge::bom` pins it.
- **Unclosed constructs at end of file.** micromark gives a fenced code block,
  HTML block or list that runs to EOF without a closer *all* the trailing
  line endings and blank lines. The reference used to keep them in `raw`,
  contradicting §1 inv. 4 (found by `edge::unclosed-fence-eof`); it now trims
  the trailing `\r`/`\n` run off every span, which is also what a port does.
- **Block ends in `markdown-rs`.** It ends a loose list item, a list whose
  last item is loose, and a footnote definition *after* the line ending and
  swallows the blank lines that follow — including `>`-prefixed blank lines
  inside an enclosing blockquote. §1 inv. 4 picks "before"; the port trims
  trailing line endings on every block and trailing blank (or blank-`>`)
  lines on lists, items and footnote definitions, never below the last
  child's end.
- **Block starts in `markdown-rs`.** It includes leading indentation in every
  block's position where micromark excludes it (see §1 inv. 7). The port
  computes the container's content column and skips the indentation.
- **Trim set.** JS `String.prototype.trim` removes U+FEFF; Rust's does not.
  §4.1 step 3 picks the JS set.
- **Digits.** The list-marker pattern uses ASCII digits only.
- **Line endings.** `\r\n`, `\r` and `\n` are all line endings for §4.1; a
  block's `raw` never ends in one (§1 inv. 4); CRLF sources round-trip
  unchanged because bytes are spliced, never re-serialized.

## Open questions

- [ ] Setext headings: `text` currently keeps the `===`/`---` underline
      ("Title One =========") because §4.1 only strips ATX markers. Least
      surprise says strip it; decide, then fixture → reference → port.
- [ ] `frontmatter` `text` includes the `---` fences. Same question.
- [ ] `code_fence` `text` includes the fence lines and info string. Same
      question (indented code, by contrast, yields just the trimmed lines).
- [ ] Nested `text` keeps blockquote `> ` continuation prefixes. Same
      question, with an identity cost: it is the `norm_hash` input.
