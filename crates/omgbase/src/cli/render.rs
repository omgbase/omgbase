//! The human renderer (`spec/cli` §3.3, §4): the styling ladder (only the
//! plain tier is pinned; the others are the same text with ANSI applied),
//! the plain glyphs, aligned columns, the wordmark and the rule, relative
//! time.

/// The styling tier. `Plain` is selected by `--no-color`, `NO_COLOR`, a
/// non-TTY stdout or `TERM=dumb`; `Basic` applies 16-color ANSI and the
/// safe-Unicode glyphs (unpinned).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Plain,
    Basic,
}

/// Styling: the identity in the plain tier.
#[derive(Clone, Copy, Debug)]
pub struct Style {
    pub tier: Tier,
}

const RESET: &str = "\x1b[0m";

impl Style {
    pub fn detect(no_color: bool, stdout_tty: bool) -> Self {
        let plain = no_color
            || !stdout_tty
            || std::env::var_os("NO_COLOR").is_some()
            || std::env::var("TERM").is_ok_and(|t| t == "dumb");
        Self {
            tier: if plain { Tier::Plain } else { Tier::Basic },
        }
    }

    pub fn plain(&self) -> bool {
        self.tier == Tier::Plain
    }

    fn sgr(&self, code: &str, s: &str) -> String {
        if self.plain() {
            s.to_owned()
        } else {
            format!("\x1b[{code}m{s}{RESET}")
        }
    }

    pub fn bold(&self, s: &str) -> String {
        self.sgr("1", s)
    }
    pub fn dim(&self, s: &str) -> String {
        self.sgr("2", s)
    }
    pub fn ok(&self, s: &str) -> String {
        self.sgr("32", s)
    }
    pub fn warn(&self, s: &str) -> String {
        self.sgr("33", s)
    }
    pub fn err(&self, s: &str) -> String {
        self.sgr("31", s)
    }
    pub fn accent(&self, s: &str) -> String {
        self.sgr("36", s)
    }
    pub fn path(&self, s: &str) -> String {
        self.sgr("34", s)
    }
    /// Ids recede; locators are for eyes.
    pub fn id(&self, s: &str) -> String {
        self.dim(s)
    }

    /// The glyph set of the tier (§3.3).
    pub fn glyphs(&self) -> Glyphs {
        if self.plain() { PLAIN } else { BASIC }
    }

    /// `  omgbase  >  <subject>`.
    pub fn wordmark(&self, subject: &str) -> String {
        format!(
            "  {}  {}  {}",
            self.accent("omgbase"),
            self.dim(self.glyphs().arrow),
            self.bold(subject)
        )
    }

    /// Two spaces and forty `-`.
    pub fn rule(&self) -> String {
        let bar = if self.plain() {
            "-".repeat(40)
        } else {
            "─".repeat(40)
        };
        format!("  {}", self.dim(&bar))
    }
}

/// The glyphs a tier prints.
#[derive(Clone, Copy, Debug)]
pub struct Glyphs {
    pub live: &'static str,
    pub dead: &'static str,
    pub ok: &'static str,
    pub warn: &'static str,
    pub err: &'static str,
    pub diamond: &'static str,
    pub arrow: &'static str,
    pub task_open: &'static str,
    /// The checked task glyph (the `show` card prints the open one for the type).
    #[allow(dead_code)]
    pub task_done: &'static str,
    pub doc: &'static str,
    pub block: &'static str,
    pub heading: &'static str,
}

const PLAIN: Glyphs = Glyphs {
    live: "*",
    dead: "o",
    ok: "ok",
    warn: "!",
    err: "x",
    diamond: "*",
    arrow: ">",
    task_open: "[ ]",
    task_done: "[x]",
    doc: "[D]",
    block: "[B]",
    heading: "#",
};

const BASIC: Glyphs = Glyphs {
    live: "●",
    dead: "○",
    ok: "✓",
    warn: "!",
    err: "✗",
    diamond: "◆",
    arrow: "›",
    task_open: "☐",
    task_done: "☑",
    doc: "▤",
    block: "▪",
    heading: "§",
};

/// The glyph for a block type (`show`).
pub fn type_glyph(style: &Style, kind: &str) -> String {
    let g = style.glyphs();
    match kind {
        "heading" => style.accent(g.heading),
        "task" => g.task_open.to_owned(),
        k if k.starts_with("doc") => style.path(g.doc),
        _ => style.dim(g.block),
    }
}

/// Strip ANSI SGR sequences.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            for d in chars.by_ref() {
                if d == 'm' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The visible width: the reference's `.length` — UTF-16 code units — after
/// stripping ANSI.
pub fn visible_width(s: &str) -> usize {
    strip_ansi(s).encode_utf16().count()
}

/// Pad to `width` visible columns on the right.
pub fn pad_end(s: &str, width: usize) -> String {
    let w = visible_width(s);
    if w >= width {
        s.to_owned()
    } else {
        format!("{s}{}", " ".repeat(width - w))
    }
}

/// Pad to `width` visible columns on the left.
pub fn pad_start(s: &str, width: usize) -> String {
    let w = visible_width(s);
    if w >= width {
        s.to_owned()
    } else {
        format!("{}{s}", " ".repeat(width - w))
    }
}

/// Column alignment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Left,
    Right,
}

/// §4 columns: cells padded to the widest of their column, joined by two
/// spaces, the last column unpadded, trailing whitespace removed.
pub fn columns(rows: &[Vec<String>], aligns: &[Align]) -> Vec<String> {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            let w = visible_width(cell);
            if widths.len() <= i {
                widths.push(w);
            } else if widths[i] < w {
                widths[i] = w;
            }
        }
    }
    rows.iter()
        .map(|row| {
            let line = row
                .iter()
                .enumerate()
                .map(|(i, cell)| {
                    if i + 1 == row.len() {
                        return cell.clone();
                    }
                    let w = widths.get(i).copied().unwrap_or(0);
                    match aligns.get(i).copied().unwrap_or_default() {
                        Align::Left => pad_end(cell, w),
                        Align::Right => pad_start(cell, w),
                    }
                })
                .collect::<Vec<_>>()
                .join("  ");
            line.trim_end().to_owned()
        })
        .collect()
}

/// §4 relative time: `<n>s ago` under a minute, then minutes, hours, days;
/// `—` for no commit; the raw string when unparsable.
pub fn rel_time(ts: Option<&str>, now_ms: i64) -> String {
    let Some(ts) = ts.filter(|t| !t.is_empty()) else {
        return "—".to_owned();
    };
    let Ok(then) = omgbase_store::time::parse_ms(ts) else {
        return ts.to_owned();
    };
    let secs = ((now_ms - then) / 1000).max(0);
    if secs < 60 {
        return format!("{secs}s ago");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hrs = mins / 60;
    if hrs < 24 {
        return format!("{hrs}h ago");
    }
    format!("{}d ago", hrs / 24)
}

/// `~`-shorten a path under `$HOME`.
pub fn shorten_home(p: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && p.starts_with(&home) => format!("~{}", &p[home.len()..]),
        _ => p.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_pad_and_trim() {
        let rows = vec![
            vec!["a".to_owned(), "1 blocks".to_owned(), "0s ago".to_owned()],
            vec![
                "abc".to_owned(),
                "13 blocks".to_owned(),
                "0s ago".to_owned(),
            ],
        ];
        let out = columns(&rows, &[Align::Left, Align::Right, Align::Right]);
        assert_eq!(out[0], "a     1 blocks  0s ago");
        assert_eq!(out[1], "abc  13 blocks  0s ago");
        let out = columns(&[vec!["x".to_owned(), String::new()]], &[]);
        assert_eq!(out[0], "x");
    }

    #[test]
    fn relative_time() {
        let now = omgbase_store::time::parse_ms("2026-09-27T00:00:00.000Z").unwrap();
        assert_eq!(rel_time(Some("2026-09-27T00:00:00.000Z"), now), "0s ago");
        assert_eq!(rel_time(Some("2026-09-26T23:58:30.000Z"), now), "1m ago");
        assert_eq!(rel_time(Some("2026-09-26T20:00:00.000Z"), now), "4h ago");
        assert_eq!(rel_time(Some("2026-09-20T00:00:00.000Z"), now), "7d ago");
        assert_eq!(rel_time(None, now), "—");
    }

    #[test]
    fn plain_wordmark() {
        let s = Style { tier: Tier::Plain };
        assert_eq!(s.wordmark("fixture"), "  omgbase  >  fixture");
        assert_eq!(s.rule(), format!("  {}", "-".repeat(40)));
        assert_eq!(visible_width("\x1b[2mab\x1b[0m…"), 3);
    }
}
