// Visual capability ladder + ANSI primitives (11 §4, §8). Hand-rolled ANSI, no
// deps. Three tiers, detected from the environment:
//
//   rich  — 24-bit truecolor + Nerd Font icons (gradients, per-type glyphs)
//   basic — 16/256-color + safe unicode (● ✓ ⟳ ◆, box drawing)
//   plain — no color, no non-ASCII (NO_COLOR, non-TTY, --json, dumb terminals)
//
// stdout is data; all styling is for the human-facing (TTY) path only (§4). A
// piped or --json invocation degrades to plain automatically.

export type Tier = "rich" | "basic" | "plain";

export interface StyleOptions {
  /** Force color off (--no-color, NO_COLOR, or non-TTY stdout). */
  noColor?: boolean;
  /** The stream we're styling for (defaults to process.stdout). */
  isTTY?: boolean;
}

function detectTier(opts: StyleOptions): Tier {
  if (opts.noColor) return "plain";
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return "plain";
  if (process.env.NO_COLOR != null) return "plain";
  if (process.env.TERM === "dumb") return "plain";

  const truecolor = process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
  // Nerd Font heuristic: users set this convention, or common terminal programs
  // that ship glyph fonts. Imperfect by design (11 §glyph policy) — degrade
  // gracefully when unsure.
  const term = `${process.env.TERM_PROGRAM ?? ""} ${process.env.LC_TERMINAL ?? ""}`.toLowerCase();
  const nerd =
    process.env.OMG_NERD_FONT === "1" ||
    process.env.NERD_FONT === "1" ||
    /wezterm|kitty|ghostty|iterm/.test(term);

  return truecolor && nerd ? "rich" : "basic";
}

const RESET = "\x1b[0m";

export class Style {
  readonly tier: Tier;
  private readonly color: boolean;

  constructor(opts: StyleOptions = {}) {
    this.tier = detectTier(opts);
    this.color = this.tier !== "plain";
  }

  get isRich(): boolean {
    return this.tier === "rich";
  }

  // ---- raw SGR helpers ------------------------------------------------------

  private sgr(code: string, s: string): string {
    return this.color ? `\x1b[${code}m${s}${RESET}` : s;
  }

  /** 24-bit foreground when rich; falls back to a near 256-color code otherwise. */
  private fg(r: number, g: number, b: number, s: string): string {
    if (!this.color) return s;
    if (this.tier === "rich") return `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
    // basic tier: map to the nearest xterm-256 cube color.
    const idx = 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
    return `\x1b[38;5;${idx}m${s}${RESET}`;
  }

  bold(s: string): string {
    return this.sgr("1", s);
  }
  dim(s: string): string {
    return this.sgr("2", s);
  }
  italic(s: string): string {
    return this.sgr("3", s);
  }

  // ---- semantic colors ------------------------------------------------------

  ok(s: string): string {
    return this.fg(64, 200, 128, s); // green
  }
  warn(s: string): string {
    return this.fg(230, 180, 60, s); // amber
  }
  err(s: string): string {
    return this.fg(228, 90, 90, s); // red
  }
  accent(s: string): string {
    return this.fg(90, 190, 235, s); // cyan
  }
  path(s: string): string {
    return this.fg(120, 180, 245, s); // soft blue
  }
  id(s: string): string {
    return this.dim(s); // IDs recede; locators are for eyes (§4.2)
  }

  /**
   * Horizontal gradient across a string, cyan→magenta. Rich tier only; basic
   * falls back to a flat accent, plain to the bare text. Used for the wordmark.
   */
  gradient(
    s: string,
    from: [number, number, number] = [90, 190, 235],
    to: [number, number, number] = [200, 110, 235],
  ): string {
    if (this.tier !== "rich") return this.color ? this.accent(s) : s;
    const chars = [...s];
    const n = Math.max(chars.length - 1, 1);
    return (
      chars
        .map((ch, i) => {
          const t = i / n;
          const r = Math.round(from[0] + (to[0] - from[0]) * t);
          const g = Math.round(from[1] + (to[1] - from[1]) * t);
          const b = Math.round(from[2] + (to[2] - from[2]) * t);
          return `\x1b[38;2;${r};${g};${b}m${ch}`;
        })
        .join("") + RESET
    );
  }

  /** A solid gradient bar of `width` cells (rich only; degrades to a dim rule). */
  gradientBar(width: number): string {
    if (this.tier !== "rich") return this.color ? this.dim("─".repeat(width)) : "-".repeat(width);
    const from: [number, number, number] = [90, 190, 235];
    const to: [number, number, number] = [200, 110, 235];
    let out = "";
    const n = Math.max(width - 1, 1);
    for (let i = 0; i < width; i++) {
      const t = i / n;
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      out += `\x1b[38;2;${r};${g};${b}m━`;
    }
    return out + RESET;
  }
}

// ---- glyph sets (indexed by tier) -------------------------------------------

export interface Glyphs {
  live: string;
  dead: string;
  ok: string;
  warn: string;
  err: string;
  sync: string;
  bullet: string;
  diamond: string;
  arrow: string;
  taskOpen: string;
  taskDone: string;
  doc: string;
  block: string;
  heading: string;
  queued: string;
  // box drawing
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  teeL: string;
  teeR: string;
}

// Nerd Font glyphs by codepoint (Private Use Area). Written as \u{} escapes so
// the source is unambiguous under any editor font; they render as icons only
// when a Nerd Font is active (the "rich" tier gate).
const RICH: Glyphs = {
  live: "\u{f111}", // nf-fa-circle
  dead: "\u{f10c}", // nf-fa-circle_o
  ok: "\u{f00c}", // nf-fa-check
  warn: "\u{f071}", // nf-fa-warning
  err: "\u{f00d}", // nf-fa-times
  sync: "\u{f021}", // nf-fa-refresh
  bullet: "\u{f444}", // nf-oct-dot_fill
  diamond: "\u{f219}", // nf-fa-diamond
  arrow: "\u{f101}", // nf-fa-angle_double_right
  taskOpen: "\u{f096}", // nf-fa-square_o
  taskDone: "\u{f046}", // nf-fa-check_square_o
  doc: "\u{f15c}", // nf-fa-file_text
  block: "\u{f0c8}", // nf-fa-square
  heading: "\u{f1dc}", // nf-fa-header
  queued: "\u{f017}", // nf-fa-clock_o
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", teeL: "├", teeR: "┤",
};

const BASIC: Glyphs = {
  live: "●", dead: "○", ok: "✓", warn: "!", err: "✗",
  sync: "⟳", bullet: "•", diamond: "◆", arrow: "›",
  taskOpen: "☐", taskDone: "☑", doc: "▤", block: "▪",
  heading: "§", queued: "~",
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", teeL: "├", teeR: "┤",
};

const PLAIN: Glyphs = {
  live: "*", dead: "o", ok: "ok", warn: "!", err: "x",
  sync: "~", bullet: "-", diamond: "*", arrow: ">",
  taskOpen: "[ ]", taskDone: "[x]", doc: "[D]", block: "[B]", heading: "#", queued: "~",
  tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", teeL: "+", teeR: "+",
};

export function glyphs(tier: Tier): Glyphs {
  return tier === "rich" ? RICH : tier === "basic" ? BASIC : PLAIN;
}
