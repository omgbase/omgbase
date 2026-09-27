//! argv (`spec/cli` §2.2): the global flags, recognized anywhere in argv and
//! consumed before the command sees its arguments, with `--` passthrough;
//! and the per-command option parser with `node:util` `parseArgs` semantics
//! (`--name value`, `--name=value`, short `-n value` / `-nvalue`, grouped
//! short booleans, positionals anywhere, `--` ending the options). Plus the
//! stdin helpers the `-` conventions share.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use super::output::CliError;

/// The output mode (§3.2); the last of `--json`/`--jsonl`/`--ids` wins.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Human,
    Json,
    Jsonl,
    Ids,
}

/// The global flags (§2.2).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Globals {
    /// `-C <dir>` / `--directory <dir>`, unresolved.
    pub directory: Option<String>,
    /// `--repo <slug>`.
    pub repo: Option<String>,
    /// `--server <cmd|url>`.
    pub server: Option<String>,
    /// `-H` / `--header`, in flag order.
    pub headers: Vec<String>,
    pub mode: Mode,
    pub stale: bool,
    pub no_color: bool,
    pub dry_run: bool,
    pub help: bool,
    pub version: bool,
}

impl Globals {
    /// Not the human mode.
    pub fn machine(&self) -> bool {
        self.mode != Mode::Human
    }
}

/// argv split into the globals, the command and its residual argv.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub flags: Globals,
    pub command: Option<String>,
    pub rest: Vec<String>,
}

/// §2.2: the first token not starting with `-` is the command; the global
/// flags are consumed wherever they appear; everything after `--` passes
/// through (the `--` itself too, once a command is known). A flag whose
/// value is missing, or a stray flag before the command, is a usage error
/// (§9 Fixed: with the `usage:` prefix). On error the flags parsed so far
/// come back too, so the error renders in the mode already chosen.
pub fn parse_globals(argv: &[String]) -> Result<Parsed, (Globals, CliError)> {
    let mut flags = Globals::default();
    let mut command: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut passthrough = false;
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        i += 1;
        if passthrough {
            rest.push(a.to_owned());
            continue;
        }
        if a == "--" {
            passthrough = true;
            if command.is_some() {
                rest.push(a.to_owned());
            }
            continue;
        }
        let mut take = |what: &str| -> Result<String, (Globals, CliError)> {
            match argv.get(i) {
                Some(v) => {
                    i += 1;
                    Ok(v.clone())
                }
                None => Err((flags.clone(), CliError::usage(what.to_owned()))),
            }
        };
        match a {
            "-C" | "--directory" => {
                flags.directory = Some(take(&format!("{a} requires a directory"))?);
            }
            "--repo" => flags.repo = Some(take("--repo requires a slug")?),
            "--server" => {
                let s = take("--server requires a command or url")?;
                // §9 Fixed: an empty `--server ""` is a usage error, not a local run.
                if s.is_empty() {
                    return Err((
                        flags,
                        CliError::usage("--server requires a command or url".to_owned()),
                    ));
                }
                flags.server = Some(s);
            }
            "-H" | "--header" => {
                let h = take(&format!("{a} requires a \"Name: value\" header"))?;
                flags.headers.push(h);
            }
            "--json" => flags.mode = Mode::Json,
            "--jsonl" => flags.mode = Mode::Jsonl,
            "--ids" => flags.mode = Mode::Ids,
            "--stale" => flags.stale = true,
            "--no-color" => flags.no_color = true,
            "--dry-run" => flags.dry_run = true,
            "--help" | "-h" => flags.help = true,
            "--version" | "-V" => flags.version = true,
            _ => {
                if command.is_none() && !a.starts_with('-') {
                    command = Some(a.to_owned());
                } else if command.is_none() {
                    // A stray flag before any command is a usage error; once
                    // the command is known, anything unrecognized is its residual.
                    return Err((flags, CliError::usage(format!("unknown flag {a}"))));
                } else {
                    rest.push(a.to_owned());
                }
            }
        }
    }
    Ok(Parsed {
        flags,
        command,
        rest,
    })
}

// ---- per-command options (parseArgs semantics) ---------------------------------------

/// One declared option.
#[derive(Clone, Copy, Debug)]
pub struct Opt {
    pub long: &'static str,
    pub short: Option<char>,
    /// Takes a value (`type: "string"`); else a boolean.
    pub value: bool,
}

impl Opt {
    pub const fn flag(long: &'static str) -> Self {
        Self {
            long,
            short: None,
            value: false,
        }
    }
    pub const fn flag_short(long: &'static str, short: char) -> Self {
        Self {
            long,
            short: Some(short),
            value: false,
        }
    }
    pub const fn value(long: &'static str) -> Self {
        Self {
            long,
            short: None,
            value: true,
        }
    }
    pub const fn value_short(long: &'static str, short: char) -> Self {
        Self {
            long,
            short: Some(short),
            value: true,
        }
    }
}

/// The parse: values by long name (the last given wins), booleans set,
/// positionals in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub values: BTreeMap<String, String>,
    pub flags: BTreeSet<String>,
    pub positionals: Vec<String>,
}

impl Args {
    pub fn value(&self, long: &str) -> Option<&str> {
        self.values.get(long).map(String::as_str)
    }
    pub fn flag(&self, long: &str) -> bool {
        self.flags.contains(long)
    }
    /// The positional at `i`.
    pub fn pos(&self, i: usize) -> Option<&str> {
        self.positionals.get(i).map(String::as_str)
    }
}

fn unknown_option(token: &str) -> CliError {
    // §9 Fixed: an unknown per-command option is a usage error (exit 2), no
    // longer Node's `ERR_PARSE_ARGS_UNKNOWN_OPTION` engine error.
    CliError::usage(format!("unknown option '{token}'"))
}

fn missing_value(token: &str) -> CliError {
    CliError::usage(format!("option '{token}' requires a value"))
}

/// Parse `args` against the declared options (`allowPositionals: true`).
/// `--` ends option parsing; everything after it is positional. A value
/// option consumes the next token unconditionally (Node's rule: an
/// option-argument may start with a dash), so `-f -` reads stdin.
pub fn parse_args(args: &[String], opts: &[Opt]) -> Result<Args, CliError> {
    let mut out = Args::default();
    let find_long = |name: &str| opts.iter().find(|o| o.long == name);
    let find_short = |c: char| opts.iter().find(|o| o.short == Some(c));
    let mut i = 0;
    let mut only_positionals = false;
    while i < args.len() {
        let a = args[i].as_str();
        i += 1;
        if only_positionals || a == "-" || !a.starts_with('-') {
            out.positionals.push(a.to_owned());
            continue;
        }
        if a == "--" {
            only_positionals = true;
            continue;
        }
        if let Some(body) = a.strip_prefix("--") {
            let (name, inline) = match body.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (body, None),
            };
            let Some(opt) = find_long(name) else {
                return Err(unknown_option(&format!("--{name}")));
            };
            if opt.value {
                let v = match inline {
                    Some(v) => v.to_owned(),
                    None => match args.get(i) {
                        Some(v) => {
                            i += 1;
                            v.clone()
                        }
                        None => return Err(missing_value(a)),
                    },
                };
                out.values.insert(opt.long.to_owned(), v);
            } else {
                if inline.is_some() {
                    return Err(CliError::usage(format!(
                        "option '--{name}' does not take a value"
                    )));
                }
                out.flags.insert(opt.long.to_owned());
            }
            continue;
        }
        // Short option(s): `-n 5`, `-n5`, `-1v`.
        let mut chars = a[1..].chars();
        let c = chars.next().unwrap_or_default();
        let tail: String = chars.collect();
        let Some(opt) = find_short(c) else {
            return Err(unknown_option(&format!("-{c}")));
        };
        if opt.value {
            let v = if tail.is_empty() {
                match args.get(i) {
                    Some(v) => {
                        i += 1;
                        v.clone()
                    }
                    None => return Err(missing_value(&format!("-{c}"))),
                }
            } else {
                tail
            };
            out.values.insert(opt.long.to_owned(), v);
        } else {
            out.flags.insert(opt.long.to_owned());
            for c in tail.chars() {
                let Some(opt) = find_short(c) else {
                    return Err(unknown_option(&format!("-{c}")));
                };
                if opt.value {
                    return Err(missing_value(&format!("-{c}")));
                }
                out.flags.insert(opt.long.to_owned());
            }
        }
    }
    Ok(out)
}

/// A numeric option: `Number(v)` in the reference; a non-number is a usage
/// error here (§9 Fixed for `split --at`; the read verbs follow the rule).
pub fn number(args: &Args, long: &str) -> Result<Option<i64>, CliError> {
    match args.value(long) {
        None => Ok(None),
        Some(v) => v
            .trim()
            .parse::<i64>()
            .map(Some)
            .map_err(|_| CliError::usage(format!("--{long} expects a number, got '{v}'"))),
    }
}

// ---- stdin ------------------------------------------------------------------------------

/// Read fd 0 to EOF (an unreadable stdin is empty).
pub fn read_stdin() -> String {
    let mut buf = Vec::new();
    let _ = std::io::stdin().lock().read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// The ids on stdin, one per line, trimmed, blanks dropped.
pub fn read_ids_from_stdin() -> Vec<String> {
    read_stdin()
        .split('\n')
        .map(|l| l.trim_end_matches('\r').trim())
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A ref list where a bare `-` stands for the refs on stdin.
pub fn expand_dash(positionals: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for a in positionals {
        if a == "-" {
            out.extend(read_ids_from_stdin());
        } else {
            out.push(a.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn globals_anywhere_and_passthrough() {
        let p = parse_globals(&v(&["ls", "texts/*", "--ids"])).unwrap();
        assert_eq!(p.command.as_deref(), Some("ls"));
        assert_eq!(p.flags.mode, Mode::Ids);
        assert_eq!(p.rest, v(&["texts/*"]));
        let p = parse_globals(&v(&["--ids", "ls", "texts/*"])).unwrap();
        assert_eq!(p.rest, v(&["texts/*"]));
        let p = parse_globals(&v(&["ls", "--", "--ids"])).unwrap();
        assert_eq!(p.rest, v(&["--", "--ids"]));
        assert_eq!(p.flags.mode, Mode::Human);
        let p = parse_globals(&v(&["-C", "vault", "-h", "cat"])).unwrap();
        assert_eq!(p.flags.directory.as_deref(), Some("vault"));
        assert!(p.flags.help);
        assert_eq!(p.command.as_deref(), Some("cat"));
    }

    #[test]
    fn globals_errors() {
        let (_, e) = parse_globals(&v(&["-n", "5", "ls"])).unwrap_err();
        assert_eq!(e.message(), "unknown flag -n");
        let (_, e) = parse_globals(&v(&["-C"])).unwrap_err();
        assert_eq!(e.message(), "-C requires a directory");
        let (_, e) = parse_globals(&v(&["ls", "--repo"])).unwrap_err();
        assert_eq!(e.message(), "--repo requires a slug");
        let (_, e) = parse_globals(&v(&["-H"])).unwrap_err();
        assert_eq!(e.message(), "-H requires a \"Name: value\" header");
        let (f, e) = parse_globals(&v(&["--json", "ls", "--server", ""])).unwrap_err();
        assert_eq!(e.message(), "--server requires a command or url");
        assert_eq!(f.mode, Mode::Json);
    }

    #[test]
    fn command_options() {
        let opts = [
            Opt::value_short("n", 'n'),
            Opt::flag_short("one", '1'),
            Opt::flag_short("verbose", 'v'),
            Opt::flag("no-semantic"),
            Opt::value("cursor"),
        ];
        let a = parse_args(&v(&["emerald", "tablet", "-n", "3", "-1v"]), &opts).unwrap();
        assert_eq!(a.positionals, v(&["emerald", "tablet"]));
        assert_eq!(a.value("n"), Some("3"));
        assert!(a.flag("one") && a.flag("verbose"));
        let a = parse_args(&v(&["-n5", "--cursor=abc", "--", "-x"]), &opts).unwrap();
        assert_eq!(a.value("n"), Some("5"));
        assert_eq!(a.value("cursor"), Some("abc"));
        assert_eq!(a.positionals, v(&["-x"]));
        let a = parse_args(&v(&["--cursor", "-"]), &opts).unwrap();
        assert_eq!(a.value("cursor"), Some("-"));
        let e = parse_args(&v(&["--scope", "x"]), &opts).unwrap_err();
        assert_eq!(e.message(), "unknown option '--scope'");
        let e = parse_args(&v(&["-n"]), &opts).unwrap_err();
        assert_eq!(e.message(), "option '-n' requires a value");
        let a = parse_args(&v(&["-"]), &opts).unwrap();
        assert_eq!(a.positionals, v(&["-"]));
    }
}
