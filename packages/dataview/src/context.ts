// The translation context threaded through sources.ts / expressions.ts /
// translate.ts: which omgbase target the rows are, how deep the current scope
// is (for `^docs` outer references), the current document, how a `[[link]]`
// resolves to a path, and the grouping state.

import type { OrderSpec } from "@omgbase/oqx";
import type { Node } from "./ast.ts";
import { DqlError, positionAt, type DqlPosition } from "./errors.ts";

export type Target = "docs" | "blocks";

export interface Ctx {
  /** The DQL source (for error positions). */
  source: string;
  /** `docs` for TABLE/LIST/CALENDAR, `blocks` (type task) for TASK. */
  target: Target;
  /** Syntactic scope depth of the current row (spec/oqx §2): 1 at the top level, +1 inside each block. */
  depth: number;
  /** The current document's path (`this`), rooted, or null when the client gave none. */
  thisPath: string | null;
  /** `[[target]]` → a rooted path, or null to fall back to a suffix match on the path. */
  resolveLink: (target: string) => string | null;
  /** After GROUP BY: the key's alias, else null. */
  groupKey: string | null;
  /** A SORT written before GROUP BY: the order of the rows inside each group. */
  rowsOrder: OrderSpec[] | null;
  /** Whether some `rows collect { … }` carried `rowsOrder` (else it is warned about). */
  rowsOrderUsed: boolean;
  /** The engine features the output relies on (checked against `capabilities`). */
  features: Set<"dates" | "groupBy">;
  warnings: string[];
}

export function warn(ctx: Ctx, message: string): void {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
}

export function at(ctx: Ctx, node: Node): DqlPosition {
  return positionAt(ctx.source, node.start);
}

/** The same context one block deeper (inside `{ … }`), or with the grouping state changed. */
export function nested(ctx: Ctx, changes: Partial<Ctx> = {}): Ctx {
  return { ...ctx, depth: ctx.depth + 1, ...changes };
}

/** The reference form of a path: `/`-rooted, `.md` added to an extensionless note name. */
export function rootPath(path: string): string {
  let p = path.trim().replace(/^\/+/, "");
  if (!/\.[A-Za-z0-9]+$/.test(p)) p += ".md";
  return `/${p}`;
}

/** `[[target]]` as a path test: `path == "/resolved.md"` when the client resolves
 * the name, else a suffix match on the reference form (`path.endsWith("/note.md")`),
 * which is what a vault-wide name lookup means without the vault. */
export function linkPath(ctx: Ctx, target: string, node?: Node): { exact: string } | { suffix: string } {
  // `[[]]` is the current file (Dataview "Sources": `FROM [[]]`).
  if (target === "") {
    if (ctx.thisPath === null) throw new DqlError("unsupported", "[[]]: the empty link is the current document; pass { thisPath } to translate()", node ? at(ctx, node) : null, "[[]]");
    return { exact: rootPath(ctx.thisPath) };
  }
  const resolved = ctx.resolveLink(target);
  if (resolved !== null) return { exact: rootPath(resolved) };
  return { suffix: rootPath(target) };
}
