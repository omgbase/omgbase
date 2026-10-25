import type { Store } from "./store.js";
import { referencePath } from "../paths.js";
import { explicitWalker } from "./gc.js";

// History retention (spec/store §7 "Retention: plan, export, squash", 15.0).
// The policy says which revisions of a document stay hot in the store and
// which move to an archive segment; `evaluateRetention` is the policy as an
// exact rule over one repository — deterministic in the store, the policy and
// the clock, so both engines produce the same plan and the fixtures pin it.
// Nothing here writes: `archive.ts` turns a plan into a segment and a squash.

/** `one per <period>`: the ladder's thinning grain. */
export type LadderKeep = "one per day" | "one per week" | "one per month" | "one per year";
export const LADDER_KEEPS: readonly LadderKeep[] = ["one per day", "one per week", "one per month", "one per year"];

export interface LadderRung {
  /** The rung applies to a revision whose age in whole days is at least this. */
  after_days: number;
  keep: LadderKeep;
}

/** A per-path override: the keys given replace the base policy's for the documents the glob matches. */
export interface RetentionOverride {
  glob: string;
  keep_days?: number;
  per_doc_max?: number;
  ladder?: LadderRung[];
  keep_origins?: string[];
}

export interface RetentionPolicy {
  /** Every revision younger than this many days is kept. */
  keep_days: number;
  /** Beyond `keep_days`, one revision per period per rung (sorted by `after_days`). */
  ladder: LadderRung[];
  /** The newest N revisions of a document are kept regardless of age. */
  per_doc_max: number;
  /** A revision whose commit has one of these origins AND a non-empty reason is kept. */
  keep_origins: string[];
  overrides: RetentionOverride[];
}

/** The defaults (spec/store §7): a month hot, then one a day for a year, then one a month; 200 per document; api commits with a reason. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  keep_days: 30,
  ladder: [
    { after_days: 30, keep: "one per day" },
    { after_days: 365, keep: "one per month" },
  ],
  per_doc_max: 200,
  keep_origins: ["api"],
  overrides: [],
};

/** The settings key the policy lives under (`history.retention`, deep-merged over the defaults). */
export const RETENTION_SETTINGS_KEY = "history";
/** The repo-settings key naming the last segment this repo recorded (`history.last_segment`). */
export const LAST_SEGMENT_SETTINGS_KEY = "last_segment";

const DAY_MS = 86_400_000;

export class RetentionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonNegativeInt(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new RetentionPolicyError(`${at} must be a non-negative integer`);
  return v;
}

function parseLadder(v: unknown, at: string): LadderRung[] {
  if (!Array.isArray(v)) throw new RetentionPolicyError(`${at} must be an array of { after_days, keep }`);
  const rungs = v.map((r, i): LadderRung => {
    if (!isRecord(r)) throw new RetentionPolicyError(`${at}[${i}] must be an object`);
    const extra = Object.keys(r).filter((k) => k !== "after_days" && k !== "keep");
    if (extra.length > 0) throw new RetentionPolicyError(`${at}[${i}]: unknown key ${extra[0]}`);
    if (!(LADDER_KEEPS as readonly unknown[]).includes(r.keep)) throw new RetentionPolicyError(`${at}[${i}].keep must be one of ${LADDER_KEEPS.map((k) => JSON.stringify(k)).join(", ")}`);
    return { after_days: nonNegativeInt(r.after_days, `${at}[${i}].after_days`), keep: r.keep as LadderKeep };
  });
  // Sorted by after_days; two rungs at the same age would be ambiguous.
  rungs.sort((a, b) => a.after_days - b.after_days);
  for (let i = 1; i < rungs.length; i++) if (rungs[i]!.after_days === rungs[i - 1]!.after_days) throw new RetentionPolicyError(`${at}: two rungs share after_days ${rungs[i]!.after_days}`);
  return rungs;
}

function parseOrigins(v: unknown, at: string): string[] {
  if (!Array.isArray(v) || v.some((o) => typeof o !== "string")) throw new RetentionPolicyError(`${at} must be an array of strings`);
  return [...(v as string[])];
}

const POLICY_KEYS = new Set(["keep_days", "ladder", "per_doc_max", "keep_origins", "overrides"]);
const OVERRIDE_KEYS = new Set(["glob", "keep_days", "ladder", "per_doc_max", "keep_origins"]);

/**
 * A partial policy (a settings blob, a `--policy` argument) over `base`: every
 * key given replaces the base's; a malformed value is `RetentionPolicyError`.
 */
export function mergeRetentionPolicy(base: RetentionPolicy, partial: unknown, at = "history.retention"): RetentionPolicy {
  if (partial === undefined || partial === null) return { ...base, ladder: [...base.ladder], keep_origins: [...base.keep_origins], overrides: [...base.overrides] };
  if (!isRecord(partial)) throw new RetentionPolicyError(`${at} must be an object`);
  for (const k of Object.keys(partial)) if (!POLICY_KEYS.has(k)) throw new RetentionPolicyError(`${at}: unknown key ${k}`);
  const out: RetentionPolicy = { ...base, ladder: [...base.ladder], keep_origins: [...base.keep_origins], overrides: [...base.overrides] };
  if ("keep_days" in partial) out.keep_days = nonNegativeInt(partial.keep_days, `${at}.keep_days`);
  if ("per_doc_max" in partial) out.per_doc_max = nonNegativeInt(partial.per_doc_max, `${at}.per_doc_max`);
  if ("ladder" in partial) out.ladder = parseLadder(partial.ladder, `${at}.ladder`);
  if ("keep_origins" in partial) out.keep_origins = parseOrigins(partial.keep_origins, `${at}.keep_origins`);
  if ("overrides" in partial) {
    if (!Array.isArray(partial.overrides)) throw new RetentionPolicyError(`${at}.overrides must be an array`);
    out.overrides = partial.overrides.map((o, i): RetentionOverride => {
      const here = `${at}.overrides[${i}]`;
      if (!isRecord(o)) throw new RetentionPolicyError(`${here} must be an object`);
      for (const k of Object.keys(o)) if (!OVERRIDE_KEYS.has(k)) throw new RetentionPolicyError(`${here}: unknown key ${k}`);
      if (typeof o.glob !== "string" || o.glob === "") throw new RetentionPolicyError(`${here}.glob must be a non-empty string`);
      const r: RetentionOverride = { glob: o.glob };
      if ("keep_days" in o) r.keep_days = nonNegativeInt(o.keep_days, `${here}.keep_days`);
      if ("per_doc_max" in o) r.per_doc_max = nonNegativeInt(o.per_doc_max, `${here}.per_doc_max`);
      if ("ladder" in o) r.ladder = parseLadder(o.ladder, `${here}.ladder`);
      if ("keep_origins" in o) r.keep_origins = parseOrigins(o.keep_origins, `${here}.keep_origins`);
      return r;
    });
  }
  return out;
}

/** A settings blob as stored (`workspace_settings.settings`, `repos.settings`): an object, or `{}` for anything else. */
export function parseSettingsJson(json: string | undefined | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * The repo's effective settings (`spec/sync` settings: the workspace layer
 * with the repo's own deep-merged over it at the leaf). Inlined here rather
 * than imported from `sync/settings.ts` — `core/` does not import its
 * siblings — and kept to the rule that module states.
 */
export function effectiveSettings(store: Store, repoId: string): Record<string, unknown> {
  const ws = parseSettingsJson((store.db.prepare("SELECT settings FROM workspace_settings WHERE id = 0").get() as { settings: string } | undefined)?.settings);
  const own = parseSettingsJson((store.db.prepare("SELECT settings FROM repos WHERE repo_id = ?").get(repoId) as { settings: string } | undefined)?.settings);
  const merge = (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      const b = out[k];
      out[k] = isRecord(b) && isRecord(v) ? merge(b, v) : v;
    }
    return out;
  };
  return merge(ws, own);
}

/** The repo's effective policy: the defaults, the settings' `history.retention` over them, then `override` (a CLI `--policy`). */
export function retentionPolicy(store: Store, repoId: string, override?: unknown): RetentionPolicy {
  const settings = effectiveSettings(store, repoId);
  const history = settings[RETENTION_SETTINGS_KEY];
  const configured = isRecord(history) ? history.retention : undefined;
  const base = mergeRetentionPolicy(DEFAULT_RETENTION, configured);
  return override === undefined ? base : mergeRetentionPolicy(base, override, "policy");
}

/**
 * An override glob against a reference path: `**` any run of characters,
 * `*` any run without `/`, `?` one character, everything else literal; a glob
 * without a leading `/` is rooted (`projects/**` ≡ `/projects/**`).
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.startsWith("/") ? glob : `/${glob}`;
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

/** The policy for one document: the first matching override's keys over the base. */
export function policyFor(base: RetentionPolicy, referencePathOfDoc: string): RetentionPolicy {
  for (const o of base.overrides) {
    if (!globToRegExp(o.glob).test(referencePathOfDoc)) continue;
    return {
      keep_days: o.keep_days ?? base.keep_days,
      per_doc_max: o.per_doc_max ?? base.per_doc_max,
      ladder: o.ladder ?? base.ladder,
      keep_origins: o.keep_origins ?? base.keep_origins,
      overrides: [],
    };
  }
  return base;
}

/** Whole days between a commit's `ts` and `now` (negative when the commit is in the future). */
export function ageDays(ts: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(ts)) / DAY_MS);
}

/** The period key of a timestamp under a rung's grain (UTC; a week starts on Monday). */
export function periodKey(ts: string, keep: LadderKeep): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  switch (keep) {
    case "one per day": return `${y}-${m}-${day}`;
    case "one per month": return `${y}-${m}`;
    case "one per year": return `${y}`;
    case "one per week": {
      // The Monday of the ISO week, as a date.
      const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
      const dow = (monday.getUTCDay() + 6) % 7; // Monday = 0
      monday.setUTCDate(monday.getUTCDate() - dow);
      return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}`;
    }
  }
}

// ---- the plan ------------------------------------------------------------------

export interface RetentionDocPlan {
  id: string;
  /** The document's current path, reference form. */
  path: string;
  /** Live (non-archived) revisions of the document before the plan. */
  revisions: number;
  /** Revision ids kept, oldest first. */
  keep: string[];
  /** Revision ids to archive, oldest first. */
  archive: string[];
  /** Bytes of blobs and tree nodes reachable from the archived revisions and from no kept revision of the store. */
  bytes: number;
}

export interface RetentionTotals {
  /** Documents with at least one revision to archive. */
  docs: number;
  /** Live revisions of the repository before the plan. */
  revisions: number;
  keep: number;
  archive: number;
  /** Bytes reachable only from the archived revisions, over their union. */
  bytes: number;
}

export interface RetentionPlan {
  policy: RetentionPolicy;
  now: string;
  before: string | null;
  /** Only the documents with something to archive, by path. */
  docs: RetentionDocPlan[];
  totals: RetentionTotals;
}

export interface EvaluateOptions {
  /** The clock; `new Date()` when absent (the spec seam pins it). */
  now?: string;
  /** Only revisions committed strictly before this instant are candidates. */
  before?: string;
  /** The policy in effect; `retentionPolicy(store, repoId)` when absent. */
  policy?: RetentionPolicy;
}

interface RevRow {
  rev_id: string;
  doc_id: string;
  seq: number;
  root_tree: Buffer | null;
  frontmatter_blob: Buffer | null;
  commit_id: string;
  ts: string;
  origin: string;
  reason: string | null;
  archive: string | null;
}

/**
 * The sizes of the blobs and tree nodes of a store, and the walk that marks
 * what a set of revisions reaches (spec/store §7: the GC mark, run twice — once
 * from what stays, once from what goes — to cost a plan).
 */
export class ReachMarker {
  private readonly treeNode;
  private readonly blobSize;
  private readonly treeSizes = new Map<string, number>();
  private readonly blobSizes = new Map<string, number>();

  constructor(private readonly store: Store) {
    this.treeNode = store.db.prepare("SELECT entries FROM tree_nodes WHERE hash = ?");
    this.blobSize = store.db.prepare("SELECT size FROM blobs WHERE hash = ?");
  }

  /** Mark every tree node and blob the given revisions name EXPLICITLY (spec/store §7, 16.0: a `{`-node's own entries, not its base's) into `trees`/`blobs` (hex). */
  mark(revs: { root_tree: Buffer | null; frontmatter_blob: Buffer | null }[], trees: Set<string>, blobs: Set<string>): void {
    const walk = explicitWalker(this.store.db, trees, blobs, (hashHex, entries) => this.treeSizes.set(hashHex, Buffer.byteLength(entries)));
    for (const r of revs) {
      if (r.root_tree) walk(r.root_tree.toString("hex"));
      if (r.frontmatter_blob) blobs.add(r.frontmatter_blob.toString("hex"));
    }
  }

  /** Bytes of the given tree nodes (their `entries`) and blobs (`size`). */
  bytesOf(trees: Iterable<string>, blobs: Iterable<string>): number {
    let n = 0;
    for (const t of trees) {
      let size = this.treeSizes.get(t);
      if (size === undefined) {
        const node = this.treeNode.get(Buffer.from(t, "hex")) as { entries: string } | undefined;
        size = node ? Buffer.byteLength(node.entries) : 0;
        this.treeSizes.set(t, size);
      }
      n += size;
    }
    for (const b of blobs) {
      let size = this.blobSizes.get(b);
      if (size === undefined) {
        size = (this.blobSize.get(Buffer.from(b, "hex")) as { size: number } | undefined)?.size ?? 0;
        this.blobSizes.set(b, size);
      }
      n += size;
    }
    return n;
  }
}

/**
 * The plan (spec/store §7 "Retention", the policy as an exact rule). Per
 * document, over its live revisions oldest → newest: a revision is KEPT when
 * any rule keeps it — it is the document's current revision (a tombstoned
 * document's last revision is its current one), a `pending_materializations`
 * row names it, it is younger than `keep_days`, it is among the newest
 * `per_doc_max`, its commit's origin is in `keep_origins` with a non-empty
 * reason, it is not before `before`, no ladder rung applies to its age (the
 * gap below the first rung keeps everything), or it is the newest revision of
 * its rung's period; every other revision is ARCHIVED. Bytes are the GC mark
 * from the archived revisions minus the mark from every revision that stays
 * live in the store (all repositories — blobs and tree nodes are shared).
 */
export function evaluateRetention(store: Store, repoId: string, opts: EvaluateOptions = {}): RetentionPlan {
  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const before = opts.before ?? null;
  const beforeMs = before === null ? null : Date.parse(before);
  const base = opts.policy ?? retentionPolicy(store, repoId);
  const db = store.db;

  const docs = db
    .prepare("SELECT doc_id, path, head FROM docs WHERE repo_id = ? ORDER BY path")
    .all(repoId) as { doc_id: string; path: string; head: string | null }[];
  const revStmt = db.prepare(
    `SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.commit_id, c.ts, c.origin, c.reason, r.archive
     FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.doc_id = ? ORDER BY r.seq`,
  );
  const pinned = new Set(
    (db.prepare("SELECT rev_id FROM pending_materializations WHERE repo_id = ? AND rev_id IS NOT NULL").all(repoId) as { rev_id: string }[]).map((r) => r.rev_id),
  );

  const archiveSet = new Set<string>();
  const perDoc: { doc: { doc_id: string; path: string }; live: RevRow[]; keep: string[]; archive: RevRow[] }[] = [];
  let totalLive = 0;
  for (const d of docs) {
    const rows = (revStmt.all(d.doc_id) as RevRow[]).filter((r) => r.archive === null);
    totalLive += rows.length;
    if (rows.length === 0) continue;
    const policy = policyFor(base, referencePath(d.path));
    const kept = new Set<string>();
    // Rules 1–6: the per-revision keeps.
    rows.forEach((r, i) => {
      const rank = rows.length - i; // 1 = the newest
      if (r.rev_id === d.head) kept.add(r.rev_id);
      else if (pinned.has(r.rev_id)) kept.add(r.rev_id);
      else if (ageDays(r.ts, nowMs) < policy.keep_days) kept.add(r.rev_id);
      else if (rank <= policy.per_doc_max) kept.add(r.rev_id);
      else if (policy.keep_origins.includes(r.origin) && r.reason !== null && r.reason !== "") kept.add(r.rev_id);
      else if (beforeMs !== null && Date.parse(r.ts) >= beforeMs) kept.add(r.rev_id);
    });
    // Rule 7: the ladder. Each remaining revision belongs to the rung with the
    // greatest `after_days` not above its age; the newest revision of each
    // (rung, period) bucket — over every live revision of the document in that
    // bucket, kept or not — is the bucket's representative and is kept.
    const representative = new Map<string, RevRow>();
    const bucketOf = new Map<string, string>();
    for (const r of rows) {
      const age = ageDays(r.ts, nowMs);
      if (age < policy.keep_days) continue;
      let rung: LadderRung | undefined;
      for (const l of policy.ladder) if (l.after_days <= age) rung = l;
      if (!rung) {
        kept.add(r.rev_id); // the gap below the first rung: nothing says to thin it
        continue;
      }
      const key = `${rung.after_days}|${rung.keep}|${periodKey(r.ts, rung.keep)}`;
      bucketOf.set(r.rev_id, key);
      const cur = representative.get(key);
      if (!cur || r.seq > cur.seq) representative.set(key, r);
    }
    for (const r of representative.values()) kept.add(r.rev_id);
    const keep: string[] = [];
    const archive: RevRow[] = [];
    for (const r of rows) {
      if (kept.has(r.rev_id)) keep.push(r.rev_id);
      else {
        archive.push(r);
        archiveSet.add(r.rev_id);
      }
    }
    perDoc.push({ doc: d, live: rows, keep, archive });
  }

  // Costing: the mark from everything that stays live in the whole store.
  const marker = new ReachMarker(store);
  const keptTrees = new Set<string>();
  const keptBlobs = new Set<string>();
  const liveRevs = db.prepare("SELECT rev_id, root_tree, frontmatter_blob FROM revisions WHERE archive IS NULL").all() as { rev_id: string; root_tree: Buffer | null; frontmatter_blob: Buffer | null }[];
  marker.mark(liveRevs.filter((r) => !archiveSet.has(r.rev_id)), keptTrees, keptBlobs);
  const unionTrees = new Set<string>();
  const unionBlobs = new Set<string>();
  const planned: RetentionDocPlan[] = [];
  let keepTotal = 0;
  for (const p of perDoc) {
    keepTotal += p.keep.length;
    if (p.archive.length === 0) continue;
    const trees = new Set<string>();
    const blobs = new Set<string>();
    marker.mark(p.archive, trees, blobs);
    const onlyTrees = [...trees].filter((t) => !keptTrees.has(t));
    const onlyBlobs = [...blobs].filter((b) => !keptBlobs.has(b));
    for (const t of onlyTrees) unionTrees.add(t);
    for (const b of onlyBlobs) unionBlobs.add(b);
    planned.push({
      id: p.doc.doc_id,
      path: referencePath(p.doc.path),
      revisions: p.live.length,
      keep: p.keep,
      archive: p.archive.map((r) => r.rev_id),
      bytes: marker.bytesOf(onlyTrees, onlyBlobs),
    });
  }
  return {
    policy: base,
    now,
    before,
    docs: planned,
    totals: {
      docs: planned.length,
      revisions: totalLive,
      keep: keepTotal,
      archive: archiveSet.size,
      bytes: marker.bytesOf(unionTrees, unionBlobs),
    },
  };
}
