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
import type { NameContext, NameMatch } from '../genome/naming'
import type { S3Credential } from '../s3/sigv4'
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
 *
 * A remote source may carry the credential that signs it. It travels *with the
 * URL* rather than being configured on the worker, and the two properties that
 * follow are both wanted:
 *
 * - The worker holds no credential store and cannot enumerate one. It is handed
 *   the single key the URL it was given needs, for as long as that open lasts.
 * - `localStorage` does not exist in a worker, so a worker-side lookup was never
 *   available anyway — the shape the platform forces is also the better one.
 *
 * Absent means an unsigned request, which is the whole of the public path: the
 * demo bucket is read with no `Authorization` header, no preflight, and no
 * credential ever reaching this message.
 */
/**
 * Where a file's bytes are, and — for the one format that is two files — where
 * its other half's are.
 *
 * `bins` is the HiC-Pro pair (§3.9), and it is the same shape as the thing it
 * hangs off because it is the same question asked twice: a bin file may be a
 * local drop or a URL exactly as its matrix may. It is not a sidecar index in
 * the §8.11 sense — the matrix is unreadable without it rather than merely
 * slower — so its absence is a refusal rather than a fallback.
 */
export type SourceSpec = SourceLocation & {
  bins?: SourceLocation
  /**
   * How to read this file, when the default is known to be wrong for it.
   *
   * Absent is the default, and is what every file takes. It is set only by the
   * shell re-issuing an open with the reader's answer to a load gate, and it
   * doubles as the token that says the gate has been answered — which is why it
   * sits out here rather than on the remote arm: §3.8's gate is about round
   * trips and fires only over the network, but §3.9's is about parsing and
   * memory and fires on a local file just the same.
   *
   * - `whole` — one `GET` of the entire object, then everything is instant.
   *   The only answer a HiC-Pro pair has, since it is read whole regardless.
   * - `fine` — small chunks, little bandwidth, many round trips. An `.scool`
   *   only (§3.8); nothing else has a scattered-metadata problem to trade against.
   */
  reading?: 'whole' | 'fine'
}

type SourceLocation =
  | { kind: 'local'; file: File; index?: File }
  | {
      kind: 'remote'
      url: string
      credential?: S3Credential
      /**
       * The sidecar index named beside the URL — `<url>#index=<url>` split at
       * the door — for the one question the shell asks the annotations worker
       * about a remote file before opening it as a genome: a FASTA's assembly
       * is read from its `.fai` (§8.8), and a name the reader gave must reach
       * that question and not only the track loaded afterwards.
       */
      index?: string
      /**
       * Static headers put on **every** request for this URL (SPECS §24.7).
       *
       * The other kind of credential, and it travels for the same reason the
       * first one does: a Google API key and a bearer token are read from
       * `localStorage` and from a registry that exist only on the main thread,
       * so the worker is handed the headers the URL it was given needs rather
       * than a way to work them out.
       *
       * Unlike the signature, they are *static* — the same on the `HEAD`, the
       * probe, every ranged read and the whole-object fallback — because they
       * are a statement about who is asking rather than about what is being
       * asked. `sources/access.ts` is the one place the two are merged, in the
       * one order that works.
       */
      headers?: Record<string, string>
    }

/**
 * How a `.pairs` file is turned into a map (§3.7).
 *
 * Present only on the second `open` of one: the first is refused with
 * `pairs-binning-needed`, because a contact list declares no resolution and
 * there is nothing to open it *at* until a reader has chosen one.
 */
export interface PairsBinning {
  /** Bin size of the finest rung, in base pairs. */
  base: number
  /** How many rungs the ladder has, base included. */
  rungs: number
  /** Positions are 1-based, per the 4DN spec. */
  oneBased?: boolean
  /** Hand the written `.mcool` to the browser as soon as it is built. */
  download?: boolean
}

/** What a probe of a `.pairs` learned, for the dialog that picks a resolution. */
export interface PairsProbeResult {
  contigs: Array<{ name: string; length: number }>
  genomeLength: number
  /** Exact when the file is indexed, `null` otherwise. */
  records: number | null
  indexed: boolean
  assembly: string | null
  sorted: string | null
  sourceBytes: number
  /** The base resolution the dialog opens on. */
  suggestedBase: number
}

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

/** The `.mcool` an import was written to, ready to be handed to the browser. */
export interface McoolExport {
  /** The file's bytes. Transferred rather than copied — see `reader.worker.ts`. */
  bytes: Uint8Array
  /** What to call it in the download. */
  filename: string
  /** Rungs it carries, finest first. */
  rungs: number[]
}

/** What an import actually did, for the info panel and the status line. */
export interface PairsImportSummary {
  base: number
  rungs: number[]
  records: number
  nnz: number
  indexed: boolean
  /** Records naming a contig the header did not declare. */
  skippedUnknownContig: number
  /** Records whose position column did not hold a number. */
  skippedBadPosition: number
  /** Records whose position ran past the declared contig length. */
  clampedPosition: number
  /** `true` when the file was not `bin1`-ordered and a merge pass ran. */
  requiredMerge: boolean
  /** `true` when the file ended mid-member or without a BGZF end-of-file marker. */
  truncated: boolean
  /** Declared sequences with nothing on their own diagonal. */
  sequencesWithoutCisContacts: string[]
  /** Whether the caller asked for the `.mcool` to be built and downloaded. */
  download: boolean
  /**
   * The four orientation-resolved decay curves, where the file carried strands.
   *
   * Accumulated in the import's own pass (`pairs/bin.ts`), so it costs two more
   * fields off each record and no second read. Carried here rather than fetched
   * because the records are gone once the pass ends: the map is the pixel table
   * from then on, and this is the one reading that cannot be recovered from it.
   *
   * `null` for a file with no `strand1`/`strand2` columns, which is a fact about
   * the file rather than a failure.
   */
  orientation: OrientationSummary | null
  /** The binning that produced this map, so a second mount can reproduce it. */
  binning: PairsBinning
}

/** {@link PairsImportSummary.orientation}, as plain arrays that cross a worker. */
export interface OrientationSummary {
  edges: Float64Array
  counts: [Float64Array, Float64Array, Float64Array, Float64Array]
  total: number
}

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
  /**
   * The bins a whole-file picture may draw: everything but `__unbinned__`.
   *
   * `[0, nBins]` for a cooler and for a metacool written with
   * `drop_unassigned`. Elsewhere it is the range with the unassigned contigs
   * left out — they are not a genome, are shown nowhere else (§7.4), and on a
   * real metagenome are the largest thing in the picture.
   */
  displayExtent: Extent
  /**
   * Sibling names of the enclosing collection; `[]` for a plain file. The other
   * maps of an mmetacool (§3.4), or the other resolutions of an mcool (§9).
   */
  entries: string[]
  /** The group they live under: `entries` (mmetacool) or `resolutions` (mcool). */
  entryGroup: string
  /**
   * Every cell of an `.scool`, in file order; `[]` for every other container.
   *
   * Separate from {@link entries} on purpose, though both are sibling coolers
   * in one file. An mcool's resolutions are *rungs of the same map* and belong
   * in the breadcrumb's picker beside it; an scool's cells are the map's
   * **subject**, thousands of them, sorted and filtered and ticked — a table,
   * not a drop-down. Folding them into one list would put four thousand entries
   * in a menu and lose the columns that make them choosable.
   *
   * Paid for at open, and it is the one thing an scool costs: the names come
   * from walking the container's HDF5 link storage, which writers scatter
   * across the whole file (§12).
   */
  cells: string[]
  /**
   * The cells the open map is currently summing, in file order.
   *
   * Equal to {@link cells} for a file opened with nothing chosen, which is what
   * dropping one means: an scool with no selection is the pseudo-bulk of
   * everything in it. `[]` for every other container.
   */
  activeCells: string[]
  /**
   * Stored pixels across {@link activeCells}; `null` for every other container.
   *
   * The cost forecast the whole-file gate asks for, and an scool is the one
   * file where the root's own `nnz` cannot answer it: a standard container does
   * not write one (it has no pixels of its own) and a flat one writes nothing
   * at all. What the reader would otherwise conclude is "this file declares no
   * cost", and the read it then starts unwarned is a pass over every pixel of
   * every selected cell — the most expensive thing the format can be asked for.
   *
   * Recomputed whenever the set changes, because it is a property of the set:
   * one cell of a 3,882-cell file is four orders of magnitude cheaper than all
   * of them, and a gate quoting the file's total would fire on both.
   */
  cellNnz: number | null
  /** `false` for a plain cooler, which has no genome layer to browse. */
  hasGenomes: boolean
  /** `true` when `/bins/weight` exists, so balanced counts can be offered. */
  hasWeights: boolean
  /**
   * The `/pixels` value columns, `count` first — what the score picker lists.
   *
   * On the info rather than fetched on demand because it is one group listing
   * taken while the file is being opened anyway, and because every view that
   * offers the picker would otherwise ask for it separately.
   */
  scoreColumns: string[]
  /** Byte size of the source — the remote overview gate is a byte threshold (§7.3). */
  sourceBytes: number
  /** Present only when this map was imported from a `.pairs` (§3.7). */
  pairs?: PairsImportSummary
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

/**
 * The cells table (§5.1's sibling for an `.scool`).
 *
 * One row per cell, and the columns are **discovered**, exactly as the genomes
 * table's are: `name`, `nnz` and `sum` are guaranteed because every cooler
 * writes them, and anything else a writer put on its cells that actually
 * *differs* between them comes through as a column of its own.
 *
 * Attributes that are the same on every cell are dropped rather than shown.
 * They describe the file — its bin size, its storage mode, the cooler that
 * wrote it — and a column repeating one value four thousand times is a column
 * that cannot be sorted, cannot be filtered, and pushes the two that can off
 * the side of the screen. The info panel is where a file-level fact belongs.
 */
export interface CellsResult {
  table: TablePayload
  /** Row indices currently summed into the map, as offsets into `table`. */
  selected: Int32Array
}

/** What changed when a reader ticked a different set of cells. */
export interface CellsSelectedResult {
  /** The resolved set, in file order — deduplicated and validated. */
  names: string[]
  /** Stored pixels the new set will walk; the read-cost forecast. */
  nnz: number
  /** Value columns every cell of the new set offers. */
  scoreColumns: string[]
}

/**
 * The `/bins` columns a file carries — names and kinds, never a value (§8.12).
 *
 * Names and dtypes only, which is what makes it safe to ask while a file is
 * being opened for a drop-down that may never be opened: §3.3's rule is that
 * `/bins` is never *read*, and a group listing reads nothing. `[]` for a file
 * with no `/bins` group at all, which is every `.hic`.
 */
export interface BinColumnsResult {
  columns: Array<{ name: string; text: boolean }>
}

/** One `/bins` column over the bin range that was asked for. */
export interface BinColumnResult {
  column: string
  /** The half-open bin range these values cover, clamped to the file. */
  from: number
  to: number
  /** One of the two, according to what is on disk. */
  values?: Float64Array
  text?: string[]
}

/** One labelled run along an axis of a rendered block, in block-local offsets. */
export interface AxisGroup {
  /**
   * Every sequence in this stretch of the axis, where a cell holds more than
   * one.
   *
   * A cell is at most a capacity of bins and never part of one sequence beside
   * anything else — but sequences too small to fill a cell do share, and then
   * the axis is labelled with the first of them and the rest are invisible. This
   * is where they are: the readout names them, and the sequence list beside the
   * map offers all of them rather than every other one.
   *
   * Absent for the ordinary group, which is one sequence however many cells it
   * spans. A sequence longer than the capacity has several, and listing it once
   * per cell is how it came to appear twice in a list of names.
   */
  merged?: Array<{ label: string; unitLength: number }>
  label: string
  /** First row/column of the group within the block. */
  start: number
  /** One past the last row/column of the group within the block. */
  end: number
  /**
   * Absolute bin index at which this group's contig (or genome) *itself*
   * begins, which is not in general the bin the block begins at.
   *
   * `start` is block-local, so `(offset - start) * binsize` measures from the
   * left edge of the picture. That is the same thing as a position in the
   * contig only when the block starts on a contig boundary — true for a genome
   * view and for a whole contig, false for `contig:start-end`, where the block
   * begins at `chrom_offset[c] + floor(start / binsize)` and the readout
   * restarted at zero. A base-pair position is
   * `(rowExtent[0] + offset - unitStart) * binsize`.
   *
   * Absent above bin level, where a cell *is* a whole contig or genome and has
   * no position inside anything.
   */
  unitStart?: number
  /**
   * The absolute bin this group's contig begins at, as an **identity**.
   *
   * Distinct from {@link unitStart}, which is an arithmetic *origin*, and the
   * two are only the same number on a dense block. A coarsened axis is measured
   * in cells anchored to the contig, so its origin depends on where that axis's
   * own block opens — which makes it useless for the one other question an
   * axis run is asked, "is the other axis the same sequence as this one".
   * `contig × the same contig` over two different windows gets two different
   * origins and one `unitBin`, and the genomic distance across such a cell is
   * exactly what needs to tell them apart (`MatrixPanel.separationOf`).
   *
   * A number rather than the name because a metagenome may hold two `contig_1`s
   * in two MAGs. Absent above bin level, where a cell is a whole sequence.
   */
  unitBin?: number
  /**
   * Length of this group's contig in base pairs, where it is a contig.
   *
   * Only the reader knows it, and only it can answer the question a selection
   * asks at the end of a sequence: the last bin of a contig is usually partial,
   * so `bins * binsize` overshoots the sequence — by up to one bin — and a
   * region built from that arithmetic is refused as out of bounds by the very
   * parser that would open it. Sent so the UI can clamp to the truth rather
   * than to a multiple of the bin size.
   */
  unitLength?: number
}

export interface MatrixResult {
  nrows: number
  ncols: number
  /**
   * Names this read answered that this file does not itself write (§5.9).
   *
   * A ticked selection resolves its names the same way a region does, and it
   * has to *report* the same way too: a selection view drawn from names matched
   * across conventions and saying nothing is precisely the silent rename the
   * region path was built to prevent. Absent — not empty — where nothing was
   * matched, which is every read of a file in its own vocabulary.
   */
  matched?: NameMatch[]
  /** Row-major, `nrows * ncols` long. Transferred, not copied. */
  values: Float32Array
  rowExtent: Extent
  colExtent: Extent
  /** Contig (or genome) runs along each axis, for separators and tick labels. */
  rowGroups: AxisGroup[]
  colGroups: AxisGroup[]
  /**
   * The genome each stretch of the axis belongs to — the coarser structure over
   * {@link rowGroups}, in the same offset space.
   *
   * Two levels of structure exist in a contig × contig picture and both are
   * wanted at once, which is why this does not replace `rowGroups`: the pointer
   * is over a contig, and that contig is in a genome, and a reader looking at a
   * whole metagenome needs to be told which.
   *
   * Present only where the axis *is* contigs of a file that has genomes. Absent
   * for a plain cooler, and absent when the axis is already genomes.
   */
  rowGenomes?: AxisGroup[]
  colGenomes?: AxisGroup[]
  /**
   * Whether the genome runs above are the boundaries to *draw*.
   *
   * Naming and drawing are separate decisions, and two pictures want both,
   * because in both the subject is genomes. The whole-metagenome overview: there
   * 20,000 contig hairlines over 4,000 genome blocks is a grey wash that hides
   * the block structure the view exists to show, so the genome runs become the
   * separators and the axis labels. And a **selection of several genomes**,
   * which is the same picture of a chosen few — ticking four MAGs asks for four
   * blocks, and their two thousand contigs are the wash again.
   *
   * Everywhere else the genome is a fact for the tooltip and the contigs keep
   * the lines: a whole-genome view of a metacool is still read contig by contig,
   * a selection of *contigs* is a picture of the contigs that were ticked, and
   * one genome on its own has nothing coarser than its own contigs to show.
   */
  genomeBoundaries?: boolean
  level: 'bin' | 'contig' | 'genome'
  /**
   * The sequence this block was read round, where it was read round one.
   *
   * Present only on a wrapped read (see the `matrix` request's `wrap`), and it is
   * what tells the view that `rowExtent` and `colExtent` are **unwrapped** — that
   * they may run off either end of the sequence, and that a bin of them is a bin
   * of the file only after being taken modulo this. In bins of the open map, like
   * the extents beside it.
   *
   * The axis runs need no such warning, because they already carry the answer:
   * a run's `unitStart` is shifted a lap per revolution, which is what makes the
   * second stretch of a junction-crossing block say *this is the beginning of the
   * sequence, one lap along* rather than *this is somewhere past its end*.
   */
  wrapped?: Extent
  /**
   * Bins summed into one cell, where the block was read at a coarser bin size
   * than the file stores (`metacooler/pooling.ts`). Absent, or 1, for the
   * ordinary read.
   *
   * The axes are then *bins of that coarser grid*: a cell is `binsPerCell` bins
   * of one contig, a run of cells is that contig, and every coordinate the UI
   * computes is right if it multiplies the file's bin size by this. Reported
   * rather than assumed, so the picture and the summary above it cannot claim
   * two different resolutions.
   */
  binsPerCell?: number
  /**
   * The bin size of the map this block was actually read from, where that is
   * not the open one.
   *
   * Present only for a cross-rung read (`WorkerRequest`'s `rung`). The effective
   * resolution on screen is this times {@link binsPerCell}, and a caller that
   * assumed the open map's bin size would label a 5 kb picture as a 1 kb one —
   * which is the one number a methods section quotes.
   */
  binsize?: number
  /**
   * The window that was asked for, in bins of the map that is **open**.
   *
   * Present only for a cross-rung read, and present because bin indices are not
   * comparable across levels: `rowExtent` describes the block on the rung's own
   * grid — which is what the axes, the runs and every coordinate on screen are
   * built from — while a caller deciding *what to ask for next* is working in
   * the space it asked in. Without this the two silently disagree, and a zoom
   * that had just read a coarse rung would compute its next window against that
   * rung's indices as though they were the open map's.
   */
  source?: { rows: Extent; cols: Extent }
  /**
   * Whole sequences summed into one cell, where the axis had more of them than
   * the picture has pixels. Absent, or 1, for every axis with room for a cell
   * per sequence — which is every cooler and most assemblies.
   *
   * Above 1 the axis is no longer one of positions: a cell is a named set of
   * sequences, `binsPerCell` says nothing about it, and the view labels it as
   * sequences rather than as base pairs. A cell still never holds part of a
   * sequence, which is the property that makes the picture readable at all
   * (`metacooler/pooling.ts`).
   */
  contigsPerCell?: number
  /**
   * Sequences on each axis, as against cells.
   *
   * The two part company exactly when {@link contigsPerCell} is above one: an
   * axis run is one *cell's* name, so counting runs then counts cells, and a
   * summary saying "4,885 bins across 2,441 contigs" of a 4,882-contig genome
   * reports the pooling as though it were the assembly.
   */
  rowContigs?: number
  colContigs?: number
}

export interface OverviewResult {
  /** Whether the axes are genomes or contigs. */
  level: 'genome' | 'contig'
  /** Axis names, `__unbinned__` and its contigs excluded (§7.3, §7.4). */
  labels: string[]
  /**
   * The genome each axis entry belongs to, at contig level only.
   *
   * A contig × contig picture of a whole metagenome is read *by genome* — the
   * question is which bins hold together — so the boundaries worth drawing are
   * the genome ones, not one per contig. The labels stay per contig, because
   * that is what the pointer is over.
   */
  groups?: string[]
  /**
   * The plain name of the unit each slot *starts* at.
   *
   * Distinct from {@link labels}, which carries the "+15" that tells a reader a
   * row is pooled. This one is what a click resolves to — a real contig or
   * genome the app can open — so the display string and the navigation target
   * never have to be recovered from one another by parsing.
   */
  unitNames: string[]
  /** Row-major `n × n`. */
  values: Float32Array
  n: number
  /** Whether the numbers came from a full pixel scan or a sidecar edge list. */
  source: 'scan' | 'edge-list'
  /**
   * `true` when consecutive units share an axis slot.
   *
   * Note what this is *not*: units are never dropped. Every displayable unit
   * contributes to exactly one slot, so a pooled overview is a coarser picture
   * of the whole file rather than a sharp picture of part of it. The field it
   * replaces, `restricted`, meant the opposite — that the axis had been cut to
   * the densest few and the rest discarded.
   */
  pooled: boolean
  /** Mean units per slot; `1` when nothing is pooled. */
  unitsPerSlot: number
  /** Displayable units at this level — the number actually represented. */
  totalUnits: number
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
  cells: CellsResult
  selectCells: CellsSelectedResult
  binColumns: BinColumnsResult
  binColumn: BinColumnResult
  range: ParsedRange
  matrix: MatrixResult
  aggregate: MatrixResult
  selection: MatrixResult
  overview: OverviewResult
  overviewSidecar: OverviewResult
  validateDeep: DeepValidation
  stats: StatsResult
  exportMcool: McoolExport
  cancel: null
  close: null
}

export type RequestKind = keyof ResultMap

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The session's cell cap, stamped onto **every** request by the client.
 *
 * A worker cannot work this out for itself: the cap is read from the page's
 * URL or its `localStorage` (`render/rasterCap.ts`) and a worker has neither,
 * so its own module-load value is always the default. Carried on the request
 * rather than sent as an init message because there is no moment at which a
 * one-shot would be reliably earlier than the first read — a blob-URL worker in
 * the standalone build is constructed and messaged in the same tick — and a
 * field every request carries cannot arrive second.
 *
 * Optional, and absent means the default: a request built by hand in a test
 * says nothing about caps, and should not have to.
 */
export interface SessionCap {
  cellCap?: number
}

export type WorkerRequest = WorkerRequestBody & SessionCap

type WorkerRequestBody =
  | { id: number; kind: 'open'; uri: string; source: SourceSpec; binning?: PairsBinning }
  // Build the `.mcool` for the pairs import this session was opened from.
  // Separate from `open` because it is a second long job with its own
  // progress and its own cancel, and because a reader who cancelled the
  // download still has the map.
  | { id: number; kind: 'exportMcool' }
  | { id: number; kind: 'genomes' }
  | { id: number; kind: 'contigs' }
  | { id: number; kind: 'cells' }
  /**
   * Change which cells the open map sums (§3.8).
   *
   * A cell set is not part of the URI — `file.scool::/cells/one` addresses one
   * cell as a plain cooler, and there is no group path that means *these eight*
   * — so it is state on the open map, swapped here rather than by re-opening.
   * The swap costs one small index read per cell and no re-mount.
   *
   * `null` is every cell, which is what an scool with nothing ticked shows.
   */
  | { id: number; kind: 'selectCells'; names: string[] | null }
  | { id: number; kind: 'binColumns' }
  // One `/bins` column over the bins a picture actually covers (§8.12). The
  // range is the caller's because the caller is the side that knows what is on
  // screen; it is clamped here, so a block that runs past the last bin asks for
  // a slice rather than an error.
  | { id: number; kind: 'binColumn'; column: string; from: number; to: number }
  | {
      id: number
      kind: 'range'
      range: string
      rung?: string
      /**
       * The naming context of the file the range string came **out of**.
       *
       * Two booleans, and they travel because a name cannot carry them: `X` is
       * chromosome ten in a file counting `I`…`XVI` and the sex chromosome
       * everywhere else, and only the list it was written in can say which
       * (§5.9). A companion following a lead of another nomenclature is the
       * whole reason this field exists; a session of one file never sets it.
       */
      naming?: NameContext
      /**
       * Sequences the reader has declared circular, in **this file's** spelling
       * (§8.15).
       *
       * Sent because nothing in a `.cool` can say it and this worker therefore
       * cannot know it: the declaration is the reader's, made in the Chromosomes
       * table and kept per file on the main thread. It changes exactly one
       * answer here — a range whose end is below its start is a typo on a line
       * and the window across the origin on a circle — so it travels with the
       * range rather than being mounted with the file, and a request that omits
       * it gets cooler's own refusal.
       */
      circular?: readonly string[]
    }
  // `balance` multiplies each cell by its two bin weights, which is cooler's
  // own definition of a balanced matrix (§6.4). Off by default, matching
  // `metacooler show`, and offered only when the file carries the column.
  // `genomes` asks for the genome each stretch of the axes belongs to, for the
  // tooltip. Off by default: it costs a walk over the block's bins and a run
  // encoding, and every view but the whole-genome one already knows the answer
  // from the view it is — a genome view is one genome, a region view is one
  // contig of one.
  // `binsPerCell` reads the block at a coarser bin size: every N consecutive
  // bins of a contig summed into one cell, accumulated from the stored pixels
  // rather than from a block that would have to exist first
  // (`metacooler/pooling.ts`). 1 or absent is the ordinary dense read. The
  // caller chooses it because the caller is what has to label the axes in the
  // matching units, and one number cannot be derived twice and agree.
  | {
      id: number
      kind: 'matrix'
      /**
       * Read from a **sibling rung** of the collection this file is in, rather
       * than from the map that is open (§3.4, §9).
       *
       * The entry's own name — `2000` under `/resolutions`, whatever an
       * `.mmetacool` calls it under `/entries` — as `OpenResult.entries` lists
       * them. Absent is the open map, which is every request that is not a
       * zoom-driven one.
       *
       * `rows` and `cols` stay **bins of the open map** even when this is set,
       * and the worker converts. That is not a convenience: bin indices are not
       * comparable across rungs — each level has its own `chrom_offset` and its
       * own short last bin per sequence — so a caller converting for itself
       * would need every rung's tables, which is the reader's side of the wall.
       * Converting here means one round trip and one implementation.
       *
       * A coarse rung is read rather than pooled for two reasons, and the second
       * is the one that matters: it walks fewer stored pixels for the same
       * picture, and its balanced values are *balanced at that resolution*
       * rather than summed — which is what `cooler zoomify --balance` produces
       * and what summing a fine level cannot approximate (§6.4).
       */
      rung?: string
      rows: Extent
      cols?: Extent
      /**
       * Read `rows` and `cols` as positions on a **circle** whose bins are this
       * extent (SPECS §8.15).
       *
       * With it, the two extents are *unwrapped*: they may run off either end of
       * the sequence and are resolved modulo it, so a window across the junction
       * is up to four stored blocks assembled into one — see `worker/wrap.ts` for
       * the two coordinate spaces and why the request is written in the one that
       * runs off the ends.
       *
       * The sequence's own extent, in bins of the **open** map, exactly as `rows`
       * and `cols` are: the worker converts both together when a rung is named.
       * Absent is every ordinary read, and a window that happens to fall entirely
       * inside the sequence takes the ordinary path whether this is set or not —
       * same bins, same block, same grid.
       */
      wrap?: Extent
      balance?: boolean
      /** `/pixels` column the values come from; `count` when absent. */
      value?: string
      budgetBytes?: number
      genomes?: boolean
      binsPerCell?: number
      contigsPerCell?: number
    }
  | {
      id: number
      kind: 'aggregate'
      rows: Extent
      cols?: Extent
      level: 'contig' | 'genome'
      balance?: boolean
      /** `/pixels` column the values come from; `count` when absent. */
      value?: string
      budgetBytes?: number
      genomes?: boolean
    }
  // One map of several chosen sequences: their own maps on the diagonal and
  // everything between them off it. Named rather than given as bin extents,
  // because the names are what the URL carries and what the axis is labelled
  // with — resolving them in the worker keeps one answer to "which bins is
  // `MAG_7`", the reader's.
  | {
      id: number
      kind: 'selection'
      unit: 'genome' | 'contig'
      names: string[]
      /**
       * The naming context of the file the names came out of — see the `range`
       * request, which carries it for the same reason. A ticked selection is a
       * shared view exactly as a region is, so it has to cross nomenclatures
       * exactly as one does (§5.9).
       */
      naming?: NameContext
      balance?: boolean
      /** `/pixels` column the values come from; `count` when absent. */
      value?: string
      binsPerCell?: number
      contigsPerCell?: number
      /**
       * Ceiling on the dense block this read may build, as `matrix` takes one.
       *
       * A selection is already capped at `pooledCellCap()²` cells whatever the
       * file's size, so this is not what stops a runaway read — it is what lets a
       * *deck* divide that ceiling. Six panels each entitled to the whole cap is
       * six times the one block the guard was written for (§16.7), and the
       * selection path was the one request kind with no way to say so.
       */
      budgetBytes?: number
    }
  | { id: number; kind: 'overview'; level?: 'genome' | 'contig'; maxUnits?: number }
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
  // Unsolicited, and the only message here that answers no request: the worker
  // saying how busy it has been. It carries no id because there is nothing to
  // correlate it with — the status bar's CPU figure is about the thread, not
  // about any one read (see `perf/busy.ts`).
  | { type: 'busy'; fraction: number }

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
      // A table's string column is 154,468 entries, and a string cannot hold a
      // buffer — so recursing into one was 1.5 M `typeof` checks per contigs
      // response looking for something that cannot be there.
      if (value.length === 0 || typeof value[0] !== 'object') return
      for (const item of value) visit(item)
      return
    }
    for (const item of Object.values(value as Record<string, unknown>)) visit(item)
  }
  visit(payload)
  return out
}
