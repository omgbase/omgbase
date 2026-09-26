//! Vectors and similarity (`spec/search` §3): cosine over float32 vectors and
//! over their little-endian blobs.

/// §3: with `n = min(|a|, |b|)`, accumulate `dot`, `‖a‖²`, `‖b‖²` over `i <
/// n` left to right in f64 from the float32 values; `0` when either norm is
/// zero; else `dot / (√‖a‖² × √‖b‖²)`.
#[must_use]
pub fn cosine_f32(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0f64, 0.0f64, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (f64::from(*x), f64::from(*y));
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// A stored blob as float32 values (little-endian); the length is floored to
/// a multiple of 4.
#[must_use]
pub fn blob_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// A float32 vector as the little-endian blob the store keeps (§2.3).
#[must_use]
pub fn f32_to_blob(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// [`cosine_f32`] over two blobs (the body of the SQL `cosine` function;
/// the `NULL` rule is the caller's).
#[must_use]
pub fn cosine_bytes(a: &[u8], b: &[u8]) -> f64 {
    cosine_f32(&blob_to_f32(a), &blob_to_f32(b))
}

/// f64 values (JSON numbers from a provider) as float32, the stored precision.
#[must_use]
pub fn to_f32(values: &[f64]) -> Vec<f32> {
    values.iter().map(|v| *v as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_basics() {
        assert_eq!(cosine_f32(&[1.0, 0.0], &[1.0, 0.0]), 1.0);
        assert_eq!(cosine_f32(&[1.0, 0.0], &[0.0, 1.0]), 0.0);
        assert_eq!(cosine_f32(&[1.0, 0.0], &[-1.0, 0.0]), -1.0);
        assert_eq!(cosine_f32(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
        assert_eq!(cosine_f32(&[], &[]), 0.0);
        // The shorter length wins; the third component of `b` is ignored.
        assert_eq!(cosine_f32(&[1.0, 0.0], &[1.0, 0.0, 5.0]), 1.0);
    }

    #[test]
    fn f64_accumulation_left_to_right() {
        let a = [0.1f32, 0.2, 0.3];
        let b = [0.3f32, 0.2, 0.1];
        let (mut dot, mut na, mut nb) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..3 {
            dot += f64::from(a[i]) * f64::from(b[i]);
            na += f64::from(a[i]) * f64::from(a[i]);
            nb += f64::from(b[i]) * f64::from(b[i]);
        }
        assert_eq!(cosine_f32(&a, &b), dot / (na.sqrt() * nb.sqrt()));
    }

    #[test]
    fn blobs_round_trip_and_floor() {
        let v = [1.5f32, -2.25, 0.0];
        let blob = f32_to_blob(&v);
        assert_eq!(blob.len(), 12);
        assert_eq!(blob_to_f32(&blob), v);
        // Trailing bytes short of a float are ignored.
        let mut ragged = blob.clone();
        ragged.extend_from_slice(&[1, 2, 3]);
        assert_eq!(blob_to_f32(&ragged), v);
        assert!((cosine_bytes(&blob, &ragged) - 1.0).abs() < 1e-12);
        assert_eq!(cosine_bytes(&[], &blob), 0.0);
    }
}
