import { Style, glyphs, type Glyphs, type Tier } from "./style.js";

// Human-facing renderer (11 §4). Columns, the branded header/box, status lines,
// hit lists — all TTY-only pizzazz. Width math strips ANSI so colored cells
// still align. Nothing here touches the machine paths (--json/--jsonl/--ids),
// which emit library objects verbatim from the command layer.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string, ignoring ANSI SGR sequences. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function padEndVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function padStartVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

export interface Column {
  /** "left" (default) or "right" alignment. */
  align?: "left" | "right";
}

/** Align a matrix of already-styled cells into padded columns joined by gap. */
export function columns(rows: string[][], cols: Column[] = [], gap = "  "): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => {
        const w = widths[i] ?? 0;
        // Don't pad the final column (avoids trailing whitespace).
        if (i === row.length - 1) return cell;
        return (cols[i]?.align === "right" ? padStartVisible : padEndVisible)(cell, w);
      })
      .join(gap)
      .replace(/\s+$/, ""),
  );
}

export class Renderer {
  readonly style: Style;
  readonly g: Glyphs;
  readonly tier: Tier;

  constructor(style: Style) {
    this.style = style;
    this.tier = style.tier;
    this.g = glyphs(style.tier);
  }

  /** The branded wordmark line: gradient "omgbase" + accent arrow + subject. */
  wordmark(subject?: string): string {
    const mark = this.style.gradient("omgbase");
    if (!subject) return `  ${mark}`;
    return `  ${mark}  ${this.style.dim(this.g.arrow)}  ${this.style.bold(subject)}`;
  }

  /** A full-width gradient underline for the header (rich only; else a rule). */
  rule(width = 40): string {
    return "  " + this.style.gradientBar(width);
  }

  /** A colored status dot + label, e.g. ● live / ○ none. */
  statusDot(state: "live" | "none" | "ok" | "warn" | "err", label: string): string {
    switch (state) {
      case "live":
        return `${this.style.ok(this.g.live)} ${label}`;
      case "none":
        return `${this.style.dim(this.g.dead)} ${label}`;
      case "ok":
        return `${this.style.ok(this.g.ok)} ${label}`;
      case "warn":
        return `${this.style.warn(this.g.warn)} ${label}`;
      case "err":
        return `${this.style.err(this.g.err)} ${label}`;
    }
  }

  /** Glyph for a node/block type (used in outlines and hit lists). */
  typeGlyph(type: string): string {
    if (type === "heading") return this.style.accent(this.g.heading);
    if (type === "task") return this.g.taskOpen;
    if (type.startsWith("doc")) return this.style.path(this.g.doc);
    return this.style.dim(this.g.block);
  }

  /** id (dim) paired with locator (accent) — the §4.2 pairing. */
  idLocator(id: string, locator: string): string {
    return `${this.style.id(id)}  ${this.style.accent(locator)}`;
  }
}

// ---- IO abstraction ---------------------------------------------------------
//
// stdout is data; stderr is everything else (§4.1). Commands write their result
// to out(); diagnostics, progress, truncation footers, and errors go to err().
// Injectable so command functions are unit-testable without spawning.

export interface IO {
  out(s: string): void;
  err(s: string): void;
  readonly stdoutTTY: boolean;
  readonly stderrTTY: boolean;
}

export const processIO: IO = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
  stdoutTTY: Boolean(process.stdout.isTTY),
  stderrTTY: Boolean(process.stderr.isTTY),
};

/** Collecting IO for tests: captures out/err lines. */
export class CaptureIO implements IO {
  outLines: string[] = [];
  errLines: string[] = [];
  stdoutTTY = false;
  stderrTTY = false;
  out(s: string): void {
    this.outLines.push(s);
  }
  err(s: string): void {
    this.errLines.push(s);
  }
  get stdout(): string {
    return this.outLines.join("\n");
  }
  get stderr(): string {
    return this.errLines.join("\n");
  }
}
