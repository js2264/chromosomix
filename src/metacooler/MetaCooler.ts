/**
 * The reader (spec §6): a read-only JS mirror of the Python `MetaCooler`.
 *
 * Same names, same semantics, same errors, no new concepts. Where this file
 * and `metacooler/api.py` disagree, this file is wrong.
 *
 * What `open` reads, and nothing more (§3.2): the root attributes **once**, the
 * `/genomes` and `/contigs` columns the *reader* uses, and the two small offset
 * arrays. Never `/pixels/*`, never `indexes/bin1_offset` (one entry per bin —
 * sliced on demand), and never `/bins` at all (§3.3).
 *
 * "The columns the reader uses" is a narrowing of §3.2's "all columns", and it
 * is a large one: on the reference file the optional `/contigs` metadata is 72%
 * of the whole open's HDF5 bytes, for a table view the user may never open.
 * {@link MetaCooler.fullContigs} and {@link MetaCooler.fullGenomes} read the
 * rest when that view actually opens, which is the only place it is shown.
 */

import { UNBINNED_NAME } from '../constants'
import type { StorageMode } from '../constants'
import { MetaCoolerFormatError, truncateNames, ViewerError } from '../errors'
import { pyRepr } from '../format'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import { NameIndex } from '../genome/naming'
import { openHdf5 } from '../h5/Hdf5File'
import { dtypeKind } from '../h5/typed'
import { makeTable } from '../h5/readTable'
import type {
  ByteSource,
  Column,
  DenseMatrix,
  Extent,
  Info,
  Layout,
  MatrixQuery,
  PixelChunk,
  Table,
} from '../types'
import {
  aggregateMatrix,
  pixelAccumulator,
  sparseAggregator,
  type AggregatedMatrix,
  type AggregationLevel,
} from './aggregate'
import { Coords } from './coords'
import {
  poolBins,
  POOLED_CELL_CAP,
  selectionPooling,
  type BinPooling,
  type PoolPlan,
} from './pooling'
import {
  assertAcceptable,
  cellPath,
  detectLayout,
  extractMetadata,
  normaliseInfo,
  scoolGeometry,
  willListCells,
} from './detect'
import {
  DEFAULT_WEIGHT_COLUMN,
  DENSE_HINTS,
  type SpanScanOptions,
  planRead,
  readDenseMatrix,
  resolveCountKind,
} from './matrix'
import { CoolerStore, type PixelStore, type ScanAllOptions } from './store'
import { resolveCells, ScoolStore } from './scool'
import { HicFile } from '../hic/HicFile'
import { isHicMagic } from '../hic/format'
import { hicHandle } from '../hic/handle'
import { HicStore } from '../hic/store'
import type { BinnedPixels } from '../pairs/bin'
import { isPairsFile, readPairsHeader, type PairsHeader } from '../pairs/format'
import { isGzip as isGzipMagic } from '../pairs/stream'
import { pairsHandle } from '../pairs/handle'
import { PairsStore } from '../pairs/store'
import { parseRegion, regionToExtent } from './range'
import { parseUri } from '../uri'

/** Columns `schema.validate` requires; absence is a format error, not a crash. */
const REQUIRED_GENOME_COLUMNS = ['name', 'length', 'n_contigs', 'n_bins'] as const
/** What any cooler's chrom/contig table must carry. */
const REQUIRED_COOLER_COLUMNS = ['name', 'length'] as const

/**
 * The `/contigs` columns the *reader* uses, as against the ones a creator may
 * have joined in for the table view.
 *
 * `genome_id` is here for the metacool path and simply absent from a cooler's
 * `/chroms`, which is the same shape of absence the required-column check
 * already handles.
 */
const READER_CONTIG_COLUMNS = ['name', 'length', 'genome_id'] as const

/** The `/genomes` columns the reader uses; the rest are the table view's. */
const READER_GENOME_COLUMNS = ['name', 'length', 'n_contigs', 'n_bins'] as const

/**
 * The attributes an scool's root may leave to its cells.
 *
 * Geometry only, and it is a whitelist rather than a merge for the reason
 * {@link MetaCooler.fromScool} gives: a cell's `nnz` and `sum` are that cell's,
 * and letting them stand as the container's would have the light validation
 * check one cell's pixel count against the whole selection's.
 */
const SCOOL_GEOMETRY_ATTRS = ['bin-size', 'bin-type', 'storage-mode'] as const

/** Cell-table columns that lead, and are shown even when every cell agrees. */
const CELL_TABLE_LEADING: readonly string[] = ['nnz', 'sum']

/**
 * Everything `MetaCooler` needs, already read.
 *
 * Split out from the constructor so a synthesised view — a plain cooler
 * built from something other than a metacool's four tables — a plain cooler,
 * which has two — can be constructed without this class growing a second
 * constructor.
 */
export interface MetaCoolerInit {
  uri: string
  handle: Hdf5Handle
  layout: Layout
  attrs: Record<string, AttrValue>
  contigs: Table
  /**
   * Where the pixels come from, when they do not come from this handle.
   *
   * Absent for every HDF5 file, which is the overwhelming majority and takes
   * {@link CoolerStore} by default. Supplied by {@link MetaCooler.fromHic},
   * which is the one caller whose pixels are indexed some other way.
   */
  store?: PixelStore
  /**
   * Where the *tables* come from, when they do not come from `handle`.
   *
   * One container needs this and it is the `.scool`: its root holds a set of
   * coolers rather than being one, so `/pixels` is not there to take a dtype
   * from and — in the flat layout — neither is `/chroms` or `/bins`. Those
   * questions are answered by a representative cell, which shares its bin space
   * with every other cell by construction.
   *
   * Deliberately **not** where weights come from. `bins/weight` stays on
   * `handle`, so a cell set is balanced by the *shared* bins or not at all
   * (`metacooler/scool.ts`). Absent for every other layout, where the two
   * handles are the same object.
   */
  tables?: Hdf5Handle
  /** `indexes/chrom_offset`, length `nContigs + 1`. */
  chromOffset: Float64Array
  /**
   * `/genomes`, or `undefined` for a plain cooler.
   *
   * Undefined rather than a synthesised one-row table: a cooler has no genomes,
   * and inventing one named after the assembly would put a row in the UI that
   * is not in the file, then require every genome path to special-case it. The
   * genome layer is simply absent, and the accessors say so.
   */
  genomes?: Table
  /** `indexes/genome_offset`, length `nGenomes + 1`; absent for a cooler. */
  genomeOffset?: Float64Array
}

/** Anything `MetaCooler.open` needs that is not the file or its bytes. */
export interface OpenOptions {
  /**
   * The reader has already agreed to what listing this file's cells costs.
   *
   * Set on the *second* open of a container over the network — the one made
   * with their answer to the §12 gate on the source — and it is what stops that
   * gate from asking the same question again forever. Choosing *download it
   * whole* changes the source's own answer to `isRemote` and would pass
   * regardless; choosing *small pieces* does not, and did not, which is the bug
   * this exists to have fixed rather than a defensive flag.
   */
  listingAgreed?: boolean
}

/** The §7.4 QC statistic: how much of the file binning failed to assign. */
export interface UnassignedStats {
  /** True genome index of `__unbinned__` — never renumbered away (§7.4). */
  genomeIndex: number
  contigs: number
  bins: number
  totalContigs: number
  totalBins: number
  /** Fraction in `[0, 1]`, or `0` when the denominator is 0. */
  contigFraction: number
  binFraction: number
}

/** Callbacks for {@link MetaCooler.scanPixels}. */
export interface ScanOptions {
  /** Pixels per chunk; `DEEP_PIXEL_CHUNK` in Python. */
  chunkSize?: number
  /** Called per chunk. Returning `false` stops the scan — this is the cancel. */
  onChunk(chunk: PixelChunk): boolean | void
  /** Cumulative and total pixel counts after each chunk. */
  onProgress?(done: number, total: number): void
}

/** Outcome of {@link MetaCooler.validateDeep}. */
export interface DeepValidation {
  ok: boolean
  problems: string[]
  /** What was actually checked — and, just as importantly, what was not. */
  note: string
}

export class MetaCooler {
  /** The URI this map was opened from, `file` or `file::group`. */
  readonly uri: string
  /** Which of the four layouts the file turned out to be. */
  readonly layout: Layout
  /**
   * Sibling names when this map lives inside a collection: the other maps of an
   * mmetacool (§3.4), or the other resolutions of an mcool (§9).
   */
  readonly entries: string[]
  /** The group those siblings live under — `entries` or `resolutions`. */
  readonly entryGroup: string
  /** The handle that answers table and pixel-shape questions — see `MetaCoolerInit.tables`. */
  private readonly tables: Hdf5Handle
  /** Normalised root attributes (`MetaCooler.info`). */
  readonly info: Info
  /** The optional user `metadata` object, `{}` when absent. */
  readonly metadata: Record<string, unknown>
  /**
   * `/genomes` with every column the creator wrote (spec §5.1), or `null` for a
   * plain cooler, which has no such table and is not pretending to.
   */
  readonly genomes: Table | null
  /** `/contigs` with every column the creator wrote. */
  readonly contigs: Table
  /** Uniform bin size in bp. Never `null` here — §3.2 refuses variable bins. */
  readonly binsize: number
  /** `symmetric-upper` or `square`, read from the attribute, never assumed. */
  readonly storageMode: StorageMode
  /** Dtype kind of `pixels/count`, resolved once (correction #2). */
  readonly countKind: 'i' | 'u' | 'f'
  /** Fixed-bin arithmetic over `chrom_offset` + `contigs/length` (§3.3). */
  readonly coords: Coords

  /** Contig names, in file order — cooler's `chromnames`. */
  readonly chromnames: string[]
  /**
   * Contig name → length in bp — cooler's `chromsizes`. Built on first use.
   *
   * Lazy because it is only ever consulted by name, and only by a *region*
   * selection: on a 154 k-contig file it is 7.3 MB of map built during the open,
   * before the landing table has painted, for a lookup many sessions never make.
   */
  get chromsizes(): Map<string, number> {
    this.chromsizeCache ??= new Map(this.chromnames.map((name, i) => [name, this.contigLengths[i]]))
    return this.chromsizeCache
  }

  /** Contig name → index. Lazy for the same reason as {@link chromsizes}. */
  private get contigIds(): Map<string, number> {
    this.contigIdCache ??= new Map(this.chromnames.map((name, i) => [name, i]))
    return this.contigIdCache
  }

  /**
   * This file's sequences, indexed by every convention that might name one.
   *
   * Lazy for {@link chromsizes}' reason and consulted for a narrower one: it is
   * only ever reached where a name has *already failed* to resolve strictly
   * (`parseMetacoolerRange`), which is to say when a second file with its own
   * spellings is in the room. A session of one file never builds it.
   */
  get names(): NameIndex {
    this.nameIndexCache ??= NameIndex.of(
      this.chromnames.map((name, i) => ({ name, length: this.contigLengths[i] })),
    )
    return this.nameIndexCache
  }
  /** Genome names, in file order, `__unbinned__` included; `[]` for a cooler. */
  readonly genomeNames: string[]
  /**
   * `contigs/genome_id`, one entry per contig, exactly as written. Public
   * because the aggregation path needs contig → genome and must never invent
   * its own mapping (§7.4: nothing is renumbered).
   *
   * Empty for a plain cooler: there is no mapping to carry, and a filled-in one
   * would be an invention the aggregation path could not tell from real data.
   */
  readonly contigGenomeIds: Int32Array

  readonly handle: Hdf5Handle
  /**
   * The pixels, behind the one interface both containers implement.
   *
   * Public because `analysis/run/` walks pixels directly and must go through
   * the same seam the views do; see `metacooler/store.ts` for why the seam is
   * at the operation rather than at the dataset.
   */
  /**
   * Where the pixels come from.
   *
   * Behind a getter because one container replaces it: an `.scool` swaps the
   * store when the cell set changes ({@link selectCells}), and every reader of
   * it — `readDenseMatrix` through `MatrixSource`, the scans, the pooled
   * aggregations — must see the current one rather than a captured reference.
   */
  private pixelStore: PixelStore

  get store(): PixelStore {
    return this.pixelStore
  }
  private readonly chromOffset: Float64Array
  private readonly genomeOffset: Float64Array
  private readonly genomeIds: Map<string, number>
  private closed = false
  /** Memoised full-width tables; see {@link fullContigs}. */
  private fullContigTable: Table | null = null
  private fullGenomeTable: Table | null = null
  /** Built on the first lookup by name; see {@link contigIds}. */
  private contigIdCache: Map<string, number> | null = null
  private chromsizeCache: Map<string, number> | null = null
  private nameIndexCache: NameIndex | null = null
  /** `indexes/bin1_offset`, read whole on first use; see {@link binOffsets}. */
  private readonly contigLengths: Float64Array

  /**
   * Open a map from a byte source.
   *
   * The source is the only thing that differs between a local drag-and-drop
   * and a remote range-request file (§6.1); everything below this line is
   * identical for both.
   */
  static async open(
    uri: string,
    source: ByteSource,
    options: OpenOptions = {},
  ): Promise<MetaCooler> {
    // Mounted first so the sniff below has a byte accessor in every backing —
    // a path-backed source resolves its filesystem at mount and has nowhere
    // else to await one. Idempotent, and `openHdf5` reuses the same mount.
    await source.mount()
    // Four bytes decide the container. Asked before HDF5 is asked anything at
    // all, because a `.hic` is not an HDF5 file and h5wasm's refusal of one is
    // a stack trace rather than the sentence §10 requires.
    if (isHicMagic(source.readBytes(0, 4))) return MetaCooler.fromHic(uri, source)
    // A `.pairs` is a *third* container and the only one that cannot be opened
    // from its own bytes alone: it declares no resolution, so there is nothing
    // to open it *at* until a reader has chosen one. The refusal carries what
    // the choice needs — see `pairs/import.ts` — and the worker turns it into a
    // dialog. Asked here rather than in the worker so every entry point (the
    // CLI, a test) gets the same sentence instead of an HDF5 stack trace.
    if (await isPairsFile(source)) {
      const header = await readPairsHeader(source)
      throw new ViewerError(
        'pairs-binning-needed',
        'This is a .pairs file: a list of contacts with no resolution of its own. Choose a ' +
          'bin size to build a map at.',
        {
          contigs: header.contigs.length,
          assembly: header.assembly,
          sorted: header.sorted,
        },
      )
    }
    // A gzip that is *not* a pairs file is refused here rather than handed on.
    // HDF5 cannot read a compressed file in any case, and what it does instead
    // is worth pre-empting: h5wasm answers a request for the root attributes of
    // a non-HDF5 file with `error - name not defined!`, which is neither the
    // sentence §10 requires nor recognisably about the file the reader dropped.
    if (isGzipMagic(source.readBytes(0, 2))) {
      throw new ViewerError(
        'not-hdf5',
        'This file is gzip-compressed. HDF5 is read in place and cannot be decompressed on ' +
          'the fly, so a .cool, .mcool or .metacool must be decompressed first. A .pairs.gz ' +
          'is read compressed — but this one carries no `## pairs format` line, so it is not ' +
          'one.',
        {},
      )
    }
    // The group comes from the URI, so `file.mmetacool::entries/rep1` and a
    // plain `file.metacool` reach the handle already resolved (§3.5).
    const handle = await openHdf5(uri, source, parseUri(uri).group)
    try {
      if (options.listingAgreed !== true) assertListingAffordable(handle, source)
      return MetaCooler.fromHandle(handle)
    } catch (error) {
      handle.close()
      throw error
    }
  }

  /**
   * Open a `.hic` as one of these.
   *
   * The three lines of translation are all there is, and that is the design
   * rather than an accident: `hic/handle.ts` answers the metadata questions a
   * cooler's HDF5 groups answer, `hic/store.ts` answers the pixel ones, and
   * this constructor is the only place in the repo that knows both exist. The
   * resulting object is a `MetaCooler` in every sense the rest of the
   * application uses the word.
   *
   * The resolution is named the way an mcool's is — `file.hic::/resolutions/5000`
   * — so the entry picker, the URL hash, the refine ladder (§3.4) and a deck
   * descending to its lead's rung all work on a `.hic` without a line of their
   * own. A URI with no group opens the finest resolution the file carries,
   * which is what dropping one on the page means.
   */
  static fromHic(uri: string, source: ByteSource): MetaCooler {
    const { group } = parseUri(uri)
    const named = /^\/resolutions\/(\d+)$/.exec(group)
    const file = HicFile.open(source, named === null ? {} : { binSize: Number(named[1]) })
    if (!file.hasAnyMatrix()) {
      throw new ViewerError(
        'unsupported',
        `This .hic carries no base-pair matrix at ${file.binSize} bp. Its resolutions are ` +
          `${file.resolutions.join(', ')}.`,
        { binSize: file.binSize, resolutions: file.resolutions },
      )
    }
    const handle = hicHandle(uri, file)
    const attrs = handle.attrs()
    return new MetaCooler({
      uri,
      handle,
      layout: {
        kind: 'hic',
        group,
        entries: file.resolutions.map((size) => String(size)),
      },
      attrs,
      contigs: handle.readTable('chroms'),
      chromOffset: handle.readNumeric('indexes/chrom_offset'),
      store: new HicStore(file),
    })
  }

  /**
   * Open one rung of an imported `.pairs` as one of these.
   *
   * The same three lines of translation a `.hic` gets, and for the same reason:
   * `pairs/handle.ts` answers the metadata questions, `pairs/store.ts` answers
   * the pixel ones, and this constructor is the only place in the repo that
   * knows both exist.
   *
   * Unlike every other constructor here, this one reads no bytes. The file was
   * read once, at import; what arrives is a pixel table and the header it came
   * from, and the resulting object is a `MetaCooler` in every sense the rest of
   * the application uses the word — including the fourteen analysis tasks,
   * which cannot tell the difference and are not told.
   *
   * The rung list is spelled the way an mcool's resolutions are, so the entry
   * picker, the URL hash, §3.4's refine ladder and a deck descending to its
   * lead's rung all work with no code of their own.
   */
  static fromPairs(init: {
    uri: string
    header: PairsHeader
    pixels: BinnedPixels
    rungs: number[]
    indexed: boolean
    declaredRecords?: number | null
  }): MetaCooler {
    const handle = pairsHandle({
      uri: init.uri,
      header: init.header,
      pixels: init.pixels,
      rungs: init.rungs,
      indexed: init.indexed,
      declaredRecords: init.declaredRecords ?? null,
    })
    return new MetaCooler({
      uri: init.uri,
      handle,
      layout: {
        kind: 'pairs',
        group: `/resolutions/${init.pixels.binSize}`,
        entries: init.rungs.map((size) => String(size)),
      },
      attrs: handle.attrs(),
      contigs: handle.readTable('chroms'),
      chromOffset: handle.readNumeric('indexes/chrom_offset'),
      store: new PairsStore(init.pixels),
    })
  }

  /**
   * Open an `.scool` as one cooler over a set of its cells (§3.7).
   *
   * The file is a container of coolers sharing one bin space, so the object
   * this returns is a `MetaCooler` in the same full sense a `.hic` is: the
   * coordinate system comes from the cells' shared tables and the pixels come
   * from {@link ScoolStore}, which sums the selected set. Every view above it —
   * the chromosome table, a region, the whole map, the axis runs, the pooled
   * reads — works with no knowledge that a cell exists.
   *
   * `cells` is the ticked set, or `null` for **all of them**. All is what a file
   * dropped and pressed on through means: an scool with nothing chosen is the
   * pseudo-bulk of everything in it. It is also the expensive one, which is why
   * the count is on {@link OpenResult} and gated in the caller rather than here
   * — the reader refuses nothing it was asked for.
   *
   * ## Where each table comes from
   *
   * A **representative cell**, in both layouts and for both tables. The
   * standard container hard-links `/chroms` and `/bins` into every cell from
   * the root, so reading a cell's is reading the root's; the flat one has
   * nothing at its root to read. One path, and it is correct for both.
   *
   * The attributes are the other way round: the root's win, and the cell's fill
   * the gaps. A standard root states the geometry it has a `/bins` to describe;
   * a flat root states only provenance, and the geometry is inside the cells.
   * Whitelisted rather than merged wholesale, because a cell's `nnz` and `sum`
   * describe *that cell* and would be validated here against the whole set.
   */
  static fromScool(
    handle: Hdf5Handle,
    layout: Layout,
    attrs: Record<string, AttrValue>,
    cells: readonly string[] | null,
  ): MetaCooler {
    const names = resolveCells(layout.entries ?? [], cells)
    // The representative is the file's first cell, not the selection's: it
    // answers questions about the *shared* bin space, which every cell agrees
    // on, and pinning it to the file rather than the selection keeps the
    // coordinate system identical as the ticks change.
    const representative = handle.at(cellPath(layout, (layout.entries ?? [])[0]))
    const geometry = scoolGeometry(handle, layout, attrs).attrs
    const merged: Record<string, AttrValue> = { ...attrs }
    for (const key of SCOOL_GEOMETRY_ATTRS) {
      if (merged[key] === undefined && geometry[key] !== undefined) merged[key] = geometry[key]
    }
    const chromOffset = representative.readNumeric('indexes/chrom_offset')
    const countKind = resolveCountKind(representative.dtype('pixels/count'))
    const nBins = Number(chromOffset[chromOffset.length - 1] ?? 0)
    return new MetaCooler({
      uri: handle.uri,
      handle,
      tables: representative,
      layout,
      attrs: merged,
      contigs: representative.readTable('chroms', undefined, undefined, READER_CONTIG_COLUMNS),
      chromOffset,
      store: new ScoolStore(handle, layout, names, nBins, countKind),
    })
  }

  /**
   * Build a map from an already-open handle: detect, gate, then read the four
   * small things §3.2 allows.
   *
   * @throws ViewerError from {@link detectLayout} (`not-a-cooler`) or
   *   {@link assertAcceptable} (`mmetacool-root`, `mcool-root`,
   *   `bad-format-version`, `bad-ordering`, `variable-bins`), and
   *   MetaCoolerFormatError for a metacool missing `indexes/genome_offset`.
   */
  static fromHandle(handle: Hdf5Handle): MetaCooler {
    // Read **once**. Three enumerations of the root attribute block cost three
    // wasm round trips per fixed-length string attribute, for a set of values
    // that cannot change between them.
    const attrs = handle.attrs()
    const layout = detectLayout(handle, attrs)
    assertAcceptable(handle, layout, attrs)

    // A plain cooler — including one resolution of an mcool — is opened as
    // itself: its `/chroms` is the contig table, and there is no genome layer
    // to read. Everything below this point is bin arithmetic over
    // `chrom_offset` and contig lengths, which is the same in both files.
    if (layout.kind === 'scool') return MetaCooler.fromScool(handle, layout, attrs, null)

    if (layout.kind !== 'metacool') {
      return new MetaCooler({
        uri: handle.uri,
        handle,
        layout,
        attrs,
        contigs: handle.readTable('chroms', undefined, undefined, READER_CONTIG_COLUMNS),
        chromOffset: handle.readNumeric('indexes/chrom_offset'),
      })
    }

    if (!handle.has('indexes/genome_offset')) {
      throw new MetaCoolerFormatError('indexes/genome_offset is missing')
    }
    return new MetaCooler({
      uri: handle.uri,
      handle,
      layout,
      attrs,
      genomes: handle.readTable('genomes', undefined, undefined, READER_GENOME_COLUMNS),
      contigs: handle.readTable('contigs', undefined, undefined, READER_CONTIG_COLUMNS),
      chromOffset: handle.readNumeric('indexes/chrom_offset'),
      genomeOffset: handle.readNumeric('indexes/genome_offset'),
    })
  }

  /**
   * `/contigs` (or `/chroms`) with **every** column the creator wrote — the
   * table the contigs *view* shows, read when that view opens.
   *
   * Opening a file does not need them. On the reference file the optional
   * metadata columns are 72% of the whole open's HDF5 bytes, decoded before the
   * landing table has painted, for a view the user may never reach. Memoised,
   * because the view is reached by navigation and comes back.
   */
  fullContigs(): Table {
    this.fullContigTable ??= this.tables.readTable(
      this.layout.kind === 'metacool' ? 'contigs' : 'chroms',
    )
    return this.fullContigTable
  }

  /** `/genomes` with every column the creator wrote; `null` for a cooler. */
  fullGenomes(): Table | null {
    if (this.genomes === null) return null
    this.fullGenomeTable ??= this.handle.readTable('genomes')
    return this.fullGenomeTable
  }

  constructor(init: MetaCoolerInit) {
    this.uri = init.uri
    this.handle = init.handle
    this.tables = init.tables ?? init.handle
    this.layout = init.layout
    this.entries = init.handle.rootEntries
    this.entryGroup = init.handle.rootEntryGroup
    this.genomes = init.genomes ?? null
    this.contigs = init.contigs
    this.chromOffset = init.chromOffset
    this.genomeOffset = init.genomeOffset ?? new Float64Array(0)

    this.info = normaliseInfo(init.attrs)
    this.metadata = extractMetadata(init.attrs)
    this.storageMode = this.info['storage-mode']

    const binsize = this.info['bin-size']
    if (binsize === null || binsize <= 0) {
      // Unreachable through `fromHandle` — the §3.2 gate ran first — but a
      // synthesised init could get here, and a zero bin size would turn every
      // coordinate formula into a division by zero rather than an error.
      throw new MetaCoolerFormatError(
        `attrs['bin-size'] must be positive, got ${pyRepr(binsize)}`,
        { 'bin-size': binsize },
      )
    }
    this.binsize = binsize

    this.chromnames = this.contigs.strings('name')
    this.genomeNames = this.genomes === null ? [] : this.genomes.strings('name')
    // `numbers()` materialises a plain JS array first — 1.5 MB of throwaway per
    // call at 154 k contigs, twice. The column is already a `Float64Array` off
    // the decoder, so the typed-array constructor converts it in one pass with
    // nothing in between.
    const contigLengths = toFloat64(this.contigs, 'length')
    this.contigGenomeIds =
      this.genomes === null ? new Int32Array(0) : toInt32(this.contigs, 'genome_id')
    this.coords = new Coords(this.binsize, this.chromOffset, contigLengths)

    this.contigLengths = contigLengths
    this.genomeIds = new Map()
    for (let i = 0; i < this.genomeNames.length; i++) this.genomeIds.set(this.genomeNames[i], i)

    this.countKind = resolveCountKind(this.tables.dtype('pixels/count'))
    // After `countKind` and after `chromOffset`, because the default store is
    // built from both. A supplied one already knows its own answers.
    this.pixelStore = init.store ?? new CoolerStore(this.handle, this.nBins, this.countKind)
    this.validateLight()
  }

  // -------------------------------------------------------------------------
  // Shape and identity
  // -------------------------------------------------------------------------

  /**
   * `true` when this file has a genome layer — a metacool.
   *
   * The one thing callers branch on. A plain cooler answers `0`, `[]` and
   * `null` from every genome accessor below rather than throwing, so the
   * difference shows up as an empty list in the UI and not as an error screen.
   */
  get hasGenomes(): boolean {
    return this.genomes !== null
  }

  /**
   * `true` when `/bins/weight` exists — the file has been balanced.
   *
   * One `has` on a dataset path, no read. The UI offers the balance toggle only
   * when this is true, so "balanced" is never an option that then fails.
   */
  get hasWeights(): boolean {
    return this.handle.has(`bins/${DEFAULT_WEIGHT_COLUMN}`)
  }

  /**
   * The `/pixels` value columns this file carries, `count` first.
   *
   * One `keys` call on a group, no read. What it is *for* is the score picker:
   * cooler fixes three columns and lets a file carry more, and a viewer that
   * assumed `count` could not show the others at all — so a file that had gone
   * to the trouble of storing an expected value, a second normalisation or a
   * per-pixel significance had no way of saying so.
   */
  get scoreColumns(): string[] {
    return this.store.scoreColumns()
  }

  /** Number of genomes, `__unbinned__` included; `0` for a plain cooler. */
  get nGenomes(): number {
    return this.genomes?.length ?? 0
  }

  /** Number of contigs. */
  get nContigs(): number {
    return this.contigs.length
  }

  /** Total bins — `chrom_offset`'s terminator, never `len(/bins)`. */
  get nBins(): number {
    return this.coords.nBins
  }

  /** `(n_bins, n_bins)`, as cooler reports it. */
  get shape(): [number, number] {
    return [this.nBins, this.nBins]
  }

  /** `true` if *name* is a genome in this file (`__unbinned__` counts). */
  hasGenome(name: string): boolean {
    return this.genomeIds.has(name)
  }

  /** `true` if *name* is a contig in this file. */
  hasContig(name: string): boolean {
    return this.contigIds.has(name)
  }

  /**
   * Genome index by name.
   *
   * @throws ViewerError `unknown-label`, mirroring the Python `KeyError`.
   */
  genomeId(name: string): number {
    const id = this.genomeIds.get(name)
    if (id === undefined) {
      throw new ViewerError(
        'unknown-label',
        `Genome ${pyRepr(name)} not found. Available: ${truncateNames(this.displayGenomes().map((i) => this.genomeNames[i]))}`,
        { label: name },
      )
    }
    return id
  }

  /**
   * Contig index by name.
   *
   * @throws ViewerError `unknown-label`, mirroring the Python `KeyError`.
   */
  contigId(name: string): number {
    const id = this.contigIds.get(name)
    if (id === undefined) {
      throw new ViewerError(
        'unknown-label',
        `Contig ${pyRepr(name)} not found. Available: ${truncateNames(this.chromnames)}`,
        { label: name },
      )
    }
    return id
  }

  // -------------------------------------------------------------------------
  // Extents
  // -------------------------------------------------------------------------

  /**
   * Half-open bin range of a `contig` or `contig:start-end` region, exactly as
   * `cooler.Cooler.extent` computes it. Genome names are **not** accepted here
   * — that is `parseMetacoolerRange`'s job, and cooler has no concept of one.
   */
  extent(region: string): Extent {
    const [chrom, start, end] = parseRegion(region, this.chromsizes)
    return regionToExtent(this.chromOffset, this.contigId(chrom), start, end, this.binsize)
  }

  /** First bin of a region — `cooler.Cooler.offset`. */
  offset(region: string): number {
    return this.extent(region)[0]
  }

  /** Half-open contig range `[c0, c1)` of a genome, from `genome_offset`. */
  genomeContigExtent(genome: string | number): Extent {
    const gid = typeof genome === 'number' ? genome : this.genomeId(genome)
    return [this.genomeOffset[gid], this.genomeOffset[gid + 1]]
  }

  /**
   * Half-open **bin** range of a genome.
   *
   * Under the accepted `genome-then-length` ordering this always succeeds: the
   * genome's contigs are `genome_offset[g] … genome_offset[g+1]` and its bins
   * are the corresponding `chrom_offset` span. The contiguity assertion is
   * kept anyway — it is O(1) and free, and it catches a file whose
   * `contig-ordering` attribute lies about its actual layout, which no other
   * check in the open path would notice.
   *
   * @returns `[0, 0]` for a genome with no bins, matching Python.
   * @throws ViewerError when the genome's contig block is not homogeneous.
   */
  genomeExtent(genome: string | number): Extent {
    const gid = typeof genome === 'number' ? genome : this.genomeId(genome)
    const [c0, c1] = this.genomeContigExtent(gid)
    if (c1 <= c0) return [0, 0]
    this.assertContiguous(gid, c0, c1)
    const lo = this.chromOffset[c0]
    const hi = this.chromOffset[c1]
    return hi <= lo ? [0, 0] : [lo, hi]
  }

  /**
   * The free invariant check behind {@link genomeExtent}.
   *
   * `genome_id` is non-decreasing under a genome-grouped ordering, so proving
   * that the block `[c0, c1)` is exactly genome *gid* needs only its two
   * endpoints and its two neighbours — four lookups, no scan.
   */
  private assertContiguous(gid: number, c0: number, c1: number): void {
    const ids = this.contigGenomeIds
    const bad =
      ids[c0] !== gid ||
      ids[c1 - 1] !== gid ||
      (c0 > 0 && ids[c0 - 1] === gid) ||
      (c1 < ids.length && ids[c1] === gid)
    if (bad) {
      throw new ViewerError(
        'bad-ordering',
        `Genome ${pyRepr(this.genomeNames[gid])} is not contiguous in bin space under ` +
          `contig-ordering ${pyRepr(this.info.ordering)}; a single bin range cannot represent ` +
          `it, so the file's ordering attribute does not describe its actual contig layout. ` +
          `Re-create the file with a genome-grouped ordering.`,
        { genome: this.genomeNames[gid], genomeId: gid, contigs: [c0, c1] },
      )
    }
  }

  /**
   * Half-open bin range of a contig, straight from `chrom_offset`.
   *
   * @returns `[0, 0]` for a contig with no bins, matching Python.
   */
  contigExtent(contig: string | number): Extent {
    const cid = typeof contig === 'number' ? contig : this.contigId(contig)
    const [lo, hi] = this.coords.contigBinExtent(cid)
    return hi <= lo ? [0, 0] : [lo, hi]
  }

  // -------------------------------------------------------------------------
  // `__unbinned__` (spec §7.4)
  // -------------------------------------------------------------------------

  /**
   * Genomes the UI may show: everything except `__unbinned__`.
   *
   * Filtered by **name**, never by index — `create(drop_unassigned=True)`
   * omits the row entirely, which makes genome 0 an ordinary MAG in exactly
   * the files that were binned most cleanly. Each entry keeps its true index,
   * because nothing is renumbered or compacted to close the gap: `genome_id`,
   * `genome_offset` and every bin index stay as written, and exclusion happens
   * at selection and display time only.
   */
  displayGenomes(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.genomeNames.length; i++) {
      if (this.genomeNames[i] !== UNBINNED_NAME) out.push(i)
    }
    return out
  }

  /**
   * The one number `__unbinned__` is allowed to contribute (§7.4): how many
   * contigs and what share of the bins binning failed to assign.
   *
   * It is a QC statistic, not a view — it opens nothing and selects nothing —
   * and it is read straight off the `/genomes` row, so no code path reaches
   * `__unbinned__` through it.
   */
  /**
   * The bins a picture of "the whole file" is allowed to draw.
   *
   * `__unbinned__` is not a genome and is never displayed (§7.4) — it is absent
   * from the genomes table, unselectable, and excluded from the overview. The
   * whole-file map read `[0, nBins)` and drew it anyway, which on a real
   * metagenome is the largest thing in the picture: on one 1.9 M-bin file it is
   * 56% of the bins, so it dominated a band *and*, being in the drawn pixels, set
   * the auto `vmax` for everything else (§7.1).
   *
   * Under `genome-then-length` every genome is one contiguous bin range and
   * `__unbinned__` holds genome index 0, so leaving it out is a range and not a
   * gap. Where it is not at either end — which no file this app accepts can
   * produce — the whole range is kept rather than a wrong half of it.
   */
  displayBinExtent(): Extent {
    const whole: Extent = [0, this.nBins]
    const gid = this.genomeIds.get(UNBINNED_NAME)
    if (gid === undefined) return whole
    const [lo, hi] = this.genomeExtent(gid)
    if (hi <= lo) return whole
    if (lo === 0) return [hi, this.nBins]
    if (hi === this.nBins) return [0, lo]
    return whole
  }

  unassignedStats(): UnassignedStats | null {
    const totalContigs = this.nContigs
    const totalBins = this.nBins
    const gid = this.genomeIds.get(UNBINNED_NAME)
    // Absence is normal, not an error: `create(drop_unassigned=True)` omits the
    // row, and `null` is what tells the info panel there is nothing to report.
    if (gid === undefined || this.genomes === null) return null
    const contigs = Number(this.genomes.get('n_contigs', gid) ?? 0)
    const bins = Number(this.genomes.get('n_bins', gid) ?? 0)
    return {
      genomeIndex: gid,
      contigs,
      bins,
      totalContigs,
      totalBins,
      contigFraction: totalContigs > 0 ? contigs / totalContigs : 0,
      binFraction: totalBins > 0 ? bins / totalBins : 0,
    }
  }

  // -------------------------------------------------------------------------
  // Density proxy (spec §4)
  // -------------------------------------------------------------------------

  /**
   * Non-zero pixels whose **row** bin falls inside genome *g*:
   * `bin1_offset[hi] - bin1_offset[lo]`, two lookups into an index the file
   * already carries.
   *
   * **This is not a contact count and must never be labelled as one.** It
   * counts stored pixels, not contacts; it ignores everything stored under a
   * lower row bin (i.e. this genome's contacts with genomes before it); and it
   * is exactly as cheap as its two array reads. As a per-MAG *density*
   * indicator at zero cost it earns its sortable column in the genomes table,
   * and nothing more.
   */
  genomeDensity(genome: string | number): number {
    const [lo, hi] = this.genomeExtent(genome)
    if (hi <= lo) return 0
    const offsets = this.binOffsets()
    return offsets[hi] - offsets[lo]
  }

  /**
   * `indexes/bin1_offset` in full, read once and kept.
   *
   * Two one-element HDF5 reads look cheaper than one whole-array read, and are
   * not: each is a `file.get`, a metadata fetch, a `malloc`, a hyperslab read
   * and a `free` — measured at 72 µs against an in-memory mount, the best case
   * there is. The landing view asks for one per genome, so the reference file
   * spent 8,788 of them (635 ms) before the table painted, and the overview's
   * top-N sort asked ~190,000 (13.7 s) before its scan even started. The whole
   * array is one read of 3.4 MB on that file, and every query after it is two
   * array lookups.
   *
   * Held for the session: it is the index the density column, the size guards
   * and every bounded read consult, so it is re-asked for constantly.
   */
  binOffsets(): Float64Array {
    return this.store.binOffsets()
  }

  /**
   * The same proxy for every displayed genome, in one pass.
   *
   * Indexed by *genome id*, not by position in the result — nothing is
   * renumbered here any more than anywhere else (§7.4).
   */
  genomeDensities(): Float64Array {
    const out = new Float64Array(this.nGenomes)
    if (this.genomes === null) return out
    const offsets = this.binOffsets()
    for (const genome of this.displayGenomes()) {
      const [lo, hi] = this.genomeExtent(genome)
      if (hi > lo) out[genome] = offsets[hi] - offsets[lo]
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Matrix
  // -------------------------------------------------------------------------

  /**
   * Load one dense block (§5.2, §5.3). Async only because the byte source may
   * be; the read itself is four slices and no scan.
   */
  async matrix(q: MatrixQuery, hint: string = DENSE_HINTS.range): Promise<DenseMatrix> {
    return readDenseMatrix(this, q, hint)
  }

  /** The whole intra-genome matrix of one MAG — the §5.2 genome view. */
  async genomeMatrix(genome: string | number): Promise<DenseMatrix> {
    const extent = this.genomeExtent(genome)
    return this.matrix({ rows: extent }, DENSE_HINTS.binSelection)
  }

  /**
   * The rectangular block between two genomes — the §5.3 pair view.
   *
   * Both genomes are contiguous under the accepted ordering, so this is one
   * bounded query however far apart they sit in bin space; the transpose is
   * handled inside {@link readDenseMatrix}.
   */
  async genomePairMatrix(row: string | number, col: string | number): Promise<DenseMatrix> {
    return this.matrix(
      { rows: this.genomeExtent(row), cols: this.genomeExtent(col) },
      DENSE_HINTS.binSelection,
    )
  }

  /**
   * Roll a block already in memory up to contig or genome level — free, no
   * I/O (§4). The bin → contig mapping comes from `chrom_offset`, never from
   * `/bins/chrom`.
   *
   * `storageMode` is passed through because it decides whether an on-diagonal
   * block has to be folded before it is summed: under `symmetric-upper` the
   * block is a mirror image of a half-stored triangle, and summing it whole
   * would double every within-group off-diagonal pixel. The result then
   * matches `metacooler aggregate` and `show --level contig` exactly.
   */
  /**
   * Roll a block up to contig or genome level **without materialising it**.
   *
   * The dense route is right for what its docstring describes — a MAG already on
   * screen, whose contig view is then free — and wrong for a selection whose
   * output is small and whose input is not. A whole yeast genome at 500 bp is
   * 2,366 MB of `Float32Array` and 295 million iterations to produce a 17 × 17
   * answer; this reads the same pixels in bounded windows and accumulates into
   * `Float64Array(17²)`. Measured: 2,090 ms and 2.4 GB against 139 ms and a few
   * kilobytes, with output identical to the last bit.
   *
   * That is also what takes the roll-up out from behind the dense guard. The
   * refusal for an over-large block used to offer "or switch to contig level" as
   * the escape hatch, and switching hit the same guard for the same reason,
   * because the roll-up read the same block first.
   */
  async aggregateSparse(
    q: MatrixQuery,
    level: AggregationLevel,
    options: SpanScanOptions = {},
  ): Promise<AggregatedMatrix & { contigsPerCell: number }> {
    const rows = clampExtent(q.rows, this.nBins)
    const cols = clampExtent(q.cols ?? q.rows, this.nBins)
    const plan = planRead(rows, cols, this.storageMode)
    const aggregator = sparseAggregator(
      rows,
      cols,
      this.coords,
      this.contigGenomeIds,
      level,
      plan.mode,
      this.storageMode === 'symmetric-upper',
      // Bounded at what the renderer draws, for the same reason the bin grid is:
      // an axis past it is pooled a second time on the way to the screen, flat
      // and blind to the sequences it is collapsing.
      POOLED_CELL_CAP,
    )
    // Weights are read once per axis for the bins on screen, exactly as the
    // dense path does — the one bounded read of `/bins` in the reader (§6.4).
    const weights = q.balance === true ? this.weightSlices(rows, cols) : null
    // Watched for the same reason as the pooled read above: a roll-up of the
    // whole file walks every pixel of it, and the level toggle is one click away
    // from the view that does.
    await this.store.forEachWindow(
      rows,
      cols,
      plan,
      (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const b1 = chunk.bin1[i]
          const b2 = chunk.bin2[i]
          const value =
            weights === null
              ? chunk.count[i]
              : chunk.count[i] *
                weightAt(weights, rows, cols, b1) *
                weightAt(weights, rows, cols, b2)
          aggregator.place(b1, b2, value)
        }
      },
      scanFor(options, q.value),
    )
    return { ...aggregator.finish(), contigsPerCell: aggregator.perCell }
  }

  /**
   * A block read at a **coarser grid** than the file stores: consecutive bins of
   * one contig, or whole contigs, summed into one cell.
   *
   * The same pass as {@link aggregateSparse} over the same pixels, into a
   * different set of slots — see `metacooler/pooling.ts` for why the slots are
   * bins rather than contigs, and why that makes the result an ordinary block
   * one bin size up rather than a new kind of object. An identity plan is not
   * pooling; the caller reads such a block the direct way.
   *
   * The output is bounded by construction: `cap` cells per axis, whatever the
   * file's bin count. That is what lets a whole-genome view of a large cooler
   * exist at all — the dense block it would otherwise ask for is refused by the
   * browser's 2 GiB ceiling on one array, and was refused *after* the user had
   * been asked to wait for it. The bound is on the cells the renderer will draw,
   * not near them, so nothing downstream pools a second time.
   *
   * `aim` is the grid the caller has already labelled its axis with. It is a
   * floor, never a target: the read may coarsen it where the sequences fall
   * badly, and reports what it used.
   */
  async pooledMatrix(
    q: MatrixQuery,
    aim: PoolPlan,
    options: SpanScanOptions = {},
  ): Promise<
    Omit<AggregatedMatrix, 'level'> & {
      binsPerCell: number
      contigsPerCell: number
      rowMembers: BinPooling
      colMembers: BinPooling
    }
  > {
    const rows = clampExtent(q.rows, this.nBins)
    const cols = clampExtent(q.cols ?? q.rows, this.nBins)
    const plan = planRead(rows, cols, this.storageMode)
    const onDiagonal = rows[0] === cols[0] && rows[1] === cols[1]
    // The contig → genome map goes in so that a cell of whole sequences is a
    // cell of one genome's sequences (`pooling.ts`). Empty for a plain cooler,
    // where there is no coarser structure and a chromosome is the only unit.
    const groups = this.contigGenomeIds
    const rowPool = poolBins(this.coords, rows[0], rows[1], aim, POOLED_CELL_CAP, groups)
    const colPool = onDiagonal
      ? rowPool
      : poolBins(this.coords, cols[0], cols[1], aim, POOLED_CELL_CAP, groups)
    const acc = pixelAccumulator(
      rows,
      cols,
      rowPool,
      colPool,
      plan.mode,
      this.storageMode === 'symmetric-upper',
    )
    // Weights are read once per axis for the bins on screen, exactly as the
    // dense and roll-up paths do — the one bounded read of `/bins` (§6.4).
    const weights = q.balance === true ? this.weightSlices(rows, cols) : null
    // Watched rather than raced through: this is the read the whole-genome view
    // makes, its span is the whole file, and a person waiting on it is owed a
    // bar and a way out (`forEachPixelSpanAsync`).
    await this.store.forEachWindow(
      rows,
      cols,
      plan,
      (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const b1 = chunk.bin1[i]
          const b2 = chunk.bin2[i]
          const value =
            weights === null
              ? chunk.count[i]
              : chunk.count[i] *
                weightAt(weights, rows, cols, b1) *
                weightAt(weights, rows, cols, b2)
          acc.place(b1, b2, value)
        }
      },
      scanFor(options, q.value),
    )
    return {
      ...acc.finish(),
      binsPerCell: rowPool.stride,
      contigsPerCell: Math.max(rowPool.contigsPerCell, colPool.contigsPerCell),
      rowMembers: rowPool,
      colMembers: colPool,
    }
  }

  /**
   * One map of **several chosen sequences**, and nothing else.
   *
   * The picture a reader asks for by ticking four MAGs out of two thousand:
   * their own maps on the diagonal, everything between them off it, in the
   * order they were given. It is not a range — the four are scattered through
   * the file — so it is built the way the overview is, by walking pixels and
   * dropping the ones whose bins are not on either axis
   * (`selectionPooling`).
   *
   * Which makes it the whole file's worth of reading whatever is selected, and
   * that is why it is watched: the same bar and the same cancel as the
   * whole-genome read, through the same options.
   *
   * @param units Selected sequences as `(id, bin extent)`, in display order.
   */
  async selectionMatrix(
    units: ReadonlyArray<{ id: number; extent: readonly [number, number] }>,
    aim: PoolPlan,
    options: SpanScanOptions & { balance?: boolean; cellCap?: number } = {},
  ): Promise<
    Omit<AggregatedMatrix, 'level'> & {
      binsPerCell: number
      contigsPerCell: number
      ids: Int32Array
      pooling: BinPooling
    }
  > {
    // `cellCap` is the caller's ceiling on the *picture*, which is what a memory
    // budget resolves to here: the block is square, so a byte budget divides
    // into a cells-per-axis cap and nothing else has to change. Absent means
    // `selectionPooling`'s own cap, which is the raster's.
    const pooling =
      options.cellCap === undefined
        ? selectionPooling(this.nBins, units, aim)
        : selectionPooling(this.nBins, units, aim, options.cellCap)
    // On the diagonal by construction: one axis, used twice. `planRead` decides
    // what that means for the store rather than this function assuming it — a
    // `square` file holds both triangles and each stored pixel is its own cell,
    // an upper-triangular one holds half and the result is mirrored at the end.
    const whole: Extent = [0, this.nBins]
    const acc = pixelAccumulator(
      whole,
      whole,
      pooling,
      pooling,
      planRead(whole, whole, this.storageMode).mode,
      this.storageMode === 'symmetric-upper',
    )
    const weights = options.balance === true ? this.weightSlices(whole, whole) : null
    await this.store.forEachBands(
      units.map(({ extent }) => [extent[0], extent[1]] as Extent),
      (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const b1 = chunk.bin1[i]
          const b2 = chunk.bin2[i]
          const value =
            weights === null
              ? chunk.count[i]
              : chunk.count[i] * weights.rows[b1] * weights.cols[b2]
          acc.place(b1, b2, value)
        }
      },
      options,
    )
    const out = acc.finish()
    return {
      ...out,
      binsPerCell: pooling.stride,
      contigsPerCell: pooling.contigsPerCell,
      ids: pooling.ids,
      pooling,
    }
  }

  /**
   * The `/bins` columns this file carries, with the kind of each — names and
   * dtypes, never a value (§8.12).
   *
   * One group listing and one `dtype` per column, which is what makes it safe
   * to ask at open time for a drop-down that may never be opened: §3.3's rule
   * is that `/bins` is never *read*, and this reads nothing. The weight column
   * is in the list like any other, because to a reader it is exactly what this
   * feature is for — the balancing decision, drawn beside the map it was made
   * for.
   */
  binColumns(): Array<{ name: string; text: boolean }> {
    if (!this.tables.has('bins')) return []
    const out: Array<{ name: string; text: boolean }> = []
    for (const name of this.tables.keys('bins')) {
      // A column whose dtype this reader cannot interpret — a compound, a
      // reference, an enum — is left out rather than reported as a number.
      // Nothing downstream could draw it, and the honest place to decline is
      // the list rather than the lane.
      const text = columnIsText(this.tables.dtype(`bins/${name}`))
      if (text !== null) out.push({ name, text })
    }
    return out
  }

  /**
   * One `/bins` column over one half-open bin range.
   *
   * Bounded exactly as the weight read is, and for the same reason: the block
   * on screen is at most a few thousand cells however large the file is, so a
   * lane over it never needs more of the column than the picture covers. A
   * whole-file column read would be as long as the file's bin count, for a
   * picture that is going to be four thousand pixels wide.
   */
  binColumn(column: string, lo: number, hi: number): Float64Array | string[] {
    const path = `bins/${column}`
    if (!this.tables.has(path)) {
      throw new ViewerError(
        'unsupported',
        `This file has no /${path} column.`,
        { column },
      )
    }
    const from = Math.max(0, Math.min(lo, this.nBins))
    const to = Math.max(from, Math.min(hi, this.nBins))
    return columnIsText(this.tables.dtype(path)) === true
      ? this.tables.readStrings(path, from, to)
      : this.tables.readNumeric(path, from, to)
  }

  /** The two bounded weight slices a balanced roll-up multiplies by. */
  private weightSlices(rows: Extent, cols: Extent): { rows: Float64Array; cols: Float64Array } {
    const path = `bins/${DEFAULT_WEIGHT_COLUMN}`
    if (!this.handle.has(path)) {
      throw new ViewerError(
        'unsupported',
        `This file has no /${path} column, so there are no weights to balance with. ` +
          'Run `cooler balance` on it, or view the raw counts.',
        { column: DEFAULT_WEIGHT_COLUMN },
      )
    }
    const rowWeights = this.handle.readNumeric(path, rows[0], rows[1])
    const colWeights =
      cols[0] === rows[0] && cols[1] === rows[1]
        ? rowWeights
        : this.handle.readNumeric(path, cols[0], cols[1])
    return { rows: rowWeights, cols: colWeights }
  }

  aggregate(m: DenseMatrix, level: AggregationLevel): AggregatedMatrix {
    return aggregateMatrix(
      m,
      this.coords,
      this.contigGenomeIds,
      level,
      this.storageMode === 'symmetric-upper',
    )
  }

  // -------------------------------------------------------------------------
  // Cells (spec §3.7)
  // -------------------------------------------------------------------------

  /** Every cell of an `.scool`, in file order; `[]` for any other container. */
  get cells(): string[] {
    return this.layout.kind === 'scool' ? (this.layout.entries ?? []) : []
  }

  /**
   * The cells currently summed into this map.
   *
   * Equal to {@link cells} until something ticks a subset, and `[]` on a file
   * that has none — which is what lets every caller ask without branching on
   * the container first.
   */
  get activeCells(): string[] {
    return this.pixelStore instanceof ScoolStore ? this.pixelStore.names : []
  }

  /**
   * Sum a different set of cells, in place. `null` is every cell.
   *
   * A swap rather than a re-open, and the difference is what makes ticking
   * boxes feel like ticking boxes: the mount, the chrom table, the coordinate
   * system and the bin space are all shared by every cell, so what actually
   * changes is which pixel tables get walked. The cost is one small index read
   * per newly selected cell.
   */
  selectCells(names: readonly string[] | null): void {
    if (this.layout.kind !== 'scool') {
      throw new ViewerError(
        'unsupported',
        `${this.uri} is not a single-cell container, so it has no cells to choose.`,
        { layout: this.layout.kind },
      )
    }
    const resolved = resolveCells(this.cells, names)
    this.pixelStore = new ScoolStore(this.handle, this.layout, resolved, this.nBins, this.countKind)
  }

  /**
   * One row per cell, with the columns its attributes actually distinguish.
   *
   * `name`, `nnz` and `sum` first, because every cooler writes the latter two
   * and they are what a reader ranks cells by — a single-cell library is a
   * distribution of depths, and the useful ones are at one end of it. After
   * them, any other attribute that **differs** across cells, discovered rather
   * than listed: a writer that records a phase, a batch or a QC call per cell
   * gets a sortable column for free.
   *
   * A constant attribute is deliberately not a column — see {@link CellsResult}.
   * `metadata` is dropped whatever it does, being a JSON blob rather than a
   * cell of a table.
   */
  cellTable(): Table {
    const names = this.cells
    const rows = names.map((name) => this.handle.attrsAt(cellPath(this.layout, name)))
    const columns: string[] = ['name']
    const data: Record<string, Column> = { name: names }

    const discovered = new Set<string>()
    for (const attrs of rows) for (const key of Object.keys(attrs)) discovered.add(key)
    // Order: the two guaranteed numbers, then whatever else varies, by name, so
    // the table is stable across files rather than following HDF5's iteration.
    const rest = [...discovered]
      .filter((key) => !CELL_TABLE_LEADING.includes(key) && key !== 'metadata')
      .sort()
    for (const key of [...CELL_TABLE_LEADING, ...rest]) {
      if (!discovered.has(key)) continue
      const values = rows.map((attrs) => attrs[key])
      // A column every row agrees on describes the file, not the cell.
      if (!CELL_TABLE_LEADING.includes(key) && values.every((v) => v === values[0])) continue
      const numeric = values.every((v) => typeof v === 'number' || typeof v === 'boolean')
      if (numeric) {
        data[key] = Float64Array.from(values, (v) => Number(v))
      } else {
        data[key] = values.map((v) => (v === null || v === undefined ? '' : String(v)))
      }
      columns.push(key)
    }
    return makeTable(names.length, columns, data)
  }

  // -------------------------------------------------------------------------
  // The full scan — gated, never automatic (spec §4, §7.3)
  // -------------------------------------------------------------------------

  /** Total stored pixels, from the dataset shape. No pixel is read. */
  get nnz(): number {
    return this.store.nnz ?? 0
  }

  /**
   * Stream every non-zero pixel, in chunks.
   *
   * **This is the one operation that costs the whole file.** Summing all
   * genome pairs is inherently a full pixel scan — there is no index that
   * shortcuts it — which is why the genome × genome overview is gated rather
   * than being the landing view. Returning `false` from `onChunk` stops the
   * scan, and that is what makes the gate cancellable.
   */
  async scanPixels(options: ScanOptions): Promise<void> {
    await this.store.scanAll(options as ScanAllOptions)
  }

  /**
   * The deep integrity check, offered as an explicit debug action only (§6.3).
   *
   * This is `check --deep`'s pixel scan (`_deep_pixel_problems`) plus the
   * offset-array invariants of `_check_offset_array`: every pixel in range,
   * upper-triangular, sorted by `(bin1_id, bin2_id)`, owned by the
   * `bin1_offset` slot that claims it, and totalling `attrs['sum']`.
   *
   * It is deliberately **not** a port of the whole Python `validate()`: that
   * function reads three `/bins` columns end to end, and this reader never
   * reads `/bins` (§3.3). `note` says so, so a user running the debug action
   * knows exactly which invariants went unchecked rather than assuming a
   * clean report means the file is perfect.
   */
  async validateDeep(options?: {
    /** Polled between chunks; `true` abandons the scan with an `AbortError`. */
    cancelled?: () => boolean
    onProgress?: (done: number, total: number) => void
  }): Promise<DeepValidation> {
    const problems: string[] = []
    const reported = new Set<string>()
    const once = (kind: string, message: string): void => {
      if (!reported.has(kind)) {
        reported.add(kind)
        problems.push(message)
      }
    }

    const nBins = this.nBins
    const square = this.storageMode === 'square'
    const bin1Offset = this.binOffsets()
    const total = this.nnz
    if (bin1Offset.length !== nBins + 1) {
      problems.push(`bin1_offset length (${bin1Offset.length}) != ${nBins + 1}`)
    } else if (bin1Offset[0] !== 0 || bin1Offset[nBins] !== total) {
      problems.push(
        `bin1_offset endpoints (${bin1Offset[0]}, ${bin1Offset[nBins]}) do not bracket the ` +
          `table (0, ${total})`,
      )
    }
    for (let i = 1; i < bin1Offset.length; i++) {
      if (bin1Offset[i] < bin1Offset[i - 1]) {
        once(
          'monotone',
          `bin1_offset is not non-decreasing: bin1_offset[${i - 1}]=${bin1Offset[i - 1]} > ` +
            `bin1_offset[${i}]=${bin1Offset[i]}`,
        )
        break
      }
    }

    let sum = 0
    const integral = this.countKind !== 'f'
    // Scalars, not a two-element array per pixel: at a reference-scale `nnz` of
    // 3e8 that was 300 million short-lived objects, forcing a continuous
    // scavenge through a loop that is otherwise allocation-free. Measured
    // 14.2 ns/pixel against 4.6.
    let prev1 = -1
    let prev2 = -1
    // A *walking* owner pointer rather than a binary search per pixel. Rows
    // arrive in order, so the slot only ever advances; the search re-derived
    // from scratch what a single incrementing counter already knows, at
    // 33.5 ns/pixel against 7.3.
    const indexed = bin1Offset.length === nBins + 1
    let owner = 0
    let row = 0
    const cancelled = options?.cancelled
    await this.scanPixels({
      onProgress: options?.onProgress,
      onChunk: (chunk) => {
        if (cancelled?.() === true) return false
        for (let i = 0; i < chunk.length; i++, row++) {
          const b1 = chunk.bin1[i]
          const b2 = chunk.bin2[i]
          const v = chunk.count[i]
          if (integral) sum += v
          if (b1 < 0 || b2 < 0 || b1 >= nBins || b2 >= nBins) {
            once('range', `pixel bin ids out of range [0, ${nBins}) at row ${row}`)
          }
          if (!square && b1 > b2) {
            once(
              'triangle',
              `pixels are not upper-triangular (bin1_id <= bin2_id): row ${row} is (${b1}, ${b2})`,
            )
          }
          if (prev1 >= 0 && !(prev1 < b1 || (prev1 === b1 && prev2 <= b2))) {
            once('order', `pixels are not sorted by (bin1_id, bin2_id) at row ${row}`)
          }
          if (indexed) {
            while (owner < nBins && bin1Offset[owner + 1] <= row) owner++
            if (owner !== b1) {
              once(
                'index',
                `bin1_offset disagrees with pixels/bin1_id at row ${row}: the index places it in ` +
                  `bin ${owner}, the pixel says ${b1}`,
              )
            }
          }
          prev1 = b1
          prev2 = b2
        }
        return true
      },
    })
    if (cancelled?.() === true) {
      const err = new Error('cancelled')
      err.name = 'AbortError'
      throw err
    }

    // Only integer counts are totalled: attrs['sum'] is an integer contact
    // count, so there is nothing to reconcile a float count column against.
    const declaredSum = this.info.sum
    if (integral && declaredSum !== null && declaredSum !== sum) {
      problems.push(`attrs['sum'] (${declaredSum}) != the sum of pixels/count (${sum})`)
    }

    return {
      ok: problems.length === 0,
      problems,
      note:
        `Scanned ${total} pixels for range, upper-triangle, sort order and bin1_offset ` +
        `agreement${integral ? ", and reconciled attrs['sum']" : ' (float counts: sum not reconciled)'}. ` +
        `The /bins geometry checks of the Python validate() are not run — this reader never ` +
        `reads /bins (spec §3.3).`,
    }
  }

  // -------------------------------------------------------------------------
  // Validation (spec §6.3) and teardown
  // -------------------------------------------------------------------------

  /**
   * The light checks: attributes, group presence, table lengths, the `/chroms`
   * soft link, and declared-vs-actual counts. All O(1) or O(n_columns).
   *
   * The full Python `validate()` reads whole `bins` columns, the whole
   * `genome_id` column, both offset arrays and three pixel windows — fine on
   * local disk, unacceptable over HTTP — so it belongs behind an explicit
   * debug action, not in the open path.
   */
  private validateLight(): void {
    const fail = (message: string, detail: Record<string, unknown> = {}): never => {
      throw new MetaCoolerFormatError(message, detail)
    }

    // Shared with every cooler: a contig table, its columns, and an offset
    // array that brackets it.
    if (this.nContigs === 0) fail('/contigs table is empty')
    for (const column of REQUIRED_COOLER_COLUMNS) {
      if (!this.contigs.columns.includes(column)) fail(`Missing column in /contigs: ${column}`)
    }
    if (this.chromOffset.length !== this.nContigs + 1) {
      fail(`chrom_offset length (${this.chromOffset.length}) != ${this.nContigs + 1}`)
    }
    if (this.chromOffset[0] !== 0) {
      fail(`chrom_offset endpoints (${this.chromOffset[0]}, ${this.nBins}) do not bracket the table`)
    }

    // The genome layer, only where there is one. A plain cooler fails the
    // soft-link check by construction — its `/chroms` *is* the real group, and
    // the check exists to prove a metacool is readable as one of these.
    if (this.genomes !== null) {
      if (this.nGenomes === 0) fail('/genomes table is empty')
      for (const column of REQUIRED_GENOME_COLUMNS) {
        if (!this.genomes.columns.includes(column)) fail(`Missing column in /genomes: ${column}`)
      }
      if (!this.contigs.columns.includes('genome_id')) fail('Missing column in /contigs: genome_id')
      if (!this.handle.isSoftLink('chroms')) {
        fail('/chroms must be a soft link to /contigs for cooler compatibility')
      }
      if (this.genomeOffset.length !== this.nGenomes + 1) {
        fail(`genome_offset length (${this.genomeOffset.length}) != ${this.nGenomes + 1}`)
      }
      if (this.genomeOffset[0] !== 0 || this.genomeOffset[this.nGenomes] !== this.nContigs) {
        fail(
          `genome_offset endpoints (${this.genomeOffset[0]}, ${this.genomeOffset[this.nGenomes]}) ` +
            `do not bracket the table (0, ${this.nContigs})`,
        )
      }
    }

    // Declared counts must agree with what is actually there. `nnz` is read
    // from the dataset *shape*, which costs nothing and never touches a pixel.
    const declared: [string, number | null, number, string][] = [
      ['nchroms', this.info.ncontigs, this.nContigs, 'len(/contigs)'],
      ...(this.genomes === null
        ? []
        : ([['ngenomes', this.info.ngenomes, this.nGenomes, 'len(/genomes)']] as [
            string,
            number | null,
            number,
            string,
          ][])),
      ['nbins', this.info.nbins, this.nBins, 'len(/bins)'],
      ['nnz', this.info.nnz, this.tables.datasetLength('pixels/bin1_id'), 'len(/pixels)'],
    ]
    for (const [name, value, actual, label] of declared) {
      if (value !== null && value !== actual) {
        fail(`attrs[${pyRepr(name)}] (${value}) != ${label} (${actual})`)
      }
    }
  }

  /** Release the handle and its byte source. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.handle.close()
  }
}

/**
 * A numeric column as a `Float64Array`, without the intermediate JS array.
 *
 * `Table.numbers` returns `number[]`, which is the right shape for the handful
 * of small columns the UI formats — and the wrong one for a 154,000-row index
 * the reader is about to convert anyway. Every numeric column arrives from the
 * decoder as a `Float64Array`, so the common case is a straight hand-back.
 */
function toFloat64(table: Table, column: string): Float64Array {
  const raw = table.data[column]
  if (raw instanceof Float64Array) return raw
  return Float64Array.from(table.numbers(column))
}

/**
 * Whether a dataset holds text, or `null` where its dtype is not a scalar one.
 *
 * A total function over a partial one: {@link dtypeKind} throws for a compound
 * or reference datatype, which is the right answer for a required column being
 * validated and the wrong one for a *discovery* pass over whatever a creator
 * happened to put in `/bins` (§8.12). One odd column should cost that column,
 * not the listing.
 */
function columnIsText(dtype: string): boolean | null {
  try {
    return 'SOU'.includes(dtypeKind(dtype))
  } catch {
    return null
  }
}

/** The same, narrowing to `Int32Array` — for id columns, which are indices. */
function toInt32(table: Table, column: string): Int32Array {
  const raw = table.data[column]
  if (ArrayBuffer.isView(raw) && !(raw instanceof DataView) && !(raw instanceof BigInt64Array)) {
    const out = new Int32Array(raw.length)
    out.set(raw as unknown as ArrayLike<number>)
    return out
  }
  return Int32Array.from(table.numbers(column))
}

/**
 * Scan options carrying the query's own value column.
 *
 * The streaming reads take their column through `SpanScanOptions` and the dense
 * read takes it through `MatrixQuery`; this is the one line that joins them, and
 * it exists so that no caller of the pooled or rolled-up path can forget. An
 * absent column is left absent rather than defaulted here, so the default stays
 * in one place (`DEFAULT_COUNT_COLUMN`).
 */
function scanFor(options: SpanScanOptions, value: string | undefined): SpanScanOptions {
  return value === undefined ? options : { ...options, value }
}

/** A bin range clamped onto the file, matching `readDenseMatrix`'s validation. */
function clampExtent(extent: Extent, nBins: number): Extent {
  const lo = Math.min(Math.max(Math.trunc(extent[0]), 0), nBins)
  const hi = Math.min(Math.max(Math.trunc(extent[1]), lo), nBins)
  return [lo, hi]
}

/**
 * The weight of an absolute bin, from whichever axis slice covers it.
 *
 * A pixel contributes through both of its bins, and the two can fall on
 * different axes of a rectangular block. Outside both slices the weight is `1`,
 * which cannot happen for a pixel the aggregator will place — every placement is
 * range-checked first — and is the identity if it ever did.
 */
function weightAt(
  weights: { rows: Float64Array; cols: Float64Array },
  rows: Extent,
  cols: Extent,
  bin: number,
): number {
  if (bin >= rows[0] && bin < rows[1]) return weights.rows[bin - rows[0]]
  if (bin >= cols[0] && bin < cols[1]) return weights.cols[bin - cols[0]]
  return 1
}

/**
 * Refuse to list a container's cells over a source that cannot afford it (§12).
 *
 * Every other open in this application is a bounded read, and this is the one
 * that is not: a container's cell names live in HDF5 link storage that writers
 * interleave with the cells' own data, so reading them is a thousand small
 * requests spread over the whole object. Measured on a 3,882-cell file: 1,015
 * reads averaging 512 bytes, uniformly distributed across 327 MB. Neither
 * chunk size wins — at the default 1 MiB the listing fetches the entire object,
 * and small enough to avoid that is small enough to need a thousand round trips.
 *
 * So the reader is asked, which is what this refusal is: a question with the
 * numbers in it, thrown where the cost is about to be incurred and caught by
 * the shell, which re-opens with the answer on the source (`SourceSpec.reading`).
 * A source that already holds the whole object in memory — a dropped file, or a
 * download the reader has just agreed to — has nothing to be asked about and
 * passes straight through.
 *
 * @throws ViewerError `scool-listing-cost`, carrying the object's size.
 */
function assertListingAffordable(handle: Hdf5Handle, source: ByteSource): void {
  if (!source.isRemote) return
  if (!willListCells(handle, handle.attrs())) return
  const { path } = parseUri(handle.uri)
  throw new ViewerError(
    'scool-listing-cost',
    `${path} is a single-cell container, and listing its cells is not a bounded read: the ` +
      `names live in HDF5 link records spread across the whole object. Reading them over the ` +
      `network costs either one download of ${fmtMib(source.size)} or a few percent of that in ` +
      `about a thousand separate requests. Choose which to pay, or open a local copy, where ` +
      `neither cost applies.`,
    { path, size: source.size },
  )
}

/** `326 MB`, for a sentence. */
function fmtMib(bytes: number): string {
  return bytes >= 1 << 30
    ? `${(bytes / (1 << 30)).toFixed(1)} GB`
    : `${Math.round(bytes / (1 << 20))} MB`
}
