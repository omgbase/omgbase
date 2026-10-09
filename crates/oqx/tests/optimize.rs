//! The optimizer (`oqx::optimize`), through the public API: every behavior is
//! checked two ways — the default engine must produce exactly the naive
//! engine's result or error, AND a counting context must show the work
//! actually dropped (reads of the probed collection stop scaling with the
//! product of the two sides). Port of the reference's `test/optimize.test.ts`
//! (the trace hook has no Rust counterpart; the counting context stands in).

use std::cell::Cell;

use oqx::{
    DataContext, DefaultContext, Engine, InMemoryEngine, IndexedCollection, Object, OqxError,
    OqxResult, Result, Value, parse_string, parse_template,
};

fn num(n: f64) -> Value {
    Value::Number(n)
}

fn s(x: &str) -> Value {
    Value::Str(x.to_owned())
}

fn obj(pairs: &[(&str, Value)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn customers() -> Value {
    Value::Array(vec![
        obj(&[("id", num(1.0)), ("name", s("Ann")), ("region", s("west"))]),
        obj(&[("id", num(2.0)), ("name", s("Bob")), ("region", s("east"))]),
        obj(&[("id", num(3.0)), ("name", s("Cy")), ("region", s("west"))]),
    ])
}

fn orders() -> Value {
    let order = |id: f64, cid: f64, total: f64, region: &str| {
        obj(&[
            ("id", num(id)),
            ("customer_id", num(cid)),
            ("total", num(total)),
            ("region", s(region)),
        ])
    };
    Value::Array(vec![
        order(10.0, 1.0, 5.0, "west"),
        order(11.0, 2.0, 7.0, "east"),
        order(12.0, 1.0, 9.0, "east"),
        order(13.0, 9.0, 1.0, "west"), // no such customer
    ])
}

fn roots() -> Object {
    let mut r = Object::new();
    r.insert("customers", customers());
    r.insert("orders", orders());
    r
}

/// A context over plain values that counts every property read.
struct Counting {
    inner: DefaultContext,
    gets: Cell<usize>,
}

impl Counting {
    fn new(roots: Object) -> Self {
        Self {
            inner: DefaultContext::new(roots),
            gets: Cell::new(0),
        }
    }
}

impl DataContext for Counting {
    fn root(&self, name: &str) -> Value {
        self.inner.root(name)
    }
    fn get(&self, row: &Value, key: &str) -> Result<Value> {
        self.gets.set(self.gets.get() + 1);
        self.inner.get(row, key)
    }
    fn to_rows(&self, value: &Value) -> Vec<Value> {
        self.inner.to_rows(value)
    }
    fn identity(&self, row: &Value) -> Value {
        self.inner.identity(row)
    }
    fn call_function(&self, name: &str, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_function(name, args)
    }
    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_method(name, recv, args)
    }
}

type Outcome = std::result::Result<Value, (String, String)>;

fn outcome(r: Result<OqxResult>) -> Outcome {
    r.map(OqxResult::into_value)
        .map_err(|e: OqxError| (e.stage.as_str().to_owned(), e.message))
}

/// Run `src` on the optimized and the naive engine over `roots`; assert the
/// outcomes agree; return the optimized outcome and both engines' read counts.
fn both(src: &str, roots: Object) -> (Outcome, usize, usize) {
    both_with(&parse_string(src).unwrap(), &[], roots)
}

fn both_with(q: &oqx::Query, bindings: &[Value], roots: Object) -> (Outcome, usize, usize) {
    let naive_ctx = Counting::new(roots.clone());
    let naive = outcome(
        InMemoryEngine::new(naive_ctx)
            .with_rules(&[])
            .run(q, bindings),
    );
    let naive_gets = {
        // the engine owns the context; count again on a fresh one
        let ctx = Counting::new(roots.clone());
        let e = InMemoryEngine::new(ctx).with_rules(&[]);
        let _ = e.run(q, bindings);
        e.context().gets.get()
    };
    let ctx = Counting::new(roots);
    let engine = InMemoryEngine::new(ctx);
    let optimized = outcome(engine.run(q, bindings));
    let optimized_gets = engine.context().gets.get();
    assert_eq!(optimized, naive, "optimized ≠ naive for {q:?}");
    (optimized, naive_gets, optimized_gets)
}

fn ok(o: &Outcome) -> &Value {
    match o {
        Ok(v) => v,
        Err((stage, msg)) => panic!("expected a result, got {stage} error: {msg}"),
    }
}

fn err(o: &Outcome) -> &str {
    match o {
        Ok(v) => panic!("expected an error, got {v:?}"),
        Err((_, msg)) => msg,
    }
}

fn names(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_object().unwrap().get("name").unwrap().to_string())
        .collect()
}

// ---- the four motivating queries ------------------------------------------------

#[test]
fn zip_one_to_one_with_first() {
    let (r, _, _) = both(
        "select id, total, customer: ^customers first { name values where id == ^customer_id } from orders",
        roots(),
    );
    let rows = ok(&r).as_array().unwrap();
    let customer = |i: usize| {
        rows[i]
            .as_object()
            .unwrap()
            .get("customer")
            .unwrap()
            .clone()
    };
    assert_eq!(customer(0), s("Ann"));
    assert_eq!(customer(1), s("Bob"));
    assert_eq!(customer(2), s("Ann"));
    assert_eq!(customer(3), Value::Null);
}

#[test]
fn zip_via_bindings() {
    let q = parse_template(
        &[
            "select id, name: ",
            " first { name values where id == ^customer_id } from ",
            "",
        ],
        2,
    )
    .unwrap();
    let (r, _, _) = both_with(&q, &[customers(), orders()], Object::new());
    let rows = ok(&r).as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[3].as_object().unwrap().get("name"), Some(&Value::Null));
}

#[test]
fn one_to_many_with_collect_and_semi_join_with_exists() {
    let (r, _, _) = both(
        "select name, orders: ^orders collect { id values where customer_id == ^id } from customers",
        roots(),
    );
    let rows = ok(&r).as_array().unwrap();
    let ids = |i: usize| rows[i].as_object().unwrap().get("orders").unwrap().clone();
    assert_eq!(ids(0), Value::Array(vec![num(10.0), num(12.0)]));
    assert_eq!(ids(1), Value::Array(vec![num(11.0)]));
    assert_eq!(ids(2), Value::Array(vec![]));

    let (r, _, _) = both(
        "select id values from orders where ^customers exists { where id == ^customer_id }",
        roots(),
    );
    assert_eq!(ok(&r), &Value::Array(vec![num(10.0), num(11.0), num(12.0)]));
}

// ---- every consumer, values / distinct / order by / limit, lifts, residuals -----------

#[test]
fn consumers_in_both_positions_agree_with_the_scan() {
    for src in [
        "select name, last: ^orders first { id values where customer_id == ^id order by total desc } from customers",
        "select name, one: ^orders single { total values where customer_id == ^id && total > 6 } from customers",
        "select name, regions: ^orders collect distinct { region values where customer_id == ^id } from customers",
        "select name, top: ^orders collect { id values where customer_id == ^id order by total desc limit 1 } from customers",
        "select name, rows: ^orders collect { where customer_id == ^id offset 1 } from customers",
        "select name from customers where ^orders exists { where customer_id == ^id }",
        "select name from customers where ^orders none { where customer_id == ^id }",
        "select name from customers where ^orders count { where customer_id == ^id } >= 2",
        "select name from customers where ^orders count { where customer_id == ^id }",
        "select name, totals from customers where ^orders collect { ^totals: total where customer_id == ^id }",
        "select name from customers where ^orders exists { where customer_id == ^id offset 1 }",
        "select name, same: ^orders collect { id values where customer_id == ^id && region == ^region } from customers",
        "select name, big: ^orders collect { id values where customer_id == ^id && total > 6 } from customers",
        "select name, x: ^orders collect { id values where total > 1 && customer_id == ^id - 0 } from customers",
        "select name, w: ^orders collect { id values where region == \"west\" } from customers",
        "select name, all: ^customers collect { name values } from customers",
        "select name from customers where ^orders count { } == 4",
    ] {
        let (r, _, _) = both(src, roots());
        ok(&r);
    }
    let (r, _, _) = both(
        "select name, totals from customers where ^orders collect { ^totals: total where customer_id == ^id }",
        roots(),
    );
    assert_eq!(names(ok(&r)), ["Ann", "Bob"]);
    let (r, _, _) = both(
        "select name, same: ^orders collect { id values where customer_id == ^id && region == ^region } from customers",
        roots(),
    );
    let rows = ok(&r).as_array().unwrap();
    assert_eq!(
        rows[0].as_object().unwrap().get("same"),
        Some(&Value::Array(vec![num(10.0)]))
    );
}

// ---- the sound rule: errors keep their place -----------------------------------------

#[test]
fn a_raising_conjunct_left_of_the_equality_blocks_the_hoist() {
    let (r, _, _) = both(
        "select name from customers where ^orders exists { where nope(total) && customer_id == ^id }",
        roots(),
    );
    assert_eq!(err(&r), "unknown function 'nope(…)'");
    // an orphan customer: the scan still reaches nope() on the first order
    let mut lonely = roots();
    lonely.insert(
        "lonely",
        Value::Array(vec![obj(&[("id", num(3.0)), ("name", s("Cy"))])]),
    );
    let (r, _, _) = both(
        "select name from lonely where ^orders exists { where nope(total) && customer_id == ^id }",
        lonely.clone(),
    );
    assert_eq!(err(&r), "unknown function 'nope(…)'");
    let (r, _, _) = both(
        "select name from lonely where ^orders exists { where ^^customers count { where nope(name) } > 0 && customer_id == ^id }",
        lonely.clone(),
    );
    assert_eq!(err(&r), "unknown function 'nope(…)'");
    // …while a raising conjunct RIGHT of it is evaluated only over the bucket
    let (r, _, _) = both(
        "select name from lonely where ^orders exists { where customer_id == ^id && nope(total) }",
        lonely,
    );
    assert_eq!(ok(&r), &Value::Array(vec![]));
    let (r, _, _) = both(
        "select name from customers where ^orders exists { where customer_id == ^id && nope(total) }",
        roots(),
    );
    assert_eq!(err(&r), "unknown function 'nope(…)'");
}

#[test]
fn ranges_single_bounds_and_out_of_range_bindings_raise_identically() {
    let (r, _, _) = both(
        "select name, r: ^orders first { x: 1..2 where customer_id == ^id } from customers",
        roots(),
    );
    assert!(err(&r).contains("cannot appear in a result"));
    let (r, _, _) = both(
        "select name, r: ^orders single { where customer_id == ^id } from customers",
        roots(),
    );
    assert_eq!(err(&r), "single { … } for 'receiver' matched 2 rows");
    let (r, _, _) = both(
        "select name, o: ^orders first { where customer_id == ^id limit ^missing } from customers",
        roots(),
    );
    assert!(err(&r).contains("limit must be a non-negative integer"));
    let (r, _, _) = both(
        "select name from customers where ^orders exists { where customer_id == nope(^id) }",
        roots(),
    );
    assert_eq!(err(&r), "unknown function 'nope(…)'");
    let q = parse_template(
        &[
            "select name from customers where ^orders exists { where customer_id == ",
            " }",
        ],
        1,
    )
    .unwrap();
    let (r, _, _) = both_with(&q, &[], roots());
    assert!(err(&r).contains("out of range"));
    let (r, _, _) = both(
        "select name, x: ^customers single { } from customers",
        roots(),
    );
    assert_eq!(err(&r), "single { … } for 'receiver' matched 3 rows");
}

// ---- equality is §5 equality ---------------------------------------------------------

#[test]
fn hash_keys_reproduce_equality() {
    let mut r = Object::new();
    r.insert(
        "keys",
        Value::Array(vec![
            obj(&[("k", num(f64::NAN))]),
            obj(&[("k", num(-0.0))]),
            obj(&[("k", Value::Null)]),
            obj(&[]),
            obj(&[("k", obj(&[("tag", s("same"))]))]),
            obj(&[("k", s("1"))]),
            obj(&[("k", num(1.0))]),
        ]),
    );
    r.insert(
        "items",
        Value::Array(vec![
            obj(&[("k", num(f64::NAN)), ("v", s("nan"))]),
            obj(&[("k", num(0.0)), ("v", s("zero"))]),
            obj(&[("k", Value::Null), ("v", s("null"))]),
            obj(&[("v", s("absent"))]),
            obj(&[("k", obj(&[("tag", s("same"))])), ("v", s("obj"))]),
            obj(&[("k", s("1")), ("v", s("str"))]),
            obj(&[("k", num(1.0)), ("v", s("num"))]),
        ]),
    );
    let (out, _, _) = both(
        "select hits: ^items collect { v values where k == ^k } from keys",
        r,
    );
    let hits: Vec<Value> = ok(&out)
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row.as_object().unwrap().get("hits").unwrap().clone())
        .collect();
    let arr = |xs: &[&str]| Value::Array(xs.iter().map(|x| s(x)).collect());
    assert_eq!(hits[0], arr(&[]), "NaN matches nothing");
    assert_eq!(hits[1], arr(&["zero"]), "-0 is 0");
    assert_eq!(hits[2], arr(&["null", "absent"]), "null ≡ absent");
    assert_eq!(hits[3], arr(&["null", "absent"]), "absent ≡ null");
    assert_eq!(
        hits[4],
        arr(&["obj"]),
        "objects structurally (this crate's ==)"
    );
    assert_eq!(hits[5], arr(&["str"]));
    assert_eq!(hits[6], arr(&["num"]));
}

// ---- complexity: reads of the probed collection stop scaling with the product ---------

#[test]
fn the_probe_reads_the_receiver_once_per_run_not_once_per_outer_row() {
    let n = 200usize;
    let cs: Vec<Value> = (0..n)
        .map(|i| obj(&[("id", num(i as f64)), ("name", s(&format!("c{i}")))]))
        .collect();
    let os: Vec<Value> = (0..n)
        .map(|j| {
            obj(&[
                ("id", num(1000.0 + j as f64)),
                ("customer_id", num(((j * 7) % n) as f64)),
            ])
        })
        .collect();
    let mut r = Object::new();
    r.insert("customers", Value::Array(cs));
    r.insert("orders", Value::Array(os));
    let (out, naive_gets, optimized_gets) = both(
        "select id, customer: ^customers first { name values where id == ^customer_id } from orders",
        r,
    );
    assert_eq!(ok(&out).as_array().unwrap().len(), n);
    // naive: every outer row reads `id` off every customer (n² reads plus the
    // outer reads); optimized: one index build (n reads) plus three reads per
    // outer row (`id`, `customer_id`, the matched `name`).
    assert!(
        naive_gets > n * n,
        "naive should be quadratic: {naive_gets} reads"
    );
    assert!(
        optimized_gets <= 4 * n,
        "optimized should be linear: {optimized_gets} reads"
    );
}

#[test]
fn a_per_row_receiver_is_scanned_and_an_invariant_block_is_evaluated_once() {
    let mut r = Object::new();
    r.insert(
        "varying",
        Value::Array(vec![
            obj(&[
                ("id", num(1.0)),
                (
                    "lines",
                    Value::Array(vec![
                        obj(&[("cid", num(1.0)), ("t", num(1.0))]),
                        obj(&[("cid", num(2.0)), ("t", num(9.0))]),
                    ]),
                ),
            ]),
            obj(&[
                ("id", num(2.0)),
                (
                    "lines",
                    Value::Array(vec![obj(&[("cid", num(2.0)), ("t", num(2.0))])]),
                ),
            ]),
        ]),
    );
    let (out, naive_gets, optimized_gets) = both(
        "select id, mine: lines collect { t values where cid == ^id } from varying",
        r,
    );
    let rows = ok(&out).as_array().unwrap();
    assert_eq!(
        rows[0].as_object().unwrap().get("mine"),
        Some(&Value::Array(vec![num(1.0)]))
    );
    assert_eq!(
        naive_gets, optimized_gets,
        "a per-row receiver is scanned as before"
    );

    let (out, naive_gets, optimized_gets) = both(
        "select name, all: ^customers collect { name values } from customers",
        roots(),
    );
    let rows = ok(&out).as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        optimized_gets < naive_gets,
        "the invariant block is evaluated once: {optimized_gets} < {naive_gets} reads"
    );
}

// ---- IndexedCollection / the index_for seam ---------------------------------------------

#[test]
fn indexed_collection_context_serves_its_indexes_to_the_engine() {
    let orders_rows = orders().as_array().unwrap().to_vec();
    let idx = IndexedCollection::new("orders", orders_rows, &["customer_id"]);
    let mut extra = Object::new();
    extra.insert("customers", customers());
    let ctx = idx.context(extra);
    assert!(
        ctx.index_for(&orders(), &["customer_id".to_owned()])
            .is_some()
    );
    assert!(ctx.index_for(&orders(), &["region".to_owned()]).is_none());
    let q = parse_string(
        "select name, o: ^orders collect { id values where customer_id == ^id } from customers",
    )
    .unwrap();
    let planned = InMemoryEngine::new(ctx).run(&q, &[]).unwrap().into_value();
    let plain = InMemoryEngine::new(DefaultContext::new(roots()))
        .with_rules(&[])
        .run(&q, &[])
        .unwrap()
        .into_value();
    assert_eq!(planned, plain);
    let rows = planned.as_array().unwrap();
    assert_eq!(
        rows[0].as_object().unwrap().get("o"),
        Some(&Value::Array(vec![num(10.0), num(12.0)]))
    );
}

// ---- RowIndex::lookup_rows: a store-like index that never materializes the collection ----

/// A context whose `orders` root is a MARKER (`{"__lazy": "orders"}`, the
/// shape a store-backed context takes for a table it has not read) that
/// `to_rows` expands — counting every expansion — with a `lookup_rows` index on
/// `customer_id`: the engine must probe the index and never expand the marker.
/// `region` is not indexed, so a probe on it falls back to the engine's own
/// index over one expansion.
struct Lazy {
    inner: DefaultContext,
    walks: Cell<usize>,
    probes: std::cell::RefCell<Vec<Value>>,
}

fn marker() -> Value {
    obj(&[("__lazy", s("orders"))])
}

fn is_marker(v: &Value) -> bool {
    v.as_object()
        .and_then(|o| o.get("__lazy"))
        .is_some_and(|t| *t == s("orders"))
}

impl Lazy {
    fn new() -> Self {
        let mut roots = Object::new();
        roots.insert("customers", customers());
        Self {
            inner: DefaultContext::new(roots),
            walks: Cell::new(0),
            probes: std::cell::RefCell::new(Vec::new()),
        }
    }
}

struct CustomerIndex<'a>(&'a Lazy);

impl oqx::RowIndex for CustomerIndex<'_> {
    fn lookup(&self, value: &Value) -> Vec<usize> {
        orders()
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, o)| DefaultContext::read(o, "customer_id") == *value)
            .map(|(i, _)| i)
            .collect()
    }
    fn lookup_rows(&self, value: &Value) -> Option<Result<Vec<Value>>> {
        self.0.probes.borrow_mut().push(value.clone());
        Some(Ok(orders()
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| DefaultContext::read(o, "customer_id") == *value)
            .cloned()
            .collect()))
    }
}

impl DataContext for Lazy {
    fn root(&self, name: &str) -> Value {
        if name == "orders" {
            marker()
        } else {
            self.inner.root(name)
        }
    }
    fn get(&self, row: &Value, key: &str) -> Result<Value> {
        self.inner.get(row, key)
    }
    fn to_rows(&self, value: &Value) -> Vec<Value> {
        if is_marker(value) {
            self.walks.set(self.walks.get() + 1);
            return orders().as_array().unwrap().to_vec();
        }
        self.inner.to_rows(value)
    }
    fn identity(&self, row: &Value) -> Value {
        self.inner.identity(row)
    }
    fn call_function(&self, name: &str, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_function(name, args)
    }
    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_method(name, recv, args)
    }
    fn index_for(
        &self,
        collection: &Value,
        path: &[String],
    ) -> Option<std::rc::Rc<dyn oqx::RowIndex + '_>> {
        if is_marker(collection) && path == ["customer_id"] {
            Some(std::rc::Rc::new(CustomerIndex(self)))
        } else {
            None
        }
    }
}

fn lazy_both(src: &str) -> (Value, usize, Vec<Value>) {
    let q = parse_string(src).unwrap();
    let naive = InMemoryEngine::new(Lazy::new())
        .with_rules(&[])
        .run(&q, &[])
        .unwrap()
        .into_value();
    let engine = InMemoryEngine::new(Lazy::new());
    let optimized = engine.run(&q, &[]).unwrap().into_value();
    assert_eq!(optimized, naive, "optimized ≠ naive for {src}");
    let ctx = engine.context();
    (optimized, ctx.walks.get(), ctx.probes.borrow().clone())
}

#[test]
fn lookup_rows_answers_a_stable_receivers_probe_without_expanding_the_collection() {
    let (v, walks, probes) = lazy_both(
        "select name, o: ^orders collect { id values where customer_id == ^id } from customers",
    );
    assert_eq!(walks, 0, "the probe never materializes the receiver");
    assert_eq!(probes, vec![num(1.0), num(2.0), num(3.0)]);
    let rows = v.as_array().unwrap();
    assert_eq!(
        rows[0].as_object().unwrap().get("o"),
        Some(&Value::Array(vec![num(10.0), num(12.0)]))
    );
    // the naive engine expands the marker once per customer
    let q = parse_string(
        "select name, o: ^orders collect { id values where customer_id == ^id } from customers",
    )
    .unwrap();
    let e = InMemoryEngine::new(Lazy::new()).with_rules(&[]);
    e.run(&q, &[]).unwrap();
    assert_eq!(e.context().walks.get(), 3);
}

#[test]
fn lookup_rows_probes_the_varying_equality_and_keeps_the_rest_residual_in_place() {
    // literal first, `^` second: the probe is on customer_id; `region == "east"` is evaluated per candidate
    let (v, walks, probes) = lazy_both(
        "select name, o: ^orders collect { id values where region == \"east\" && customer_id == ^id } from customers",
    );
    assert_eq!(walks, 0);
    assert_eq!(probes, vec![num(1.0), num(2.0), num(3.0)]);
    let o = |i: usize| {
        v.as_array().unwrap()[i]
            .as_object()
            .unwrap()
            .get("o")
            .cloned()
    };
    assert_eq!(o(0), Some(Value::Array(vec![num(12.0)])));
    assert_eq!(o(1), Some(Value::Array(vec![num(11.0)])));
    assert_eq!(o(2), Some(Value::Array(vec![])));
    // the kept equality is a residual conjunct: a cardinality-only consumer still enters rows for it
    let (v2, walks2, _) = lazy_both(
        "select name from customers where ^orders exists { where region == \"east\" && customer_id == ^id }",
    );
    assert_eq!(walks2, 0);
    assert_eq!(v2.as_array().unwrap().len(), 2);
}

#[test]
fn lookup_rows_falls_back_to_the_engines_index_for_an_unserved_path() {
    let (_, walks, probes) = lazy_both(
        "select name, o: ^orders collect { id values where region == ^region } from customers",
    );
    assert_eq!(walks, 1, "materialized once per run, indexed by the engine");
    assert!(probes.is_empty());
}

#[test]
fn a_stable_receiver_is_read_once_per_run_even_without_a_correlation() {
    // `>` is no correlation and `^id` keeps the block from being invariant: only the receiver is stable
    let (v, walks, _) =
        lazy_both("select name from customers where ^orders exists { where total > ^id * 3 }");
    assert_eq!(walks, 1, "the receiver's rows are read once and reused");
    assert_eq!(v.as_array().unwrap().len(), 2);
}

#[test]
fn dollar_names_other_than_scope_intrinsics_are_local_paths() {
    // `$code` is an ordinary property read through the context (no scope meta
    // carries it), so a correlation on it is probed like any other field.
    let mut roots = Object::new();
    roots.insert(
        "a",
        Value::Array(vec![obj(&[("$code", s("x"))]), obj(&[("$code", s("y"))])]),
    );
    roots.insert(
        "b",
        Value::Array(vec![
            obj(&[("$code", s("x")), ("n", num(1.0))]),
            obj(&[("$code", s("y")), ("n", num(2.0))]),
            obj(&[("$code", s("x")), ("n", num(3.0))]),
        ]),
    );
    let (out, naive_gets, optimized_gets) = both(
        "select m: ^b collect { n values where $code == ^$code } from a",
        roots,
    );
    assert_eq!(
        out.unwrap(),
        Value::Array(vec![
            obj(&[("m", Value::Array(vec![num(1.0), num(3.0)]))]),
            obj(&[("m", Value::Array(vec![num(2.0)]))]),
        ])
    );
    assert!(
        optimized_gets < naive_gets,
        "{optimized_gets} < {naive_gets}"
    );
    // `$key` is scope metadata, never a local path: an `entries(…)` block is scanned, and agrees
    let mut roots = Object::new();
    roots.insert("a", Value::Array(vec![obj(&[("k", s("x"))])]));
    roots.insert("cfg", obj(&[("x", num(1.0)), ("y", num(2.0))]));
    let (out, _, _) = both(
        "select v: entries(^cfg) collect { $it values where $key == ^k } from a",
        roots,
    );
    assert_eq!(
        out.unwrap(),
        Value::Array(vec![obj(&[("v", Value::Array(vec![num(1.0)]))])])
    );
}
