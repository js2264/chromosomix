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
  /**
   * Which `/pixels` column the cell values come from. Defaults to `count`.
   *
   * cooler fixes three columns and lets a file carry more, and the extra ones
   * are values per pixel exactly as `count` is — an expected value, a second
   * normalisation, a per-pixel significance. Naming the column here rather than
   * assuming `count` is what lets a file's own vocabulary reach the picture;
   * `scoreColumns` is how a file says which it has.
   *
   * Orthogonal to {@link balance}, which multiplies whatever was read by the two
   * bin weights: an extra column can be balanced like any other if that is what
   * the reader asks for.
   */
  value?: string
  /**
   * Override the tab's memory budget for this one read.
   *
   * The budget is a guess from `navigator.deviceMemory`, which is Chromium-only
   * and capped at 8 — so it says the same thing about a 128 GB workstation as
   * about an 8 GB laptop, and says nothing at all on Firefox or Safari. When it
   * refuses a block, the user is in a position to know better than it does, and
   * this is how they say so. Absent means "use the guess".
   */
  budgetBytes?: number
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

/**
 * The scale a value is drawn on.
 *
 * The first three mirror `metacooler show`'s `_transform_matrix` and are frozen
 * by spec §7.1's parity requirement. `log2` is the viewer's own and exists for
 * the values the CLI cannot produce: a ratio — of two files, or of a cell to its
 * distance-decay baseline — is a quantity whose neutral point is `1`, and only a
 * logarithm puts twice and half the same distance either side of it. Base two
 * rather than ten because the readings that matter are doublings, and because
 * every Hi-C tool that draws a ratio draws `log2` of it.
 */
export type Transform = 'log1p' | 'log10' | 'log2' | 'none'

/**
 * What two aligned files are reduced to (`render/compare.ts`).
 *
 * Here rather than beside the code that implements it, for `Transform`'s reason:
 * the view state carries it, so it is part of the contract every layer codes
 * against rather than a detail of the renderer. `render/compare.ts` owns the
 * list and the guard.
 */
export type CompareOp = 'split' | 'ratio' | 'difference'

export interface ColorScale {
  /** Low bound in transformed units. `NaN` asks for the auto rule. */
  vmin: number
  /** High bound in transformed units. `NaN` asks for the auto rule. */
  vmax: number
  transform: Transform
  colormap: string
  /**
   * Whether these are balanced values rather than raw counts.
   *
   * Only `log10` reads it, and only to decide what zero means: the bottom of a
   * balanced picture, the numpy-mirrored `0.0` of a count one. See
   * `render/scale.ts`'s `displayValue`.
   */
  balanced?: boolean
  /**
   * The value that means "nothing to report", in **raw** units, for a quantity
   * read against a middle rather than against a floor — `1` for a ratio, `0` for
   * a difference. Absent for every ordinary count matrix.
   *
   * It changes two things that have to change together, and both live in
   * `render/heatmap.ts`: the auto range becomes symmetric about it
   * (`autoSymmetricRange`), and the pooling reduction stops taking the maximum.
   * A contact map is pooled by its brightest cell because its signal *is* the
   * bright cell; a ratio map pooled that way would show only the arm above
   * neutral, so every region where the second file is the stronger one would
   * vanish at fit zoom — the half of the picture a difference map exists for.
   */
  neutral?: number
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

/**
 * `overview` is the whole-metagenome scan (§7.3), and it is a view state like
 * any other. It used to be a mode the shell held beside the state, which made it
 * the one landing view of a file that had no link, no back button and no place
 * in the history — three things its two neighbours in the root menu, the genomes
 * and contigs tables, have always had. Being a state costs it nothing: the scan
 * is still gated behind a click, so a shared `view=overview` link opens the gate
 * rather than a full pass over someone else's file.
 */
export type ViewKind =
  | 'genomes'
  | 'contigs'
  | 'genome'
  | 'pair'
  | 'region'
  | 'whole'
  | 'overview'
  | 'selection'
  | 'browser'

export interface ViewState {
  /** The full URI, `file` or `file::group`. */
  uri: string
  /**
   * A second cooler, drawn in the lower-left triangle of the same square.
   *
   * Part of the view, not a preference: two files in one picture is what is
   * being looked at, and a link that dropped the second would send its recipient
   * a symmetric map of one file with no sign that anything was missing. Only a
   * remote URL survives being shared, which is the same limit `uri` has always
   * had and for the same reason (§11).
   */
  uri2?: string
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
  /**
   * The genomes a `selection` view is of, comma-joined, in the order ticked.
   *
   * The plural of {@link genome}, and it makes the pair view a special case
   * rather than a separate thing: `genomes=a,b` is the same picture `pair`
   * shows, plus each one's own map on the diagonal. Comma because that is what
   * the CLI's `--genomes` takes and what a reader would type; genome and contig
   * names are ASCII and do not contain one.
   */
  genomes?: string
  /** The contigs a `selection` view is of — the plural of {@link region}. */
  regions?: string
  /**
   * What one row of the matrix is.
   *
   * `bin` and `contig` are the aggregation levels of a genome, pair, region or
   * whole view; `genome` is the overview's coarser axis, which those views have
   * no meaning for. One key rather than two because it is one question — what
   * are the axes made of — and because a state with `level` *and* `axis` in it
   * would have two ways to say the same thing on the views that share a word.
   * Each view reads it through its own accessor (`matrixLevel`,
   * `overviewLevel`), which is where a value that view has no use for is
   * translated to the one it lands on.
   */
  level?: 'bin' | 'contig' | 'genome'
  /**
   * Multiply counts by their bin weights — cooler's balanced matrix (§6.4).
   *
   * Part of the shared view, not a preference: a balanced map and a raw one are
   * different pictures of the same data, and a link that dropped which one you
   * were looking at would mislead its recipient.
   */
  balance?: boolean
  /**
   * Which score the cells are drawn from — a `/pixels` column, or `balanced`.
   *
   * Part of the shared view for the reason `balance` is: two people looking at
   * the same link have to be looking at the same numbers, and "expected" and
   * "count" are different pictures of the same region rather than two ways of
   * shading one. `balance` is kept beside it rather than folded into it so that
   * every link written before this field existed still resolves.
   */
  score?: string
  /**
   * Whether each cell is divided by what its genomic distance predicts
   * (`render/derive.ts`).
   *
   * Beside {@link score} rather than folded into it, because it composes with
   * every value in that list rather than being one more of them: the standard
   * reading is observed over expected *of* balanced counts.
   */
  oe?: boolean
  /**
   * How two open files are put together — the diagonal split, or one derived
   * field over the whole square (`render/compare.ts`).
   *
   * Meaningless with one file open, and dropped rather than defended: a link
   * naming a ratio and one file lands on that file's own map, which is the same
   * thing `uri2` does for a local second file that cannot be reopened (§11).
   */
  op?: CompareOp
  /**
   * The window a `browser` view is open at: `chrI:1,001-20,000`, 1-based
   * inclusive, as every genome browser writes one and as the locus box accepts
   * one. Absent means the whole genome, which is where a browser opens.
   */
  locus?: string
  transform?: Transform
  colormap?: string
  /**
   * Colour-scale clip, in transformed units. Absent means auto — the §7.1
   * percentile rule — and the two are independent: a link may pin the top of
   * the scale and leave its floor to the data.
   */
  vmin?: number
  vmax?: number
}
