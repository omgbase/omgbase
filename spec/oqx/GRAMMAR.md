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
| identifier | `[A-Za-z_$][A-Za-z0-9_$]*` — `$it`, `$key`, `$depth` are ordinary identifiers with intrinsic meaning |
| keyword | `from`, `where`, `select`, `is`, `not`, `and`, `or` — **reserved**; never usable as a bare field name (`select where from r` is a parse error). `is`, `not`, `and`, `or` are operators (§4, since 0.17) |
| number | `digits [ "." digits ] [ ("e"\|"E") ["+"\|"-"] digits ]`. A `.` is a decimal point only when a digit follows, so `1..5` lexes as `1`, `..`, `5` and `1.5..2` as `1.5`, `..`, `2`. A **malformed number is a lex error** whose message names `malformed number`: a trailing decimal point (`1.`, `1.x`), an exponent without digits (`1e`, `1e+`), and a leading-dot numeral (`.5` — write `0.5`; `xs.0` is the same error, since a property name cannot be a digit and there is no index access) [`errors-lex`, `lexing`]. A digits-only number **immediately** followed by `^` (no whitespace) heads an absolute scope reference (`0^docs`, §4; since 0.18) |
| string | `"…"` or `'…'`, the two quotes interchangeable. Escapes: `\n` `\t` `\r` `\0` and `\<c>` for any other character `<c>` itself (`\"`, `\'`, `\\`). An unterminated string is a lex error |
| punctuation | `(` `)` `{` `}` `[` `]` `,` `:` `.` `^` — `[`/`]` since 0.17 (brackets, §4); `^` is the outer-reference / lift marker, relative (`^^name`) or, after an integer, absolute (`0^name`, §4) |
| range | `..` (inclusive) and `...` (exclusive high end), scanned before `.` |
| operator | `==` `!=` `<=` `>=` `<` `>` `&&` `\|\|` `!` `+` `-` `*` `/` `%` — `!=` is one token, so `a! == b` (a required value compared) needs the space: `a!==b` lexes as `a`, `!=`, `=` |
| binding | a `${…}` interpolation of the tagged-template form; index `n` names the n-th bound value |

Any other character (`=`, `&`, `\|`, `@`, `;`, `#`, …) is a lex error
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

**Reserved words** (the one list): the keywords `from where select is not and
or` and the literal words `true false null`. A row property with one of these
names is unreachable by bare name. Every other word — including the contextual
`in` (omgbase's `docs` have an `in` relation: `follow in`, `in exists { }`) and
the consumer words — is a field name outside its position. [`sugar`]

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
           | receiver "{" body "}"                             ; ≡ receiver collect { body }   (0.17)
           | receiver bracket                                   ; `people[age > 40]` ≡ people first { where age > 40 }   (0.17)
```

The **directive form** consumes the whole query with the named consumer; nothing
may follow its closing brace. The **body form** always has the `collect`
consumer and must contain `from`.

**A receiver block without a consumer is `collect`** (since 0.17): `x { … }` ≡
`x collect { … }` wherever a directive may stand — the top-level directive form
(`docs { age > 15 }` as a whole query), select position (`js: jobs { employer }`)
and where position (`where jobs { ^e: employer }`). The `distinct` modifier still
needs the consumer word before it or inside the body (`x distinct { … }` is the
parse error it was; write `x collect distinct { … }` or `x { select distinct … }`).
**Carve-out:** in `follow` destination position a brace block after the **last**
destination is the options block (`follow children { depth 2 }` is unchanged), so
a destination block there keeps its explicit consumer (§`follow`). A bracket
chain (§4) whose outermost node is a directive may also be the whole query:
`people[age > 40]` is `people first { where age > 40 }`. [`sugar`, `ast`]

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
  clause, a keyword-less run is an error: there is **no implicit `where` after a
  clause** (`from people active`, `people exists { name age > 50 }` are parse
  errors whose message says to write `where`).
- **A where-first body** (since 0.17, blocks only): a block body whose **leading
  expression is syntactically a predicate** drops the `where` keyword instead —
  `people exists { age > 50 }` ≡ `people exists { where age > 50 }`,
  `jobs collect { pay > 2 }` ≡ `jobs collect { where pay > 2 }`. Such a body has
  **no `select` and no `from`** (a `from`/`select` after it is the ordinary
  clause-order error) and may continue with `follow`, `order by`, `limit`,
  `offset`. *Syntactically a predicate* is decided by shape, never by type: a
  comparison or `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`/`is not`,
  a call (free or method), a literal, a binding, a parenthesized expression, a
  postfix `!` or a bracket chain, a consumer test (`jobs exists { }`) — anything
  that is **not** a bare name, a dotted navigation (`a.b.c`), or a `^`-lift
  (`^name`, `^name: expr`). A bare name stays a projection
  (`jobs collect { employer }` is unchanged; the bare-field filter is
  `docs { is active }`), and so does the single item of a `values` projection
  whatever its shape (`{ n * 2 values }`, `{ true values }`). Projection plus
  filter keeps the keyword: `docs { name where age >= 18 }`. A comma after the
  leading predicate (`{ age >= 18, name }`) is a parse error whose message
  suggests `{ <projection> where age >= 18 }`.
- **The top level is unchanged**: `age > 15 from people` stays the parse error
  it was (`… needs an alias … at the top level a predicate is never implicit`),
  because a predicate there would be a `where` written *before* `from`, which the
  clause order forbids; the top-level projection is the only keyword-less
  clause. [`sugar`, `errors-parse`]
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
item       = [ scoperef ] ident ":" ( directive | expr )   ; alias (a scope reference = lift)
           | [ scoperef ] expr                            ; unaliased
scoperef   = "^" { "^" }                                  ; relative: one scope out per caret
           | integer "^"                                  ; absolute: scope N (§4, since 0.18)
```

- An unaliased item must be a plain navigation (`name`, `meta.slug`, `$it`),
  optionally required (`name!`, `jobs[0].employer`, §4); its key is the **last
  segment** of the navigation. (An unaliased item that *begins* with a scope
  reference is a lift, below — `x: ^name` / `x: 0^name` is how an outer
  reference is projected.) Any other unaliased expression (a call,
  arithmetic, a comparison, a bare bracket lookup `jobs[0]`) is a parse error
  `… needs an alias …` unless the projection is in `values` mode.
- **An item may reference the aliases of the items to its left** (since 0.17):
  `boss: ^people[id == ^manager], bossName: boss.name`. The reference is inlined
  by `resolveAliases` exactly as a `where` alias is (SEMANTICS §14): an alias
  shadows a same-named row field in the items after it; inside its own
  expression an alias's name is the row field; a reference to an item **to its
  right** is a parse error (`… is used before it is defined — a select item may
  reference only the items to its left`), and a chain of references that returns
  to an item is the alias-cycle error. The tree keeps the surface form.
  [`sugar`, `aliases`]
- `select distinct …` marks the body distinct (see SEMANTICS §distinct).
- `values` after the list requires **exactly one** item and turns off record
  wrapping; an alias is accepted and ignored; a lift is rejected.
- An aliased item may be a **nested directive** `name: receiver (collect|first|single) [distinct] { body }`
  — or its sugar `name: receiver { body }` (collect), `name: receiver[…]` (§4);
  `exists`/`none`/`count` are rejected there. An item whose value is exactly a
  directive is the `collect` item kind (AST.md); a directive navigated or
  operated on further (`jobs[0].pay`, `jobs[0]!`) is an ordinary `field`.
- **Projection names are unique** within one `select`. `a: 1, a: 2`,
  `name, name`, and a dotted default colliding with an alias (`meta.slug, slug: x`)
  are parse errors `duplicate projection name '<name>'` — the record would
  silently keep one value. (Lifts are keyed per depth: `^x` and `^^x` bind
  different rows and do not collide.)
- A leading scope reference on an item makes it a **lift** (`^name: expr`,
  `^^name: expr`, or unaliased `^name`; the absolute `1^name: expr` lifts into
  scope 1, §4). A lift is **legal only in the `select` of a
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
or       = and { ("||" | "or") and }
and      = primary { ("&&" | "and") primary }
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
- Consumer tests: `exists`, `none`, `count` are legal; `collect` is legal only
  when every item it projects is a lift. Only `count { … }` may be followed by a
  comparison, and the right side must be a non-negative **integer literal**.
  A `first`/`single` directive (or its bracket sugar, §4) is a **value**, never
  a test: as a bare leaf — alone, or under `!` — it is the parse error
  `… is a select-position lookup …` (write `exists`), while followed by a
  scalar continuation (`.name`, `[…]`, `!`, a comparison, arithmetic, `in`, a
  range) it is a scalar operand: `where jobs[0].pay > 2`,
  `where jobs first { }.pay > 2`, `where jobs[0]!`.
- Aliases: a bare identifier in `where` may name an alias of the same body's
  `select` (SEMANTICS §14); a `select` item may likewise name the items to its
  left (§`select`). The parser validates the reference — an alias
  cycle, or a block alias inside an expression, is a parse error — but keeps
  the identifier in the tree (AST.md §2); `resolveAliases` substitutes it
  before evaluation.

[`where`, `consumers`, `aliases`]

### `follow` — recursion

```
follow      = "follow" [ "distinct" ] destination { "," destination } [ "{" { option } "}" ]
destination = receiver                                                      ; a relation of the current row
            | receiver ("collect" | "first" | "single") [ "distinct" ] "{" body "}"   ; a destination block
option      = "where" expr | "frontier" expr | "depth" integer | "by" expr
```

`follow` is a clause when an identifier, a binding, or a scope reference (`^`,
`0^`) follows the word; otherwise it is a field name (`select follow from r`). **The implicit-`collect`
sugar does not apply to destinations:** a `{` after the last destination always
opens the **options block** — `follow children { depth 2 }` is a depth cap, and
`follow children { age > 1 }` is the options error (`… expected
where/frontier/depth/by …`, which also says a destination block needs its
consumer); `follow ^people { where ^$path in list(after) }` is the outer-reference
error below (`… it may only head a destination block (follow ^name collect { … })`),
because `^people` is read as a plain destination and the brace as its options.
[`sugar`] After `follow`,
**`distinct` is a keyword**: `follow distinct <relation>` sets the flag, and
`follow distinct {` or `follow distinct` at the end of the input is a parse
error `` expected a relation after `follow distinct` ``. A relation literally
named `distinct` is therefore not supported.

**Destinations** (since 0.14) are one or more, comma-separated; the walk is
their union (SEMANTICS §20). A **plain destination** is a relation **of the
current row**: an outer reference (`follow ^rel`) is a parse error (`` `follow`
takes a relation of the current row … ``), and so is a literal word (`follow
null`). A **destination block** is a receiver immediately followed by `collect`,
`first` or `single` (optionally `distinct`) and `{`: an ordinary select-position
block (§`select`), re-read per frontier row with `^` bound to that row. Its
receiver **may** be an outer reference — `follow ^people collect { where
manager == ^id }` (or `follow 0^people collect { … }`, §4) reads the named root
`people` from a top-level walk — since the block, not the receiver, is what
varies per row. `exists`, `none` and
`count` are not destinations (`` a follow destination must use
collect/first/single, not `exists` … ``). A comma not followed by a destination
is a parse error (`` expected a relation after ',' ``). The options block, when
present, follows the last destination. `depth` must be an integer literal in
1..8. Each option at most once; any other word in the block is a parse error.
Semantics in SEMANTICS §follow. [`follow`, `errors-parse`]

### `order by`

```
orderby  = "order" "by" spec { "," spec }
spec     = expr [ "asc" | "desc" ]
```

Recognized only as the two-word sequence. [`order-by`]

### `limit` / `offset`

```
bound    = ( "limit" | "offset" ) ( number | binding | scoperef ident )
```

The word is a bound only when followed by a number literal, a binding, or an
outer reference (`^n`, `1^n`); otherwise it is an ordinary identifier (so `limit -1`
and `limit x` are parse errors that read `limit` as a stray name and say what a
bound may be). **At the top level `^n` is a parse error** (`… has no enclosing
scope`): a top-level bound is evaluated at the root scope itself, so there is
nothing for `^` to reach — unlike a top-level `where`/`select`, where a row's
enclosing scope is the root scope and `^k` reads the named root `k`
[`outer-refs`]; for the same reason `limit 0^n` there is the absolute
reference's own error (`scope 0 does not enclose this block (the current scope
is depth 0)`, §4) [`absolute-refs`]. Inside a block `^n` reads the enclosing
row (the block's own depth is the bound's: `limit 1^n` in a block under a
top-level row is `limit ^n`). The value is checked at evaluation time
(SEMANTICS §bounds). [`limit-offset`]

## 4. Expressions

Value position (`select`, `order by`, `from`, function arguments, follow
options) accepts the full grammar. Precedence, loosest to tightest:

| Level | Operators | Notes |
| --- | --- | --- |
| or | `\|\|` `or` | left-assoc; yields an operand (SEMANTICS §logical). `or` is an exact synonym of `\|\|` (since 0.17): the same node, the same short-circuit, the same value (`title or $path` coalesces); `print` writes `or` (since 0.18) |
| and | `&&` `and` | left-assoc; `and` is an exact synonym of `&&` (since 0.17); `print` writes `and` (since 0.18) |
| cmp | `== != < <= > >=` `in` `is` `is not` | **non-associative**: a second comparison in a row is a parse error `comparisons do not chain` (`a == b == c`, `a == b in c`, `a is b is c`). `x is y` is identity, `x is not y` its negation (SEMANTICS §5; since 0.17) |
| range | `lo..hi` `lo...hi` `..hi` `lo..` | binds looser than arithmetic, tighter than comparison: `n in 1+1..2*3` is `n in (2..6)`. At least one bound is required |
| add | `+ -` | left-assoc |
| mul | `* / %` | left-assoc |
| unary | `!` `-` `is` `not` | prefix, right-assoc (`--5`); `!` has this same precedence in `where` (§3). `is x` ≡ `!!x`, `not x` ≡ `!x` — pure sugar, desugared in the parser (since 0.17) |
| postfix | `.name` `.name(args)` `name(args)` `x!` `x[…]` `x <consumer> { … }` | navigation, method call, free-function call, the required operator, a bracket lookup, a value-position directive — left to right, tightest of all: `refs(c)[0]!.name` requires the lookup, `refs(c)[0].name!` the name |
| primary | literal, identifier, `^…name`, `N^name`, binding, `( expr )` | `N^name` is the absolute spelling of an outer reference (below; since 0.18) |

```
expr     = or
or       = and { ("||" | "or") and }
and      = cmp { ("&&" | "and") cmp }
cmp      = range [ relop range | "in" range | "is" [ "not" ] range ]
range    = ( ".." | "..." ) add                     ; open low end; the high bound is required
         | add [ ( ".." | "..." ) [ add ] ]          ; the high bound is omitted when the next
                                                     ; token cannot start a value (clause words included)
add      = mul { ("+" | "-") mul }
mul      = unary { ("*" | "/" | "%") unary }
unary    = "!" unary | "-" unary | "is" unary | "not" unary | postfix
postfix  = head { suffix }
head     = primary | ident "(" args ")"                     ; a free-function call
suffix   = "." ident [ "(" args ")" ]                       ; navigation, method call
         | "!"                                               ; required (0.17)
         | bracket                                           ; lookup (0.17)
         | ("collect" | "first" | "single") [ "distinct" ] "{" body "}"   ; value-position directive (0.17)
bracket  = "[" ( integer | binding ) "]" [ "!" ]            ; positional
         | "[" where "]" [ "!" ]                             ; predicate
primary  = number | string | "true" | "false" | "null"
         | ident                                     ; a property of the CURRENT scope only
         | scoperef ident                            ; an outer reference: `^^name` exactly N scopes out,
                                                     ; `N^name` the scope at depth N (below)
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

There is no array or object literal; bound values (bindings) and named roots
are how collections enter a query.

### Outer references: relative `^…name` and absolute `N^name` (since 0.18)

An outer reference names a scope other than the current one (SEMANTICS §2).
The relative form counts carets: `^name` reads one scope out, `^^name` two.
The absolute form names the scope by its **depth**: `N^name` is an unsigned
integer literal (digits only) **immediately** followed by `^` — no whitespace —
and then the name. Scope depth is syntactic: the root scope is 0, a top-level
row 1, a block's rows one deeper than the block's receiver, a `follow`
destination block's rows one below the frontier row, and a follow `where` one
deeper than the frontier row it tests successors of — exactly the `depth` the
`visit` traversal computes (AST.md §5).

```
scoperef = "^" { "^" }          ; relative: levels = the caret count
         | integer "^"          ; absolute: levels = currentDepth − N
```

`N^name` **desugars in the parser** to the `outer` node of the relative form
with `levels = currentDepth − N` (and `N^name:` at a select item's head to the
lift with that many carets); there is no new AST node and `print` writes the
carets. So from a top-level row `0^docs` is `^docs` and `0^$it` is `^$it` (the
root object, SEMANTICS §2); inside a block under it `1^$path` is `^$path` and
`0^docs` is `^^docs`; as a lift target `1^tasks: text` is `^tasks: text`; as a
destination block's receiver `follow 0^people collect { … }` is `follow ^people
collect { … }`. It composes with everything a caret form does: `x[0^y]`,
`0^docs[0]`, `entries(0^$it)`, `0^$it.docs collect { … }`.

`N ≥ currentDepth` is a parse error: `scope N does not enclose this block (the
current scope is depth D)` — `1^k` in a top-level `where` (depth 1), `from
0^docs` or `limit 0^n` at the top level (depth 0). The integer and the caret
must touch and the integer must be digits only: `1 ^k` and `1.0^k` are the
stray-token parse error the `^` was before. [`absolute-refs`]

### Postfix `!` — required (since 0.17)

`x!` is `x`, or an eval error when `x` is absent (SEMANTICS §5b). **A `!` token
that immediately follows a complete postfix chain** — a head and any run of
suffixes (`.name`, `.name(args)`, `[…]`, `!`, a value-position directive) — **is
the postfix required operator; a `!` anywhere else is the prefix negation.** The
two never compete: a `!` can only begin an operand where an operand can begin
(after an operator, a keyword, `(`, `[`, `,`, a range operator, or at the start
of a clause), and OQX never places two operands side by side, so a `!` after an
operand cannot start one. Hence `age! - 1` is `(age!) - 1`, `-a!` is `-(a!)`,
`!a!` is `!(a!)`, `a!.b` requires `a` and `a.b!` requires `a.b`, and `!=` stays
one token (`a! == b` needs its space). In `where`, a `!` before a consumer test or
a group is still the predicate negation (`!jobs exists { }`, `!(a > 1)`); `x[p]!`
is the bracket's own `!` (below). Precedence: postfix, tightest of all.

### Brackets (since 0.17)

A bracket suffix applies to any postfix chain — a bare name, a dotted navigation,
a free-function call, an outer reference, a binding, a required value, and the
result of a prior bracket or navigation (`refs(company)[0].name`,
`jobs[pay > 2][0]`) — but not to a literal (`true[0]` is `… is a literal, not a
collection`). What is inside decides the form, **syntactically**:

| Written | Means | |
| --- | --- | --- |
| `x[n]`, `n` an integer literal or a `${…}` binding | `x first { offset n }` | positional; out of range is absent; a binding must evaluate to a non-negative integer, else the `offset` eval error |
| `x[n]!` | `(x first { offset n })!` | required positional |
| `x[p]`, anything else | `x first { where p }` | the first match or absent; `p` is a full `where` tree (consumer tests, `!`, groups), read in the rows' scope with `^` the enclosing row — exactly the block it desugars to |
| `x[p]!` | `(x single { where p })!` | exactly one match: many is the `single` eval error, none the required error |

A negative literal (`x[-1]`) is a parse error (`negative indices are not
supported`), and so is a non-integer one (`x[1.5]`: `an index is a non-negative
integer literal or a binding`). Every bracket desugars in the parser to the
directive it means (AST.md §2): there is no bracket node, `print` writes the
directive, and the directive's span covers the sugar as written.

### Value-position directives (since 0.17)

`recv first { … }`, `recv single { … }` and `recv collect { … }` may stand
where a value stands — as the receiver of a navigation (`jobs first { }.pay`), an
operand (`jobs first { }.pay > 2`), a required value (`jobs single { }!`) — and
may themselves be navigated or bracketed further. This is how the canonical
printer writes a bracket chain back (`jobs[0].pay` prints as
`jobs first { offset 0 }.pay`). `exists`/`none`/`count` are predicates and have
no value form. In `where`, a value-position directive is a scalar operand only
with a continuation (§3). [`sugar`, `ast`]

## 5. Receivers

A receiver (the left side of a consumer directive, or a `follow` destination)
is deliberately narrower than an expression:

```
receiver = binding
         | [ scoperef ] ident [ "(" args ")" ] { "." ident }
```

That is: a binding; or a dotted navigation whose head is a bare name, an outer
reference (`^people`, `^^root.rel`, `0^people`, `0^$it.docs`), or a
free-function call (`entries(prefs)`).
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
  a comma after a where-first predicate, misplaced lifts, alias cycles and
  forward references, `follow` options, chained comparisons, a top-level
  `limit ^n`, an absolute reference to a scope that does not enclose the
  block (`scope N does not enclose this block …`), `count` comparisons, a
  negative or fractional index, a bare `first`/`single` in `where`.
- `eval` — unknown functions/methods, `single` matching several rows, a required
  value that is absent (`` `x!` is absent ``), an invalid `limit`/`offset` value
  (including a bracket index binding), `follow` inside a where-position
  directive.

Messages carry a `(at offset N)` suffix for lex/parse errors; `N` counts
Unicode code points over the raw source, the unit of every AST span (AST.md
§3). Fixtures assert only on stable fragments, never on offsets or whole
messages. A fourth stage, `print`, is raised by the canonical printer when a
tree holds a binding (AST.md §6); no fixture expects it.
[`errors-lex`, `errors-parse`, `errors-eval`]
