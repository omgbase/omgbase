# OQX grammar

The surface syntax of OQX, as built in the reference implementation
(`packages/oqx/src/lexer.ts`, `parser.ts`). Where this prose and a fixture under
`cases/` disagree, the fixture wins. Fixture files that pin each area are named
in brackets.

## 1. Lexical structure

Whitespace is space, tab, newline, and carriage return; it separates tokens and
is otherwise insignificant [`clause-order`]. There are **no comments**: `#`,
`//`, and `/* */` are lex errors [`errors-lex`].

Tokens:

| Token | Form |
| --- | --- |
| identifier | `[A-Za-z_$][A-Za-z0-9_$]*` — `$value`, `$key`, `$depth` are ordinary identifiers with intrinsic meaning |
| keyword | `from`, `where`, `select` — **reserved**; never usable as a bare field name (`select where from r` is a parse error) |
| number | `digits [ "." digits ] [ ("e"\|"E") ["+"\|"-"] digits ]`. A `.` is a decimal point only when a digit follows, so `1..5` lexes as `1`, `..`, `5` and `1.5..2` as `1.5`, `..`, `2`. A **malformed number is a lex error** whose message names `malformed number`: a trailing decimal point (`1.`, `1.x`), an exponent without digits (`1e`, `1e+`), and a leading-dot numeral (`.5` — write `0.5`; `xs.0` is the same error, since a property name cannot be a digit and there is no index access) [`errors-lex`, `lexing`] |
| string | `"…"` or `'…'`, the two quotes interchangeable. Escapes: `\n` `\t` `\r` `\0` and `\<c>` for any other character `<c>` itself (`\"`, `\'`, `\\`). An unterminated string is a lex error |
| punctuation | `(` `)` `{` `}` `,` `:` `.` `^` |
| range | `..` (inclusive) and `...` (exclusive high end), scanned before `.` |
| operator | `==` `!=` `<=` `>=` `<` `>` `&&` `\|\|` `!` `+` `-` `*` `/` `%` |
| binding | a `${…}` interpolation of the tagged-template form; index `n` names the n-th bound value |

Any other character (`[`, `]`, `=`, `&`, `\|`, `@`, `;`, …) is a lex error
`unexpected character …` [`errors-lex`].

Keywords and identifiers are **case-sensitive**; `FROM` is an identifier
[`clause-order`].

**Contextual words** are identifiers that act as syntax only in position:
`collect exists none count first single order by asc desc follow distinct
frontier depth by in values limit offset`. Outside that position they are field
names (`limit from r`, `order from r`, `select follow from r`). A contextual
word that starts a clause but does not complete it is an error naming what the
clause needs (`order age` → `order by <expr>`; `follow` alone → a relation;
`limit x` → a number, binding, or `^name`) [`clause-order`, `limit-offset`].

`true`, `false`, and `null` are **literals in every position**: a value, and
never a receiver or relation (`true exists { … }`, `follow null` are parse
errors `… is a literal, not a collection`). A row property literally named
`true`/`false`/`null` is unreachable by name [`errors-parse`].

### Bindings

A query may be given as a tagged template: a list of string fragments with a
bound value between each adjacent pair. Each fragment is lexed independently and
a `binding` token is inserted between fragments. A bound value therefore never
becomes source text: it cannot supply an identifier, a keyword, an operator, or
close a block [`bindings`]. A binding is legal wherever a primary value, a
source, or a receiver is legal.

## 2. Query structure

A query is one of two forms:

```
query      = body                      ; the body's `from` is the source ("collect")
           | receiver consumer [ "distinct" ] "{" body "}"    ; directive form
```

The **directive form** consumes the whole query with the named consumer; nothing
may follow its closing brace. The **body form** always has the `collect`
consumer and must contain `from`.

### The fixed clause order (ADR-020)

A body is a sequence of clauses. Each appears **at most once**, in exactly this
order:

```
select  from  where  follow  order by  limit  offset
```

- A clause out of order is a parse error naming both clauses and the order:
  `` `select` must come before `from` — OQX clause order is select, from, where, follow, order by, limit, offset ``.
- A repeated clause is `` duplicate `<clause>` clause ``.
- Every clause is optional, except that a top-level body must have `from`
  (`a query must name its source …`). Inside a consumer block, `from E`
  re-projects each of the receiver's rows through `E` (a flatMap), because the
  receiver already supplied the rows.
- **Only `select` may drop its keyword, and only when it is the first clause
  written.** `name, id from people` ≡ `select name, id from people`. After any
  clause, a keyword-less run is an error: there is **no implicit `where`**
  (`from people active`, `people exists { age > 50 }` are parse errors whose
  message says to write `where`). The same rule applies inside every block.
- A consumer word directly after `from` gets a specific hint
  (`` unexpected `count` after `from` — a whole-query consumer is written `<collection> count { … }` … ``).
- **Only `}` ends a block, and only the end of input ends the query.** A stray
  punctuation mark, operator, or literal after a complete clause is reported
  where the body ends: at the top level `unexpected ')' after the query`, inside
  a block `unexpected ')' in the count { … } block — expected … or '}'`. (A stray
  `,` after `from` keeps the "a projection goes before `from`" hint.) A word
  there still gets the no-implicit-`where` message above.

[`clause-order`, `where`, `errors-parse`]

## 3. Clauses

### `select` — projection

```
projection = item { "," item } [ "values" ]
item       = { "^" } ident ":" ( directive | expr )      ; alias (carets = lift)
           | { "^" } expr                               ; unaliased
```

- An unaliased item must be a plain navigation (`name`, `meta.slug`, `$value`);
  its key is the **last segment**. Any other unaliased expression (a call,
  arithmetic, a comparison) is a parse error `… needs an alias …` unless the
  projection is in `values` mode.
- `select distinct …` marks the body distinct (see SEMANTICS §distinct).
- `values` after the list requires **exactly one** item and turns off record
  wrapping; an alias is accepted and ignored; a lift is rejected.
- An aliased item may be a **nested directive** `name: receiver (collect|first|single) [distinct] { body }`;
  `exists`/`none`/`count` are rejected there.
- **Projection names are unique** within one `select`. `a: 1, a: 2`,
  `name, name`, and a dotted default colliding with an alias (`meta.slug, slug: x`)
  are parse errors `duplicate projection name '<name>'` — the record would
  silently keep one value. (Lifts are keyed per depth: `^x` and `^^x` bind
  different rows and do not collide.)
- Leading carets on an item make it a **lift** (`^name: expr`, `^^name: expr`,
  or unaliased `^name`). A lift is **legal only in the `select` of a
  `collect { … }` in where position** (see SEMANTICS §lifts); at the top level,
  in a select-position block, in a whole-query directive, or in an
  `exists`/`none`/`count` block it is a parse error (`a lift (^x) … is only valid
  in a collect { … } in where position`) rather than a silent no-op. A lift's
  value must be a scalar expression, not a block.

[`projection`, `values`, `lifts`, `aliases`]

### `from` — source

`from expr`: any value expression; evaluated at the enclosing scope and coerced
to rows (SEMANTICS §collections). Typically a bare root name, a dotted
navigation (`cfg.items`), a binding, or a function call (`entries(x)`, `list(x)`).

### `where` — predicate

`where` owns the boolean structure so that consumer directives compose with
scalar predicates:

```
where    = or
or       = and { "||" and }
and      = primary { "&&" primary }
primary  = { "!" } group
         | { "!" } receiver consumer [ "distinct" ] "{" body "}" [ relop integer ]   ; consumer test
         | cmp                                                                    ; a scalar leaf (its own `!` is unary, §4)
group    = "(" where ")"                       ; a predicate group …
         | "(" where ")" scalar-tail           ; … or, when a scalar operator follows, a scalar operand
```

- A scalar leaf is a `cmp`-level expression (§4): it may contain arithmetic,
  `in`, ranges, and a single comparison, but its own `&&`/`||` belong to the
  where tree.
- **`!` has one precedence everywhere**: it is a prefix unary operator binding
  tighter than comparison, exactly as in value position and in the C family. In
  `where` it applies to the operand right after it — a consumer test (including
  its `count { … } <op> N` comparison: `!jobs count { } > 1` negates the whole
  test), a parenthesized group, or a scalar primary — **never to a whole
  comparison**: `!a == b` is `(!a) == b`; write `!(a == b)` to negate the
  comparison. `!(a) == false` is `(!a) == false`.
- **Parentheses in `where` group either a predicate or a scalar**, decided by
  the token after the `)`: a comparison, arithmetic, `in`, a range operator, or
  `.`-navigation makes the group a scalar operand (`(a + 1) > 2`,
  `(a || b) == 5` — `||` yields an operand, SEMANTICS §8 — `(name).size() > 3`);
  anything else makes it a predicate group (`(a > 1) && (b < 2)`, `((a))`,
  `(jobs exists { }) && a`). A group containing a consumer test can only be a
  predicate: `(xs count { }) > 1` is a parse error (`… is a predicate, not a
  value …`; write `xs count { } > 1` without the parentheses).
- Consumer tests: `exists`, `none`, `count` are legal; `first`/`single` are a
  parse error (`… is a select-position lookup …`); `collect` is legal only when
  every item it projects is a lift. Only `count { … }` may be followed by a
  comparison, and the right side must be a non-negative **integer literal**.
- Alias inlining: a bare identifier in `where` that names an alias of the same
  body's `select` is replaced by that alias's expression at parse time (see
  SEMANTICS §aliases). Alias cycles are parse errors.

[`where`, `consumers`, `aliases`]

### `follow` — recursion

```
follow   = "follow" [ "distinct" ] receiver [ "{" { option } "}" ]
option   = "where" expr | "frontier" expr | "depth" integer | "by" expr
```

`follow` is a clause when an identifier, a binding, or a `^` follows the word;
otherwise it is a field name (`select follow from r`). After `follow`,
**`distinct` is a keyword**: `follow distinct <relation>` sets the flag, and
`follow distinct {` or `follow distinct` at the end of the input is a parse
error `` expected a relation after `follow distinct` ``. A relation literally
named `distinct` is therefore not supported. The relation is a relation **of the
current row**: an outer reference (`follow ^rel`) is a parse error (`` `follow` takes a relation of the current row … ``), and so is a literal word (`follow
null`). `depth` must be an integer literal in 1..8. Each option at most once; any
other word in the block is a parse error. Semantics in SEMANTICS §follow.
[`follow`, `errors-parse`]

### `order by`

```
orderby  = "order" "by" spec { "," spec }
spec     = expr [ "asc" | "desc" ]
```

Recognized only as the two-word sequence. [`order-by`]

### `limit` / `offset`

```
bound    = ( "limit" | "offset" ) ( number | binding | { "^" } ident )
```

The word is a bound only when followed by a number literal, a binding, or an
outer reference (`^n`); otherwise it is an ordinary identifier (so `limit -1`
and `limit x` are parse errors that read `limit` as a stray name and say what a
bound may be). **At the top level `^n` is a parse error** (`… has no enclosing
scope`): a top-level bound is evaluated at the root scope itself, so there is
nothing for `^` to reach — unlike a top-level `where`/`select`, where a row's
enclosing scope is the root scope and `^k` reads the named root `k`
[`outer-refs`]. Inside a block `^n` reads the enclosing row. The value is
checked at evaluation time (SEMANTICS §bounds). [`limit-offset`]

## 4. Expressions

Value position (`select`, `order by`, `from`, function arguments, follow
options) accepts the full grammar. Precedence, loosest to tightest:

| Level | Operators | Notes |
| --- | --- | --- |
| or | `\|\|` | left-assoc; yields an operand (SEMANTICS §logical) |
| and | `&&` | left-assoc |
| cmp | `== != < <= > >=` `in` | **non-associative**: a second comparison in a row is a parse error `comparisons do not chain` (`a == b == c`, `a == b in c`) |
| range | `lo..hi` `lo...hi` `..hi` `lo..` | binds looser than arithmetic, tighter than comparison: `n in 1+1..2*3` is `n in (2..6)`. At least one bound is required |
| add | `+ -` | left-assoc |
| mul | `* / %` | left-assoc |
| unary | `!` `-` | prefix, right-assoc (`--5`); `!` has this same precedence in `where` (§3) |
| postfix | `.name` `.name(args)` `name(args)` | navigation, method call, free-function call |
| primary | literal, identifier, `^…name`, binding, `( expr )` | |

```
expr     = or
or       = and { "||" and }
and      = cmp { "&&" cmp }
cmp      = range [ relop range | "in" range ]
range    = ( ".." | "..." ) add                     ; open low end; the high bound is required
         | add [ ( ".." | "..." ) [ add ] ]          ; the high bound is omitted when the next
                                                     ; token cannot start a value (clause words included)
add      = mul { ("+" | "-") mul }
mul      = unary { ("*" | "/" | "%") unary }
unary    = "!" unary | "-" unary | postfix
postfix  = primary { "." ident [ "(" args ")" ] }
         | ident "(" args ")" { "." ident [ "(" args ")" ] }
primary  = number | string | "true" | "false" | "null"
         | ident                                     ; a property of the CURRENT scope only
         | "^" { "^" } ident                         ; an outer reference, exactly N scopes out
         | binding
         | "(" expr ")"
args     = [ expr { "," expr } ]
```

A range bound is a value; an open end stops at any token that cannot begin a
value. The contextual clause words (`order`, `by`, `asc`, `desc`, `follow`,
`distinct`, consumers, `limit`, `offset`, `in`, `values`, …) and the keywords do
not begin a value, so `where age in 18.. order by name` parses as intended and
`where n in .. order by a` — a range with **no** bound at all — is a parse error
(`a range needs at least one bound`) rather than a range up to `order`.
[`ranges`, `where`]

There is **no index syntax** (`a[0]`) and no array or object literal; bound
values (bindings) and named roots are how collections enter a query.

## 5. Receivers

A receiver (the left side of a consumer directive, or the relation of `follow`)
is deliberately narrower than an expression:

```
receiver = binding
         | { "^" } ident [ "(" args ")" ] { "." ident }
```

That is: a binding; or a dotted navigation whose head is a bare name, an outer
reference (`^people`, `^^root.rel`), or a free-function call (`entries(prefs)`).
Method calls, operators, and the literal words `true`/`false`/`null` are not
receivers. A directive is recognized only when the receiver is immediately
followed by a consumer word and then `{` (or `distinct {`); otherwise the tokens
are re-read as an ordinary expression. A dangling `.` in a receiver or a value
is the same parse error (`expected a property name after '.'`).
[`consumers`, `outer-refs`, `entries`, `errors-parse`]

## 6. Error stages

Every failure is an `OqxError` with a `stage`:

- `lex` — an unexpected character, an unterminated string, or a malformed number.
- `parse` — everything the grammar above rejects, including clause order,
  duplicates, missing `where`, projection naming (unnamed and duplicate items),
  misplaced lifts, alias cycles, `follow` options, chained comparisons, a
  top-level `limit ^n`, and `count` comparisons.
- `eval` — unknown functions/methods, `single` matching several rows, an
  invalid `limit`/`offset` value, `follow` inside a where-position directive.

Messages carry a `(at offset N)` suffix for lex/parse errors. Fixtures assert
only on stable fragments, never on offsets or whole messages.
[`errors-lex`, `errors-parse`, `errors-eval`]
