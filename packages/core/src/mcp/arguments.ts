import { z } from "zod";
import { EngineError } from "./errors.js";
import { canonicalJson } from "../mutate/canonical.js";

// Argument-shape errors (spec/surface §4 "Arguments", 3.0). Every tool's
// arguments are validated here, ahead of the handler, so a malformed call is
// one `filter_invalid` whose message names what was expected — and, for an
// unknown argument name, the nearest valid one — rather than the SDK's generic
// "Input validation error". The Rust catalog (`omgbase-surface::arguments`)
// composes the same messages byte for byte; the surface fixtures pin them
// (every argument-shape error carries `data.hint = "arguments"`).
//
// Message forms (the `(… takes …)` tail lists the tool's arguments in bytewise
// order, optional ones marked `?`; a tool without arguments "takes no
// arguments"):
//   unknown argument `q`; did you mean `query`? (blocks_search takes limit?, q, repo?)
//   `doc` is no longer an argument — pass `id` or `path` (docs_read takes …)
//   `dry_run` is no longer an argument — preview with `plan { effects: [...] }` (blocks_insert takes …)
//   `query` is required (query takes …)
//   `limit` must be an integer (query takes …)
//   pass id or path (docs_read takes …)                     — a locator tool called with neither
//   id "d_x" and path "/a.md" name different documents (…)   — both given, disagreeing

/** One tool's argument shape: the zod raw shape it was registered with. */
export type ArgShape = Record<string, z.ZodTypeAny>;

/** The `(tool takes …)` tail: names in bytewise order, `?` on the optional ones. */
export function argumentsHint(tool: string, shape: ArgShape): string {
  const names = Object.keys(shape).sort(cmpBytes);
  if (names.length === 0) return `${tool} takes no arguments`;
  return `${tool} takes ${names.map((n) => (isOptional(shape[n]!) ? `${n}?` : n)).join(", ")}`;
}

/** A `filter_invalid` for an argument-shape failure: the message plus the tool's shape — and a `fix` (4.5, spec/surface §4) when the corrected call can be spelled. */
export function argumentError(tool: string, message: string, shape: ArgShape, fix?: string): EngineError {
  const full = `${message} (${argumentsHint(tool, shape)})`;
  return new EngineError("filter_invalid", full, { data: { reason: full, hint: "arguments", ...(fix !== undefined ? { fix } : {}) } });
}

// ---- string lists (spec/surface §4 "Arguments", 4.5 / 4.11) ---------------------------
//
// Every list-of-strings argument (`docs`, `ids`, `roots`, `blocks`, `select`,
// `unset`) also takes ONE bare string as a one-element list — the first guess
// of a caller who has one ref — and (4.11) a string that IS a JSON array of
// strings (`"[\"b_1\",\"b_2\"]"`, the list stringified by a client that
// serializes every argument) as that array: the intent is unambiguous, the
// same tolerance class as the bare string. A comma-joined string is still
// "must be an array of strings", but that error carries a `fix`: the same call
// with the string split on commas (each part trimmed, empty parts dropped),
// canonical JSON. A string opening `[` that is not a JSON array of strings is
// the same error, its `fix` the parsed array when it parsed (a JSON array of
// numbers) and the comma split otherwise (a malformed `[`).

const STRING_LISTS = new WeakSet<z.ZodTypeAny>();

/** The schema of a string-list argument: an array of strings, or one bare string (normalized to `[s]` by `validateArguments`). */
export function stringList(opts: { min?: number } = {}): z.ZodType<string[]> {
  const list = opts.min !== undefined ? z.array(z.string()).min(opts.min) : z.array(z.string());
  const schema = z.union([list, z.string()]);
  STRING_LISTS.add(schema);
  return schema as unknown as z.ZodType<string[]>;
}

/** Is this argument a string list (through `optional`/`nullable`)? */
export function isStringList(schema: z.ZodTypeAny): boolean {
  return STRING_LISTS.has(unwrap(schema));
}

/** The parts of a comma-joined string: split on `,`, trimmed, empty parts dropped. */
export function commaSplit(s: string): string[] {
  return s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * (4.11) A string whose trimmed form opens `[`, read as JSON: `{ list }` when it
 * is a JSON array of strings (accepted as that list); otherwise `{ fix }` — the
 * list the error's corrected call should carry: the parsed array when the text
 * parsed (a JSON array that is not all strings), else the comma split.
 */
export function jsonArrayString(s: string): { list: string[] } | { fix: unknown[] } | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { fix: commaSplit(s) };
  }
  if (!Array.isArray(parsed)) return { fix: commaSplit(s) };
  if (parsed.every((x) => typeof x === "string")) return { list: parsed as string[] };
  return { fix: parsed };
}

/**
 * Validate `raw` against `shape`: unknown names first (in bytewise order), then
 * each declared argument (bytewise order) for presence and type. Returns the
 * arguments with any `undefined` members dropped; throws the first failure.
 */
export function validateArguments(tool: string, shape: ArgShape, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw argumentError(tool, "arguments must be an object", shape);
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args).sort(cmpBytes)) {
    if (!(key in shape)) throw argumentError(tool, unknownArgumentMessage(key, shape), shape);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape).sort(cmpBytes)) {
    const schema = shape[key]!;
    const value = args[key];
    if (value === undefined) {
      if (!isOptional(schema)) throw argumentError(tool, `\`${key}\` is required`, shape);
      continue;
    }
    if (isStringList(schema) && typeof value === "string") {
      // (4.11) a stringified JSON array of strings is that list — checked
      // against the list schema itself (the `roots` minimum holds for it too);
      // any other `[…` is the array error with the parsed array (or the comma
      // split) as its `fix`.
      const json = jsonArrayString(value);
      if (json !== null) {
        if ("fix" in json) throw argumentError(tool, `\`${key}\` must be an array of strings`, shape, canonicalJson({ ...args, [key]: json.fix }));
        const parsed = schema.safeParse(json.list);
        if (!parsed.success) throw argumentError(tool, issueMessage(key, schema, parsed.error.issues), shape);
        out[key] = json.list;
        continue;
      }
      // (4.5) one bare string is a one-element list; a comma-joined one is the
      // array error with the split list as its `fix`.
      if (value.includes(",")) throw argumentError(tool, `\`${key}\` must be an array of strings`, shape, canonicalJson({ ...args, [key]: commaSplit(value) }));
      out[key] = [value];
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw argumentError(tool, issueMessage(key, schema, parsed.error.issues), shape);
    // The value as sent, not zod's copy: the schemas here coerce nothing, and
    // the kernel-op grammar (`apply.ops`) keeps keys the schema does not name.
    out[key] = value;
  }
  return out;
}

/** The first failure, spelled for the argument: a top-level type mismatch is
 *  "`key` must be <phrase>"; a failure inside a nested shape (`ops[0].block`)
 *  names the path — "is required" when the member is absent, else "must be
 *  <zod's expected type>". Nested wording is the reference's own (the Rust
 *  catalog checks nested shapes in its handlers); the top-level form is pinned. */
function issueMessage(key: string, schema: z.ZodTypeAny, issues: readonly { code: string; path: PropertyKey[]; expected?: string; input?: unknown }[]): string {
  const issue = issues[0];
  if (!issue || issue.path.length === 0) return `\`${key}\` must be ${phraseFor(schema)}`;
  const at = key + issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");
  if (issue.code === "invalid_type" && issue.input === undefined) return `\`${at}\` is required`;
  const expected: Record<string, string> = { string: "a string", number: "an integer", boolean: "a boolean", object: "an object", array: "an array" };
  return `\`${at}\` must be ${issue.expected !== undefined ? (expected[issue.expected] ?? issue.expected) : "valid"}`;
}

/**
 * What to say about an argument name the tool does not take. The names 3.0
 * retired are called out with their replacement (`doc` → `id`/`path`,
 * `block`/`node` → `id`, `heading` → `section`, `markdown` → `text`) when the
 * tool has the replacement, and so are the inputs 4.0 retired (spec/surface
 * §4; ADR-021's retirement release): `ops` on a tool that takes `effects`
 * (the kernel ops are a library/fixture contract), `dry_run` on any tool (the
 * preview is `plan`), `attrs` on a tool that takes `checked`. Otherwise the
 * nearest valid name (Levenshtein ≤ 2, or one a prefix of the other).
 */
export function unknownArgumentMessage(key: string, shape: ArgShape): string {
  const has = (n: string) => n in shape;
  const retired = (replacement: string) => `\`${key}\` is no longer an argument — pass ${replacement}`;
  if (key === "doc" && has("id") && has("path")) return retired("`id` or `path`");
  if ((key === "block" || key === "node") && has("id")) return retired("`id`");
  if (key === "heading" && has("section")) return retired("`section` (the heading's text), or blocks_append with the heading's `id`");
  if (key === "markdown" && has("text")) return retired("`text`");
  if (key === "ops" && has("effects")) return RETIRED_OPS;
  if (key === "dry_run") return RETIRED_DRY_RUN;
  if (key === "attrs" && has("checked")) return RETIRED_ATTRS;
  const near = nearest(key, Object.keys(shape));
  return near === null ? `unknown argument \`${key}\`` : `unknown argument \`${key}\`; did you mean \`${near}\`?`;
}

/** The retired-input messages of surface 4.0 (spec/surface §4), without the `(tool takes …)` tail. */
export const RETIRED_OPS = "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0)";
export const RETIRED_DRY_RUN = "`dry_run` is no longer an argument — preview with `plan { effects: [...] }`";
export const RETIRED_ATTRS = "`attrs` is no longer an argument — pass `checked`";

/** The nearest candidate: Levenshtein distance ≤ 2, or a prefix relation either way; ties → the bytewise-first. */
export function nearest(name: string, candidates: readonly string[]): string | null {
  let best: { name: string; score: number } | null = null;
  for (const c of [...candidates].sort(cmpBytes)) {
    const d = levenshtein(name, c);
    const prefix = name.length > 0 && c.length > 0 && (c.startsWith(name) || name.startsWith(c));
    if (d > 2 && !prefix) continue;
    const score = prefix && d > 2 ? 3 : d;
    if (best === null || score < best.score) best = { name: c, score };
  }
  return best?.name ?? null;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

function cmpBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- zod introspection ----------------------------------------------------------------

type Def = { type: string; innerType?: z.ZodTypeAny; element?: z.ZodTypeAny; entries?: Record<string, unknown>; options?: z.ZodTypeAny[] };

function defOf(schema: z.ZodTypeAny): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const d = defOf(schema);
  return d.type === "optional" || (d.type === "nullable" && isOptional(d.innerType!));
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const d = defOf(schema);
  return d.type === "optional" || d.type === "nullable" ? unwrap(d.innerType!) : schema;
}

/** The expected-type phrase of an argument, as the Rust catalog spells it from its JSON schema. */
export function phraseFor(schema: z.ZodTypeAny): string {
  if (isStringList(schema)) return "an array of strings";
  const d = defOf(unwrap(schema));
  switch (d.type) {
    case "string": return "a string";
    case "number": return "an integer";
    case "boolean": return "a boolean";
    case "object": case "record": return "an object";
    case "enum": return `one of ${Object.values(d.entries ?? {}).map(String).join(", ")}`;
    case "array": {
      const inner = defOf(unwrap(d.element!)).type;
      return `an array of ${inner === "string" ? "strings" : inner === "number" ? "integers" : "objects"}`;
    }
    case "union": return "\"start\", \"end\", {before} or {after}";
    default: return "valid";
  }
}
