//! Build info for the `version` tool (`spec/surface` §4, 1.4): the git
//! revision the binary was built from, the build time and the compiler.
//!
//! - `OMGBASE_COMMIT` — `git rev-parse --short HEAD` when building from a
//!   checkout; else the `sha1` of `.cargo_vcs_info.json` at the crate root
//!   (what `cargo publish` packages), shortened to 7 characters; else unset
//!   (`option_env!` → `null` on the wire).
//! - `OMGBASE_BUILT` — the build time, RFC 3339 UTC; `SOURCE_DATE_EPOCH`
//!   (seconds) wins when set, for reproducible builds.
//! - `OMGBASE_RUSTC` — `rustc --version` (`$RUSTC` when cargo names one).
//!
//! No dependencies: the date arithmetic is the civil-from-days algorithm.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// The `sha1` of `.cargo_vcs_info.json` (`{"git":{"sha1":"…"},…}`), read
/// without a JSON parser: the value after the `"sha1"` key.
fn vcs_info_sha(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let at = text.find("\"sha1\"")?;
    let rest = &text[at + "\"sha1\"".len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let sha = &rest[..end];
    (sha.len() >= 7 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then(|| sha[..7].to_owned())
}

/// The commit: a checkout's `HEAD` (registering the files whose change
/// means a new revision), else the packaged VCS info, else none.
fn commit(manifest_dir: &Path) -> Option<String> {
    if let Some(short) = git(manifest_dir, &["rev-parse", "--short", "HEAD"]) {
        if let Some(head) = git(manifest_dir, &["rev-parse", "--git-path", "HEAD"]) {
            let head = manifest_dir.join(head);
            println!("cargo:rerun-if-changed={}", head.display());
            // `HEAD` names a ref (`ref: refs/heads/main`): a commit moves that
            // file, not `HEAD` itself.
            if let Ok(text) = std::fs::read_to_string(&head) {
                if let Some(r) = text.trim().strip_prefix("ref:") {
                    if let Some(p) = git(manifest_dir, &["rev-parse", "--git-path", r.trim()]) {
                        println!("cargo:rerun-if-changed={}", manifest_dir.join(p).display());
                    }
                }
            }
        }
        return Some(short);
    }
    let vcs = manifest_dir.join(".cargo_vcs_info.json");
    if vcs.is_file() {
        println!("cargo:rerun-if-changed={}", vcs.display());
        return vcs_info_sha(&vcs);
    }
    None
}

/// Seconds since the epoch → `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's
/// civil-from-days).
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn built() -> String {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs())
        });
    rfc3339(secs)
}

fn rustc_version() -> Option<String> {
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let out = Command::new(rustc).arg("--version").output().ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (out.status.success() && !s.is_empty()).then_some(s)
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    // The default "rerun when the package changes" is lost once any
    // `rerun-if-changed` is printed, so restate it: the build time stays the
    // time of the build that last compiled a change.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=src");
    if let Some(sha) = commit(&manifest_dir) {
        println!("cargo:rustc-env=OMGBASE_COMMIT={sha}");
    }
    println!("cargo:rustc-env=OMGBASE_BUILT={}", built());
    if let Some(v) = rustc_version() {
        println!("cargo:rustc-env=OMGBASE_RUSTC={v}");
    }
}
