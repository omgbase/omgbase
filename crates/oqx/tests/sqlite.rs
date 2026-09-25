//! Port of `packages/oqx/test/sqlite.test.ts`: OQX → SQL over an in-memory
//! SQLite database, with the in-memory engine finishing any residual — plus
//! the tier-3 = tier-1 law (a planned result equals the naive engine over the
//! same rows) across a spread of queries, and the Rust-side type mapping.

#![cfg(feature = "sqlite")]

use oqx::adapters::sqlite::{Compiled, SqliteTable, rusqlite};
use oqx::{
    DefaultContext, Engine, InMemoryEngine, Object, OqxResult, PlannedEngine, QueryPlanner, Value,
    parse_string, parse_template, run_query,
};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;

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

fn make_db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE emp (id INTEGER, name TEXT, dept TEXT, level INTEGER, city TEXT)",
    )
    .unwrap();
    let mut ins = db
        .prepare("INSERT INTO emp VALUES (?, ?, ?, ?, ?)")
        .unwrap();
    for e in employees() {
        let o = e.as_object().unwrap();
        let get = |k: &str| o.get(k).unwrap().clone();
        ins.execute(rusqlite::params![
            get("id").as_f64().unwrap() as i64,
            get("name").as_str().unwrap(),
            get("dept").as_str().unwrap(),
            get("level").as_f64().unwrap() as i64,
            get("city").as_str().unwrap(),
        ])
        .unwrap();
    }
    drop(ins);
    db
}

const COLUMNS: [&str; 5] = ["id", "name", "dept", "level", "city"];

fn planner(db: &Connection) -> SqliteTable<'_> {
    SqliteTable::new(db, "emp", &COLUMNS)
}

/// The `name` of each collected row (objects) or the rows themselves (`values`).
fn names(res: &OqxResult) -> Vec<String> {
    let OqxResult::Collect(rows) = res else {
        panic!("collect expected, got {res:?}");
    };
    rows.iter()
        .map(|r| match r {
            Value::Object(o) => o.get("name").unwrap().to_string(),
            other => other.to_string(),
        })
        .collect()
}

// ---- the reference's tests, one for one --------------------------------------

#[test]
fn pushes_a_comparison_predicate_into_sql_and_matches_the_in_memory_engine() {
    let db = make_db();
    let planner = planner(&db);
    let q = parse_string(
        "name, level from emp where dept == \"eng\" && level >= 5 order by level desc",
    )
    .unwrap();
    let sql = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    let mem = run_query(&q, &[], emp_roots()).unwrap();
    assert_eq!(sql, mem);
    assert_eq!(names(&sql), ["Alice", "Bob"]);
}

#[test]
fn reduces_rows_in_sql_before_residual_only_pushable_conjuncts_hit_the_db() {
    let db = make_db();
    let planner = planner(&db);
    // `matches(...)` can't translate → residual; `dept == "eng"` is pushed, so
    // SQL returns the 3 eng rows and the in-memory residual applies the regex.
    let q = parse_string("name from emp where dept == \"eng\" && name.matches(\"^A\")").unwrap();
    let plan = planner.plan(&q, &[]).expect("plan");
    assert_eq!(plan.rows.len(), 3); // SQL reduced 4 rows → 3 before residual
    assert!(plan.residual.r#where.is_some()); // the regex remains as residual
    let res = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    assert_eq!(names(&res), ["Alice"]);
}

#[test]
fn binding_values_become_sql_parameters() {
    let db = make_db();
    let planner = planner(&db);
    // A template binding (index 0) → a `?` SQL parameter bound to the passed value.
    let q = parse_template(&["name from emp where level >= ", " order by name"], 1).unwrap();
    let compiled = planner.compile(&q, &[num(4.0)]).unwrap();
    assert_eq!(
        compiled.sql,
        "SELECT * FROM \"emp\" WHERE (\"emp\".\"level\" >= ?)"
    );
    assert_eq!(compiled.params, [SqlValue::Real(4.0)]);
    let res = PlannedEngine::new(planner).run(&q, &[num(4.0)]).unwrap();
    assert_eq!(names(&res), ["Alice", "Bob", "Carol"]);
}

#[test]
fn a_range_membership_stays_residual_and_matches_the_in_memory_engine() {
    let db = make_db();
    let planner = planner(&db);
    // `in` (incl. a range RHS) is not translatable → the whole predicate is
    // residual; SQL returns all rows and the in-memory engine applies coverage.
    let q = parse_string("name from emp where level in 4..6 order by name").unwrap();
    let plan = planner.plan(&q, &[]).expect("plan");
    assert_eq!(plan.rows.len(), 4); // nothing pushed → all rows returned
    assert!(plan.residual.r#where.is_some()); // the range membership remains as residual
    let sql = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    let mem = run_query(&q, &[], emp_roots()).unwrap();
    assert_eq!(sql, mem);
    assert_eq!(names(&sql), ["Bob", "Carol"]); // levels 5 and 4
}

#[test]
fn unordered_first_pushes_a_limit() {
    let db = make_db();
    let planner = planner(&db);
    let q = parse_string("emp first { name where dept == \"eng\" }").unwrap();
    let plan = planner.plan(&q, &[]).expect("plan");
    assert_eq!(plan.rows.len(), 1); // LIMIT 1 applied in SQL
}

#[test]
fn a_query_level_limit_offset_is_honored_no_sql_limit_underneath_first_single_none() {
    let db = make_db();
    let planner = planner(&db);
    let engine = PlannedEngine::new(planner);
    for src in [
        // fully pushed predicate, unordered → SQL LIMIT must NOT apply
        "emp first { name values where dept == \"eng\" offset 1 }",
        "emp single { name values where dept == \"eng\" limit 1 }",
        "emp count { where dept == \"eng\" limit 2 }",
        "emp none { where dept == \"eng\" offset 3 }",
        "name values from emp where level >= 4 order by level desc limit 1 offset 1",
    ] {
        let q = parse_string(src).unwrap();
        assert_eq!(
            engine.run(&q, &[]).unwrap(),
            run_query(&q, &[], emp_roots()).unwrap(),
            "{src}"
        );
    }
}

// ---- the tier-3 = tier-1 law over a spread of shapes ---------------------------

#[test]
fn planned_result_equals_the_in_memory_engine_over_the_same_rows() {
    let db = make_db();
    let engine = PlannedEngine::new(planner(&db));
    let naive = InMemoryEngine::new(DefaultContext::new(emp_roots()));
    for src in [
        // fully pushed
        "name from emp where dept == \"eng\" order by name",
        "name from emp where dept == \"eng\" && level >= 5 order by name",
        "name from emp where \"NYC\" == city && level != 5 order by name",
        "name from emp where level + 1 >= 6 order by name",
        "name from emp where -level < -4 order by name",
        "name from emp where level * 2 > 8 && level % 2 == 1 order by name",
        "name from emp where level == 5.0",
        "name from emp where dept == \"eng\" && true order by name",
        "emp count { where dept == \"eng\" }",
        "emp exists { where level > 6 }",
        "emp none { where level > 10 }",
        "emp first { name where dept == \"sales\" }",
        "emp single { name where id == 2 }",
        "emp single { name where dept == \"nobody\" }",
        // where-level negation / disjunction are residual
        "name from emp where !(dept == \"eng\") order by name",
        "name from emp where dept == \"eng\" || dept == \"sales\" order by name",
        "name from emp where (dept == \"eng\" || dept == \"sales\") && level > 4 order by name",
        // untranslatable leaves are residual
        "name from emp where name.matches(\"^[AB]\") order by name",
        "name from emp where level in 7.. order by name",
        "name from emp where $value.level == 5",
        "name from emp where name.lower() == \"bob\"",
        "name from emp where unknown == 1",
        // no where, ordering, bounding, distinct, values, projections
        "name from emp order by name",
        "name from emp order by level desc limit 2 offset 1",
        "dept values from emp order by dept",
        "select distinct dept from emp order by dept",
        "name, senior: level >= 5 from emp order by name",
        "emp count { }",
        "emp first { name order by level }",
        "emp single { name where level > 4 order by level desc limit 1 }",
    ] {
        let q = parse_string(src).unwrap();
        assert_eq!(
            engine.run(&q, &[]).unwrap(),
            naive.run(&q, &[]).unwrap(),
            "{src}"
        );
    }
}

// ---- compilation: the SQL each shape produces -----------------------------------

#[test]
fn compile_pins_the_sql_and_parameters() {
    let db = make_db();
    let planner = planner(&db);
    let compile = |src: &str| -> Compiled {
        planner
            .compile(&parse_string(src).unwrap(), &[])
            .expect("compiles")
    };

    let c = compile("name from emp where dept == \"eng\" && level >= 5");
    assert_eq!(
        c.sql,
        "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?) AND (\"emp\".\"level\" >= ?)"
    );
    assert_eq!(
        c.params,
        [SqlValue::Text("eng".to_owned()), SqlValue::Real(5.0)]
    );
    assert_eq!(c.residual.r#where, None);

    let c = compile("name from emp where level != 5 && id < 3 && id <= 3 && id > 0");
    assert_eq!(
        c.sql,
        "SELECT * FROM \"emp\" WHERE (\"emp\".\"level\" <> ?) AND (\"emp\".\"id\" < ?) AND (\"emp\".\"id\" <= ?) AND (\"emp\".\"id\" > ?)"
    );

    let c = compile("name from emp where level + 1 - 2 * 3 / 4 % 5 == -level");
    assert_eq!(
        c.sql,
        "SELECT * FROM \"emp\" WHERE (((\"emp\".\"level\" + ?) - (((? * ?) / ?) % ?)) = (-\"emp\".\"level\"))"
    );

    let c = compile("name from emp where !level");
    // `!x` at the where level is a `Where::Not` → residual, so nothing pushed.
    assert_eq!(c.sql, "SELECT * FROM \"emp\"");
    assert!(c.residual.r#where.is_some());

    let c = compile("name from emp where dept == null && city == true");
    assert_eq!(c.params, [SqlValue::Null, SqlValue::Integer(1)]);

    // LIMIT for unordered first/single with nothing residual …
    let c = compile("emp first { name where dept == \"eng\" }");
    assert_eq!(
        c.sql,
        "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?) LIMIT 1"
    );
    let c = compile("emp single { name where dept == \"eng\" }");
    assert_eq!(
        c.sql,
        "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?) LIMIT 2"
    );
    let c = compile("emp first { name }");
    assert_eq!(c.sql, "SELECT * FROM \"emp\" LIMIT 1");
    // … but not when ordered, bounded, residual, or another consumer.
    let c = compile("emp first { name where dept == \"eng\" order by name }");
    assert_eq!(c.sql, "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?)");
    let c = compile("emp first { name where dept == \"eng\" limit 1 }");
    assert_eq!(c.sql, "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?)");
    let c = compile("emp first { name where dept == \"eng\" && name.matches(\"^A\") }");
    assert_eq!(c.sql, "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?)");
    let c = compile("emp count { where dept == \"eng\" }");
    assert_eq!(c.sql, "SELECT * FROM \"emp\" WHERE (\"emp\".\"dept\" = ?)");

    // Undeclared columns, outer refs, `$value`, members, calls, `in` → residual.
    for src in [
        "name from emp where unknown == 1",
        "name from emp where ^dept == \"eng\"",
        "name from emp where $value == 1",
        "name from emp where $value.dept == \"eng\"",
        "name from emp where name.lower() == \"bob\"",
        "name from emp where level in 4..6",
        "name from emp where dept == \"e\" + name.lower()",
    ] {
        let c = compile(src);
        assert_eq!(c.sql, "SELECT * FROM \"emp\"", "{src}");
        assert!(c.residual.r#where.is_some(), "{src}");
    }
}

#[test]
fn a_missing_binding_binds_null() {
    let db = make_db();
    let planner = planner(&db);
    let q = parse_template(&["name from emp where dept == ", ""], 1).unwrap();
    let c = planner.compile(&q, &[]).unwrap();
    assert_eq!(c.params, [SqlValue::Null]);
    assert!(planner.plan(&q, &[]).unwrap().rows.is_empty());
}

#[test]
fn declines_other_sources_re_projections_and_follow() {
    let db = make_db();
    let planner = planner(&db);
    let decline = |q: &oqx::Query| {
        assert!(planner.compile(q, &[]).is_none(), "{q:?}");
        assert!(planner.plan(q, &[]).is_none(), "{q:?}");
    };
    decline(&parse_string("name from other where dept == \"eng\"").unwrap());
    decline(&parse_string("name from emp where dept == \"eng\" follow manager").unwrap());
    let mut q = parse_string("name from emp where dept == \"eng\"").unwrap();
    q.from.push(oqx::Expr::Ident {
        name: "reports".to_owned(),
    });
    decline(&q);

    // A declined query runs in-memory over the engine's fallback context.
    let engine = PlannedEngine::with_fallback(planner, DefaultContext::new(emp_roots()));
    let q =
        parse_string("name from emp where dept == \"eng\" follow manager order by name").unwrap();
    assert_eq!(
        names(&engine.run(&q, &[]).unwrap()),
        ["Alice", "Bob", "Dave"]
    );
}

// ---- values, JSON columns, mapping, errors ---------------------------------------

#[test]
fn sqlite_types_map_to_values_and_select_star_returns_every_column() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE t (id INTEGER, ratio REAL, label TEXT, absent TEXT, bytes BLOB, extra TEXT);
         INSERT INTO t VALUES (1, 1.5, 'one', NULL, X'00FF', 'hidden');",
    )
    .unwrap();
    // `extra` is not a declared column: not pushable, but still returned.
    let planner = SqliteTable::new(&db, "t", &["id", "ratio", "label", "absent", "bytes"]);
    let q = parse_string("$value values from t").unwrap();
    let plan = planner.plan(&q, &[]).unwrap();
    assert_eq!(
        plan.rows,
        [obj(&[
            ("id", num(1.0)),
            ("ratio", num(1.5)),
            ("label", s("one")),
            ("absent", Value::Null),
            ("bytes", Value::Array(vec![num(0.0), num(255.0)])),
            ("extra", s("hidden")),
        ])]
    );
    let q = parse_string("extra from t where extra == \"hidden\"").unwrap();
    let c = planner.compile(&q, &[]).unwrap();
    assert_eq!(c.sql, "SELECT * FROM \"t\"");
    let res = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    assert_eq!(
        res,
        OqxResult::Collect(vec![obj(&[("extra", s("hidden"))])])
    );
}

#[test]
fn json_columns_are_parsed_back_into_row_values() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE doc (id INTEGER, tags TEXT, meta TEXT);
         INSERT INTO doc VALUES (1, '[\"a\",\"b\"]', '{\"k\":1,\"j\":null}');
         INSERT INTO doc VALUES (2, '[\"b\"]', 'not json');
         INSERT INTO doc VALUES (3, NULL, '{}');",
    )
    .unwrap();
    let planner = SqliteTable::new(&db, "doc", &["id"]).json_columns(&["tags", "meta"]);
    let q = parse_string("id, tags, meta from doc order by id").unwrap();
    let res = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    assert_eq!(
        res,
        OqxResult::Collect(vec![
            obj(&[
                ("id", num(1.0)),
                ("tags", Value::Array(vec![s("a"), s("b")])),
                ("meta", obj(&[("k", num(1.0)), ("j", Value::Null)])),
            ]),
            // Malformed JSON is left as the text it was; NULL stays null.
            obj(&[
                ("id", num(2.0)),
                ("tags", Value::Array(vec![s("b")])),
                ("meta", s("not json")),
            ]),
            obj(&[("id", num(3.0)), ("tags", Value::Null), ("meta", obj(&[]))]),
        ])
    );

    // Parsed columns take part in the residual like any other value.
    let db2 = Connection::open_in_memory().unwrap();
    db2.execute_batch(
        "CREATE TABLE doc (id INTEGER, tags TEXT);
         INSERT INTO doc VALUES (1, '[\"a\",\"b\"]');
         INSERT INTO doc VALUES (2, '[\"b\"]');",
    )
    .unwrap();
    let planner = SqliteTable::new(&db2, "doc", &["id"]).json_columns(&["tags"]);
    let q = parse_string("id values from doc where tags exists { where $value == \"a\" }").unwrap();
    let res = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    assert_eq!(res, OqxResult::Collect(vec![num(1.0)]));
}

#[test]
fn a_custom_map_replaces_the_raw_row_and_overrides_json_columns() {
    let db = make_db();
    let planner = SqliteTable::new(&db, "emp", &COLUMNS)
        .json_columns(&["name"]) // would be ignored: map wins
        .map(|raw| {
            obj(&[
                ("who", raw.get("name").unwrap().clone()),
                ("rank", raw.get("level").unwrap().clone()),
            ])
        });
    // `level >= 5` is pushed against the SQL column; the residual then sees
    // only the mapped shape, so it must project `who`/`rank`.
    let q = parse_string("who, rank from emp where level >= 5 order by rank desc").unwrap();
    let res = PlannedEngine::new(planner).run(&q, &[]).unwrap();
    assert_eq!(
        res,
        OqxResult::Collect(vec![
            obj(&[("who", s("Alice")), ("rank", num(7.0))]),
            obj(&[("who", s("Bob")), ("rank", num(5.0))]),
        ])
    );
}

#[test]
fn try_plan_surfaces_sql_errors_and_plan_panics_with_them() {
    let db = make_db();
    // `salary` is declared but does not exist in the table.
    let planner = SqliteTable::new(&db, "emp", &["salary"]);
    let q = parse_string("name from emp where salary > 1").unwrap();
    let err = planner.try_plan(&q, &[]).unwrap_err();
    assert!(err.to_string().contains("salary"), "{err}");
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| planner.plan(&q, &[])));
    let msg = panicked.unwrap_err();
    let msg = msg.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(msg.contains("oqx sqlite adapter"), "{msg}");
    assert!(
        msg.contains("SELECT * FROM \"emp\" WHERE (\"emp\".\"salary\" > ?)"),
        "{msg}"
    );

    // Declared columns that exist work fine on the same planner shape.
    let ok = SqliteTable::new(&db, "emp", &["level"]);
    assert_eq!(ok.try_plan(&q, &[]).unwrap().unwrap().rows.len(), 4);
}

#[test]
fn accessors_and_debug() {
    let db = make_db();
    let planner = planner(&db).json_columns(&["name"]);
    assert_eq!(planner.table(), "emp");
    assert!(planner.is_column("dept"));
    assert!(!planner.is_column("$value"));
    let dbg = format!("{planner:?}");
    assert!(dbg.contains("SqliteTable"), "{dbg}");
    assert!(dbg.contains("\"emp\""), "{dbg}");
}
