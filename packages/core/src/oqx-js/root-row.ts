// The root row (spec/surface §1.1, 2.0; spec/oqx 0.18). The repository is OQX's
// root row: from a top-level row `^docs` reaches the documents (one caret per
// enclosing block, or the absolute `0^docs`), `^_id` the repository id, and the
// root object (`^$it`) exposes the five collections (`revisions` since 4.7). Two spellings are refused
// as `filter_invalid`, with the messages below, in both engines:
//
//   • `$repo` (removed in 2.0) anywhere — bare, as a member head (`$repo.docs`),
//     `^$repo`, `0^$repo` — statically, before any row is read, so the error is
//     deterministic whether or not a row would have reached it (run.ts
//     `checkRootSpellings`);
//   • a bare target name at scope depth ≥ 1 (inside a block, or in a top-level
//     row's clauses), where a bare name reads a property of the current row,
//     which has none — refused statically for every root name since 5.0 (the
//     relations are `_blocks`, `_nodes`, `_revisions`: a bare `blocks` is never
//     one), and by the context at read time should one reach it (context.ts). A frontmatter key named after a
//     target is unreachable by bare name (use `_frontmatter.<k>`).

export type Target = "docs" | "blocks" | "nodes" | "links";
/** Every root collection (spec/surface §1.1): the four row kinds the
 * unknown-names pass judges (`TARGETS`, names.ts) plus `revisions` (4.7), the
 * history target — one row per revision of the repository's documents. */
export type Root = Target | "revisions";

/** The four row kinds whose names the unknown-names pass judges (names.ts keys
 * its vocabulary tables by them); `revisions` joins when that pass learns the
 * kind. Every OTHER root-collection test uses `ROOTS`. */
export const TARGETS: ReadonlySet<string> = new Set<Target>(["docs", "blocks", "nodes", "links"]);
/** The root collections, in the root object's entry order (§1.1). */
export const ROOT_NAMES: readonly Root[] = ["docs", "blocks", "nodes", "links", "revisions"];
export const ROOTS: ReadonlySet<string> = new Set<string>(ROOT_NAMES);

/** The root names, as relations of each kind's rows (§1.2, `_`-prefixed since
 * 5.0): `_revisions` on a document is its revision list (4.7). A BARE root name
 * on a row is never a relation (it is the loud error below). */
export const TARGET_RELATIONS: Readonly<Record<Root, ReadonlySet<string>>> = {
  docs: new Set(["_nodes", "_blocks", "_revisions"]),
  blocks: new Set(["_nodes"]),
  nodes: new Set(["_blocks"]),
  links: new Set(),
  revisions: new Set(),
};

/** The reach-through heads and the target of the row they reach (`_doc.x`, `_block.x`, and a link's `_dst.x`; spec/surface §1.2, 5.0 — the self aliases are gone). */
export const REACH_THROUGH: Readonly<Record<string, Target>> = { _doc: "docs", _block: "blocks", _dst: "docs" };

const NOUN: Record<Root, string> = { docs: "documents", blocks: "blocks", nodes: "nodes", links: "links", revisions: "revisions" };

export const REPO_REMOVED_MESSAGE =
  "`$repo` was removed in surface 2.0 — reach the repository's collections through the root row: `^docs` from a top-level row (one caret per enclosing block, or the absolute `0^docs`), and the repository id as `^_id` / `0^_id`";

/**
 * The bare-target error. `depth` is the scope depth the name was read at when
 * known statically (the carets in the hint count it); `null` when raised at read
 * time, where the hint spells out the rule instead.
 */
export function bareTargetMessage(name: string, depth: number | null): string {
  const t = name as Root;
  const carets = "^".repeat(depth ?? 1);
  const how = depth === null ? `; one caret per enclosing block, or the absolute \`0^${name}\`` : "";
  return `\`${name}\` inside a block reads a property of the current row, which has none — did you mean \`${carets}${name}\` (the repository's ${NOUN[t]}${how})?`;
}

/**
 * The past-the-root error: `^docs` at the root scope (more carets than there
 * are enclosing scopes) would read absent and count 0 — refused, naming the
 * bare spelling. `levels` is the caret count written.
 */
export function pastRootMessage(name: string, levels: number): string {
  const t = name as Root;
  return `\`${"^".repeat(levels)}${name}\` reaches past the root — there is no enclosing row at this depth; at the top level the repository's ${NOUN[t]} are the bare \`${name}\` (\`${name} count { … }\`, \`from ${name}\`, \`entries(${name})\`)`;
}

/**
 * The unknown-target error (3.0 name pass): a top-level `from <name>` whose name
 * is not one of the five collections would read an absent root and return an
 * empty result — refused instead, naming the collections; `edges`, the links
 * target's name before 3.0, gets its new name spelled out.
 */
export function unknownTargetMessage(name: string): string {
  const was = name === "edges" ? " (`edges` was renamed `links` in surface 3.0)" : "";
  return `\`${name}\` is not a target — the repository's collections are ${ROOT_NAMES.map((r) => `\`${r}\``).join(", ")}${was}`;
}

/** Whether `name`, read as `<head>.<name>` or bare on a row of `target`, is one of that row's relations named after a target (`_blocks`, `_nodes`, `_revisions`). */
export function isTargetRelationOf(target: Root | undefined, name: string): boolean {
  return target !== undefined && TARGET_RELATIONS[target].has(name);
}
