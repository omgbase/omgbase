# OQX corpus fixtures

Fixture repositories for high-level OQX tests — queries run against a realistic
interlinked corpus rather than three throwaway documents. Unit-level coverage
(grammar, lowering, SQL shape) lives in `src/oqx/*.test.ts`.

## `fixtures/alchemy/` — 18 markdown documents

A small knowledge repository on the subject of alchemy. Chosen because it
naturally produces the structure OQX needs to be exercised: a hub document, typed
entities that cross-reference each other, notes at different levels of
confidence, and laboratory notebooks with open and completed work.

```
index.md                  hub, links to everything, no tasks
substances/               prima-materia, philosophers-stone, mercury, sulphur, salt
processes/                magnum-opus, calcination, dissolution, coagulation
practitioners/            maria-prophetissa, jabir-ibn-hayyan, paracelsus, newton
texts/                    emerald-tablet, mutus-liber
lab/                      2026-01-notes, 2026-02-notes
```

Every file round-trips byte-identically through the parser (asserted in
`alchemy.test.ts`), so no query result can be an artefact of a mangled parse.

### Frontmatter schema

| Key | Cardinality | Values |
|---|---|---|
| `type` | scalar | `hub` · `substance` · `process` · `practitioner` · `text` · `lab-note` |
| `layer` | scalar | `canon` · `working` · `draft` |
| `tradition` | scalar | `western` · `islamic` · `alexandrian` |
| `era` | scalar (number) | 250 · 800 · 1530 · 1677 · 1680 |
| `verified` | scalar (bool) | 4 documents are `false` |
| `tags` | **list, except `mercury.md` which is scalar** | exercises `list()` polymorphism |
| `element`, `stage`, `stages`, `month` | scalar | on the documents where they apply |
| `slug` | scalar | on every substance and process; equals the filename base, and a `[[wikilink]]`'s value IS a slug — so links resolve to documents by `slug == value` (the join key) |
| `subject` | scalar | on the two lab notes; a process `slug`, naming the notebook's subject for a 1:1 `single(...)` lookup |

### Where tasks live (a corpus convention, asserted by the tests)

Actionable work belongs in the **lab notebooks**. Reference pages — substances,
processes, practitioners, texts — state open questions as **prose bullets**, not
checkboxes, so a query for outstanding work returns the notebooks rather than
every page that ever raised a question.

The one exception is `substances/salt.md`, which carries a short **supply** list
("buy more salt of tartar") — and every item is checked. That makes it the
deliberate **discriminator**: it is the only substance page with task nodes, and
it has no *open* ones, so `nodes exists { where kind == "md:task" }` and
`nodes exists { where kind == "md:task" && !attrs.checked }` return provably
different sets. Several tests depend on this; keep it fully checked.

### Structure the corpus exercises

- **Task nodes** (`md:task`) — 11 documents carry tasks; 10 have at least one
  open. Distribution: both lab notes (7 and 4), the four process pages, three
  practitioners, `texts/mutus-liber.md`, and salt's checked supply list.
- **Task-free documents** — seven of them, including `index.md`,
  `substances/mercury.md`, `practitioners/maria-prophetissa.md`, and
  `texts/emerald-tablet.md`. A correlated subquery must never return these; an
  uncorrelated one would.
- **Links** — `md:link` (markdown) and `md:wikilink` (`[[…]]`), both present, and
  some documents use only one kind (`texts/emerald-tablet.md` has no wikilinks).
- **Inline fields** (`md:inline_field`, `key:: value`) — currently stored as
  **list-cardinality** properties (so `in list(k)` matches and a scalar `==` does
  not), and the value regex captures a single token (`known_for:: tria prima`
  yields `tria`). Both behaviours are being reworked on the `inline-properties`
  branch, so the two tests that touch them are written to hold either way —
  `in list(k)` spans all cardinalities, and the value is asserted by prefix.
- **Block variety** — code fences (5 docs), tables (5), blockquotes (4), plus
  headings, lists, and paragraphs.
- **Section scoping** — the reference pages carry an `## Open questions` section
  of prose bullets (`list_item`), while `processes/magnum-opus.md` has an
  identically-titled section of `- [ ]` checkboxes (block type `task`). This
  makes `under_heading("Open questions")` testable *and* gives the
  `list_item`-vs-`task` type filter a real discriminator (not luck). It also
  exercises the `md:section` nodes and the `section.blocks` / `block.section`
  relations (asserted to navigate the same content as `under_heading`).
- **Lifts (`^name`)** — the open tasks distributed across ten documents (both
  lab notes, three practitioners, all four processes, mutus-liber) let a single
  `from docs where nodes collect { ^open: value where kind == "md:task" &&
  !attrs.checked } select $path, open` both filter to those docs and capture each
  one's open-task texts. salt's all-checked supply list is the discriminator
  again: an any-task lift captures salt, an open-task lift drops it.
- **Correlation & joins (`^name` outer references + `$repo.*` roots)** — the
  wikilink graph is the join fixture. `slug` on every substance/process is the
  key a `[[wikilink]]` value matches, so:
  - a *dependent join* resolves each document's outgoing wikilinks to the
    documents they name (`$repo.docs collect { where slug in ^refs }`), with
    `prima-materia.md`'s lone `[[nigredo]]` (no target document) as the dangling
    reference that resolves to `[]`;
  - a *semi-join* finds the substances any wikilink actually points to —
    mercury, salt, sulphur — over the global `$repo.nodes` scan, and the *anti-join*
    the two (philosophers-stone, prima-materia) named only in prose;
  - a *self-join* on `tradition` pairs the two western practitioners (Newton,
    Paracelsus) while the sole Islamic (Jabir) and Alexandrian (Maria) holders
    get `[]` — exercising two `^` correlations plus self-exclusion (`^tradition`,
    `^me`);
  - `single { … }` / `first { … }` look up each lab note's `subject` process as one
    cardinality-checked record (slug is unique, so `single` is safe).
- **Order by (`order by <expr> [asc|desc]`)** — the four practitioners have
  distinct `era` values (250 / 800 / 1530 / 1680), so `order by era` sorts them
  Maria → Jabir → Paracelsus → Newton (numeric, not lexical), `desc` reverses,
  and `$repo.docs first { … order by era desc }` is Newton. Ranking is how `semantic()` /
  bm25 scores become a top-K.
- **Top-level consumers (`$repo.<target> <op> { … }`)** — a postfix directive over
  a root receiver shapes the whole result, over the 18-document corpus:
  `$repo.docs count` folds a set to a number (18 total, 5 substances),
  `$repo.docs exists` to a boolean, `$repo.docs first` to the first document in path
  order (`index.md`, which sorts before every subdirectory), and `$repo.docs single`
  to the sole `draft` document (`texts/mutus-liber.md`) — while
  `$repo.docs single { where layer == "canon" }` fails loudly because 13 documents
  match.
- **Recursive `follow`** — the corpus is ingested through `processCheckpoint`
  (the real sync path) so the wikilink/markdown-link graph is extracted to
  doc→doc `references` edges (64 of them), which the **citation-graph** demos
  walk: `follow doc.out` (outgoing), `follow doc.in` (backlinks). It exercises
  every follow feature — `distinct` (philosophers-stone's 10-document transitive
  citation closure) vs default per-path occurrences (56), a post-walk `$depth`
  filter (the 5 documents that directly cite magnum-opus), **cyclic-safety**
  (`$stop == "cycle"` — paracelsus ⇄ index is admitted once, never looped),
  `frontier type == "practitioner"` (biographies as the edge of the walk),
  `by type` (re-keying identity so the walk stops when a document *type*
  repeats), and `$ordinal`. The **structural** relations ride the heading
  outline (`section.children` — magnum-opus's `#` over four `##`, with `$leaf`)
  and the block tree (`block.children` — a bullet list down to its items),
  including a **nested follow-collect** projecting each process document's
  outline as a subtree.

### Adding to the corpus

Assertions in `alchemy.test.ts` pin exact document sets, so editing a fixture
will fail tests by design — that is the point. If you add a document:

- put actionable checkboxes in a **lab note**, not on a reference page;
- keep `salt.md`'s supply list **fully checked** (several tests use it as the
  has-tasks / has-open-tasks discriminator);
- give a substance/process a `slug` (= filename base) if anything wikilinks it,
  and keep the wikilink graph in mind — the correlation AND `follow doc.out/in`
  tests pin exact resolved sets (the graph is extracted to `references` edges by
  the `processCheckpoint` ingest), including `prima-materia.md`'s deliberately
  dangling `[[nigredo]]`;
- update the affected expectations, and re-check the task counts in the
  `collect` and blocks-target tests.
