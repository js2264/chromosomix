/**
 * Two sequence sets against each other (SPECS §28): the minimizers of each,
 * the anchors their merge-join makes, and the streaks those chain into — a
 * reordering a line that jumps, an inversion a line that turns, a repeat
 * family dropped rather than a square of noise.
 */

import { describe, expect, it } from 'vitest'

import { anchorsOf, densityOf, locate, minimizersOf, oneToOne, orderByKey, sequenceSet, streaksOf, windowFor } from '@/dotplot/dotplot'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Random bases, the same every time for a seed. */
function random(length: number, seed: number): string {
  let x = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
    out += 'ACGT'[(x >>> 16) & 3]
  }
  return out
}

function reverseComplement(text: string): string {
  const pair: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' }
  return [...text].reverse().map((base) => pair[base]).join('')
}

describe('the minimizers', () => {
  it('are canonical: a sequence and its reverse complement share every one, the other way round', () => {
    const text = random(20_000, 7)
    const set = sequenceSet([{ name: 's', length: text.length }])
    const forward = minimizersOf(set, () => bytes(text), 10)
    const backward = minimizersOf(set, () => bytes(reverseComplement(text)), 10)
    expect(forward.count).toBeGreaterThan(20_000 / 10)
    const anchors = anchorsOf(forward, backward)
    // Every anchor the other way round, on the anti-diagonal x + y = length − k.
    let reversed = 0
    for (let i = 0; i < anchors.count; i++) if (anchors.strand[i] === -1 && anchors.x[i] + anchors.y[i] === text.length - 19) reversed++
    expect(reversed / anchors.count).toBeGreaterThan(0.95)
  })

  it('are sorted by hash without a comparator', () => {
    const keys = Uint32Array.from([5, 0xffffffff, 3, 0x10000, 3, 0])
    expect(Array.from(orderByKey(keys)).map((i) => keys[i])).toEqual([0, 3, 3, 5, 0x10000, 0xffffffff])
  })

  it('sample a set to stay under a budget', () => {
    expect(windowFor(12_000_000, 4_000_000)).toBe(5)
    expect(windowFor(12_000_000)).toBe(11)
    expect(windowFor(1_000, 4_000_000)).toBe(1)
  })
})

describe('two assemblies against each other', () => {
  // A: two chromosomes. B: A's first with its middle turned, and its second's
  // halves swapped — an inversion, and a reordering.
  const one = random(60_000, 11)
  const two = random(40_000, 23)
  const a = sequenceSet([
    { name: 'I', length: one.length },
    { name: 'II', length: two.length },
  ])
  const turned = one.slice(0, 20_000) + reverseComplement(one.slice(20_000, 40_000)) + one.slice(40_000)
  const swapped = two.slice(20_000) + two.slice(0, 20_000)
  const b = sequenceSet([
    { name: 'I', length: turned.length },
    { name: 'II', length: swapped.length },
  ])
  const readA = (name: string): Uint8Array => bytes(name === 'I' ? one : two)
  const readB = (name: string): Uint8Array => bytes(name === 'I' ? turned : swapped)

  it('draw the inversion as a line that turns and the reordering as one that jumps', () => {
    const anchors = anchorsOf(minimizersOf(a, readA, 5), minimizersOf(b, readB, 5))
    const streaks = streaksOf(anchors)
    const described = streaks.map((streak) => {
      const x = locate(a, streak.x0)
      const y = locate(b, streak.y0)
      return `${a.names[x.sequence]}:${Math.round(x.at / 1000)}k→${b.names[y.sequence]}:${Math.round(y.at / 1000)}k ${streak.strand === 1 ? '+' : '−'} ${Math.round((streak.x1 - streak.x0) / 1000)}kb`
    })
    expect(described).toEqual([
      'I:0k→I:0k + 20kb',
      'I:20k→I:20k − 20kb',
      'I:40k→I:40k + 20kb',
      'II:0k→II:20k + 20kb',
      'II:20k→II:0k + 20kb',
    ])
  })

  it('drop a repeat family rather than draw it as a square', () => {
    const unit = random(300, 99)
    const repeated = Array.from({ length: 80 }, (_, i) => unit + random(700, 1000 + i)).join('')
    const set = sequenceSet([{ name: 'r', length: repeated.length }])
    const m = minimizersOf(set, () => bytes(repeated), 5)
    const offDiagonal = (most: number): number => {
      const anchors = anchorsOf(m, m, most)
      let off = 0
      for (let i = 0; i < anchors.count; i++) if (anchors.x[i] !== anchors.y[i]) off++
      return off
    }
    expect(anchorsOf(m, m).dropped).toBeGreaterThan(0)
    // The copies' own minimizers go; what stays is a copy's edges, where the
    // window a k-mer wins in reaches into what flanks it — and only in some.
    expect(offDiagonal(50)).toBeLessThan(0.1 * offDiagonal(Number.POSITIVE_INFINITY))
  })

  it('say which streak each anchor is part of, and none for a chance match', () => {
    const anchors = anchorsOf(minimizersOf(a, readA, 5), minimizersOf(b, readB, 5))
    const member = new Int32Array(anchors.count)
    const streaks = streaksOf(anchors, undefined, undefined, undefined, member)
    let placed = 0
    let astray = 0
    for (let i = 0; i < anchors.count; i++) {
      const m = member[i]
      if (m < 0) continue
      placed++
      const streak = streaks[m]
      const inside = anchors.x[i] >= streak.x0 && anchors.x[i] < streak.x1 && anchors.y[i] >= streak.y0 && anchors.y[i] < streak.y1
      if (!inside || anchors.strand[i] !== streak.strand) astray++
    }
    expect(astray).toBe(0)
    expect(placed).toBe(streaks.reduce((sum, streak) => sum + streak.anchors, 0))
  })

  it('count anchors on a grid square in bases, signed by the way round they read', () => {
    const anchors = anchorsOf(minimizersOf(a, readA, 5), minimizersOf(b, readB, 5))
    const grid = densityOf(anchors, a, b, 10)
    expect([grid.ncols, grid.nrows, grid.cellSize]).toEqual([10, 10, 10_000])
    // I:20-40k against itself, turned: its anti-diagonal y = 60k − x crosses
    // the cell of x 30-40k and y 20-30k, and counts it negative.
    expect(grid.values[2 * 10 + 3]).toBeLessThan(0)
    expect(grid.values[0]).toBeGreaterThan(0)
  })
})

describe('one to one', () => {
  // A mobile element, 3 kb, in four places of each assembly, each between
  // flanks of its own: the flanks put each copy at one place, and every copy
  // meets every other besides.
  const element = random(3_000, 5)
  const flank = (i: number): string => random(8_000, 300 + i)
  const text = Array.from({ length: 4 }, (_, i) => flank(i) + element).join('') + flank(4)
  const a = sequenceSet([{ name: 'A', length: text.length }])
  const b = sequenceSet([{ name: 'B', length: text.length }])
  const read = (): Uint8Array => bytes(text)

  it('keeps each stretch at its best place and drops the grid its copies draw with each other', () => {
    const anchors = anchorsOf(minimizersOf(a, read, 5), minimizersOf(b, read, 5))
    const streaks = streaksOf(anchors)
    // Every copy against every other: the grid, beside the diagonal.
    const off = streaks.filter((streak) => streak.x0 !== streak.y0)
    expect(off.length).toBeGreaterThanOrEqual(12)
    const kept = oneToOne(streaks, a, b)
    const left = streaks.filter((_, i) => kept[i] === 1)
    expect(left.every((streak) => Math.abs(streak.x0 - streak.y0) < 100)).toBe(true)
    // The diagonal whole: every base of it along x is still some kept streak's.
    const along = left.reduce((sum, streak) => sum + (streak.x1 - streak.x0), 0)
    expect(along).toBeGreaterThan(0.95 * text.length)
  })
})
