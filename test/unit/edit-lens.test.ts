/**
 * The lens in the reader (SPECS §27.2, §27.7): the edited map read as though
 * it were a file.
 *
 * Held to the definition rather than to what the code happens to do: every
 * edited cell `(i, j)` is the stored cell `(orig(i), orig(j))`, and a gap is
 * empty — so a dense read of any window of the edited map, through the ordinary
 * `readDenseMatrix` and the lens's store, must equal that matrix built by hand
 * from the original. Windows on the diagonal, off it and across a gap, and
 * edits that turn, move, copy and set aside, are the cases.
 */

import { describe, expect, it } from 'vitest'

import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import { Coords } from '../../src/metacooler/coords'
import { BinLens, LensStore, lensFor } from '../../src/metacooler/lens'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { readDenseMatrix, type ReadPlan, type SpanScanOptions } from '../../src/metacooler/matrix'
import type { PixelStore, ScanAllOptions } from '../../src/metacooler/store'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import type { Extent, PixelChunk } from '../../src/types'

class MemoryStore implements PixelStore {
  readonly countKind = 'i' as const
  constructor(
    readonly bin1: Int32Array,
    readonly bin2: Int32Array,
    readonly count: Float64Array,
    readonly nBins: number,
  ) {}
  get nnz(): number {
    return this.count.length
  }
  scoreColumns(): string[] {
    return ['count']
  }
  binOffsets(): Float64Array {
    const offsets = new Float64Array(this.nBins + 1)
    for (let i = 0; i < this.bin1.length; i++) offsets[this.bin1[i] + 1]++
    for (let b = 0; b < this.nBins; b++) offsets[b + 1] += offsets[b]
    return offsets
  }
  private rows(bands: readonly Extent[]): PixelChunk {
    const keep: number[] = []
    for (let i = 0; i < this.bin1.length; i++) {
      if (bands.some(([lo, hi]) => this.bin1[i] >= lo && this.bin1[i] < hi)) keep.push(i)
    }
    return {
      bin1: Int32Array.from(keep, (i) => this.bin1[i]),
      bin2: Int32Array.from(keep, (i) => this.bin2[i]),
      count: Float64Array.from(keep, (i) => this.count[i]),
      length: keep.length,
    }
  }
  async forEachWindow(_r: Extent, _c: Extent, plan: ReadPlan, onChunk: (c: PixelChunk) => void): Promise<boolean> {
    onChunk(this.rows([plan.span]))
    return true
  }
  async forEachBands(bands: readonly Extent[], onChunk: (c: PixelChunk) => void, _o?: SpanScanOptions): Promise<boolean> {
    onChunk(this.rows(bands))
    return true
  }
  async scanAll(options: ScanAllOptions): Promise<void> {
    options.onChunk(this.rows([[0, this.nBins]]))
  }
}

/**
 * A store with a two-dimensional index, as a `.hic` is: it reads a rectangle
 * rather than a band — and, as a `.hic`'s blocks do, hands back more than the
 * rectangle, here a bin past it on every side.
 */
class BlockStore extends MemoryStore {
  readonly rectangular = true
  bandReads = 0
  override async forEachWindow(rows: Extent, cols: Extent, _plan: ReadPlan, onChunk: (c: PixelChunk) => void): Promise<boolean> {
    const lo = Math.max(0, Math.min(rows[0], cols[0]) - 1)
    const hi = Math.min(this.nBins, Math.max(rows[1], cols[1]) + 1)
    const keep: number[] = []
    for (let i = 0; i < this.bin1.length; i++) {
      if (this.bin1[i] >= lo && this.bin1[i] < hi && this.bin2[i] >= lo && this.bin2[i] < hi) keep.push(i)
    }
    onChunk({
      bin1: Int32Array.from(keep, (i) => this.bin1[i]),
      bin2: Int32Array.from(keep, (i) => this.bin2[i]),
      count: Float64Array.from(keep, (i) => this.count[i]),
      length: keep.length,
    })
    return true
  }
  override async forEachBands(bands: readonly Extent[], onChunk: (c: PixelChunk) => void, o?: SpanScanOptions): Promise<boolean> {
    this.bandReads++
    return super.forEachBands(bands, onChunk, o)
  }
}

/** `I` 10 kb and `II` 6 kb at 1 kb: 16 bins, every pair a distinct value. */
const coords = new Coords(1000, Float64Array.from([0, 10, 16]), Float64Array.from([10_000, 6_000]))
const NAMES = ['I', 'II']
const ORIGINAL = { names: NAMES, lengths: [10_000, 6_000] }
const value = (a: number, b: number): number => {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return 1 + lo * 100 + hi
}
function store(Kind: typeof MemoryStore = MemoryStore): MemoryStore {
  const b1: number[] = []
  const b2: number[] = []
  const c: number[] = []
  for (let i = 0; i < 16; i++) {
    for (let j = i; j < 16; j++) {
      b1.push(i)
      b2.push(j)
      c.push(value(i, j))
    }
  }
  return new Kind(Int32Array.from(b1), Int32Array.from(b2), Float64Array.from(c), 16)
}

function lensOf(...steps: EditStep[]): BinLens {
  let edit: ReferenceEdit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return BinLens.of(coords, NAMES, EditedAssembly.of(edit))
}

/** A window of the edited map, read the ordinary way through the lens. */
async function read(lens: BinLens, rows: Extent, cols: Extent, file: MemoryStore = store()): Promise<Float32Array> {
  const source = {
    handle: undefined as never,
    nBins: lens.nBins,
    storageMode: 'symmetric-upper' as const,
    store: new LensStore(file, lens, true),
  }
  return (await readDenseMatrix(source, { rows, cols }, 'test')).values
}

/** The same window, from the definition. */
function expected(lens: BinLens, rows: Extent, cols: Extent): Float32Array {
  const out = new Float32Array((rows[1] - rows[0]) * (cols[1] - cols[0]))
  for (let i = rows[0]; i < rows[1]; i++) {
    for (let j = cols[0]; j < cols[1]; j++) {
      const a = lens.toOriginal[i]
      const b = lens.toOriginal[j]
      out[(i - rows[0]) * (cols[1] - cols[0]) + (j - cols[0])] = a < 0 || b < 0 ? 0 : value(a, b)
    }
  }
  return out
}

describe('the bins', () => {
  it('are the file’s own under no edit', () => {
    const lens = lensOf()
    expect(Array.from(lens.toOriginal)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(Array.from(lens.chromOffset)).toEqual([0, 10, 16])
  })

  it('read a turned stretch backwards', () => {
    const lens = lensOf({ op: 'invert', sequence: 'I', from: 2000, to: 5000 })
    expect(Array.from(lens.toOriginal.subarray(0, 10))).toEqual([0, 1, 4, 3, 2, 5, 6, 7, 8, 9])
    expect(lens.names).toEqual(['I_e1', 'II'])
  })

  it('keep cooler’s count for each sequence, whatever its junctions round to', () => {
    // `[1.4 kb, 3.6 kb)` of I after II: 6 + 2.2 kb = 8.2 kb, nine bins.
    const lens = lensOf({ op: 'move', sequence: 'I', from: 1400, to: 3600, into: 'II', at: 6000, strand: 1 })
    expect(Array.from(lens.chromOffset)).toEqual([0, 8, 17])
    expect(Array.from(lens.toOriginal.subarray(8))).toEqual([10, 11, 12, 13, 14, 15, 1, 2, 3])
  })

  it('land a stretch set aside nowhere, and a gap is no bin at all', () => {
    const lens = lensOf(
      { op: 'aside', sequence: 'II', from: 0, to: 2000, why: 'debris' },
      { op: 'join', a: 'I', aEnd: 'end', b: 'II_e1', bEnd: 'start', gap: 2000 },
    )
    expect(lens.names).toEqual(['I_e1'])
    expect(Array.from(lens.toOriginal.subarray(9, 13))).toEqual([9, -1, -1, 12])
    // Bins 10 and 11 of the original — II's first two — land nowhere.
    expect(lens.landingStart[11] - lens.landingStart[10]).toBe(0)
  })
})

describe('the map through them', () => {
  const edits: Array<[string, EditStep[]]> = [
    ['nothing', []],
    ['a turn', [{ op: 'invert', sequence: 'I', from: 2000, to: 7000 }]],
    ['a move to the other sequence, turned', [{ op: 'move', sequence: 'I', from: 3000, to: 6000, into: 'II', at: 2000, strand: -1 }]],
    ['a copy', [{ op: 'duplicate', sequence: 'II', from: 1000, to: 3000, into: 'I', at: 4000, strand: 1 }]],
    [
      'a stretch set aside, and a join with a gap',
      [
        { op: 'aside', sequence: 'I', from: 0, to: 2000, why: 'contaminant' },
        { op: 'join', a: 'II', aEnd: 'end', b: 'I_e1', bEnd: 'end', gap: 1000 },
      ],
    ],
  ]

  for (const [name, steps] of edits) {
    it(`is the stored map, cell for cell, under ${name}`, async () => {
      const lens = lensOf(...steps)
      const n = lens.nBins
      for (const [rows, cols] of [
        [[0, n], [0, n]],
        [[2, 9], [2, 9]],
        [[0, 5], [8, n]],
        [[8, n], [0, 5]],
        [[3, 12], [6, n]],
      ] as Array<[Extent, Extent]>) {
        const clip = (extent: Extent): Extent => [Math.min(extent[0], n), Math.min(extent[1], n)]
        const r = clip(rows)
        const c = clip(cols)
        expect(Array.from(await read(lens, r, c)), `${r} × ${c}`).toEqual(Array.from(expected(lens, r, c)))
        // From a store that reads rectangles, a rectangle at a time — each stored
        // pixel handed on once, though its blocks overlap — and never a band.
        const blocks = store(BlockStore) as BlockStore
        expect(Array.from(await read(lens, r, c, blocks)), `${r} × ${c}, by rectangles`).toEqual(Array.from(expected(lens, r, c)))
        expect(blocks.bandReads).toBe(0)
      }
    })
  }

  it('reads a square store, which keeps each pixel in its own row, under a copy and a turn', async () => {
    // Every ordered pair once, and no two alike: row 3 against column 5 is not
    // row 5 against column 3 in a square store.
    const ordered = (a: number, b: number): number => 1 + a * 100 + b
    const b1: number[] = []
    const b2: number[] = []
    const c: number[] = []
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        b1.push(i)
        b2.push(j)
        c.push(ordered(i, j))
      }
    }
    const square = new MemoryStore(Int32Array.from(b1), Int32Array.from(b2), Float64Array.from(c), 16)
    const lens = lensOf(
      { op: 'duplicate', sequence: 'II', from: 1000, to: 3000, into: 'I', at: 4000, strand: -1 },
      { op: 'invert', sequence: 'I_e1', from: 1000, to: 5000 },
    )
    const n = lens.nBins
    const source = { handle: undefined as never, nBins: n, storageMode: 'square' as const, store: new LensStore(square, lens, false) }
    for (const [rows, cols] of [
      [
        [0, n],
        [0, n],
      ],
      [
        [9, n],
        [0, 6],
      ],
      [
        [2, 8],
        [3, 12],
      ],
    ] as Array<[Extent, Extent]>) {
      const got = (await readDenseMatrix(source, { rows, cols }, 'test')).values
      const want: number[] = []
      for (let i = rows[0]; i < rows[1]; i++) {
        for (let j = cols[0]; j < cols[1]; j++) {
          const a = lens.toOriginal[i]
          const b = lens.toOriginal[j]
          want.push(a < 0 || b < 0 ? 0 : ordered(a, b))
        }
      }
      expect(Array.from(got), `${rows} × ${cols}`).toEqual(want)
    }
  })

  it('reads a window from the rows its pixels are kept in, and no more', () => {
    const far = lensOf({ op: 'move', sequence: 'I', from: 2000, to: 4000, into: 'II', at: 3000, strand: -1 })
    // I's first two bins against II's last three: the pixels between them are
    // kept in I's rows, which come first in the file, so II's are not read.
    expect(far.windowBands([0, 2], [13, 16])).toEqual([[0, 2]])
    expect(far.windowBands([13, 16], [0, 2])).toEqual([[0, 2]])
    // The stretch moved into II is I's bins 2 and 3, which still come after I's
    // first two in the file: the pixels between them are kept in those rows too.
    expect(far.windowBands([0, 2], [10, 13])).toEqual([[0, 2]])
    // Against I's own last bins, which come before the stretch, it is the
    // stretch's rows that hold them: 2 and 3 against 4 to 9, read in 2 and 3.
    expect(far.windowBands([11, 13], [2, 8])).toEqual([[2, 4]])
    // On the diagonal, every row the window shows.
    expect(far.windowBands([8, 16], [8, 16])).toEqual([
      [2, 4],
      [10, 16],
    ])
  })

  it('reads a store with a two-dimensional index a band at a time where a window would be too many rectangles', () => {
    // Every other bin of I turned on its own: ten bands on each axis.
    const lens = lensOf(...[0, 2, 4, 6, 8].map((k): EditStep => ({ op: 'invert', sequence: 'I', from: k * 1000, to: k * 1000 + 1000 })))
    expect(lens.originalRectangles([0, 16], [0, 16], 64)).toEqual([[[0, 16], [0, 16]]])
    const far = lensOf({ op: 'move', sequence: 'I', from: 2000, to: 4000, into: 'II', at: 3000, strand: -1 })
    // I's first two bins against II's last three: two bands, and one rectangle
    // between them — neither diagonal block, which no cell of the window shows.
    expect(far.originalRectangles([0, 2], [13, 16], 64)).toEqual([[[0, 2], [13, 16]]])
    // The stretch moved into II shows original bins 2 and 3, which close the gap
    // to the rows' own: one band, holding rows and columns both.
    expect(far.originalRectangles([0, 2], [10, 16], 64)).toEqual([
      [
        [0, 4],
        [0, 4],
      ],
      [
        [0, 4],
        [12, 16],
      ],
    ])
    expect(far.originalRectangles([0, 2], [10, 16], 1)).toBeNull()
  })
})

describe('the demo maps through an edit', () => {
  // A turn inside IV, and a stretch of IV moved into V the other way round:
  // IV_e1 and V_e1, beside each other in the file's order as IV and V were.
  const COOLER = new URL('../../demo/yeast/Yeast_microC_G2M_1kb.cool', import.meta.url).pathname
  const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname
  const maps: Array<[string, () => Promise<MetaCooler>]> = [
    ['a cooler', async () => MetaCooler.open(COOLER, await LocalFileSource.open(COOLER))],
    [
      'a .hic',
      async () => {
        const source = await LocalFileSource.fromPath(HIC)
        await source.mount()
        return MetaCooler.fromHic(`${HIC}::/resolutions/16000`, source)
      },
    ],
  ]

  for (const [name, open] of maps) {
    it(`reads ${name} as the file's own cells, placed where the edit puts them, raw and balanced`, async () => {
      const mc = await open()
      try {
        let edit = emptyEdit({ names: [...mc.chromnames], lengths: Array.from(mc.coords.contigLengths) })
        edit = withStep(edit, { op: 'invert', sequence: 'IV', from: 400_000, to: 700_000 }, 'reader', 0)
        edit = withStep(edit, { op: 'move', sequence: 'IV_e1', from: 100_000, to: 180_000, into: 'V', at: 50_000, strand: -1 }, 'reader', 1)
        const seen = MetaCooler.withLens(mc, edit)
        expect(seen.refusal).toBeNull()
        const lensed = seen.map
        expect(lensed.unlensed).toBe(mc)
        // Each edited sequence where its original was, in the file's own order.
        const iv = mc.chromnames.indexOf('IV')
        const v = mc.chromnames.indexOf('V')
        expect(lensed.chromnames).toEqual(mc.chromnames.map((c) => (c === 'IV' ? 'IV_e1' : c === 'V' ? 'V_e1' : c)))
        const lens = BinLens.of(mc.coords, mc.chromnames, EditedAssembly.of(edit))
        expect(lensed.coords.nBins).toBe(lens.nBins)

        // Windows over the edit's junctions: both ends of the turn, which the
        // move has shifted 80 kb left in IV_e1, and the stretch now in V_e1.
        const size = lensed.binsize
        const within = (c: number, from: number, to: number): Extent => {
          const [lo, hi] = lensed.coords.contigBinExtent(c)
          return [lo + Math.floor(from / size), Math.min(hi, lo + Math.ceil(to / size))]
        }
        const turn = within(iv, 250_000, 700_000)
        const moved = within(v, 0, 250_000)
        const windows: Array<[Extent, Extent]> = [
          [turn, turn],
          [turn, moved],
          [moved, turn],
          [moved, moved],
        ]
        // The file's own cells those windows show, which every edited cell below is one of.
        const blocks = [iv, v].map((c): Extent => {
          const [lo, hi] = mc.coords.contigBinExtent(c)
          let min = hi
          let max = lo
          for (const [lo2, hi2] of [turn, moved]) {
            for (let e = lo2; e < hi2; e++) {
              const bin = lens.toOriginal[e]
              if (bin >= lo && bin < hi) {
                min = Math.min(min, bin)
                max = Math.max(max, bin + 1)
              }
            }
          }
          return [min, max]
        })
        for (const balance of [false, true]) {
          if (balance && !mc.hasWeights) continue
          const stored = new Map<string, Float32Array>()
          for (const [p, rows] of blocks.entries()) {
            for (const [q, cols] of blocks.entries()) stored.set(`${p}${q}`, (await mc.matrix({ rows, cols, balance })).values)
          }
          const cell = (a: number, b: number): number => {
            const p = a >= blocks[0][0] && a < blocks[0][1] ? 0 : 1
            const q = b >= blocks[0][0] && b < blocks[0][1] ? 0 : 1
            const width = blocks[q][1] - blocks[q][0]
            return (stored.get(`${p}${q}`) as Float32Array)[(a - blocks[p][0]) * width + (b - blocks[q][0])]
          }
          const wrong: string[] = []
          for (const [rows, cols] of windows) {
            const read = await lensed.matrix({ rows, cols, balance })
            const width = cols[1] - cols[0]
            for (let i = rows[0]; i < rows[1]; i++) {
              for (let j = cols[0]; j < cols[1]; j++) {
                const got = read.values[(i - rows[0]) * width + (j - cols[0])]
                const want = cell(lens.toOriginal[i], lens.toOriginal[j])
                // Balanced, the two weights may be multiplied the other way round.
                const same = Number.isNaN(want) ? Number.isNaN(got) : Math.abs(got - want) <= Math.abs(want) * 1e-6
                if (!same && wrong.length < 5) wrong.push(`${balance ? 'balanced' : 'raw'} ${i} × ${j}: ${got}, not ${want}`)
              }
            }
          }
          expect(wrong).toEqual([])
        }
      } finally {
        mc.close()
      }
    })
  }
})

describe('an edit that does not fit', () => {
  it('is refused with the first sequence that differs', () => {
    const edit = emptyEdit({ names: ['I', 'II'], lengths: [10_000, 6_001] })
    expect(lensFor(withStep(edit, { op: 'cut', sequence: 'I', at: 5 }, 'reader', 0), NAMES, [10_000, 6_000])).toEqual({
      refusal: 'The edit was made on another assembly: II is 6001 bp in the edit and 6000 bp here.',
    })
  })

  it('is no lens at all where it changes nothing', () => {
    expect(lensFor(withStep(emptyEdit(ORIGINAL), { op: 'cut', sequence: 'I', at: 5000 }, 'reader', 0), NAMES, [10_000, 6_000])).toBeNull()
  })
})
