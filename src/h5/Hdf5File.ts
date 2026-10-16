/**
 * The concrete {@link Hdf5Handle} over a {@link ByteSource}.
 *
 * A handle is *rooted at a group*, so a plain `.metacool` (`/`) and one entry
 * of an `.mmetacool` (`/entries/rep1`) are the same object with a different
 * prefix and no call site branches on which it is (spec §3.4, §3.5). Every
 * path a caller passes is resolved inside that root — a leading `/` is stripped
 * rather than escaping to the file root, so `has('/chroms')` on an mmetacool
 * entry asks about *that entry's* `chroms` and can never accidentally answer
 * about the collection.
 */

import type { AttrValue, Hdf5Handle } from './api'
import type { ByteSource, Table } from '../types'
import { MetaCoolerFormatError, ViewerError, truncateNames } from '../errors'
import type { H5Module, H5wasmDataset, H5wasmFile, Metadata } from './bootstrap'
import { getH5 } from './bootstrap'
import {
  classify,
  readInt32Slice,
  readNumericSlice,
  readStringSlice,
  readTableGroup,
  type HeapAccess,
} from './readTable'
import { orderEntries } from '../metacooler/detect'

const UTF8 = new TextDecoder('utf-8')

/**
 * Open an HDF5 file through a byte source and root it at a group.
 *
 * @param uri The `file` or `file::group` URI this handle represents. Carried
 *   only for error messages — the bytes come from `source`, the group from
 *   `group`, both already resolved by `parseUri`.
 * @param source Mounted on first call; the handle takes ownership and closes
 *   it in {@link Hdf5Handle.close}.
 * @param group HDF5 group path, `'/'` for a plain file.
 */
export async function openHdf5(
  uri: string,
  source: ByteSource,
  group: string,
): Promise<Hdf5Handle> {
  const h5 = await getH5()
  const mounted = await source.mount()

  let file: H5wasmFile
  try {
    file = new h5.File(mounted, 'r')
  } catch (cause) {
    source.close()
    throw new ViewerError(
      'not-hdf5',
      `${uri} could not be opened as an HDF5 file: ${describe(cause)}`,
      { uri, source: source.id },
    )
  }

  const root = normalise(group)
  try {
    if (root !== '/') {
      const node = file.get(root)
      if (node === null) {
        // Mirrors `schema.validate`'s message for a URI naming a group that is
        // not there, so a typo reads the same in the browser and the CLI.
        throw new ViewerError(
          'entry-not-found',
          `Group '${root}' not found in ${source.id}. ` +
            `Top-level keys: ${truncateNames(file.keys())}`,
          { uri, group: root, available: file.keys() },
        )
      }
      if (!(node instanceof h5.Group)) {
        throw new MetaCoolerFormatError(
          `'${root}' in ${source.id} is not an HDF5 group`,
          { uri, group: root },
          'entry-not-found',
        )
      }
    }
  } catch (err) {
    file.close()
    source.close()
    throw err
  }

  // Captured while the root is in hand; see `Hdf5Handle.rootEntries`.
  //
  // Two group names, one idea: an mmetacool keeps its maps under `/entries`
  // and an mcool keeps its resolutions under `/resolutions`. Both are ladders
  // of sibling coolers, and the picker that offers them does not care which
  // word the format chose.
  let rootEntries: string[] = []
  let rootEntryGroup = ''
  try {
    for (const group of ['entries', 'resolutions']) {
      // `get_type`, not `keys().includes(...)`: a listing of the root walks
      // every link in it, and a single-cell container has one per cell —
      // several thousand records scattered across the whole file (§12). Asking
      // whether *one* name exists is a lookup, and it is the same answer.
      if (file.get_type(`/${group}`) < 0) continue
      const node = file.get(group)
      if (!(node instanceof h5.Group)) continue
      rootEntries = orderEntries(node.keys())
      rootEntryGroup = group
      break
    }
  } catch {
    // A file with no readable entry group simply has no entries to pick.
  }

  return new Hdf5File(uri, root, h5, file, source, rootEntries, rootEntryGroup)
}

class Hdf5File implements Hdf5Handle {
  readonly uri: string
  readonly group: string
  readonly rootEntries: string[]
  readonly rootEntryGroup: string

  private readonly h5: H5Module
  private readonly file: H5wasmFile
  /** What a numeric column is read straight out of the wasm heap with (`readTable.heapSlice`). */
  private readonly heap: HeapAccess
  private readonly source: ByteSource
  private closed = false
  /** A view from {@link at}, which shares the mount and must not close it. */
  private readonly borrowed: boolean

  constructor(
    uri: string,
    group: string,
    h5: H5Module,
    file: H5wasmFile,
    source: ByteSource,
    rootEntries: string[] = [],
    rootEntryGroup = '',
    borrowed = false,
  ) {
    this.uri = uri
    this.group = group
    this.rootEntries = rootEntries
    this.rootEntryGroup = rootEntryGroup
    this.borrowed = borrowed
    this.h5 = h5
    this.file = file
    this.heap = { h5, file }
    this.source = source
  }

  attrs(): Record<string, AttrValue> {
    return this.attrsAt('')
  }

  attrsAt(path: string): Record<string, AttrValue> {
    const entity = this.entity(path)
    const hasAttrs = entity instanceof this.h5.Group || entity instanceof this.h5.Dataset
    if (entity === null || !hasAttrs) {
      throw new MetaCoolerFormatError(
        `${this.describe(path)} does not exist, or carries no attributes`,
        { uri: this.uri, path: this.resolve(path) },
      )
    }
    const out: Record<string, AttrValue> = {}
    for (const [name, attr] of Object.entries(entity.attrs)) {
      out[name] = this.decodeAttr(entity.path, name, attr.metadata, attr.json_value)
    }
    return out
  }

  has(path: string): boolean {
    this.assertOpen()
    // `get_type` returns -1 for a missing path and does so silently; `get()`
    // would build a wrapper object for the hit case that is then thrown away.
    return this.file.get_type(this.resolve(path)) >= 0
  }

  keys(path: string): string[] {
    const entity = this.entity(path)
    if (entity === null || !(entity instanceof this.h5.Group)) return []
    return entity.keys()
  }

  isSoftLink(path: string): boolean {
    // Guarded by `has`: `get_symbolic_link` on a missing path prints an HDF5
    // diagnostic block to stderr before returning null, which is noise the
    // caller never asked for.
    if (!this.has(path)) return false
    const target = this.file.get_link(this.resolve(path))
    return typeof target === 'string' && target.length > 0
  }

  datasetLength(path: string): number {
    const shape = this.dataset(path).metadata.shape
    return shape && shape.length > 0 ? shape[0] : 0
  }

  dtype(path: string): string {
    const raw = this.dataset(path).dtype
    if (typeof raw !== 'string') {
      throw new MetaCoolerFormatError(
        `${this.describe(path)} has a compound datatype, which this reader does not read`,
        { uri: this.uri, path: this.resolve(path) },
      )
    }
    return raw
  }

  readNumeric(path: string, lo?: number, hi?: number): Float64Array {
    const [ds, start, stop] = this.numericRange(path, lo, hi)
    return readNumericSlice(ds, start, stop, this.heap)
  }

  readInt32(path: string, lo?: number, hi?: number): Int32Array {
    const [ds, start, stop] = this.numericRange(path, lo, hi)
    return readInt32Slice(ds, start, stop, this.heap)
  }

  /** The shared preamble of the two numeric reads: classify, then clamp. */
  private numericRange(
    path: string,
    lo?: number,
    hi?: number,
  ): [H5wasmDataset, number, number] {
    const ds = this.dataset(path)
    if (classify(this.h5, ds.metadata) !== 'number') {
      throw new MetaCoolerFormatError(
        `${this.describe(path)} is ${String(ds.dtype)}, not a numeric dataset`,
        { uri: this.uri, path: this.resolve(path), dtype: String(ds.dtype) },
      )
    }
    const [start, stop] = this.range(ds, lo, hi)
    return [ds, start, stop]
  }

  readStrings(path: string, lo?: number, hi?: number): string[] {
    const ds = this.dataset(path)
    const md = ds.metadata
    if (classify(this.h5, md) !== 'string') {
      throw new MetaCoolerFormatError(
        `${this.describe(path)} is ${String(ds.dtype)}, not a string dataset`,
        { uri: this.uri, path: this.resolve(path), dtype: String(ds.dtype) },
      )
    }
    const [start, stop] = this.range(ds, lo, hi)
    return readStringSlice(this.h5, this.file, ds, start, stop)
  }

  readTable(path: string, lo?: number, hi?: number, columns?: readonly string[]): Table {
    const entity = this.entity(path)
    if (entity === null || !(entity instanceof this.h5.Group)) {
      throw new MetaCoolerFormatError(`${this.describe(path)} is not a table group`, {
        uri: this.uri,
        path: this.resolve(path),
      })
    }
    const label = this.resolve(path).slice(this.group === '/' ? 1 : this.group.length + 1)
    return readTableGroup(this.h5, this.file, entity, label, lo, hi, columns)
  }

  at(path: string): Hdf5Handle {
    const rooted = this.resolve(path)
    // `borrowed`, so this view's `close` is inert — see `Hdf5Handle.at`.
    const view = new Hdf5File(
      this.uri,
      rooted,
      this.h5,
      this.file,
      this.source,
      this.rootEntries,
      this.rootEntryGroup,
      true,
    )
    return view
  }

  close(): void {
    // A borrowed view shares the mount with the handle it came from; closing
    // it here would pull the file out from under that one (`Hdf5Handle.at`).
    if (this.closed || this.borrowed) return
    this.closed = true
    try {
      this.file.close()
    } finally {
      this.source.close()
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Resolve a caller path against the rooted group, always absolute. */
  private resolve(path: string): string {
    const relative = path.replace(/^\/+/, '')
    if (relative === '') return this.group
    return normalise(this.group === '/' ? `/${relative}` : `${this.group}/${relative}`)
  }

  private describe(path: string): string {
    return `${this.uri} :: ${this.resolve(path)}`
  }

  private entity(path: string) {
    this.assertOpen()
    const resolved = this.resolve(path)
    if (resolved === '/') return this.file
    return this.file.get(resolved)
  }

  private dataset(path: string): H5wasmDataset {
    const entity = this.entity(path)
    if (entity === null) {
      throw new MetaCoolerFormatError(`${this.describe(path)} does not exist`, {
        uri: this.uri,
        path: this.resolve(path),
      })
    }
    if (!(entity instanceof this.h5.Dataset)) {
      throw new MetaCoolerFormatError(`${this.describe(path)} is not a dataset`, {
        uri: this.uri,
        path: this.resolve(path),
      })
    }
    return entity
  }

  /** Clamp a caller-supplied `[lo, hi)` onto a 1-D dataset's real extent. */
  private range(ds: H5wasmDataset, lo?: number, hi?: number): [number, number] {
    const shape = ds.metadata.shape
    if (!shape || shape.length !== 1) {
      throw new MetaCoolerFormatError(
        `/${ds.path.replace(/^\//, '')} is ${shape ? `${shape.length}-D` : 'scalar'}; ` +
          'this reader only slices 1-D columns',
        { path: ds.path, shape },
      )
    }
    const total = shape[0]
    const start = Math.min(Math.max(Math.trunc(lo ?? 0), 0), total)
    const stop = Math.min(Math.max(Math.trunc(hi ?? total), start), total)
    return [start, stop]
  }

  /**
   * Decode one attribute.
   *
   * `json_value` already does the right thing for everything h5py writes as an
   * attribute — it narrows BigInt to Number, unwraps scalars, and turns an
   * h5py boolean enum back into `true`/`false`. The exception is a
   * *fixed-length* string attribute, which lands in h5wasm's ASCII decode path;
   * those are re-read from raw bytes for the same reason string columns are.
   */
  private decodeAttr(
    objectPath: string,
    name: string,
    md: Metadata,
    jsonValue: unknown,
  ): AttrValue {
    if (md.type === this.h5.Module.H5T_class_t.H5T_STRING.value && !md.vlen) {
      const decoded = this.readFixedStringAttr(objectPath, name, md)
      if (decoded !== null) return decoded
    }
    return coerceAttr(jsonValue)
  }

  private readFixedStringAttr(
    objectPath: string,
    name: string,
    md: Metadata,
  ): string | string[] | null {
    const count = md.total_size
    const nbytes = md.size * count
    if (nbytes <= 0) return null
    const runtime = this.h5.Module
    const ptr = runtime._malloc(nbytes)
    if (ptr === 0) return null
    let bytes: Uint8Array
    try {
      runtime.get_attribute_data(this.file.file_id, objectPath, name, BigInt(ptr))
      bytes = runtime.HEAPU8.slice(ptr, ptr + nbytes)
    } finally {
      runtime._free(ptr)
    }
    const items: string[] = []
    for (let i = 0; i < count; i++) {
      let item = bytes.subarray(i * md.size, (i + 1) * md.size)
      const nul = item.indexOf(0)
      if (nul > -1) item = item.subarray(0, nul)
      items.push(UTF8.decode(item))
    }
    const shape = md.shape
    return shape && shape.length > 0 ? items : (items[0] ?? '')
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new MetaCoolerFormatError(`${this.uri} is closed`, { uri: this.uri })
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Collapse repeated separators and strip a trailing slash, keeping the root. */
function normalise(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  return collapsed === '' ? '/' : collapsed
}

/** Narrow an h5wasm JSON-compatible attribute value onto {@link AttrValue}. */
function coerceAttr(value: unknown): AttrValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return value as string[]
    const numeric = (v: unknown) =>
      typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint'
    if (value.every(numeric)) return value.map((v) => Number(v))
    return value.map((v) => String(v))
  }
  return null
}
