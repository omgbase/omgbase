// The DQL tree the parser produces (Dataview docs: "Queries" → "Query Types",
// "Data Commands"; "Expressions"; "Sources"). Every node carries `start`/`end`
// — code-unit offsets into the DQL source — so an `unsupported` error can point
// at the construct it refuses.

export interface Node {
  start: number;
  end: number;
}

/** The four query types ("Query Types"). */
export type QueryType = "TABLE" | "LIST" | "TASK" | "CALENDAR";

export interface DqlQuery extends Node {
  type: QueryType;
  /** `TABLE WITHOUT ID` / `LIST WITHOUT ID`. */
  withoutId: boolean;
  /** TABLE columns, the LIST value (at most one), the CALENDAR date field (exactly one); empty for TASK. */
  fields: Field[];
  /** `FROM <source>`; null = the whole vault. */
  from: Source | null;
  /** The data commands, in the order written (Dataview applies them sequentially). */
  commands: Command[];
}

/** A TABLE column or LIST/CALENDAR expression: `<expr> [AS "name"]`. */
export interface Field extends Node {
  expr: Expr;
  /** The `AS` alias, or null. */
  alias: string | null;
  /** The field's source text, Dataview's default column header. */
  text: string;
}

// ---- data commands ("Data Commands") -----------------------------------------

export type Command =
  | ({ kind: "where"; expr: Expr } & Node)
  | ({ kind: "sort"; keys: SortKey[] } & Node)
  | ({ kind: "limit"; count: Expr } & Node)
  | ({ kind: "group"; expr: Expr; alias: string | null } & Node)
  | ({ kind: "flatten"; expr: Expr; alias: string | null } & Node);

export interface SortKey extends Node {
  expr: Expr;
  desc: boolean;
}

// ---- sources ("Sources") -----------------------------------------------------

export type Source =
  | ({ kind: "folder"; path: string } & Node) // "folder" or "folder/file"
  | ({ kind: "tag"; tag: string } & Node) // #tag (stored without the `#`)
  | ({ kind: "link"; target: string } & Node) // [[note]] — pages linking TO note
  | ({ kind: "outgoing"; target: string } & Node) // outgoing([[note]]) — pages note links to
  | ({ kind: "csv"; path: string } & Node) // csv("file.csv") — refused by the translator
  | ({ kind: "and"; left: Source; right: Source } & Node)
  | ({ kind: "or"; left: Source; right: Source } & Node)
  | ({ kind: "not"; source: Source } & Node);

// ---- expressions ("Expressions") -------------------------------------------

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "&" | "|";

export type Expr =
  | ({ kind: "string"; value: string } & Node)
  | ({ kind: "number"; value: number } & Node)
  | ({ kind: "boolean"; value: boolean } & Node)
  | ({ kind: "null" } & Node)
  /** `date(today)`, `date(2026-10-15)` — a bare date literal ("Literals: Dates"). */
  | ({ kind: "date"; text: string } & Node)
  /** `dur(1 hour 30 minutes)` — a bare duration literal ("Literals: Durations"). */
  | ({ kind: "duration"; text: string } & Node)
  /** `[[note]]`, `[[note#heading]]`, `[[note|display]]`, `![[embed]]`. */
  | ({ kind: "link"; target: string; display: string | null; embed: boolean } & Node)
  | ({ kind: "list"; items: Expr[] } & Node)
  | ({ kind: "object"; entries: { key: string; value: Expr }[] } & Node)
  /** A bare field name (`due`, `file`, `this`, `rows`, `key`). */
  | ({ kind: "ident"; name: string } & Node)
  /** `a.b` */
  | ({ kind: "member"; object: Expr; name: string } & Node)
  /** `a[i]` */
  | ({ kind: "index"; object: Expr; index: Expr } & Node)
  /** `f(args)` — Dataview functions are free calls only. */
  | ({ kind: "call"; name: string; args: Expr[] } & Node)
  | ({ kind: "neg"; expr: Expr } & Node)
  | ({ kind: "not"; expr: Expr } & Node)
  | ({ kind: "binary"; op: BinaryOp; left: Expr; right: Expr } & Node)
  /** `(expr)` — kept so a column header reproduces the source text; no semantics. */
  | ({ kind: "paren"; expr: Expr } & Node)
  /** `(x) => body` — a lambda; always unsupported downstream. */
  | ({ kind: "lambda"; params: string[]; body: Expr } & Node);
