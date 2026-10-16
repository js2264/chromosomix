/**
 * dtype handling, in one place.
 *
 * `metacooler.schema.CORE_COLUMN_KINDS` expresses every on-disk requirement as
 * numpy *kind* letters (`"iu"`, `"iuf"`, `"SOU"`) rather than exact dtypes,
 * because a legitimately written file may hold `length` as int32 or int64 and
 * `name` as fixed-length bytes or a vlen str. This module is the bridge from
 * the dtype strings h5wasm emits to those letters, so the acceptance gates can
 * be written against the Python constants verbatim.
 */

import { MetaCoolerFormatError } from '../errors'

/** numpy dtype-kind letters this reader can produce or accept. */
export type DtypeKind = 'i' | 'u' | 'f' | 'S' | 'O' | 'U' | 'b'

// h5wasm builds its dtype strings in `metadata_to_dtype`: a byte-order char
// (`<` or `>`) plus a struct-module format letter sized by the datatype
//   1→b  2→h  4→i  8→q   (upper-cased when unsigned)
//   2→e  4→f  8→d        (floats)
// and, for strings, `A<n>` when the datatype's character set is ASCII or
// `S<n>` when it is UTF-8, with the length omitted entirely for vlen strings.
// numpy's own spellings (`<i4`, `|S25`, `<U10`, `|b1`, `|O`) are accepted too,
// so a dtype quoted from a Python traceback can be passed straight in.
const SIGNED_INT_LETTERS = 'bhilnpq'
const UNSIGNED_INT_LETTERS = 'BHILNPQu'
const FLOAT_LETTERS = 'defg'

/**
 * Map a dtype string onto its numpy kind letter.
 *
 * The one genuinely ambiguous letter is `b`: h5wasm writes `<b` for int8,
 * numpy writes `|b1` for bool. They are told apart by the byte-order character
 * — h5wasm always emits `<` or `>` for a numeric type and never `|`, which is
 * the marker numpy uses for single-byte types.
 *
 * @throws MetaCoolerFormatError if the dtype is not a scalar numeric/string
 *   type — compound, reference and enum datatypes surface here as `'unknown'`
 *   or `'Reference'` and have no numpy kind.
 */
export function dtypeKind(dtype: string): DtypeKind {
  const text = dtype.trim()
  const bad = (): never => {
    throw new MetaCoolerFormatError(
      `cannot interpret the HDF5 dtype ${JSON.stringify(dtype)} as a numpy kind`,
      { dtype },
    )
  }
  if (text === '') bad()

  const byteOrder = '<>|='.includes(text[0]) ? text[0] : ''
  const body = byteOrder === '' ? text : text.slice(1)
  if (body === '') bad()

  const letter = body[0]
  const width = body.slice(1)
  // `A25` / `S25` / `<i4` all end in digits; anything else in the tail (as in
  // `Reference`, `RegionReference`, `unknown`) is not a scalar dtype.
  if (width !== '' && !/^\d+$/.test(width)) bad()

  switch (letter) {
    case 'A':
    case 'S':
      // A bare `A`/`S` is h5wasm's vlen string, which h5py/numpy surface as an
      // object column — kind `O`, exactly what CORE_COLUMN_KINDS permits.
      return width === '' ? 'O' : 'S'
    case 'U':
      return 'U'
    case 'O':
      return 'O'
    case '?':
      return 'b'
    case 'b':
      return byteOrder === '|' ? 'b' : 'i'
    default:
      if (SIGNED_INT_LETTERS.includes(letter)) return 'i'
      if (UNSIGNED_INT_LETTERS.includes(letter)) return 'u'
      if (FLOAT_LETTERS.includes(letter)) return 'f'
      return bad()
  }
}

/**
 * Which of a 64-bit integer's two 32-bit words holds its low half: the first
 * on a little-endian machine — every one this runs on — and the second
 * otherwise. Asked of the machine once rather than assumed, because a typed
 * array's byte order is the platform's.
 */
const LOW_WORD = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0 : 1

/**
 * Narrow any numeric array h5wasm can hand back to `Float64Array`.
 *
 * int64 columns — `bin1_id`, `bin2_id` and all three offset arrays — arrive as
 * `BigInt64Array`, and BigInt does not mix with Number: `bigint + number`
 * throws a TypeError at *runtime*, not at compile time. Narrowing once, here,
 * is what makes that class of bug unreachable downstream (spec §6.2). Bin and
 * pixel indices are far below 2^53, so the conversion is exact.
 *
 * **Read as two 32-bit words, never as a BigInt.** `Number(x[i])` makes a
 * BigInt of every element before converting it, which on a column of tens of
 * millions was a third of the cost of reading it, and a BigInt of garbage for
 * every value. The high word times 2³² plus the low one is the same number:
 * exact below 2^53, and above it one rounding of the exact sum, which is the
 * rounding `Number` makes.
 */
export function toNumberArray(
  x: ArrayLike<number> | BigInt64Array | BigUint64Array,
): Float64Array {
  const out = new Float64Array(x.length)
  if (x instanceof BigInt64Array || x instanceof BigUint64Array) {
    const n = x.length
    const low = new Uint32Array(x.buffer, x.byteOffset, n * 2)
    const high = x instanceof BigInt64Array ? new Int32Array(x.buffer, x.byteOffset, n * 2) : low
    const lo = LOW_WORD
    const hi = 1 - LOW_WORD
    for (let i = 0; i < n; i++) out[i] = high[2 * i + hi] * 4294967296 + low[2 * i + lo]
    return out
  }
  out.set(x as ArrayLike<number>)
  return out
}

/**
 * The low 32 bits of each element of a 64-bit integer array, as `Int32` —
 * exactly what `ToInt32(Number(x))` gives, without making a BigInt per element.
 *
 * For index columns, `pixels/bin2_id` above all, which are int64 on disk and
 * array indices in use: every guard here keeps a bin id far below 2^31, so the
 * low word *is* the value.
 */
export function lowWords(x: BigInt64Array | BigUint64Array): Int32Array {
  const n = x.length
  const words = new Int32Array(x.buffer, x.byteOffset, n * 2)
  const out = new Int32Array(n)
  const lo = LOW_WORD
  for (let i = 0; i < n; i++) out[i] = words[2 * i + lo]
  return out
}

/**
 * Assert that a dataset's dtype has one of `allowed`'s numpy kinds.
 *
 * The message mirrors `metacooler.schema._core_dtype_problems` so the browser
 * and `metacooler check` describe the same file the same way.
 *
 * @param path Dataset path as it appears in the file, e.g. `genomes/length`.
 * @param dtype The dtype string as reported by the HDF5 layer.
 * @param allowed Kind letters, as in `CORE_COLUMN_KINDS` — e.g. `'iuf'`.
 */
export function assertKind(path: string, dtype: string, allowed: string): void {
  const kind = dtypeKind(dtype)
  if (allowed.includes(kind)) return
  const kinds = [...allowed].map((k) => `'${k}'`).join(', ')
  throw new MetaCoolerFormatError(
    `/${path} is ${dtype} (kind '${kind}'); expected one of the kinds [${kinds}]`,
    { path, dtype, kind, allowed },
  )
}
