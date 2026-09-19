// Keyset cursors for every paged list surface (mcp-api §1: "truncated + cursor").
// One encoding — base64url of a JSON tuple of strings — shared by the OQX
// collect page (`[path, id]`) and the docs_list / docs_tree pages (`[path]`),
// so there is exactly one place a cursor can be malformed and one error for it.
// Kernel-owned: the query layer and the read layer both consume this; neither
// defines its own.

/** A cursor this surface did not issue (malformed / tampered / from another
 *  tool). The MCP layer maps it to `filter_invalid`. */
export class CursorInvalid extends Error {
  constructor(public readonly surface: string) {
    super("invalid cursor");
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
