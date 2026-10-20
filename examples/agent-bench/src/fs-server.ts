// The filesystem baseline (`--profiles fs`): an in-process tool server over the
// workspace's vault/ directory — the same corpus copy the omg profiles ingest —
// exposing seven generic, Claude-Code-like file tools and nothing of omgbase.
// Paths the model passes are vault-relative in either form (`/a/b.md` or
// `a/b.md`); `..` escapes and anything outside the vault are refused. Every result
// is JSON text, errors `{ error: <code>, message }` with `ok: false`, so the loop's
// metrics (`failed_by_code`) read the same as for an omg server.
import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import type { CallOutcome, ToolServer } from "./server.ts";
import { FS_PROFILE } from "./types.ts";
import type { Workspace } from "./workspace.ts";

/** `grep` returns at most this many matching lines; the result says when it was cut. */
export const GREP_CAP = 200;

const PATH = { type: "string", description: "a file path relative to the vault root, with or without a leading slash (`notes/a.md` or `/notes/a.md`)" } as const;

/** The seven tools, described as a generic file-tool server would describe them. */
export const FS_TOOLS: readonly Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List the Markdown files (`.md`) in the vault as sorted vault-relative paths, recursing into subdirectories. Pass `dir` to list one directory only.",
    input_schema: { type: "object", properties: { dir: { type: "string", description: "a directory relative to the vault root (default: the root)" } }, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a file and return its complete text.",
    input_schema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Create a file, or replace an existing file's entire content, with `content`. Missing parent directories are created. To change part of an existing file prefer `edit_file`.",
    input_schema: { type: "object", properties: { path: PATH, content: { type: "string", description: "the complete new content of the file" } }, required: ["path", "content"], additionalProperties: false },
  },
  {
    name: "edit_file",
    description: "Replace one exact occurrence of `old_string` in a file with `new_string`. `old_string` must appear exactly once: the call fails without touching the file when it matches nowhere or more than once, so include enough surrounding text to make it unique. Read the file first so the match is exact (whitespace included).",
    input_schema: {
      type: "object",
      properties: { path: PATH, old_string: { type: "string", description: "the exact text to replace (must occur exactly once)" }, new_string: { type: "string", description: "the replacement text" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: `Search the vault's Markdown files for a regular expression (JavaScript syntax, case-sensitive). Returns the matching lines as \`path:line: text\`, optionally restricted to files whose path matches \`glob\` (\`*\` within a path segment, \`**\` across segments, e.g. \`notes/*.md\` or \`**/index.md\`). At most ${GREP_CAP} lines are returned; the result says when the output was cut.`,
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string", description: "a regular expression" }, glob: { type: "string", description: "limit the search to files matching this glob (default: every .md file)" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file. Missing parent directories of `to` are created; the call fails when `from` does not exist or `to` already exists.",
    input_schema: { type: "object", properties: { from: PATH, to: PATH }, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "delete_file",
    description: "Delete a file.",
    input_schema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
  },
];

export const FS_TOOL_NAMES: readonly string[] = FS_TOOLS.map((t) => t.name);

/** A refused call: `code` is what the model sees as `error` and the metrics count under `failed_by_code`. */
export class FsToolError extends Error {
  readonly code: string;
  readonly data?: Record<string, unknown>;
  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (data) this.data = data;
  }
}

/** A glob with `*` (within a segment), `**` (across segments) and `?`, anchored to the whole vault-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/^\/+/, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") i++; // `**/` matches zero or more directories
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new FsToolError("invalid_arguments", `\`${key}\` must be a string`);
  return v;
}

export class FsServer implements ToolServer {
  readonly profile = FS_PROFILE;
  /** the vault directory every path is resolved against */
  readonly root: string;

  constructor(workspaceOrRoot: Workspace | string) {
    this.root = resolve(typeof workspaceOrRoot === "string" ? workspaceOrRoot : workspaceOrRoot.vault);
  }

  tools(): Promise<Anthropic.Tool[]> {
    return Promise.resolve(FS_TOOLS.map((t) => ({ ...t })));
  }

  /**
   * A vault-relative path in either form → `{ abs, rel }` (rel with `/` separators,
   * no leading slash). Refuses an escape (`..`, or anything resolving outside the vault).
   */
  resolvePath(p: string): { abs: string; rel: string } {
    if (p.includes("\0")) throw new FsToolError("outside_vault", "path contains a NUL byte");
    const rel = posix.normalize(p.replace(/\\/g, "/").replace(/^\/+/, ""));
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new FsToolError("outside_vault", `${p} is outside the vault; paths are relative to the vault root and may not escape it`, { path: p });
    }
    return { abs, rel: abs === this.root ? "" : relative(this.root, abs).split(sep).join("/") };
  }

  private listMarkdown(absDir: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    walk(absDir);
    return out.sort();
  }

  private requireFile(p: string): { abs: string; rel: string } {
    const r = this.resolvePath(p);
    if (!existsSync(r.abs) || !statSync(r.abs).isFile()) throw new FsToolError("not_found", `${p}: no such file`, { path: p });
    return r;
  }

  /** The tool itself; throws `FsToolError` for a refused call. */
  run(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "list_files": {
        const dir = args.dir === undefined ? "" : str(args, "dir");
        const { abs, rel } = this.resolvePath(dir);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new FsToolError("not_found", `${dir}: no such directory`, { dir });
        return { dir: rel, files: this.listMarkdown(abs) };
      }
      case "read_file": {
        const { abs, rel } = this.requireFile(str(args, "path"));
        return { path: rel, content: readFileSync(abs, "utf8") };
      }
      case "write_file": {
        const { abs, rel } = this.resolvePath(str(args, "path"));
        const content = str(args, "content");
        if (existsSync(abs) && statSync(abs).isDirectory()) throw new FsToolError("is_directory", `${rel} is a directory`, { path: rel });
        const created = !existsSync(abs);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        return { path: rel, created, bytes: Buffer.byteLength(content) };
      }
      case "edit_file": {
        const { abs, rel } = this.requireFile(str(args, "path"));
        const oldString = str(args, "old_string");
        const newString = str(args, "new_string");
        if (oldString === "") throw new FsToolError("invalid_arguments", "`old_string` must not be empty");
        const content = readFileSync(abs, "utf8");
        const count = content.split(oldString).length - 1;
        if (count === 0) throw new FsToolError("no_match", `${rel}: old_string was not found in the file; nothing changed`, { path: rel, matches: 0 });
        if (count > 1) throw new FsToolError("ambiguous_match", `${rel}: old_string occurs ${count} times; include more surrounding text to make it unique — nothing changed`, { path: rel, matches: count });
        const at = content.indexOf(oldString);
        writeFileSync(abs, content.slice(0, at) + newString + content.slice(at + oldString.length));
        return { path: rel, replaced: 1 };
      }
      case "grep": {
        const pattern = str(args, "pattern");
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (e) {
          throw new FsToolError("invalid_pattern", `invalid regular expression: ${e instanceof Error ? e.message : String(e)}`, { pattern });
        }
        const glob = args.glob === undefined ? null : globToRegExp(str(args, "glob"));
        const lines: string[] = [];
        let total = 0;
        for (const file of this.listMarkdown(this.root)) {
          if (glob && !glob.test(file)) continue;
          const text = readFileSync(join(this.root, file), "utf8").split("\n");
          text.forEach((line, i) => {
            if (!re.test(line)) return;
            total += 1;
            if (lines.length < GREP_CAP) lines.push(`${file}:${i + 1}: ${line}`);
          });
        }
        const truncated = total > lines.length;
        return { pattern, ...(args.glob !== undefined ? { glob: args.glob } : {}), matches: lines, count: total, truncated, ...(truncated ? { note: `output cut at ${GREP_CAP} of ${total} matching lines; narrow the pattern or pass a glob` } : {}) };
      }
      case "move_file": {
        const from = this.requireFile(str(args, "from"));
        const to = this.resolvePath(str(args, "to"));
        if (existsSync(to.abs)) throw new FsToolError("exists", `${to.rel} already exists`, { path: to.rel });
        mkdirSync(dirname(to.abs), { recursive: true });
        renameSync(from.abs, to.abs);
        return { from: from.rel, to: to.rel };
      }
      case "delete_file": {
        const { abs, rel } = this.requireFile(str(args, "path"));
        rmSync(abs);
        return { path: rel, deleted: true };
      }
      default:
        throw new FsToolError("unknown_tool", `unknown tool ${name}`, { tool: name });
    }
  }

  call(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
    const started = performance.now();
    try {
      const result = this.run(name, args);
      return Promise.resolve({ ok: true, text: JSON.stringify(result), result, ms: performance.now() - started });
    } catch (e) {
      const code = e instanceof FsToolError ? e.code : "tool_error";
      const message = e instanceof Error ? e.message : String(e);
      const result = { error: code, message, ...(e instanceof FsToolError && e.data ? { data: e.data } : {}) };
      return Promise.resolve({ ok: false, text: JSON.stringify(result), result, error_code: code, ms: performance.now() - started });
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
