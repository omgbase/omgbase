//! Pushdown analysis helpers shared by planner adapters (tier 3). Port of
//! `packages/oqx/src/plan.ts`.
//!
//! The unit of pushdown here is the top-level `where` conjunction: an adapter
//! classifies each AND-conjunct as pushable (translatable into its native
//! query) or residual (must be evaluated in-memory afterward). Whatever it
//! pushes reduces the rows it produces; the residual [`Query`] re-runs over
//! those rows in the in-memory engine, which preserves correctness even for
//! partial pushdown.
//!
//! Deliberately conservative: only positive scalar leaves are pushable.
//! Consumer ops (exists/count/collect), negation, and disjunction stay
//! residual — an adapter that wants to push those can special-case them itself.
//!
//! Because a bare identifier resolves against the current row ONLY (it never
//! climbs to an enclosing scope or a named root), an [`Expr::Ident`] in a
//! top-level `where` is unambiguously a column of the scanned rows and is safe
//! to push. An [`Expr::Outer`] (`^name`) reference is not a row column and
//! stays residual, and so is the `$value` intrinsic (the row itself, not one of
//! its columns) — adapters gate idents on their known column set, which never
//! includes it.

use crate::ast::{BinaryOp, Expr, Query, Where};
use crate::value::Value;

/// The synthetic root name the residual query scans — the rows a plan produced.
pub const ROWS_ROOT: &str = "__oqx_rows__";

/// Split a top-level where into pushable scalar conjuncts and a residual tree.
///
/// Only the direct parts of a top-level [`Where::And`] (or the whole clause
/// when it is not an `and`) are considered; a part is pushed iff it is a
/// [`Where::Scalar`] whose expression `can_push` accepts. Everything else is
/// kept, in order, as the residual: `None` when nothing remains, the single
/// remaining part on its own, or an `and` of the rest.
pub fn partition_pushable(
    r#where: Option<&Where>,
    can_push: impl Fn(&Expr) -> bool,
) -> (Vec<Expr>, Option<Where>) {
    let Some(clause) = r#where else {
        return (Vec::new(), None);
    };
    let parts: Vec<&Where> = match clause {
        Where::And { parts } => parts.iter().collect(),
        other => vec![other],
    };
    let mut pushed = Vec::new();
    let mut rest: Vec<Where> = Vec::new();
    for part in parts {
        match part {
            Where::Scalar { expr } if can_push(expr) => pushed.push(expr.clone()),
            _ => rest.push(part.clone()),
        }
    }
    let residual = match rest.len() {
        0 => None,
        1 => rest.pop(),
        _ => Some(Where::And { parts: rest }),
    };
    (pushed, residual)
}

/// Rebuild a query to run in-memory over a plan's produced rows: scan the rows
/// root, drop pushed top-level `from`/predicates, keep projection/order/consumer.
pub fn residual_query(query: &Query, residual_where: Option<Where>) -> Query {
    Query {
        source: Expr::Ident {
            name: ROWS_ROOT.to_owned(),
        },
        from: Vec::new(),
        r#where: residual_where,
        ..query.clone()
    }
}

/// A literal or binding — a value known without a row context.
pub fn is_const(e: &Expr) -> bool {
    matches!(e, Expr::Lit(_) | Expr::Binding { .. })
}

/// Evaluate a constant expression against the query bindings. `None` when
/// `e` is not a constant (the reference throws here; a planner only ever calls
/// this on an expression [`is_const`] accepted). A binding index past the end
/// of `params` reads as [`Value::Undefined`], as `params[i]` does in the TS.
pub fn const_value(e: &Expr, params: &[Value]) -> Option<Value> {
    match e {
        Expr::Lit(v) => Some(v.clone()),
        Expr::Binding { index } => Some(params.get(*index).cloned().unwrap_or(Value::Undefined)),
        _ => None,
    }
}

/// The two sides of a recognized `field == const` predicate (see [`as_equality`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Equality<'a> {
    /// The bare identifier — a column of the current row (see the module note).
    pub field: &'a str,
    /// The constant side: a literal or a binding, for [`const_value`].
    pub value: &'a Expr,
}

/// Recognize `field == const` / `const == field` (a bare identifier is always a
/// column of the current row — see the module note).
pub fn as_equality(e: &Expr) -> Option<Equality<'_>> {
    let Expr::Binary {
        op: BinaryOp::Eq,
        left,
        right,
    } = e
    else {
        return None;
    };
    if let Expr::Ident { name } = &**left {
        if is_const(right) {
            return Some(Equality {
                field: name,
                value: right,
            });
        }
    }
    if let Expr::Ident { name } = &**right {
        if is_const(left) {
            return Some(Equality {
                field: name,
                value: left,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Consumer;
    use crate::parser::{parse_string, parse_template};

    fn parse(src: &str) -> Query {
        parse_string(src).expect("test query parses")
    }

    /// Accept any `ident == const` whose ident is in `cols`.
    fn indexed_on<'a>(cols: &'a [&'a str]) -> impl Fn(&Expr) -> bool + 'a {
        move |e| as_equality(e).is_some_and(|eq| cols.contains(&eq.field))
    }

    fn scalar_text(w: &Where) -> String {
        match w {
            Where::Scalar { expr } => format!("{expr:?}"),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn no_where_pushes_nothing() {
        let q = parse("name from emp");
        let (pushed, residual) = partition_pushable(q.r#where.as_ref(), |_| true);
        assert!(pushed.is_empty());
        assert_eq!(residual, None);
    }

    #[test]
    fn a_lone_scalar_is_fully_pushed_when_accepted() {
        let q = parse("name from emp where dept == \"eng\"");
        let (pushed, residual) = partition_pushable(q.r#where.as_ref(), indexed_on(&["dept"]));
        assert_eq!(pushed.len(), 1);
        assert_eq!(residual, None);
        let eq = as_equality(&pushed[0]).expect("equality");
        assert_eq!(eq.field, "dept");
        assert_eq!(const_value(eq.value, &[]), Some(Value::from("eng")));
    }

    #[test]
    fn a_lone_scalar_is_the_residual_when_declined() {
        let q = parse("name from emp where level >= 5");
        let (pushed, residual) = partition_pushable(q.r#where.as_ref(), indexed_on(&["dept"]));
        assert!(pushed.is_empty());
        assert_eq!(residual, q.r#where);
    }

    #[test]
    fn splits_a_top_level_and_into_pushed_and_residual() {
        let q = parse("name from emp where dept == \"eng\" && level >= 5 && \"NYC\" == city");
        let (pushed, residual) =
            partition_pushable(q.r#where.as_ref(), indexed_on(&["dept", "city"]));
        let fields: Vec<&str> = pushed
            .iter()
            .map(|e| as_equality(e).expect("equality").field)
            .collect();
        assert_eq!(fields, ["dept", "city"]);
        // One conjunct left over → it stands alone, not wrapped in an `and`.
        let residual = residual.expect("level >= 5 is residual");
        assert!(matches!(residual, Where::Scalar { .. }), "{residual:?}");
        assert!(scalar_text(&residual).contains("level"));
    }

    #[test]
    fn two_or_more_leftovers_stay_an_and_in_order() {
        let q = parse("name from emp where level >= 5 && dept == \"eng\" && city != \"SF\"");
        let (pushed, residual) = partition_pushable(q.r#where.as_ref(), indexed_on(&["dept"]));
        assert_eq!(pushed.len(), 1);
        match residual {
            Some(Where::And { parts }) => {
                assert_eq!(parts.len(), 2);
                assert!(scalar_text(&parts[0]).contains("level"));
                assert!(scalar_text(&parts[1]).contains("city"));
            }
            other => panic!("expected an and of two parts, got {other:?}"),
        }
    }

    #[test]
    fn or_not_and_consumer_ops_are_never_pushed() {
        let q = parse(
            "name from emp where (dept == \"eng\" || dept == \"sales\") && !(city == \"SF\") && reports exists { where level > 3 }",
        );
        let (pushed, residual) = partition_pushable(q.r#where.as_ref(), |_| true);
        assert!(pushed.is_empty(), "{pushed:?}");
        assert_eq!(residual, q.r#where);
    }

    #[test]
    fn an_or_at_the_top_is_the_whole_residual() {
        let q = parse("name from emp where dept == \"eng\" || dept == \"sales\"");
        let (pushed, residual) = partition_pushable(q.r#where.as_ref(), |_| true);
        assert!(pushed.is_empty());
        assert!(matches!(residual, Some(Where::Or { .. })));
    }

    #[test]
    fn outer_refs_and_value_are_not_equalities_a_column_planner_accepts() {
        // `^dept == "eng"` is not `ident == const`: as_equality declines it.
        let q = parse("name from emp where ^dept == \"eng\"");
        let Some(Where::Scalar { expr }) = &q.r#where else {
            panic!("scalar where expected: {:?}", q.r#where);
        };
        assert_eq!(as_equality(expr), None);

        // `$value == "x"` IS syntactically an equality on the ident `$value`;
        // the adapter's column gate is what keeps it residual.
        let q = parse("name from emp where $value == \"x\"");
        let Some(Where::Scalar { expr }) = &q.r#where else {
            panic!("scalar where expected: {:?}", q.r#where);
        };
        assert_eq!(as_equality(expr).map(|eq| eq.field), Some("$value"));
        let (pushed, _) = partition_pushable(q.r#where.as_ref(), indexed_on(&["dept"]));
        assert!(pushed.is_empty());
    }

    #[test]
    fn as_equality_recognizes_both_orientations_and_bindings_only() {
        let q = parse_template(&["name from emp where ", " == dept && level == 5 + 1"], 1)
            .expect("template parses");
        let Some(Where::And { parts }) = &q.r#where else {
            panic!("and expected: {:?}", q.r#where);
        };
        let Where::Scalar { expr: first } = &parts[0] else {
            panic!("scalar")
        };
        let eq = as_equality(first).expect("binding == ident is an equality");
        assert_eq!(eq.field, "dept");
        assert!(matches!(eq.value, Expr::Binding { index: 0 }));
        assert_eq!(
            const_value(eq.value, &[Value::from("eng")]),
            Some(Value::from("eng"))
        );
        assert_eq!(const_value(eq.value, &[]), Some(Value::Undefined));

        // `level == 5 + 1`: the RHS is computable but not a constant leaf.
        let Where::Scalar { expr: second } = &parts[1] else {
            panic!("scalar")
        };
        assert_eq!(as_equality(second), None);
        assert!(!is_const(second));
        assert_eq!(const_value(second, &[]), None);

        // `!=`, `<`, … are not equalities.
        let q = parse("name from emp where dept != \"eng\"");
        let Some(Where::Scalar { expr }) = &q.r#where else {
            panic!("scalar where expected")
        };
        assert_eq!(as_equality(expr), None);
    }

    #[test]
    fn residual_query_scans_the_rows_root_and_keeps_the_rest() {
        let mut q = parse(
            "name, dept from emp where dept == \"eng\" && level >= 5 order by name desc limit 2 offset 1",
        );
        // The parser admits one `from` (ADR-020); a re-projection is an AST-level
        // shape, so build it directly.
        q.from.push(Expr::Ident {
            name: "reports".to_owned(),
        });
        let (_, residual) = partition_pushable(q.r#where.as_ref(), indexed_on(&["dept"]));
        let r = residual_query(&q, residual.clone());
        assert_eq!(
            r.source,
            Expr::Ident {
                name: ROWS_ROOT.to_owned()
            }
        );
        assert!(
            r.from.is_empty(),
            "top-level `from` re-projections are dropped"
        );
        assert_eq!(r.r#where, residual);
        assert_eq!(r.select, q.select);
        assert_eq!(r.order_by, q.order_by);
        assert_eq!(r.consumer, Consumer::Collect);
        assert_eq!(r.limit, q.limit);
        assert_eq!(r.offset, q.offset);
        assert_eq!(r.distinct, q.distinct);
        assert_eq!(r.values, q.values);

        let none = residual_query(&q, None);
        assert_eq!(none.r#where, None);
    }
}
