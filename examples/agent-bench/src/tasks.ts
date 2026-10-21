// tasks/*.json: load and validate. A task is a prompt, machine-checkable end-state
// checks, an optional hook and the two scripted solutions the dry run and the tests
// replay — `solution` in the omgbase tools, `solution_fs` in the file tools. Validation is structural (every member typed, ids unique, regexes
// compile); whether a check is *right* is what `pnpm bench --dry` proves.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CORPORA, PACKAGE_ROOT } from "./workspace.ts";
import { REQUIREMENTS, type Check, type Hook, type Solution, type SolutionStep, type Task } from "./types.ts";

export const TASKS_DIR = join(PACKAGE_ROOT, "tasks");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function regexOk(re: string): boolean {
  try {
    new RegExp(re, "s");
    return true;
  } catch {
    return false;
  }
}

const CHECK_KINDS = new Set(["query", "read", "unchanged", "final_text", "answer"]);

/** An `answer` entry written `/…/` is a regex; anything else a substring. */
export function answerRegex(entry: string): RegExp | null {
  const m = /^\/(.+)\/$/s.exec(entry);
  return m ? new RegExp(m[1]!, "is") : null;
}

function answerEntryOk(entry: string): boolean {
  try {
    answerRegex(entry);
    return true;
  } catch {
    return false;
  }
}

function validateCheck(c: unknown, at: string, problems: string[]): void {
  if (!isRecord(c)) return void problems.push(`${at}: a check must be an object`);
  if (typeof c.kind !== "string" || !CHECK_KINDS.has(c.kind)) return void problems.push(`${at}: kind must be one of ${[...CHECK_KINDS].join(", ")}`);
  const allowed: Record<string, string[]> = {
    query: ["kind", "query", "hits", "count"],
    read: ["kind", "path", "equals", "matches", "not_matches"],
    unchanged: ["kind", "path"],
    final_text: ["kind", "matches"],
    answer: ["kind", "paths", "ordered", "mode", "must_mention"],
  };
  for (const k of Object.keys(c)) if (!allowed[c.kind]!.includes(k)) problems.push(`${at}: unknown member \`${k}\` on a ${c.kind} check`);
  switch (c.kind as Check["kind"]) {
    case "query":
      if (typeof c.query !== "string" || c.query.trim() === "") problems.push(`${at}: query must be a non-empty string`);
      if (c.hits === undefined && c.count === undefined) problems.push(`${at}: a query check needs \`hits\` and/or \`count\``);
      if (c.hits !== undefined && !(Array.isArray(c.hits) && c.hits.every(isRecord))) problems.push(`${at}: hits must be an array of objects`);
      if (c.count !== undefined && !(Number.isInteger(c.count) && (c.count as number) >= 0)) problems.push(`${at}: count must be a non-negative integer`);
      break;
    case "read":
      if (typeof c.path !== "string") problems.push(`${at}: path must be a string`);
      if (c.equals === undefined && c.matches === undefined && c.not_matches === undefined) problems.push(`${at}: a read check needs equals, matches or not_matches`);
      if (c.equals !== undefined && typeof c.equals !== "string") problems.push(`${at}: equals must be a string`);
      for (const key of ["matches", "not_matches"] as const) {
        if (c[key] === undefined) continue;
        if (!isStringArray(c[key])) problems.push(`${at}: ${key} must be an array of regex strings`);
        else for (const re of c[key] as string[]) if (!regexOk(re)) problems.push(`${at}: ${key} /${re}/ does not compile`);
      }
      break;
    case "unchanged":
      if (typeof c.path !== "string") problems.push(`${at}: path must be a string`);
      break;
    case "final_text":
      if (typeof c.matches !== "string" || !regexOk(c.matches)) problems.push(`${at}: matches must be a regex string`);
      break;
    case "answer":
      if (c.paths === undefined && c.must_mention === undefined) problems.push(`${at}: an answer check needs \`paths\` and/or \`must_mention\``);
      if (c.paths !== undefined) {
        if (!isStringArray(c.paths) || c.paths.length === 0) problems.push(`${at}: paths must be a non-empty array of strings`);
        else {
          for (const p of c.paths) if (!/^\/[^\s`'"]+\.md$/.test(p)) problems.push(`${at}: paths entry ${JSON.stringify(p)} must be a repository-root \`.md\` path (\`/a/b.md\`)`);
          if (new Set(c.paths).size !== c.paths.length) problems.push(`${at}: paths must not repeat`);
        }
      }
      if (c.ordered !== undefined && typeof c.ordered !== "boolean") problems.push(`${at}: ordered must be a boolean`);
      if (c.ordered !== undefined && c.paths === undefined) problems.push(`${at}: ordered needs paths`);
      if (c.mode !== undefined) problems.push(`${at}: mode is set by the rescore, not by a task file`);
      if (c.must_mention !== undefined) {
        if (!isStringArray(c.must_mention) || c.must_mention.length === 0) problems.push(`${at}: must_mention must be a non-empty array of strings`);
        else for (const e of c.must_mention) if (e === "" || !answerEntryOk(e)) problems.push(`${at}: must_mention entry ${JSON.stringify(e)} is empty or does not compile`);
      }
      break;
  }
}

function validateHook(h: unknown, at: string, problems: string[]): void {
  if (!isRecord(h)) return void problems.push(`${at}: hook must be an object`);
  if (h.kind !== "disk_edit") problems.push(`${at}: hook.kind must be "disk_edit"`);
  if (h.on !== "after_first_plan") problems.push(`${at}: hook.on must be "after_first_plan"`);
  if (h.also_before_first_write !== undefined && typeof h.also_before_first_write !== "boolean") problems.push(`${at}: hook.also_before_first_write must be a boolean`);
  if (typeof h.path !== "string") problems.push(`${at}: hook.path must be a string`);
  if (typeof h.append !== "string" || h.append === "") problems.push(`${at}: hook.append must be a non-empty string`);
  for (const k of Object.keys(h)) if (!["kind", "on", "also_before_first_write", "path", "append"].includes(k)) problems.push(`${at}: unknown hook member \`${k}\``);
}

function validateSolution(s: unknown, at: string, problems: string[]): void {
  if (!isRecord(s)) return void problems.push(`${at}: must be an object (steps + final_text)`);
  if (!Array.isArray(s.steps)) problems.push(`${at}: steps must be an array`);
  else {
    s.steps.forEach((step: unknown, i) => {
      const sa = `${at}.steps[${i}]`;
      if (!isRecord(step)) return void problems.push(`${sa}: must be an object`);
      if (typeof step.tool !== "string") problems.push(`${sa}: tool must be a string`);
      if (!isRecord(step.args)) problems.push(`${sa}: args must be an object`);
      if (step.expect_error !== undefined && typeof step.expect_error !== "string") problems.push(`${sa}: expect_error must be a string`);
      for (const k of Object.keys(step)) if (!["tool", "args", "expect_error"].includes(k)) problems.push(`${sa}: unknown member \`${k}\``);
      // a $result may only point backwards
      const refs: number[] = [];
      JSON.stringify(step.args, (_k, v: unknown) => {
        if (isRecord(v) && typeof v.$result === "number") refs.push(v.$result);
        return v;
      });
      for (const r of refs) if (r >= i) problems.push(`${sa}: $result ${r} must refer to an earlier step`);
    });
  }
  if (typeof s.final_text !== "string") problems.push(`${at}: final_text must be a string`);
}

const TASK_KEYS = new Set(["id", "prompt", "corpus", "requires", "checks", "unchanged_all", "hook", "solution", "solution_fs", "trivial_on_fresh", "notes"]);

/** Structural problems of one task document (empty = valid). */
export function validateTask(doc: unknown, at: string): string[] {
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${at}: a task must be an object`];
  for (const k of Object.keys(doc)) if (!TASK_KEYS.has(k)) problems.push(`${at}: unknown member \`${k}\``);
  if (typeof doc.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(doc.id)) problems.push(`${at}: id must be a kebab-case string`);
  if (typeof doc.prompt !== "string" || doc.prompt.trim() === "") problems.push(`${at}: prompt must be a non-empty string`);
  if (doc.corpus !== undefined && (typeof doc.corpus !== "string" || !(doc.corpus in CORPORA))) problems.push(`${at}: corpus must be one of ${Object.keys(CORPORA).join(", ")}`);
  if (doc.requires !== undefined) {
    if (!isStringArray(doc.requires)) problems.push(`${at}: requires must be an array of strings`);
    else for (const r of doc.requires) if (!REQUIREMENTS.includes(r)) problems.push(`${at}: unknown requirement \`${r}\` (known: ${REQUIREMENTS.join(", ")})`);
  }
  if (doc.unchanged_all !== undefined && typeof doc.unchanged_all !== "boolean") problems.push(`${at}: unchanged_all must be a boolean`);
  if (!Array.isArray(doc.checks) || doc.checks.length === 0) problems.push(`${at}: checks must be a non-empty array`);
  else doc.checks.forEach((c: unknown, i) => validateCheck(c, `${at}.checks[${i}]`, problems));
  if (doc.hook !== undefined) validateHook(doc.hook, `${at}.hook`, problems);
  validateSolution(doc.solution, `${at}.solution`, problems);
  validateSolution(doc.solution_fs, `${at}.solution_fs`, problems);
  if (doc.trivial_on_fresh !== undefined && typeof doc.trivial_on_fresh !== "boolean") problems.push(`${at}: trivial_on_fresh must be a boolean`);
  if (doc.notes !== undefined && typeof doc.notes !== "string") problems.push(`${at}: notes must be a string`);
  return problems;
}

export interface LoadedTasks {
  tasks: Task[];
  problems: string[];
}

/** Every `tasks/*.json`, sorted by file name; a file whose id differs from its name is a problem. */
export function loadTasks(dir = TASKS_DIR): LoadedTasks {
  const tasks: Task[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const p = validateTask(doc, file);
    if (p.length > 0) {
      problems.push(...p);
      continue;
    }
    const task = doc as Task;
    if (task.id !== file.replace(/\.json$/, "")) problems.push(`${file}: id "${task.id}" must equal the file name`);
    if (seen.has(task.id)) problems.push(`${file}: duplicate id "${task.id}"`);
    seen.add(task.id);
    tasks.push(task);
  }
  return { tasks, problems };
}

/** Narrowing helpers the tests use. */
export type { Check, Hook, Solution, SolutionStep, Task };
