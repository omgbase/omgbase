// The default query, generated for the connected server's surface version
// (lib/paths.ts), and the test for "the editor still holds a default" that lets
// the page swap it when the version changes without touching a user's edits.
//
// The query walks the sample's release timeline from `kickoff.md` both ways:
// back through each document's own `before` (`refs(before)`, surface 1.5), and
// forward through the documents whose `after` names it — the frontier's
// backlinks (`$it.in`; a `/`-rooted frontmatter reference is extracted as an
// edge, so every such document is among them) narrowed to the ones whose `after`
// really says so. The correlation compares the frontier's path with an authored
// reference, which is where the server versions differ: `^$path` is rooted on
// 2.0 and needs `"/" +` before.

import { LEGACY_SURFACE, pathOperand, serverPath } from "./paths.ts";

export const DEFAULT_START = "timeline/kickoff.md";

export function defaultQuery(surface: string | null): string {
  return `select $path, title, phase, before, after
from docs
where $path == ${JSON.stringify(serverPath(surface, DEFAULT_START))}
follow distinct refs(before), $it.in collect { where ${pathOperand(surface, "^$path")} in list(after) }
order by $ordinal`;
}

/** Earlier defaults, still persisted in some browsers. */
export const PREVIOUS_DEFAULT_QUERIES: readonly string[] = [
  `select $path, title, phase, before, after
from docs
where $path == "timeline/kickoff.md"
follow $repo.docs collect { where after.contains("/" + ^$path) }
order by $ordinal`,
];

/** Is `source` one of the defaults — the current one for any server version,
 * or an earlier one — rather than something the user wrote? */
export function isDefaultQuery(source: string): boolean {
  return source === defaultQuery(LEGACY_SURFACE) || source === defaultQuery("2.0") || PREVIOUS_DEFAULT_QUERIES.includes(source);
}
