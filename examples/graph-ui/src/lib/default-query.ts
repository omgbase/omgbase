// The default query — the sample's release timeline — and the test for "the
// editor still holds the default" that lets the page swap it for the starter
// (lib/starter-query.ts) without touching a user's edits.
//
// The query walks the timeline from `kickoff.md` both ways: back through each
// document's own `before` (`refs(before)` resolves the references to the
// documents), and forward through the documents whose `after` names it — the
// frontier's backlinks (`in_links collect { from doc }`; a `/`-rooted
// frontmatter reference is extracted as an edge, so every such document is
// among them) narrowed to the ones whose `after` really says so (`^path in
// list(after)`: the row's path is `/`-rooted like the authored reference).

export const DEFAULT_START = "/timeline/kickoff.md";

export const DEFAULT_QUERY = `select path, title, phase, before, after
from docs
where path == ${JSON.stringify(DEFAULT_START)}
follow distinct refs(before), in_links collect { from doc where ^path in list(after) }
order by $ordinal`;

/** Is `source` the default rather than something the user wrote? */
export function isDefaultQuery(source: string): boolean {
  return source === DEFAULT_QUERY;
}
