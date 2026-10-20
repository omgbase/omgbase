// What the page says when a query runs and matches nothing. `0 rows` in the
// footer is not feedback: the panel names the repository, quotes the first
// `where` clause, says which `_path == "…"` literal is not in the repository
// (probed with `existsQuery`), and offers the starter query. Pure helpers; the
// probe takes an `exists` function so it is testable without a server.

import type { Expr, Query, Where } from "@omgbase/oqx";
import { visit } from "@omgbase/oqx";
import { codePointToUtf16 } from "./errors.ts";
import { rooted } from "./paths.ts";

/** The source text of the query's top-level `where` clause (`_path == "…"`),
 * null when it has none. Spans are code points. */
export function firstWhereText(source: string, query: Query | null): string | null {
  const where: Where | null = query?.where ?? null;
  if (!where) return null;
  return source.slice(codePointToUtf16(source, where.span[0]), codePointToUtf16(source, where.span[1])).trim() || null;
}

/** Every string literal compared with the path attribute (`_path`; a 4.x
 * query's `path`) by `==` anywhere in the query, as the author spelled it,
 * deduped and in source order. */
export function pathLiterals(query: Query | null): string[] {
  if (!query) return [];
  const out: string[] = [];
  visit(query, {
    enter(node) {
      const e = node as Expr;
      if (e.kind !== "binary" || e.op !== "==") return;
      const sides: [Expr, Expr][] = [[e.left, e.right], [e.right, e.left]];
      for (const [a, b] of sides) {
        if (a.kind === "ident" && (a.name === "_path" || a.name === "path") && b.kind === "lit" && typeof b.value === "string" && !out.includes(b.value)) out.push(b.value);
      }
    },
  });
  return out;
}

/** The literals that do not exist in the repository. `exists` answers true /
 * false, or null when it could not tell (then the literal is not reported). */
export async function missingPathLiterals(literals: readonly string[], exists: (path: string) => Promise<boolean | null>, max = 3): Promise<string[]> {
  const answers = await Promise.all(literals.slice(0, max).map(async (p) => [p, await exists(p).catch(() => null)] as const));
  return answers.filter(([, found]) => found === false).map(([p]) => p);
}

export interface EmptyState {
  /** The first `where` clause as written, or null. */
  where: string | null;
  /** Path literals that are not in the repository. */
  missing: string[];
}

export interface EmptyStateText {
  title: string;
  /** One line per missing path (`/timeline/kickoff.md is not in repo notes`). */
  details: string[];
  /** The footer's short form. */
  footer: string;
}

/** The words the panel and the footer show. */
export function emptyStateText(state: EmptyState, repo: string): EmptyStateText {
  const where = repo ? ` in repo ${repo}` : "";
  const details = state.missing.map((p) => `${rooted(p)} is not in repo ${repo || "(unknown)"}`);
  return {
    title: `the query matched nothing${where}`,
    details,
    footer: state.missing.length > 0 ? `matched nothing — ${rooted(state.missing[0]!)} is not in this repo` : "matched nothing",
  };
}
