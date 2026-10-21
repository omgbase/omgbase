// The grep-blind guard for the three semantic-only tasks: no content word of the
// question (stopwords removed, loosely stemmed) appears anywhere in the target
// document — frontmatter, title, path or body — so a grep for the question's words
// cannot find it; every decoy carries at least one, so a grep finds the decoys. A
// future corpus edit that lets a question word into the target fails here, not in a
// paid run. Also pins the task file to its plant: the prompt opens with the question,
// the answer is exactly the target, the solution's semantic() phrase is the question.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEMANTIC_PLANTS, TIMELINE_DIR, generateTimeline, plantedPaths } from "../src/corpus.ts";
import { loadTasks } from "../src/tasks.ts";
import type { AnswerCheck } from "../src/types.ts";

/** Function words and the question frame ("which note explains …") — never evidence. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "from", "with", "into", "onto", "over", "under", "out", "up", "down", "off",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "has", "have", "had", "will", "would", "should", "could", "can", "may", "might", "must",
  "it", "its", "this", "that", "these", "those", "there", "here", "he", "she", "they", "we", "i", "you", "his", "her", "their", "our", "my", "your", "one", "ones",
  "not", "no", "so", "as", "if", "than", "then", "too", "very", "also", "only", "just", "all", "any", "some", "such",
  "who", "whom", "whose", "what", "which", "where", "when", "why", "how", "someone", "something", "anyone", "anything",
  "note", "notes", "document", "documents", "explain", "explains", "explained", "describe", "describes", "described", "say", "says", "said", "mention", "mentions", "mentioned", "report", "reports", "reported", "record", "records",
]);

/** A loose stem: lower-case, common inflections stripped (burning → burn, buying → buy, explains → explain, stays → stay, cold → cold). */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  return w.replace(/(ing|ed|es|s|ly)$/, "");
}

/** Two stems name one word when they are equal, or one extends the other and the shorter is four letters or more — the grep rule: `burn` hits burnout and burnt, `detector` hits detectors; `stay` does not hit steady, `cold` does not hit cooldown. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/** The question's content words: letters only, stopwords dropped, stemmed, deduplicated. */
export function contentWords(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/'s$/, "")).filter((w) => !STOPWORDS.has(w)).map(stem))];
}

/** Every word of a document — path included — stemmed. */
export function documentStems(path: string, text: string): string[] {
  const words = `${path.replace(/[/._-]/g, " ")} ${text}`.toLowerCase().match(/[a-z][a-z']*/g) ?? [];
  return words.map((w) => stem(w.replace(/'s$/, "")));
}

/** The content words of `question` that occur in the document (empty = grep-blind). */
export function leakedWords(question: string, path: string, text: string): string[] {
  const stems = documentStems(path, text);
  return contentWords(question).filter((q) => stems.some((s) => sameWord(q, s)));
}

describe("the semantic-only plants are grep-blind", () => {
  const files = generateTimeline();
  const { tasks, problems } = loadTasks();
  if (problems.length > 0) throw new Error(problems.join("\n"));

  it("there are three, one per task, every planted path is a generated and committed file, and no two plants share a path", () => {
    expect(SEMANTIC_PLANTS.map((p) => p.task)).toEqual(["semantic-synonym", "semantic-paraphrase", "semantic-cross-domain"]);
    const paths = plantedPaths();
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(13); // 3 targets + 3 + 3 + 4 decoys
    for (const p of paths) {
      expect(files.get(p)).toBeDefined();
      expect(readFileSync(join(TIMELINE_DIR, p.slice(1)), "utf8")).toBe(files.get(p));
    }
  });

  for (const plant of SEMANTIC_PLANTS) {
    describe(plant.task, () => {
      const words = contentWords(plant.question);

      it("the question has content words to be blind to", () => {
        expect(words.length).toBeGreaterThanOrEqual(1); // "someone burning out" is one content word, burn — the concept IS the one word
      });

      it("no content word of the question appears in the target (frontmatter, title, path, body)", () => {
        expect(leakedWords(plant.question, plant.target.path, plant.target.text)).toEqual([]);
      });

      it("every decoy carries at least one content word of the question", () => {
        expect(plant.decoys.length).toBeGreaterThanOrEqual(3);
        for (const d of plant.decoys) expect(leakedWords(plant.question, d.path, d.text), d.path).not.toEqual([]);
      });

      it("the planted passages clear the embedding floor (24 whitespace tokens) so semantic() ranks them at all; none carries a window, an after: or an open task", () => {
        for (const n of [plant.target, ...plant.decoys]) {
          const body = n.text.replace(/^---[\s\S]*?---\n/, "");
          const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));
          expect(Math.max(...paragraphs.map((p) => p.split(/\s+/).length)), n.path).toBeGreaterThanOrEqual(24);
          expect(n.text).not.toMatch(/^window:|^after:/m);
          expect(n.text).not.toContain("- [ ]");
          expect(n.text).not.toContain("- [x]");
        }
      });

      it("the task file is pinned to the plant: requires semantic, timeline corpus, the prompt opens with the question, the answer is exactly the target, the solution embeds the question verbatim and reads the top hit", () => {
        const task = tasks.find((t) => t.id === plant.task)!;
        expect(task).toBeDefined();
        expect(task.requires).toEqual(["semantic"]);
        expect(task.corpus).toBe("timeline");
        expect(task.unchanged_all).toBe(true);
        expect(task.prompt.startsWith(plant.question)).toBe(true);
        const answer = task.checks.find((c) => c.kind === "answer") as AnswerCheck;
        expect(answer.paths).toEqual([plant.target.path]);
        expect(answer.ordered).toBeUndefined();
        const [query, read] = task.solution.steps;
        expect(query!.tool).toBe("query");
        expect(String((query!.args as { query: string }).query)).toContain(`order by semantic(${JSON.stringify(plant.question)}) desc`);
        expect(read!.tool).toBe("docs_read");
        expect(read!.args).toEqual({ _path: { $result: 0, $get: "hits.0._path" } });
        // the fs oracle is the honest grep path: it greps, it reads decoys, and it reads the target last
        const steps = task.solution_fs.steps;
        expect(steps.length).toBeGreaterThanOrEqual(12);
        expect(steps.filter((s) => s.tool === "grep").length).toBeGreaterThanOrEqual(4);
        const reads = steps.filter((s) => s.tool === "read_file").map((s) => (s.args as { path: string }).path);
        for (const d of plant.decoys) expect(reads, `${plant.task} fs oracle reads decoy ${d.path}`).toContain(d.path);
        expect(reads[reads.length - 1]).toBe(plant.target.path);
        // every grep pattern is one of the question's words, a synonym, or a title/directory sweep — never a word of the target's own prose that the question does not share
        for (const s of steps.filter((s) => s.tool === "grep")) expect(typeof (s.args as { pattern: unknown }).pattern).toBe("string");
      });
    });
  }

  it("the helpers: stopwords, stems, same-word", () => {
    expect(contentWords("Which note explains why the camera would not stay cold overnight?")).toEqual(["camera", "stay", "cold", "overnight"]);
    expect(contentWords("Where did someone argue that buying the backup detector was a mistake?")).toEqual(["argue", "buy", "backup", "detector", "mistake"]);
    expect(contentWords("Which note describes someone burning out?")).toEqual(["burn"]);
    expect(sameWord("detector", "detectors")).toBe(true);
    expect(sameWord("burn", "burnt")).toBe(true);
    expect(sameWord("burn", "burnout")).toBe(true);
    expect(sameWord("stay", "steady")).toBe(false);
    expect(sameWord("cold", "cooldown")).toBe(false);
    expect(leakedWords("Which note explains why the camera would not stay cold overnight?", "/x.md", "The cold storage stays shut overnight.")).toEqual(["stay", "cold", "overnight"]);
  });
});
