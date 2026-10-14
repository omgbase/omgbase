// Paths and the surface gate (the subset of repo-explorer's lib/paths.ts this
// app needs). attn speaks omgbase surface 4.7 (spec/surface): a bare path as an
// effect's target (spec/mutate 3.2), `expect.revision` on an effect, the
// Receipt's `summary` and the error `fix` (4.4), and — for the Stream — the
// `revisions` query target and `docs_read { at }` (4.7). The connected server's
// version comes from the `version` tool's `specs.surface` and is checked once
// per connection (`surfaceProblem`).

/** The surface this app is written against. */
export const REQUIRED_SURFACE = "4.7";

/** The `version` tool's `specs.surface` ("major.minor"), or null when the result does not carry one. */
export function surfaceOf(versionResult: unknown): string | null {
  const surface = (versionResult as { specs?: { surface?: unknown } } | null | undefined)?.specs?.surface;
  return typeof surface === "string" && /^\d+\.\d+$/.test(surface) ? surface : null;
}

/** The `version` tool's `profile` ("full" | "minimal", 4.3), or null when absent. */
export function profileOf(versionResult: unknown): string | null {
  const profile = (versionResult as { profile?: unknown } | null | undefined)?.profile;
  return typeof profile === "string" ? profile : null;
}

/** `"major.minor"` → `[major, minor]`, null for anything else. */
export function surfaceParts(surface: string | null): [number, number] | null {
  const m = surface === null ? null : /^(\d+)\.(\d+)$/.exec(surface);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Is `surface` at least `required` (major first, then minor)? False for an unreadable surface. */
export function surfaceAtLeast(surface: string | null, required: string = REQUIRED_SURFACE): boolean {
  const a = surfaceParts(surface);
  const b = surfaceParts(required);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

/** Null when the server speaks a surface this app understands (≥ 4.7); else the message to show instead of connecting. */
export function surfaceProblem(surface: string | null): string | null {
  if (surfaceAtLeast(surface)) return null;
  return `attn needs omgbase surface ≥ ${REQUIRED_SURFACE} (bare-path effect targets, expect.revision, the revisions target and docs_read { at }) — the server reports ${surface ?? "no surface version (no `version` tool)"}`;
}

/** A query hit's document path as returned (`/`-rooted), else null. */
export function hitPath(hit: Record<string, unknown> | null | undefined): string | null {
  const v = hit?.path;
  return typeof v === "string" ? v : null;
}

/** The `/`-rooted form: exactly one leading slash. Idempotent. */
export function rooted(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/** The last segment of a path (`/a/b.md` → `b.md`; a `dir` entry `/a/b/` → `b`). */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** A document's slug: the file name without its extension (`/attn/intents/enjoy-lunch.md` → `enjoy-lunch`). */
export function slugOf(path: string): string {
  return baseName(path).replace(/\.[a-z0-9]+$/i, "");
}
