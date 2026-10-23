// Which query the editor starts with, per REPOSITORY rather than per sample.
//
// The sample default (lib/default-query.ts) walks the sample's release timeline
// from `/timeline/kickoff.md`; against any other repository it matches nothing
// and the first thing a user sees is an empty graph. So, once the connection
// has told the page which repository it is looking at, the editor's content is
// chosen by `chooseQuery`:
//
//   - a user's edit is never replaced (only a preset — the sample default or
//     the starter, in either spelling — is swapped);
//   - the sample workspace (`repos` slug `sample` AND `/timeline/kickoff.md`
//     present) keeps its timeline default;
//   - every other repository gets the STARTER: the most recently changed
//     documents, which exists in any repository and needs no field names. It
//     has no `follow`, so the picker offers the builtin `_out_links` /
//     `_in_links` (lib/candidates.ts; `doc.out_links` / `doc.in_links` under
//     the 4.x names) and infers nothing else; `links` are drawn, force layout.
//
// Every preset is spelled for the connected server (lib/paths.ts
// `EngineNames`: `_path`/`_title`/`_updated_at` from surface 5.0, bare before);
// the `*_QUERY` constants are the 5.0 texts and the `is*Query` tests recognise
// both spellings.
//
// `timelineStarter` is the second suggestion — the sample default's shape with
// the start document left to the user — shown under the editor while it holds
// the starter.

import { defaultQuery, isDefaultQuery } from "./default-query.ts";
import { NAMES_4, NAMES_5, rooted, type EngineNames } from "./paths.ts";

/** The slug `scripts/dev-workspace.mjs` gives the sample. */
export const SAMPLE_REPO = "sample";

/** The sample document whose presence (with the slug) identifies the sample workspace. */
export const SAMPLE_PROBE_PATH = "/timeline/kickoff.md";

/** The generic starter: recent documents, in any repository (no path literal,
 * no correlation). `_title` is the computed title attribute (spec/surface
 * §1.2), the authored one being the bare `title`. */
export function starterQuery(names: EngineNames = NAMES_5): string {
  return `docs {
  select ${names.path}, ${names.title}
  order by ${names.updated_at} desc
  limit 40
}`;
}

/** The starter in the native (5.0) spelling. */
export const STARTER_QUERY = starterQuery(NAMES_5);

export function isStarterQuery(source: string): boolean {
  return source === starterQuery(NAMES_5) || source === starterQuery(NAMES_4);
}

/** A preset — something the page put in the editor, not the user. */
export function isPresetQuery(source: string): boolean {
  return isDefaultQuery(source) || isStarterQuery(source);
}

/** The timeline suggestion for a repository that authors `before`/`after`
 * frontmatter: the sample default's walk from `start` (a repo path; a
 * placeholder when none is known). */
export function timelineStarter(start: string | null = null, names: EngineNames = NAMES_5): string {
  const literal = start === null ? "/path/to/start.md" : rooted(start);
  return `docs {
  select ${names.path}, ${names.title}, before, after
  where ${names.path} == ${JSON.stringify(literal)}
  follow distinct refs(before), ${names.in_links} { from ${names.doc} where ^${names.path} in list(after) }
}`;
}

/** The one cheap probe: does `path` exist in the repository? (`limit 1`, so a
 * `hits.length > 0` answer.) */
export function existsQuery(path: string, names: EngineNames = NAMES_5): string {
  return `docs { select ${names.path} where ${names.path} == ${JSON.stringify(rooted(path))} limit 1 }`;
}

export interface RepositoryShape {
  /** The connected repo's `repos` slug. */
  slug: string;
  /** Whether `SAMPLE_PROBE_PATH` exists there; null when the probe failed. */
  hasProbeDoc: boolean | null;
}

/** The sample workspace is the sample slug WITH the timeline's start document;
 * a repo under another slug, or one missing the document, is not. An
 * unanswered probe on the sample slug is taken as the sample (the default
 * query still has every chance of working there). */
export function isSampleRepository(repo: RepositoryShape): boolean {
  return repo.slug === SAMPLE_REPO && repo.hasProbeDoc !== false;
}

/** What the editor should hold once the repository is known: null = leave it
 * alone (the user wrote it, or it is already right). A preset in the other
 * server's spelling is swapped for this server's. */
export function chooseQuery(current: string, repo: RepositoryShape, names: EngineNames = NAMES_5): string | null {
  if (!isPresetQuery(current)) return null;
  const want = isSampleRepository(repo) ? defaultQuery(names) : starterQuery(names);
  return want === current ? null : want;
}
