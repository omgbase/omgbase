// The default query — the sample's release timeline — and the test for "the
// editor still holds the default" that lets the page swap it for the starter
// (lib/starter-query.ts) without touching a user's edits.
//
// The query walks the timeline from `kickoff.md` both ways: back through each
// document's own `before` (`refs(before)` resolves the references to the
// documents), and forward through the documents whose `after` names it — the
// frontier's backlinks (`_in_links collect { from _doc }`; a `/`-rooted
// frontmatter reference is extracted as an edge, so every such document is
// among them) narrowed to the ones whose `after` really says so (`^_path in
// list(after)`: the row's path is `/`-rooted like the authored reference).
//
// The engine names are spelled for the connected server (lib/paths.ts
// `EngineNames`): `_path`/`_title`/`_in_links`/`_doc` from surface 5.0, the
// bare `path`/`title`/`in_links`/`doc` before. `DEFAULT_QUERY` is the 5.0
// text; `isDefaultQuery` recognises either spelling, so switching servers
// swaps the preset (lib/starter-query.ts `chooseQuery`).

import { NAMES_4, NAMES_5, type EngineNames } from "./paths.ts";

export const DEFAULT_START = "/timeline/kickoff.md";

/** The sample default in a server's spelling. */
export function defaultQuery(names: EngineNames = NAMES_5): string {
  return `select ${names.path}, ${names.title}, phase, before, after
from docs
where ${names.path} == ${JSON.stringify(DEFAULT_START)}
follow distinct refs(before), ${names.in_links} collect { from ${names.doc} where ^${names.path} in list(after) }
order by $ordinal`;
}

/** The default in the native (5.0) spelling — what a fresh editor holds before a server is known. */
export const DEFAULT_QUERY = defaultQuery(NAMES_5);

/** Is `source` the default (in either spelling) rather than something the user wrote? */
export function isDefaultQuery(source: string): boolean {
  return source === defaultQuery(NAMES_5) || source === defaultQuery(NAMES_4);
}
