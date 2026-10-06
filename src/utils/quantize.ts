/**
 * Int8 quantization kernel — 4× denser vectors, tiny error, pure math.
 *
 * All palace embeddings are L2-unit-normalized (normalizeInPlace at every
 * provider), so every coordinate lives in [-1, 1] — no per-space scale
 * vector needed. Quantization maps to int8 (×127, round, clamp), cutting
 * storage from 4 bytes/dim to 1 (−75% on the embedding column) and
 * letting the SQL cosine run as pure integer arithmetic.
 *
 * Error behavior: the naive worst case is dominated by the LINEAR term
 * |Σ vᵢδᵢ| ≤ √d/254 (each rounding error δᵢ ≤ 1/254 can align with the
 * coordinate sign), which for large d is far above anything observed.
 * In practice the per-coordinate rounding errors behave like independent
 * zero-mean noise and cancel in the dot product: measured maximum cosine
 * error on L2-normalized inputs is < 0.005 for d ≤ 1024, asserted in
 * test/quantize.test.ts. That measurement — not a worst-case bound — is
 * the contract.
 */

import { cosine } from './embedding.js';

export const INT8_SCALE = 127;

/** Quantize a unit-normalized vector to int8 (values in [-127, 127]). */
export function quantizeToInt8(v: Float32Array): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === undefined) continue; // i < v.length
    const scaled = Math.round(x * INT8_SCALE);
    q[i] = Math.max(-INT8_SCALE, Math.min(INT8_SCALE, scaled));
  }
  return q;
}

/** Dequantize int8 back to float32 (for kernels that need real vectors). */
export function dequantizeToFloat32(q: Int8Array): Float32Array {
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) {
    const x = q[i];
    if (x !== undefined) v[i] = x / INT8_SCALE;
  }
  return v;
}

/**
 * Integer cosine on two int8 vectors — the SQL pushdown hot path.
 * dot = Σ a·b (integer); norm = Σ a² (integer); cosine = dot / √(na·nb).
 */
export function int8Cosine(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) continue; // i < a.length = b.length
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return Number.isFinite(denom) && denom > 0 ? dot / denom : 0;
}

/** Maximum absolute cosine error between float and int8 paths. */
export function quantizationError(
  originals: Float32Array[],
  query: Float32Array,
): number {
  const q8 = quantizeToInt8(query);
  let maxErr = 0;
  for (const v of originals) {
    const floatCos = cosine(query, v);
    const intCos = int8Cosine(q8, quantizeToInt8(v));
    maxErr = Math.max(maxErr, Math.abs(floatCos - intCos));
  }
  return maxErr;
}

/** Bytes-per-dim comparison for storage-savings reporting. */
export const FLOAT32_BYTES_PER_DIM = 4;
export const INT8_BYTES_PER_DIM = 1;
export const COMPRESSION_RATIO = FLOAT32_BYTES_PER_DIM / INT8_BYTES_PER_DIM;
