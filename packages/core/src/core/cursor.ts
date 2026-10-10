// Keyset cursors for every paged list surface (mcp-api §1: "truncated + cursor").
// One encoding — base64url of a JSON tuple of strings — shared by the OQX
// collect page (`[path, id]`) and the docs_list / docs_tree pages (`[path]`),
// so there is exactly one place a cursor can be malformed and one error for it.
// Kernel-owned: the query layer and the read layer both consume this; neither
// defines its own.

/** A cursor this surface did not issue (malformed / tampered / from another
 *  tool). The MCP layer maps it to `filter_invalid`. */
export class CursorInvalid extends Error {
  /** `reason` names the fault when it is not the generic "not issued by this
   *  surface" — a 1.x cursor, say (see `decodePathCursor`). */
  constructor(public readonly surface: string, public readonly reason?: string) {
    super(reason === undefined ? "invalid cursor" : `invalid cursor: ${reason}`);
    this.name = "CursorInvalid";
  }
}

/** Encode a keyset position as an opaque cursor. */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

/** Decode a cursor issued by `encodeCursor`, requiring exactly `arity` string
 *  parts. `surface` names the caller for the error. */
export function decodeCursor(cursor: string, surface: string, arity: number): string[] {
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CursorInvalid(surface);
  }
  if (!Array.isArray(parts) || parts.length !== arity || !parts.every((p) => typeof p === "string")) throw new CursorInvalid(surface);
  return parts as string[];
}

/**
 * `decodeCursor` for the keysets whose FIRST part is a document path (`query`'s
 * `[path, id]`, `docs_list`/`docs_tree`'s `[path]`). Since spec/surface 2.0 the
 * surface speaks the reference form, so an issued cursor's path is `/`-rooted;
 * a bare path can only come from a 1.x cursor, whose keyset would sort before
 * every rooted row and silently replay the first page — it is refused with a
 * reason that names the cause.
 */
export function decodePathCursor(cursor: string, surface: string, arity: number): string[] {
  const parts = decodeCursor(cursor, surface, arity);
  if (!parts[0]!.startsWith("/")) {
    throw new CursorInvalid(surface, `cursor was issued before surface 2.0 (its path ${JSON.stringify(parts[0])} is not /-rooted); start the page sequence again without a cursor`);
  }
  return parts;
}
