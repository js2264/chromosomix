/**
 * The lens in the reader (SPECS §27.2, §27.7): the edited assembly presented
 * to everything above it as though it were the file.
 *
 * An edit is drawn, never written back, and the whole session is drawn through
 * it — so the one place it can be applied without every view, task and table
 * learning about it is here, under them: a map opened with an edit answers with
 * the edited sequences' names, lengths and bins, and every pixel it hands up
 * has been carried from the original bins it was stored at to the edited bins
 * it lands at. Above this module nothing knows; below it the file is read
 * exactly as it would be without one (§13).
 *
 * ## Bins
 *
 * An edited sequence has `ceil(length / binsize)` bins, cooler's own rule, so
 * that every coordinate the rest of the app computes from a bin — a region's
 * extent, a tick, a readout — is right in the edited sequence to the bin. Its
 * parts are placed on those bins by rounding each one's edited offset to the
 * nearest bin edge, and a piece shows the original bins its own ends round to,
 * read forward or backwards, stretched or squeezed by a bin where the two
 * roundings disagree. **Bins move whole** (§27.2): every edited bin inside a
 * piece is one stored bin, every count is the integer the file stored, and what
 * is approximate is the bin a junction falls in — which holds the contacts of a
 * stored bin beside it, or of one twice, at most one bin a junction.
 *
 * Edited → original is a function ({@link BinLens.toOriginal}); original →
 * edited is a relation ({@link BinLens.landingStart}, {@link BinLens.landings}),
 * because a stretch set aside lands nowhere and one duplicated lands twice.
 */

import { EditedAssembly, isGap, mismatch, type ReferenceEdit } from '../genome/edit'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import { makeTable } from '../h5/readTable'
import type { Extent, PixelChunk, Table } from '../types'
import type { Coords } from './coords'
import { planRead, type ReadPlan, type SpanScanOptions } from './matrix'
import type { PixelStore, ScanAllOptions } from './store'

/**
 * The most rectangles one window through the lens is read as, from a store
 * that reads rectangles (`PixelStore.rectangular`); past it the window is read
 * a band at a time, as from any other store. A window across a few junctions is
 * a handful of rectangles; the whole genome of a much-edited assembly would be
 * thousands, each a walk of the file's index for one pair.
 */
const MOST_RECTANGLES = 64

export class BinLens {
  /** The edited sequences, in order. */
  readonly names: string[]
  /** Their lengths, in base pairs. */
  readonly lengths: Float64Array
  /** The first edited bin of each, and one past the last: `names.length + 1` long. */
  readonly chromOffset: Float64Array
  /** The original bin each edited bin shows; `-1` in a gap. */
  readonly toOriginal: Int32Array
  /** Where each original bin's landings begin in {@link landings}: `originalBins + 1` long. */
  readonly landingStart: Int32Array
  /** Every edited bin, grouped by the original bin it shows. */
  readonly landings: Int32Array
  readonly originalBins: number

  private constructor(fields: {
    names: string[]
    lengths: Float64Array
    chromOffset: Float64Array
    toOriginal: Int32Array
    originalBins: number
  }) {
    this.names = fields.names
    this.lengths = fields.lengths
    this.chromOffset = fields.chromOffset
    this.toOriginal = fields.toOriginal
    this.originalBins = fields.originalBins
    const start = new Int32Array(fields.originalBins + 1)
    for (const bin of fields.toOriginal) if (bin >= 0) start[bin + 1]++
    for (let b = 0; b < fields.originalBins; b++) start[b + 1] += start[b]
    const fill = start.slice(0, fields.originalBins)
    const landings = new Int32Array(start[fields.originalBins])
    fields.toOriginal.forEach((bin, edited) => {
      if (bin >= 0) landings[fill[bin]++] = edited
    })
    this.landingStart = start
    this.landings = landings
  }

  /** Edited bins in all. */
  get nBins(): number {
    return this.toOriginal.length
  }

  /**
   * The lens an edited assembly makes over one resolution of the file.
   *
   * @param names The original sequences, in file order, as `coords` indexes them.
   */
  static of(coords: Coords, names: readonly string[], assembly: EditedAssembly): BinLens {
    const size = coords.binsize
    const index = new Map(names.map((name, i) => [name, i]))
    const out: number[] = []
    const edited: string[] = []
    const lengths: number[] = []
    const offsets: number[] = [0]
    for (const sequence of assembly.sequences) {
      const length = assembly.lengthOf(sequence.name) ?? 0
      const bins = Math.ceil(length / size)
      let offset = 0
      sequence.parts.forEach((part, i) => {
        const partLength = isGap(part) ? part.gap : part.end - part.start
        const from = Math.min(bins, Math.round(offset / size))
        offset += partLength
        // The last part runs to the sequence's own last bin, so the parts'
        // roundings can never leave the count off cooler's.
        const to = i === sequence.parts.length - 1 ? bins : Math.min(bins, Math.round(offset / size))
        const count = Math.max(0, to - from)
        const c = isGap(part) ? undefined : index.get(part.sequence)
        if (isGap(part) || c === undefined) {
          for (let k = 0; k < count; k++) out.push(-1)
          return
        }
        const [first, last] = coords.contigBinExtent(c)
        const cells = last - first
        const originalLength = coords.contigLengths[c]
        const edge = (bp: number): number => (bp >= originalLength ? cells : Math.max(0, Math.min(cells, Math.round(bp / size))))
        let low = edge(part.start)
        let high = edge(part.end)
        if (high <= low) {
          // Shorter than half a bin: the bin its middle is in.
          low = Math.max(0, Math.min(cells - 1, Math.floor((part.start + part.end) / 2 / size)))
          high = low + 1
        }
        const held = high - low
        for (let k = 0; k < count; k++) {
          const j = Math.min(held - 1, Math.floor(((k + 0.5) * held) / count))
          out.push(first + (part.strand === 1 ? low + j : high - 1 - j))
        }
      })
      edited.push(sequence.name)
      lengths.push(length)
      offsets.push(out.length)
    }
    return new BinLens({
      names: edited,
      lengths: Float64Array.from(lengths),
      chromOffset: Float64Array.from(offsets),
      toOriginal: Int32Array.from(out),
      originalBins: coords.nBins,
    })
  }

  /**
   * The original rows a read of these edited extents needs, as merged bands.
   *
   * Every edited pixel in `rows × cols` comes from a stored pixel between the
   * original bins of a row and of a column, and the store keeps it at the lower
   * of the two — so the rows of both, together, hold every one of them.
   */
  originalBands(extents: readonly Extent[]): Extent[] {
    const marked = new Uint8Array(this.originalBins)
    for (const [lo, hi] of extents) {
      for (let e = Math.max(0, lo); e < Math.min(this.nBins, hi); e++) {
        const bin = this.toOriginal[e]
        if (bin >= 0) marked[bin] = 1
      }
    }
    return this.bandsOf(marked)
  }

  /**
   * The original rows a read of the edited window `rows × cols` needs, as
   * merged bands — fewer than {@link originalBands} of both. The store keeps a
   * pixel at the lower of its two bins, so a bin a row shows is needed only
   * where some column shows a bin at or after it, and a column's only where
   * some row's is: a window whose rows all come before its columns in the file
   * reads its rows alone, as the same window with no edit does.
   */
  windowBands(rows: Extent, cols: Extent): Extent[] {
    const last = ([lo, hi]: Extent): number => {
      let most = -1
      for (let e = Math.max(0, lo); e < Math.min(this.nBins, hi); e++) most = Math.max(most, this.toOriginal[e])
      return most
    }
    const marked = new Uint8Array(this.originalBins)
    for (const [[lo, hi], below] of [
      [rows, last(cols)],
      [cols, last(rows)],
    ] as const) {
      for (let e = Math.max(0, lo); e < Math.min(this.nBins, hi); e++) {
        const bin = this.toOriginal[e]
        if (bin >= 0 && bin <= below) marked[bin] = 1
      }
    }
    return this.bandsOf(marked)
  }

  private bandsOf(marked: Uint8Array): Extent[] {
    const bands: Extent[] = []
    let open = -1
    for (let b = 0; b <= this.originalBins; b++) {
      const on = b < this.originalBins && marked[b] === 1
      if (on && open < 0) open = b
      if (!on && open >= 0) {
        bands.push([open, b])
        open = -1
      }
    }
    return bands
  }

  /**
   * The original rectangles a read of the edited window `rows × cols` needs,
   * for a store that reads rectangles: the original bins of both, merged into
   * bands, and each pair of bands, the lower first, that holds a row's bin
   * against a column's. Every stored pixel between two of those bins lies in
   * exactly one of them, so a pixel is handed on once however many there are.
   * `null` where there would be more than `most`.
   */
  originalRectangles(rows: Extent, cols: Extent, most: number): Array<[Extent, Extent]> | null {
    // Bit 1: some edited row shows this bin; bit 2: some edited column does.
    const marks = new Uint8Array(this.originalBins)
    for (const [[lo, hi], bit] of [
      [rows, 1],
      [cols, 2],
    ] as const) {
      for (let e = Math.max(0, lo); e < Math.min(this.nBins, hi); e++) {
        const bin = this.toOriginal[e]
        if (bin >= 0) marks[bin] |= bit
      }
    }
    const bands: Array<{ extent: Extent; bits: number }> = []
    let open = -1
    let bits = 0
    for (let b = 0; b <= this.originalBins; b++) {
      const mark = b < this.originalBins ? marks[b] : 0
      if (mark !== 0) {
        if (open < 0) {
          open = b
          bits = 0
        }
        bits |= mark
      } else if (open >= 0) {
        bands.push({ extent: [open, b], bits })
        open = -1
      }
    }
    const out: Array<[Extent, Extent]> = []
    for (let i = 0; i < bands.length; i++) {
      for (let j = i; j < bands.length; j++) {
        const a = bands[i].bits
        const c = bands[j].bits
        if (!((a & 1 && c & 2) || (a & 2 && c & 1))) continue
        if (out.length === most) return null
        out.push([bands[i].extent, bands[j].extent])
      }
    }
    return out
  }

  /**
   * Stored pixels carried to where they land.
   *
   * @param upper The store holds each pair once, lower bin first — and so the
   *   edited pixels are handed on the same way. A pixel on an original diagonal
   *   whose bin lands twice is each *pair* of its landings once.
   * @param within One of {@link originalRectangles}: only the pixels inside it,
   *   either way round, are carried. A store that reads rectangles hands back
   *   whole blocks, and a block can reach into the next rectangle.
   */
  translate(chunk: PixelChunk, upper: boolean, out: ChunkBuffer, within?: readonly [Extent, Extent]): PixelChunk {
    out.reset()
    const { landingStart, landings } = this
    const [[r0, r1], [c0, c1]] = within ?? [
      [0, this.originalBins],
      [0, this.originalBins],
    ]
    for (let i = 0; i < chunk.length; i++) {
      const b1 = chunk.bin1[i]
      const b2 = chunk.bin2[i]
      if (within !== undefined) {
        const direct = b1 >= r0 && b1 < r1 && b2 >= c0 && b2 < c1
        if (!direct && !(b1 >= c0 && b1 < c1 && b2 >= r0 && b2 < r1)) continue
      }
      const s1 = landingStart[b1]
      const e1 = landingStart[b1 + 1]
      if (s1 === e1) continue
      const s2 = landingStart[b2]
      const e2 = landingStart[b2 + 1]
      if (s2 === e2) continue
      const value = chunk.count[i]
      // Kept once for both orientations, a pixel on the diagonal is each pair
      // of its landings once; a square store keeps both, and so gets both.
      if (b1 === b2 && upper) {
        for (let a = s1; a < e1; a++) {
          for (let c = a; c < e1; c++) out.push(landings[a], landings[c], value, upper)
        }
        continue
      }
      for (let a = s1; a < e1; a++) {
        for (let c = s2; c < e2; c++) out.push(landings[a], landings[c], value, upper)
      }
    }
    return out.chunk()
  }

  /** A per-bin column of the original, in edited order: `NaN` in a gap. */
  gather(values: Float64Array, lo = 0, hi = this.nBins): Float64Array {
    const out = new Float64Array(Math.max(0, hi - lo))
    for (let e = lo; e < hi; e++) {
      const bin = this.toOriginal[e]
      out[e - lo] = bin >= 0 && bin < values.length ? values[bin] : Number.NaN
    }
    return out
  }

  /** The same, for a column of text: empty in a gap. */
  gatherText(values: readonly string[], lo = 0, hi = this.nBins): string[] {
    const out: string[] = []
    for (let e = lo; e < hi; e++) {
      const bin = this.toOriginal[e]
      out.push(bin >= 0 && bin < values.length ? values[bin] : '')
    }
    return out
  }
}

/** A growable chunk, reused from one translation to the next. */
export class ChunkBuffer {
  private bin1 = new Int32Array(1024)
  private bin2 = new Int32Array(1024)
  private count = new Float64Array(1024)
  private length = 0

  reset(): void {
    this.length = 0
  }

  push(a: number, b: number, value: number, upper: boolean): void {
    if (this.length === this.bin1.length) this.grow()
    const swap = upper && a > b
    this.bin1[this.length] = swap ? b : a
    this.bin2[this.length] = swap ? a : b
    this.count[this.length] = value
    this.length++
  }

  chunk(): PixelChunk {
    return { bin1: this.bin1, bin2: this.bin2, count: this.count, length: this.length }
  }

  private grow(): void {
    const size = this.bin1.length * 2
    const bin1 = new Int32Array(size)
    bin1.set(this.bin1)
    const bin2 = new Int32Array(size)
    bin2.set(this.bin2)
    const count = new Float64Array(size)
    count.set(this.count)
    this.bin1 = bin1
    this.bin2 = bin2
    this.count = count
  }
}

/**
 * The pixels of the edited map: the file's own, read in the original rows a
 * question needs and carried to the edited bins they land at.
 */
export class LensStore implements PixelStore {
  private readonly buffer = new ChunkBuffer()

  constructor(
    private readonly inner: PixelStore,
    private readonly lens: BinLens,
    private readonly upper: boolean,
  ) {}

  get nnz(): number | null {
    return this.inner.nnz
  }

  get countKind(): 'i' | 'u' | 'f' {
    return this.inner.countKind
  }

  scoreColumns(): string[] {
    return this.inner.scoreColumns()
  }

  /** Each edited bin's stored-pixel count is its original bin's — a density, for sorting and estimates. */
  binOffsets(): Float64Array {
    const inner = this.inner.binOffsets()
    const out = new Float64Array(this.lens.nBins + 1)
    for (let e = 0; e < this.lens.nBins; e++) {
      const bin = this.lens.toOriginal[e]
      out[e + 1] = out[e] + (bin >= 0 ? inner[bin + 1] - inner[bin] : 0)
    }
    return out
  }

  /**
   * The edited window, from the original rows it needs — or, from a store that
   * reads rectangles, from the original rectangles it needs: a `.hic` read a
   * band at a time answers a window near the diagonal with those rows against
   * the whole genome, a block for every one.
   */
  async forEachWindow(
    rows: Extent,
    cols: Extent,
    _plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options?: SpanScanOptions,
  ): Promise<boolean> {
    const rectangles = this.inner.rectangular === true ? this.lens.originalRectangles(rows, cols, MOST_RECTANGLES) : null
    if (rectangles === null) {
      // A square store keeps each pixel in its own row, whichever bin is lower.
      const bands = this.upper ? this.lens.windowBands(rows, cols) : this.lens.originalBands([rows])
      if (bands.length === 0) return true
      return this.inner.forEachBands(bands, (chunk) => onChunk(this.lens.translate(chunk, this.upper, this.buffer)), options)
    }
    const mode = this.upper ? 'symmetric-upper' : 'square'
    for (const rectangle of rectangles) {
      const [r, c] = rectangle
      const going = await this.inner.forEachWindow(
        r,
        c,
        planRead(r, c, mode),
        (chunk) => onChunk(this.lens.translate(chunk, this.upper, this.buffer, rectangle)),
        options,
      )
      if (!going) return false
    }
    return true
  }

  forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options?: SpanScanOptions,
  ): Promise<boolean> {
    const original = this.lens.originalBands(bands)
    if (original.length === 0) return Promise.resolve(true)
    return this.inner.forEachBands(original, (chunk) => onChunk(this.lens.translate(chunk, this.upper, this.buffer)), options)
  }

  scanAll(options: ScanAllOptions): Promise<void> {
    return this.inner.scanAll({
      ...options,
      onChunk: (chunk) => options.onChunk(this.lens.translate(chunk, this.upper, this.buffer)),
    })
  }
}

/**
 * The file's handle, answering for the edited assembly where a question is
 * about sequences or bins: the sequence table, the bin columns — the weights
 * above all, carried to the edited bins as the pixels are — and the counts in
 * the root's attributes. Every other path is the file's own.
 */
export function lensedHandle(
  handle: Hdf5Handle,
  lens: BinLens,
  table: Table,
  attrs: Record<string, AttrValue>,
): Hdf5Handle {
  const numeric = new Map<string, Float64Array>()
  const text = new Map<string, string[]>()
  const isBins = (path: string): boolean => path.startsWith('bins/')
  const isSequences = (path: string): boolean => path === 'chroms' || path === 'contigs'
  return new Proxy(handle, {
    get(target, property) {
      switch (property) {
        case 'attrs':
          return (): Record<string, AttrValue> => attrs
        case 'datasetLength':
          return (path: string): number => {
            if (isBins(path)) return lens.nBins
            if (path.startsWith('chroms/') || path.startsWith('contigs/')) return table.length
            return target.datasetLength(path)
          }
        case 'readNumeric':
          return (path: string, lo?: number, hi?: number): Float64Array => {
            if (!isBins(path)) return target.readNumeric(path, lo, hi)
            let all = numeric.get(path)
            if (all === undefined) {
              all = target.readNumeric(path)
              numeric.set(path, all)
            }
            return lens.gather(all, lo ?? 0, hi ?? lens.nBins)
          }
        case 'readStrings':
          return (path: string, lo?: number, hi?: number): string[] => {
            if (!isBins(path)) return target.readStrings(path, lo, hi)
            let all = text.get(path)
            if (all === undefined) {
              all = target.readStrings(path)
              text.set(path, all)
            }
            return lens.gatherText(all, lo ?? 0, hi ?? lens.nBins)
          }
        case 'readTable':
          return (path: string, lo?: number, hi?: number, columns?: readonly string[]): Table =>
            isSequences(path) ? table : target.readTable(path, lo, hi, columns)
        default: {
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        }
      }
    },
  })
}

/** The edited sequences as the `/chroms` table a cooler carries: a name and a length. */
export function sequenceTable(lens: BinLens): Table {
  return makeTable(lens.names.length, ['name', 'length'], { name: lens.names, length: lens.lengths })
}

/** Whether an edit changes anything a map would show, and applies to these sequences. */
export function lensFor(
  edit: ReferenceEdit,
  names: readonly string[],
  lengths: ArrayLike<number>,
  options: { always?: boolean } = {},
): { assembly: EditedAssembly } | { refusal: string } | null {
  const wrong = mismatch(edit, names, Array.from(lengths))
  if (wrong !== null) return { refusal: `The edit was made on another assembly: ${wrong}.` }
  const assembly = EditedAssembly.of(edit)
  // An edit that changes nothing is the map as it is — but for one of some of
  // its sequences, which is those sequences alone.
  return assembly.isIdentity && options.always !== true ? null : { assembly }
}
