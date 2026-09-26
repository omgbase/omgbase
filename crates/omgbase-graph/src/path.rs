//! Path resolution (§3.2): a `./` or `../` target against the source
//! document's directory, and the canonical (no leading `/`) repo path.

/// The directory of a repo path: everything up to and including the last
/// `/` (`"a/b/"` for `a/b/c.md`, `""` at the root). The reference's
/// `path.replace(/[^/]*$/, "")`.
#[must_use]
pub fn doc_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "",
    }
}

/// §3.2 (`resolveRelativePath`): a target starting with `./` or `../` is
/// joined to `doc_dir` and normalized segment-wise — `.` and empty segments
/// dropped, `..` pops (past the root it is simply dropped); any other target
/// is returned as is.
#[must_use]
pub fn resolve_relative(target: &str, doc_dir: &str) -> String {
    if !target.starts_with("./") && !target.starts_with("../") {
        return target.to_owned();
    }
    let joined = format!("{doc_dir}{target}");
    let mut resolved: Vec<&str> = Vec::new();
    for p in joined.split('/') {
        match p {
            "." | "" => {}
            ".." => {
                resolved.pop();
            }
            seg => resolved.push(seg),
        }
    }
    resolved.join("/")
}

/// One leading `/` stripped (`resolveDocPath`'s `path.replace(/^\//, "")`).
#[must_use]
pub fn canonical_path(path: &str) -> &str {
    path.strip_prefix('/').unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_of_a_path() {
        assert_eq!(doc_dir("a/b/c.md"), "a/b/");
        assert_eq!(doc_dir("c.md"), "");
        assert_eq!(doc_dir("a/"), "a/");
        assert_eq!(doc_dir(""), "");
    }

    #[test]
    fn relative_targets_join_the_directory() {
        assert_eq!(resolve_relative("./x.md", "a/b/"), "a/b/x.md");
        assert_eq!(resolve_relative("../x.md", "a/b/"), "a/x.md");
        assert_eq!(resolve_relative("../../x.md", "a/b/"), "x.md");
        assert_eq!(resolve_relative("../../../x.md", "a/b/"), "x.md");
        assert_eq!(resolve_relative("./x.md", ""), "x.md");
        assert_eq!(resolve_relative("./x/../../old.md", "a/"), "old.md");
        assert_eq!(resolve_relative("./a//b/./c.md", ""), "a/b/c.md");
        // Anything else is taken as is (root-relative).
        assert_eq!(resolve_relative("x.md", "a/b/"), "x.md");
        assert_eq!(resolve_relative("/x.md", "a/b/"), "/x.md");
        assert_eq!(resolve_relative("note", "a/"), "note");
        assert_eq!(resolve_relative(".hidden/x.md", "a/"), ".hidden/x.md");
        assert_eq!(resolve_relative("", "a/"), "");
    }

    #[test]
    fn canonical_strips_one_slash() {
        assert_eq!(canonical_path("/a.md"), "a.md");
        assert_eq!(canonical_path("//a.md"), "/a.md");
        assert_eq!(canonical_path("a.md"), "a.md");
    }
}
