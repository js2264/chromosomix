/**
 * The import, end to end: a `.pairs` in, a resolution ladder out.
 *
 * Three phases, and they are separated because the user stands between the
 * first and the second.
 *
 * 1. {@link probePairs} — read the header and, where there is one, the index.
 *    Cheap: a preamble and a small BGZF file. It answers *what is in here and
 *    what would it cost*, which is what the resolution dialog needs in order to
 *    be a decision rather than a guess.
 * 2. {@link importPairs} — the one pass. Bins the base rung, then derives the
 *    others from it.
 * 3. The result is held by the caller and every rung is served from it.
 *
 * ## Why the base resolution has to be asked
 *
 * Every other container this app opens *states* its resolutions. A pairs file
 * has none — it is a list of contacts, and the grid is a choice the reader
 * makes. So there is a dialog before the map exists, which is a genuinely new
 * interaction here, and {@link suggestBase} exists so it opens with a defensible
 * number in it rather than an empty box: the finest grid whose pixel table
 * plausibly fits the memory budget, given the record count and the assembly
 * size.
 *
 * ## Why the ladder is nearly free
 *
 * See `ladder.ts`. The base rung costs a pass over the records; every rung
 * above it costs a pass over the base rung's pixels, which is smaller by
 * roughly the ratio of records to stored pixels — thirteen to one on this
 * repository's yeast demo. So a five-rung ladder is not five times the work,
 * it is the pass plus a few per cent.
 */

import { ViewerError } from '../errors'
import type { ByteSource } from '../types'
import { deviceDenseBudgetBytes } from '../metacooler/matrix'
import { binPairs, type BinnedPixels } from './bin'
import { binCountFor, readPairsHeader, type PairsHeader } from './format'
import { aggregatePixels, ladderSizes } from './ladder'
import { loadPx2, spansFor, splitKey, type Px2Index } from './px2'

/** Bytes a stored pixel occupies in the imported table: three int32s. */
export const BYTES_PER_PIXEL = 12

/** What a probe learned, and what the dialog is drawn from. */
export interface PairsProbe {
  header: PairsHeader
  /** `null` when no `.px2` was found beside the file. */
  index: Px2Index | null
  /** Exact when indexed, `null` otherwise. */
  records: number | null
  /** Total assembly length, for the suggested resolution. */
  genomeLength: number
  /** Bytes of the file itself, the fallback progress denominator. */
  sourceBytes: number
}

export interface ImportOptions {
  /** Bin size of the base rung, in base pairs. */
  base: number
  /** How many rungs the ladder has, base included. */
  rungs: number
  /** Restrict the import to these chromosome-pair keys. All of them when absent. */
  keys?: readonly string[]
  /** Positions are 1-based, per the spec. Default `true`. */
  oneBased?: boolean
  /** Pixel-table budget; `deviceDenseBudgetBytes()` when absent. */
  maxPixelBytes?: number
  onProgress?: (done: number, total: number, note?: string) => void
  cancelled?: () => boolean
}

/** Every rung of one imported file. */
export interface PairsImport {
  header: PairsHeader
  /** Bin sizes, finest first. */
  rungs: number[]
  /** Pixel table per rung. */
  tables: Map<number, BinnedPixels>
  indexed: boolean
  declaredRecords: number | null
}

/**
 * Read the header, and the index if one is beside the file.
 *
 * `openIndex` is a callback rather than a path because the two sources this app
 * has are opened very differently — a local `File` handed over by a drop target
 * and a URL over range requests — and neither of them knows how to derive a
 * sibling of the other's kind.
 */
export async function probePairs(
  source: ByteSource,
  openIndex: () => Promise<ByteSource | null>,
): Promise<PairsProbe> {
  const header = await readPairsHeader(source)
  let index: Px2Index | null = null
  try {
    index = await loadPx2(openIndex)
  } catch (error) {
    // A broken index is worth saying out loud, but it is not worth refusing the
    // file over: without one the import reads the whole file, which is exactly
    // what an unindexed file does.
    if (!(error instanceof ViewerError)) throw error
    index = null
  }
  let genomeLength = 0
  for (const contig of header.contigs) genomeLength += contig.length
  return {
    header,
    index,
    records: index?.linecount ?? null,
    genomeLength,
    sourceBytes: source.size,
  }
}

/**
 * A defensible default base resolution for this file.
 *
 * Two things bound it, and the finer of them wins. The pixel table cannot pass
 * the memory budget, and `nnz` is at most the record count — so a file with
 * few records can afford a fine grid however big its assembly is. And the bin
 * count itself has to stay sane, because the importer holds one `Int32Array` of
 * `nBins` as its scratch row.
 *
 * Rounded to the 1-2-5 series so the number in the box is one a reader would
 * have typed: 1 kb, 2 kb, 5 kb, and not 3,168 bp.
 */
export function suggestBase(probe: PairsProbe, budgetBytes = deviceDenseBudgetBytes()): number {
  const records = probe.records ?? estimateRecords(probe)
  const affordablePixels = Math.max(1, Math.floor(budgetBytes / BYTES_PER_PIXEL))
  // A grid finer than this cannot pay for itself: below roughly one bin per
  // eight records the table is mostly singletons, which is a scatter plot of
  // the file rather than a contact map.
  const targetBins = Math.max(1_000, Math.min(Math.sqrt(affordablePixels * 2), 200_000))
  const raw = Math.max(1, probe.genomeLength / targetBins)
  const capped = Math.max(raw, probe.genomeLength / Math.max(1, Math.sqrt(records)))
  return roundToSeries(capped)
}

/** Record count guessed from file size, for a file with no index. */
function estimateRecords(probe: PairsProbe): number {
  // A pairs record is ~55 bytes of text and compresses about 4.5×. Only ever
  // used to pick a *default* in a dialog the reader can overrule.
  return Math.max(1, Math.round((probe.sourceBytes * 4.5) / 55))
}

/** Round up to the next 1-2-5 value: 1, 2, 5, 10, 20, 50, 100, … */
export function roundToSeries(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1
  const decade = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * decade) return step * decade
  }
  return 10 * decade
}

/**
 * Estimate what a base resolution would cost, before committing to it.
 *
 * The pixel count cannot be known without binning — that is the honest answer
 * and the reason this returns a *bound* rather than a figure. `nnz` is at most
 * the record count and at most the number of cells in the upper triangle, and
 * the smaller of those two is a real ceiling. The dialog shows it as one.
 */
export function estimateCost(
  probe: PairsProbe,
  base: number,
): { nBins: number; maxPixels: number; maxBytes: number; scratchBytes: number } {
  const nBins = binCountFor(probe.header.contigs, base)
  const records = probe.records ?? estimateRecords(probe)
  const cells = (nBins * (nBins + 1)) / 2
  const maxPixels = Math.min(records, cells)
  return {
    nBins,
    maxPixels,
    maxBytes: maxPixels * BYTES_PER_PIXEL,
    // The importer's dense scratch row, which is `nBins` int32s plus its
    // touched list — the one allocation that scales with the grid rather than
    // with the data.
    scratchBytes: nBins * 8,
  }
}

/**
 * Run the import.
 *
 * Progress is reported as one bar across the whole job: the pass over the
 * records is the bulk of it and the rungs are the tail, weighted so the bar
 * does not stall at 99% while four aggregations run.
 *
 * @returns `null` when the caller cancelled.
 */
export async function importPairs(
  source: ByteSource,
  probe: PairsProbe,
  options: ImportOptions,
): Promise<PairsImport | null> {
  const sizes = ladderSizes(options.base, options.rungs)
  const budget = options.maxPixelBytes ?? deviceDenseBudgetBytes()

  // The pass is most of the work; the rungs share what is left. Weighting them
  // this way is what keeps the bar honest rather than smooth.
  const PASS_SHARE = 0.85
  const report = (fraction: number, note: string): void => {
    options.onProgress?.(Math.round(fraction * 1000), 1000, note)
  }

  const spans = options.keys === undefined ? undefined : spansForKeys(probe, options.keys, source)

  const binOptions: Parameters<typeof binPairs>[1] = {
    binSize: options.base,
    contigs: probe.header.contigs,
    columns: probe.header.columns,
    oneBased: options.oneBased ?? true,
    maxPixelBytes: budget,
    onProgress: (done, total, note) => {
      report(total > 0 ? (done / total) * PASS_SHARE : 0, note ?? 'reading records')
    },
  }
  if (spans !== undefined) binOptions.spans = spans
  if (probe.records !== null) binOptions.expectedRecords = probe.records
  if (options.cancelled !== undefined) binOptions.cancelled = options.cancelled

  const base = await binPairs(source, binOptions)
  if (base === null) return null

  const tables = new Map<number, BinnedPixels>([[options.base, base]])
  for (let i = 1; i < sizes.length; i++) {
    const size = sizes[i]
    const rung = await aggregatePixels(base, size, {
      onProgress: (done, total) => {
        const within = total > 0 ? done / total : 1
        const step = (i - 1 + within) / Math.max(1, sizes.length - 1)
        report(PASS_SHARE + step * (1 - PASS_SHARE), `building the ${formatBp(size)} rung`)
      },
      ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled }),
    })
    if (rung === null) return null
    tables.set(size, rung)
  }
  report(1, 'done')

  return {
    header: probe.header,
    rungs: sizes,
    tables,
    indexed: probe.index !== null,
    declaredRecords: probe.records,
  }
}

/**
 * Byte spans for a set of chromosome-pair keys.
 *
 * Present for the scoped import — bin four contigs of a metagenome without
 * reading the other two thousand — and unused by the default path, which reads
 * the file whole. It is here rather than in the dialog because the *index* is
 * what makes it possible and the index lives on this side.
 */
function spansForKeys(
  probe: PairsProbe,
  keys: readonly string[],
  source: ByteSource,
): Array<{ from: number; to: number }> | undefined {
  if (probe.index === null) return undefined
  const spans = spansFor(probe.index, keys, source)
  // An empty span list would import nothing at all, which is never what a
  // selection meant: a key set that matches no index entry falls back to the
  // whole file rather than to silence.
  return spans.length === 0 ? undefined : spans
}

/** The chromosome pairs an index knows about, as ordinary name pairs. */
export function indexedPairs(index: Px2Index): Array<[string, string]> {
  return index.keys.map((key) => splitKey(key, index.splitChar))
}

/** `5000` → `5 kb`, for a progress note and a dialog label. */
export function formatBp(size: number): string {
  if (size >= 1_000_000 && size % 1_000_000 === 0) return `${size / 1_000_000} Mb`
  if (size >= 1_000 && size % 1_000 === 0) return `${size / 1_000} kb`
  return `${size} bp`
}
