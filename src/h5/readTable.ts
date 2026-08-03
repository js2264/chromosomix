/**
 * Dataset decoding — the only code that touches raw HDF5 bytes.
 *
 * Two decisions here are load-bearing and both come from spec §6.2.
 *
 * **Strings are decoded from raw bytes, not from h5wasm's `slice()`.**
 * metacooler writes name columns as fixed-length `S<n>` sized by the *UTF-8
 * encoded byte length* (`_str_to_hdf5`), precisely so multi-byte characters
 * survive. h5py stamps those datatypes with the ASCII character set, and
 * h5wasm honours that literally: its `process_data` decodes them with
 * `TextDecoder('ascii')`, which is an alias for windows-1252, so `café` comes
 * back as `cafÃ©`. Every byte is still there — only the decoding is wrong — so
 * this module reads the bytes itself and runs them through
 * `TextDecoder('utf-8')`, matching `schema.read_table`'s
 * `np.char.decode(data, "utf-8")` exactly.
 *
 * **Numbers are narrowed to `Float64Array` on read.** int64 columns arrive as
 * `BigInt64Array`, and BigInt does not mix with Number at runtime.
 */

import type { Column, Table } from '../types'
import { MetaCoolerFormatError } from '../errors'
import type { H5Module, H5wasmDataset, H5wasmFile, H5wasmGroup, Metadata } from './bootstrap'
import { toNumberArray } from './typed'

const UTF8 = new TextDecoder('utf-8')

/** The HDF5 datatype classes this reader knows how to decode. */
export type H5Class = 'string' | 'number' | 'other'

/**
 * Classify a dataset by its HDF5 datatype *class* rather than by its dtype
 * string.
 *
 * Enumerations are the reason: h5py stores a pandas `bool` column as an HDF5
 * enum, and h5wasm's `metadata_to_dtype` has no enum branch, so its dtype
 * string is the literal `'unknown'`. Reading such a column as its base integer
 * is both possible and correct, and an optional metadata column must never be
 * able to make a whole table unreadable (spec §5.1).
 */
export function classify(h5: H5Module, md: Metadata): H5Class {
  const cls = h5.Module.H5T_class_t
  if (md.type === cls.H5T_STRING.value) return 'string'
  if (md.type === cls.H5T_INTEGER.value) return 'number'
  if (md.type === cls.H5T_FLOAT.value) return 'number'
  if (md.type === cls.H5T_ENUM.value) return 'number'
  return 'other'
}

/**
 * Copy a half-open row range of a 1-D dataset out of the wasm heap, undecoded.
 *
 * Mirrors `Dataset.slice()` but stops before `process_data`, which is where
 * h5wasm's ASCII string decode happens. The returned array is a copy: the wasm
 * heap can be detached by a later allocation, so a view would be a use-after-free
 * waiting to happen.
 */
export function readRawBytes(
  h5: H5Module,
  file: H5wasmFile,
  ds: H5wasmDataset,
  lo: number,
  hi: number,
): Uint8Array {
  const n = hi - lo
  if (n <= 0) return new Uint8Array(0)
  const md = ds.metadata
  const nbytes = md.size * n
  const ptr = malloc(h5, nbytes)
  try {
    h5.Module.get_dataset_data(
      file.file_id,
      ds.path,
      [BigInt(n)],
      [BigInt(lo)],
      [1n],
      BigInt(ptr),
    )
    return h5.Module.HEAPU8.slice(ptr, ptr + nbytes)
  } finally {
    h5.Module._free(ptr)
  }
}

/**
 * Split a fixed-length string buffer into UTF-8 decoded strings.
 *
 * Each record occupies exactly `itemSize` bytes and is NUL-padded on the
 * right. Truncating at the first NUL is what numpy does for an `S` dtype, so
 * the result matches the Python reader byte for byte.
 */
export function decodeFixedStrings(bytes: Uint8Array, itemSize: number, count: number): string[] {
  const out: string[] = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    let item = bytes.subarray(i * itemSize, (i + 1) * itemSize)
    const nul = item.indexOf(0)
    if (nul > -1) item = item.subarray(0, nul)
    out[i] = UTF8.decode(item)
  }
  return out
}

/**
 * Read a half-open row range of a string dataset.
 *
 * Handles both storage forms `CORE_COLUMN_KINDS` permits: fixed-length `S<n>`
 * (kind `S`, what `metacooler create` writes) and variable-length strings
 * (kind `O`, what a file routed through `create cool` may carry). Vlen data is
 * a heap of pointers, so the borrowed strings are materialised before the
 * dataspace is reclaimed.
 */
export function readStringSlice(
  h5: H5Module,
  file: H5wasmFile,
  ds: H5wasmDataset,
  lo: number,
  hi: number,
): string[] {
  const n = hi - lo
  if (n <= 0) return []
  const md = ds.metadata
  if (!md.vlen) {
    return decodeFixedStrings(readRawBytes(h5, file, ds, lo, hi), md.size, n)
  }

  const nbytes = md.size * n
  const ptr = malloc(h5, nbytes)
  try {
    h5.Module.get_dataset_data(
      file.file_id,
      ds.path,
      [BigInt(n)],
      [BigInt(lo)],
      [1n],
      BigInt(ptr),
    )
    // Each element is a pointer into the wasm heap; decode with UTF8ToString
    // regardless of the datatype's declared character set, for the same reason
    // fixed-length columns are decoded as UTF-8 above.
    const pointers = new Uint32Array(h5.Module.HEAPU8.slice(ptr, ptr + nbytes).buffer)
    const out: string[] = new Array<string>(n)
    for (let i = 0; i < n; i++) out[i] = h5.Module.UTF8ToString(pointers[i])
    return out
  } finally {
    // Count-sized reclaim: the hyperslab read filled only `n` hvl_t structs, so
    // reclaiming the dataset's full extent would free past the buffer end.
    h5.Module.reclaim_vlen_memory_count(file.file_id, ds.path, '', BigInt(ptr), [BigInt(n)])
    h5.Module._free(ptr)
  }
}

/**
 * Read a half-open row range of a numeric dataset, narrowed to `Float64Array`.
 *
 * Enum datasets (h5py booleans) are read through their base integer type, so
 * `false`/`true` arrive as `0`/`1`.
 */
export function readNumericSlice(ds: H5wasmDataset, lo: number, hi: number): Float64Array {
  const n = hi - lo
  if (n <= 0) return new Float64Array(0)
  const raw = ds.slice([[lo, hi]])
  // Already the target type, and already a buffer h5wasm minted for this call
  // and will not touch again — so it is ours to hand on. Copying it into an
  // identical array was 8 B per element of pure duplication, and both copies
  // were live while it happened: on a float-count file that is the single
  // largest avoidable allocation in the read path.
  if (raw instanceof Float64Array) return raw
  if (raw instanceof BigInt64Array || raw instanceof BigUint64Array) return toNumberArray(raw)
  if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
    return toNumberArray(raw as unknown as ArrayLike<number>)
  }
  throw new MetaCoolerFormatError(
    `/${ds.path.replace(/^\//, '')} did not read back as a numeric array`,
    { path: ds.path },
  )
}

/**
 * Read a half-open row range of an integer column straight into `Int32Array`.
 *
 * For `pixels/bin1_id` and `pixels/bin2_id` — int64 on disk, and consumed as
 * array indices. {@link readNumericSlice} would widen them to `Float64Array`
 * and the caller would then narrow that to `Int32Array`, so a bin id passed
 * through three buffers of 8, 8 and 4 bytes to arrive somewhere 4 bytes wide.
 * This is the same single pass over the BigInt64 data, writing the final width
 * directly: 8 B per pixel of live memory that no longer exists, per column.
 *
 * Bin ids are bounded by the file's bin count, which every guard here keeps far
 * below 2^31, so the narrowing is exact.
 */
export function readInt32Slice(ds: H5wasmDataset, lo: number, hi: number): Int32Array {
  const n = hi - lo
  if (n <= 0) return new Int32Array(0)
  const raw = ds.slice([[lo, hi]])
  if (raw instanceof Int32Array) return raw
  if (raw instanceof BigInt64Array || raw instanceof BigUint64Array) {
    const out = new Int32Array(n)
    for (let i = 0; i < n; i++) out[i] = Number(raw[i])
    return out
  }
  if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
    const out = new Int32Array(n)
    // `set` on an integer target applies ToInt32, which is exact for the
    // integral values an index column holds.
    out.set(raw as unknown as ArrayLike<number>)
    return out
  }
  throw new MetaCoolerFormatError(
    `/${ds.path.replace(/^\//, '')} did not read back as a numeric array`,
    { path: ds.path },
  )
}

/**
 * Assemble a {@link Table} from already-decoded columns.
 *
 * Exported so the synthetic `/genomes` table a plain cooler needs (spec §9)
 * can be built without inventing a second Table shape.
 */
export function makeTable(length: number, columns: string[], data: Record<string, Column>): Table {
  return {
    length,
    columns,
    data,
    get(column: string, row: number): string | number | undefined {
      const col = data[column]
      if (col === undefined || row < 0 || row >= length) return undefined
      const value = (col as ArrayLike<unknown>)[row]
      if (typeof value === 'bigint') return Number(value)
      if (typeof value === 'string' || typeof value === 'number') return value
      return undefined
    },
    strings(column: string): string[] {
      const col = data[column]
      if (col === undefined) {
        throw new MetaCoolerFormatError(`no such column: ${column}`, { column })
      }
      if (Array.isArray(col) && (col.length === 0 || typeof col[0] === 'string')) {
        return col as string[]
      }
      throw new MetaCoolerFormatError(`column ${column} is not a string column`, { column })
    },
    numbers(column: string): number[] {
      const col = data[column]
      if (col === undefined) {
        throw new MetaCoolerFormatError(`no such column: ${column}`, { column })
      }
      if (col instanceof BigInt64Array) return Array.from(col, Number)
      if (Array.isArray(col) && col.length > 0 && typeof col[0] === 'string') {
        throw new MetaCoolerFormatError(`column ${column} is not a numeric column`, { column })
      }
      return Array.from(col as ArrayLike<number>)
    },
  }
}

/**
 * Read every column of a table group into a {@link Table}.
 *
 * The column *set* is discovered from the group and kept in file order, never
 * hard-coded, so the optional `/genomes` metadata columns a creator joined in
 * — completeness, contamination, taxonomy, anything — flow through to the UI
 * untouched (spec §5.1).
 *
 * A column whose datatype is neither numeric nor text (a compound, a reference)
 * is skipped rather than fatal: it can only ever be optional metadata, and a
 * file must not become unopenable because one extra column is exotic.
 */
export function readTableGroup(
  h5: H5Module,
  file: H5wasmFile,
  group: H5wasmGroup,
  label: string,
  lo?: number,
  hi?: number,
  columns?: readonly string[],
): Table {
  const datasets: { name: string; ds: H5wasmDataset; md: Metadata; length: number }[] = []
  for (const name of group.keys()) {
    const entity = group.get(name)
    if (!(entity instanceof h5.Dataset)) continue
    const md = entity.metadata
    const shape = md.shape
    if (!shape || shape.length !== 1) continue
    datasets.push({ name, ds: entity, md, length: shape[0] })
  }

  const lengths = new Set(datasets.map((d) => d.length))
  if (lengths.size > 1) {
    // Same failure and the same wording as `schema._table_length`: a truncated
    // column silently mis-pairs values with records.
    const detail = datasets
      .map((d) => `${d.name}=${d.length}`)
      .sort()
      .join(', ')
    throw new MetaCoolerFormatError(
      `/${label} columns have unequal lengths (${detail}); every column of a table ` +
        'must have one row per record',
      { table: label },
    )
  }

  const total = datasets.length === 0 ? 0 : datasets[0].length
  const start = clamp(lo ?? 0, 0, total)
  const stop = clamp(hi ?? total, start, total)

  // The *lengths* above are metadata and cost no read, so the equal-length
  // check runs over the whole group whatever is asked for. Only the decode
  // below is narrowed — a column the caller did not ask for is simply absent
  // from the result, which is exactly how a column that is not in the file
  // reads, so a required-column check still fires for a file that lacks one.
  const wanted = columns === undefined ? null : new Set(columns)
  const names: string[] = []
  const data: Record<string, Column> = {}
  for (const { name, ds, md } of datasets) {
    if (wanted !== null && !wanted.has(name)) continue
    switch (classify(h5, md)) {
      case 'string':
        names.push(name)
        data[name] = readStringSlice(h5, file, ds, start, stop)
        break
      case 'number':
        names.push(name)
        data[name] = readNumericSlice(ds, start, stop)
        break
      case 'other':
        break
    }
  }
  return makeTable(stop - start, names, data)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(Math.trunc(value), lo), hi)
}

function malloc(h5: H5Module, nbytes: number): number {
  if (nbytes > h5.Module.MAXIMUM_MEMORY) {
    throw new MetaCoolerFormatError(
      `a ${nbytes} byte read exceeds the wasm heap limit of ${h5.Module.MAXIMUM_MEMORY} bytes`,
      { nbytes, limit: h5.Module.MAXIMUM_MEMORY },
    )
  }
  const ptr = h5.Module._malloc(nbytes)
  if (ptr === 0) {
    throw new MetaCoolerFormatError(`allocation of ${nbytes} bytes in the wasm heap failed`, {
      nbytes,
    })
  }
  return ptr
}
