// The implicit-field map (Dataview "Metadata on Pages" → `file.*`; "Metadata on
// Tasks" → the task fields) onto the omgbase surface's bare attributes
// (spec/surface §1.2). Dataview keeps engine attributes under `file.*`;
// omgbase's are bare (`path`, `title`, `tags`, `updated_at`, `raw`, `hash`, `id`).
//
// Each entry says how a field is read: an OQX attribute (`attr`), a value
// derived from `path` on the client (`derive` — OQX has no basename/dirname
// function, so `file.name` is `path` plus a client-side derivation; in a
// predicate against a literal the translator rewrites it to a path test, see
// expressions.ts), a relation rendered as a collect (`collect`), a handle
// (`frontmatter`), or `unsupported` with the reason.

export type Derive = "basename" | "dirname" | "link" | "ext";

/** The static kind the translator tracks for an expression — enough to pick the
 * date/duration methods over `+`/`-` and to wrap a field in `date()` when it is
 * compared with a date. */
export type Kind =
  | "date" | "duration" | "number" | "string" | "boolean" | "list"
  | "tags" // the expanded tag list (`#a/b` counts as `#a`): prefix semantics on membership
  | "etags" // exact tags
  | "inlinks" | "outlinks" | "unknown";

export type FileField =
  | { read: "attr"; attr: string; kind: Kind; warning?: string }
  | { read: "derive"; derive: Derive }
  | { read: "collect"; relation: string; body: "from doc" | "from dst" | 'where type == "task"' | 'where type == "list_item"'; kind: Kind }
  | { read: "frontmatter" }
  | { read: "unsupported"; reason: string };

/** `file.<name>` on a page (Dataview "Metadata on Pages"). */
export const FILE_FIELDS: Readonly<Record<string, FileField>> = {
  path: { read: "attr", attr: "path", kind: "string" },
  name: { read: "derive", derive: "basename" },
  folder: { read: "derive", derive: "dirname" },
  link: { read: "derive", derive: "link" },
  ext: { read: "derive", derive: "ext" },
  size: { read: "attr", attr: "size(raw)", kind: "number", warning: "file.size is size(raw) — a code-point count of the source, not a byte count" },
  mtime: { read: "attr", attr: "updated_at", kind: "date" },
  mday: { read: "attr", attr: "updated_at.date()", kind: "date" },
  ctime: { read: "unsupported", reason: "omgbase stores no creation time; use file.mtime (the last commit)" },
  cday: { read: "unsupported", reason: "omgbase stores no creation time; use file.mday (the last commit's day)" },
  tags: { read: "attr", attr: "tags", kind: "tags" },
  etags: { read: "attr", attr: "tags", kind: "etags" },
  inlinks: { read: "collect", relation: "in_links", body: "from doc", kind: "inlinks" },
  outlinks: { read: "collect", relation: "out_links", body: "from dst", kind: "outlinks" },
  aliases: { read: "attr", attr: "aliases", kind: "list" },
  tasks: { read: "collect", relation: "blocks", body: 'where type == "task"', kind: "list" },
  lists: { read: "collect", relation: "blocks", body: 'where type == "list_item"', kind: "list" },
  frontmatter: { read: "frontmatter" },
  day: { read: "unsupported", reason: "no date is inferred from a file name or a `date` field; read the field itself" },
  starred: { read: "unsupported", reason: "Obsidian stars are not part of the document" },
};

export type TaskField =
  | { read: "attr"; attr: string; kind: Kind; warning?: string }
  | { read: "collect"; relation: string; body: "from dst"; kind: Kind }
  | { read: "unsupported"; reason: string };

/** The fields of a task row (Dataview "Metadata on Tasks and Lists") on a
 * `blocks` row of type `task` (spec/format: `{ "checked": bool }`). */
export const TASK_FIELDS: Readonly<Record<string, TaskField>> = {
  text: { read: "attr", attr: "text", kind: "string" },
  visual: { read: "attr", attr: "text", kind: "string" },
  completed: { read: "attr", attr: "checked", kind: "boolean" },
  checked: { read: "attr", attr: "checked", kind: "boolean" },
  fullyCompleted: { read: "attr", attr: "checked", kind: "boolean", warning: "fullyCompleted reads the task's own checkbox; subtasks are not consulted" },
  path: { read: "attr", attr: "path", kind: "string" },
  blockId: { read: "attr", attr: "id", kind: "string" },
  outlinks: { read: "collect", relation: "out_links", body: "from dst", kind: "outlinks" },
  status: { read: "unsupported", reason: "omgbase keeps a task's checkbox as `checked` (true/false); the status character is not stored" },
  line: { read: "unsupported", reason: "line numbers are not part of the block model; a task is addressed by its block id" },
  lineCount: { read: "unsupported", reason: "line numbers are not part of the block model" },
  position: { read: "unsupported", reason: "line numbers are not part of the block model" },
  section: { read: "unsupported", reason: "a task's section is a relation (`section`), not a link value" },
  link: { read: "unsupported", reason: "a task has no link value; the client renders path + id" },
  children: { read: "unsupported", reason: "subtasks are the block's `children` relation, not a value" },
  subtasks: { read: "unsupported", reason: "subtasks are the block's `children` relation, not a value" },
  parent: { read: "unsupported", reason: "the parent is a tree position, not a value" },
  annotated: { read: "unsupported", reason: "inline fields on a task are not indexed per task" },
  tags: { read: "unsupported", reason: "a task's own tags are not indexed; use file.tags for the page's" },
  header: { read: "unsupported", reason: "a task's heading is the `section` relation, not a value" },
  symbol: { read: "unsupported", reason: "the list marker is not stored" },
  task: { read: "unsupported", reason: "every row of a TASK query is a task" },
  real: { read: "unsupported", reason: "every row of a TASK query is a task" },
  list: { read: "unsupported", reason: "the owning list is a tree position, not a value" },
};

/** Date methods (surface 4.8 contract): Dataview's `date.year` etc. become calls. */
export const DATE_MEMBERS: ReadonlySet<string> = new Set(["year", "month", "day", "weekday", "hour", "minute", "second", "date"]);

/** Dataview date fields with no counterpart in the contract. */
export const DATE_MEMBERS_UNSUPPORTED: ReadonlySet<string> = new Set(["week", "weekyear", "millisecond", "yearday", "quarter"]);

/** Dataview duration fields (`dur.hours` is the hours component, not a total): no counterpart. */
export const DURATION_MEMBERS: ReadonlySet<string> = new Set(["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]);
