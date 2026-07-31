/**
 * The reader (spec §6): a read-only JS mirror of the Python `MetaCooler`.
 *
 * Same names, same semantics, same errors, no new concepts. Where this file
 * and `metacooler/api.py` disagree, this file is wrong.
 *
 * What `open` reads, and nothing more (§3.2): the root attributes, `/genomes`
 * and `/contigs` in full, and the two small offset arrays. Never `/pixels/*`,
 * never `indexes/bin1_offset` (one entry per bin — sliced on demand), and
 * never `/bins` at all (§3.3).
 */

import { UNBINNED_NAME } from '../constants'
import type { StorageMode } from '../constants'
import { MetaCoolerFormatError, truncateNames, ViewerError } from '../errors'
import { pyRepr } from '../format'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import { openHdf5 } from '../h5/Hdf5File'
import type {
  ByteSource,
  DenseMatrix,
  Extent,
  Info,
  Layout,
  MatrixQuery,
  PixelChunk,
  Table,
} from '../types'
import { aggregateMatrix, type AggregatedMatrix, type AggregationLevel } from './aggregate'
import { Coords, searchOffset } from './coords'
import { assertAcceptable, detectLayout, extractMetadata, normaliseInfo } from './detect'
import { DENSE_HINTS, readDenseMatrix, resolveCountKind } from './matrix'
import { parseRegion, regionToExtent } from './range'
import { parseUri } from '../uri'

/** Columns `schema.validate` requires; absence is a format error, not a crash. */
const REQUIRED_GENOME_COLUMNS = ['name', 'length', 'n_contigs', 'n_bins'] as const
const REQUIRED_CONTIG_COLUMNS = ['name', 'length', 'genome_id'] as const

/**
 * Everything `MetaCooler` needs, already read.
 *
 * Split out from the constructor so a synthesised view — a plain cooler
 * presented as a one-genome metacool (§9) — can be built without this class
 * knowing that such a thing exists.
 */
export interface MetaCoolerInit {
  uri: string
  handle: Hdf5Handle
  layout: Layout
  attrs: Record<string, AttrValue>
  genomes: Table
  contigs: Table
  /** `indexes/chrom_offset`, length `nContigs + 1`. */
  chromOffset: Float64Array
  /** `indexes/genome_offset`, length `nGenomes + 1`. */
  genomeOffset: Float64Array
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
  /** Sibling entry names when this map lives inside an mmetacool (§3.4). */
  readonly entries: string[]
  /** Normalised root attributes (`MetaCooler.info`). */
  readonly info: Info
  /** The optional user `metadata` object, `{}` when absent. */
  readonly metadata: Record<string, unknown>
  /** `/genomes` with every column the creator wrote (spec §5.1). */
  readonly genomes: Table
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
  /** Contig name → length in bp — cooler's `chromsizes`. */
  readonly chromsizes: Map<string, number>
  /** Genome names, in file order, `__unbinned__` included. */
  readonly genomeNames: string[]
  /**
   * `contigs/genome_id`, one entry per contig, exactly as written. Public
   * because the aggregation path needs contig → genome and must never invent
   * its own mapping (§7.4: nothing is renumbered).
   */
  readonly contigGenomeIds: Int32Array

  readonly handle: Hdf5Handle
  private readonly chromOffset: Float64Array
  private readonly genomeOffset: Float64Array
  private readonly contigIds: Map<string, number>
  private readonly genomeIds: Map<string, number>
  private closed = false

  /**
   * Open a map from a byte source.
   *
   * The source is the only thing that differs between a local drag-and-drop
   * and a remote range-request file (§6.1); everything below this line is
   * identical for both.
   */
  static async open(uri: string, source: ByteSource): Promise<MetaCooler> {
    // The group comes from the URI, so `file.mmetacool::entries/rep1` and a
    // plain `file.metacool` reach the handle already resolved (§3.5).
    const handle = await openHdf5(uri, source, parseUri(uri).group)
    try {
      return MetaCooler.fromHandle(handle)
    } catch (error) {
      handle.close()
      throw error
    }
  }

  /**
   * Build a map from an already-open handle: detect, gate, then read the four
   * small things §3.2 allows.
   *
   * @throws ViewerError from {@link assertAcceptable} for a refused file, or
   *   `unsupported` for a plain cool/mcool, which reaches this class only
   *   through a synthesised {@link MetaCoolerInit} (§9).
   */
  static fromHandle(handle: Hdf5Handle): MetaCooler {
    const layout = detectLayout(handle)
    assertAcceptable(handle, layout)
    if (layout.kind !== 'metacool') {
      throw new ViewerError(
        'unsupported',
        `${handle.uri} is a ${layout.kind} file. Plain cooler files are supported at region ` +
          `level through a synthesised single-genome view; construct MetaCooler from that ` +
          `instead of opening the file directly.`,
        { kind: layout.kind },
      )
    }
    if (!handle.has('indexes/genome_offset')) {
      throw new MetaCoolerFormatError('indexes/genome_offset is missing')
    }
    return new MetaCooler({
      uri: handle.uri,
      handle,
      layout,
      attrs: handle.attrs(),
      genomes: handle.readTable('genomes'),
      contigs: handle.readTable('contigs'),
      chromOffset: handle.readNumeric('indexes/chrom_offset'),
      genomeOffset: handle.readNumeric('indexes/genome_offset'),
    })
  }

  constructor(init: MetaCoolerInit) {
    this.uri = init.uri
    this.handle = init.handle
    this.layout = init.layout
    this.entries = init.handle.rootEntries
    this.genomes = init.genomes
    this.contigs = init.contigs
    this.chromOffset = init.chromOffset
    this.genomeOffset = init.genomeOffset

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
    this.genomeNames = this.genomes.strings('name')
    const contigLengths = Float64Array.from(this.contigs.numbers('length'))
    this.contigGenomeIds = Int32Array.from(this.contigs.numbers('genome_id'))
    this.coords = new Coords(this.binsize, this.chromOffset, contigLengths)

    this.chromsizes = new Map()
    this.contigIds = new Map()
    for (let i = 0; i < this.chromnames.length; i++) {
      this.chromsizes.set(this.chromnames[i], contigLengths[i])
      this.contigIds.set(this.chromnames[i], i)
    }
    this.genomeIds = new Map()
    for (let i = 0; i < this.genomeNames.length; i++) this.genomeIds.set(this.genomeNames[i], i)

    this.countKind = resolveCountKind(this.handle.dtype('pixels/count'))
    this.validateLight()
  }

  // -------------------------------------------------------------------------
  // Shape and identity
  // -------------------------------------------------------------------------

  /** Number of genomes, `__unbinned__` included. */
  get nGenomes(): number {
    return this.genomes.length
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
  unassignedStats(): UnassignedStats | null {
    const totalContigs = this.nContigs
    const totalBins = this.nBins
    const gid = this.genomeIds.get(UNBINNED_NAME)
    // Absence is normal, not an error: `create(drop_unassigned=True)` omits the
    // row, and `null` is what tells the info panel there is nothing to report.
    if (gid === undefined) return null
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
    const start = this.handle.readNumeric('indexes/bin1_offset', lo, lo + 1)[0]
    const end = this.handle.readNumeric('indexes/bin1_offset', hi, hi + 1)[0]
    return end - start
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
  // The full scan — gated, never automatic (spec §4, §7.3)
  // -------------------------------------------------------------------------

  /** Total stored pixels, from the dataset shape. No pixel is read. */
  get nnz(): number {
    return this.handle.datasetLength('pixels/bin1_id')
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
    const chunkSize = options.chunkSize ?? 1_000_000
    const total = this.nnz
    for (let lo = 0; lo < total; lo += chunkSize) {
      const hi = Math.min(lo + chunkSize, total)
      const bin1 = this.handle.readNumeric('pixels/bin1_id', lo, hi)
      const bin2 = this.handle.readNumeric('pixels/bin2_id', lo, hi)
      const count = this.handle.readNumeric('pixels/count', lo, hi)
      const chunk: PixelChunk = {
        bin1: Int32Array.from(bin1),
        bin2: Int32Array.from(bin2),
        count,
        length: count.length,
      }
      const keepGoing = options.onChunk(chunk)
      options.onProgress?.(hi, total)
      if (keepGoing === false) return
      // Yield to the event loop so a cancel message can actually be delivered.
      await Promise.resolve()
    }
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
  async validateDeep(): Promise<DeepValidation> {
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
    const bin1Offset = this.handle.readNumeric('indexes/bin1_offset')
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
    let integral = this.countKind !== 'f'
    let previous: [number, number] | null = null
    let row = 0
    await this.scanPixels({
      onChunk: (chunk) => {
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
          if (previous !== null && !(previous[0] < b1 || (previous[0] === b1 && previous[1] <= b2))) {
            once('order', `pixels are not sorted by (bin1_id, bin2_id) at row ${row}`)
          }
          if (bin1Offset.length === nBins + 1 && searchOffset(bin1Offset, row) !== b1) {
            once(
              'index',
              `bin1_offset disagrees with pixels/bin1_id at row ${row}: the index places it in ` +
                `bin ${searchOffset(bin1Offset, row)}, the pixel says ${b1}`,
            )
          }
          previous = [b1, b2]
        }
      },
    })

    // Only integer counts are totalled: attrs['sum'] is an integer contact
    // count, so there is nothing to reconcile a float weight column against.
    if (!integral) integral = false
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

    if (this.nContigs === 0) fail('/contigs table is empty')
    if (this.nGenomes === 0) fail('/genomes table is empty')
    for (const column of REQUIRED_GENOME_COLUMNS) {
      if (!this.genomes.columns.includes(column)) fail(`Missing column in /genomes: ${column}`)
    }
    for (const column of REQUIRED_CONTIG_COLUMNS) {
      if (!this.contigs.columns.includes(column)) fail(`Missing column in /contigs: ${column}`)
    }

    // The dual identity: a metacool must stay openable by cooler.Cooler(),
    // which it does only because /chroms soft-links to /contigs.
    if (!this.handle.isSoftLink('chroms')) {
      fail('/chroms must be a soft link to /contigs for cooler compatibility')
    }

    if (this.chromOffset.length !== this.nContigs + 1) {
      fail(`chrom_offset length (${this.chromOffset.length}) != ${this.nContigs + 1}`)
    }
    if (this.genomeOffset.length !== this.nGenomes + 1) {
      fail(`genome_offset length (${this.genomeOffset.length}) != ${this.nGenomes + 1}`)
    }
    if (this.chromOffset[0] !== 0) {
      fail(`chrom_offset endpoints (${this.chromOffset[0]}, ${this.nBins}) do not bracket the table`)
    }
    if (this.genomeOffset[0] !== 0 || this.genomeOffset[this.nGenomes] !== this.nContigs) {
      fail(
        `genome_offset endpoints (${this.genomeOffset[0]}, ${this.genomeOffset[this.nGenomes]}) ` +
          `do not bracket the table (0, ${this.nContigs})`,
      )
    }

    // Declared counts must agree with what is actually there. `nnz` is read
    // from the dataset *shape*, which costs nothing and never touches a pixel.
    const declared: [string, number | null, number, string][] = [
      ['nchroms', this.info.ncontigs, this.nContigs, 'len(/contigs)'],
      ['ngenomes', this.info.ngenomes, this.nGenomes, 'len(/genomes)'],
      ['nbins', this.info.nbins, this.nBins, 'len(/bins)'],
      ['nnz', this.info.nnz, this.handle.datasetLength('pixels/bin1_id'), 'len(/pixels)'],
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
