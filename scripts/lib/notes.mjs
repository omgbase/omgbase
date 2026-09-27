// Change notes: changes/<slug>.md, one per change, committed with the code.
//
//   ---
//   npm:
//     "@omgbase/core": minor
//   crates:
//     omgbase-store: patch
//     omgbase: minor
//   ---
//   One paragraph or a few bullets of Markdown: what changed and why.
//
// The frontmatter is a flat two-section map (a section may also be written
// `crates: {}`), so it is parsed here by hand — no YAML library.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { LEVELS, keyOf } from "./workspace.mjs";

export const SECTIONS = { npm: "npm", crates: "crate" };

const unquote = (s) => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1);
  return t;
};

/**
 * Parse `---\n<flat two-section map>\n---\n<body>`. Returns
 * `{ sections: { npm: {name: level}, crates: {…} }, body }` (only the sections
 * present) or throws with a line-numbered message.
 */
export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0].trim() !== "---") throw new Error("line 1: a change note starts with a `---` frontmatter fence");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("the frontmatter is never closed (no second `---` line)");
  const sections = {};
  let current = null;
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (top) {
      const name = unquote(top[1]);
      const rest = top[2].trim();
      if (!(name in SECTIONS)) throw new Error(`line ${i + 1}: unknown section \`${name}\` (expected \`npm\` or \`crates\`)`);
      if (name in sections) throw new Error(`line ${i + 1}: section \`${name}\` appears twice`);
      if (rest !== "" && rest !== "{}") throw new Error(`line ${i + 1}: \`${name}\` must be a section (\`${name}:\` with indented entries, or \`${name}: {}\`)`);
      sections[name] = {};
      current = rest === "{}" ? null : name;
      continue;
    }
    const entry = /^\s+(.+?):\s*(.*)$/.exec(line);
    if (entry) {
      if (!current) throw new Error(`line ${i + 1}: an indented entry outside a section`);
      const key = unquote(entry[1]);
      const value = unquote(entry[2]);
      if (!key) throw new Error(`line ${i + 1}: empty package name`);
      if (key in sections[current]) throw new Error(`line ${i + 1}: \`${key}\` appears twice under \`${current}\``);
      sections[current][key] = value;
      continue;
    }
    throw new Error(`line ${i + 1}: cannot parse \`${raw.trim()}\``);
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { sections, body };
}

/**
 * Parse + validate one note against the workspace. Returns
 * `{ slug, file, body, bumps: [{ key, level }] }` or throws listing every problem.
 */
export function parseNote(text, file, ws) {
  const slug = basename(file).replace(/\.md$/, "");
  const { sections, body } = parseFrontmatter(text);
  const problems = [];
  const bumps = [];
  if (Object.keys(sections).length === 0) problems.push("no `npm:` or `crates:` section");
  for (const [section, entries] of Object.entries(sections)) {
    const kind = SECTIONS[section];
    for (const [name, level] of Object.entries(entries)) {
      const key = keyOf(kind, name);
      if (!ws.byKey.has(key)) {
        const known = ws.all.filter((p) => p.kind === kind).map((p) => p.name).join(", ");
        problems.push(`unknown ${section === "npm" ? "npm package" : "crate"} \`${name}\` (known: ${known})`);
      }
      if (!LEVELS.includes(level)) problems.push(`\`${name}\`: unknown level \`${level}\` (expected ${LEVELS.join(" | ")})`);
      if (ws.byKey.has(key) && LEVELS.includes(level)) bumps.push({ key, level });
    }
  }
  if (!body) problems.push("empty body — say what changed and why");
  if (problems.length) throw new Error(problems.map((p) => `  - ${p}`).join("\n"));
  return { slug, file, body, bumps };
}

/** Pending notes: every changes/*.md except README.md, sorted by slug. */
export function noteFiles(root) {
  const dir = join(root, "changes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => join(dir, f));
}

/** Load and validate every pending note; `{ notes, errors }` (errors are per-file messages). */
export function loadNotes(ws) {
  const notes = [];
  const errors = [];
  for (const file of noteFiles(ws.root)) {
    try {
      notes.push(parseNote(readFileSync(file, "utf8"), file, ws));
    } catch (e) {
      errors.push(`changes/${basename(file)}: malformed change note\n${e.message}`);
    }
  }
  return { notes, errors };
}
