/**
 * Shared types — the contract every module in this repo codes against.
 *
 * Nothing here imports h5wasm or touches the network; the byte-source and HDF5
 * layers are the only places that do (spec §6.1).
 */

import type { StorageMode } from './constants'
import type { NameMatch } from './genome/naming'

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
  /**
   * `true` when a read that seeks costs a network round trip.
   *
   * Not "was this a URL": a remote object downloaded whole and mounted from
   * memory answers `false`, because what this is asked about is the cost of
   * *scattered* access, and there is none once the bytes are here. The one
   * caller is the §12 gate on listing a single-cell container's cells, which is
   * the only read in this application whose shape the byte layer cannot bound.
   */
  readonly isRemote: boolean
  /** Make the bytes visible to the Emscripten FS; returns the mounted path. */
  mount(): Promise<string>
  /**
   * Read `[position, position + length)` directly, without going through HDF5.
   *
   * HDF5 is not the only container this app opens: a `.hic` is a flat binary
   * file with its own index, and it needs the same bounded, cached, counted
   * byte access that `mount()` gives h5wasm — the LRU, the request coalescing
   * and the §12 accounting are properties of the *source*, not of the format
   * reading it. So the byte layer is exposed once here rather than reimplemented
   * beside every parser.
   *
   * **Synchronous, and therefore worker-only** on the remote path, for the same
   * reason `mount()`'s stream ops are: it is `XMLHttpRequest` underneath, and a
   * synchronous one is legal only off the main thread. That is where all I/O
   * already lives.
   *
   * Returns fewer bytes than asked for only at end of file.
   */
  readBytes(position: number, length: number): Uint8Array
  /**
   * Read `[position, position + length)` as exactly those bytes, past the cache.
   *
   * {@link readBytes} rounds every read out to whole chunks, which is right for
   * the reads it was built for — HDF5's metadata walk lands again and again in
   * the chunk it just fetched — and wrong for a read that lands alone in the
   * middle of a large file and is never followed by its neighbours. A `.hic`
   * walked pair by pair is exactly that: the head of each chromosome pair's
   * matrix record and one coarse block after it, a few hundred bytes apiece and
   * megabytes apart, so a 1 MiB chunk around each is a megabyte thrown away per
   * read — half a gigabyte to count the contacts of one 4DN file.
   *
   * Served from the cache when every chunk it covers is already there, and
   * otherwise one request for exactly the range, which is then **not** kept:
   * the caller has asked for bytes it will not read again. Optional, because a
   * source whose reads cost no round trip has nothing to gain from it; a caller
   * without it falls back to {@link readBytes}.
   *
   * **Asynchronous**, unlike every other read here, and that is the other half
   * of the point. A walk of that kind is a round trip or two per chromosome pair
   * and nothing else — latency is its whole cost — so it keeps a few in flight
   * at once, and the worker answers other requests while they are.
   */
  readExact?(position: number, length: number): Promise<Uint8Array>
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

export type LayoutKind =
  | 'mmetacool'
  | 'metacool'
  | 'mcool'
  | 'scool'
  | 'cool'
  | 'hic'
  | 'hicpro'
  | 'pairs'

export interface Layout {
  kind: LayoutKind
  /** HDF5 group path holding the dataset ('/' for a plain metacool). */
  group: string
  /** For mmetacool/mcool/scool/hic: available entry (or cell, or resolution) names, in file order. */
  entries?: string[]
  /**
   * For `scool`: the group the cells live under, which is the one structural
   * difference between the format's two layouts.
   *
   * `'cells'` for the standard container `cooler.create_scool` writes, and the
   * empty string for the flat one every pre-0.8.11 writer produced, whose cells
   * are the root's own children. Absent for every other layout, which has no
   * cells. A field rather than a boolean because it is a *path*, and every
   * caller that has one wants to join it to a name.
   */
  cellGroup?: string
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
  /**
   * Present only where the name asked for is not the name this file writes.
   *
   * A companion panel following `chr1` into a file that calls it `1` resolves,
   * and this is the record of what it took — which spelling arrived, which one
   * answered, and by which rule. It exists so the panel can *say so*: a map
   * that silently answers a name it does not have is the one way this feature
   * can be quietly wrong (§5.9).
   */
  matched?: NameMatch
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
  | 'cells'
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
  /**
   * Further coolers, each drawn in a panel of its own beside this one (§16).
   *
   * The plural of {@link uri}, and a weaker claim than {@link uri2}: a second
   * file *blended into* this square has to share its grid, and a second file
   * *beside* it has only to share its coordinates. Pipe-separated rather than
   * comma-separated because a comma is legal in a URI and a pipe is not
   * (`panels/deck.ts`), and a local companion is written as `~` rather than
   * dropped, so a link keeps the count and the order of what was sent even
   * where it cannot keep the bytes (§11).
   */
  maps?: string
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
   * The stretch of {@link region} the map opens **zoomed to**, on the diagonal:
   * `chrI:1200000-1260000`, 0-based half-open, exactly as `region` is written.
   *
   * The distinction from `region` is the whole of what this key is for, and it is
   * a distinction a reader can feel: `region=chrI:1200000-1260000` *cuts a block*
   * at those coordinates, so panning stops at its edges and there is nothing
   * outside them to see. This names a window over a block that was read whole, so
   * the picture opens on the locus and the rest of the chromosome is still there
   * to pan into. That is what a bookmark means by "take me there" (§8.10), and it
   * is why saved places do not simply set `region`.
   *
   * A **one-shot initial condition**, not a live position. Pan and zoom are
   * deliberately absent from the hash (§5.5 carries what is *being looked at*,
   * and a URL that rewrote itself on every wheel notch would make the back button
   * a scrollback), so this is applied when the block it names arrives and is not
   * written back when the reader moves off it. The link keeps pointing at the
   * place it was made for, which is what makes a bookmark shareable.
   *
   * Ignored by every view but `region`: it is a window *inside* a block read on
   * one axis pair, and a genome or a selection has no single diagonal to put it
   * on. Ignored quietly, and left in the hash rather than stripped, for the
   * reason `flip` is on a metagenome — a reader passing through a view that
   * cannot honour it should not find it deleted on the far side.
   */
  focus?: string
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
   * The cells of an `.scool` being summed, comma-joined, in file order.
   *
   * Unlike every other key here it is not the subject of *one* view: it says
   * which cells the file is being **read through**, and it survives navigating
   * from the cells table into a chromosome and back out (§3.8). A map view with
   * no `cells` sums every cell in the file, which is what an scool dropped and
   * pressed through means.
   *
   * Comma-joined for the reason `genomes` is, and with the same limit: a
   * selection of four thousand cells would not fit in a URL, so `*` is written
   * for "all of them" and the enumeration is only for a genuine subset.
   */
  cells?: string
  /**
   * The total every map of the tab is drawn to, in contacts (§6.5).
   *
   * Typed in the breadcrumb's *contacts* box, or set there by the deck's two
   * chevrons. Each map is drawn to it on its own: subsampled where it holds
   * more — cooltools' `random-sample --count --exact` — oversampled through
   * Boost-HiC where it holds fewer, left alone where it holds exactly this
   * many. Every picture and every task reads the drawn maps, which is the point:
   * two libraries compared at one depth.
   *
   * **Part of the shared view**, for the reason {@link balance} is — a map at
   * ten million contacts is a different picture from the file — and carried
   * across a navigation with the cell set (`SUBJECT_KEYS`), since it is which
   * data the file is read through rather than which part of it is on screen.
   * Absent is every file as stored.
   */
  contacts?: number
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
   * The effective bin size, in bp, where the reader asked for one the file does
   * not store (§3.4).
   *
   * A `.mcool` carries the rungs whoever ran `cooler zoomify` chose to write,
   * and a reader who wants a 10 kb picture of a file that stops at 4 kb can have
   * one for free: a 10 kb bin is a whole number of stored bins added up. This
   * says which resolution they asked for; `metacooler/coarsen.ts` says which rung
   * it is summed from and by how much, and the {@link uri} names that rung.
   *
   * **Part of the shared view**, for the reason {@link balance} is: a 10 kb map
   * and a 1 kb map of the same window are different pictures, and a link that
   * dropped which one you were looking at would send its recipient a blockier or
   * a finer map with nothing on screen saying so. Which resolutions a reader has
   * *added to the ladder* is a different question and travels with the tracks
   * they loaded (`state/resolutions.ts`).
   *
   * Absent is the open rung's own bins, which is every view of every file until
   * somebody presses `+`. A value this file cannot be read at is ignored rather
   * than refused — a link is a string a stranger can edit, and the answer closest
   * to what was asked for is the file's own grid.
   */
  coarsen?: number
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
   * Divide by the decay along **both arms** of a bacterial chromosome rather
   * than along the diagonal alone, within this many bins along the arms (`0`,
   * the whole sequence) — `analysis/arms.ts`, read from the origin declared for
   * the sequence on screen (§8.15).
   *
   * A modifier of {@link oe} rather than a second baseline beside it: it changes
   * *which* expectation the ratio is taken against, so it is meaningless without
   * one and turning it on turns the O/E on. In the link for `oe`'s reason — the
   * two pictures are different numbers of the same region.
   */
  arms?: number
   /**
   * How much despeckling, as the token the picker carries — a fixed radius
   * (`1` is 3 × 3) or an adaptive target (`a200`, a window that grows per cell
   * until it covers enough evidence); `0` and absent are off
   * (`render/smooth.ts`).
   *
   * Beside {@link oe} and carried for its reason: it composes with every other
   * value rather than replacing one, and a smoothed map *looks like a map*, so a
   * link that dropped it would send a recipient a picture whose single-cell
   * features had been averaged away with nothing on screen saying so. The one
   * key in this group whose absence and whose `0` mean the same thing, which is
   * why it is written down only when a reader has asked for it.
   */
  smooth?: string
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
   * Whether the map is turned 45° — position along the bottom, distance from the
   * diagonal up the side (`render/rotate.ts`).
   *
   * **Absent means square**, and only an explicit `true` is a turned map.
   *
   * It was the other way round, and the argument for it was that a band along a
   * genomic axis is what a contact map is *for* on a block that has a diagonal.
   * The trouble is where that default lands: `isTurnable` is true for exactly one
   * kind of block — one sequence against itself — so *every* map it applied to
   * was a single chromosome, and opening one from the Chromosomes table made the
   * picture change shape as you arrived. A reader who clicks a chromosome is
   * asking to see that chromosome, not to have it rotated; the turn is a reading
   * they ask for, and now it is written down when they do. The hash of an
   * ordinary view still says nothing about it, and a link with no `flip` in it
   * still opens the way this viewer opens — the way has changed.
   *
   * Part of what is being looked at rather than how it is shaded, so §11's rule
   * applies and a link carries it. Ignored by any view whose block has no
   * diagonal to measure from, which is what `isTurnable` decides and what the
   * toggle is greyed by: a hash naming it on a whole-metagenome map lands on the
   * square, the way `op` lands on one file — and quietly, without writing the
   * refusal back, or a reader who passed through a metagenome would find the
   * turn switched off on the next map that could take one.
   */
  flip?: boolean
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
