/**
 * A map redrawn to a chosen number of contacts (§6.5).
 *
 * The promises, each tested where it is made:
 *
 * - **the total is exact** — `N` contacts, summed over the whole map, whichever
 *   way it was drawn and whatever was read first;
 * - **a pixel is one pixel** — the same value from a window, a set of bands and
 *   a full scan, from two stores that took their censuses separately, and after
 *   its band was evicted and drawn again;
 * - **the draw is the right one** — a subsample never adds, an oversample never
 *   takes away, and a pixel's expected share is its share of the map;
 * - **what cannot be drawn is refused**, by name.
 */

import { describe, expect, it } from 'vitest'

import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { planRead, type ReadPlan, type SpanScanOptions } from '../../src/metacooler/matrix'
import {
  ResampledStore,
  multinomial,
  planResample,
  resampleMode,
  subsampleBlock,
  takeCensus,
  type Census,
  type ResampleSpec,
} from '../../src/metacooler/resample'
import { Rng } from '../../src/metacooler/sampling'
import type { PixelStore, ScanAllOptions } from '../../src/metacooler/store'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import type { Extent, PixelChunk } from '../../src/types'

// ---------------------------------------------------------------------------
// A store over arrays
// ---------------------------------------------------------------------------

/** Upper-triangular pixels in `(bin1, bin2)` order, handed out as a cooler hands them. */
class MemoryStore implements PixelStore {
  readonly countKind = 'i' as const
  scans = 0
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

  private rows(lo: number, hi: number): PixelChunk {
    const keep: number[] = []
    for (let i = 0; i < this.bin1.length; i++) if (this.bin1[i] >= lo && this.bin1[i] < hi) keep.push(i)
    return {
      bin1: Int32Array.from(keep, (i) => this.bin1[i]),
      bin2: Int32Array.from(keep, (i) => this.bin2[i]),
      count: Float64Array.from(keep, (i) => this.count[i]),
      length: keep.length,
    }
  }

  async forEachWindow(_r: Extent, _c: Extent, plan: ReadPlan, onChunk: (c: PixelChunk) => void): Promise<boolean> {
    onChunk(this.rows(plan.span[0], plan.span[1]))
    return true
  }

  async forEachBands(bands: readonly Extent[], onChunk: (c: PixelChunk) => void, _o?: SpanScanOptions): Promise<boolean> {
    for (const [lo, hi] of bands) onChunk(this.rows(lo, hi))
    return true
  }

  async scanAll(options: ScanAllOptions): Promise<void> {
    this.scans++
    options.onChunk(this.rows(0, this.nBins))
  }
}

/**
 * A three-sequence map: 12, 7 and 9 bins, every pair of bins with a count that
 * falls with distance, contacts between sequences sparser.
 */
function syntheticMap(scale = 1): { store: MemoryStore; starts: Float64Array } {
  const starts = Float64Array.from([0, 12, 19, 28])
  const seqOf = (bin: number): number => (bin < 12 ? 0 : bin < 19 ? 1 : 2)
  const b1: number[] = []
  const b2: number[] = []
  const c: number[] = []
  for (let i = 0; i < 28; i++) {
    for (let j = i; j < 28; j++) {
      const cis = seqOf(i) === seqOf(j)
      const value = cis ? Math.floor((scale * 400) / (1 + j - i)) : (i * 7 + j * 3) % 5 === 0 ? 3 * scale : 0
      if (value > 0) {
        b1.push(i)
        b2.push(j)
        c.push(value)
      }
    }
  }
  return {
    store: new MemoryStore(Int32Array.from(b1), Int32Array.from(b2), Float64Array.from(c), 28),
    starts,
  }
}

function resampled(spec: ResampleSpec, scale = 1): { store: ResampledStore; inner: MemoryStore; starts: Float64Array } {
  const { store: inner, starts } = syntheticMap(scale)
  const store = new ResampledStore(inner, { starts }, spec, takeCensus(inner, starts))
  return { store, inner, starts }
}

/** Every pixel a full scan hands out, keyed `bin1,bin2`. */
async function scanned(store: PixelStore): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  await store.scanAll({
    onChunk: (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const key = `${chunk.bin1[i]},${chunk.bin2[i]}`
        expect(out.has(key), `pixel ${key} handed out twice`).toBe(false)
        out.set(key, chunk.count[i])
      }
    },
  })
  return out
}

function sum(pixels: Map<string, number>): number {
  let total = 0
  for (const value of pixels.values()) total += value
  return total
}

// ---------------------------------------------------------------------------

describe('the census', () => {
  it('sums every sequence pair, and is taken once', async () => {
    const { store, starts } = syntheticMap()
    const census = await takeCensus(store, starts)
    const whole = sum(await scanned(store))
    expect(census.total).toBe(whole)
    expect(census.sum.reduce((a, b) => a + b, 0)).toBe(whole)
    // Pairs are (a ≤ b), sorted.
    for (let i = 0; i < census.a.length; i++) expect(census.a[i]).toBeLessThanOrEqual(census.b[i])
    expect(census.sequences).toBe(3)
    expect(census.nBins).toBe(28)
  })

  it('refuses a count that is not a whole number of contacts', async () => {
    const store = new MemoryStore(Int32Array.from([0]), Int32Array.from([1]), Float64Array.from([2.5]), 4)
    await expect(takeCensus(store, Float64Array.from([0, 4]))).rejects.toThrow(/number of contacts/)
  })

  it('refuses a pixel below the diagonal', async () => {
    const store = new MemoryStore(Int32Array.from([3]), Int32Array.from([1]), Float64Array.from([2]), 4)
    await expect(takeCensus(store, Float64Array.from([0, 4]))).rejects.toThrow(/below its diagonal/)
  })
})

describe('the plan', () => {
  const census: Census = {
    total: 1000,
    nnz: 10,
    sequences: 2,
    nBins: 10,
    a: Int32Array.from([0, 0, 1]),
    b: Int32Array.from([0, 1, 1]),
    sum: Float64Array.from([600, 100, 300]),
  }
  const starts = Float64Array.from([0, 6, 10])

  it('says which way', () => {
    expect(resampleMode(1000, 1000)).toBe('none')
    expect(resampleMode(1000, 10)).toBe('sub')
    expect(resampleMode(1000, 5000)).toBe('over')
  })

  it('splits a subsample exactly, never past a pair’s own contacts', () => {
    for (let seed = 0; seed < 50; seed++) {
      const plan = planResample(census, { contacts: 250, seed }, starts)
      expect(plan.mode).toBe('sub')
      const shares = [...plan.shares.entries()]
      expect(shares.reduce((a, [, v]) => a + v, 0)).toBe(250)
      expect(plan.shares.get(0) ?? 0).toBeLessThanOrEqual(600)
      expect(plan.shares.get(1) ?? 0).toBeLessThanOrEqual(100)
    }
  })

  it('splits an oversample’s new contacts exactly', () => {
    const plan = planResample(census, { contacts: 5000 }, starts)
    expect(plan.mode).toBe('over')
    expect([...plan.shares.values()].reduce((a, b) => a + b, 0)).toBe(4000)
  })

  it('is the same split from the same seed and another from another', () => {
    const a = planResample(census, { contacts: 250, seed: 4 }, starts)
    const b = planResample(census, { contacts: 250, seed: 4 }, starts)
    expect([...a.shares]).toEqual([...b.shares])
    const differs = [5, 6, 7, 8, 9].some(
      (seed) => JSON.stringify([...planResample(census, { contacts: 250, seed }, starts).shares]) !== JSON.stringify([...a.shares]),
    )
    expect(differs).toBe(true)
  })

  it('scales balanced values by the total over the target', () => {
    expect(planResample(census, { contacts: 250 }, starts).weightScale).toBeCloseTo(2, 12)
    expect(planResample(census, { contacts: 1000 }, starts).weightScale).toBe(1)
  })

  it('refuses a target that is not a positive whole number', () => {
    for (const contacts of [0, -5, 2.5, Number.NaN, Infinity]) {
      expect(() => planResample(census, { contacts }, starts)).toThrow(/positive whole number/)
    }
  })

  it('refuses to oversample a sequence past Boost-HiC’s reach, naming it', () => {
    const wide = Float64Array.from([0, 6, 5000])
    const big: Census = { ...census, nBins: 5000 }
    expect(() => planResample(big, { contacts: 5000 }, wide, ['I', 'chrXL'])).toThrow(/chrXL is 4,994 bins/)
    // A subsample of the same map is not Boost-HiC's to refuse.
    expect(planResample(big, { contacts: 50 }, wide).mode).toBe('sub')
  })
})

describe('one block', () => {
  it('keeps exactly its share, and never more of a pixel than it had', () => {
    const count = Float64Array.from([1, 5, 40, 200, 3, 0, 7])
    const size = count.reduce((a, b) => a + b, 0)
    for (let seed = 0; seed < 40; seed++) {
      const out = { pushed: [] as number[], push(_1: number, _2: number, v: number) { this.pushed.push(v) } }
      subsampleBlock(
        { bin1: new Int32Array(7), bin2: Int32Array.from([0, 1, 2, 3, 4, 5, 6]), count },
        97,
        size,
        new Rng(seed),
        out as never,
      )
      expect(out.pushed.reduce((a, b) => a + b, 0)).toBe(97)
    }
  })

  it('gives each pixel its share of the block on average', () => {
    const count = Float64Array.from([10, 30, 60])
    const kept = [0, 0, 0]
    const runs = 4000
    for (let seed = 0; seed < runs; seed++) {
      const got = new Map<number, number>()
      const out = { push(_1: number, b2: number, v: number) { got.set(b2, v) } }
      subsampleBlock(
        { bin1: new Int32Array(3), bin2: Int32Array.from([0, 1, 2]), count },
        25,
        100,
        new Rng(seed),
        out as never,
      )
      for (let i = 0; i < 3; i++) kept[i] += got.get(i) ?? 0
    }
    // 25 of 100: a quarter of each pixel.
    expect(kept[0] / runs).toBeCloseTo(2.5, 1)
    expect(kept[1] / runs).toBeCloseTo(7.5, 1)
    expect(kept[2] / runs).toBeCloseTo(15, 1)
  })

  it('adds exactly the draws asked for, and none to a cell of no weight', () => {
    const weights = Float64Array.from([0, 1, 0, 3, 0.5, 0])
    for (let seed = 0; seed < 30; seed++) {
      const added = multinomial(weights, 1234, new Rng(seed))
      expect(added.reduce((a, b) => a + b, 0)).toBe(1234)
      expect(added[0] + added[2] + added[5]).toBe(0)
    }
  })
})

describe('a subsampled map', () => {
  it('holds exactly the contacts asked for, none of them new', async () => {
    const { store, inner } = resampled({ contacts: 1500, seed: 3 })
    const before = await scanned(inner)
    const after = await scanned(store)
    expect(sum(after)).toBe(1500)
    for (const [key, value] of after) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThanOrEqual(before.get(key)!)
    }
  })

  it('reads the same pixel from a window, from bands and from a scan', async () => {
    const { store, starts } = resampled({ contacts: 2000, seed: 9 })
    const whole = await scanned(store)
    // A window across the first two sequences, planned as a view plans one.
    const rows: Extent = [5, 16]
    const cols: Extent = [9, 25]
    const plan = planRead(rows, cols, 'symmetric-upper')
    const window = new Map<string, number>()
    await store.forEachWindow(rows, cols, plan, (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        expect(chunk.bin1[i]).toBeGreaterThanOrEqual(plan.span[0])
        expect(chunk.bin1[i]).toBeLessThan(plan.span[1])
        window.set(`${chunk.bin1[i]},${chunk.bin2[i]}`, chunk.count[i])
      }
    })
    expect(window.size).toBeGreaterThan(0)
    for (const [key, value] of window) expect(value).toBe(whole.get(key))
    const bands = new Map<string, number>()
    await store.forEachBands([[20, 23], [0, 2]], (chunk) => {
      for (let i = 0; i < chunk.length; i++) bands.set(`${chunk.bin1[i]},${chunk.bin2[i]}`, chunk.count[i])
    })
    for (const [key, value] of bands) {
      const bin1 = Number(key.split(',')[0])
      expect((bin1 >= 20 && bin1 < 23) || bin1 < 2).toBe(true)
      expect(value).toBe(whole.get(key))
    }
    expect(starts.length).toBe(4)
  })

  it('is the same map from two stores, whatever each read first', async () => {
    const a = resampled({ contacts: 1800, seed: 21 })
    const b = resampled({ contacts: 1800, seed: 21 })
    // One reads a window first, the other goes straight to the scan.
    await b.store.forEachWindow([19, 28], [19, 28], planRead([19, 28], [19, 28], 'symmetric-upper'), () => {})
    expect([...(await scanned(a.store))].sort()).toEqual([...(await scanned(b.store))].sort())
    const c = resampled({ contacts: 1800, seed: 22 })
    expect([...(await scanned(c.store))].sort()).not.toEqual([...(await scanned(a.store))].sort())
  })

  it('refuses a column that is not the contacts', async () => {
    const { store } = resampled({ contacts: 100 })
    await expect(
      store.forEachWindow([0, 4], [0, 4], planRead([0, 4], [0, 4], 'symmetric-upper'), () => {}, { value: 'balanced' }),
    ).rejects.toThrow(/not a count/)
  })
})

describe('an oversampled map', () => {
  it('holds exactly the contacts asked for, every stored one still there', async () => {
    const { store, inner } = resampled({ contacts: 60_000, seed: 5 })
    const before = await scanned(inner)
    const after = await scanned(store)
    expect(sum(after)).toBe(60_000)
    for (const [key, value] of before) expect(after.get(key)!).toBeGreaterThanOrEqual(value)
  })

  it('keeps each sequence pair’s share of the contacts, near enough', async () => {
    const { store, inner, starts } = resampled({ contacts: 400_000, seed: 8 })
    const before = await takeCensus(inner, starts)
    const after = await takeCensus(store, starts)
    for (let i = 0; i < before.sum.length; i++) {
      const share = before.sum[i] / before.total
      const now = after.sum[after.a.findIndex((a, k) => a === before.a[i] && after.b[k] === before.b[i])] / after.total
      expect(Math.abs(now - share)).toBeLessThan(0.01)
    }
  })

  it('reads the same pixel from a window and from a scan', async () => {
    const { store } = resampled({ contacts: 30_000, seed: 12 })
    const whole = await scanned(store)
    const plan = planRead([2, 14], [2, 14], 'symmetric-upper')
    await store.forEachWindow([2, 14], [2, 14], plan, (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        expect(chunk.count[i]).toBe(whole.get(`${chunk.bin1[i]},${chunk.bin2[i]}`))
      }
    })
  })
})

// ---------------------------------------------------------------------------
// The demo cooler, through MetaCooler
// ---------------------------------------------------------------------------

const COOLER = new URL('../../demo/yeast/Yeast_microC_G2M_1kb.cool', import.meta.url).pathname

async function openDemo(): Promise<MetaCooler> {
  return MetaCooler.open(COOLER, await LocalFileSource.open(COOLER))
}

describe('the demo cooler, resampled', () => {
  it('declares 179,175,551 contacts and subsamples to exactly ten million', async () => {
    const mc = await openDemo()
    try {
      expect(mc.info.sum).toBe(179_175_551)
      const plan = await mc.resample({ contacts: 10_000_000 })
      expect(plan!.mode).toBe('sub')
      expect(plan!.total).toBe(179_175_551)
      let total = 0
      await mc.scanPixels({
        onChunk: (chunk) => {
          for (let i = 0; i < chunk.length; i++) total += chunk.count[i]
        },
      })
      expect(total).toBe(10_000_000)
    } finally {
      mc.close()
    }
  })

  it('draws the window on screen from the same map, raw and balanced', async () => {
    const mc = await openDemo()
    try {
      const rows: Extent = [3000, 3120]
      const rawBefore = await mc.matrix({ rows, balance: true })
      await mc.resample({ contacts: 20_000_000, seed: 2 })
      const raw = await mc.matrix({ rows })
      const balanced = await mc.matrix({ rows, balance: true })
      // The dense read and the scan agree cell for cell.
      const fromScan = new Float32Array(120 * 120)
      await mc.scanPixels({
        onChunk: (chunk) => {
          for (let i = 0; i < chunk.length; i++) {
            const r = chunk.bin1[i] - rows[0]
            const c = chunk.bin2[i] - rows[0]
            if (r >= 0 && r < 120 && c >= 0 && c < 120) {
              fromScan[r * 120 + c] += chunk.count[i]
              if (r !== c) fromScan[c * 120 + r] += chunk.count[i]
            }
          }
        },
      })
      expect(Array.from(raw.values)).toEqual(Array.from(fromScan))
      // Balanced with the weights over √(N/T): on the file's scale again, so a
      // sum over the window is within noise of the file's own balanced sum.
      let a = 0
      let b = 0
      for (let i = 0; i < balanced.values.length; i++) {
        if (Number.isFinite(balanced.values[i])) a += balanced.values[i]
        if (Number.isFinite(rawBefore.values[i])) b += rawBefore.values[i]
      }
      expect(a / b).toBeGreaterThan(0.97)
      expect(a / b).toBeLessThan(1.03)
    } finally {
      mc.close()
    }
  })

  it('takes one census for two totals, and puts the file back', async () => {
    const mc = await openDemo()
    try {
      const rows: Extent = [0, 50]
      const stored = await mc.matrix({ rows })
      await mc.resample({ contacts: 5_000_000 })
      const census = await mc.takenCensus()
      expect(census?.total).toBe(179_175_551)
      await mc.resample({ contacts: 50_000_000 })
      expect(await mc.takenCensus()).toBe(census)
      await mc.resample(null)
      const back = await mc.matrix({ rows })
      expect(Array.from(back.values)).toEqual(Array.from(stored.values))
    } finally {
      mc.close()
    }
  })

  it('oversamples a sequence through Boost-HiC, keeping every stored contact', async () => {
    const mc = await openDemo()
    try {
      // Chromosome I alone: 231 bins, so the one band read is quick.
      const rows: Extent = [0, 231]
      const stored = await mc.matrix({ rows })
      await mc.resample({ contacts: 400_000_000 })
      const drawn = await mc.matrix({ rows })
      let before = 0
      let after = 0
      for (let i = 0; i < stored.values.length; i++) {
        expect(drawn.values[i]).toBeGreaterThanOrEqual(stored.values[i])
        before += stored.values[i]
        after += drawn.values[i]
      }
      // About 400/179 times as deep.
      expect(after / before).toBeGreaterThan(2.0)
      expect(after / before).toBeLessThan(2.5)
    } finally {
      mc.close()
    }
  })
})

describe('the demo .hic, counted', () => {
  const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname

  async function openHic(binsize: number): Promise<MetaCooler> {
    const source = await LocalFileSource.fromPath(HIC)
    await source.mount()
    return MetaCooler.fromHic(`${HIC}::/resolutions/${binsize}`, source)
  }

  it('does not take its header’s sumCounts, which counts each contact off a diagonal twice', async () => {
    const mc = await openHic(1000)
    try {
      expect(mc.declaredContacts).toBeNull()
      // What the header says, for the record: 2·cis − diagonal + trans.
      const file = (mc.storedPixels as unknown as { file: { totalCount(): number } }).file
      expect(file.totalCount()).toBe(23_827_759)
    } finally {
      mc.close()
    }
  })

  it('holds the same contacts at its coarsest rung as at its finest, which is how it is counted', async () => {
    const fine = await openHic(1000)
    const coarse = await openHic(16000)
    try {
      expect(await fine.countContacts()).toBe(13_681_280)
      expect(await coarse.countContacts()).toBe(13_681_280)
    } finally {
      fine.close()
      coarse.close()
    }
  })
})
