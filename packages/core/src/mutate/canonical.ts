import { MutationError } from "./tree.js";

/** The argument-shape error of the surface (`effects.ts` `effectInvalid`), spelled here to avoid the module cycle. */
function effectInvalid(message: string): MutationError {
  return new MutationError("filter_invalid", message, { reason: message, hint: "arguments" });
}

// Canonical JSON (spec/mutate §11.5): the text a plan's digest is taken over,
// and since 3.3 the text every error `fix` and every `summary` value is spelled
// in — one serialization both engines produce byte for byte. Kept apart from
// `plan.ts` so the compile (`select.ts`) and the lowering (`effects.ts`) can use
// it without a module cycle.

function cmpUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// A lone surrogate has no UTF-8 encoding: it cannot be digested (nor sent as JSON text).
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function canonicalString(s: string): string {
  if (!isWellFormed(s)) throw effectInvalid("strings must be well-formed Unicode (a lone surrogate cannot be digested)");
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x08: out += "\\b"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      default:
        out += c < 0x20 ? `\\u${c.toString(16).padStart(4, "0")}` : s[i]!;
    }
  }
  return out + '"';
}

function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw effectInvalid("a number in a plan must be finite");
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return String(n === 0 ? 0 : n);
  return String(n);
}

/**
 * Canonical JSON (§11.5): no whitespace; object keys sorted by their UTF-8
 * bytes; members whose value is `undefined` omitted (an optional key absent is
 * absent, never `null`; a JSON `null` value stays `null`); strings escaped only
 * as JSON requires — `"`, `\`, and U+0000–U+001F (`\b \f \n \r \t`, else
 * `\u00xx` lower-case) — everything else literal UTF-8; a number that is
 * integral with |n| < 2^53 printed as a plain integer (`-0` as `0`), any other
 * finite number by ECMAScript `Number::toString` (shortest round-trip digits);
 * `true`/`false`/`null`.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return canonicalNumber(v);
    case "string":
      return canonicalString(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpUtf8);
      return `{${keys.map((k) => `${canonicalString(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw effectInvalid(`a ${typeof v} cannot be digested`);
  }
}

// ---- the corrected-example `fix` (3.3; spec/mutate §8 "fix", spec/surface §9) ----------------
//
// Channel 2 of the teaching surfaces: an error that can be corrected
// mechanically carries `data.fix`, a LITERAL corrected call — the arguments
// as canonical JSON, prefixed by the tool's name and one space when the
// corrected call is to another tool — built from the request that failed,
// never a prose template. Both engines compose the same bytes.

/** A `plan` / `apply` / `execute` request as the caller gave it: `select`, `effects`, `expect` (each only when present). */
export interface FixRequest {
  select?: unknown;
  effects: unknown;
  expect?: unknown;
}

/** The `fix` for a request to the SAME tool: the corrected arguments, canonical JSON. */
export function fixRequest(req: FixRequest): string {
  return canonicalJson({
    ...(req.select !== undefined ? { select: req.select } : {}),
    effects: req.effects,
    ...(req.expect !== undefined ? { expect: req.expect } : {}),
  });
}

/** The `fix` naming another tool: `<tool> <canonical args>`. */
export function fixTool(tool: string, args: unknown): string {
  return `${tool} ${canonicalJson(args)}`;
}

/** The selector that names exactly one row: the request narrowed to `from <root> where id == "<id>"` with `expect.max: 1` (the fix of a cross-hit collision or an ambiguous target under a selector). */
export function narrowedTo(root: "docs" | "blocks" | "nodes", id: string): string {
  return `from ${root} where id == ${JSON.stringify(id)}`;
}

/** The root a row id belongs to, by its prefix (`d_` / `b_` / `n_`). */
export function rootOfId(id: string): "docs" | "blocks" | "nodes" {
  if (id.startsWith("d_")) return "docs";
  if (id.startsWith("n_")) return "nodes";
  return "blocks";
}

/** `value` with the member at `path` (keys and array indices) replaced; a copy, the input untouched. */
export function withMember(value: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[Number(head)] = withMember(copy[Number(head)], rest, replacement);
    return copy;
  }
  const o = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return { ...o, [head]: withMember(o[head], rest, replacement) };
}
