/**
 * The worker message protocol — the shared vocabulary between the main thread
 * and the reader worker.
 *
 * The worker owns *all* I/O (HDF5 mounts, range requests, the sidecar edge-list
 * `fetch`), so no user gesture on the main thread can ever block on a byte that
 * has not arrived. Everything crossing the boundary is therefore either plain
 * data or a transferable buffer.
 *
 * Two things need explicit care at this boundary:
 *
 * 1. **Errors.** A structured clone of an `Error` subclass loses the subclass:
 *    `ViewerError` arrives on the other side as a bare `Error` with no `code`
 *    and no `detail`, which would collapse every named refusal of spec §10 into
 *    "something went wrong". They are serialised and revived explicitly.
 * 2. **Tables.** {@link Table} carries methods (`get`, `strings`, `numbers`),
 *    and methods do not survive structured cloning. Tables travel as
 *    {@link TablePayload} and are rehydrated by {@link tableFromPayload}.
 */

import { ViewerError, type ErrorCode } from '../errors'
import type { Column, Extent, Info, Layout, ParsedRange, SourceStats, Table } from '../types'

// ---------------------------------------------------------------------------
// Byte sources
// ---------------------------------------------------------------------------

/** Which of the two byte-source implementations to build (spec §6.1). */
export type SourceKind = 'local' | 'remote'

/**
 * How to obtain the bytes. A `File` is structured-cloneable, so a dropped file
 * is handed to the worker by reference — it is never read into a buffer on the
 * main thread and it never leaves the browser (spec §11).
 */
export type SourceSpec = { kind: 'local'; file: File } | { kind: 'remote'; url: string }

// ---------------------------------------------------------------------------
// Wire-safe tables
// ---------------------------------------------------------------------------

/**
 * A {@link Table} flattened for structured cloning: column order preserved,
 * every numeric column narrowed to `Float64Array` (int64 columns arrive as
 * `BigInt64Array`, and mixing `BigInt` with `Number` throws at *runtime*, so
 * the narrowing happens once, here — spec §6.2).
 */
export interface TablePayload {
  length: number
  columns: string[]
  data: Record<string, string[] | Float64Array>
}

/** `true` when a decoded column holds strings rather than numbers. */
function isStringColumn(column: Column): column is string[] {
  return Array.isArray(column) && (column.length === 0 || typeof column[0] === 'string')
}

/**
 * Flatten a {@link Table} for transfer. Numeric columns become `Float64Array`.
 *
 * Every numeric column is **copied**, even one that is already a
 * `Float64Array`. {@link transfersFor} moves the buffers it finds rather than
 * cloning them, and moving a buffer detaches it: handing over the reader's own
 * `/contigs/length` array would leave the still-open `MetaCooler` reading from
 * a zero-length view on the next query.
 */
export function tableToPayload(table: Table): TablePayload {
  const data: Record<string, string[] | Float64Array> = {}
  for (const name of table.columns) {
    const column = table.data[name]
    if (column === undefined) continue
    if (isStringColumn(column)) {
      // Strings are structured-cloned, not transferred, so sharing is safe.
      data[name] = column
    } else if (column instanceof BigInt64Array) {
      data[name] = Float64Array.from(column, Number)
    } else {
      data[name] = Float64Array.from(column as ArrayLike<number>)
    }
  }
  return { length: table.length, columns: [...table.columns], data }
}

/**
 * Rebuild a usable {@link Table} from a payload. The column *set* is whatever
 * the file had — nothing here knows the names of `/genomes`' optional metadata
 * columns, which is what lets the genomes table render them generically (§5.1).
 */
export function tableFromPayload(payload: TablePayload): Table {
  const data = payload.data as Record<string, Column>
  return {
    length: payload.length,
    columns: payload.columns,
    data,
    get(column: string, row: number): string | number | undefined {
      const col = payload.data[column]
      if (col === undefined || row < 0 || row >= payload.length) return undefined
      return col[row]
    },
    strings(column: string): string[] {
      const col = payload.data[column]
      if (col === undefined) throw new Error(`no such column: ${column}`)
      if (!Array.isArray(col)) throw new Error(`column ${column} is not a string column`)
      return col
    },
    numbers(column: string): number[] {
      const col = payload.data[column]
      if (col === undefined) throw new Error(`no such column: ${column}`)
      if (Array.isArray(col)) throw new Error(`column ${column} is not a numeric column`)
      return Array.from(col)
    },
  }
}

/** `true` when a payload column should be treated as text by the UI. */
export function payloadColumnIsText(column: string[] | Float64Array): column is string[] {
  return Array.isArray(column)
}

// ---------------------------------------------------------------------------
// Reader-side statistics that the UI displays but does not compute
// ---------------------------------------------------------------------------

/**
 * Re-exported from the reader so the wire types cannot drift from what the
 * reader actually produces. These are *type-only* re-exports: they are erased
 * at build time, so importing them here does not drag `MetaCooler` — and with
 * it h5wasm — into the main-thread bundle.
 *
 * `UnassignedStats` is the single retained `__unbinned__` number (§7.4): a
 * read-only QC statistic for the info panel that opens nothing and selects
 * nothing. `DeepValidation` is the outcome of the opt-in full check (§6.3).
 */
export type { DeepValidation, UnassignedStats } from '../metacooler/MetaCooler'
import type { DeepValidation, UnassignedStats } from '../metacooler/MetaCooler'

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface OpenResult {
  uri: string
  layout: Layout
  info: Info
  metadata: Record<string, unknown>
  binsize: number | null
  shape: [number, number]
  nGenomes: number
  nContigs: number
  nBins: number
  unassigned: UnassignedStats | null
  /** Sibling entry names of the enclosing mmetacool; `[]` for a plain file (§3.4). */
  entries: string[]
  /** Byte size of the source — the remote overview gate is a byte threshold (§7.3). */
  sourceBytes: number
  sourceKind: SourceKind
}

export interface GenomesResult {
  table: TablePayload
  /**
   * Row indices of `table` that may be displayed. `__unbinned__` is absent with
   * no toggle (§7.4), and nothing is renumbered to achieve that — the omitted
   * row keeps its index, its `genome_id` and all of its bins.
   */
  display: Int32Array
  /**
   * `bin1_offset[hi] − bin1_offset[lo]` per genome row: the number of non-zero
   * pixels whose *row* bin falls inside the genome (§4). Free, from an index
   * already in memory. **Not a contact count** — the column is labelled as a
   * proxy wherever it is shown.
   */
  density: Float64Array
}

export interface ContigsResult {
  table: TablePayload
}

/** One labelled run along an axis of a rendered block, in block-local offsets. */
export interface AxisGroup {
  label: string
  /** First row/column of the group within the block. */
  start: number
  /** One past the last row/column of the group within the block. */
  end: number
}

export interface MatrixResult {
  nrows: number
  ncols: number
  /** Row-major, `nrows * ncols` long. Transferred, not copied. */
  values: Float32Array
  rowExtent: Extent
  colExtent: Extent
  /** Contig (or genome) runs along each axis, for separators and tick labels. */
  rowGroups: AxisGroup[]
  colGroups: AxisGroup[]
  level: 'bin' | 'contig' | 'genome'
}

export interface OverviewResult {
  /** Genome names along both axes, `__unbinned__` excluded (§7.3, §7.4). */
  labels: string[]
  /** Row-major `n × n`. */
  values: Float32Array
  n: number
  /** Whether the numbers came from a full pixel scan or a sidecar edge list. */
  source: 'scan' | 'edge-list'
  /** `true` when the genome set was capped for memory; see `totalGenomes`. */
  restricted: boolean
  totalGenomes: number
}

export interface StatsResult {
  /** Everything the byte source has fetched since the file was opened. */
  total: SourceStats
  /** Delta across the most recent matrix/aggregate/overview request (§12). */
  lastOp: SourceStats
  /** Number of worker requests served. */
  calls: number
}

/** Every request kind, mapped to what it resolves with. */
export interface ResultMap {
  open: OpenResult
  genomes: GenomesResult
  contigs: ContigsResult
  range: ParsedRange
  matrix: MatrixResult
  aggregate: MatrixResult
  overview: OverviewResult
  overviewSidecar: OverviewResult
  validateDeep: DeepValidation
  stats: StatsResult
  cancel: null
  close: null
}

export type RequestKind = keyof ResultMap

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type WorkerRequest =
  | { id: number; kind: 'open'; uri: string; source: SourceSpec }
  | { id: number; kind: 'genomes' }
  | { id: number; kind: 'contigs' }
  | { id: number; kind: 'range'; range: string }
  // No `balance` flag: the format defines no weights column and `show()` uses
  // `balance=False`, so the reader refuses a balanced query outright (§6.4).
  | { id: number; kind: 'matrix'; rows: Extent; cols?: Extent }
  | { id: number; kind: 'aggregate'; rows: Extent; cols?: Extent; level: 'contig' | 'genome' }
  | { id: number; kind: 'overview'; maxGenomes?: number }
  | { id: number; kind: 'overviewSidecar'; url: string }
  | { id: number; kind: 'validateDeep' }
  | { id: number; kind: 'stats' }
  | { id: number; kind: 'cancel'; target: number }
  | { id: number; kind: 'close' }

/** The request payload for a kind, before the client stamps an id on it. */
export type RequestOf<K extends RequestKind> = Omit<Extract<WorkerRequest, { kind: K }>, 'id'>

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * A `ViewerError` flattened for the wire. `code` and `detail` are what the UI
 * switches on (spec §10), so losing them to structured clone is not acceptable.
 */
export interface SerialisedError {
  name: string
  code: ErrorCode | null
  message: string
  detail: Record<string, unknown>
  stack?: string
}

export type WorkerResponse =
  | { type: 'result'; id: number; kind: RequestKind; payload: unknown }
  | { type: 'error'; id: number; error: SerialisedError }
  | { type: 'progress'; id: number; done: number; total: number; note?: string }

/** Progress callbacks receive the same numbers the worker emits. */
export type ProgressHandler = (done: number, total: number, note?: string) => void

// ---------------------------------------------------------------------------
// Error serialisation
// ---------------------------------------------------------------------------

/**
 * Reduce a value to something structured-clone-safe. `detail` is built by the
 * reader and may legitimately contain a `Map`, a typed array or a `BigInt`;
 * a single un-cloneable value in there would fail the whole `postMessage` and
 * turn a precise refusal into a silent hang.
 */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return Number(value)
    case 'object': {
      if (Array.isArray(value)) return value.map(plain)
      if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
      if (value instanceof Map) {
        const out: Record<string, unknown> = {}
        for (const [k, v] of value) out[String(k)] = plain(v)
        return out
      }
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v)
      return out
    }
    default:
      return String(value)
  }
}

/** Flatten any thrown value into a {@link SerialisedError}. */
export function serialiseError(err: unknown): SerialisedError {
  if (err instanceof ViewerError) {
    return {
      name: err.name,
      code: err.code,
      message: err.message,
      detail: plain(err.detail) as Record<string, unknown>,
      stack: err.stack,
    }
  }
  if (err instanceof Error) {
    return { name: err.name, code: null, message: err.message, detail: {}, stack: err.stack }
  }
  return { name: 'Error', code: null, message: String(err), detail: {} }
}

/**
 * Rebuild an error on the receiving side. A `code` means the refusal was one of
 * spec §10's named cases, so it comes back as a real `ViewerError` and the UI's
 * `switch (err.code)` keeps working across the worker boundary.
 */
export function reviveError(serialised: SerialisedError): Error {
  if (serialised.code !== null) {
    const err = new ViewerError(serialised.code, serialised.message, serialised.detail)
    err.name = serialised.name
    if (serialised.stack) err.stack = serialised.stack
    return err
  }
  const err = new Error(serialised.message)
  err.name = serialised.name
  if (serialised.stack) err.stack = serialised.stack
  return err
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/**
 * Collect the buffers in a result that should move rather than be copied.
 *
 * A genome's matrix is up to a few million `Float32` cells; copying it across
 * the boundary would double both the peak footprint and the latency for no
 * benefit, since the worker has no further use for it.
 */
export function transfersFor(payload: unknown): Transferable[] {
  const out: Transferable[] = []
  const seen = new Set<ArrayBufferLike>()
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    if (ArrayBuffer.isView(value)) {
      const buffer = value.buffer
      if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
        seen.add(buffer)
        out.push(buffer)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const item of Object.values(value as Record<string, unknown>)) visit(item)
  }
  visit(payload)
  return out
}
