# @omgbase/dataview

A **Dataview Query Language (DQL) → OQX** translator. An Obsidian Dataview
query — `TABLE`, `LIST`, `TASK` or `CALENDAR`, with `FROM`, `WHERE`, `SORT`,
`LIMIT`, `FLATTEN`, `GROUP BY` — becomes one OQX string for the omgbase `query` tool plus a
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
// oqx    → docs { select _path, _updated_at, due
//          where (_path.startsWith("/projects/") or _path == "/projects.md") and date(due) < date("today")
//          order by due desc limit 10 }
// render → { type: "table", withoutId: false, grouped: false,
//            id: { name: "File", alias: "_path", derive: "link" },
//            columns: [{ name: "file.mtime", alias: "_updated_at" }, { name: "due", alias: "due" }] }

const hits = await client.callTool("query", { query: oqx });
// each hit is { _id, _path, ...projection }: read hit[column.alias] under column.name
```

The output speaks **surface 5.0** ("underscore = engine", `spec/surface` §1.2):
an underscore-prefixed name is the engine's (`_path`, `_tags`, `_updated_at`,
`_in_links`, …) and a bare name is the author's (a frontmatter or inline key on
a page, an `attrs` key such as `checked` on a task). Dataview draws the same
line — `file.*` and the task metadata are the engine's, a bare field is the
page's property — so `file.<x>` becomes a `_` name and a bare field stays bare
(`title` is the authored `title`, never the computed `_title`; nothing bare is
reserved).

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
  capabilities?: { groupBy?: boolean; dates?: boolean; flatten?: boolean };
}

interface Translation { oqx: string; render: RenderShape; warnings: string[] }

interface Column { name: string; alias: string; derive?: "basename" | "dirname" | "link" | "ext" }

type RenderShape =
  | { type: "table";    withoutId: boolean; grouped: boolean; id: Column | null; columns: Column[] }
  | { type: "list";     withoutId: boolean; grouped: boolean; id: Column | null; value: Column | null }
  | { type: "task";     grouped: boolean; id: Column | null; rows: string | null;
                        task: { id: string; text: string; checked: string; path: "_path" } }
  | { type: "calendar"; grouped: false; id: Column; date: Column };
```

Also exported: `DqlError`, `parseDql` (the DQL AST), `FUNCTIONS` (the function
table below as data), `FILE_FIELDS`, `TASK_FIELDS`, `NAMED_DATES`.

**Reading a hit.** `id` is the row's identity column — `_path` for an
ungrouped query (`derive: "link"`: show it as a link), the group key after
`GROUP BY`, `null` under `WITHOUT ID` (the path is still selected, so a client
can link anyway). A `derive` on a column means the alias holds a `_path` and the
client computes the value: `basename` (the name without `.md`), `dirname`,
`ext`, or `link`. OQX has no basename/dirname function, so these are the one
place the client finishes the work. Tags come back **without `#`** (omgbase
stores them bare). After a `FLATTEN` every hit is still the page — `_id` and
`_path` repeat per element, as Dataview repeats the page link — with the bound
name's value beside them; a bound task or document renders as `{ _id, _path }`,
so read its fields through a column (`t.text`) rather than the row. A `TASK`
query's `task` names the aliases of its four values: `_id`/`_text`/`checked`/`_path`
on a plain `TASK`, `task_id`/`text`/`checked`/`_path` after `FLATTEN file.tasks`
(the page owns `_id` there).

## Targets

| Dataview | omgbase | rows |
| --- | --- | --- |
| `TABLE`, `LIST`, `CALENDAR` | `docs { … }` | one per document |
| `TASK` | `blocks { … where _type == "task" }` | one per task block: `_id`, `_text`, `checked`, `_path`; the page's fields through the `_doc` handle (`_doc.<field>`, `_doc._tags`) |

Every query selects `_path` first (the hit's identity); `TASK` adds `_id`,
`_text`, `checked`; `CALENDAR` adds `date: <expr>` and `where has(date)`
(pages without the field have no day, as in Dataview).

## Sources (`FROM`)

Dataview's sources are expressions that pick pages; OQX picks rows with
`where`, so every source becomes a `where` conjunct. `and` / `or` / `-` / `!`
and parentheses compose as written.

| `FROM` | OQX |
| --- | --- |
| `"folder"` | `_path.startsWith("/folder/") or _path == "/folder.md"` — a bare string is a folder or a note, so both are tested; `"note.md"` is `_path == "/note.md"`; `""` is the whole vault |
| `#tag` | `_tags exists { where $it == "tag" or $it.startsWith("tag/") }` — nested tags count, as in Dataview |
| `[[note]]` (pages linking **to** note) | `_out_links exists { where _dst._path.endsWith("/note.md") }` |
| `outgoing([[note]])` (pages note links to) | `_in_links exists { where _doc._path.endsWith("/note.md") }` |
| `[[]]` | the current document (`thisPath`) |
| `csv("file.csv")` | unsupported |

A `[[target]]` resolves by **suffix** (`_path.endsWith("/target.md")`) unless
the client supplies `resolveLink`, which turns it into `_path == "/exact.md"`.
`[[note#heading|display]]` keeps only `note`. On a `TASK` query the document's
attributes and relations are reached through the `_doc` handle (`_doc._tags`,
`_doc._out_links`, `_doc._path`).

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
| `SORT` before `GROUP BY` | the order of the rows inside each group: `rows { … order by … }`; warned about when no column reads the rows |
| `LIMIT n` | `limit n` — must be the last command, a non-negative integer literal |
| `GROUP BY expr [AS name]` | `group by name: expr` (default `key`); one per query |
| `FLATTEN expr [AS name]` | `flatten <expr> as <name>` (spec/oqx 0.25); several chain in order; see "Flatten" |
| `WHERE` after `FLATTEN` | split by what each conjunct reads: the page's → `where`, one element's → that flatten's block, a mix → unsupported |
| `FLATTEN` after `GROUP BY` | unsupported (OQX's clause order puts `flatten` before `group by`) |

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
| bare field `due` | `due` — the authored key, bare; nothing is reserved, so `title`, `tags`, `path`, `id` are the author's keys too (the engine's are `_title`, `_tags`, `_path`, `_id`). A key that itself begins with `_` is read through the merged authored view, `_data.<k>` (warned) |
| `this.file.path` / `.name` / `.folder` / `.link` / `.ext` | constants from `thisPath` |
| `this.<field>` | `^docs first { where _path == "<thisPath>" }.<field>` (the carets count the scope depth) |
| `[[note]]` in a value | unsupported — a link is a value only in `FROM` and `contains(file.inlinks\|outlinks, …)` |
| `(x) => …` | unsupported |
| a field name that is not an identifier (`time-played`) | unsupported (OQX has no string-keyed lookup) |

### Implicit fields

| Dataview | OQX | notes |
| --- | --- | --- |
| `file.path` | `_path` | `/`-rooted |
| `file.name` | `_path` + `derive: basename` | in a predicate against a literal: `file.name = "x"` → `_path.endsWith("/x.md")`, `startswith`/`endswith`/`contains` → a path regex |
| `file.folder` | `_path` + `derive: dirname` | `file.folder = "a/b"` → `_path ~ "^/a/b/[^/]+$"`; `""` is the root |
| `file.link` | `_path` + `derive: link` | `= this.file.link` → `_path == …` |
| `file.ext` | `_path` + `derive: ext` | `= "md"` → `_path.endsWith(".md")` |
| `file.size` | `size(_raw)` | code points, not bytes (warned) |
| `file.mtime` | `_updated_at` | the last commit's time |
| `file.mday` | `_updated_at.date()` | |
| `file.ctime` | `_created_at` | when omgbase **first observed** the document (surface 4.10), not the file's creation time (warned) |
| `file.cday` | `_created_at.date()` | the first observation's day (warned) |
| `file.tags` | `_tags` | authored `tags` ∪ body `#hashtags`, bare; membership tests nested tags by prefix |
| `file.etags` | `_tags` | exact membership |
| `file.aliases` | `aliases` | the authored frontmatter key, bare |
| `file.inlinks` | `_in_links { from _doc }` | `length(…)` → `size(_in_links)`; `contains(…, [[n]])` → `_in_links exists { where _doc._path … }` |
| `file.outlinks` | `_out_links { from _dst }` | `contains(…, [[n]])` → `_out_links exists { where _dst._path … }` |
| `file.tasks` | `_blocks { where _type == "task" }` | |
| `file.lists` | `_blocks { where _type == "list_item" }` | |
| `file.frontmatter` | `entries(_frontmatter)`; `file.frontmatter.k` → `_frontmatter.k` | |
| `file.day`, `file.starred` | unsupported | |

`file.name` has no `_title` counterpart: Dataview's `file.name` is the
basename, and omgbase's `_title` is a computed title (the first heading or the
authored `title`), so the basename stays a client-side derivation from `_path`.

Task fields (`TASK` queries): `text`/`visual` → `_text`; `completed`,
`checked`, `fullyCompleted` → `checked` (an `attrs` key — the author's, bare);
`path` → `_path`; `blockId` → `_id`; `outlinks` → `_out_links { from
_dst }`; `status`, `line`, `section`, `children`, `parent`, `tags`, … →
unsupported (the block model keeps a checkbox, not a status character or a
line number). Any other bare field on a task reads the **page's** property
through the `_doc` handle (`_doc.<field>`, warned): omgbase indexes inline
fields per document, not per task.

### Functions

Supported:

| Dataview | OQX |
| --- | --- |
| `contains(x, y)` | `y in x` (string: substring; list: element; object: key) |
| `contains(file.tags, "#t")` | `_tags exists { where $it == "t" or $it.startsWith("t/") }` (in `WHERE`); `"t" in _tags` in a value |
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
as the group's row collection and a receiver (`rows { … }`); a `select`
under a group names only the key, aggregates and `rows`-derived values.

| Dataview | OQX |
| --- | --- |
| `GROUP BY author` | `group by key: author`; the key is `key` (or the `AS` name) |
| `rows.title` | `collect(title)` (the authored `title`) |
| `rows.file.link` | `collect(_path)` (`derive: link`) |
| `rows` | `rows { select _path }` (tasks: `_id, _text, checked, _path`) |
| `length(rows)` | `count()` |
| `sum(rows.x)` … | `sum(x)` … |
| `WHERE` after | `having …` |
| `SORT` before | `rows { x values order by … }` |

Grouping by `file.folder` or `file.name` is unsupported (no dirname/basename;
grouping by `_path` instead would silently make one group per document).
`GROUP BY file.link` works (the path *is* the key). A page field after `GROUP
BY` is unsupported — Dataview reads it as null there. The key's `AS` name may
not be in the engine's `_` namespace (`AS _path`), as no user-chosen name is.

## Flatten

`FLATTEN <expr> [AS name]` is OQX 0.25's `flatten <expr> as <name>` (spec/oqx
SEMANTICS §25): after `where`, before `group by`, one clause per `FLATTEN` in
writing order (a later one reads the names earlier ones bound); each page row
becomes one row per element with the name bound beside the page's fields —
`_id`/`_path` repeat per element. The name is the `AS`, else the last segment of
a field path (`FLATTEN file.tasks` binds `tasks`, `FLATTEN j.tags` binds
`tags`, Dataview's rule); any other expression needs `AS`. A bound name shadows
every other reading of it for the rest of the query (a column, `SORT`, `GROUP
BY`, a later `FLATTEN`, `rows.<name>`); the bare namespace is the user's, so
`FLATTEN file.tags` binding `tags` shadows only the authored `tags` — `file.tags`
(`_tags`) still reads the page. A name in the engine's `_` namespace (`AS _id`,
`AS _path` — the hit envelope — or any `_x`), `file`, `this`, `rows`, `key`, a
column the query selects and a name already bound are refused.

| Dataview | OQX | element |
| --- | --- | --- |
| `FLATTEN file.tasks [AS t]` | `flatten _blocks { where _type == "task" } as t` | a task block: `t.text` → `t._text`, `t.completed` → `t.checked`, `t.blockId` → `t._id`, `t.outlinks`; an inline field reads the page (`t._doc.due`, warned); `t.file` is refused |
| `FLATTEN file.lists [AS l]` | `flatten _blocks { where _type == "list_item" } as l` | a list-item block |
| `FLATTEN file.outlinks [AS o]` | `flatten _out_links { from _dst } as o` | the linked document: `o.file.name` → `o._path` (`derive: basename`), `o.file.mtime` → `o._updated_at`, `o.<field>` |
| `FLATTEN file.inlinks [AS i]` | `flatten _in_links { from _doc } as i` | the linking document |
| `FLATTEN file.tags` / `file.etags` `[AS x]` | `flatten _tags { } as x` | one string; the empty block makes the value a collection — Dataview's `file.tags` is `[]` on a page without tags (no row), while OQX fans an absent value out to one row |
| `FLATTEN file.aliases [AS x]` | `flatten aliases { } as x` | one string (the authored key, the same block) |
| `FLATTEN authors [AS a]` (an authored field) | `flatten authors as a` | the element as it is; absent → one row with `a` absent (Dataview's rule) |
| `FLATTEN j.tags`, `this.related`, `length(x) AS n`, `file.frontmatter AS e` | the expression itself | a bound name's member, an outer reference, a computed value, an `entries(_frontmatter)` entry |
| `FLATTEN file.name` / `file.folder` / `file.link` / `file.ext` | unsupported | one derived string, not a list |

**The WHERE split.** OQX's `where` runs *before* `flatten` and there is no
post-flatten filter on ungrouped rows, so a `WHERE` written after a `FLATTEN`
is split at its top-level `&`/`and` into conjuncts:

- a conjunct that reads only the page (no bound name) → the body `where` —
  Dataview applies commands sequentially, but a page predicate holds the same
  before and after the fan-out, so moving it is semantics-preserving;
- a conjunct that reads only **one** bound element → that flatten's block
  (`FLATTEN file.tasks AS t WHERE t.completed` → `flatten _blocks {
  where _type == "task" and checked } as t`; `FLATTEN file.tags AS tag WHERE tag
  != "draft"` → `flatten _tags { where $it != "draft" } as tag`):
  filtering the elements before the fan-out is filtering the flattened rows by
  the element, and a parent whose elements all fail yields no row — Dataview's
  result for the same `WHERE`;
- a conjunct that mixes the element with the page (`t.completed | status =
  "open"` as one disjunction) or two bound names (`a = b`) → `unsupported`
  naming the predicate: it has no spelling. `this.*` counts for neither side.

So `WHERE t.completed & status = "open"` becomes `where status == "open" flatten
_blocks { where _type == "task" and checked } as t`. An element conjunct
on an **authored** field (or a bound name's member) reads it through `list(…)` —
`flatten list(authors) { where $it != "anon" } as a` — because a block
over a scalar is an eval error and `list` makes a scalar a one-row collection
while leaving a list alone; a page where the field is absent then yields no
row, where Dataview keeps one with the name null when the test passes null
(warned).

`SORT` and `LIMIT` after a `FLATTEN` order and bound the flattened rows
(`order by t.text`, `limit 10`), as in Dataview. `GROUP BY` after a `FLATTEN`
groups them: the tag census `TABLE length(rows) AS n FLATTEN file.tags AS tag
GROUP BY tag SORT length(rows) DESC` is `docs { select key, n: count()
flatten _tags { } as tag group by key: tag order by count() desc }`, and
`rows.t.text` is `collect(t._text)`; a bound name read after the `GROUP BY` (not
as the key) is refused like a page field (Dataview reads it as null). A
`FLATTEN` written after a `GROUP BY` is refused — OQX's clause order has no
place for it. A `CALENDAR` whose date reads a bound name is refused (the
`has(date)` filter runs before the fan-out).

**`TASK` and `FLATTEN file.tasks`.** A plain `TASK` row is a task block, so a
`FLATTEN file.tags AS tag` on it is `flatten _doc._tags { } as tag` over
`blocks { … }`. `TASK … FLATTEN file.tasks [AS t]` re-roots the query at the
page: `docs { … flatten _blocks { where _type == "task" … } as t }`, the
bare task fields (`completed`, `text`, …) read the bound task — in a `WHERE`
before or after the `FLATTEN` — and the shape is `select _path, task_id: t._id,
text: t._text, checked: t.checked` (`render.task` names the aliases; grouped,
`rows { _path, task_id: t._id, text: t._text, checked: t.checked }`). The
only other reading — a task row fanned out over its own page's tasks — is a
cross product of a task with its siblings, which no author means. A second
`FLATTEN file.tasks` on a `TASK` is refused.

## Capabilities

`capabilities: { groupBy, dates, flatten }` says what the server can do; a
client sets them from the server's `version` (surface ≥ 4.8 → `dates`, OQX ≥
0.24 → `groupBy`, OQX ≥ 0.25 → `flatten`). All default to `true`, so the
output is pure OQX. With a
capability off, a query that needs it is refused as `unsupported` naming the
feature. There is **no client-side fallback yet** (re-grouping or date
arithmetic over fetched rows) — the translation is complete and tested, the
fallback is the next step.

## Not supported

- `FLATTEN` after `GROUP BY`; a `WHERE` conjunct after `FLATTEN` that mixes a
  flattened element with the page (or two flattened names); `FLATTEN … AS _x`
  (the engine's `_` namespace, the hit envelope `_id`/`_path` included) or `AS
  file`/`this`/`rows`/`key`; `GROUP BY … AS _x`; `FLATTEN` of a path-derived
  field (`file.name`); a second `FLATTEN file.tasks` on a `TASK`; `CALENDAR`
  over a flattened date.
- A second `GROUP BY`; `CALENDAR … GROUP BY`; `LIMIT` anywhere but last.
- `csv(…)` sources; `[[link]]` literals as values; lambdas; object literals;
  list literals with zero elements; computed or negative indexes.
- `file.day`, `file.starred`; a task's `status`, `line`, `section`,
  `children`, `parent`, own `tags`.
- Field names that are not identifiers (`time-played`).
- Inline DQL (`= expr`), `$=` and DataviewJS.

## Deviations (documented, warned where it matters)

- `file.name`, `file.folder`, `file.link`, `file.ext` are `_path` plus a
  client-side derivation; in a predicate they compare only with literals (or
  `this.file.*`); `SORT file.name` orders by the full path (warned).
- `file.ctime` / `file.cday` are `_created_at`: when omgbase first observed
  the document, not the file system's creation time (warned).
- `default(x, d)` is `x or d`: `0`, `""` and `false` also fall through to `d`
  (Dataview falls through on null only).
- `file.size` is a code-point count (`size(_raw)`), not bytes.
- `contains(file.tags, "#t")` in a value position tests the exact tag (nested
  tags match only in `WHERE`).
- `regexmatch` with a computed pattern is unanchored.
- A task's inline fields read the page's property (`_doc.<field>`).
- `file.etags` and `file.tags` are both `_tags` (omgbase does not expand parent
  tags; the difference is in how membership is tested).
- A column `AS` name in the engine's `_` namespace (`due AS _due`) is not
  taken as the OQX alias (the hit would carry a `_` key that is not the
  engine's); the column falls back to the field's own name or `c<i>`, and
  `render.columns[i].name` still shows the header as written.
- A `WHERE` on a flattened authored field drops a page where the field is
  absent (`list(…)` makes the block legal over a scalar); Dataview keeps a null
  row when the test passes null. Implicit list fields (`file.tags`, …) and
  the block/document flattens agree with Dataview exactly.

## Tests

```
pnpm --filter @omgbase/dataview test
```

`test/cases/*.json` is the golden corpus (`{ dql, options?, oqx, render,
warnings }` or `{ dql, error }`), generated by the translator and reviewed as
code; `DATAVIEW_CASES_UPDATE=1 node --test test/cases.test.ts` regenerates it.
Every successful case is also parsed whole by `@omgbase/oqx` (0.25: `group by`,
`having` and `flatten` included) and must satisfy the canonical printer's
round-trip law, so the output is OQX the engine accepts today.
