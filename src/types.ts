/**
 * Shared types — the contract every module in this repo codes against.
 *
 * Nothing here imports h5wasm or touches the network; the byte-source and HDF5
 * layers are the only places that do (spec §6.1).
 */

import type { StorageMode } from './constants'

// ---------------------------------------------------------------------------
// Byte sources (spec §6.1)
// ---------------------------------------------------------------------------

/**
 * A file the HDF5 layer can mount. One interface, two implementations
 * (`LocalFileSource`, `RemoteRangeSource`), chosen at construction. Nothing
 * downstream of `h5/` may import h5wasm or call `fetch`.
 */
export interface ByteSource {
  /** Stable identity for caching and for error messages. */
  readonly id: string
  /** Total size in bytes. Known before `mount()` for both implementations. */
  readonly size: number
  /** Make the bytes visible to the Emscripten FS; returns the mounted path. */
  mount(): Promise<string>
  /** Release the mount. Idempotent. */
  close(): void
  /** Bytes fetched and requests issued so far — drives the §12 budget tests. */
  stats(): SourceStats
}

export interface SourceStats {
  requests: number
  bytes: number
}

// ---------------------------------------------------------------------------
// Tables (spec §6.2)
// ---------------------------------------------------------------------------

/** One decoded column. Strings are already UTF-8 decoded and NUL-stripped. */
export type Column = string[] | Float64Array | Int32Array | BigInt64Array | number[]

/**
 * A column-oriented table read from an HDF5 group. The column *set* is
 * discovered, never hard-coded, so optional metadata columns flow through to
 * the UI untouched (spec §5.1).
 */
export interface Table {
  readonly length: number
  /** Column names in the on-disk order. */
  readonly columns: string[]
  /** Column data, keyed by name. */
  readonly data: Record<string, Column>
  /** Convenience accessor: `get('name', 3)`. Returns `undefined` if absent. */
  get(column: string, row: number): string | number | undefined
  /** A whole column as a plain array of strings. Throws if not a string column. */
  strings(column: string): string[]
  /** A whole column as numbers (BigInt columns are narrowed to Number). */
  numbers(column: string): number[]
}

// ---------------------------------------------------------------------------
// File layout detection (spec §3.1)
// ---------------------------------------------------------------------------

export type LayoutKind = 'mmetacool' | 'metacool' | 'mcool' | 'cool'

export interface Layout {
  kind: LayoutKind
  /** HDF5 group path holding the dataset ('/' for a plain metacool). */
  group: string
  /** For mmetacool/mcool: available entry (or resolution) names, in file order. */
  entries?: string[]
}

// ---------------------------------------------------------------------------
// Normalised file info (spec §6, mirroring `MetaCooler.info`)
// ---------------------------------------------------------------------------

export interface Info {
  format: string | null
  'format-url': string | null
  'format-version': number | null
  'bin-size': number | null
  'bin-type': string | null
  ordering: string | null
  assembly: string | null
  'storage-mode': StorageMode
  nbins: number | null
  nnz: number | null
  sum: number | null
  ngenomes: number | null
  ncontigs: number | null
  /** Anything else on the root group, passed through unchanged. */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Matrix queries (spec §5, §6, M2)
// ---------------------------------------------------------------------------

/** A half-open bin-index interval `[lo, hi)`. */
export type Extent = [number, number]

export interface MatrixQuery {
  /** Row bin range. */
  rows: Extent
  /** Column bin range. Defaults to `rows` (on-diagonal) when omitted. */
  cols?: Extent
  /** Apply `/bins` weights if a balancing column is present (spec §6.4). */
  balance?: boolean
}

/**
 * A dense block in row-major order. `values.length === nrows * ncols`.
 *
 * Float32 is enough for display and halves the footprint of a 1200×1200 MAG,
 * but *aggregation accumulates in Float64* (spec §6.2) — counts are widened to
 * int64 on disk precisely because summation overflows int32.
 */
export interface DenseMatrix {
  readonly nrows: number
  readonly ncols: number
  readonly values: Float32Array
  /** The bin range each axis covers, after any transpose was undone. */
  readonly rowExtent: Extent
  readonly colExtent: Extent
}

/** COO triplets straight off the pixel table, before scattering to dense. */
export interface PixelChunk {
  bin1: Int32Array
  bin2: Int32Array
  count: Float64Array
  /** Number of valid entries; the arrays may be over-allocated. */
  length: number
}

// ---------------------------------------------------------------------------
// Range parsing (spec §5.4)
// ---------------------------------------------------------------------------

export type RangeKind = 'genome' | 'contig'

export interface ParsedRange {
  kind: RangeKind
  /** The matched genome or contig name. */
  label: string
  extent: Extent
}

// ---------------------------------------------------------------------------
// Rendering (spec §7)
// ---------------------------------------------------------------------------

export type Transform = 'log1p' | 'log10' | 'none'

export interface ColorScale {
  vmin: number
  vmax: number
  transform: Transform
  colormap: string
}

/** A boundary line drawn across the heatmap, with the label it separates. */
export interface Separator {
  /** Bin offset within the rendered block where the boundary falls. */
  at: number
  label: string
}

// ---------------------------------------------------------------------------
// View state (spec §5.5)
// ---------------------------------------------------------------------------

export type ViewKind = 'genomes' | 'contigs' | 'genome' | 'pair' | 'region' | 'whole'

export interface ViewState {
  /** The full URI, `file` or `file::group`. */
  uri: string
  view: ViewKind
  /** Genome name for `genome`; row genome for `pair`. */
  genome?: string
  /** Column genome for `pair`. */
  genome2?: string
  /** `contig` or `contig:start-end` for `region` — the row axis. */
  region?: string
  /**
   * Column axis of a `region` view, making it a rectangular contig × contig
   * block rather than a square one.
   *
   * Clicking the intersection of two contigs inside a genome asks about the
   * contacts *between* them, so the answer is the off-diagonal block, not
   * either contig's own square map. Absent means the region is on-diagonal.
   */
  region2?: string
  /** Aggregation level inside a genome view. */
  level?: 'bin' | 'contig'
  /**
   * Multiply counts by their bin weights — cooler's balanced matrix (§6.4).
   *
   * Part of the shared view, not a preference: a balanced map and a raw one are
   * different pictures of the same data, and a link that dropped which one you
   * were looking at would mislead its recipient.
   */
  balance?: boolean
  transform?: Transform
  colormap?: string
  vmax?: number
}
