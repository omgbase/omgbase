// Which query the editor starts with, per REPOSITORY rather than per sample.
//
// The sample default (lib/default-query.ts) walks the sample's release timeline
// from `/timeline/kickoff.md`; against any other repository it matches nothing
// and the first thing a user sees is an empty graph. So, once the connection
// has told the page which repository it is looking at, the editor's content is
// chosen by `chooseQuery`:
//
//   - a user's edit is never replaced (only a preset — the sample default in any
//     of its versions, or the starter — is swapped);
//   - the sample workspace (`repos` slug `sample` AND `/timeline/kickoff.md`
//     present) keeps its timeline default, in the connected server's path form;
//   - every other repository gets the STARTER: the most recently changed
//     documents, which exists in any repository and needs no field names. It
//     has no `follow`, so the picker offers the builtin `doc.out_links` /
//     `doc.in_links` (lib/candidates.ts) and infers nothing else; `links` are
//     drawn, force layout.
//
// `timelineStarter` is the second suggestion — the sample default's shape with
// the start document left to the user — shown under the editor while it holds
// the starter.

import { defaultQuery, isDefaultQuery } from "./default-query.ts";
import { LEGACY_SURFACE, attr, outerPathOperand, serverPath } from "./paths.ts";

/** The slug `scripts/dev-workspace.mjs` gives the sample. */
export const SAMPLE_REPO = "sample";

/** The sample document whose presence (with the slug) identifies the sample workspace. */
export const SAMPLE_PROBE_PATH = "timeline/kickoff.md";

/** The generic starter: recent documents, in any repository (no path literal,
 * no correlation) — the attributes in the server's spelling (`path`/`title`/
 * `updated_at` on ≥ 3.0, `$path`/`$title`/`$updated_at` before; `title` on 3.0
 * is the computed title, the authored one being `data.title`). */
export function starterQuery(surface: string | null = null): string {
  return `select ${attr(surface, "path")}, ${attr(surface, "title")}
from docs
order by ${attr(surface, "updated_at")} desc
limit 40`;
}

/** The starter under every spelling a server may have been given. */
export const STARTER_QUERIES: readonly string[] = [starterQuery(LEGACY_SURFACE), starterQuery("3.0")];

export function isStarterQuery(source: string): boolean {
  return STARTER_QUERIES.includes(source);
}

/** A preset — something the page put in the editor, not the user. */
export function isPresetQuery(source: string): boolean {
  return isDefaultQuery(source) || isStarterQuery(source);
}

/** The timeline suggestion for a repository that authors `before`/`after`
 * frontmatter: the sample default's walk from `start` (a repo path; the
 * literal in the server's form, the correlation via `pathOperand`). */
export function timelineStarter(surface: string | null, start: string | null = null): string {
  const literal = start === null ? "/path/to/start.md" : serverPath(surface, start);
  const path = attr(surface, "path");
  return `select ${path}, ${attr(surface, "title")}, before, after
from docs
where ${path} == ${JSON.stringify(literal)}
follow distinct refs(before), $it.in collect { where ${outerPathOperand(surface)} in list(after) }`;
}

/** The one cheap probe: does `path` exist in the repository? (`limit 1`, so a
 * `hits.length > 0` answer; a `select` works against every server version.) */
export function existsQuery(surface: string | null, path: string): string {
  const p = attr(surface, "path");
  return `select ${p} from docs where ${p} == ${JSON.stringify(serverPath(surface, path))} limit 1`;
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

/** What the editor should hold once the server (`surface`) and the repository
 * are known: null = leave it alone (the user wrote it, or it is already right). */
export function chooseQuery(current: string, surface: string | null, repo: RepositoryShape): string | null {
  if (!isPresetQuery(current)) return null;
  const want = isSampleRepository(repo) ? defaultQuery(surface) : starterQuery(surface);
  return want === current ? null : want;
}
