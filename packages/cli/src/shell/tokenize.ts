// Shell line tokenizer (11 shell). Splits a line into argv tokens the way a
// POSIX-ish shell would for the pieces we care about: whitespace separates
// tokens; single quotes are literal; double quotes group with backslash escapes;
// a backslash escapes the next char outside quotes. This is deliberately small —
// no globbing, no variable expansion (session `@refs` are resolved separately),
// no pipes — the shell stores and dereferences, it is not a second language.

export class TokenizeError extends Error {}

export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasCur = false; // distinguishes an empty quoted token ("") from no token
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      if (hasCur) {
        tokens.push(cur);
        cur = "";
        hasCur = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      hasCur = true;
      i++;
      const end = line.indexOf("'", i);
      if (end === -1) throw new TokenizeError("unterminated single quote");
      cur += line.slice(i, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      hasCur = true;
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < n) {
          const next = line[i + 1]!;
          // Inside double quotes only \" \\ \$ \` are special escapes; keep the
          // rest verbatim (backslash included) as a real shell does.
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            cur += next;
            i += 2;
            continue;
          }
        }
        cur += line[i];
        i++;
      }
      if (i >= n) throw new TokenizeError("unterminated double quote");
      i++; // closing quote
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < n) {
        cur += line[i + 1];
        hasCur = true;
        i += 2;
        continue;
      }
      // trailing backslash: treat literally
      cur += ch;
      hasCur = true;
      i++;
      continue;
    }
    cur += ch;
    hasCur = true;
    i++;
  }
  if (hasCur) tokens.push(cur);
  return tokens;
}
