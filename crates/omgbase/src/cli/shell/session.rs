//! The persistent shell runtime (`spec/cli` §7). One open [`Cli`] (its
//! workspace, store and surface) is reused across every line — no
//! per-command startup cost — and typed command results become ephemeral
//! session state:
//!
//! ```text
//!   @1 … @N   rows of the most recent displayed collection frame
//!   @_        the previous command's typed result
//!   @name     a named binding created with `@name = <command | @ref>`
//! ```
//!
//! A binding is a snapshot of a typed value, never a live query: using it
//! later re-runs nothing. The shell stores and dereferences; all data
//! semantics (filter/map/traverse/join) stay in OQX. [`ShellSession::exec`]
//! is the single entry point, which makes the session drivable from the
//! script runner, the prompted runner and the TTY loop alike.

use std::collections::BTreeMap;

use serde_json::Value as Json;

use crate::cli::argv::parse_globals;
use crate::cli::context::Cli;
use crate::cli::output::{CliError, EXIT_OK, EXIT_USAGE, Io, js_json, render_error};
use crate::cli::render::Style;
use crate::cli::run_command;

use super::refs::{Captured, ParsedRef, RefError, Row, coerce, derive_rows, is_name, parse_ref};
use super::tokenize::tokenize;

/// A reference resolved to its typed value plus, when known, a direct
/// argv-usable id/locator (the row's ref).
struct Resolved {
    value: Json,
    r#ref: Option<String>,
}

pub struct ShellSession<'a> {
    cli: &'a mut Cli,
    /// The shell's own styling (its notices, the inspect listing).
    style: Style,
    /// The session's `--no-color`, OR-ed into every line's style.
    no_color: bool,
    /// `--server` / `-H` of the session, threaded into every line that
    /// names none of its own.
    server: Option<String>,
    headers: Vec<String>,
    bindings: BTreeMap<String, Captured>,
    frame: Option<Vec<Row>>,
    last: Option<Json>,
    /// Set by `exit`/`quit`; the drivers watch this.
    pub exited: bool,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

impl<'a> ShellSession<'a> {
    /// A session over `cli`: the shell's own flags (`--server`, `-H`,
    /// `--no-color`) are read once, here; every line then re-parses its own.
    pub fn new(cli: &'a mut Cli) -> Self {
        let style = cli.style;
        let no_color = cli.flags.no_color;
        let server = cli.flags.server.clone();
        let headers = cli.flags.headers.clone();
        cli.capturing = true;
        Self {
            cli,
            style,
            no_color,
            server,
            headers,
            bindings: BTreeMap::new(),
            frame: None,
            last: None,
            exited: false,
        }
    }

    /// Execute one input line. Returns an exit code (0 ok, 1 error, 2 usage).
    pub fn exec(&mut self, line: &str) -> i32 {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return EXIT_OK; // blank / comment
        }
        let tokens = match tokenize(line) {
            Ok(t) => t,
            Err(e) => return self.usage(&e.0),
        };
        if tokens.is_empty() {
            return EXIT_OK;
        }
        match self.exec_tokens(&tokens) {
            Ok(code) => code,
            Err(e) => self.usage(&e.0),
        }
    }

    fn exec_tokens(&mut self, tokens: &[String]) -> Result<i32, RefError> {
        let head = tokens[0].as_str();
        match head {
            "exit" | "quit" => {
                self.exited = true;
                Ok(EXIT_OK)
            }
            "unset" => Ok(self.do_unset(&tokens[1..])),
            "bindings" => Ok(self.do_bindings()),
            "?" => Ok(self.do_shell_help()),
            _ => {
                // `None` unless `@…`; an error on a malformed `@…`.
                let r#ref = parse_ref(head)?;
                // `@name = <command | @ref>` binds a snapshot (the command runs
                // quietly). A bare reference on its own line inspects the value
                // (and, if it's a collection, makes it the addressable frame).
                // Anything else is a normal omg command line with `@refs`
                // substituted into its argv.
                match r#ref {
                    Some(r) if tokens.get(1).is_some_and(|t| t == "=") => {
                        self.do_assign(&r, &tokens[2..])
                    }
                    Some(_) if tokens.len() == 1 => self.inspect(head),
                    _ => self.run_line(tokens),
                }
            }
        }
    }

    // ---- builtins -------------------------------------------------------------

    /// `@name = <command | @ref>` — bind a snapshot of a result under `name`.
    /// A command runs quietly (stdout suppressed); a bare `@ref` copies its
    /// value. The target must be a plain name (no `[i]`/`.field`, not `@_`/`@N`).
    fn do_assign(&mut self, target: &ParsedRef, rhs: &[String]) -> Result<i32, RefError> {
        let name = target.base.as_str();
        if target.index.is_some() || target.field.is_some() {
            return Ok(self
                .usage("cannot assign to @name[i] or @name.field — bind a whole result to @name"));
        }
        if !is_name(name) || name == "_" {
            return Ok(self.usage(&format!(
                "bad binding name '@{name}' (use a letter-led identifier)"
            )));
        }
        if rhs.is_empty() {
            return Ok(self.usage("@name = <command | @ref>"));
        }

        let captured = if rhs.len() == 1 && parse_ref(&rhs[0])?.is_some() {
            // @x = @ref — snapshot the referenced value.
            Captured::of(self.resolve_ref(&rhs[0])?.value)
        } else {
            // @x = <command> — run it quietly (stdout suppressed) and snapshot
            // the typed result. Diagnostics/errors still reach stderr.
            let substituted = self.substitute(rhs)?;
            let (code, value) = self.dispatch(&substituted, true);
            if code != EXIT_OK {
                return Ok(code); // command failed → don't bind
            }
            Captured::of(value.unwrap_or(Json::Null))
        };

        let summary = self.summary(&captured);
        self.last = Some(captured.value.clone());
        self.bindings.insert(name.to_owned(), captured);
        self.cli
            .io
            .err(&self.style.dim(&format!("  @{name} = {summary}")));
        Ok(EXIT_OK)
    }

    fn do_unset(&mut self, rest: &[String]) -> i32 {
        let Some(name) = rest.first() else {
            return self.usage("unset <name>");
        };
        let note = if self.bindings.remove(name).is_some() {
            format!("  unset @{name}")
        } else {
            format!("  no binding @{name}")
        };
        self.cli.io.err(&self.style.dim(&note));
        EXIT_OK
    }

    fn do_bindings(&mut self) -> i32 {
        if self.bindings.is_empty() {
            self.cli.io.err(&self.style.dim("  no bindings"));
            return EXIT_OK;
        }
        let lines: Vec<String> = self
            .bindings
            .iter()
            .map(|(name, cap)| {
                format!(
                    "{}  {}",
                    self.style.accent(&format!("@{name}")),
                    self.style.dim(&self.summary(cap))
                )
            })
            .collect();
        for l in lines {
            self.cli.io.out(&l);
        }
        EXIT_OK
    }

    fn do_shell_help(&mut self) -> i32 {
        let io = self.cli.io;
        let style = self.style;
        let line = |s: String| io.out(&format!("  {s}"));
        io.out(&style.bold("  omg shell — session bindings"));
        line(style.dim("run any omg command; results become addressable:"));
        line(format!(
            "{}   {}",
            style.accent("@1 @2 …"),
            style.dim("rows of the last displayed collection")
        ));
        line(format!(
            "{}         {}",
            style.accent("@_"),
            style.dim("the previous command's result")
        ));
        line(format!(
            "{}      {}",
            style.accent("@name"),
            style.dim("a named binding (also @name[i], @name.field)")
        ));
        io.out("");
        line(format!(
            "{}      {}",
            style.accent("@x = <cmd|@ref>"),
            style.dim("bind a snapshot of a result")
        ));
        line(format!(
            "{}              {}",
            style.accent("unset x"),
            style.dim("drop a binding")
        ));
        line(format!(
            "{}             {}",
            style.accent("bindings"),
            style.dim("list bindings")
        ));
        line(format!(
            "{} / {}          {}",
            style.accent("exit"),
            style.accent("quit"),
            style.dim("leave the shell")
        ));
        EXIT_OK
    }

    // ---- command lines --------------------------------------------------------

    /// A normal omg command line: substitute refs, dispatch, record the result.
    fn run_line(&mut self, tokens: &[String]) -> Result<i32, RefError> {
        let substituted = self.substitute(tokens)?;
        let (code, value) = self.dispatch(&substituted, false);
        if let Some(v) = value {
            self.record(v);
        }
        Ok(code)
    }

    /// Run one command line through the same path as a one-shot invocation
    /// (§2.2 globals, the sweep, dispatch, error rendering) over the shared
    /// `Cli`, and return its exit code with the typed result it captured.
    /// `quiet` drops stdout (the `@name = …` snapshot runs).
    fn dispatch(&mut self, tokens: &[String], quiet: bool) -> (i32, Option<Json>) {
        let parsed = match parse_globals(tokens) {
            Ok(p) => p,
            // A malformed global flag is `usage: <message>`, no hint (the reference
            // throws it past the per-command renderer).
            Err((_, e)) => return (self.usage(e.message()), None),
        };
        let Some(command) = parsed.command else {
            return (EXIT_OK, None);
        };
        let mut flags = parsed.flags;
        // In a remote session, thread the server address into every line (unless
        // the line names its own) so each command runs against the shared engine.
        if let (Some(server), None) = (&self.server, &flags.server) {
            flags.server = Some(server.clone());
            if flags.headers.is_empty() {
                flags.headers = self.headers.clone();
            }
        }
        flags.no_color = flags.no_color || self.no_color;
        let machine = flags.machine();
        let line_style = Style::detect(flags.no_color, self.cli.io.stdout_tty());
        if flags.repo != self.cli.flags.repo {
            if let Err(e) = self.cli.reselect_repo() {
                return (render_error(&e, self.cli.io, &line_style, machine), None);
            }
        }
        self.cli.flags = flags;
        self.cli.style = line_style;
        self.cli.take_captured();
        // A displayed line announces its frame at capture time (before the
        // verb's own notices); a quiet snapshot run does not.
        self.cli.announce_frame = !quiet;
        Io::mute_stdout(quiet);
        let outcome = run_command(self.cli, &command, &parsed.rest);
        Io::mute_stdout(false);
        self.cli.announce_frame = false;
        let captured = self.cli.take_captured();
        match outcome {
            Ok(code) => (code, captured),
            Err(e) => (render_error(&e, self.cli.io, &line_style, machine), None),
        }
    }

    /// Update `@_` and, when the result is a collection, replace the numbered
    /// frame (the `N rows` hint already printed at capture time).
    fn record(&mut self, value: Json) {
        let rows = derive_rows(&value);
        self.last = Some(value);
        if let Some(rows) = rows {
            self.frame = Some(rows);
        }
    }

    /// Inspect a bare `@ref` line: print it and, if a collection, make it the frame.
    fn inspect(&mut self, token: &str) -> Result<i32, RefError> {
        let Resolved { value, r#ref } = self.resolve_ref(token)?;
        if let Some(rows) = derive_rows(&value) {
            for (i, r) in rows.iter().enumerate() {
                let line = format!(
                    "{} {}  {}",
                    self.style.dim(&format!("[{}]", i + 1)),
                    self.style.id(&r.r#ref),
                    self.style.accent(&r.label)
                );
                self.cli.io.out(line.trim_end());
            }
            self.cli.io.err(
                &self
                    .style
                    .dim(&format!("  {}", plural(rows.len(), "row", "rows"))),
            );
            self.frame = Some(rows);
        } else if let Some(s) = value.as_str() {
            self.cli.io.out(s);
        } else if let Some(r) = r#ref {
            self.cli.io.out(&r);
        } else {
            // A scalar or a record: its id/locator if coercible, else JSON.
            match coerce(&value) {
                Ok(s) => self.cli.io.out(&s),
                Err(_) => self.cli.io.out(&js_json(&value)),
            }
        }
        self.last = Some(value);
        Ok(EXIT_OK)
    }

    // ---- reference resolution -------------------------------------------------

    /// Replace whole-token `@refs` with their coerced argv strings.
    fn substitute(&self, tokens: &[String]) -> Result<Vec<String>, RefError> {
        tokens
            .iter()
            .map(|t| {
                if parse_ref(t)?.is_none() {
                    return Ok(t.clone());
                }
                let Resolved { value, r#ref } = self.resolve_ref(t)?;
                // A known row id is used verbatim; otherwise coerce (which refuses
                // a bare collection, forcing the user to pick a row with [i]).
                match r#ref {
                    Some(r) => Ok(r),
                    None => coerce(&value),
                }
            })
            .collect()
    }

    /// Resolve a reference token to its typed value plus, when known, a
    /// direct argv-usable id/locator. Coercion is deferred to the caller so
    /// that inspecting a bare collection reference does not error.
    fn resolve_ref(&self, token: &str) -> Result<Resolved, RefError> {
        let parsed =
            parse_ref(token)?.ok_or_else(|| RefError(format!("not a reference: '{token}'")))?;

        let mut value: Json;
        let mut r#ref: Option<String> = None;
        if parsed.base == "_" {
            value = self
                .last
                .clone()
                .ok_or_else(|| RefError("no previous result (@_)".to_owned()))?;
        } else if parsed.base.chars().all(|c| c.is_ascii_digit()) {
            let frame = self
                .frame
                .as_ref()
                .ok_or_else(|| RefError("no displayed collection to index with @N".to_owned()))?;
            let n: usize = parsed.base.parse().unwrap_or(usize::MAX);
            let row = n.checked_sub(1).and_then(|i| frame.get(i)).ok_or_else(|| {
                RefError(format!(
                    "@{} out of range ({})",
                    parsed.base,
                    plural(frame.len(), "row", "rows")
                ))
            })?;
            value = row.value.clone();
            r#ref = Some(row.r#ref.clone());
        } else {
            let binding = self
                .bindings
                .get(&parsed.base)
                .ok_or_else(|| RefError(format!("no binding @{}", parsed.base)))?;
            value = binding.value.clone();
        }

        if let Some(index) = parsed.index {
            let rows = derive_rows(&value).ok_or_else(|| {
                RefError(format!(
                    "@{} is not a collection to index with [i]",
                    parsed.base
                ))
            })?;
            let row = index
                .checked_sub(1)
                .and_then(|i| rows.get(i))
                .ok_or_else(|| {
                    RefError(format!(
                        "[{index}] out of range ({})",
                        plural(rows.len(), "item", "items")
                    ))
                })?;
            value = row.value.clone();
            r#ref = Some(row.r#ref.clone());
        }

        if let Some(field) = &parsed.field {
            let Some(o) = value.as_object() else {
                return Err(RefError(format!("cannot read .{field} of a non-object")));
            };
            let Some(v) = o.get(field) else {
                return Err(RefError(format!("no field .{field}")));
            };
            value = v.clone();
            r#ref = None; // no longer a row id — coerce from the field value
        }

        Ok(Resolved { value, r#ref })
    }

    // ---- helpers --------------------------------------------------------------

    fn summary(&self, cap: &Captured) -> String {
        if let Some(rows) = &cap.rows {
            return plural(rows.len(), "row", "rows");
        }
        match &cap.value {
            Json::String(s) => {
                if s.chars().count() > 48 {
                    format!("\"{}…\"", s.chars().take(45).collect::<String>())
                } else {
                    format!("\"{s}\"")
                }
            }
            Json::Number(_) | Json::Bool(_) => js_json(&cap.value),
            Json::Object(o) => ["id", "node", "path", "locator"]
                .iter()
                .find_map(|k| o.get(*k).filter(|v| !v.is_null()))
                .map_or_else(
                    || "record".to_owned(),
                    |v| match v {
                        Json::String(s) => s.clone(),
                        other => js_json(other),
                    },
                ),
            _ => "empty".to_owned(),
        }
    }

    /// `usage: <message>` on stderr, exit 2 — the shell's own usage errors
    /// carry no hint.
    fn usage(&self, message: &str) -> i32 {
        render_error(&CliError::usage(message), self.cli.io, &self.style, false).max(EXIT_USAGE)
    }
}
