# The omgbase properties specification

A document's **properties** are the typed, indexed rows the engine derives
from three authored-or-computed sources — the YAML frontmatter fence, inline
`key:: value` fields in the body, and engine-computed `$`-intrinsics — and
stores in the `properties` table (`spec/store` §3.1) so that filters,
projections and `docs_read` see one uniform surface. This directory
specifies the mapping from a document's bytes to those rows, and the two read
shapes built from them, so that more than one implementation produces the
same rows from the same document. It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/core/store/properties.ts`, the inline/computed parts of `core/ingest.ts`, `format/markdown.ts` (`projectNodes` inline fields, `computeProperties`, `extractMetadata`), `graph/extract.ts` (`maskCode`) | **Reference.** Property decisions land here first. |
| `omgbase-properties` (Rust, crates.io) | `crates/omgbase-properties` | Conformance-first port: a pure library, block tree in, rows out. `omgbase-store` calls it in the commit transaction. |

The spec is two artifacts, versioned together by `VERSION`:

- this `README.md` — the sources, the value typing, the row shape, the read
  shapes, the YAML contract, the fixture contract;
- `cases/*.json` — the executable fixtures. **When prose and fixtures
  disagree, the fixtures win**, and the prose gets fixed.

The design rationale (why one table, why `card`, why `$`-intrinsics) is
`docs/properties-table.md`; this document is the as-built contract.

## Versioning

`VERSION` is `<major>.<minor>`. The `omgbase-properties` crate is
`<major>.<minor>.<patch>`, exactly as the other crates track their specs. A
change to which rows a document yields (a new source, a typing rule, a
computed intrinsic, the YAML resolution) bumps the minor; a change to the row
*shape* (a column's meaning, `prop_id`, the read shapes) bumps the major. A
fixture that pins existing behavior is neither. The reference lives inside
`@omgbase/core`, which has its own version line.

## The rule for changing the properties

**Fixture first, TypeScript (reference) second, Rust third.** Fixture
*inputs* (document sources) are authored by hand; each case's `expect` is
*generated* by the reference (§7) and reviewed as code. A divergence found by
the port is adjudicated by the prose here; when the prose is silent, write
the rule, and fix whichever implementation disagrees with it (§8 records the
reference oddities surfaced and the decisions taken).

## 1. Inputs and output

Input: a Markdown document as `spec/format` parses it — the block tree with
ids assigned (the `frontmatter` block, if any, split off; every body block
carrying its `block_id`) — plus the document's `doc_id`. Only `format =
markdown` is specified here; the YAML and JSON adapters' whole-document
metadata joins later as further `format` values.

Output: the document's **property rows**, in no particular order (the table
has no sequence; §7 sorts for comparison), each

```text
PropertyRow
  prop_id     "p_" + first 12 hex chars of sha256(doc_id + "|" + source + "|" + key + "|" + ord)
  block_id    the authoring block's id for inline rows; null for frontmatter and computed
  source      frontmatter | inline | computed
  key         dotted, flattened key ("layer", "meta.owner"); computed keys carry "$" ("$title")
  card        scalar | list — the authored shape (§2.3)
  ord         position within a multi-value key, from 0; 0 for a scalar
  type        string | number | bool | null | json
  val_text    the string, for type string; else null
  val_num     the number, for type number; else null
  val_bool    1 or 0, for type bool; else null
  val_json    JSON text: the escape-hatch value for type json, or the range
              side channel for a range-shaped string (§2.2); else null
```

plus the two read shapes of §5. `prop_id` is deterministic: a row is
identified by its document, source, key and ordinal, so the same document
yields the same ids. Two rows with the same `(source, key, ord)` collide on
`prop_id`; the reference writes `INSERT OR REPLACE`, so **the later row wins**
(§8).

## 2. Values

### 2.1 Typing a scalar (`typed_value`)

Given a JSON-shaped value as the YAML parser (§4) or the inline coercion
(§3.2) produced it:

| Value | `type` | columns |
| --- | --- | --- |
| null (YAML `null`, `~`, empty) | `null` | all `null` |
| boolean | `bool` | `val_bool` 1/0 |
| number (finite or not, §8) | `number` | `val_num` |
| string that is **range-shaped** (§2.2) | `string` | `val_text` = the string verbatim, `val_json` = the range object |
| any other string | `string` | `val_text` |
| object or array that resisted flattening (§2.3) | `json` | `val_json` = the value as JSON |

`val_json` text is JSON with object keys in the parser's order and numbers
in JavaScript `Number.prototype.toString` form (`1`, not `1.0`; `1e+21`);
runners compare it as parsed JSON, so a port need not reproduce the bytes.

### 2.2 Range-shaped strings (`detect_range`)

A string is range-shaped when it matches `^(.*?)(\.\.\.?)(.*)$` with the
operator a **maximal** run of exactly two or three dots (the left part must
not end in `.`, the right part must not start with `.` — so `1....5` is not a
range and `3.14` has no operator), at least one of the two bounds non-empty,
and the non-empty bounds all in **one** domain:

- **numeric**: `^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$` — bounds become numbers;
- **ISO date/datetime**: `^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$`
  — bounds stay strings (they order lexically = chronologically).

The side channel is `{"__range": true, "lo": <bound|null>, "hi": <bound|null>,
"exclusiveEnd": <three dots>}`. The row stays `type = string` with the
verbatim text, so equality, display and FTS are a string's; the range is
opt-in at query time (`range(prop)`). `a..z`, `1..2026-01-01`, `../foo`,
`..` are not ranges; `1.5...` is (open-ended, exclusive — the left bound
does not end in `.`). Quoting does not defeat detection: `f: "1..5"` gets
the side channel too (`yaml::quoted-scalars-are-strings`). `\d` is ASCII.

### 2.3 Flattening a frontmatter object (`flatten_frontmatter`)

Walk the parsed mapping's entries in parser order, with the dotted `key`
prefix so far (`""` at the top; a nested key is `prefix + "." + k`, so
`meta: {owner: alice}` yields key `meta.owner`, indistinguishable from an
authored `meta.owner: alice` — §8):

- a **mapping** value recurses (its own key emits nothing; an **empty
  mapping emits no rows**);
- an **array** whose elements are all scalars (no mapping, no array among
  them) emits one row per element, `card = list`, `ord` = the index, typed
  per §2.1; an **empty array emits no rows**;
- any **other array** (containing a mapping or an array) emits **one** row,
  `card = list`, `ord = 0`, `type = json`, `val_json` = the whole array;
- a **scalar** emits one row, `card = scalar`, `ord = 0`, typed per §2.1.

Keys are the parser's string keys (§4: a non-string YAML key is stringified;
a `null` key is `""`). Keys are not trimmed or case-folded.

### 2.4 Computed values (`flatten_computed`)

Given the computed object (§3.3): an array value emits `card = list` rows
per element (`ord` = index); anything else one `card = scalar` row. Keys
are stored as given, `$` included.

## 3. Sources

### 3.1 Frontmatter (`source = frontmatter`, `block_id = null`)

The document's frontmatter is the `frontmatter` block of the `spec/format`
tree — the leading `---` fence — and nothing else: a document whose first
block is not `frontmatter` has no frontmatter rows, whatever else its bytes
resemble (§8: the reference also regex-scanned the raw source). Its YAML text
is the block's `raw` with the first line (the opening `---`) and the last
line (the closing `---`, with any trailing whitespace) removed; line endings
may be `\n` or `\r\n`.

Parse that text as YAML per §4. If parsing fails, or the result is not a
mapping (a scalar, a sequence, `null`/empty), the document has **no
frontmatter rows** — frontmatter is queryable metadata, not load-bearing.
Otherwise flatten per §2.3.

### 3.2 Inline fields (`source = inline`, `block_id` = the authoring block)

Walk every body block in pre-order (a block, then its children — so a list's
raw, which contains its items, is scanned **and** each item's raw is scanned
again; see below for why that does not double count). Skip `code_fence`
blocks entirely. For any other block, scan `mask_code(raw)` — the block's
`raw` with fenced code blocks and inline code spans replaced by spaces of the
same length (`graph/extract.ts` `maskCode`: a fence is ` ``` `/`~~~` of ≥ 3
after any run of spaces and tabs, closed by the same character at ≥ the same
length; a backtick fence whose info string contains a backtick is not a
fence; then code spans of *n* backticks closed by exactly *n*) — with two
regular expressions, in this order, **case-insensitive over ASCII letters
only** (`[a-z]` under the flag means `[A-Za-z]`; a port must not let Unicode
case folding admit `ſ` or `K`), all matches:

1. **Bracketed form**: `[[(]([a-z][a-z0-9_]*)::[ \t]*([^\]\n)]*?)[ \t]*[\])]`
   — `[key:: value]` or `(key:: value)` anywhere in prose; the value runs to
   the closer, trimmed of spaces and tabs; the opener and closer need not
   match.
2. **Line form**: `^[ \t]*([a-z][a-z0-9_]*)::[ \t]*([^\n]*?)[ \t]*$` with
   multiline anchors — a key at the start of a line (after spaces/tabs), the
   value to the end of the line, trimmed. A bracketed field on its own line
   is not also a line-form match because `[`/`(` is not `[a-z]`.

Each match is one **occurrence** `(key, value, block_id)`, where `key` is
the captured name **as written** (case preserved; the `i` flag only widens
the match) and `block_id` is the id of the block being scanned. Occurrences
are collected in scan order: block pre-order, then within a block all
bracketed matches in position order, then all line-form matches in position
order.

**Containers.** A `list`'s or `blockquote`'s `raw` contains its children's
raws (`spec/format` §3), so a field inside a nested block can match once per
enclosing container **and** once for the block itself. The reference keeps
**every** occurrence, so such a field counts several times (`card = list`,
the outermost container's `block_id` first). Which fields this affects
follows from the patterns: a bracketed field anywhere inside a container; a
line-form field on a *continuation* line of a list item (`- a\n  job:: x`).
A line-form field on a list item's **marker line** (`- job:: x`) never
matches at all: the item's `raw` includes its marker (`spec/format` §3), so
`- ` is in the way of `^[ \t]*[a-z]` in the item and in the list alike
(`inline::marker-line-field-yields-nothing`). A blockquote's `> `-prefixed
line fails the same way at the quote level, but the nested paragraph's own
`raw` starts at content (`spec/format` §1 inv. 7), so `> job:: x` yields
**one** row, anchored to the paragraph
(`inline::blockquote-line-field-matches-once-via-nested-paragraph`). A code
fence inside a blockquote is masked not by the fence rule (the `> ` prefix
defeats it) but by the code-span rule — three backticks closed by three
(`inline::fenced-code-inside-blockquote-masked-as-a-code-span`). This is as
built and pinned (§8); a runner reproduces it.

**Card and ord.** Count occurrences per `key` across the document. A key
with exactly one occurrence yields a `card = scalar` row, `ord = 0`; a key
with several yields `card = list` rows, `ord` = 0, 1, … in occurrence order.
(A frontmatter row for the same bare key does not change `card`; the
authored-union multiplicity is a query-time gate.)

**Value coercion** (`typed_inline_value`): trim the captured value with the
JavaScript trim set (`spec/format` §4.1 step 4). `true`/`false` (exact,
lower-case) → `bool`. Otherwise, if the string is non-empty and is a
**JavaScript numeric string** that converts to a finite number → `number`
with that value: an optional sign, then a decimal literal (`12`, `1.5`,
`.5`, `5.`, `1e3`, `1E-2`), or — unsigned — a `0x`/`0X` hex, `0o`/`0O`
octal or `0b`/`0B` binary integer; `Infinity` is not finite; `1_000`, `12px`,
`NaN`, `0x` alone are not numeric. Otherwise `string`, and range detection
§2.2 does **not** apply to inline values (§8).

### 3.3 Computed (`source = computed`, `block_id = null`)

The Markdown adapter computes, over the body blocks:

- **`$title`**: the `text` (visible text, `spec/format` §4.1) of the first
  block in **pre-order** with `type = heading` and `attrs.level = 1` whose
  trimmed text is non-empty — nested headings (inside a blockquote or a list
  item) count, in document order. Absent when there is none. A scalar row.
- **`$tags`**: walking blocks in pre-order, skipping `heading` and
  `code_fence` blocks (but **not** skipping containers, whose `raw` includes
  their children, nor `html_block`/`opaque`), collect every match of
  `(?:^|\s)#([a-zA-Z][\w/-]*)` over the block's **`raw`** (not `text`, not
  code-masked; `^` is the start of the raw, `\s` the JavaScript whitespace
  set, `\w` ASCII `[A-Za-z0-9_]`), keeping the first occurrence of each
  distinct tag in encounter order. Absent when empty; otherwise a list.

Nothing else is computed in this version.

## 4. The YAML contract

Frontmatter is **YAML 1.2, core schema**, parsed as the `yaml` npm package
(v2) parses a single document with default options. A port that uses another
YAML library must resolve plain scalars by the core schema and match the
failure behavior; the `yaml.json` suite pins the cases that matter:

- **Null**: `null`, `Null`, `NULL`, `~`, and an empty value → null.
- **Bool**: only `true|True|TRUE|false|False|FALSE`. `yes`, `no`, `on`,
  `off`, `y`, `n` are **strings** (YAML 1.1 booleans are not core schema).
- **Int**: `[-+]?[0-9]+` decimal (`012` is twelve, not octal), `0o[0-7]+`
  octal, `0x[0-9a-fA-F]+` hex. `1_000` is a **string** (underscores were
  1.1). Integers are IEEE doubles in both hosts: `9007199254740993` reads as
  `9007199254740992`.
- **Float**: `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`; `1.0` and
  `1` are the same number; `.inf`/`-.inf`/`.nan` are the non-finite floats
  (§8 for how they store).
- **Timestamps are strings**: `2026-01-01` and `2026-01-01T10:00:00Z` are
  `type = string` (and range-shaped when joined by `..`).
- **Quoted scalars are strings** (`"1"` → `"1"`), as is anything explicitly
  tagged `!!str`. Other core tags (`!!int`, `!!float`, `!!bool`, `!!null`)
  resolve as tagged **only when the value also matches that tag's own
  format** (`!!int "1"` → 1, `!!float 1.0` → 1, `!!bool "true"` → true,
  `!!null ""` → null); a mismatch (`!!float 1`, `!!int 1.5`, `!!bool yes`,
  `!!null x`) is a failed resolution and yields the **string** of the scalar
  (`yaml::explicit-core-tag-mismatch-is-a-string`). An **unknown tag**
  (`!custom 1`) is a warning, not an error, and always yields the **string
  of the source scalar** — `"1"`, not the number; `!bar` with no value is
  `""`, not null (`yaml::unknown-tag-yields-the-string`).
- **Anchors and aliases** resolve (`a: &x 1` / `b: *x` → both 1). **Merge
  keys do not**: `<<` is an ordinary key (merge is off in 1.2).
- **Block scalars** (`|`, `>`) resolve per YAML (`|` keeps the final line
  break: `"line1\nline2\n"`).
- **Keys** are strings: `1: x` → key `"1"`; `null: x` (or `~: x`) → key `""`.
- **Failures → no rows**: duplicate keys in one mapping, tabs as
  indentation, more than one document, a document that is not a mapping, and
  any syntax error. A `---` line cannot occur *inside* the fence (it closes
  it — `---x: 2` is just a key,
  `frontmatter::yaml-line-starting-with-dashes-is-inside-the-fence`); the
  multi-document failure is reachable through the `...` end marker
  (`yaml::document-end-marker-no-rows`).

## 5. Read shapes

Both shapes group the document's rows by `key`. **`shape(rows)`** for one
key: if the group is exactly one row with `card = scalar`, the decoded
scalar (`string` → `val_text`, `number` → `val_num`, `bool` → true/false,
`null` → null, `json` → the parsed `val_json`); otherwise an **array** of the
decoded rows sorted by source rank (`frontmatter` 0, `inline` 1, `computed`
2) then `ord`. So a one-element YAML list reads as a one-element array, a
bare key with a frontmatter row and an inline row reads as a two-element
array, and the json escape-hatch row (`card = list`) reads **wrapped**:
`items: [{a: 1}]` is `[[{"a": 1}]]`
(`shapes::json-escape-hatch-reads-as-nested-array`). Non-finite numbers read
as `Infinity`/`-Infinity`; NaN reads as `null` (its `val_num` is NULL).

- **grouped** (`docs_read.properties`): `{ frontmatter: {key: shape}, inline:
  {…}, computed: {…} }` — each source's rows shaped separately (every
  source present, possibly `{}`).
- **merged** (the query layer's bag): `{ key: shape }` over **all** rows of
  the document, authored sources and computed alike, keyed by the stored key
  (`$title` keeps its sigil).

A range-shaped string decodes as its `val_text` in both shapes.

## 6. Where the rows are written

`spec/store` §5.4: inside the commit transaction, after the blocks are
refreshed, the document's existing `properties` rows are deleted
(`DELETE … WHERE doc_id = ?`) and the rows of §1 are inserted with
`repo_id`, `doc_id`, `created_commit` = the commit, `deleted_commit = NULL`,
by `INSERT OR REPLACE` on `prop_id`. Rows are written inline first (in
occurrence order), then frontmatter, then computed — which only matters for
the collision rule of §1. `properties` is current-state, rebuilt by
re-ingest, never by `rebuild_index`.

## 7. Fixtures

`cases/<suite>.json`, `suite` = file stem; case ids `<suite>::<name>`.
Suites: `frontmatter.json` (flattening, typing, ranges, collisions),
`yaml.json` (§4 resolution and failures), `inline.json` (both forms,
masking, card/ord, coercion, containers), `computed.json` (`$title`,
`$tags`), `shapes.json` (grouped/merged), plus mixed cases as coverage grows.

```jsonc
{
  "suite": "inline",
  "cases": [
    {
      "name": "lone-field-is-scalar",
      "notes": "optional prose",
      "source": "---\nlayer: canon\n---\n\n# Title\n\nelement:: fire\n",
      "expect": {                                        // GENERATED
        "rows": [
          { "prop_id": "p_…12 hex…", "block_id": null,  "source": "frontmatter", "key": "layer",   "card": "scalar", "ord": 0, "type": "string", "val_text": "canon", "val_num": null, "val_bool": null, "val_json": null },
          { "prop_id": "p_…",        "block_id": "b_1", "source": "inline",      "key": "element", "card": "scalar", "ord": 0, "type": "string", "val_text": "fire",  "val_num": null, "val_bool": null, "val_json": null },
          { "prop_id": "p_…",        "block_id": null,  "source": "computed",    "key": "$title",  "card": "scalar", "ord": 0, "type": "string", "val_text": "Title", "val_num": null, "val_bool": null, "val_json": null }
        ],
        "grouped": { "frontmatter": { "layer": "canon" }, "inline": { "element": "fire" }, "computed": { "$title": "Title" } },
        "merged":  { "layer": "canon", "element": "fire", "$title": "Title" }
      }
    }
  ]
}
```

**Inputs** (authored): `source` is the exact document; it is parsed per
`spec/format`, the `frontmatter` block split off, and body block ids
assigned `b_0`, `b_1`, … in pre-order over the **body** blocks (the
frontmatter block takes no id). The document id is `d_0`.

**Expect** (generated): `rows` sorted by (`source` rank frontmatter <
inline < computed, `key` bytewise, `ord`); `val_json` carried as parsed
JSON (an object, not a string) and compared as such; `val_num` a JSON
number, or the strings `"Infinity"`, `"-Infinity"`, `"NaN"` for the
non-finite values (§8); `grouped` and `merged` as §5, object key order
ignored. Every row carries all eleven fields.

**Runner checks, per case**: every `prop_id` equals the §1 derivation from
the row's own fields; `prop_id`s are unique; the row set, `grouped` and
`merged` deep-equal the fixture.

**Generation.** `packages/core/corpus/properties/spec.test.ts` asserts the
reference reproduces every committed `expect` and, with
`PROPERTIES_SPEC_UPDATE=1`, rewrites each case's `expect` in place from its
`source`. The reference runs the real ingest into a `:memory:` store and
reads the rows back, so the fixtures pin what the engine writes, not a
helper.

**Allowlist (Rust).** `crates/omgbase-properties/tests/spec-passing.txt`,
same mechanism as the other specs (`PROPERTIES_SPEC_UPDATE=1 cargo test -p
omgbase-properties --test spec`).

## 8. Reference oddities surfaced while specifying, and decisions

- **Fixed — frontmatter came from a regex over the raw source.** The
  reference's Markdown `extractMetadata` matched `^---\r?\n([\s\S]*?)\r?\n---`
  against the whole file and only fell back to the `frontmatter` block when
  that failed, so `---\nfoo: 1\n---bar\n` (no frontmatter block: the closing
  fence is invalid) still produced a `foo` row, and `---\na: 1\n---x: 2\n---`
  lost its second key. The Markdown adapter no longer has `extractMetadata`
  (the YAML/JSON adapters keep theirs for whole-document metadata); §3.1
  makes the `frontmatter` block the only source;
  `frontmatter::invalid-closing-fence-has-no-rows` pins it.
- **Pinned — non-finite numbers.** `.inf`/`-.inf` store as `type = number`
  with `val_num` ±Infinity (SQLite REAL holds infinities); `.nan` stores as
  `type = number` with `val_num = NULL`, because SQLite binds NaN as NULL. A
  row with `type = number` and no `val_num` therefore means NaN. Fixtures
  carry these as the strings `"Infinity"`, `"-Infinity"`, `"NaN"` in rows
  (and `Infinity`/`-Infinity` as strings in the read shapes, where NaN is
  `null`).
- **Not pinned — host-specific YAML values.** A flow-sequence key
  (`[1,2]: u`) stringifies as the host prints it (`"[ 1, 2 ]"` in the
  reference); `!!binary` yields a host byte-buffer object in the json
  escape hatch; `!!timestamp`, `!!set` and `!!omap` values become host
  objects (a `Date`, a `Set`, a `Map`) that flatten to nothing; a tab used as
  a key/value separator (`a:\tb`) is accepted by the reference and rejected
  by the Rust parser; the reference keeps the later of `1: a` and `"1": b`
  where the port treats them as duplicates. Fixtures avoid all of these.
- **Port note — the Rust YAML.** `omgbase-properties` uses `saphyr-parser`
  for structure only and resolves every plain scalar itself with the core
  schema test set in the reference's try order; duplicate keys (compared
  after JavaScript number stringification, so `1`, `01` and `1.0` collide),
  multi-document input and tab indentation are rejected by its own checks.
- **Pinned — `prop_id` collisions resolve last-wins.** An authored
  `meta.owner: a` beside `meta: {owner: b}` produces two rows with the same
  `(source, key, ord)`; `INSERT OR REPLACE` keeps the later one in parser
  order. A fixture must not depend on JavaScript's integer-like-keys-first
  object order (`spec/oqx` records the same host fact); the mapping order the
  YAML parser yields is otherwise the authored order.
- **Pinned — fields inside containers count once per nesting level, and
  marker-line fields not at all.** `- a\n  job:: x` yields two `inline` rows
  for `job` (`ord` 0 with the list's `block_id`, `ord` 1 with the item's);
  `See [k:: v]` inside a blockquote yields two; `- job:: x` yields none (the
  `- ` defeats the line anchor); `> job:: x` yields one, via the nested
  paragraph. Recorded for a decision: the least surprising behavior is one
  occurrence anchored to the innermost block and a marker-line field
  recognized, which would be a minor bump here.
- **Pinned — inline values are not range-detected.** `typed_inline_value`
  never calls `detect_range`, so `window:: 1..5` is a plain string with no
  side channel while the same frontmatter value gets one.
- **Pinned — inline coercion is JavaScript `Number()`.** `0x10` → 16,
  `.5` → 0.5, `5.` → 5, `1e3` → 1000, `+5` → 5; `Infinity`/`NaN` and anything
  with letters or underscores stay strings.
- **Pinned — `$tags` scans `raw`, not `text`, and skips only headings and
  code fences.** A `#tag` inside an `html_block` or an `opaque` block counts,
  and so does one inside an inline code span when whitespace precedes it
  (`` `see #inl` ``); `` `#not` `` does not, because a backtick is not `\s`
  (`computed::tags-inline-code-after-whitespace-counts`,
  `computed::tags-after-backtick-does-not-count`). One in a heading does
  not; a tag at the very start of a paragraph counts (`^`), one after
  punctuation (`(#tag)`) does not (`\s`).
- **Pinned — empty containers vanish.** `a: {}` and `a: []` produce no rows,
  so a key that was authored as an empty list is indistinguishable from an
  absent key.
- **Pinned — `card` for a bare key is per source.** A key with one
  frontmatter scalar and one inline occurrence is two `card = scalar` rows;
  the query layer's single-value gate, not the rows, makes it behave as a
  list.

## Decisions

- 2026-09-26, properties 1.0 specified as built (one fix: frontmatter from
  the block, not a regex). The store spec excludes this table on purpose;
  this spec owns the rows and `spec/store` §5.4 owns when they are written.
  Next in the same series: graph (nodes, edges), then search.
