// Sanitize a user-supplied search string into a safe FTS5 MATCH expression.
//
// FTS5 MATCH has its own query grammar: bareword operators (AND/OR/NOT/NEAR),
// prefix `*`, column filters `:`, grouping `()`, and assorted punctuation. A
// raw string like "guides/onboarding" is parsed as syntax and errors with
// `fts5: syntax error near "/"`. Agents and humans expect a search box, not a
// query DSL, so we compile their input down to a grammar-free form:
//
//   - text inside double quotes stays a phrase (adjacent-token match);
//   - every other run of characters becomes one double-quoted token.
//
// Quoting each token makes FTS5 treat inner punctuation as token separators
// (the unicode61 tokenizer already strips non-alphanumerics), so `/`, `-`, `:`
// and friends can never reach the query parser. Space-separated tokens keep
// FTS5's implicit-AND semantics; a trailing `*` on a bareword is preserved as a
// prefix match. Returns "" when the input carries no searchable token, so
// callers can skip the MATCH entirely rather than emit an empty-query error.

function hasWordChar(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

// Wrap one raw token as a quoted FTS5 string, doubling embedded quotes.
function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export function sanitizeFtsQuery(input: string): string {
  const out: string[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i]!;

    // Skip whitespace between tokens.
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // A user-supplied phrase: capture until the closing quote (or end).
    if (c === '"') {
      i++;
      let phrase = "";
      while (i < n && input[i] !== '"') {
        phrase += input[i];
        i++;
      }
      if (i < n) i++; // consume closing quote
      if (hasWordChar(phrase)) out.push(quoteToken(phrase));
      continue;
    }

    // A bareword: read until whitespace or a quote.
    let word = "";
    while (i < n && !/\s/.test(input[i]!) && input[i] !== '"') {
      word += input[i];
      i++;
    }
    // Preserve a trailing `*` as an FTS5 prefix match on the quoted token.
    const prefix = word.endsWith("*");
    const core = prefix ? word.slice(0, -1) : word;
    if (hasWordChar(core)) out.push(quoteToken(core) + (prefix ? "*" : ""));
  }

  return out.join(" ");
}
