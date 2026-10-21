// End-state checks, run through an omg MCP server after the loop ends — under an
// omgbase profile the run's own server (it has already re-ingested anything the
// hook wrote to disk); under `fs` a `full` server spawned after `omg sync` has
// observed the agent's disk writes (src/bench.ts). The oracle is the same for every
// profile. Every check returns a list of failure strings; empty = passed.
import { isDeepStrictEqual } from "node:util";
import type { OmgServer } from "./mcp.ts";
import { answerRegex } from "./tasks.ts";
import type { AnswerCheck, Check, FinalTextCheck, Task } from "./types.ts";
import { DEFAULT_CORPUS, fixtureBytes, vaultDiff, type Workspace } from "./workspace.ts";

export interface CheckContext {
  server: OmgServer;
  /** the model's final assistant text */
  finalText: string;
  /** the run's workspace — names the corpus the `unchanged` checks compare against and the vault `unchanged_all` walks (alchemy when absent) */
  workspace?: Workspace;
}

function describe(v: unknown, max = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** `docs_read { _path }` → `_raw` (spec/surface 5.0: a row attribute is `_`-prefixed in the argument and the result alike). */
async function readRaw(server: OmgServer, path: string): Promise<string | null> {
  const r = await server.call("docs_read", { _path: path });
  if (!r.ok) return null;
  return (r.result as { _raw: string })._raw;
}

/** The `api`-origin commits, each with the paths it touched (`changes_since`; a digest's `revisions` are rows `{ _id, _path, _hash }`, spec/sync 3.0). */
async function apiCommits(server: OmgServer): Promise<{ commit: string; paths: string[] }[] | string> {
  const r = await server.call("changes_since", { origin: "api", limit: 500 });
  if (!r.ok) return `changes_since failed: ${describe(r.result)}`;
  const digests = (r.result as { digests: { commit: string; revisions: { _path: string }[] }[] }).digests;
  return digests.map((d) => ({ commit: d.commit, paths: d.revisions.map((rev) => rev._path) }));
}

/**
 * Does the text mention the entry — as a case-insensitive substring, or by the `/…/`
 * regex? A substring entry rooted at `/` matches either path form: the `fs` tools
 * print `practitioners/x.md` and the omg tools `/practitioners/x.md`, and both are
 * the one document.
 */
export function mentions(text: string, entry: string): boolean {
  const re = answerRegex(entry);
  if (re) return re.test(text);
  const t = text.toLowerCase();
  const e = entry.toLowerCase();
  return t.includes(e) || (e.startsWith("/") && t.includes(e.slice(1)));
}

/** The repository-root form of a path as the model may have written it: `` `a/b.md` `` → `/a/b.md` (backticks, surrounding quotes and whitespace dropped, one leading slash). */
export function normalizePath(p: string): string {
  const bare = p.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim().replace(/^\/+/, "");
  return `/${bare}`;
}

/** The body of the LAST fenced code block tagged `answer` (```answer … ```), or null when the text has none. */
export function answerBlock(text: string): string | null {
  const re = /^[ \t]*(`{3,}|~{3,})[ \t]*answer[ \t]*\r?\n([\s\S]*?)\r?\n?^[ \t]*\1[ \t]*$/gim;
  let body: string | null = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) body = m[2] ?? "";
  return body;
}

/**
 * The paths an `answer` block lists, normalized, in order, each once: one per line;
 * a list marker (`- `, `* `, `1. `) the model added anyway is dropped, so is a blank
 * line. Anything else on a line is part of the "path" and will not match — the
 * block is for paths only.
 */
export function blockPaths(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    if (line === "") continue;
    const p = normalizePath(line);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Lenient mode: where the path first appears in the text, in either form (−1 when it does not). */
function foundLeniently(text: string, path: string): number {
  return text.toLowerCase().indexOf(normalizePath(path).slice(1).toLowerCase());
}

/** The `paths` half of the `answer` check: strict (the block) or lenient (anywhere in the text). */
function checkPaths(check: AnswerCheck, finalText: string, mode: "strict" | "lenient"): string[] {
  const want = (check.paths ?? []).map(normalizePath);
  const failures: string[] = [];
  if (mode === "lenient") {
    const positions = want.map((p) => [p, foundLeniently(finalText, p)] as const);
    for (const [p, at] of positions) if (at < 0) failures.push(`answer (lenient) does not mention ${p}`);
    if (check.ordered && failures.length === 0) {
      const order = positions.map(([, at]) => at);
      if (order.some((at, i) => i > 0 && at < order[i - 1]!)) failures.push(`answer (lenient) names the paths out of order: ${want.join(", ")} expected in that order`);
    }
    return failures;
  }
  const body = answerBlock(finalText);
  if (body === null) return ["answer: no ```answer block in the final text (the prompt asks for one listing the matching paths, one per line)"];
  const got = blockPaths(body);
  const missing = want.filter((p) => !got.includes(p));
  const extra = got.filter((p) => !want.includes(p));
  if (missing.length > 0) failures.push(`answer block is missing ${missing.join(", ")}`);
  if (extra.length > 0) failures.push(`answer block lists ${extra.length} path(s) that do not belong: ${extra.join(", ")}`);
  if (check.ordered && failures.length === 0 && got.some((p, i) => p !== want[i])) failures.push(`answer block order differs: got ${got.join(", ")}; expected ${want.join(", ")}`);
  return failures;
}

/**
 * The `answer` check over a final text (pure; exported for the tests and the
 * rescore). `mode` overrides the check's own (`pnpm bench rescore` passes "lenient"
 * for a run that predates the block sentence).
 */
export function checkAnswer(check: AnswerCheck, finalText: string, mode?: "strict" | "lenient"): string[] {
  const failures: string[] = [];
  const m = mode ?? check.mode ?? "strict";
  // Lenient: a check with `must_mention` is judged by it alone — the legacy prompts asked for prose facts (titles, headings, task
  // texts) and those entries were the legacy verdict; `paths` entered with the block sentence. Only a check with nothing else falls
  // back to the paths anywhere in the text.
  if (check.paths && !(m === "lenient" && check.must_mention)) failures.push(...checkPaths(check, finalText, m));
  for (const e of check.must_mention ?? []) if (!mentions(finalText, e)) failures.push(`answer does not mention ${JSON.stringify(e)}`);
  if (failures.length > 0) failures.push(`answer was: ${describe(finalText)}`);
  return failures;
}

/** The checks that need only the final text — what a rescore can re-run without the workspace. */
export function isTextOnly(check: Check): check is AnswerCheck | FinalTextCheck {
  return check.kind === "answer" || check.kind === "final_text";
}

/** Was this stored failure string produced by a text-only check (`answer`, `final_text`)? The rescore drops these and keeps the rest. */
export function isTextOnlyFailure(failure: string): boolean {
  return /^(answer\b|final text does not match)/.test(failure);
}

/** The `final_text` check over a final text (pure). */
export function checkFinalText(check: FinalTextCheck, finalText: string): string[] {
  return new RegExp(check.matches, "is").test(finalText) ? [] : [`final text does not match /${check.matches}/: ${describe(finalText)}`];
}

export async function runCheck(check: Check, ctx: CheckContext): Promise<string[]> {
  const { server } = ctx;
  const corpus = ctx.workspace?.corpus ?? DEFAULT_CORPUS;
  const failures: string[] = [];
  switch (check.kind) {
    case "query": {
      const r = await server.call("query", { query: check.query, limit: 500 });
      if (!r.ok) return [`query failed: ${describe(r.result)}`];
      const v = r.result as { hits: Record<string, unknown>[]; count?: number };
      if (check.count !== undefined && v.count !== check.count) failures.push(`count ${v.count} ≠ ${check.count} for ${check.query}`);
      if (check.hits) {
        if (v.hits.length !== check.hits.length) {
          failures.push(`${v.hits.length} hit(s) ≠ ${check.hits.length} for ${check.query}: ${describe(v.hits)}`);
        } else {
          check.hits.forEach((want, i) => {
            const got = v.hits[i]!;
            for (const [k, val] of Object.entries(want)) {
              if (!isDeepStrictEqual(got[k], val)) failures.push(`hit ${i}.${k} = ${describe(got[k])} ≠ ${describe(val)} for ${check.query}`);
            }
          });
        }
      }
      return failures;
    }
    case "read": {
      const raw = await readRaw(server, check.path);
      if (raw === null) return [`${check.path}: not readable (missing?)`];
      if (check.equals !== undefined && raw !== check.equals) failures.push(`${check.path}: bytes differ from the expected content`);
      for (const re of check.matches ?? []) if (!new RegExp(re, "s").test(raw)) failures.push(`${check.path}: does not match /${re}/`);
      for (const re of check.not_matches ?? []) if (new RegExp(re, "s").test(raw)) failures.push(`${check.path}: matches /${re}/ but must not`);
      return failures;
    }
    case "unchanged": {
      // Bytes first; then no `api`-origin commit. Under `fs` the second half is vacuous
      // (the sweep's commits are observed, never api) and the bytes carry the check.
      const raw = await readRaw(server, check.path);
      if (raw === null) return [`${check.path}: not readable (missing?)`];
      if (raw !== fixtureBytes(check.path, corpus)) failures.push(`${check.path}: bytes differ from the fixture`);
      const commits = await apiCommits(server);
      if (typeof commits === "string") return [...failures, commits];
      const touched = commits.filter((c) => c.paths.includes(check.path));
      if (touched.length > 0) failures.push(`${check.path}: ${touched.length} api commit(s) touched it (${touched.map((c) => c.commit).join(", ")})`);
      return failures;
    }
    case "final_text":
      return checkFinalText(check, ctx.finalText);
    case "answer":
      return checkAnswer(check, ctx.finalText);
  }
}

/**
 * `unchanged_all`: the vault equals the corpus file for file (nothing added, removed
 * or edited — compared on disk, so it holds under every profile) and no `api`-origin
 * commit exists anywhere (vacuous under `fs`, where the bytes carry it).
 */
export async function checkUnchangedAll(ctx: CheckContext): Promise<string[]> {
  if (!ctx.workspace) return ["unchanged_all needs the run's workspace"];
  const failures: string[] = [];
  const diff = vaultDiff(ctx.workspace);
  if (diff.length > 0) failures.push(`the vault differs from the ${ctx.workspace.corpus} corpus in ${diff.length} file(s): ${diff.slice(0, 5).join(", ")}${diff.length > 5 ? ", …" : ""}`);
  const commits = await apiCommits(ctx.server);
  if (typeof commits === "string") return [...failures, commits];
  if (commits.length > 0) failures.push(`${commits.length} api commit(s) were made (${commits.map((c) => c.commit).join(", ")}) touching ${[...new Set(commits.flatMap((c) => c.paths))].join(", ")}`);
  return failures;
}

/** Every check of the task (and `unchanged_all` when set); the failures of all of them. */
export async function runChecks(task: Task, ctx: CheckContext): Promise<string[]> {
  const failures: string[] = [];
  for (const c of task.checks) failures.push(...(await runCheck(c, ctx)));
  if (task.unchanged_all) failures.push(...(await checkUnchangedAll(ctx)));
  return failures;
}
