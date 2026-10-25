//! The `cosine` SQL scalar (`spec/search` §3): registered on every connection
//! the semantic provider attaches to, so a query can score a stored vector
//! blob against a query vector in SQL.

use rusqlite::Connection;
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::ValueRef;

use crate::error::Result;

/// Cosine similarity of two little-endian float32 vector blobs
/// (`spec/search` §3, the reference's `cosineFloat32`): products and sums in
/// f64 over the shorter length (each blob floored to a multiple of 4 bytes);
/// `0.0` when either norm is zero.
#[must_use]
pub fn cosine_bytes(a: &[u8], b: &[u8]) -> f64 {
    omgbase_search::cosine_bytes(a, b)
}

fn cosine_udf(ctx: &Context<'_>) -> rusqlite::Result<Option<f64>> {
    let blob = |i: usize| -> rusqlite::Result<Option<&[u8]>> {
        match ctx.get_raw(i) {
            ValueRef::Null => Ok(None),
            ValueRef::Blob(b) => Ok(Some(b)),
            other => Err(rusqlite::Error::InvalidFunctionParameterType(
                i,
                other.data_type(),
            )),
        }
    };
    match (blob(0)?, blob(1)?) {
        (Some(a), Some(b)) => Ok(Some(cosine_bytes(a, b))),
        _ => Ok(None),
    }
}

/// Register `cosine(a, b)` on `conn` (deterministic, UTF-8).
pub fn register(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "cosine",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        cosine_udf,
    )?;
    Ok(())
}
