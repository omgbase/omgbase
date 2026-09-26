//! URI normalization (§4) over a WHATWG URL parser (the `url` crate, as the
//! reference uses Node's `URL`).

use url::Url;

/// §4: parse as a WHATWG URL (on failure return `s` unchanged), drop the
/// fragment, lower-case scheme and host (the parser does; the host is
/// IDNA-encoded), drop an explicit default port (the parser does), serialize
/// and strip **one** trailing `/`.
#[must_use]
pub fn normalize_uri(s: &str) -> String {
    let Ok(mut u) = Url::parse(s) else {
        return s.to_owned();
    };
    u.set_fragment(None);
    let out = u.to_string();
    match out.strip_suffix('/') {
        Some(stripped) => stripped.to_owned(),
        None => out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_section_4_table() {
        assert_eq!(normalize_uri("https://a.com"), "https://a.com");
        assert_eq!(normalize_uri("https://a.com/"), "https://a.com");
        assert_eq!(normalize_uri("https://a.com/./x/../y"), "https://a.com/y");
        assert_eq!(normalize_uri("https://a.com/a b"), "https://a.com/a%20b");
        assert_eq!(normalize_uri("https://a.com/a%2Fb"), "https://a.com/a%2Fb");
        assert_eq!(normalize_uri("https://a.com/?"), "https://a.com/?");
        assert_eq!(
            normalize_uri("https://a.com//double//x"),
            "https://a.com//double//x"
        );
        assert_eq!(
            normalize_uri("mailto:someone@a.com"),
            "mailto:someone@a.com"
        );
        assert_eq!(normalize_uri("HTTPS://A.COM/X#frag"), "https://a.com/X");
        assert_eq!(normalize_uri("https://a.com:443/x"), "https://a.com/x");
        assert_eq!(normalize_uri("http://a.com:80/x"), "http://a.com/x");
        assert_eq!(normalize_uri("http://a.com:8080/x"), "http://a.com:8080/x");
        assert_eq!(normalize_uri("https://a.com/#"), "https://a.com");
        assert_eq!(normalize_uri("https://a.com/x/#top"), "https://a.com/x");
        assert_eq!(
            normalize_uri("https://ünïcode.example/x"),
            "https://xn--ncode-cta3g.example/x"
        );
        assert_eq!(
            normalize_uri("https://a.com/x?q=1#f"),
            "https://a.com/x?q=1"
        );
        assert_eq!(
            normalize_uri("https://a.com/x?q=a b"),
            "https://a.com/x?q=a%20b"
        );
        // Unparsable strings pass through.
        assert_eq!(normalize_uri("not a url"), "not a url");
        assert_eq!(normalize_uri("./x.md"), "./x.md");
        assert_eq!(normalize_uri("https://"), "https://");
        assert_eq!(normalize_uri(""), "");
    }
}
