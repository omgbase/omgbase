//! The shell line tokenizer (`spec/cli` §7). Splits a line into argv tokens
//! the way a POSIX-ish shell would for the pieces that matter: whitespace
//! separates tokens; single quotes are literal; double quotes group with
//! backslash escapes (`\"`, `\\`, `\$`, `` \` `` only — any other backslash
//! is kept); a backslash outside quotes escapes the next character. No
//! globbing, no variable expansion (`@refs` are resolved separately), no
//! pipes — the shell stores and dereferences, it is not a second language.

/// An unterminated quote (a usage error for that line).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenizeError(pub String);

impl std::fmt::Display for TokenizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn tokenize(line: &str) -> Result<Vec<String>, TokenizeError> {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    // Distinguishes an empty quoted token (`""`) from no token at all.
    let mut has_cur = false;
    let mut i = 0;

    while i < n {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' {
            if has_cur {
                tokens.push(std::mem::take(&mut cur));
                has_cur = false;
            }
            i += 1;
            continue;
        }
        if ch == '\'' {
            has_cur = true;
            i += 1;
            let Some(end) = chars[i..].iter().position(|c| *c == '\'') else {
                return Err(TokenizeError("unterminated single quote".to_owned()));
            };
            cur.extend(&chars[i..i + end]);
            i += end + 1;
            continue;
        }
        if ch == '"' {
            has_cur = true;
            i += 1;
            while i < n && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < n {
                    let next = chars[i + 1];
                    // Inside double quotes only \" \\ \$ \` are escapes; the
                    // rest stays verbatim (backslash included), as a real shell does.
                    if matches!(next, '"' | '\\' | '$' | '`') {
                        cur.push(next);
                        i += 2;
                        continue;
                    }
                }
                cur.push(chars[i]);
                i += 1;
            }
            if i >= n {
                return Err(TokenizeError("unterminated double quote".to_owned()));
            }
            i += 1; // the closing quote
            continue;
        }
        if ch == '\\' {
            if i + 1 < n {
                cur.push(chars[i + 1]);
                has_cur = true;
                i += 2;
                continue;
            }
            // A trailing backslash is literal.
            cur.push(ch);
            has_cur = true;
            i += 1;
            continue;
        }
        cur.push(ch);
        has_cur = true;
        i += 1;
    }
    if has_cur {
        tokens.push(cur);
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(line: &str) -> Vec<String> {
        tokenize(line).unwrap()
    }

    #[test]
    fn splits_and_quotes() {
        assert_eq!(t("  ls   texts/*  "), vec!["ls", "texts/*"]);
        assert_eq!(
            t(r#"q 'from docs where $path == "x"' --ids"#),
            vec!["q", r#"from docs where $path == "x""#, "--ids"]
        );
        assert_eq!(
            t(r#"q "from docs where \$path == \"x\"" --ids"#),
            vec!["q", r#"from docs where $path == "x""#, "--ids"]
        );
        assert_eq!(t(r#"q "a\nb""#), vec!["q", r"a\nb"]);
        assert_eq!(
            t(r#"q from\ docs\ \"text\""#),
            vec!["q", r#"from docs "text""#]
        );
        assert_eq!(t(r#"x "" y"#), vec!["x", "", "y"]);
        assert_eq!(t("a\\"), vec!["a\\"]);
        assert_eq!(t("'it''s' x"), vec!["its", "x"]);
        assert!(t("").is_empty());
    }

    #[test]
    fn unterminated() {
        assert_eq!(
            tokenize("q 'oops").unwrap_err().0,
            "unterminated single quote"
        );
        assert_eq!(
            tokenize("q \"oops").unwrap_err().0,
            "unterminated double quote"
        );
    }
}
