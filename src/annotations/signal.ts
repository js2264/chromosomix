/**
 * The text signal formats — bedGraph and wig — and the track they become.
 *
 * ## Why this exists at all
 *
 * The app writes bedGraph and could not read one. Every analysis result offers
 * a *bedGraph* button beside its bigWig button (`analysis/write/bedgraph.ts`),
 * and dropping the file back on the page produced a row of grey boxes: the
 * sniffer knew three formats and a four-column bedGraph is BED-shaped, so its
 * value column landed in `name` and the track drew as featureless segments with
 * no signal in them at all. Silently — which is the worst of the three ways that
 * could have gone.
 *
 * That asymmetry is the reason, and it is not the whole of it. bedGraph is what
 * MACS, deepTools, cooltools and most of the pipeline world emit when they are
 * not emitting bigWig, and asking a reader to run `bedGraphToBigWig` before they
 * can look at their own output is exactly the "one more step" this project
 * exists to delete.
 *
 * ## Why a track and not a feature set
 *
 * A bedGraph *is* a bigWig, written out. So it becomes the same kind of thing: a
 * `kind: 'track'` entry whose data stays in the worker and is sampled per view
 * (§8.2), rather than a `FeatureSet` shipped whole to the main thread. That is
 * what gives it a range, a ceiling, an autoscale, a colour, the ⌘-scroll and
 * every other affordance a bigWig already has — none of which had to be written
 * again, because none of them knows what a bigWig is either.
 *
 * The one thing it cannot borrow is bigWig's zoom levels. A bigWig carries
 * pre-computed summaries on disk and picks one by `basesPerSpan`; a text file
 * carries nothing, so {@link IntervalTrack} computes the summary for the window
 * it was asked about. Same answer, paid for at read time instead of at write
 * time, which is the trade the format itself already made.
 */

import { contigIndexOf } from '../genome/naming'

import { isInteger } from './parse'

/** One contig's intervals, sorted by start, with no overlaps assumed. */
export interface SignalContig {
  name: string
  starts: Int32Array
  ends: Int32Array
  values: Float32Array
}

export interface SignalSet {
  contigs: SignalContig[]
  /** Interval count over every contig — the one-line summary's number. */
  length: number
  min: number
  max: number
}

/** What the sniffer concluded a text signal file is. */
export type SignalFormat = 'bedgraph' | 'wig'

/**
 * Whether these lines are a signal file rather than a feature file.
 *
 * Two questions, asked in this order because only the first is unambiguous.
 *
 * **wig says so out loud.** A `fixedStep` or `variableStep` declaration line is
 * the format's own name for itself and nothing else has one.
 *
 * **bedGraph is BED with a number in column four**, which is the case that has
 * to be judged rather than read. A `track type=bedGraph` line settles it where
 * there is one, and where there is not the test is that every data row has
 * *exactly* four columns and a finite number in the fourth. Exactly four
 * matters: a BED6 has a numeric score in column five and a name in four, and a
 * BED4 has a *name* in four — so a file that could be either is only a bedGraph
 * if it is four columns wide and that column is numeric on every row inspected.
 *
 * The name is not consulted. A `.bdg`, a `.bedgraph` and a `.txt` out of a
 * pipeline are the same file, and §8.3's rule is that the content decides.
 */
export function sniffSignal(text: string): SignalFormat | null {
  const lines = text.split('\n', 200)
  let dataRows = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (/^(fixedStep|variableStep)\b/i.test(line)) return 'wig'
    if (/^track\b/i.test(line)) {
      if (/type\s*=\s*"?bedGraph/i.test(line)) return 'bedgraph'
      if (/type\s*=\s*"?wiggle_0/i.test(line)) return 'wig'
      continue
    }
    if (line.startsWith('#') || /^browser\b/i.test(line)) continue
    const columns = line.split(/\t| +/)
    if (columns.length !== 4) return null
    if (!isInteger(columns[1]) || !isInteger(columns[2])) return null
    const value = Number(columns[3])
    if (!Number.isFinite(value) || columns[3].trim() === '') return null
    dataRows += 1
    // Four rows is enough to be sure and cheap enough to always pay: a file
    // whose first row is numeric by coincidence is not one whose first four are.
    if (dataRows >= 4) return 'bedgraph'
  }
  return dataRows > 0 ? 'bedgraph' : null
}

/**
 * Accumulates one contig's intervals without knowing how many there will be.
 *
 * Exported for `annotations/bedmethyl.ts`, which is a third text format that
 * becomes a track: a modification call is a number at a place, so it wants this
 * builder, this sort and {@link finishSet}, and a copy of them beside it would
 * be a second place for the sort-on-finish rule to be got wrong.
 */
export class ContigBuilder {
  private starts: number[] = []
  private ends: number[] = []
  private values: number[] = []

  constructor(readonly name: string) {}

  push(start: number, end: number, value: number): void {
    this.starts.push(start)
    this.ends.push(end)
    this.values.push(value)
  }

  get length(): number {
    return this.starts.length
  }

  /**
   * Freeze into typed arrays, sorted by start.
   *
   * Sorted here rather than assumed, because a bedGraph out of a pipeline that
   * merged two runs is legal and unsorted, and every consumer below — the
   * binary search in {@link IntervalTrack.samples} above all — is written
   * against ascending starts. Sorting a file that is already sorted costs one
   * pass over an index array and nothing else.
   */
  finish(): SignalContig {
    const n = this.starts.length
    const order = Int32Array.from({ length: n }, (_, i) => i)
    let sorted = true
    for (let i = 1; i < n; i++) {
      if (this.starts[i] < this.starts[i - 1]) {
        sorted = false
        break
      }
    }
    if (!sorted) order.sort((a, b) => this.starts[a] - this.starts[b])
    const starts = new Int32Array(n)
    const ends = new Int32Array(n)
    const values = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const at = order[i]
      starts[i] = this.starts[at]
      ends[i] = this.ends[at]
      values[i] = this.values[at]
    }
    return { name: this.name, starts, ends, values }
  }
}

/**
 * Parse a bedGraph.
 *
 * `chrom start end value`, 0-based half-open, exactly as this repo's own writer
 * emits it. Comment, `track` and `browser` lines are skipped; a row that is not
 * four numeric-shaped columns is skipped rather than fatal, because a file with
 * one bad line in a million is a file somebody still wants to look at.
 */
export function parseBedGraph(text: string): SignalSet {
  const builders = new Map<string, ContigBuilder>()
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let length = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^(track|browser)\b/i.test(line)) continue
    const columns = line.split(/\t| +/)
    if (columns.length < 4) continue
    const start = Number(columns[1])
    const end = Number(columns[2])
    const value = Number(columns[3])
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isFinite(value)) continue
    if (end <= start) continue
    let builder = builders.get(columns[0])
    if (builder === undefined) {
      builder = new ContigBuilder(columns[0])
      builders.set(columns[0], builder)
    }
    builder.push(start, end, value)
    length += 1
    if (value < min) min = value
    if (value > max) max = value
  }
  return finishSet(builders, length, min, max)
}

/**
 * Parse a wig — both step styles, and the one detail that catches everybody.
 *
 * **wig is 1-based and inclusive; everything else here is 0-based and
 * half-open.** A `variableStep` position of `1` is the first base, so it becomes
 * `[0, span)`. Getting this wrong shifts an entire track by one base, which is
 * invisible at any zoom that matters and wrong at the one that does — the zoom
 * where somebody is checking whether a peak sits on a boundary.
 *
 * `span` defaults to 1 and `step` to 1, per the specification, and both are
 * sticky: they are properties of the declaration line and hold until the next.
 */
export function parseWig(text: string): SignalSet {
  const builders = new Map<string, ContigBuilder>()
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let length = 0

  let mode: 'fixed' | 'variable' | null = null
  let contig = ''
  let span = 1
  let step = 1
  let cursor = 0
  let builder: ContigBuilder | null = null

  const add = (start: number, value: number): void => {
    if (builder === null || !Number.isFinite(value)) return
    builder.push(start, start + span, value)
    length += 1
    if (value < min) min = value
    if (value > max) max = value
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^(track|browser)\b/i.test(line)) continue

    const declaration = /^(fixedStep|variableStep)\s+(.*)$/i.exec(line)
    if (declaration !== null) {
      mode = declaration[1].toLowerCase() === 'fixedstep' ? 'fixed' : 'variable'
      const fields = new Map<string, string>()
      for (const pair of declaration[2].split(/\s+/)) {
        const at = pair.indexOf('=')
        if (at > 0) fields.set(pair.slice(0, at).toLowerCase(), pair.slice(at + 1))
      }
      contig = fields.get('chrom') ?? ''
      span = Number(fields.get('span') ?? 1) || 1
      step = Number(fields.get('step') ?? 1) || 1
      // 1-based in the file, 0-based here, and the conversion belongs at the
      // one point the file's own numbering is read.
      cursor = (Number(fields.get('start') ?? 1) || 1) - 1
      if (contig === '') {
        builder = null
        continue
      }
      builder = builders.get(contig) ?? new ContigBuilder(contig)
      builders.set(contig, builder)
      continue
    }

    if (mode === null || builder === null) continue
    if (mode === 'fixed') {
      add(cursor, Number(line))
      cursor += step
    } else {
      const columns = line.split(/\t| +/)
      if (columns.length < 2) continue
      const position = Number(columns[0])
      if (!Number.isInteger(position)) continue
      add(position - 1, Number(columns[1]))
    }
  }
  return finishSet(builders, length, min, max)
}

export function finishSet(
  builders: Map<string, ContigBuilder>,
  length: number,
  min: number,
  max: number,
): SignalSet {
  const contigs: SignalContig[] = []
  for (const builder of builders.values()) {
    if (builder.length > 0) contigs.push(builder.finish())
  }
  return {
    contigs,
    length,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  }
}

/**
 * A parsed signal file, answering the same `sample` request a bigWig does.
 *
 * Held in the worker for the life of its entry, exactly as `OpenTrack` and
 * `SequenceStore` are, and for the same reason: a lane draws a window at a time,
 * and shipping the whole thing to the main thread would carry megabytes across
 * so that a few hundred pixels of it could be read.
 */
export class IntervalTrack {
  private readonly byName = new Map<string, SignalContig>()

  constructor(private readonly set: SignalSet) {
    for (const contig of set.contigs) this.byName.set(contig.name, contig)
  }

  /**
   * This track's contig for a name a lane asked with, whatever spells it.
   *
   * Exact first, through the map built above, which is every lane of the map
   * this track was loaded against. The fallback is for the others: a deck draws
   * one track beside every panel and each asks by its own file's spelling
   * (§5.9).
   */
  private held(name: string): SignalContig | undefined {
    const direct = this.byName.get(name)
    if (direct !== undefined) return direct
    const at = contigIndexOf(this.set.contigs, name)
    return at < 0 ? undefined : this.set.contigs[at]
  }

  get contigNames(): string[] {
    return this.set.contigs.map((contig) => contig.name)
  }

  get extent(): { min: number; max: number } {
    return { min: this.set.min, max: this.set.max }
  }

  get length(): number {
    return this.set.length
  }

  has(name: string): boolean {
    return this.held(name) !== undefined
  }

  /**
   * The values of one window, at the grain the caller can draw.
   *
   * Two regimes, and the switch between them is what a bigWig's zoom levels do
   * on disk. Below one interval per pixel the intervals are returned as they
   * are; above it they are **binned to the pixel grid**, and a bin carries its
   * mean alongside its min and its max — which is what `summary: true` promises
   * and what lets a lane draw the envelope rather than a line through whichever
   * interval happened to land on a pixel centre.
   *
   * The mean is weighted by covered bases, not by interval count. A bedGraph out
   * of a peak caller has intervals of wildly different widths, and an unweighted
   * mean of those is a number describing the file's segmentation rather than the
   * signal.
   */
  samples(
    contig: string,
    start: number,
    end: number,
    basesPerPixel: number,
  ): {
    starts: Int32Array
    ends: Int32Array
    values: Float32Array
    min: Float32Array | null
    max: Float32Array | null
    summary: boolean
  } | null {
    const held = this.held(contig)
    if (held === undefined || end <= start) return null

    const from = lowerBound(held.ends, start)
    let to = from
    while (to < held.starts.length && held.starts[to] < end) to += 1
    if (to <= from) {
      return {
        starts: new Int32Array(0),
        ends: new Int32Array(0),
        values: new Float32Array(0),
        min: null,
        max: null,
        summary: false,
      }
    }

    const width = Math.max(1, basesPerPixel)
    const pixels = Math.ceil((end - start) / width)
    // One interval per pixel or fewer: nothing is gained by binning, and the
    // interval bounds themselves are what a lane wants to draw.
    if (to - from <= pixels) {
      return {
        starts: held.starts.slice(from, to),
        ends: held.ends.slice(from, to),
        values: held.values.slice(from, to),
        min: null,
        max: null,
        summary: false,
      }
    }

    const starts = new Int32Array(pixels)
    const ends = new Int32Array(pixels)
    const values = new Float32Array(pixels)
    const mins = new Float32Array(pixels)
    const maxes = new Float32Array(pixels)
    const weight = new Float64Array(pixels)
    const sum = new Float64Array(pixels)
    mins.fill(Number.NaN)
    maxes.fill(Number.NaN)
    for (let p = 0; p < pixels; p++) {
      starts[p] = Math.round(start + p * width)
      ends[p] = Math.round(Math.min(end, start + (p + 1) * width))
    }
    for (let i = from; i < to; i++) {
      const lo = Math.max(held.starts[i], start)
      const hi = Math.min(held.ends[i], end)
      if (hi <= lo) continue
      const value = held.values[i]
      const firstPixel = Math.max(0, Math.floor((lo - start) / width))
      const lastPixel = Math.min(pixels - 1, Math.floor((hi - 1 - start) / width))
      for (let p = firstPixel; p <= lastPixel; p++) {
        const covered = Math.min(hi, ends[p]) - Math.max(lo, starts[p])
        if (covered <= 0) continue
        sum[p] += value * covered
        weight[p] += covered
        if (Number.isNaN(mins[p]) || value < mins[p]) mins[p] = value
        if (Number.isNaN(maxes[p]) || value > maxes[p]) maxes[p] = value
      }
    }
    for (let p = 0; p < pixels; p++) {
      values[p] = weight[p] > 0 ? sum[p] / weight[p] : Number.NaN
    }
    return { starts, ends, values, min: mins, max: maxes, summary: true }
  }
}

/** First index whose end is strictly past `position`. */
function lowerBound(ends: Int32Array, position: number): number {
  let lo = 0
  let hi = ends.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ends[mid] <= position) lo = mid + 1
    else hi = mid
  }
  return lo
}
