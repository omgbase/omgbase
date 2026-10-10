// The root row (spec/surface §1.1, 2.0; spec/oqx 0.18). The repository is OQX's
// root row: from a top-level row `^docs` reaches the documents (one caret per
// enclosing block, or the absolute `0^docs`), `^$id` the repository id, and the
// root object (`^$it`) exposes the four collections. Two spellings are refused
// as `filter_invalid`, with the messages below, in both engines:
//
//   • `$repo` (removed in 2.0) anywhere — bare, as a member head (`$repo.docs`),
//     `^$repo`, `0^$repo` — statically, before any row is read, so the error is
//     deterministic whether or not a row would have reached it (run.ts
//     `checkRootSpellings`);
//   • a bare target name at scope depth ≥ 1 (inside a block, or in a top-level
//     row's clauses), where a bare name reads a property of the current row,
//     which has none: `docs` and `edges` are no row's relation, so they are
//     refused statically by the same walk; `blocks` and `nodes` ARE relations
//     of some rows (`docs.blocks`, `docs.nodes`, `blocks.nodes`,
//     `section.blocks`), so the context raises the same error at read time on a
//     row that lacks the relation (context.ts). A frontmatter key named after a
//     target is unreachable by bare name (use `frontmatter.<k>`).

export type Target = "docs" | "blocks" | "nodes" | "edges";

export const TARGETS: ReadonlySet<string> = new Set<Target>(["docs", "blocks", "nodes", "edges"]);

/** The target names that are a relation of each target's rows (§1.2). */
export const TARGET_RELATIONS: Readonly<Record<Target, ReadonlySet<string>>> = {
  docs: new Set(["nodes", "blocks"]),
  blocks: new Set(["nodes"]),
  nodes: new Set(["blocks"]),
  edges: new Set(),
};

/** The reach-through heads and the target of the row they reach (`doc.x`, `block.x`, `section.x`). */
export const REACH_THROUGH: Readonly<Record<string, Target>> = { doc: "docs", block: "blocks", section: "nodes" };

const NOUN: Record<Target, string> = { docs: "documents", blocks: "blocks", nodes: "nodes", edges: "edges" };

export const REPO_REMOVED_MESSAGE =
  "`$repo` was removed in surface 2.0 — reach the repository's collections through the root row: `^docs` from a top-level row (one caret per enclosing block, or the absolute `0^docs`), and the repository id as `^$id` / `0^$id`";

/**
 * The bare-target error. `depth` is the scope depth the name was read at when
 * known statically (the carets in the hint count it); `null` when raised at read
 * time, where the hint spells out the rule instead.
 */
export function bareTargetMessage(name: string, depth: number | null): string {
  const t = name as Target;
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
  const t = name as Target;
  return `\`${"^".repeat(levels)}${name}\` reaches past the root — there is no enclosing row at this depth; at the top level the repository's ${NOUN[t]} are the bare \`${name}\` (\`${name} count { … }\`, \`from ${name}\`, \`entries(${name})\`)`;
}

/** Whether `name`, read as `<head>.<name>` or bare on a row of `target`, is one of that row's relations named after a target. */
export function isTargetRelationOf(target: Target | undefined, name: string): boolean {
  return target !== undefined && TARGET_RELATIONS[target].has(name);
}
