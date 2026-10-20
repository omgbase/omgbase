import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { sequentialMinter, setIdMinter, type IdMinter } from "../core/ids.js";
import { withClock } from "../core/clock.js";
import { normalizeText, normalizeVisibleText } from "../core/hash.js";
import { findDoc } from "../core/read/reader.js";
import { resolveRef } from "../core/read/refs.js";
import { referencePath } from "../core/paths.js";
import { isContainerBlock } from "../format/index.js";
import { observeBatch } from "../sync/observe.js";
import { apply, type Op } from "../mutate/apply.js";
import { docsAppend, linksRepair, nodeSet, sectionsAppend, tasksComplete } from "../mutate/macros.js";
import { composeFile, splitFrontmatter } from "../mutate/docs.js";
import { surfaceApplyResult, surfaceRetargetHits } from "../surface-paths.js";
import { CORPUS_TS, FIXTURE_REPO_SLUG, cmpBytes, readCorpusFromDisk } from "../../corpus/surface/fixture.js";
import { EngineError, errorBody } from "./errors.js";
import { buildServer, WRITE_TOOLS } from "./server.js";

// ADR-021, the retirement release (spec/surface 4.0, spec/mutate 3.0): every
// write tool is `apply { effects }` sugar returning the Receipt, and the 3.x
// inputs — `apply.ops`, `dry_run` on every tool, `blocks_update.attrs`, the
// `links_*` dry-run default with `applied` — are refused by name. This suite is
// the 4.0 equivalence file: for every block-level tool and link macro, the
// Receipt path (through the MCP server) and the pre-4.0 commit footprint (the
// 3.x handler bodies reproduced here over the library kernel `apply` + the
// macros — the code the tools called before the migration) run on identical
// workspaces under the fixture minter and the same clock, and must agree on
//
//   - the revisions committed (ids, paths, hashes) — the Receipt's `revisions`
//     equal the legacy result's; a link macro's `hits`/`pairs` too,
//   - the store projection (docs, blocks, revisions, commits minus `ops`,
//     dispositions) and the files on disk,
//   - the exact sequence of ids minted,
//   - the error envelope, where the legacy call failed,
//
// and the legacy DRY RUN's preview must predict exactly what the 4.0 commit
// produced (its `diffs[path].after` is the file the commit wrote; its revision
// hashes are the Receipt's). The intended differences are pinned: a 4.0 commit
// carries the intent record in `commits.ops` (the legacy rows are NULL); there
// is no dry run — the preview is `plan`, which mints NOTHING (the legacy dry run
// burned the ids the commit would take, spec/surface §9, closed at 4.0); and the
// `blocks_update` legacy `attrs` bag, a bag that sets nothing included, is an
// argument error. The document operations' library path is gone (the builders
// are the one path), so their rows are pinned as truths: the Receipt shape, the
// `spec/mutate` §6 reasons, the intent record, the `api` dispositions a
// known-id write labels its blocks with (spec/surface §9: `docs_create`
// `inserted/api`, `docs_set_meta` `edited/api`).

// ---- workspaces -----------------------------------------------------------------

interface Ws {
  dir: string;
  store: Store;
  repoId: string;
  /** every id minted by this side, in order (the seed's included) */
  mints: string[];
  closed: boolean;
}

/**
 * What one side leaves behind, taken before its store is closed. Only one
 * workspace is open at a time: an open store registers an in-use oracle
 * (spec/store §2.1), so a second store's sequential mints would be redrawn
 * past the first's rows and the two sides could never mint alike.
 */
interface Snapshot {
  outcome: Outcome;
  mints: string[];
  projection: Record<string, unknown[]>;
  files: Record<string, string>;
  last: { reason: string | null; ops: string | null } | undefined;
}

function snapshot(ws: Ws, seed: number, outcome: Outcome): Snapshot {
  const snap = { outcome, mints: ws.mints.slice(seed), projection: projection(ws), files: files(ws.dir), last: lastCommit(ws) };
  ws.store.close();
  ws.closed = true;
  return snap;
}

const CORPUS = readCorpusFromDisk();
const PATHS = Object.keys(CORPUS).sort(cmpBytes);
const live: Ws[] = [];

/** A recording fixture minter: `sequentialMinter` whose every offering is logged. */
function recording(into: string[]): IdMinter {
  const next = sequentialMinter();
  return (prefix) => {
    const id = next(prefix);
    into.push(id);
    return id;
  };
}

/** The alchemy corpus as a workspace: files on disk, repo `fixture` with an fs source at `dir`, one observe batch at CORPUS_TS. */
function workspace(): Ws {
  const mints: string[] = [];
  setIdMinter(recording(mints));
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "omgbase-migration-"));
  for (const p of PATHS) {
    const abs = join(dir, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, CORPUS[p]!);
  }
  const store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, dir);
  observeBatch(store, repoId, PATHS.map((path) => ({ path, content: CORPUS[path]! })), CORPUS_TS);
  const ws = { dir, store, repoId, mints, closed: false };
  live.push(ws);
  return ws;
}

afterEach(() => {
  setIdMinter(null);
  for (const ws of live.splice(0)) {
    if (!ws.closed) ws.store.close();
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

function hex(v: unknown): unknown {
  return Buffer.isBuffer(v) ? v.toString("hex") : v;
}

/** The rows the two sides must agree on (`commits.ops` excluded: the one intended difference). */
function projection(ws: Ws): Record<string, unknown[]> {
  const rows = (sql: string): unknown[] =>
    (ws.store.db.prepare(sql).all() as Record<string, unknown>[])
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v)])))
      .sort((a, b) => cmpBytes(JSON.stringify(a), JSON.stringify(b)));
  return {
    docs: rows("SELECT doc_id, path, current_rev, file_hash, deleted_commit FROM docs"),
    blocks: rows("SELECT block_id, doc_id, parent_block, order_key, ordinal, depth, type, attrs, text, raw_hash, trivia_hash, created_commit, deleted_commit FROM blocks"),
    revisions: rows("SELECT rev_id, doc_id, seq, root_tree, rendered_hash, path, commit_id FROM revisions"),
    commits: rows("SELECT commit_id, seq, ts, origin, actor, reason FROM commits"),
    dispositions: rows("SELECT commit_id, block_id, kind, confidence, reason, matcher_v, detail FROM dispositions"),
    pending: rows("SELECT * FROM pending_materializations"),
  };
}

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === ".omgbase") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

function lastCommit(ws: Ws): { reason: string | null; ops: string | null } | undefined {
  return ws.store.db.prepare("SELECT reason, ops FROM commits ORDER BY seq DESC LIMIT 1").get() as { reason: string | null; ops: string | null } | undefined;
}

// ---- the 4.0 side: the MCP server ---------------------------------------------------

type Outcome = { ok: true; payload: unknown } | { ok: false; payload: unknown };

async function viaServer(ws: Ws, tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const server = buildServer({ store: ws.store, repoId: ws.repoId, rootPath: ws.dir });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "migration", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const r = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { ok: !r.isError, payload: JSON.parse(r.content[0]!.text) };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

// ---- the legacy side: the pre-4.0 handlers over the library kernel -------------------
//
// Each function is the 3.x body of the block-level tool handler in `server.ts`,
// with the server's private helpers (ref resolution, CAS pinning, section
// resolution) reproduced verbatim over the library kernel `apply` and the
// macros — the write path the tools took before ADR-021's migration. Refs are
// passed as ids/paths, so resolution is trivial.

type Args = Record<string, unknown> & { dry_run?: boolean };
type Legacy = (ws: Ws, a: Args) => unknown;

function blockMissing(value: string): EngineError {
  return new EngineError("block_missing", `no block with id ${JSON.stringify(value)}`, { data: { _id: value } });
}
function resolveBlockRef(ws: Ws, ref: string): string {
  const r = resolveRef(ws.store, ws.repoId, ref);
  if (!r || r.kind !== "block" || !r.blockId) throw blockMissing(ref);
  return r.blockId;
}
function resolveParentRef(ws: Ws, ref: string): { parent: string | { doc: true }; docId: string } {
  const r = resolveRef(ws.store, ws.repoId, ref);
  if (!r) throw new EngineError("block_missing", `no block or document with id or path ${JSON.stringify(ref)}`, { data: { ref } });
  if (r.kind === "document") return { parent: { doc: true }, docId: r.docId };
  return { parent: r.blockId!, docId: r.docId };
}
function pinHash(ws: Ws, id: string): string | undefined {
  return (ws.store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(id) as { h: string } | undefined)?.h;
}
function docIdOfBlock(ws: Ws, id: string): string | undefined {
  return (ws.store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(id) as { doc_id: string } | undefined)?.doc_id;
}
function locateDoc(ws: Ws, a: Args): string {
  const id = a._id as string | undefined;
  const path = a._path as string | undefined;
  const given = { ...(id !== undefined ? { _id: id } : {}), ...(path !== undefined ? { _path: path } : {}) };
  const missing = (v: string) => new EngineError("doc_missing", `no document with _id or _path ${JSON.stringify(v)}`, { data: given });
  const byId = id !== undefined ? findDoc(ws.store, { docId: id }) : null;
  if (id !== undefined && (!byId || byId.repoId !== ws.repoId)) throw missing(id);
  const byPath = path !== undefined ? findDoc(ws.store, { repoId: ws.repoId, path }) : null;
  if (path !== undefined && !byPath) throw missing(path);
  return (byId ?? byPath)!.docId;
}
function resolveSectionHeading(ws: Ws, docId: string, docPath: string, section: string): string {
  const needle = /^[ \t]*#/.test(section) ? normalizeVisibleText(section, "heading") : normalizeText(section);
  const rows = ws.store.db.prepare("SELECT block_id, doc_id, text FROM blocks WHERE doc_id = ? AND type = 'heading' AND deleted_commit IS NULL").all(docId) as { block_id: string; doc_id: string; text: string }[];
  const matches = rows.filter((r) => normalizeText(r.text) === needle);
  const shown = referencePath(docPath);
  if (matches.length === 0) throw new EngineError("parent_missing", `no heading ${JSON.stringify(section)} in ${shown}`, { data: { section, _path: shown } });
  if (matches.length > 1) throw new EngineError("ambiguous_heading", `heading ${JSON.stringify(section)} matches ${matches.length} headings in ${shown}; pass the heading's id to blocks_append`, { data: { section, _path: shown, candidates: matches.map((m) => ({ _id: m.block_id, _doc_id: m.doc_id })) } });
  return matches[0]!.block_id;
}
function legacyApply(ws: Ws, ops: Op[], reason: string, dryRun?: boolean) {
  return surfaceApplyResult(apply(ws.store, { repoId: ws.repoId, rootPath: ws.dir, ops, origin: { actor: "agent:mcp", reason }, ...(dryRun !== undefined ? { dryRun } : {}) }));
}

const LEGACY: Record<string, Legacy> = {
  blocks_insert: (ws, a) => {
    const { parent, docId } = resolveParentRef(ws, a.to as string);
    const to = { parent, at: (a.at as Op extends { to: { at: infer A } } ? A : never) ?? "end" };
    const ops: Op[] = [{ op: "insert", ...(typeof parent === "object" ? { doc: docId } : {}), to, markdown: a.markdown as string, ...(a.expect ? { expect: a.expect } : {}) } as Op];
    return legacyApply(ws, ops, "blocks_insert", a.dry_run);
  },
  blocks_update: (ws, a) => {
    const block = resolveBlockRef(ws, a._id as string);
    const expect = (a.expect as Record<string, string> | undefined) ?? (() => { const h = pinHash(ws, block); return h ? { content_hash: h } : undefined; })();
    const attrs = a.checked !== undefined ? { checked: a.checked as boolean } : undefined;
    const ops: Op[] = [{ op: "update", block, ...(a.markdown !== undefined ? { markdown: a.markdown as string } : {}), ...(attrs ? { attrs } : {}), ...(expect ? { expect } : {}) } as Op];
    return legacyApply(ws, ops, "blocks_update", a.dry_run);
  },
  blocks_move: (ws, a) => {
    const blocks = (a.blocks as string[]).map((b) => resolveBlockRef(ws, b));
    const { parent, docId } = resolveParentRef(ws, a.to as string);
    if (typeof parent === "object" && blocks[0] !== undefined && docIdOfBlock(ws, blocks[0]) !== docId) {
      throw new EngineError("target_missing", `blocks_move cannot target another document's root (${a.to}); anchor on a block in that document with at.before/at.after`, { data: { to: a.to } });
    }
    const to = { parent, at: (a.at as never) ?? "end" };
    return legacyApply(ws, [{ op: "move", blocks, to, ...(a.expect ? { expect: a.expect } : {}) } as Op], "blocks_move", a.dry_run);
  },
  blocks_remove: (ws, a) => legacyApply(ws, [{ op: "remove", blocks: (a.blocks as string[]).map((b) => resolveBlockRef(ws, b)) } as Op], "blocks_remove", a.dry_run),
  blocks_split: (ws, a) => {
    const block = resolveBlockRef(ws, a._id as string);
    return legacyApply(ws, [{ op: "split", block, at: a.at as number[], expect: { content_hash: pinHash(ws, block) ?? "" } } as Op], "blocks_split", a.dry_run);
  },
  blocks_merge: (ws, a) => {
    const blocks = (a.blocks as string[]).map((b) => resolveBlockRef(ws, b));
    return legacyApply(ws, [{ op: "merge", blocks, ...(a.separator !== undefined ? { separator: a.separator } : {}) } as Op], "blocks_merge", a.dry_run);
  },
  blocks_check: (ws, a) => {
    const blocks = (a._ids as string[]).map((b) => resolveBlockRef(ws, b));
    const checked = (a.checked as boolean | undefined) ?? true;
    const ops: Op[] = checked
      ? tasksComplete(ws.store, blocks)
      : blocks.map((block) => ({ op: "update", block, attrs: { checked: false }, ...(() => { const h = pinHash(ws, block); return h ? { expect: { content_hash: h } } : {}; })() } as Op));
    return legacyApply(ws, ops, "blocks_check", a.dry_run);
  },
  nodes_set: (ws, a) => {
    const known = ws.store.db.prepare("SELECT 1 FROM nodes WHERE node_id = ? AND repo_id = ?").get(a._id, ws.repoId);
    if (!known) throw new EngineError("block_missing", `no node with id ${JSON.stringify(a._id)}`, { data: { _id: a._id } });
    return legacyApply(ws, nodeSet(ws.store, a._id as string, a.prop as string, a.value as string), "nodes_set", a.dry_run);
  },
  blocks_append: (ws, a) => {
    const block = resolveBlockRef(ws, a._id as string);
    const row = ws.store.db
      .prepare("SELECT b.type AS type, d.format AS format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_commit IS NULL) AS children FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_commit IS NULL")
      .get(block) as { type: string; format: string | null; children: number } | undefined;
    if (!row) throw blockMissing(a._id as string);
    let ops: Op[];
    if (row.type === "heading") ops = sectionsAppend(block, a.text as string);
    else if (isContainerBlock(row.format ?? "markdown", { type: row.type, children: new Array<unknown>(row.children) })) ops = [{ op: "insert", to: { parent: block, at: "end" }, markdown: a.text as string } as Op];
    else {
      throw new EngineError("block_not_container", `block ${block} is a ${row.type}, not a heading or a container; append means into — insert after it with blocks_insert { to: <its parent>, at: { after: ${JSON.stringify(block)} } }`, { data: { _id: block, _type: row.type } });
    }
    return legacyApply(ws, ops, "blocks_append", a.dry_run);
  },
  docs_append: (ws, a) => {
    const docId = locateDoc(ws, a);
    let ops: Op[];
    if (a.section !== undefined) {
      const info = findDoc(ws.store, { docId })!;
      ops = sectionsAppend(resolveSectionHeading(ws, docId, info.path, a.section as string), a.text as string);
    } else ops = docsAppend(docId, a.text as string);
    return legacyApply(ws, ops, "docs_append", a.dry_run);
  },
  links_retarget: (ws, a) => {
    const { ops, hits: rawHits, pairs } = linksRepair(ws.store, ws.repoId, [{ from: a.from_target as string, to: a.to_target as string }], a.path_glob ? { pathGlob: a.path_glob as string } : {});
    const hits = surfaceRetargetHits(rawHits);
    const res = legacyApply(ws, ops, "links_retarget", a.dry_run);
    return { hits, pairs, applied: !a.dry_run, ...res };
  },
  links_repair: (ws, a) => {
    const repairs = (a.repairs as { from: string; to: string }[] | undefined)
      ?? (a.from_target !== undefined && a.to_target !== undefined ? [{ from: a.from_target as string, to: a.to_target as string }] : null);
    if (!repairs || repairs.length === 0) throw new EngineError("target_missing", "links_repair requires `repairs` (array of {from,to}) or a `from_target`+`to_target` pair");
    const { ops, hits: rawHits, pairs } = linksRepair(ws.store, ws.repoId, repairs, a.path_glob ? { pathGlob: a.path_glob as string } : {});
    const hits = surfaceRetargetHits(rawHits);
    const res = legacyApply(ws, ops, "links_repair", a.dry_run);
    return { hits, pairs, applied: !a.dry_run, ...res };
  },
};

function viaLegacy(ws: Ws, tool: string, args: Args): Outcome {
  try {
    return { ok: true, payload: JSON.parse(JSON.stringify(LEGACY[tool]!(ws, args))) };
  } catch (e) {
    return { ok: false, payload: JSON.parse(JSON.stringify(errorBody(e))) };
  }
}

// ---- the scenarios --------------------------------------------------------------------
//
// Alchemy ids under the fixture minter (the interop suite's): `b_1` index.md's
// first paragraph, `b_2` its first heading, `b_4` the tria-prima list (`b_5`…
// `b_7` its items), `b_29`/`b_30` top-level blocks of index.md, `b_43`/`b_44`
// two paragraphs and `b_47`/`b_58` a paragraph and a list item of
// lab/2026-01-notes.md, `b_52`/`b_56`/`b_57` its tasks, `b_149` a list in
// processes/calcination.md with item `b_150`, `d_16` texts/emerald-tablet.md,
// `n_c7ebbf77d614` the calcination link node, `n_9e25b3a6f1e2` a wikilink node.

interface Scenario {
  tool: string;
  args: Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  { tool: "blocks_insert", args: { to: "processes/calcination.md", markdown: "## Notes\n\nInserted at the end.\n" } },
  { tool: "blocks_insert", args: { to: "b_149", markdown: "- calcined tin → white putty powder\n", at: { after: "b_150" } } },
  { tool: "blocks_insert", args: { to: "index.md", markdown: "Up front.\n", at: "start", expect: {} } },
  { tool: "blocks_insert", args: { to: "b_1", markdown: "x" } },
  { tool: "blocks_insert", args: { to: "processes/calcination.md", markdown: "x", expect: { parent_children_hash: "00" } } },
  { tool: "blocks_insert", args: { to: "nope.md", markdown: "x" } },
  { tool: "blocks_update", args: { _id: "b_1", markdown: "The art of transformation, revised." } },
  { tool: "blocks_update", args: { _id: "b_1", markdown: "First para.\n\nSecond para.\n" } },
  { tool: "blocks_update", args: { _id: "b_56", checked: true } },
  { tool: "blocks_update", args: { _id: "b_52", checked: false } },
  { tool: "blocks_update", args: { _id: "b_56", markdown: "- [ ] Pre-fire crucibles again", checked: true } },
  { tool: "blocks_update", args: { _id: "b_1", markdown: "x", expect: { content_hash: "00" } } },
  { tool: "blocks_update", args: { _id: "b_1", markdown: "Guarded.", expect: { content_hash: "cfe406f7c3a7fd71e90c28015168bc1cfee0111e5f624425d9c4223c6c5a11a7" } } },
  { tool: "blocks_update", args: { _id: "b_999", markdown: "x" } },
  { tool: "blocks_move", args: { blocks: ["b_7"], to: "b_4", at: "start" } },
  { tool: "blocks_move", args: { blocks: ["b_29", "b_30"], to: "index.md", at: { before: "b_2" } } },
  { tool: "blocks_move", args: { blocks: ["b_5"], to: "lab/2026-01-notes.md" } },
  { tool: "blocks_move", args: { blocks: ["b_7"], to: "b_4", at: "start", expect: { parent_children_hash: "00" } } },
  { tool: "blocks_move", args: { blocks: ["b_7"], to: "b_1" } },
  { tool: "blocks_remove", args: { blocks: ["b_47", "b_58"] } },
  { tool: "blocks_remove", args: { blocks: ["b_4", "b_5", "b_5"] } },
  { tool: "blocks_remove", args: { blocks: ["b_999"] } },
  { tool: "blocks_split", args: { _id: "b_1", at: [98] } },
  { tool: "blocks_split", args: { _id: "b_1", at: [0] } },
  { tool: "blocks_merge", args: { blocks: ["b_43", "b_44"] } },
  { tool: "blocks_merge", args: { blocks: ["b_43", "b_44"], separator: "\n\n" } },
  { tool: "blocks_merge", args: { blocks: ["b_1", "b_43"] } },
  { tool: "blocks_check", args: { _ids: ["b_56", "b_57"] } },
  { tool: "blocks_check", args: { _ids: ["b_52"], checked: false } },
  { tool: "blocks_check", args: { _ids: ["b_1"] } },
  { tool: "nodes_set", args: { _id: "n_c7ebbf77d614", prop: "name", value: "Calcination" } },
  { tool: "nodes_set", args: { _id: "n_9e25b3a6f1e2", prop: "value", value: "substances/mercury.md" } },
  { tool: "nodes_set", args: { _id: "n_nope", prop: "name", value: "x" } },
  { tool: "blocks_append", args: { _id: "b_29", text: "Bench notes are dated by month.\n" } },
  { tool: "blocks_append", args: { _id: "b_4", text: "- quintessence\n" } },
  { tool: "blocks_append", args: { _id: "b_1", text: "x" } },
  { tool: "docs_append", args: { _path: "processes/calcination.md", section: "Products", text: "- calcined tin → white putty powder\n" } },
  { tool: "docs_append", args: { _path: "texts/mutus-liber.md", text: "## Addendum\n\nAppended text.\n" } },
  { tool: "docs_append", args: { _id: "d_16", text: "Trailing line.\n" } },
  { tool: "docs_append", args: { _path: "processes/calcination.md", section: "Nope", text: "x" } },
  { tool: "docs_append", args: { _path: "nope.md", text: "x" } },
  { tool: "links_retarget", args: { from_target: "nigredo", to_target: "processes/magnum-opus.md" } },
  { tool: "links_retarget", args: { from_target: "zzz-nothing", to_target: "a.md" } },
  { tool: "links_retarget", args: { from_target: "salt", to_target: "substances/salt.md", path_glob: "lab/*" } },
  { tool: "links_repair", args: { repairs: [{ from: "magnum-opus", to: "processes/magnum-opus.md" }, { from: "mercury", to: "substances/mercury.md" }] } },
  { tool: "links_repair", args: {} },
];

function label(s: Scenario): string {
  return `${s.tool} ${JSON.stringify(s.args)}`;
}

/** The legacy handler on a fresh workspace, snapshotted (the store closed before the next side opens). */
async function legacySide(tool: string, args: Args): Promise<Snapshot> {
  const a = workspace();
  const seed = a.mints.length;
  const outcome = await withClock(CORPUS_TS, async () => viaLegacy(a, tool, args));
  return snapshot(a, seed, outcome);
}

/** The 4.0 handler through the MCP server on a fresh workspace, snapshotted. */
async function migratedSide(tool: string, args: Args): Promise<Snapshot> {
  const b = workspace();
  const seed = b.mints.length;
  const outcome = await withClock(CORPUS_TS, () => viaServer(b, tool, args));
  return snapshot(b, seed, outcome);
}

type Receipt = { plan_id: string; commit: string | null; revisions: { _id: string; _path: string; _hash: string }[]; new_ids: Record<string, string>; committed: true; hits?: unknown; pairs?: unknown };
type LegacyResult = { results: { ids: string[] }[]; revisions: { _id: string; _path: string; _hash: string }[]; diffs?: Record<string, { before: string; after: string }>; committed: boolean; hits?: unknown; pairs?: unknown };

function withoutFix(payload: unknown): unknown {
  const p = payload as { data?: Record<string, unknown> };
  if (!p || typeof p !== "object" || !p.data || !("fix" in p.data)) return payload;
  const { fix: _fix, ...data } = p.data;
  return { ...p, data };
}

async function compare(s: Scenario): Promise<void> {
  const legacyDry = await legacySide(s.tool, { ...s.args, dry_run: true });
  const legacy = await legacySide(s.tool, s.args);
  const migrated = await migratedSide(s.tool, s.args);

  expect(migrated.outcome.ok, `4.0 ${migrated.outcome.ok ? "succeeded" : "failed"} where legacy ${legacy.outcome.ok ? "succeeded" : "failed"}: ${JSON.stringify(migrated.outcome.payload)}`).toBe(legacy.outcome.ok);
  if (!legacy.outcome.ok) {
    // The same error envelope: every tool keeps its pre-checks, the planner's `effect_index` is dropped.
    // (4.4) the `fix` is new on the Receipt path — the legacy envelope never carried one — so it is set aside here.
    expect(withoutFix(migrated.outcome.payload)).toEqual(legacy.outcome.payload);
    expect(migrated.projection).toEqual(legacy.projection);
    expect(migrated.mints).toEqual(legacy.mints);
    return;
  }

  // The Receipt names the revisions the legacy result did; a link macro reports the same hits and pairs.
  const receipt = migrated.outcome.payload as Receipt;
  const result = legacy.outcome.payload as LegacyResult;
  expect(receipt).toMatchObject({ plan_id: expect.stringMatching(/^[0-9a-f]{64}$/), committed: true });
  expect(receipt.revisions).toEqual(result.revisions);
  expect(receipt.commit).toBe(result.revisions.length === 0 ? null : (legacy.projection.commits as { commit_id: string; seq: number }[]).reduce((a, b) => (a.seq > b.seq ? a : b)).commit_id);
  expect(Object.keys(receipt)).toEqual(expect.arrayContaining(["plan_id", "commit", "revisions", "new_ids", "committed"]));
  expect(receipt).not.toHaveProperty("results");
  expect(receipt).not.toHaveProperty("diffs");
  expect(receipt).not.toHaveProperty("applied");
  if (s.tool.startsWith("links_")) {
    expect(receipt.hits).toEqual(result.hits);
    expect(receipt.pairs).toEqual(result.pairs);
  } else {
    expect(receipt).not.toHaveProperty("hits");
  }
  // Every id the legacy result reported that it minted is a `new_ids` value.
  const minted = new Set(Object.values(receipt.new_ids));
  for (const r of result.results) for (const id of r.ids) if (legacy.mints.includes(id)) expect(minted.has(id), `${id} minted by the legacy run is not in new_ids`).toBe(true);

  // The same bytes, rows and mints; the intent record is the one difference.
  expect(migrated.files).toEqual(legacy.files);
  expect(migrated.projection).toEqual(legacy.projection);
  expect(migrated.mints, "minted ids").toEqual(legacy.mints);
  expect(migrated.last?.reason).toBe(legacy.last?.reason);
  if (result.revisions.length > 0) {
    expect(legacy.last?.ops).toBeNull();
    expect(migrated.last?.ops).toMatch(/^\{"effects":\[/);
  }

  // The legacy dry run's preview predicted exactly what the 4.0 commit produced.
  expect(legacyDry.outcome.ok).toBe(true);
  const preview = legacyDry.outcome.payload as LegacyResult;
  expect(preview.committed).toBe(false);
  for (const [path, diff] of Object.entries(preview.diffs ?? {})) expect(migrated.files[path.replace(/^\//, "")], path).toBe(diff.after);
  expect(preview.revisions.map((r) => [r._id, r._path, r._hash])).toEqual(receipt.revisions.map((r) => [r._id, r._path, r._hash]));
}

describe("ADR-021 retirement (surface 4.0): the Receipt path equals the pre-4.0 commit footprint over the alchemy corpus", () => {
  for (const s of SCENARIOS) {
    it(label(s), async () => { await compare(s); });
  }
});

describe("the preview is `plan` and mints nothing (spec/surface §9 'dry runs consume minted ids', closed at 4.0)", () => {
  const PLANS: { tool: string; args: Record<string, unknown>; effects: unknown[] }[] = [
    { tool: "blocks_insert", args: { to: "processes/calcination.md", markdown: "## Notes\n\nInserted at the end.\n" }, effects: [{ op: "insert", into: { kind: "document", _path: "processes/calcination.md" }, at: "end", markdown: "## Notes\n\nInserted at the end.\n" }] },
    { tool: "blocks_update", args: { _id: "b_1", markdown: "First para.\n\nSecond para.\n" }, effects: [{ op: "set", target: { kind: "block", _id: "b_1" }, field: "markdown", value: "First para.\n\nSecond para.\n" }] },
    { tool: "docs_create", args: { path: "substances/gold.md", markdown: "# Gold\n\nThe goal.\n", frontmatter: { type: "substance" } }, effects: [{ op: "create", path: "substances/gold.md", markdown: "# Gold\n\nThe goal.\n", frontmatter: { type: "substance" } }] },
    { tool: "docs_move", args: { _path: "texts/mutus-liber.md", to_path: "texts/silent-book.md" }, effects: [{ op: "move", target: { kind: "document", _path: "texts/mutus-liber.md" }, to: "texts/silent-book.md" }] },
  ];
  for (const p of PLANS) {
    it(`${p.tool}: the plan's preview is the legacy dry run's, under symbols; the commit then takes the ids the legacy dry run burned`, async () => {
      const planned = await migratedSide("plan", { effects: p.effects, diffs: true });
      expect(planned.outcome.ok, JSON.stringify(planned.outcome.payload)).toBe(true);
      const plan = planned.outcome.payload as { new_ids: { symbol: string }[]; preview: { diffs: Record<string, { before: string; after: string }>; revisions: { _id: string; _path: string; _hash: string }[] } };
      expect(planned.mints, "a plan mints nothing").toEqual([]);
      expect((planned.projection.commits as unknown[]).length).toBe(20); // the corpus observation only: nothing committed
      // The symbols stand where the ids will be.
      for (const s of plan.new_ids) expect(s.symbol).toMatch(/^\$new\.\d+$/);
      const committed = await migratedSide(p.tool, p.args);
      expect(committed.outcome.ok, JSON.stringify(committed.outcome.payload)).toBe(true);
      const receipt = committed.outcome.payload as Receipt;
      // The preview's diffs are the files the commit wrote; its revision hashes the Receipt's.
      for (const [path, diff] of Object.entries(plan.preview.diffs)) expect(committed.files[path.replace(/^\//, "")] ?? "", path).toBe(diff.after);
      expect(plan.preview.revisions.map((r) => r._hash)).toEqual(receipt.revisions.map((r) => r._hash));
      // A `$new.n` revision is the created document; every symbol of the plan is realized by the commit.
      expect(Object.keys(receipt.new_ids).sort()).toEqual(plan.new_ids.map((s) => s.symbol).sort());
      if (p.tool === "blocks_insert") {
        // Through 3.x the dry run burned b_327/b_328 and the commit took b_329/b_330; the plan burns none.
        expect(Object.values(receipt.new_ids)).toEqual(["b_327", "b_328"]);
      }
    });
  }
});

describe("the retired inputs are refused by name (spec/surface §4; never silently stripped)", () => {
  const SUGAR = [...WRITE_TOOLS].filter((t) => !["plan", "execute", "observe", "observe_many", "observe_delete"].includes(t));
  const MINIMAL: Record<string, Record<string, unknown>> = {
    apply: { effects: [] },
    blocks_insert: { to: "index.md", markdown: "x" },
    blocks_update: { _id: "b_1", markdown: "x" },
    blocks_move: { blocks: ["b_7"], to: "b_4" },
    blocks_remove: { blocks: ["b_47"] },
    blocks_split: { _id: "b_1", at: [1] },
    blocks_merge: { blocks: ["b_43", "b_44"] },
    blocks_check: { _ids: ["b_56"] },
    nodes_set: { _id: "n_c7ebbf77d614", prop: "name", value: "x" },
    blocks_append: { _id: "b_4", text: "- x" },
    docs_append: { _path: "index.md", text: "x" },
    links_retarget: { from_target: "a", to_target: "b" },
    links_repair: { repairs: [{ from: "a", to: "b" }] },
    docs_create: { path: "new.md", markdown: "x" },
    docs_move: { _path: "index.md", to_path: "x.md" },
    docs_delete: { _path: "index.md" },
    docs_set_meta: { _path: "index.md", set: { a: 1 } },
    docs_update: { _path: "index.md", content: "x" },
  };

  it("`dry_run` on every write tool is filter_invalid pointing at `plan`, and nothing is written", async () => {
    const ws = workspace();
    const before = { files: files(ws.dir), projection: projection(ws), mints: ws.mints.length };
    for (const tool of SUGAR) {
      const r = await viaServer(ws, tool, { ...MINIMAL[tool]!, dry_run: true });
      expect(r.ok, tool).toBe(false);
      expect(r.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
      expect((r.payload as { message: string }).message, tool).toMatch(/^`dry_run` is no longer an argument — preview with `plan \{ effects: \[\.\.\.\] \}` \(/);
    }
    expect(files(ws.dir)).toEqual(before.files);
    expect(projection(ws)).toEqual(before.projection);
    expect(ws.mints.length).toBe(before.mints);
  });

  it("`ops` on apply, `attrs` on blocks_update, a missing `effects`", async () => {
    const ws = workspace();
    const ops = await viaServer(ws, "apply", { ops: [{ op: "remove", blocks: ["b_47"] }] });
    expect(ops.payload).toMatchObject({ error: "filter_invalid", message: "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0) (apply takes effects, expect?, reason?, repo?, select?)" });
    const both = await viaServer(ws, "apply", { ops: [], effects: [] });
    expect((both.payload as { message: string }).message).toMatch(/^`ops` is no longer an argument/);
    const none = await viaServer(ws, "apply", {});
    expect(none.payload).toMatchObject({ error: "filter_invalid", message: "`effects` is required (apply takes effects, expect?, reason?, repo?, select?)" });
    const attrs = await viaServer(ws, "blocks_update", { _id: "b_56", attrs: { checked: true } });
    expect(attrs.payload).toMatchObject({ error: "filter_invalid", message: "`attrs` is no longer an argument — pass `checked` (blocks_update takes _id, checked?, expect?, markdown?, repo?)" });
    const nothing = await viaServer(ws, "blocks_update", { _id: "b_56" });
    expect(nothing.payload).toMatchObject({ error: "filter_invalid", message: "pass `markdown` and/or `checked` (blocks_update takes _id, checked?, expect?, markdown?, repo?)" });
    const applied = await viaServer(ws, "links_retarget", { from_target: "a", to_target: "b", applied: true });
    expect((applied.payload as { message: string }).message).toMatch(/^unknown argument `applied`/);
    expect(ws.store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });
});

describe("the pinned behaviours of the migration (spec/mutate §10; spec/surface §9)", () => {
  it("blocks_update with `expect: {}` is completed by the planner where the legacy kernel path refused it", async () => {
    const legacy = await legacySide("blocks_update", { _id: "b_1", markdown: "x", expect: {} });
    expect(legacy.outcome.ok).toBe(false);
    expect(legacy.outcome.payload).toMatchObject({ error: "stale_expectation", message: "expect.content_hash required" });
    const migrated = await migratedSide("blocks_update", { _id: "b_1", markdown: "x", expect: {} });
    expect(migrated.outcome.ok).toBe(true);
    expect(migrated.outcome.payload).toMatchObject({ revisions: [{ _id: "d_0", _path: "/index.md" }], new_ids: {}, committed: true });
    // … exactly as the unguarded call (the pin is the live hash either way; the plan ids differ — the empty guard is a digested effect member).
    const unguarded = await migratedSide("blocks_update", { _id: "b_1", markdown: "x" });
    const sans = (o: unknown) => { const { plan_id: _p, ...rest } = o as Record<string, unknown>; return rest; };
    expect(sans(migrated.outcome.payload)).toEqual(sans(unguarded.outcome.payload));
    expect(migrated.projection).toEqual(unguarded.projection);
    expect(migrated.mints).toEqual(unguarded.mints);
    // An order-only guard with `markdown` is the same case; a given content hash is still checked as given.
    const pch = await migratedSide("blocks_update", { _id: "b_1", markdown: "x", expect: { parent_children_hash: "00" } });
    expect(pch.outcome.payload).toMatchObject({ error: "stale_expectation", message: "parent_children_hash mismatch" });
    const stale = await migratedSide("blocks_update", { _id: "b_1", markdown: "x", expect: { content_hash: "00" } });
    expect(stale.outcome.payload).toMatchObject({ error: "stale_expectation", data: { op_index: 0, block: "b_1", expected_content_hash: "00" } });
    expect((stale.outcome.payload as { data: Record<string, unknown> }).data).not.toHaveProperty("effect_index");
  });

  it("blocks_check naming a block twice is one write where the legacy path failed the second op", async () => {
    const legacy = await legacySide("blocks_check", { _ids: ["b_56", "b_56"] });
    expect(legacy.outcome.ok).toBe(false);
    expect(legacy.outcome.payload).toMatchObject({ error: "stale_expectation", data: { op_index: 1, block: "b_56" } });
    const migrated = await migratedSide("blocks_check", { _ids: ["b_56", "b_56", "b_57"] });
    expect(migrated.outcome.ok).toBe(true);
    // … and projects exactly as the deduplicated call.
    const once = await migratedSide("blocks_check", { _ids: ["b_56", "b_57"] });
    expect(once.outcome.payload).toEqual(migrated.outcome.payload);
    expect(once.projection).toEqual(migrated.projection);
    expect(once.mints).toEqual(migrated.mints);
    expect(JSON.parse(migrated.last!.ops!).effects).toHaveLength(2);
  });

  it("an empty block list is an argument error, not a malformed kernel op", async () => {
    const ws = workspace();
    for (const [tool, arg] of [["blocks_move", "blocks"], ["blocks_remove", "blocks"], ["blocks_merge", "blocks"], ["blocks_check", "_ids"]] as const) {
      const r = await viaServer(ws, tool, { [arg]: [], ...(tool === "blocks_move" ? { to: "index.md" } : {}) });
      expect(r.ok).toBe(false);
      expect(r.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
      expect((r.payload as { message: string }).message).toContain(`\`${arg}\` must name at least one block (${tool} takes`);
    }
  });
});

// ---- the document operations: the builders are the one path; their footprint is pinned ----

describe("the document operations return the Receipt and commit through the builders (spec/surface §4 'The document operations', 4.0)", () => {
  const dispositionsOf = (snap: Snapshot, commit: string) =>
    (snap.projection.dispositions as { commit_id: string; kind: string; reason: string | null; matcher_v: string | null; confidence: number | null }[])
      .filter((r) => r.commit_id === commit)
      .map((r) => `${r.kind}/${r.confidence}/${r.reason}/${r.matcher_v}`);

  it("docs_create: revisions[0] is the created document, new_ids its id and blocks, the bytes composed, `inserted/api` dispositions, reason `create <rel>`", async () => {
    const fm = { type: "substance", layer: "working", tags: ["substance", "metal"] };
    const md = "# Gold\n\nThe goal. See [[mercury]] and [mercury](/substances/mercury.md).\n";
    const snap = await migratedSide("docs_create", { path: "/substances/gold.md", markdown: md, frontmatter: fm });
    expect(snap.outcome.ok, JSON.stringify(snap.outcome.payload)).toBe(true);
    const receipt = snap.outcome.payload as Receipt;
    expect(receipt.revisions).toHaveLength(1);
    expect(receipt.revisions[0]).toMatchObject({ _id: "d_20", _path: "/substances/gold.md" });
    expect(receipt.new_ids["$new.0"]).toBe("d_20");
    expect(Object.values(receipt.new_ids).slice(1).every((id) => id.startsWith("b_"))).toBe(true);
    expect(receipt).not.toHaveProperty("_id");
    expect(receipt).not.toHaveProperty("_path");
    expect(snap.files["substances/gold.md"]).toBe(composeFile(md, fm));
    expect(snap.last).toMatchObject({ reason: "create substances/gold.md" });
    expect(snap.last!.ops).toMatch(/"op":"create"/);
    expect([...new Set(dispositionsOf(snap, receipt.commit!))]).toEqual(["inserted/1/api/null"]);
    // The pre-checks keep the legacy envelope: a taken path has the legacy message and no data.
    const taken = await migratedSide("docs_create", { path: "index.md", markdown: "# Again\n" });
    expect(taken.outcome.payload).toEqual({ error: "path_taken", message: "document already exists at index.md", retriable: false, data: {} });
    const onDisk = await migratedSide("docs_create", { path: "lab", markdown: "a directory's name" });
    expect(onDisk.outcome.payload).toEqual({ error: "path_taken", message: "file already exists on disk at lab", retriable: false, data: {} });
  });

  it("docs_set_meta: the Receipt's one revision is the patched document, the bytes are the per-entry patch (spec/mutate 3.6: every untouched key byte-identical, `tags: [...]` kept), no body dispositions (store 14.2: every body block is `same`), reason `set_meta <path>`", async () => {
    const snap = await migratedSide("docs_set_meta", { _path: "substances/salt.md", set: { verified: false, reviewed: "2026-09" }, unset: ["tradition"] });
    expect(snap.outcome.ok).toBe(true);
    const receipt = snap.outcome.payload as Receipt;
    expect(receipt.revisions).toEqual([{ _id: "d_14", _path: "/substances/salt.md", _hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(receipt.new_ids).toEqual({});
    // Per-entry (spec/mutate §11.3, 3.6): `verified`'s line is re-rendered in
    // place, `reviewed` is a new part after the last entry, `tradition`'s part
    // is gone — and the flow list `tags: [substance, tria-prima]` keeps its
    // bytes (through 3.5 the whole mapping was re-serialized as block sequences).
    const source = CORPUS["substances/salt.md"]!;
    expect(source).toContain("tags: [substance, tria-prima]\nverified: true\n---\n");
    const expected = source.replace("tradition: western\n", "").replace("verified: true\n---\n", "verified: false\nreviewed: 2026-09\n---\n");
    expect(snap.files["substances/salt.md"]).toBe(expected);
    const { frontmatter } = splitFrontmatter(snap.files["substances/salt.md"]!);
    expect(frontmatter).toMatchObject({ verified: false, reviewed: "2026-09", tags: ["substance", "tria-prima"] });
    expect(frontmatter).not.toHaveProperty("tradition");
    expect(snap.last).toMatchObject({ reason: "set_meta substances/salt.md" });
    // store 14.2: a frontmatter patch leaves every body block byte-identical in
    // place — `same`, which the store does not persist — so the commit has no
    // disposition rows at all (through 14.1 the head write stamped every carried
    // block `edited/1/api/null`).
    expect([...new Set(dispositionsOf(snap, receipt.commit!))]).toEqual([]);
    // Neither the head write nor the legacy re-ingest minted a block: the commit and the revision only.
    expect(snap.mints).toEqual(["c_20", "r_20"]);
    const empty = await migratedSide("docs_set_meta", { _path: "index.md" });
    expect((empty.outcome.payload as { message: string }).message).toContain("pass `set` and/or `unset` (docs_set_meta takes");
  });

  it("docs_move: the Receipt carries the rewritten sources' revisions plus `retargeted` and `dangling`; `retarget_inbound: false` leaves them as written", async () => {
    const snap = await migratedSide("docs_move", { _path: "texts/mutus-liber.md", to_path: "texts/silent-book.md" });
    expect(snap.outcome.ok).toBe(true);
    const r = snap.outcome.payload as Receipt & { retargeted: { blocks: string[]; docs: string[] } | null; dangling: { _path: string; _block_id: string | null; target: string }[] };
    expect(r.committed).toBe(true);
    expect(r.retargeted).toEqual({ blocks: [expect.stringMatching(/^b_/)], docs: ["d_0"] });
    expect(r.dangling).toEqual([]);
    expect(r.revisions).toEqual([{ _id: "d_0", _path: "/index.md", _hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(snap.files["texts/silent-book.md"]).toBe(CORPUS["texts/mutus-liber.md"]);
    expect(snap.files).not.toHaveProperty("texts/mutus-liber.md");
    expect(snap.files["index.md"]).toContain("[Mutus Liber](/texts/silent-book.md)");
    expect(snap.last).toMatchObject({ reason: "move texts/mutus-liber.md -> texts/silent-book.md" });
    const kept = await migratedSide("docs_move", { _path: "texts/mutus-liber.md", to_path: "texts/silent-book.md", retarget_inbound: false });
    const k = kept.outcome.payload as typeof r;
    expect(k.retargeted).toBeNull();
    expect(k.revisions).toEqual([]);
    expect(k.dangling.map((l) => [l._path, l._block_id, l.target])).toEqual([["/index.md", r.retargeted!.blocks[0], "/texts/mutus-liber.md"]]);
    expect(k.commit).toMatch(/^c_/);
    const taken = await migratedSide("docs_move", { _path: "index.md", to_path: "texts/mutus-liber.md" });
    expect(taken.outcome.payload).toEqual({ error: "path_taken", message: "a document already exists at texts/mutus-liber.md", retriable: false, data: {} });
  });

  it("docs_delete: a tombstone advances no revision — the Receipt has the commit and no revision; the file is gone; reason `delete <path>`", async () => {
    const snap = await migratedSide("docs_delete", { _id: "d_16" });
    expect(snap.outcome.ok).toBe(true);
    expect(snap.outcome.payload).toMatchObject({ commit: "c_20", revisions: [], new_ids: {}, committed: true });
    expect(snap.files).not.toHaveProperty("texts/emerald-tablet.md");
    expect(snap.last).toMatchObject({ reason: "delete texts/emerald-tablet.md" });
    expect(snap.last!.ops).toMatch(/"op":"remove"/);
    const missing = await migratedSide("docs_delete", { _path: "nope.md" });
    expect(missing.outcome.payload).toMatchObject({ error: "doc_missing", data: { _path: "nope.md" } });
  });

  it("N sequential frontmatter patches compose to the bytes of one merged patch over every corpus document (the YAML emitter is idempotent on its own output)", () => {
    // `docs_set_meta` is one `set`/`unset _frontmatter.<k>` effect per key; each
    // lowers as `composeFile(body, parse(previous) patched)`, so the result equals
    // the legacy single `composeFile(body, { ...fm, ...set } minus unset)` iff
    // `stringify ∘ parse` is the identity on what `stringify` wrote.
    for (const path of PATHS) {
      const { frontmatter, body } = splitFrontmatter(CORPUS[path]!);
      const set: Record<string, unknown> = { verified: false, reviewed: "2026-09", tags: ["x", "y"], n: 1.5, era: 1677, nothing: null, nested: { k: "v" } };
      const unset = ["type", "tradition", "nope"];
      const merged: Record<string, unknown> = { ...frontmatter, ...set };
      for (const k of unset) delete merged[k];
      const once = composeFile(body, merged);
      let current = CORPUS[path]!;
      for (const [k, v] of Object.entries(set)) {
        const cur = splitFrontmatter(current);
        current = composeFile(cur.body, { ...cur.frontmatter, [k]: v });
      }
      for (const k of unset) {
        const cur = splitFrontmatter(current);
        const next = { ...cur.frontmatter };
        delete next[k];
        current = composeFile(cur.body, next);
      }
      expect(current, path).toBe(once);
    }
  });
});
