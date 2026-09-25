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
| number | `digits [ "." digits ] [ ("e"\|"E") ["+"\|"-"] digits ]`. A `.` is a decimal point only when a digit follows, so `1..5` lexes as `1`, `..`, `5`. Leading-dot numerals (`.5`) are accepted by the reference but not part of the spec |
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
frontier depth by in values limit offset true false null`. Outside that position
they are field names (`limit from r`, `order from r`, `select follow from r`).
`true`, `false`, and `null` are literals wherever a value is expected.

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

[`clause-order`, `where`]

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
- Leading carets on an item make it a **lift** (`^name: expr`, `^^name: expr`,
  or unaliased `^name`), meaningful inside a `collect { … }` that sits in
  `where` (see SEMANTICS §lifts). A lift's value must be a scalar expression, not
  a block.

[`projection`, `values`, `lifts`]

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
and      = not { "&&" not }
not      = "!" not | primary
primary  = "(" where ")"
         | receiver consumer [ "distinct" ] "{" body "}" [ relop integer ]   ; consumer test
         | cmp                                                            ; a scalar leaf
```

- A scalar leaf is a `cmp`-level expression (§4): it may contain arithmetic,
  `in`, ranges, and a single comparison, but its own `&&`/`||` belong to the
  where tree.
- Parentheses in `where` group **predicates**; `(a || b) == 5` is a parse
  error. (Compare a logical value through a select alias instead.)
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

`follow` is recognized only when a receiver (identifier or binding) follows the
word. `depth` must be an integer literal in 1..8. Each option at most once; any
other word in the block is a parse error. Semantics in SEMANTICS §follow.
[`follow`]

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
and `limit x` are parse errors that read `limit` as a stray name). The value
is checked at evaluation time (SEMANTICS §bounds). [`limit-offset`]

## 4. Expressions

Value position (`select`, `order by`, `from`, function arguments, follow
options) accepts the full grammar. Precedence, loosest to tightest:

| Level | Operators | Notes |
| --- | --- | --- |
| or | `\|\|` | left-assoc; yields an operand (SEMANTICS §logical) |
| and | `&&` | left-assoc |
| cmp | `== != < <= > >=` `in` | **non-associative**: one comparison per level (`a == b == c` is an error) |
| range | `lo..hi` `lo...hi` `..hi` `lo..` | binds looser than arithmetic, tighter than comparison: `n in 1+1..2*3` is `n in (2..6)` |
| add | `+ -` | left-assoc |
| mul | `* / %` | left-assoc |
| unary | `!` `-` | prefix, right-assoc (`--5`) |
| postfix | `.name` `.name(args)` `name(args)` | navigation, method call, free-function call |
| primary | literal, identifier, `^…name`, binding, `( expr )` | |

```
expr     = or
or       = and { "||" and }
and      = cmp { "&&" cmp }
cmp      = range [ relop range | "in" range ]
range    = ".." add | "..." add
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

An open-ended range's high bound stops at any token that cannot begin a value;
the contextual clause words (`order`, `by`, `asc`, `desc`, `follow`, consumers,
`limit`, …) do not begin a value, so `where age in 18.. order by name` parses
as intended. [`ranges`]

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
Method calls and operators are not receivers. A directive is recognized only
when the receiver is immediately followed by a consumer word and then `{` (or
`distinct {`); otherwise the tokens are re-read as an ordinary expression.
[`consumers`, `outer-refs`, `entries`]

## 6. Error stages

Every failure is an `OqxError` with a `stage`:

- `lex` — an unexpected character or an unterminated string.
- `parse` — everything the grammar above rejects, including clause order,
  duplicates, missing `where`, projection naming, alias cycles, `follow` options,
  and `count` comparisons.
- `eval` — unknown functions/methods, `single` matching several rows, an
  invalid `limit`/`offset` value, `follow` inside a where-position directive.

Messages carry a `(at offset N)` suffix for lex/parse errors. Fixtures assert
only on stable fragments, never on offsets or whole messages.
[`errors-lex`, `errors-parse`, `errors-eval`]
