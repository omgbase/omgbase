// Non-blocking advice about a parsed query: things that run (or fail at the
// server) but mean something other than the author most likely intends. Pure;
// `<oqx-query-editor>` shows them under its status line and `describeQueryError`
// (lib/errors.ts) uses the same reading to turn the engine's generic remedy into
// the concrete one.
//
// Rules:
//   1. `follow <bare field>` — `follow before` over a frontmatter list of paths
//      follows the STRINGS, and since surface 1.5 the server refuses the hit
//      (`filter_invalid`, "a hit must be a document, block, node or edge row").
//      `follow refs(before)` resolves the references to the documents.
//      Not flagged: `refs(…)`, a destination block, a dotted path (`doc.out`,
//      `$it.in`), a `$`-intrinsic, and the structural relations (`in`, `out`,
//      `children`, `subsections`, …) which yield rows by themselves.
//   2. the path form, once the server's surface version is known (lib/paths.ts):
//      on a 2.0 server `"/" + $path` (or `"/" + ^$path`, `"/" + $dst_path`) adds
//      a second slash to an already rooted path — use the intrinsic alone; on a
//      1.x server a bare `$path`/`^$path` compared directly with a property
//      (`^$path in list(after)`, `after.contains(^$path)`, `customer == ^$path`)
//      never matches an authored `/`-rooted reference — prefix it with `"/" +`.
//      A literal (`$path == "a.md"`) and another intrinsic (`$path == ^^$path`)
//      are not flagged: the server roots a literal itself on 2.0, and a bare
//      literal is right on 1.x.

import type { Expr, Query, Span } from "@omgbase/oqx";
import { visit } from "@omgbase/oqx";
import { STRUCTURAL_RELATIONS, dottedPath, refsField } from "./candidates.ts";
import { rootsPaths } from "./paths.ts";

export type HintKind = "follow-bare-field" | "path-already-rooted" | "path-not-rooted";

export interface Hint {
  kind: HintKind;
  /** The code the hint is about: the field a destination names, or the path
   * intrinsic as spelled (`$path`, `^$path`). */
  field: string;
  /** Code-point span of the offending source. */
  span: Span;
  /** Prose with the code parts in backticks (the editor renders them as <code>). */
  message: string;
}

/** `follow` destinations that are a bare frontmatter-looking field. */
export function bareFollowFields(query: Query | null): { field: string; span: Span }[] {
  if (!query?.follow) return [];
  const out: { field: string; span: Span }[] = [];
  for (const dest of query.follow.destinations) {
    if (dest.kind === "op" || refsField(dest)) continue;
    const path = dottedPath(dest);
    if (!path || path.includes(".") || path.startsWith("$") || STRUCTURAL_RELATIONS.has(path)) continue;
    out.push({ field: path, span: dest.span });
  }
  return out;
}

/** Hints for `query` against a server of surface `serverSurface` (`null` while
 * unknown — then only the version-independent rules apply). */
export function queryHints(query: Query | null, serverSurface: string | null = null): Hint[] {
  const hints: Hint[] = bareFollowFields(query).map(({ field, span }) => ({
    kind: "follow-bare-field",
    field,
    span,
    message: `\`${field}\` holds document references; \`follow refs(${field})\` walks the documents (a bare field follows the strings)`,
  }));
  if (query && serverSurface !== null) {
    hints.push(...(rootsPaths(serverSurface) ? slashPrefixedPaths(query) : barePathsAgainstProperties(query)).map((p) => pathHint(p, serverSurface)));
  }
  return hints.sort((a, b) => a.span[0] - b.span[0]);
}

function pathHint(p: PathMention, serverSurface: string): Hint {
  const intrinsic = p.ref.replace(/^\^+/, "");
  return rootsPaths(serverSurface)
    ? { kind: "path-already-rooted", field: p.ref, span: p.span, message: `\`${intrinsic}\` is already \`/\`-rooted on this server; use \`${p.ref}\`` }
    : { kind: "path-not-rooted", field: p.ref, span: p.span, message: `this server's \`${intrinsic}\` has no leading slash; use \`"/" + ${p.ref}\`` };
}

// ---- the path form ---------------------------------------------------------

interface PathMention {
  /** The intrinsic as spelled (`$path`, `^$path`, `^^$dst_path`). */
  ref: string;
  span: Span;
}

const PATH_INTRINSICS = new Set(["$path", "$dst_path"]);

/** A bare path intrinsic (`$path`, `^$path`, …) and its spelling, else null. */
export function pathRef(expr: Expr): string | null {
  if (expr.kind === "ident" && PATH_INTRINSICS.has(expr.name)) return expr.name;
  if (expr.kind === "outer" && PATH_INTRINSICS.has(expr.name)) return `${"^".repeat(expr.levels)}${expr.name}`;
  return null;
}

/** `"/" + $path` (a `/` literal prefixed to a path intrinsic), else null. */
export function slashPrefixedPath(expr: Expr): string | null {
  if (expr.kind !== "binary" || expr.op !== "+" || expr.left.kind !== "lit" || expr.left.value !== "/") return null;
  return pathRef(expr.right);
}

/** Every `"/" + <path intrinsic>` in the query (2.0: the slash is redundant). */
export function slashPrefixedPaths(query: Query): PathMention[] {
  const out: PathMention[] = [];
  visit(query, {
    enter(node) {
      const ref = slashPrefixedPath(node as Expr);
      if (ref) out.push({ ref, span: node.span });
    },
  });
  return out;
}

/** Every comparison of a bare path intrinsic with a property value — `in`,
 * `==`/`!=`, `.contains()` either way round (1.x: the intrinsic lacks the slash
 * the authored reference has). */
export function barePathsAgainstProperties(query: Query): PathMention[] {
  const out: PathMention[] = [];
  const check = (span: Span, a: Expr, b: Expr): void => {
    const ref = pathRef(a);
    if (ref && mentionsProperty(b)) out.push({ ref, span });
  };
  visit(query, {
    enter(node) {
      const e = node as Expr;
      if (e.kind === "in" || (e.kind === "binary" && (e.op === "==" || e.op === "!="))) {
        check(e.span, e.left, e.right);
        check(e.span, e.right, e.left);
      } else if (e.kind === "call" && e.name === "contains" && e.recv && e.args.length === 1) {
        check(e.span, e.args[0]!, e.recv);
        check(e.span, e.recv, e.args[0]!);
      }
    },
  });
  return out;
}

/** Does the expression read a property (a non-`$` name, at any depth)? */
function mentionsProperty(expr: Expr): boolean {
  let found = false;
  visit(expr, {
    enter(node) {
      if ((node.kind === "ident" || node.kind === "outer") && !(node as { name: string }).name.startsWith("$")) found = true;
    },
  });
  return found;
}

/** Split a hint message into prose and code runs (odd indices are code). */
export function messageRuns(message: string): string[] {
  return message.split("`");
}
