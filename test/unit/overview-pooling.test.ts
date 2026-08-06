/**
 * The overview's axes, and the accumulator behind them.
 *
 * The old behaviour was to keep the densest 2,048 units and drop the rest —
 * 98.7% of the contigs on the reference file — and the "densest" was itself a
 * one-sided proxy that favoured whatever came first in the file. Nothing is
 * dropped now: units share slots. These are the properties that has to keep.
 */

import { describe, expect, it } from 'vitest'

import {
  apportion,
  overviewUnitCap,
  OVERVIEW_HARD_CAP,
  poolUnits,
  TriangleAccumulator,
} from '@/worker/overview'

describe('poolUnits', () => {
  it('is the identity below the cap, and says nothing was pooled', () => {
    const pooling = poolUnits(4395, 8192)
    expect(pooling.pooled).toBe(false)
    expect(pooling.slots).toBe(4395)
    expect(Array.from(pooling.slotOf.slice(0, 5))).toEqual([0, 1, 2, 3, 4])
    expect(pooling.slotOf[4394]).toBe(4394)
  })

  it('represents every unit above the cap — none is dropped', () => {
    const count = 154_468
    const pooling = poolUnits(count, 4096)
    expect(pooling.pooled).toBe(true)
    expect(pooling.slots).toBeLessThanOrEqual(4096)
    expect(pooling.slotOf).toHaveLength(count)
    const seen = new Set<number>()
    for (let i = 0; i < count; i++) {
      const slot = pooling.slotOf[i]
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(pooling.slots)
      seen.add(slot)
    }
    // And every slot is used, so the picture has no blank rows.
    expect(seen.size).toBe(pooling.slots)
  })

  it('assigns slots monotonically, so the axis keeps file order', () => {
    const pooling = poolUnits(10_000, 1_000)
    for (let i = 1; i < 10_000; i++) {
      expect(pooling.slotOf[i]).toBeGreaterThanOrEqual(pooling.slotOf[i - 1])
    }
  })

  it('never lets a slot straddle a group boundary', () => {
    // 900 contigs in 30 genomes of unequal size, pooled into 100 slots.
    const sizes = Array.from({ length: 30 }, (_, g) => 10 + g * 2)
    const group: number[] = []
    sizes.forEach((size, g) => {
      for (let k = 0; k < size; k++) group.push(g)
    })
    const pooling = poolUnits(group.length, 100, (position) => group[position])
    expect(pooling.pooled).toBe(true)

    const groupOfSlot = new Map<number, number>()
    for (let i = 0; i < group.length; i++) {
      const slot = pooling.slotOf[i]
      const already = groupOfSlot.get(slot)
      if (already === undefined) groupOfSlot.set(slot, group[i])
      else expect(already).toBe(group[i])
    }
    // Every group got at least one slot of its own.
    expect(new Set(groupOfSlot.values()).size).toBe(sizes.length)
  })

  it('falls back to a flat split when there are more groups than slots', () => {
    // 5,000 genomes cannot each have a slot in 100; the groups are themselves
    // too many to draw, and coarsening them is the honest answer.
    const pooling = poolUnits(10_000, 100, (position) => position % 5_000)
    expect(pooling.slots).toBe(100)
    expect(pooling.pooled).toBe(true)
    for (let i = 1; i < 10_000; i++) {
      expect(pooling.slotOf[i]).toBeGreaterThanOrEqual(pooling.slotOf[i - 1])
    }
  })
})

describe('apportion', () => {
  it('hands out exactly the total, with at least one each', () => {
    for (const [sizes, total] of [
      [[10, 20, 30], 12],
      [[1, 1, 1, 1], 4],
      [[100, 1, 1], 10],
      [[5], 5],
    ] as Array<[number[], number]>) {
      const share = apportion(sizes, total)
      expect(Array.from(share).reduce((a, b) => a + b, 0)).toBe(total)
      for (const s of share) expect(s).toBeGreaterThanOrEqual(1)
    }
  })

  it('gives the larger runs the larger shares', () => {
    const share = apportion([1, 10, 100], 60)
    expect(share[2]).toBeGreaterThan(share[1])
    expect(share[1]).toBeGreaterThan(share[0])
  })
})

describe('overviewUnitCap', () => {
  it('rises with the budget while memory is what binds', () => {
    // Below the raster's width memory is still the constraint, and the cap is
    // still derived rather than fixed. Above it the picture binds first — a 1 GB
    // budget already affords 10,798 units and no screen can show them — which is
    // why the two budgets this used to compare, 1 GB and 4 GB, now give the same
    // answer. That is the point of the change, not a regression: units past
    // `RASTER_MAX_DIM` were pooled a second time on the way to the screen, flat
    // and blind to the genome boundaries `poolUnits` had just snapped to.
    const small = overviewUnitCap(1e8)
    const large = overviewUnitCap(2e8)
    expect(large).toBeGreaterThan(small)
    expect(large).toBeLessThan(OVERVIEW_HARD_CAP)
  })

  it('never exceeds the hard cap, or falls below a drawable axis', () => {
    expect(overviewUnitCap(1e12)).toBe(OVERVIEW_HARD_CAP)
    expect(overviewUnitCap(1)).toBeGreaterThanOrEqual(256)
    // The reference file's 4,395 genomes no longer each get a row: 4,096 is what
    // the renderer draws, so `poolUnits` pools the last few hundred into
    // neighbours *within their genomes* rather than letting the raster mix them
    // across boundaries.
    expect(overviewUnitCap(4e9)).toBe(OVERVIEW_HARD_CAP)
  })
})

describe('TriangleAccumulator', () => {
  it('holds half the cells and answers in either order', () => {
    const n = 7
    const acc = new TriangleAccumulator(n)
    acc.add(2, 5, 3)
    acc.add(5, 2, 4)
    expect(acc.get(2, 5)).toBe(7)
    expect(acc.get(5, 2)).toBe(7)
    acc.add(3, 3, 11)
    expect(acc.get(3, 3)).toBe(11)
  })

  it('mirrors into a full square, diagonal once', () => {
    const n = 4
    const acc = new TriangleAccumulator(n)
    let expected = 0
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) acc.add(a, b, ++expected)
    }
    const square = acc.toSquare()
    let k = 0
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) {
        k += 1
        expect(square[a * n + b]).toBe(k)
        expect(square[b * n + a]).toBe(k)
      }
    }
  })

  it('agrees with a full mirrored accumulator, cell for cell', () => {
    const n = 23
    const acc = new TriangleAccumulator(n)
    const reference = new Float64Array(n * n)
    let seed = 5
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 5_000; i++) {
      const a = Math.floor(rnd() * n)
      const b = Math.min(n - 1, a + Math.floor(rnd() * 5))
      const v = Math.ceil(rnd() * 100)
      acc.add(a, b, v)
      // The loop this replaced: a direct write plus a mirrored one.
      reference[a * n + b] += v
      if (a !== b) reference[b * n + a] += v
    }
    expect(Array.from(acc.toSquare())).toEqual(Array.from(Float32Array.from(reference)))
  })
})
