// The two path forms (spec/surface §1 "Paths", 2.0). omgbase stores a
// document's path in git's repo-relative form (`projects/oqx.md`: `docs.path`,
// the filesystem adapters, every store/sync spec) while every reference a user
// authors — a Markdown link, a wikilink, a frontmatter relation — is
// root-absolute (`/projects/oqx.md`). The surface speaks the reference form:
// every path a query, a tool or a CLI verb RETURNS is `/`-rooted, and every
// path they ACCEPT tolerates both forms. These two functions are the whole
// conversion; the storage layer never sees a rooted path and the surface never
// hands out a bare one.

/** The reference (surface) form of a storage path: exactly one leading `/`.
 *  `""` (the repo root, `docs_tree`'s prefix) becomes `/`. */
export function referencePath(path: string): string {
  return "/" + storagePath(path);
}

/** The storage form of a path a caller handed in: every leading `/` stripped
 *  (a missing slash is fine, an extra one is forgiven). */
export function storagePath(path: string): string {
  let i = 0;
  while (i < path.length && path[i] === "/") i++;
  return i === 0 ? path : path.slice(i);
}

/** `referencePath` over a nullable value; `null`/`undefined` pass through. */
export function referencePathOrNull<T extends string | null | undefined>(path: T): T extends string ? string : T {
  return (typeof path === "string" ? referencePath(path) : path) as T extends string ? string : T;
}

/** A `{ <path>: … }` record (dry-run `diffs`) re-keyed by the reference form. */
export function referenceKeyed<V>(byPath: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(byPath)) out[referencePath(k)] = v;
  return out;
}
