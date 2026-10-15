# @omgbase/dataview

A **Dataview Query Language (DQL) → OQX** translator. An Obsidian Dataview
query — `TABLE`, `LIST`, `TASK` or `CALENDAR`, with `FROM`, `WHERE`, `SORT`,
`LIMIT`, `GROUP BY` — becomes one OQX string for the omgbase `query` tool plus a
*render shape* that tells a client how to lay the hits out. The package renders
nothing itself.

> Semantics in the engines through the function registry, syntax in a package.

Pure TypeScript. The only runtime dependency is `@omgbase/oqx` (its AST builders
and canonical printer write the expressions, so quoting, escapes and
parentheses are the language's own). It never imports omgbase internals; the
directory can move into an Obsidian plugin as it is.

```ts
import { translate, DqlError } from "@omgbase/dataview";

const { oqx, render, warnings } = translate(
  'TABLE file.mtime, due FROM "projects" WHERE due < date(today) SORT due DESC LIMIT 10',
  { thisPath: "/projects/alpha.md" },
);
// oqx    → select path, updated_at, due from docs
//          where (path.startsWith("/projects/") or path == "/projects.md") and date(due) < date("today")
//          order by due desc limit 10
// render → { type: "table", withoutId: false, grouped: false,
//            id: { name: "File", alias: "path", derive: "link" },
//            columns: [{ name: "file.mtime", alias: "updated_at" }, { name: "due", alias: "due" }] }

const hits = await client.callTool("query", { query: oqx });
// each hit is { id, path, ...projection }: read hit[column.alias] under column.name
```

A query the translator cannot express throws `DqlError` with `code:
"unsupported"` and the Dataview construct in `construct`; malformed DQL throws
`code: "parse"`. Both carry a `position` (`{ offset, line, column }`). The
translator never emits a query that means something other than the DQL —
where Dataview semantics bend (see "Deviations"), `warnings` says so.

## Public API

```ts
translate(dql: string, options?: TranslateOptions): Translation

interface TranslateOptions {
  thisPath?: string | null;                          // the current document (`this`, `[[]]`)
  resolveLink?: (target: string) => string | null;   // [[target]] → a rooted path; null = suffix match
  capabilities?: { groupBy?: boolean; dates?: boolean };
}

interface Translation { oqx: string; render: RenderShape; warnings: string[] }

interface Column { name: string; alias: string; derive?: "basename" | "dirname" | "link" | "ext" }

type RenderShape =
  | { type: "table";    withoutId: boolean; grouped: boolean; id: Column | null; columns: Column[] }
  | { type: "list";     withoutId: boolean; grouped: boolean; id: Column | null; value: Column | null }
  | { type: "task";     grouped: boolean; id: Column | null; rows: string | null;
                        task: { id: "id"; text: "text"; checked: "checked"; path: "path" } }
  | { type: "calendar"; grouped: false; id: Column; date: Column };
```

Also exported: `DqlError`, `parseDql` (the DQL AST), `FUNCTIONS` (the function
table below as data), `FILE_FIELDS`, `TASK_FIELDS`, `NAMED_DATES`.

**Reading a hit.** `id` is the row's identity column — `path` for an
ungrouped query (`derive: "link"`: show it as a link), the group key after
`GROUP BY`, `null` under `WITHOUT ID` (the path is still selected, so a client
can link anyway). A `derive` on a column means the alias holds a `path` and the
client computes the value: `basename` (the name without `.md`), `dirname`,
`ext`, or `link`. OQX has no basename/dirname function, so these are the one
place the client finishes the work. Tags come back **without `#`** (omgbase
stores them bare).

## Targets

| Dataview | omgbase | rows |
| --- | --- | --- |
| `TABLE`, `LIST`, `CALENDAR` | `from docs` | one per document |
| `TASK` | `from blocks where type == "task"` | one per task block: `id`, `text`, `checked`, `path`; the page's fields through `doc.<field>` |

Every query selects `path` first (the hit's identity); `TASK` adds `id`,
`text`, `checked`; `CALENDAR` adds `date: <expr>` and `where has(date)`
(pages without the field have no day, as in Dataview).

## Sources (`FROM`)

Dataview's sources are expressions that pick pages; OQX picks rows with
`where`, so every source becomes a `where` conjunct. `and` / `or` / `-` / `!`
and parentheses compose as written.

| `FROM` | OQX |
| --- | --- |
| `"folder"` | `path.startsWith("/folder/") or path == "/folder.md"` — a bare string is a folder or a note, so both are tested; `"note.md"` is `path == "/note.md"`; `""` is the whole vault |
| `#tag` | `tags exists { where $it == "tag" or $it.startsWith("tag/") }` — nested tags count, as in Dataview |
| `[[note]]` (pages linking **to** note) | `out_links exists { where dst.path.endsWith("/note.md") }` |
| `outgoing([[note]])` (pages note links to) | `in_links exists { where doc.path.endsWith("/note.md") }` |
| `[[]]` | the current document (`thisPath`) |
| `csv("file.csv")` | unsupported |

A `[[target]]` resolves by **suffix** (`path.endsWith("/target.md")`) unless
the client supplies `resolveLink`, which turns it into `path == "/exact.md"`.
`[[note#heading|display]]` keeps only `note`. On a `TASK` query the document's
relations are reached through `doc.` (`doc.tags`, `doc.out_links`).

## Data commands

Dataview applies commands in the order written; OQX has one fixed clause
order. The translator folds conservatively and refuses what it cannot keep
faithful:

| Dataview | OQX |
| --- | --- |
| `WHERE a` `WHERE b` | `where a and b` (in order; after the `FROM` conjunct) |
| `WHERE` after `GROUP BY` | `having` |
| `SORT a DESC, b` | `order by a desc, b` |
| `SORT a` `SORT b` | `order by b, a` — a later sort re-sorts, the earlier order breaks its ties |
| `SORT` before `GROUP BY` | the order of the rows inside each group: `rows collect { … order by … }`; warned about when no column reads the rows |
| `LIMIT n` | `limit n` — must be the last command, a non-negative integer literal |
| `GROUP BY expr [AS name]` | `group by name: expr` (default `key`); one per query |
| `FLATTEN` | unsupported (see below) |

## Expressions

| Dataview | OQX |
| --- | --- |
| `=` `!=` `<` `<=` `>` `>=` | `==` `!=` `<` `<=` `>` `>=` (a date on one side wraps the other in `date()`) |
| `&` `\|` `!` (also `and` `or`) | `and` `or` `!` |
| `+ - * / %` | the same — except on dates, below |
| `"s"`, `'s'`, `1`, `1.5`, `true`, `null` | the same (strings double-quoted) |
| `[a, b]` | the tuple `(a, b)`; `[a]` is `list(a)`; `[]` and `{…}` unsupported |
| `x[0]` | `x first { offset 0 }` (the canonical form of `x[0]`); `x["k"]` is `x.k`; negative or computed indexes unsupported |
| `a.b` | `a.b` |
| bare field `due` | `due` — an authored key with an engine's name (`title`, `tags`, `path`, `id`, …) reads `data.<k>`, the author's value |
| `this.file.path` / `.name` / `.folder` / `.link` / `.ext` | constants from `thisPath` |
| `this.<field>` | `^docs first { where path == "<thisPath>" }.<field>` (the carets count the scope depth) |
| `[[note]]` in a value | unsupported — a link is a value only in `FROM` and `contains(file.inlinks\|outlinks, …)` |
| `(x) => …` | unsupported |
| a field name that is not an identifier (`time-played`) | unsupported (OQX has no string-keyed lookup) |

### Implicit fields

| Dataview | OQX | notes |
| --- | --- | --- |
| `file.path` | `path` | `/`-rooted |
| `file.name` | `path` + `derive: basename` | in a predicate against a literal: `file.name = "x"` → `path.endsWith("/x.md")`, `startswith`/`endswith`/`contains` → a path regex |
| `file.folder` | `path` + `derive: dirname` | `file.folder = "a/b"` → `path ~ "^/a/b/[^/]+$"`; `""` is the root |
| `file.link` | `path` + `derive: link` | `= this.file.link` → `path == …` |
| `file.ext` | `path` + `derive: ext` | `= "md"` → `path.endsWith(".md")` |
| `file.size` | `size(raw)` | code points, not bytes (warned) |
| `file.mtime` | `updated_at` | the last commit's time |
| `file.mday` | `updated_at.date()` | |
| `file.ctime`, `file.cday` | unsupported | no creation time is stored |
| `file.tags` | `tags` | authored tags ∪ body `#hashtags`, bare; membership tests nested tags by prefix |
| `file.etags` | `tags` | exact membership |
| `file.aliases` | `aliases` | the frontmatter key |
| `file.inlinks` | `in_links collect { from doc }` | `length(…)` → `size(in_links)`; `contains(…, [[n]])` → `in_links exists { where doc.path … }` |
| `file.outlinks` | `out_links collect { from dst }` | `contains(…, [[n]])` → `out_links exists { where dst.path … }` |
| `file.tasks` | `blocks collect { where type == "task" }` | |
| `file.lists` | `blocks collect { where type == "list_item" }` | |
| `file.frontmatter` | `entries(frontmatter)`; `file.frontmatter.k` → `frontmatter.k` | |
| `file.day`, `file.starred` | unsupported | |

Task fields (`TASK` queries): `text`/`visual` → `text`; `completed`,
`checked`, `fullyCompleted` → `checked`; `path` → `path`; `blockId` → `id`;
`outlinks` → `out_links collect { from dst }`; `status`, `line`, `section`,
`children`, `parent`, `tags`, … → unsupported (the block model keeps a
checkbox, not a status character or a line number). Any other bare field on a
task reads the **page's** property (`doc.<field>`, warned): omgbase indexes
inline fields per document, not per task.

### Functions

Supported:

| Dataview | OQX |
| --- | --- |
| `contains(x, y)` | `y in x` (string: substring; list: element; object: key) |
| `contains(file.tags, "#t")` | `tags exists { where $it == "t" or $it.startsWith("t/") }` (in `WHERE`); `"t" in tags` in a value |
| `contains(file.inlinks\|outlinks, [[n]])` | the `exists` tests above (`WHERE` only) |
| `econtains(x, y)` | `y in x` |
| `icontains(x, y)` | `x.lower().contains(y.lower())` |
| `containsword(x, "w")` | `x ~ "\bw\b"` |
| `length(x)` | `size(x)`; `length(rows)` → `count()` |
| `lower(x)`, `upper(x)` | `x.lower()`, `x.upper()` |
| `startswith(x, y)`, `endswith(x, y)` | `x.startsWith(y)`, `x.endsWith(y)` |
| `regextest(p, s)` | `s ~ p` |
| `regexmatch(p, s)` | `s ~ "^(?:p)$"` (Dataview matches the whole string) |
| `string(x)` | `` `${x}` `` |
| `default(x, d)` | `x or d` |
| `date(x)`, `dur(x)` | `date(x)`, `dur(x)` — see Dates |
| `dateformat(d, f)` | `d.format(f)` |
| `striptime(d)` | `d.date()` |
| `sum/min/max/average(rows.x)` | `sum(x)` / `min(x)` / `max(x)` / `avg(x)` after `GROUP BY` |
| `any/all/none(rows.p)` | `any(p)` / `all(p)` / `!any(p)` after `GROUP BY` |

Unsupported (each raises `unsupported` naming the function): `object`, `list`,
`array`, `number`, `link`, `elink`, `embed`, `typeof`, `round`, `trunc`,
`floor`, `ceil`, `product`, `reduce`, `minby`, `maxby`, `extract`, `sort`,
`reverse`, `nonnull`, `join`, `filter`, `map`, `flat`, `slice`, `unique`,
`regexreplace`, `replace`, `split`, `padleft`, `padright`, `substring`,
`truncate`, `ldefault`, `choice`, `hash`, `durationformat`, `localtime`,
`meta`, `currencyformat`; `sum`/`min`/`max`/`average`/`any`/`all`/`none`
outside `GROUP BY`; `date(text, format)`. An unknown name is unsupported too.

## Dates and durations

The output follows the **surface 4.8 date contract** (`spec/surface` §1.3
"Dates and durations", landed in the TypeScript reference): `date(x)` returns
a canonical ISO string (named points `now today yesterday tomorrow sow eow som
eom soy eoy`, or ISO text canonicalized), `dur(x)` a number of seconds parsed
from Dataview's duration grammar (`"1 hour 30 minutes"`, `"1h30m"`, `"2
weeks, 3 days"`, `PT1H30M`), and the methods `.plus(d)`, `.minus(d)`,
`a.until(b)` (seconds), `.year() .month() .day() .weekday() .hour() .minute()
.second() .date() .format(p)`. Every function is total (a non-date is
absent), so a `WHERE` over mixed pages filters quietly.

- Dataview's bare literals become the quoted forms: `date(today)` →
  `date("today")`, `date(2026-10-15)` → `date("2026-10-15")`, `dur(1 hour 30
  minutes)` → `dur("1 hour 30 minutes")`. A bare word that is not a named point
  stays a field (`dur(day)` → `dur(day)`, `date(due)` → `date(due)`).
- Arithmetic between a date and a duration is **never** `+`/`-` (string `+`
  concatenates in OQX): `date + dur` → `date.plus(…)`, `date - dur` →
  `date.minus(…)`. A duration **literal** is passed as its string —
  `date(today) + dur(1 month)` → `date("today").plus("1 month")` — because a
  duration string shifts the calendar month (Jan 31 + 1 month = Feb 28, as in
  Dataview) while `dur("1 month")` is a fixed 30 days of seconds; a computed
  duration is passed as the number. `a - b` on two dates is **`b.until(a)`** —
  seconds from `b` to `a`, positive when `a` is later, Dataview's sign. `dur +
  dur` stays `+` (numbers).
- `dateformat` patterns pass through; the surface's tokens are `yyyy MM dd HH
  mm ss MMM EEE` and every other letter prints literally, so a Luxon pattern
  using `MMMM`, `EEEE`, `h` or `a` is warned about.
- A field compared with a date is wrapped: `due < date(today)` → `date(due) <
  date("today")`, so an authored `2026-10-15` compares as a date.
- A field in date arithmetic is taken for a date (`due + dur(1 week)` →
  `due.plus(dur("1 week"))`) and warned about; `date - field` reads the field
  as a date and yields a duration.
- Duration components (`.hours`, `.days`) and `date.week` have no counterpart.

## Grouping

The output assumes **spec/oqx 0.24 grouping** (in flight): `group by <alias:
expr>` after `where`, before `order by`; `having`; the aggregates `count()
sum(e) min(e) max(e) avg(e) collect(e) first(e) last(e) any(p) all(p)`; `rows`
as the group's row collection and a receiver (`rows collect { … }`); a `select`
under a group names only the key, aggregates and `rows`-derived values.

| Dataview | OQX |
| --- | --- |
| `GROUP BY author` | `group by key: author`; the key is `key` (or the `AS` name) |
| `rows.title` | `collect(title)` |
| `rows.file.link` | `collect(path)` (`derive: link`) |
| `rows` | `rows collect { select path }` (tasks: `id, text, checked, path`) |
| `length(rows)` | `count()` |
| `sum(rows.x)` … | `sum(x)` … |
| `WHERE` after | `having …` |
| `SORT` before | `rows collect { x values order by … }` |

Grouping by `file.folder` or `file.name` is unsupported (no dirname/basename;
grouping by `path` instead would silently make one group per document).
`GROUP BY file.link` works (the path *is* the key). A page field after `GROUP
BY` is unsupported — Dataview reads it as null there.

## Capabilities

`capabilities: { groupBy, dates }` says what the server can do; a client sets
them from the server's `version` (surface ≥ 4.8 → `dates`, OQX ≥ 0.24 →
`groupBy`). Both default to `true`, so the output is pure OQX. With a
capability off, a query that needs it is refused as `unsupported` naming the
feature. There is **no client-side fallback yet** (re-grouping or date
arithmetic over fetched rows) — the translation is complete and tested, the
fallback is the next step.

## Not supported

- `FLATTEN` — one row per list element next to the page's fields. An OQX
  body-level `from` re-projection replaces the row (the page is not reachable
  from the element, spec/oqx §2) and a lift binds a list, not a fan-out.
- A second `GROUP BY`; `CALENDAR … GROUP BY`; `LIMIT` anywhere but last.
- `csv(…)` sources; `[[link]]` literals as values; lambdas; object literals;
  list literals with zero elements; computed or negative indexes.
- `file.ctime`, `file.cday`, `file.day`, `file.starred`; a task's `status`,
  `line`, `section`, `children`, `parent`, own `tags`.
- Field names that are not identifiers (`time-played`).
- Inline DQL (`= expr`), `$=` and DataviewJS.

## Deviations (documented, warned where it matters)

- `file.name`, `file.folder`, `file.link`, `file.ext` are `path` plus a
  client-side derivation; in a predicate they compare only with literals (or
  `this.file.*`); `SORT file.name` orders by the full path (warned).
- `default(x, d)` is `x or d`: `0`, `""` and `false` also fall through to `d`
  (Dataview falls through on null only).
- `file.size` is a code-point count (`size(raw)`), not bytes.
- `contains(file.tags, "#t")` in a value position tests the exact tag (nested
  tags match only in `WHERE`).
- `regexmatch` with a computed pattern is unanchored.
- A task's inline fields read the page's property.
- `file.etags` and `file.tags` are both `tags` (omgbase does not expand parent
  tags; the difference is in how membership is tested).

## Tests

```
pnpm --filter @omgbase/dataview test
```

`test/cases/*.json` is the golden corpus (`{ dql, options?, oqx, render,
warnings }` or `{ dql, error }`), generated by the translator and reviewed as
code; `DATAVIEW_CASES_UPDATE=1 node --test test/cases.test.ts` regenerates it.
Every ungrouped case is also parsed by `@omgbase/oqx` and must satisfy the
canonical printer's round-trip law, so the output is OQX the engine accepts
today; the grouped cases are checked for shape until spec/oqx 0.24 lands.
