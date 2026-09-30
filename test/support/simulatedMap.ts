/**
 * Contact maps simulated from a genome whose contact law and trans level are
 * chosen here, drawn with Poisson noise from a seeded generator and read
 * through the picture's own pass (`metacooler/picture.ts`) — a truth known by
 * construction, for the method that proposes edits and the stage that shows
 * them (SPECS §27.11).
 */

import { LensGrid } from '../../src/edit/grid'
import { METHOD_GATHER } from '../../src/edit/method'
import { EditedAssembly, emptyEdit } from '../../src/genome/edit'
import { Coords } from '../../src/metacooler/coords'
import type { ReadPlan, SpanScanOptions } from '../../src/metacooler/matrix'
import { pictureLayout, readPicture, type PictureContacts } from '../../src/metacooler/picture'
import type { PixelStore, ScanAllOptions } from '../../src/metacooler/store'
import type { Extent, PixelChunk } from '../../src/types'

/** Pixels in memory, as a cooler's table holds them: upper triangle, sorted by row. */
class MemoryStore implements PixelStore {
  readonly countKind = 'i' as const
  constructor(
    readonly bin1: Int32Array,
    readonly bin2: Int32Array,
    readonly count: Float64Array,
  ) {}
  get nnz(): number {
    return this.count.length
  }
  scoreColumns(): string[] {
    return ['count']
  }
  binOffsets(): Float64Array {
    throw new Error('not needed')
  }
  private rows(bands: readonly Extent[]): PixelChunk {
    const keep: number[] = []
    for (let i = 0; i < this.bin1.length; i++) if (bands.some(([lo, hi]) => this.bin1[i] >= lo && this.bin1[i] < hi)) keep.push(i)
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
    options.onChunk(this.rows([[0, Number.MAX_SAFE_INTEGER]]))
  }
}

/** A seeded generator, so a failure is the same failure every time. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** A Poisson draw: Knuth's for small means, the normal's for large ones. */
function poisson(mean: number, random: () => number): number {
  if (mean < 30) {
    const limit = Math.exp(-mean)
    let k = 0
    let p = random()
    while (p > limit) {
      k++
      p *= random()
    }
    return k
  }
  const u = Math.max(1e-12, random())
  const v = random()
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal))
}

/** A stretch of a true chromosome, as a piece of an assembled sequence: `[from, to)` cells, and the way it reads. */
export type TruePiece = [chromosome: number, from: number, to: number, strand: 1 | -1]

/**
 * A map of a genome of two true chromosomes, 300 and 200 cells of 1 kb, drawn
 * as the assembly `sequences` lays them out: every cell's true place, contacts
 * falling off as `(d + 1)^−1.1` along a chromosome from 400 at a cell with
 * itself, and a trans level of 0.3.
 */
export async function simulate(
  sequences: TruePiece[][],
  seed = 7,
  /** Cells the balancer drops, as a masked subtelomere is dropped. */
  masked: readonly number[] = [],
): Promise<{ contacts: PictureContacts; grid: LensGrid; names: string[]; lengths: number[]; offsets: number[] }> {
  const place: Array<[number, number]> = []
  const lengths: number[] = []
  for (const pieces of sequences) {
    let cells = 0
    for (const [chromosome, from, to, strand] of pieces) {
      for (let k = 0; k < to - from; k++) place.push([chromosome, strand === 1 ? from + k : to - 1 - k])
      cells += to - from
    }
    lengths.push(cells * 1000)
  }
  const n = place.length
  const random = rng(seed)
  const b1: number[] = []
  const b2: number[] = []
  const c: number[] = []
  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      const [ca, pa] = place[a]
      const [cb, pb] = place[b]
      const mean = ca === cb ? 400 * Math.pow(Math.abs(pa - pb) + 1, -1.1) : 0.3
      const k = poisson(mean, random)
      if (k === 0) continue
      b1.push(a)
      b2.push(b)
      c.push(k)
    }
  }
  const offsets = [0]
  for (const length of lengths) offsets.push(offsets[offsets.length - 1] + length / 1000)
  const coords = new Coords(1000, Float64Array.from(offsets), Float64Array.from(lengths))
  const layout = pictureLayout(coords, 1)
  const read = await readPicture({
    store: new MemoryStore(Int32Array.from(b1), Int32Array.from(b2), Float64Array.from(c)),
    coords,
    layout,
    weights: Float64Array.from({ length: n }, (_, bin) => (masked.includes(bin) ? Number.NaN : 1)),
    gather: METHOD_GATHER,
  })
  const names = sequences.map((_, i) => `s${i + 1}`)
  const assembly = EditedAssembly.of(emptyEdit({ names, lengths }))
  const grid = LensGrid.of(assembly, {
    binsize: 1000,
    sequences: names.map((name, i) => ({ name, length: lengths[i], firstCell: offsets[i], cells: offsets[i + 1] - offsets[i] })),
  })
  return { contacts: read?.contacts as PictureContacts, grid, names, lengths, offsets }
}

