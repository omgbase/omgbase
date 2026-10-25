import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import { parseTree } from "../core/parse/tree.js";
import { adapterForPath } from "../format/index.js";
import { mintId } from "../core/ids.js";
import { retargetLinksInRaw, type InboundLink } from "../graph/inbound-links.js";
import type { Op } from "./apply.js";
import type { MutBlock, MutDoc } from "./tree.js";

// The document operations' shared pieces (spec/mutate §6, 3.0). Through 2.x this
// module held `docsCreate` / `docsMove` / `docsDelete` / `docsSetMeta`, library
// functions that composed the internal commit effects themselves; since 3.0 the
// operations are the effect builders of `sugar.ts` (`create`, `move document`,
// `remove document`, `set`/`unset _frontmatter.<k>`) planned and executed by the
// Effect layer (`plan.ts`), and what remains here is what the planner's
// lowerings share with them: the path canonicalization, the file composition,
// the parse of a created document, the inbound-link retarget plan and the
// frontmatter split.

function dirOf(path: string): string {
  return path.replace(/[^/]*$/, "");
}

/** spec/mutate §6: the storage form of a document path — leading `/` stripped, `\` → `/`. */
export function canonicalDocPath(path: string): string {
  return path.replace(/^\/+/, "").split("\\").join("/");
}

/** Compose a full document's bytes from optional frontmatter + body markdown
 *  (spec/mutate §6 `docs_create`): the body with a trailing `\n` ensured; a
 *  non-empty frontmatter mapping becomes `---\n<yaml>\n---\n` followed by a
 *  blank line unless the body already starts with one. The effect planner's
 *  `set _frontmatter.<k>` composes through this same function (§11.3), so its
 *  bytes equal `docs_set_meta`'s for the same patch. */
export function composeFile(markdown: string, frontmatter?: Record<string, unknown>): string {
  const body = markdown.endsWith("\n") || markdown.length === 0 ? markdown : markdown + "\n";
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const yaml = stringifyYaml(frontmatter).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

/**
 * A document this request CREATES as the planner's working tree (spec/mutate
 * §11.3, 3.0): `source` (the composed file) parsed per the path's format —
 * the frontmatter block becomes `frontmatterRaw` (its raw + its trailing
 * trivia, as `loadMutDoc` builds it), the bytes before it the leading trivia,
 * every body block a `MutBlock` with its exact trivia and an id minted NOW in
 * pre-order under the current minter (the symbolic one at plan time, so the
 * ids are `$new.k`; the production one at execute, so the replay mints the
 * same positions). `docId` is the plan's document symbol. The round-trip law
 * makes `renderDoc` of the result equal `source` byte for byte.
 */
export function parseNewDoc(symbol: string, path: string, source: string): MutDoc {
  const adapter = adapterForPath(path);
  const tree = adapter ? adapter.parse(source) : parseTree(source);
  const fm = tree.children[0]?.type === "frontmatter" ? tree.children[0] : null;
  const rest = fm ? tree.children.slice(1) : tree.children;
  const toMut = (b: RawBlock): MutBlock => ({ id: mintId("b"), type: b.type, raw: b.raw, trivia: b.trivia, attrs: b.attrs, children: b.children.map(toMut) });
  return {
    docId: symbol,
    path,
    format: adapter?.format ?? "markdown",
    leadingTrivia: tree.leadingTrivia,
    frontmatterRaw: fm ? fm.raw + fm.trivia : null,
    children: rest.map(toMut),
  };
}

/**
 * The `retarget_inbound` plan of a move `fromPath → toRel`: one coalesced,
 * CAS-pinned `update` per deepest hit block, the blocks and docs it touches,
 * and the inbound links it leaves dangling. Pure over the store's current
 * blocks — the move itself changes no block — so the effect planner's `move
 * document` (§11.3) and the tool's `dangling`/`retargeted` report (computed
 * before the commit) plan identically.
 */
export function planInboundRetarget(store: Store, docId: string, fromPath: string, toRel: string, inbound: InboundLink[]): { ops: Op[]; blocks: string[]; docs: string[]; dangling: InboundLink[] } {
  const byBlock = new Map<string, InboundLink>();
  for (const l of inbound) if (l._block_id !== null && !byBlock.has(l._block_id)) byBlock.set(l._block_id, l);
  // A container's raw includes its children's raw, so a link inside a list item
  // is reported for BOTH the list and the item. Rewrite the deepest block only:
  // updating the container would re-parse (and re-identify) its children, and
  // the child's update alone already changes the container's rendered raw.
  const parentOf = store.db.prepare("SELECT parent_block FROM blocks WHERE block_id = ? AND deleted_at IS NULL");
  const containers = new Set<string>();
  for (const blockId of byBlock.keys()) {
    let cur: string | null = blockId;
    while (cur) {
      const row = parentOf.get(cur) as { parent_block: string | null } | undefined;
      cur = row?.parent_block ?? null;
      if (cur && byBlock.has(cur)) containers.add(cur);
    }
  }
  for (const c of containers) byBlock.delete(c);
  const ops: Op[] = [];
  const blocks: string[] = [];
  const docs = new Set<string>();
  const readBlock = store.db.prepare("SELECT raw_hash, raw FROM blocks WHERE block_id = ? AND deleted_at IS NULL");
  for (const [blockId, src] of byBlock) {
    const row = readBlock.get(blockId) as { raw_hash: Buffer; raw: string } | undefined;
    if (!row) continue;
    // Match against the directory the link was RESOLVED in (the source's path at
    // extraction time); write relative forms against the source's CURRENT
    // directory — they differ only for links inside the moved doc itself.
    const writeDir = src._doc_id === docId ? dirOf(toRel) : dirOf(src._path);
    const newRaw = retargetLinksInRaw(row.raw, dirOf(src._path), writeDir, fromPath, toRel);
    if (newRaw === null) continue;
    ops.push({ op: "update", block: blockId, markdown: newRaw, expect: { content_hash: row.raw_hash.toString("hex") } });
    blocks.push(blockId);
    docs.add(src._doc_id);
  }
  // Containers whose rewritten child covered them count as rewritten too.
  const rewritten = new Set([...blocks, ...containers]);
  const dangling = inbound.filter((l) => l._block_id === null || !rewritten.has(l._block_id));
  return { ops, blocks, docs: [...docs], dangling };
}

/** Split a file's bytes into (frontmatter object, body markdown) with
 *  `^---\r?\n([\s\S]*?)\r?\n---\r?\n?` (spec/mutate §6). Missing or malformed
 *  frontmatter yields an empty object and the whole content as body. */
export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
  } catch {
    /* malformed → empty */
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}
