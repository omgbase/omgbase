// Representative OQX, each with its expected tokenization in the notation
// `class(text) …` (whitespace dropped, touching same-class tokens merged). These
// are the goldens: a grammar change that alters any of them fails the tests, and
// `valid` says whether @omgbase/oqx parses the source (a lex-error sample must
// show an `illegal` / `numberInvalid` token, an unterminated string or an
// unterminated block comment).

export interface Sample {
  name: string;
  valid: boolean;
  source: string;
  tokens: string;
}

export const CORPUS: Sample[] = [
  {
    name: "people and current jobs",
    valid: true,
    source: "name, id, title from people where jobs exists { where employer == \"Globocorp\" && !end_date }",
    tokens:
      "identifier(name) comma(,) identifier(id) comma(,) identifier(title) keyword(from) identifier(people) keyword(where) identifier(jobs) consumer(exists) braceOpen({) keyword(where) identifier(employer) operator(==) string(\"Globocorp\") operator(&&) operator(!) identifier(end_date) braceClose(})",
  },
  {
    name: "select distinct … values",
    valid: true,
    source: "select distinct employer values from jobs",
    tokens:
      "keyword(select) modifier(distinct) identifier(employer) modifier(values) keyword(from) identifier(jobs)",
  },
  {
    name: "aliases, arithmetic, single quotes",
    valid: true,
    source: "label: name, decade: age / 10 from people where name == 'Bob'",
    tokens:
      "alias(label) colon(:) identifier(name) comma(,) alias(decade) colon(:) identifier(age) operator(/) number(10) keyword(from) identifier(people) keyword(where) identifier(name) operator(==) string('Bob')",
  },
  {
    name: "$it, order by desc",
    valid: true,
    source: "$it values from scores where $it > 50 order by $it desc",
    tokens:
      "intrinsic($it) modifier(values) keyword(from) identifier(scores) keyword(where) intrinsic($it) operator(>) number(50) clause(order) clause(by) intrinsic($it) modifier(desc)",
  },
  {
    name: "entries, $key, limit and offset",
    valid: true,
    source: "key: $key, value: $it from entries(settings) limit 10 offset 20",
    tokens:
      "alias(key) colon(:) intrinsic($key) comma(,) alias(value) colon(:) intrinsic($it) keyword(from) builtinFunction(entries) parenOpen(() identifier(settings) parenClose()) clause(limit) number(10) clause(offset) number(20)",
  },
  {
    name: "outer reference",
    valid: true,
    source: "owner from accounts where orders exists { where amount > ^budget }",
    tokens:
      "identifier(owner) keyword(from) identifier(accounts) keyword(where) identifier(orders) consumer(exists) braceOpen({) keyword(where) identifier(amount) operator(>) lift(^) identifier(budget) braceClose(})",
  },
  {
    name: "receiver with ^ and a select-position collect",
    valid: true,
    source: "name, peers: ^people collect { name where city == ^city && name != ^name } from people",
    tokens:
      "identifier(name) comma(,) alias(peers) colon(:) lift(^) identifier(people) consumer(collect) braceOpen({) identifier(name) keyword(where) identifier(city) operator(==) lift(^) identifier(city) operator(&&) identifier(name) operator(!=) lift(^) identifier(name) braceClose(}) keyword(from) identifier(people)",
  },
  {
    name: "follow with every option",
    valid: true,
    source: "id, depth: $depth from tree follow children { where active frontier $leaf depth 4 } order by $depth, id",
    tokens:
      "identifier(id) comma(,) alias(depth) colon(:) intrinsic($depth) keyword(from) identifier(tree) clause(follow) identifier(children) braceOpen({) keyword(where) identifier(active) followOption(frontier) intrinsic($leaf) followOption(depth) number(4) braceClose(}) clause(order) clause(by) intrinsic($depth) comma(,) identifier(id)",
  },
  {
    name: "follow distinct over the omgbase `in` relation",
    valid: true,
    source: "from docs follow distinct in { depth 2 }",
    tokens:
      "keyword(from) identifier(docs) clause(follow) modifier(distinct) identifier(in) braceOpen({) followOption(depth) number(2) braceClose(})",
  },
  {
    name: "omgbase: $repo, row functions, `in` as a receiver, builtin method",
    valid: true,
    source: "path: $it from $repo.docs where text(\"alchemy\") && semantic('gold') > 0.5 && in exists { where $it.startsWith(\"a/\") }",
    tokens:
      "alias(path) colon(:) intrinsic($it) keyword(from) intrinsic($repo) accessor(.) member(docs) keyword(where) hostFunction(text) parenOpen(() string(\"alchemy\") parenClose()) operator(&&) hostFunction(semantic) parenOpen(() string('gold') parenClose()) operator(>) number(0.5) operator(&&) identifier(in) consumer(exists) braceOpen({) keyword(where) intrinsic($it) accessor(.) builtinMethod(startsWith) parenOpen(() string(\"a/\") parenClose()) braceClose(})",
  },
  {
    name: "builtins, methods, string escape, every range form",
    valid: true,
    source: "n: size(jobs), lo: name.lower(), m: name.matches(\"^a\\\\d\", \"i\") from people where age in 18..65 && x in 1...5 && y in ..3 && z in 4..",
    tokens:
      "alias(n) colon(:) builtinFunction(size) parenOpen(() identifier(jobs) parenClose()) comma(,) alias(lo) colon(:) identifier(name) accessor(.) builtinMethod(lower) parenOpen(() parenClose()) comma(,) alias(m) colon(:) identifier(name) accessor(.) builtinMethod(matches) parenOpen(() string(\"^a) stringEscape(\\\\) string(d\") comma(,) string(\"i\") parenClose()) keyword(from) identifier(people) keyword(where) identifier(age) membership(in) number(18) range(..) number(65) operator(&&) identifier(x) membership(in) number(1) range(...) number(5) operator(&&) identifier(y) membership(in) range(..) number(3) operator(&&) identifier(z) membership(in) number(4) range(..)",
  },
  {
    name: "template literal (0.21): interpolations, a block inside one, escapes, a nested literal",
    valid: true,
    source: "label: `${title} (${era}) ${jobs single { employer values where primary }} \\` \\${x} $y ${ `<${n}>` }` from docs",
    tokens:
      "alias(label) colon(:) template(`) interpolation(${) identifier(title) interpolation(}) template( () interpolation(${) identifier(era) interpolation(}) template() ) interpolation(${) identifier(jobs) consumer(single) braceOpen({) identifier(employer) modifier(values) keyword(where) identifier(primary) braceClose(}) interpolation(}) template( ) stringEscape(\\`) template( ) stringEscape(\\$) template({x} $y ) interpolation(${) template(`<) interpolation(${) identifier(n) interpolation(}) template(>`) interpolation(}) template(`) keyword(from) identifier(docs)",
  },
  {
    name: "a bracket lookup (0.17) and a lex error: `#` is not a comment (0.28 added `//` and `/* */`, not `#`)",
    valid: false,
    source: "from r where a[0] == 1 # comment",
    tokens:
      "keyword(from) identifier(r) keyword(where) identifier(a) bracketOpen([) number(0) bracketClose(]) operator(==) number(1) illegal(#) identifier(comment)",
  },
  // Comments (0.28): whitespace to the lexer, read before every rule of the table.
  {
    name: "comments (0.28): a line comment at the end of a line; the newline ends it",
    valid: true,
    source: "people { select name // the names\n order by name }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) identifier(name) commentLine(// the names) clause(order) clause(by) identifier(name) braceClose(})",
  },
  {
    name: "comments (0.28): a line comment at the end of the query, after a braceless consumer",
    valid: true,
    source: "people count // how many",
    tokens: "identifier(people) identifier(count) commentLine(// how many)",
  },
  {
    name: "comments (0.28): block comments between tokens, touching tokens, and an empty one",
    valid: true,
    source: "people{select /* the projection */ name/**/where/* adults */age > 18 }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) commentBlock(/* the projection */) identifier(name) commentBlock(/**/) keyword(where) commentBlock(/* adults */) identifier(age) operator(>) number(18) braceClose(})",
  },
  {
    name: "comments (0.28): a block comment spanning lines disables a clause in place",
    valid: true,
    source: "people {\n  select name\n  /* where age > 50\n     — disabled while refining */\n  order by name\n}",
    tokens:
      "identifier(people) braceOpen({) keyword(select) identifier(name) commentBlock(/* where age > 50) commentBlock(     — disabled while refining */) clause(order) clause(by) identifier(name) braceClose(})",
  },
  {
    name: "comments (0.28): `*/` inside a line comment, `//` inside a block comment, and no nesting",
    valid: true,
    source: "people { select name // a */ b\n where /* c // d */ age > 50 && /* outer /* inner */ age < 90 }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) identifier(name) commentLine(// a */ b) keyword(where) commentBlock(/* c // d */) identifier(age) operator(>) number(50) operator(&&) commentBlock(/* outer /* inner */) identifier(age) operator(<) number(90) braceClose(})",
  },
  {
    name: "comments (0.28): `//` inside a string is string text; a quote inside a comment opens no string",
    valid: true,
    source: "people { select name where name != \"//\" && name != '/*' // it's \"fine\"\n }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) identifier(name) keyword(where) identifier(name) operator(!=) string(\"//\") operator(&&) identifier(name) operator(!=) string('/*') commentLine(// it's \"fine\") braceClose(})",
  },
  {
    name: "comments (0.28): `/*` inside a template literal's text is text",
    valid: true,
    source: "people { select t: `a /* not a comment */ b // nor this` values limit 1 }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) alias(t) colon(:) template(`a /* not a comment */ b // nor this`) modifier(values) clause(limit) number(1) braceClose(})",
  },
  {
    name: "comments (0.28): inside a `${ … }` interpolation a comment is a comment, line or block",
    valid: true,
    source: "people { select t: `${ name /* the name */ } is ${ age // the age\n }` values order by name }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) alias(t) colon(:) template(`) interpolation(${) identifier(name) commentBlock(/* the name */) interpolation(}) template( is ) interpolation(${) identifier(age) commentLine(// the age) interpolation(}) template(`) modifier(values) clause(order) clause(by) identifier(name) braceClose(})",
  },
  {
    name: "comments (0.28): a single `/` is still division",
    valid: true,
    source: "people { select name, h: age / 2 where age/2 > 24 }",
    tokens:
      "identifier(people) braceOpen({) keyword(select) identifier(name) comma(,) alias(h) colon(:) identifier(age) operator(/) number(2) keyword(where) identifier(age) operator(/) number(2) operator(>) number(24) braceClose(})",
  },
  {
    name: "comments (0.28): an unterminated block comment runs to the end of the input (a lex error, no error token)",
    valid: false,
    source: "people { select name /* never\nclosed",
    tokens: "identifier(people) braceOpen({) keyword(select) identifier(name) commentBlock(/* never) commentBlock(closed)",
  },
  {
    name: "lex errors: malformed numbers",
    valid: false,
    source: "x: 1. , y: 1e , z: .5, w: xs.0 from r",
    tokens:
      "alias(x) colon(:) numberInvalid(1.) comma(,) alias(y) colon(:) numberInvalid(1e) comma(,) alias(z) colon(:) numberInvalid(.5) comma(,) alias(w) colon(:) identifier(xs) numberInvalid(.0) keyword(from) identifier(r)",
  },
  {
    name: "contextual words as field names",
    valid: true,
    source: "select count from r where limit > 1 && order == 2 && follow != 3",
    tokens:
      "keyword(select) identifier(count) keyword(from) identifier(r) keyword(where) identifier(limit) operator(>) number(1) operator(&&) identifier(order) operator(==) number(2) operator(&&) identifier(follow) operator(!=) number(3)",
  },
  {
    name: "negation, grouping, arithmetic",
    valid: true,
    source: "name from people where has(age) && !(a == b) || c % 2 == 0",
    tokens:
      "identifier(name) keyword(from) identifier(people) keyword(where) builtinFunction(has) parenOpen(() identifier(age) parenClose()) operator(&&) operator(!) parenOpen(() identifier(a) operator(==) identifier(b) parenClose()) operator(||) identifier(c) operator(%) number(2) operator(==) number(0)",
  },
  {
    name: "range binds looser than arithmetic; range()",
    valid: true,
    source: "from people where n in 1+1..2*3 && \"2026-01-01\" in range(window)",
    tokens:
      "keyword(from) identifier(people) keyword(where) identifier(n) membership(in) number(1) operator(+) number(1) range(..) number(2) operator(*) number(3) operator(&&) string(\"2026-01-01\") membership(in) builtinFunction(range) parenOpen(() identifier(window) parenClose())",
  },
  {
    name: "unterminated string runs to the end",
    valid: false,
    source: "from r where name == \"unterminated",
    tokens:
      "keyword(from) identifier(r) keyword(where) identifier(name) operator(==) string(\"unterminated)",
  },
  {
    name: "multi-line body with literals",
    valid: true,
    source: "name,\n  siblings: family collect { name where parent == ^parent }\nfrom family\nwhere true && !null",
    tokens:
      "identifier(name) comma(,) alias(siblings) colon(:) identifier(family) consumer(collect) braceOpen({) identifier(name) keyword(where) identifier(parent) operator(==) lift(^) identifier(parent) braceClose(}) keyword(from) identifier(family) keyword(where) literal(true) operator(&&) operator(!) literal(null)",
  },
  {
    name: "bindings of the template form",
    valid: true,
    source: "from ${0} where a == ${1}",
    tokens:
      "keyword(from) binding(${0}) keyword(where) identifier(a) operator(==) binding(${1})",
  },
  {
    name: "`in` as a field: method receiver and argument",
    valid: true,
    source: "from r where in.size() > 0 && size(in) == 2",
    tokens:
      "keyword(from) identifier(r) keyword(where) identifier(in) accessor(.) builtinMethod(size) parenOpen(() parenClose()) operator(>) number(0) operator(&&) builtinFunction(size) parenOpen(() identifier(in) parenClose()) operator(==) number(2)",
  },
  {
    name: "`in` projected and as a count receiver",
    valid: true,
    source: "select in, out from docs where in count { } > 2",
    tokens:
      "keyword(select) identifier(in) comma(,) identifier(out) keyword(from) identifier(docs) keyword(where) identifier(in) consumer(count) braceOpen({) braceClose(}) operator(>) number(2)",
  },
  {
    name: "lifts at the top level (a parse error, lexically fine)",
    valid: false,
    source: "^done: attrs.text, ^^twice: x from nodes where kind == \"md:task\" && attrs.checked",
    tokens:
      "lift(^) alias(done) colon(:) identifier(attrs) accessor(.) member(text) comma(,) lift(^^) alias(twice) colon(:) identifier(x) keyword(from) identifier(nodes) keyword(where) identifier(kind) operator(==) string(\"md:task\") operator(&&) identifier(attrs) accessor(.) member(checked)",
  },
  {
    name: "asc/desc as fields and as directions",
    valid: true,
    source: "asc: 1 from r order by asc desc, desc asc limit 3",
    tokens:
      "alias(asc) colon(:) number(1) keyword(from) identifier(r) clause(order) clause(by) identifier(asc) modifier(desc) comma(,) identifier(desc) modifier(asc) clause(limit) number(3)",
  },
  {
    name: "first/single consumers, values inside a block",
    valid: true,
    source: "first: jobs first { employer values }, one: jobs single distinct { employer } from people",
    tokens:
      "alias(first) colon(:) identifier(jobs) consumer(first) braceOpen({) identifier(employer) modifier(values) braceClose(}) comma(,) alias(one) colon(:) identifier(jobs) consumer(single) modifier(distinct) braceOpen({) identifier(employer) braceClose(}) keyword(from) identifier(people)",
  },
  {
    name: "a string spanning lines",
    valid: true,
    source: "from r where note == \"line one\nline two\"",
    tokens:
      "keyword(from) identifier(r) keyword(where) identifier(note) operator(==) string(\"line one) string(line two\")",
  },
  {
    name: "single = and & and | are lex errors",
    valid: false,
    source: "from r where a = 1 & b | c",
    tokens:
      "keyword(from) identifier(r) keyword(where) identifier(a) illegal(=) number(1) illegal(&) identifier(b) illegal(|) identifier(c)",
  },
  {
    name: "a dangling dot and a lone $",
    valid: true,
    source: "from r where a. b && $ == 1",
    tokens:
      "keyword(from) identifier(r) keyword(where) identifier(a) accessor(.) identifier(b) operator(&&) intrinsic($) operator(==) number(1)",
  },
  {
    name: "a lift in a where-position collect",
    valid: true,
    source: "name, emps from people where jobs collect { ^emps: employer where !end }",
    tokens:
      "identifier(name) comma(,) identifier(emps) keyword(from) identifier(people) keyword(where) identifier(jobs) consumer(collect) braceOpen({) lift(^) alias(emps) colon(:) identifier(employer) keyword(where) operator(!) identifier(end) braceClose(})",
  },
  {
    name: "limit ^n inside a block",
    valid: true,
    source: "xs: items collect { name limit ^n } from r",
    tokens:
      "alias(xs) colon(:) identifier(items) consumer(collect) braceOpen({) identifier(name) clause(limit) lift(^) identifier(n) braceClose(}) keyword(from) identifier(r)",
  },
  {
    name: "absolute scope references (0^root, 1^row) and a numbered lift",
    valid: true,
    source: "id, t: tasks collect { text, doc: 1^path, n: size(0^docs) } from docs where tasks collect { 1^open: text }",
    tokens:
      "identifier(id) comma(,) alias(t) colon(:) identifier(tasks) consumer(collect) braceOpen({) identifier(text) comma(,) alias(doc) colon(:) lift(1^) identifier(path) comma(,) alias(n) colon(:) builtinFunction(size) parenOpen(() lift(0^) identifier(docs) parenClose()) braceClose(}) keyword(from) identifier(docs) keyword(where) identifier(tasks) consumer(collect) braceOpen({) lift(1^) alias(open) colon(:) identifier(text) braceClose(})",
  },
  {
    name: "a spaced `1 ^k` is a number then a caret (a parse error, lexically fine)",
    valid: false,
    source: "id from docs where 1 ^k == 2",
    tokens:
      "identifier(id) keyword(from) identifier(docs) keyword(where) number(1) lift(^) identifier(k) operator(==) number(2)",
  },
  {
    // omgbase surface 5.0 ("underscore = engine"): an engine name's leading `_`
    // is part of the identifier — `_id` lexes as a plain identifier, `_doc._title`
    // as an identifier and a member, and a bare authored key (`title`, `status`)
    // and a collection (`docs`) look exactly the same to the grammar.
    name: "surface 5.0 engine names: `_`-prefixed identifiers, members and relations beside bare keys",
    valid: true,
    source: "_id, _path, title, t: _title, kids: _blocks collect { _text, d: _doc._title } from docs where status == \"active\" follow _out_links collect { from _dst } order by _updated_at desc",
    tokens:
      "identifier(_id) comma(,) identifier(_path) comma(,) identifier(title) comma(,) alias(t) colon(:) identifier(_title) comma(,) alias(kids) colon(:) identifier(_blocks) consumer(collect) braceOpen({) identifier(_text) comma(,) alias(d) colon(:) identifier(_doc) accessor(.) member(_title) braceClose(}) keyword(from) identifier(docs) keyword(where) identifier(status) operator(==) string(\"active\") clause(follow) identifier(_out_links) consumer(collect) braceOpen({) keyword(from) identifier(_dst) braceClose(}) clause(order) clause(by) identifier(_updated_at) modifier(desc)",
  },
];
