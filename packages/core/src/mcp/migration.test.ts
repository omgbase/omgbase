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
import { composeFile, docsCreate, docsDelete, docsMove, docsSetMeta, splitFrontmatter, type DocOpContext } from "../mutate/docs.js";
import { planUpdate } from "../mutate/plan-update.js";
import { opsetKernelOps } from "../mutate/opset.js";
import { surfaceApplyResult, surfaceDocMoveResult, surfaceDocOpResult, surfaceRetargetHits } from "../surface-paths.js";
import { CORPUS_TS, FIXTURE_REPO_SLUG, cmpBytes, readCorpusFromDisk } from "../../corpus/surface/fixture.js";
import { EngineError, errorBody } from "./errors.js";
import { buildServer } from "./server.js";

// ADR-021, the migration phase (spec/surface 3.2 + 3.3): the twelve block-level
// sugar tools of batch 1 and the four document operations of batch 2
// (`docs_create`, `docs_delete`, `docs_move`, `docs_set_meta`) are
// `apply { effects }` sugar. This suite proves the migration
// behaviour-preserving over the alchemy corpus: for every tool, the pre-migration
// handler (reproduced here over the library — `apply` + the macros + the
// document operations, the code the tools called before) and the migrated
// handler (through the MCP server) run on identical workspaces under the fixture
// minter and the same clock, and must agree on
//
//   - the tool's result (or its error envelope),
//   - the store projection (docs, blocks, revisions, commits minus `ops`,
//     dispositions) and the files on disk,
//   - the exact sequence of ids minted — committed and dry run alike (a dry
//     run still burns the ids the real run would take: the realize-symbols shim),
//
// with one intended difference: a migrated commit carries the intent record in
// `commits.ops` (legacy rows stay NULL). The two behaviour FIXES the design
// pins (spec/mutate §10, 3.2) are asserted as divergences at the end, as is the
// one identity change batch 2 accepts (spec/surface §9, 3.3): a committed
// `docs_set_meta` is a known-id head write, not a reconciling re-ingest, so its
// dispositions differ (`edited/api` for every block, not `same/exact_hash`
// under the matcher); rows, files and mints are otherwise identical. Mutate 3.0
// (slice 3) adds the second: a committed `docs_create` ingests the planner's
// ADOPTED tree with known ids — `inserted/api` dispositions, the `b` ids minted
// before the transaction instead of inside it (same ids, different order) — and
// its dry run realizes the created document's block symbols too. The last
// `describe` compares `docs_update` (4.0: `set content` sugar) with its legacy
// handler over the library.

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

// ---- the migrated side: the MCP server ---------------------------------------------

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

// ---- the legacy side: the HEAD~ handlers over the library ----------------------------
//
// Each function is the pre-3.2 body of the tool handler in `server.ts`, with the
// server's private helpers (ref resolution, CAS pinning, section resolution)
// reproduced verbatim. Refs are passed as ids/paths, so resolution is trivial.

type Args = Record<string, unknown> & { dry_run?: boolean };
type Legacy = (ws: Ws, a: Args) => unknown;

function blockMissing(value: string): EngineError {
  return new EngineError("block_missing", `no block with id ${JSON.stringify(value)}`, { data: { id: value } });
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
  const id = a.id as string | undefined;
  const path = a.path as string | undefined;
  const given = { ...(id !== undefined ? { id } : {}), ...(path !== undefined ? { path } : {}) };
  const missing = (v: string) => new EngineError("doc_missing", `no document with id or path ${JSON.stringify(v)}`, { data: given });
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
  if (matches.length === 0) throw new EngineError("parent_missing", `no heading ${JSON.stringify(section)} in ${shown}`, { data: { section, path: shown } });
  if (matches.length > 1) throw new EngineError("ambiguous_heading", `heading ${JSON.stringify(section)} matches ${matches.length} headings in ${shown}; pass the heading's id to blocks_append`, { data: { section, path: shown, candidates: matches.map((m) => ({ id: m.block_id, doc_id: m.doc_id })) } });
  return matches[0]!.block_id;
}
function legacyApply(ws: Ws, ops: Op[], reason: string, dryRun?: boolean) {
  return surfaceApplyResult(apply(ws.store, { repoId: ws.repoId, rootPath: ws.dir, ops, origin: { actor: "agent:mcp", reason }, ...(dryRun !== undefined ? { dryRun } : {}) }));
}
/** The pre-3.3 `docCtx` of the document tools (the server passes no `omgbaseDir` here, as `buildServer` below gets none). */
function docCtx(ws: Ws, dryRun?: boolean): DocOpContext {
  return { repoId: ws.repoId, rootPath: ws.dir, actor: "agent:mcp", ...(dryRun ? { dryRun: true } : {}) };
}

const LEGACY: Record<string, Legacy> = {
  blocks_insert: (ws, a) => {
    const { parent, docId } = resolveParentRef(ws, a.to as string);
    const to = { parent, at: (a.at as Op extends { to: { at: infer A } } ? A : never) ?? "end" };
    const ops: Op[] = [{ op: "insert", ...(typeof parent === "object" ? { doc: docId } : {}), to, markdown: a.markdown as string, ...(a.expect ? { expect: a.expect } : {}) } as Op];
    return legacyApply(ws, ops, "blocks_insert", a.dry_run);
  },
  blocks_update: (ws, a) => {
    const block = resolveBlockRef(ws, a.id as string);
    const expect = (a.expect as Record<string, string> | undefined) ?? (() => { const h = pinHash(ws, block); return h ? { content_hash: h } : undefined; })();
    const attrs = (a.checked !== undefined || a.attrs)
      ? { ...(a.checked !== undefined ? { checked: a.checked } : {}), ...((a.attrs as Record<string, unknown>) ?? {}) }
      : undefined;
    const ops: Op[] = [{ op: "update", block, ...(a.markdown !== undefined ? { markdown: a.markdown } : {}), ...(attrs ? { attrs } : {}), ...(expect ? { expect } : {}) } as Op];
    const res = legacyApply(ws, ops, "blocks_update", a.dry_run);
    const ids = res.results[0]?.ids ?? [block];
    return { id: ids[0] ?? block, ids, ...res };
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
    const block = resolveBlockRef(ws, a.id as string);
    return legacyApply(ws, [{ op: "split", block, at: a.at as number[], expect: { content_hash: pinHash(ws, block) ?? "" } } as Op], "blocks_split", a.dry_run);
  },
  blocks_merge: (ws, a) => {
    const blocks = (a.blocks as string[]).map((b) => resolveBlockRef(ws, b));
    return legacyApply(ws, [{ op: "merge", blocks, ...(a.separator !== undefined ? { separator: a.separator } : {}) } as Op], "blocks_merge", a.dry_run);
  },
  blocks_check: (ws, a) => {
    const blocks = (a.ids as string[]).map((b) => resolveBlockRef(ws, b));
    const checked = (a.checked as boolean | undefined) ?? true;
    const ops: Op[] = checked
      ? tasksComplete(ws.store, blocks)
      : blocks.map((block) => ({ op: "update", block, attrs: { checked: false }, ...(() => { const h = pinHash(ws, block); return h ? { expect: { content_hash: h } } : {}; })() } as Op));
    return legacyApply(ws, ops, "blocks_check", a.dry_run);
  },
  nodes_set: (ws, a) => {
    const known = ws.store.db.prepare("SELECT 1 FROM nodes WHERE node_id = ? AND repo_id = ?").get(a.id, ws.repoId);
    if (!known) throw new EngineError("block_missing", `no node with id ${JSON.stringify(a.id)}`, { data: { id: a.id } });
    return legacyApply(ws, nodeSet(ws.store, a.id as string, a.prop as string, a.value as string), "nodes_set", a.dry_run);
  },
  blocks_append: (ws, a) => {
    const block = resolveBlockRef(ws, a.id as string);
    const row = ws.store.db
      .prepare("SELECT b.type AS type, d.format AS format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_commit IS NULL) AS children FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_commit IS NULL")
      .get(block) as { type: string; format: string | null; children: number } | undefined;
    if (!row) throw blockMissing(a.id as string);
    let ops: Op[];
    if (row.type === "heading") ops = sectionsAppend(block, a.text as string);
    else if (isContainerBlock(row.format ?? "markdown", { type: row.type, children: new Array<unknown>(row.children) })) ops = [{ op: "insert", to: { parent: block, at: "end" }, markdown: a.text as string } as Op];
    else {
      throw new EngineError("block_not_container", `block ${block} is a ${row.type}, not a heading or a container; append means into — insert after it with blocks_insert { to: <its parent>, at: { after: ${JSON.stringify(block)} } }`, { data: { id: block, type: row.type } });
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
    const dryRun = a.dry_run !== false;
    const res = legacyApply(ws, ops, "links_retarget", dryRun);
    return { hits, pairs, applied: !dryRun, ...res };
  },
  links_repair: (ws, a) => {
    const repairs = (a.repairs as { from: string; to: string }[] | undefined)
      ?? (a.from_target !== undefined && a.to_target !== undefined ? [{ from: a.from_target as string, to: a.to_target as string }] : null);
    if (!repairs || repairs.length === 0) throw new EngineError("target_missing", "links_repair requires `repairs` (array of {from,to}) or a `from_target`+`to_target` pair");
    const { ops, hits: rawHits, pairs } = linksRepair(ws.store, ws.repoId, repairs, a.path_glob ? { pathGlob: a.path_glob as string } : {});
    const hits = surfaceRetargetHits(rawHits);
    const dryRun = a.dry_run !== false;
    const res = legacyApply(ws, ops, "links_repair", dryRun);
    return { hits, pairs, applied: !dryRun, ...res };
  },
  // batch 2 (3.3): the pre-migration document tool handlers — the library's
  // document operations behind `locateDoc` and the surface re-shaping.
  docs_create: (ws, a) => surfaceDocOpResult(docsCreate(ws.store, docCtx(ws, a.dry_run), a.path as string, a.markdown as string, a.frontmatter as Record<string, unknown> | undefined)),
  docs_move: (ws, a) => {
    const docId = locateDoc(ws, a);
    return surfaceDocMoveResult(docsMove(ws.store, docCtx(ws, a.dry_run), docId, a.to_path as string, { retargetInbound: a.retarget_inbound !== false }));
  },
  docs_delete: (ws, a) => {
    const docId = locateDoc(ws, a);
    return surfaceDocOpResult(docsDelete(ws.store, docCtx(ws, a.dry_run), docId));
  },
  docs_set_meta: (ws, a) => {
    const docId = locateDoc(ws, a);
    return surfaceDocOpResult(docsSetMeta(ws.store, docCtx(ws, a.dry_run), docId, {
      ...(a.set ? { set: a.set as Record<string, unknown> } : {}),
      ...(a.unset ? { unset: a.unset as string[] } : {}),
    }));
  },
  // 4.0: the pre-retirement `docs_update` — the opset planned, then committed
  // through the kernel with the opset's ops and `set_frontmatter` (`applyOpset`).
  docs_update: (ws, a) => {
    const docId = locateDoc(ws, a);
    const opset = planUpdate(ws.store, ws.repoId, ws.dir, docId, a.content as string);
    if (!opset.converges) throw new EngineError("plan_not_convergent", "legacy: does not converge");
    const result = surfaceApplyResult(apply(ws.store, {
      repoId: ws.repoId, rootPath: ws.dir, ops: opsetKernelOps(opset),
      origin: { actor: "agent:mcp", ...(a.reason !== undefined ? { reason: a.reason as string } : {}) },
      ...(opset.frontmatter ? { setFrontmatter: [{ doc: docId, raw: opset.frontmatter.raw }] } : {}),
    }));
    return { opset, result };
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
  /** `links_*` default to a dry run: the committed form sets `dry_run: false` */
  dryDefault?: boolean;
}

const SCENARIOS: Scenario[] = [
  { tool: "blocks_insert", args: { to: "processes/calcination.md", markdown: "## Notes\n\nInserted at the end.\n" } },
  { tool: "blocks_insert", args: { to: "b_149", markdown: "- calcined tin → white putty powder\n", at: { after: "b_150" } } },
  { tool: "blocks_insert", args: { to: "index.md", markdown: "Up front.\n", at: "start", expect: {} } },
  { tool: "blocks_insert", args: { to: "b_1", markdown: "x" } },
  { tool: "blocks_insert", args: { to: "processes/calcination.md", markdown: "x", expect: { parent_children_hash: "00" } } },
  { tool: "blocks_insert", args: { to: "nope.md", markdown: "x" } },
  { tool: "blocks_update", args: { id: "b_1", markdown: "The art of transformation, revised." } },
  { tool: "blocks_update", args: { id: "b_1", markdown: "First para.\n\nSecond para.\n" } },
  { tool: "blocks_update", args: { id: "b_56", checked: true } },
  { tool: "blocks_update", args: { id: "b_52", checked: false } },
  { tool: "blocks_update", args: { id: "b_56", markdown: "- [ ] Pre-fire crucibles again", checked: true } },
  { tool: "blocks_update", args: { id: "b_56", attrs: { checked: false }, checked: true } },
  { tool: "blocks_update", args: { id: "b_1", markdown: "x", expect: { content_hash: "00" } } },
  { tool: "blocks_update", args: { id: "b_1", markdown: "Guarded.", expect: { content_hash: "cfe406f7c3a7fd71e90c28015168bc1cfee0111e5f624425d9c4223c6c5a11a7" } } },
  { tool: "blocks_update", args: { id: "b_1", attrs: { foo: "bar" } } },
  { tool: "blocks_update", args: { id: "b_1" } },
  { tool: "blocks_update", args: { id: "b_999", markdown: "x" } },
  { tool: "blocks_move", args: { blocks: ["b_7"], to: "b_4", at: "start" } },
  { tool: "blocks_move", args: { blocks: ["b_29", "b_30"], to: "index.md", at: { before: "b_2" } } },
  { tool: "blocks_move", args: { blocks: ["b_5"], to: "lab/2026-01-notes.md" } },
  { tool: "blocks_move", args: { blocks: ["b_7"], to: "b_4", at: "start", expect: { parent_children_hash: "00" } } },
  { tool: "blocks_move", args: { blocks: ["b_7"], to: "b_1" } },
  { tool: "blocks_remove", args: { blocks: ["b_47", "b_58"] } },
  { tool: "blocks_remove", args: { blocks: ["b_4", "b_5", "b_5"] } },
  { tool: "blocks_remove", args: { blocks: ["b_999"] } },
  { tool: "blocks_split", args: { id: "b_1", at: [98] } },
  { tool: "blocks_split", args: { id: "b_1", at: [0] } },
  { tool: "blocks_merge", args: { blocks: ["b_43", "b_44"] } },
  { tool: "blocks_merge", args: { blocks: ["b_43", "b_44"], separator: "\n\n" } },
  { tool: "blocks_merge", args: { blocks: ["b_1", "b_43"] } },
  { tool: "blocks_check", args: { ids: ["b_56", "b_57"] } },
  { tool: "blocks_check", args: { ids: ["b_52"], checked: false } },
  { tool: "blocks_check", args: { ids: ["b_1"] } },
  { tool: "nodes_set", args: { id: "n_c7ebbf77d614", prop: "name", value: "Calcination" } },
  { tool: "nodes_set", args: { id: "n_9e25b3a6f1e2", prop: "value", value: "substances/mercury.md" } },
  { tool: "nodes_set", args: { id: "n_nope", prop: "name", value: "x" } },
  { tool: "blocks_append", args: { id: "b_29", text: "Bench notes are dated by month.\n" } },
  { tool: "blocks_append", args: { id: "b_4", text: "- quintessence\n" } },
  { tool: "blocks_append", args: { id: "b_1", text: "x" } },
  { tool: "docs_append", args: { path: "processes/calcination.md", section: "Products", text: "- calcined tin → white putty powder\n" } },
  { tool: "docs_append", args: { path: "texts/mutus-liber.md", text: "## Addendum\n\nAppended text.\n" } },
  { tool: "docs_append", args: { id: "d_16", text: "Trailing line.\n" } },
  { tool: "docs_append", args: { path: "processes/calcination.md", section: "Nope", text: "x" } },
  { tool: "docs_append", args: { path: "nope.md", text: "x" } },
  { tool: "links_retarget", args: { from_target: "nigredo", to_target: "processes/magnum-opus.md" }, dryDefault: true },
  { tool: "links_retarget", args: { from_target: "zzz-nothing", to_target: "a.md" }, dryDefault: true },
  { tool: "links_retarget", args: { from_target: "salt", to_target: "substances/salt.md", path_glob: "lab/*" }, dryDefault: true },
  { tool: "links_repair", args: { repairs: [{ from: "magnum-opus", to: "processes/magnum-opus.md" }, { from: "mercury", to: "substances/mercury.md" }] }, dryDefault: true },
  { tool: "links_repair", args: {}, dryDefault: true },
  // batch 2 (3.3): the document operations
  { tool: "docs_create", args: { path: "substances/gold.md", markdown: "# Gold\n\nThe goal. See [[mercury]] and [mercury](/substances/mercury.md).\n", frontmatter: { type: "substance", layer: "working", tags: ["substance", "metal"] } } },
  { tool: "docs_create", args: { path: "/notes/plain.md", markdown: "No frontmatter, no trailing newline." } },
  { tool: "docs_create", args: { path: "texts/empty.md", markdown: "" } },
  { tool: "docs_create", args: { path: "texts/with-fm.md", markdown: "# Heading\n\n- a\n- b\n", frontmatter: { n: 1, ok: true, nothing: null } } },
  { tool: "docs_create", args: { path: "index.md", markdown: "# Again\n" } },
  { tool: "docs_create", args: { path: "lab", markdown: "a directory's name" } },
  { tool: "docs_delete", args: { path: "texts/emerald-tablet.md" } },
  { tool: "docs_delete", args: { id: "d_16" } },
  { tool: "docs_delete", args: { path: "/index.md" } },
  { tool: "docs_delete", args: { path: "nope.md" } },
  { tool: "docs_move", args: { path: "texts/mutus-liber.md", to_path: "texts/silent-book.md" } },
  { tool: "docs_move", args: { path: "texts/mutus-liber.md", to_path: "/texts/silent-book.md", retarget_inbound: false } },
  { tool: "docs_move", args: { path: "substances/salt.md", to_path: "substances/sal.md" } },
  { tool: "docs_move", args: { id: "d_7", to_path: "moved/calcination.md" } },
  { tool: "docs_move", args: { path: "processes/calcination.md", to_path: "processes/fire.md", retarget_inbound: false } },
  { tool: "docs_move", args: { path: "timeline/kickoff.md", to_path: "timeline/start.md" } },
  { tool: "docs_move", args: { path: "index.md", to_path: "texts/mutus-liber.md" } },
  { tool: "docs_move", args: { path: "index.md", to_path: "lab" } },
  { tool: "docs_move", args: { path: "nope.md", to_path: "x.md" } },
  { tool: "docs_set_meta", args: { path: "substances/salt.md", set: { verified: false, reviewed: "2026-09" }, unset: ["tradition"] } },
  { tool: "docs_set_meta", args: { path: "texts/mutus-liber.md", set: { tags: ["text", "images", "plates"], era: 1700, nested: { k: "v" } } } },
  { tool: "docs_set_meta", args: { path: "index.md", unset: ["type"] } },
  { tool: "docs_set_meta", args: { path: "lab/2026-01-notes.md", set: { a: 1, b: "two" }, unset: ["a", "nope"] } },
  { tool: "docs_set_meta", args: { id: "d_16", set: { layer: "canon" } } },
  { tool: "docs_set_meta", args: { path: "timeline/review.md", set: { status: "done" } } },
  { tool: "docs_set_meta", args: { path: "nope.md", set: { a: 1 } } },
];

/** The reason a document operation records (spec/mutate §6) — the migrated tools pass it through. */
const DOC_REASON = /^(create|delete|move|set_meta) /;
/** A committed `docs_set_meta`: the one scenario kind whose projection is allowed to differ (dispositions) — §9, 3.3. */
function isSetMetaCommit(s: Scenario, dry: boolean, ok: boolean): boolean {
  return s.tool === "docs_set_meta" && !dry && ok;
}
/** A successful `docs_create` (mutate 3.0, slice 3): known-id ingest of the adopted tree — dispositions and mint ORDER differ. */
function isCreate(s: Scenario, ok: boolean): boolean {
  return s.tool === "docs_create" && ok;
}

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

/** The migrated handler through the MCP server on a fresh workspace, snapshotted. */
async function migratedSide(tool: string, args: Args): Promise<Snapshot> {
  const b = workspace();
  const seed = b.mints.length;
  const outcome = await withClock(CORPUS_TS, () => viaServer(b, tool, args));
  return snapshot(b, seed, outcome);
}

async function compare(s: Scenario, dry: boolean): Promise<void> {
  const args: Args = { ...s.args, ...(s.dryDefault ? (dry ? {} : { dry_run: false }) : dry ? { dry_run: true } : {}) };
  const legacy = await legacySide(s.tool, args);
  const migrated = await migratedSide(s.tool, args);

  expect(migrated.outcome.ok, `migrated ${migrated.outcome.ok ? "succeeded" : "failed"} where legacy ${legacy.outcome.ok ? "succeeded" : "failed"}: ${JSON.stringify(migrated.outcome.payload)}`).toBe(legacy.outcome.ok);
  expect(migrated.outcome.payload).toEqual(legacy.outcome.payload);
  expect(migrated.files).toEqual(legacy.files);
  if (isCreate(s, legacy.outcome.ok)) {
    const { dispositions: legacyDispositions, ...legacyRest } = legacy.projection;
    const { dispositions: migratedDispositions, ...migratedRest } = migrated.projection;
    expect(migratedRest).toEqual(legacyRest);
    if (dry) {
      // Nothing written either way; the shim realizes every symbol — the `d` the
      // legacy dry run minted, then the created document's block symbols (3.0).
      expect(migratedDispositions).toEqual(legacyDispositions);
      expect(migrated.mints.slice(0, legacy.mints.length)).toEqual(legacy.mints);
      expect(migrated.mints.slice(legacy.mints.length).every((id) => id.startsWith("b_"))).toBe(true);
    } else {
      // The api rule: every block `inserted / 1 / api / null` where the reconciling
      // ingest wrote `inserted / null / null / m*`; the same ids, the `b`s minted by
      // the replay's parse before the transaction (the legacy ingest minted them inside it).
      const commit = legacy.last ? (legacy.projection.commits as { commit_id: string; seq: number }[]).reduce((a, b) => (a.seq > b.seq ? a : b)).commit_id : null;
      const relabelled = (legacyDispositions as Record<string, unknown>[])
        .map((d) => (d.commit_id === commit ? { ...d, confidence: 1, reason: "api", matcher_v: null } : d))
        .sort((a, b) => cmpBytes(JSON.stringify(a), JSON.stringify(b)));
      expect(migratedDispositions).toEqual(relabelled);
      expect([...migrated.mints].sort()).toEqual([...legacy.mints].sort());
      if (legacy.mints.some((id) => id.startsWith("b_"))) expect(migrated.mints).not.toEqual(legacy.mints);
      const firstNonBlock = migrated.mints.findIndex((id) => !id.startsWith("b_"));
      expect(migrated.mints.slice(firstNonBlock).some((id) => id.startsWith("b_"))).toBe(false);
    }
  } else if (isSetMetaCommit(s, dry, legacy.outcome.ok)) {
    // The accepted identity change (spec/surface §9, 3.3): the known-id head
    // write labels every block of the document itself where the reconciling
    // re-ingest ran the matcher — the rows differ in `dispositions` only (the
    // matcher assigns the known ids after parsing, so neither side burns a block id).
    const { dispositions: legacyDispositions, ...legacyRest } = legacy.projection;
    const { dispositions: migratedDispositions, ...migratedRest } = migrated.projection;
    expect(migratedRest).toEqual(legacyRest);
    expect(legacyDispositions).not.toEqual(migratedDispositions);
    expect(migrated.mints, "minted ids").toEqual(legacy.mints);
  } else {
    expect(migrated.mints, "minted ids").toEqual(legacy.mints);
    expect(migrated.projection).toEqual(legacy.projection);
  }

  // The intended difference: a committed migrated write records its intent.
  if (legacy.outcome.ok && !dry) {
    expect(migrated.last?.reason).toBe(legacy.last?.reason);
    if (migrated.last && (migrated.last.reason === s.tool || DOC_REASON.test(migrated.last.reason ?? ""))) {
      const legacyBag = s.tool === "blocks_update" && (("attrs" in s.args && Object.keys(s.args.attrs as object).some((k) => k !== "checked")) || !("markdown" in s.args || "checked" in s.args || "attrs" in s.args));
      if (legacyBag) expect(migrated.last.ops).toBeNull();
      else {
        expect(legacy.last?.ops).toBeNull();
        expect(migrated.last.ops).toMatch(/^\{"effects":\[/);
      }
    }
  }
}

describe("ADR-021 migration: the sugar tools equal their legacy handlers over the alchemy corpus", () => {
  for (const s of SCENARIOS) {
    it(`committed — ${label(s)}`, async () => { await compare(s, false); });
    it(`dry run — ${label(s)}`, async () => { await compare(s, true); });
  }
});

describe("the pinned divergences (spec/mutate §10: the two 3.2 fixes; surface 3.3: the set_meta identity change, the empty-patch argument error)", () => {
  it("blocks_update with `expect: {}` is completed by the planner where the legacy kernel path refused it", async () => {
    const legacy = await legacySide("blocks_update", { id: "b_1", markdown: "x", expect: {} });
    expect(legacy.outcome.ok).toBe(false);
    expect(legacy.outcome.payload).toMatchObject({ error: "stale_expectation", message: "expect.content_hash required" });
    const migrated = await migratedSide("blocks_update", { id: "b_1", markdown: "x", expect: {} });
    expect(migrated.outcome.ok).toBe(true);
    expect(migrated.outcome.payload).toMatchObject({ id: "b_1", ids: ["b_1"], results: [{ ids: ["b_1"] }], committed: true });
    // … exactly as the unguarded call (the pin is the live hash either way).
    const unguarded = await migratedSide("blocks_update", { id: "b_1", markdown: "x" });
    expect(migrated.outcome.payload).toEqual(unguarded.outcome.payload);
    expect(migrated.projection).toEqual(unguarded.projection);
    expect(migrated.mints).toEqual(unguarded.mints);
    // An order-only guard with `markdown` is the same case; a given content hash is still checked as given.
    const pch = await migratedSide("blocks_update", { id: "b_1", markdown: "x", expect: { parent_children_hash: "00" } });
    expect(pch.outcome.payload).toMatchObject({ error: "stale_expectation", message: "parent_children_hash mismatch" });
    const stale = await migratedSide("blocks_update", { id: "b_1", markdown: "x", expect: { content_hash: "00" } });
    expect(stale.outcome.payload).toMatchObject({ error: "stale_expectation", data: { op_index: 0, block: "b_1", expected_content_hash: "00" } });
    expect((stale.outcome.payload as { data: Record<string, unknown> }).data).not.toHaveProperty("effect_index");
  });

  it("blocks_check naming a block twice is one write where the legacy path failed the second op", async () => {
    const legacy = await legacySide("blocks_check", { ids: ["b_56", "b_56"] });
    expect(legacy.outcome.ok).toBe(false);
    expect(legacy.outcome.payload).toMatchObject({ error: "stale_expectation", data: { op_index: 1, block: "b_56" } });
    const migrated = await migratedSide("blocks_check", { ids: ["b_56", "b_56", "b_57"] });
    expect(migrated.outcome.ok).toBe(true);
    expect((migrated.outcome.payload as { results: unknown[] }).results).toEqual([{ ids: ["b_56"] }, { ids: ["b_57"] }]);
    // … and projects exactly as the deduplicated call.
    const once = await migratedSide("blocks_check", { ids: ["b_56", "b_57"] });
    expect(once.outcome.payload).toEqual(migrated.outcome.payload);
    expect(once.projection).toEqual(migrated.projection);
    expect(once.mints).toEqual(migrated.mints);
  });

  it("docs_set_meta commits a known-id head write: `edited`/`api` dispositions where the re-ingest matched `same`/`exact_hash` (surface 3.3, §9)", async () => {
    const legacy = await legacySide("docs_set_meta", { path: "substances/salt.md", set: { verified: false, reviewed: "2026-09" }, unset: ["tradition"] });
    const migrated = await migratedSide("docs_set_meta", { path: "substances/salt.md", set: { verified: false, reviewed: "2026-09" }, unset: ["tradition"] });
    expect(migrated.outcome.payload).toEqual(legacy.outcome.payload);
    expect(migrated.files).toEqual(legacy.files);
    const kinds = (snap: Snapshot) => {
      const rows = snap.projection.dispositions as { commit_id: string; kind: string; reason: string | null; matcher_v: string | null; confidence: number | null }[];
      const last = rows.filter((r) => r.commit_id === "c_20");
      return { n: last.length, kinds: [...new Set(last.map((r) => `${r.kind}/${r.reason}/${r.matcher_v}`))].sort() };
    };
    // The reconciling re-ingest: every block `same` by exact hash under the matcher…
    expect(kinds(legacy)).toEqual({ n: 20, kinds: ["same/exact_hash/m2.3"] });
    // …the known-id head write: every block of the touched document `edited` by the api, no matcher.
    expect(kinds(migrated)).toEqual({ n: 20, kinds: ["edited/api/null"] });
    // Neither side burns a block id (the reconciler assigns the known ids after
    // its parse; the head write parses nothing): the commit and revision only.
    expect(legacy.mints).toEqual(["c_20", "r_20"]);
    expect(migrated.mints).toEqual(legacy.mints);
  });

  it("N sequential frontmatter patches compose to the bytes of one merged patch over every corpus document (the YAML emitter is idempotent on its own output)", () => {
    // `docs_set_meta` is one `set`/`unset frontmatter.<k>` effect per key; each
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

  it("docs_set_meta with an empty patch is an argument error (3.3; it used to rewrite the frontmatter for nothing)", async () => {
    const ws = workspace();
    for (const args of [{ path: "index.md" }, { path: "index.md", set: {}, unset: [] }, { path: "index.md", set: { a: 1 }, unset: ["a"] }]) {
      const r = await viaServer(ws, "docs_set_meta", args);
      if ("set" in args && args.set && "a" in args.set) {
        // `unset` wins the shared key: one `unset` effect, a real write.
        expect(r.ok, JSON.stringify(r.payload)).toBe(true);
        continue;
      }
      expect(r.ok).toBe(false);
      expect(r.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
      expect((r.payload as { message: string }).message).toContain("pass `set` and/or `unset` (docs_set_meta takes");
    }
  });

  it("an empty block list is an argument error, not a malformed kernel op", async () => {
    const ws = workspace();
    for (const [tool, arg] of [["blocks_move", "blocks"], ["blocks_remove", "blocks"], ["blocks_merge", "blocks"], ["blocks_check", "ids"]] as const) {
      const r = await viaServer(ws, tool, { [arg]: [], ...(tool === "blocks_move" ? { to: "index.md" } : {}) });
      expect(r.ok).toBe(false);
      expect(r.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
      expect((r.payload as { message: string }).message).toContain(`\`${arg}\` must name at least one block (${tool} takes`);
    }
  });
});

describe("docs_update is `set content` sugar (surface 4.0): the Receipt path commits what the legacy opset path committed", () => {
  const NEWTON = CORPUS["practitioners/newton.md"]!;
  const UPDATES: [string, string, string][] = [
    ["an edited paragraph and a replaced task", "practitioners/newton.md", NEWTON.replace("Wrote more on alchemy than on physics, and published almost none of it.", "Wrote more on alchemy than on physics, and published almost none of it.").replace("1643–1727.", "1643–1727.")
      .replace("- [ ] Read the Index Chemicus entries on [[mercury]]", "- [x] Read the Index Chemicus entries on [[mercury]]")],
    ["a frontmatter change and a new paragraph", "substances/salt.md", CORPUS["substances/salt.md"]!.replace("verified: true", "verified: false") + "\nA closing remark.\n"],
    ["content already current", "texts/emerald-tablet.md", CORPUS["texts/emerald-tablet.md"]!],
  ];
  for (const [label, path, content] of UPDATES) {
    it(label, async () => {
      const legacy = await legacySide("docs_update", { path, content, reason: "interop" });
      const migrated = await migratedSide("docs_update", { path, content, reason: "interop" });
      expect(legacy.outcome.ok).toBe(true);
      expect(migrated.outcome.ok).toBe(true);
      // The same bytes land; the rows agree table by table in count, the revisions
      // in hash, the dispositions in kind/reason (both are known-id api writes).
      expect(migrated.files).toEqual(legacy.files);
      for (const table of Object.keys(legacy.projection)) expect(migrated.projection[table]!.length, table).toBe(legacy.projection[table]!.length);
      const shape = (rows: unknown[]) => (rows as Record<string, unknown>[]).map((r) => [r.kind, r.reason, r.matcher_v, r.confidence].join("/")).sort();
      expect(shape(migrated.projection.dispositions!)).toEqual(shape(legacy.projection.dispositions!));
      const hashes = (rows: unknown[]) => (rows as Record<string, unknown>[]).map((r) => r.rendered_hash).sort();
      expect(hashes(migrated.projection.revisions!)).toEqual(hashes(legacy.projection.revisions!));
      // The Receipt names the same revisions the legacy result did.
      const legacyResult = (legacy.outcome.payload as { result: { revisions: unknown[]; committed: boolean } }).result;
      expect(migrated.outcome.payload).toMatchObject({ committed: true, revisions: legacyResult.revisions });
      expect(migrated.last?.reason).toBe(legacy.last?.reason);
      if (legacyResult.revisions.length === 0) {
        // The zero-effects rule: neither side records a commit.
        expect(migrated.outcome.payload).toMatchObject({ commit: null });
        expect(migrated.projection.commits).toEqual(legacy.projection.commits);
      } else {
        expect(migrated.outcome.payload).toMatchObject({ commit: expect.stringMatching(/^c_/) });
        expect(migrated.last?.ops).toMatch(/"field":"content"/);
        // The planner's verify no longer burns real ids (it mints under a throwaway symbol table).
        expect(migrated.mints.length).toBeLessThan(legacy.mints.length);
      }
    });
  }
});
