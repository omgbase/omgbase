//! Port of `packages/oqx/test/adapters.test.ts`: the tier-2 (custom
//! `DataContext`) and tier-3 (planner) seams, through the public API only.

use oqx::{
    DataContext, DefaultContext, Engine, InMemoryEngine, IndexedCollection, Object, OqxError,
    OqxResult, PlannedEngine, QueryPlanner, Result, Stage, Value, parse_string, run_query,
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

// A shared dataset for the tier-2 / tier-3 tests.
fn employees() -> Vec<Value> {
    let emp = |id: f64, name: &str, dept: &str, level: f64, city: &str| {
        obj(&[
            ("id", num(id)),
            ("name", s(name)),
            ("dept", s(dept)),
            ("level", num(level)),
            ("city", s(city)),
        ])
    };
    vec![
        emp(1.0, "Bob", "eng", 5.0, "NYC"),
        emp(2.0, "Alice", "eng", 7.0, "SF"),
        emp(3.0, "Carol", "sales", 4.0, "NYC"),
        emp(4.0, "Dave", "eng", 3.0, "SF"),
    ]
}

fn emp_roots() -> Object {
    let mut roots = Object::new();
    roots.insert("emp", Value::Array(employees()));
    roots
}

fn names(res: &OqxResult) -> Vec<String> {
    let OqxResult::Collect(rows) = res else {
        panic!("collect expected, got {res:?}");
    };
    rows.iter()
        .map(|r| r.as_object().unwrap().get("name").unwrap().to_string())
        .collect()
}

// ---- tier 2: a custom DataContext (lazy graph navigation) -------------------

/// Nodes stored by id; `children` is a relation resolved by id lookup, not a
/// stored array — the engine only sees it through the context.
struct Graph {
    nodes: Vec<(f64, &'static str, Vec<f64>)>,
}

impl Graph {
    fn node(&self, id: f64) -> Value {
        let (id, label, child_ids) = self
            .nodes
            .iter()
            .find(|(i, _, _)| *i == id)
            .expect("known node");
        obj(&[
            ("id", num(*id)),
            ("label", s(label)),
            (
                "childIds",
                Value::Array(child_ids.iter().copied().map(num).collect()),
            ),
        ])
    }
}

impl DataContext for Graph {
    fn root(&self, name: &str) -> Value {
        if name == "tree" {
            Value::Array(vec![self.node(1.0)])
        } else {
            Value::Undefined
        }
    }

    fn get(&self, row: &Value, key: &str) -> Result<Value> {
        // `children` is a computed relation, not a stored key. Since a bare
        // name is read from the current row only (via `get`), nothing else is
        // needed for the engine to see it.
        if key == "children" {
            let ids = row
                .as_object()
                .and_then(|o| o.get("childIds"))
                .and_then(Value::as_array)
                .unwrap_or(&[]);
            return Ok(Value::Array(
                ids.iter().map(|i| self.node(i.as_f64().unwrap())).collect(),
            ));
        }
        Ok(DefaultContext::read(row, key))
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        DefaultContext::default().to_rows(value)
    }

    fn identity(&self, row: &Value) -> Value {
        row.as_object().unwrap().get("id").unwrap().clone()
    }
}

#[test]
fn tier_2_a_custom_data_context_resolves_relations_its_own_way() {
    let graph = Graph {
        nodes: vec![
            (1.0, "root", vec![2.0, 3.0]),
            (2.0, "a", vec![4.0]),
            (3.0, "b", vec![]),
            (4.0, "a1", vec![]),
        ],
    };
    let q = parse_string("id: id, depth: $depth from tree follow children order by $depth, id")
        .unwrap();
    let res = InMemoryEngine::new(graph).run(&q, &[]).unwrap();
    assert_eq!(
        res,
        OqxResult::Collect(vec![
            obj(&[("id", num(1.0)), ("depth", num(1.0))]),
            obj(&[("id", num(2.0)), ("depth", num(2.0))]),
            obj(&[("id", num(3.0)), ("depth", num(2.0))]),
            obj(&[("id", num(4.0)), ("depth", num(3.0))]),
        ])
    );
}

/// A context that refuses one property name: the host's error channel on
/// `get` (language 0.13; the reference's `get` may throw the same way).
struct Guarded;

impl DataContext for Guarded {
    fn root(&self, name: &str) -> Value {
        if name == "rows" {
            Value::Array(vec![
                obj(&[
                    ("id", num(1.0)),
                    ("kids", Value::Array(vec![obj(&[("id", num(2.0))])])),
                ]),
                obj(&[("id", num(3.0)), ("secret", s("x"))]),
            ])
        } else {
            Value::Undefined
        }
    }

    fn get(&self, row: &Value, key: &str) -> Result<Value> {
        if key == "secret" {
            return Err(OqxError::eval(format!("'{key}' is reserved")));
        }
        Ok(DefaultContext::read(row, key))
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        DefaultContext::default().to_rows(value)
    }

    fn identity(&self, row: &Value) -> Value {
        DefaultContext::default().identity(row)
    }
}

#[test]
fn tier_2_an_err_from_get_is_the_query_s_eval_error() {
    let engine = InMemoryEngine::new(Guarded);
    let run = |q: &str| engine.run(&parse_string(q).unwrap(), &[]);
    // A query that never touches the key runs.
    assert_eq!(
        run("id values from rows").unwrap(),
        OqxResult::Collect(vec![num(1.0), num(3.0)])
    );
    // A bare name (in select, where, order by), a `.field`, a `^field` from a
    // nested block, and a read inside a follow all reach `get`; each Err
    // surfaces as the eval error itself.
    for q in [
        "secret from rows",
        "id values from rows where secret == \"x\"",
        "id values from rows order by secret",
        "x: $it.secret from rows",
        "id values from rows where kids exists { where ^secret == \"x\" }",
        "id values from rows where secret == \"x\" follow kids",
        "id values from rows follow kids { where secret == \"x\" }",
    ] {
        let err = run(q).unwrap_err();
        assert_eq!(err.stage, Stage::Eval, "{q}");
        assert!(err.message.contains("'secret' is reserved"), "{q}: {err}");
    }
    // Reading past absent never asks the context, so it cannot fail.
    assert!(run("x: nope.secret from rows").is_ok());
}

// ---- tier 3: the indexed optimizing planner ---------------------------------

#[test]
fn tier_3_indexed_collection_answers_an_equality_from_the_index_not_a_scan() {
    let idx = IndexedCollection::new("emp", employees(), &["dept", "city"]);
    // Direct plan inspection: only the eng rows are produced (index probe), and
    // the equality predicate is fully consumed (no residual where).
    let q = parse_string("name from emp where dept == \"eng\"").unwrap();
    let plan = idx
        .plan(&q, &[])
        .expect("planner should handle an indexed equality");
    let ids: Vec<f64> = plan
        .rows
        .iter()
        .map(|r| r.as_object().unwrap().get("id").unwrap().as_f64().unwrap())
        .collect();
    assert_eq!(ids, [1.0, 2.0, 4.0]);
    assert_eq!(plan.residual.r#where, None);
}

#[test]
fn tier_3_planned_engine_finishes_the_residual_over_the_reduced_rows() {
    let idx = IndexedCollection::new("emp", employees(), &["dept"]);
    let engine = PlannedEngine::new(idx);
    // `dept == "eng"` is pushed to the index; `level >= 5` is residual (in-memory).
    let q =
        parse_string("name from emp where dept == \"eng\" && level >= 5 order by name").unwrap();
    let res = engine.run(&q, &[]).unwrap();
    assert!(matches!(res, OqxResult::Collect(_)));
    assert_eq!(names(&res), ["Alice", "Bob"]);
}

#[test]
fn tier_3_planner_declines_a_query_it_cannot_optimize_fallback_stays_correct() {
    let idx = IndexedCollection::new("emp", employees(), &["dept"]);
    let engine = PlannedEngine::with_fallback(idx, DefaultContext::new(emp_roots()));
    // No indexed equality → planner returns None → in-memory fallback over roots.
    let q = parse_string("name from emp where level >= 5 order by name").unwrap();
    let res = engine.run(&q, &[]).unwrap();
    assert_eq!(names(&res), ["Alice", "Bob"]);
}

#[test]
fn tier_3_indexed_planner_agrees_with_the_naive_in_memory_engine() {
    let q = parse_string("name, dept from emp where city == \"NYC\" order by name").unwrap();
    let naive = run_query(&q, &[], emp_roots()).unwrap();
    let planned = PlannedEngine::new(IndexedCollection::new("emp", employees(), &["city"]))
        .run(&q, &[])
        .unwrap();
    assert_eq!(planned, naive);
}
