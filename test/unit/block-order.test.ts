/**
 * The reader's order (§7.6): what is kept, and a block laid out in it — whole
 * genomes moved, whole contigs moved within their genome, every value with its
 * cell and every run's arithmetic with its run.
 */

import { describe, expect, it } from 'vitest'
import { orderBlock } from '../../src/render/blockOrder'
import {
  FILE_ORDER,
  OrderStore,
  arrange,
  isFileOrder,
  moveBeside,
  ranksOf,
  readOrder,
  storedOrder,
  withContigsMoved,
  withGenomesMoved,
  type ReaderOrder,
} from '../../src/state/readerOrder'
import type { AxisGroup, MatrixResult } from '../../src/worker/protocol'

/** A square block whose cell (r, c) holds `r * 100 + c`, so where a value lands says where it came from. */
function square(n: number, groups: AxisGroup[], extra: Partial<MatrixResult> = {}): MatrixResult {
  const values = new Float32Array(n * n)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) values[r * n + c] = r * 100 + c
  return {
    nrows: n,
    ncols: n,
    values,
    rowExtent: [10, 10 + n],
    colExtent: [10, 10 + n],
    rowGroups: groups,
    colGroups: groups,
    level: 'bin',
    ...extra,
  }
}

const at = (block: MatrixResult, r: number, c: number): number => block.values[r * block.ncols + c]

describe('the order kept', () => {
  it('arranges the file’s names, the placed first and the rest in the file’s order', () => {
    expect(arrange(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd'])
    expect(arrange(['a', 'b'], ['x', 'b', 'b'])).toEqual(['b', 'a'])
    expect(arrange(['a', 'b'], null)).toEqual(['a', 'b'])
  })

  it('moves names beside a neighbour, together and in their order', () => {
    expect(moveBeside(['a', 'b', 'c', 'd'], ['a'], 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveBeside(['a', 'b', 'c', 'd'], ['d', 'b'], 'a', 'before')).toEqual(['b', 'd', 'a', 'c'])
    // Beside one of themselves, or beside nobody, is nowhere.
    expect(moveBeside(['a', 'b', 'c'], ['a', 'b'], 'b', 'after')).toEqual(['a', 'b', 'c'])
    expect(moveBeside(['a', 'b', 'c'], ['a'], 'x', 'after')).toEqual(['a', 'b', 'c'])
  })

  it('moves a genome among all of them by a neighbour a picture of some can name', () => {
    const file = ['g1', 'g2', 'g3', 'g4']
    // A circle of g2 and g4 alone: g4 dropped before g2.
    const moved = withGenomesMoved(FILE_ORDER, file, ['g4'], 'g2', 'before')
    expect(moved.genomes).toEqual(['g1', 'g4', 'g2', 'g3'])
    const back = withGenomesMoved(moved, file, ['g4'], 'g3', 'after')
    expect(back.genomes).toBeNull()
    expect(isFileOrder(back)).toBe(true)
  })

  it('moves contigs within their genome alone', () => {
    const moved = withContigsMoved(FILE_ORDER, 'g1', ['a', 'b', 'c'], ['c'], 'a', 'before')
    expect(moved.contigs).toEqual({ g1: ['c', 'a', 'b'] })
    expect(moved.genomes).toBeNull()
    expect(withContigsMoved(moved, 'g1', ['a', 'b', 'c'], ['c'], 'b', 'after').contigs).toEqual({})
  })

  it('reads what storage and a workspace hold, and drops what is not a list of names', () => {
    expect(readOrder(null)).toBe(FILE_ORDER)
    expect(readOrder({ genomes: [], contigs: {} })).toBe(FILE_ORDER)
    expect(readOrder({ genomes: ['b', 'a'], contigs: { g: ['y', 'x'], bad: [1], '': ['z'] } })).toEqual({
      genomes: ['b', 'a'],
      contigs: { g: ['y', 'x'] },
    })
    const order: ReaderOrder = { genomes: ['b', 'a'], contigs: { g: ['y', 'x'] } }
    expect(readOrder(storedOrder(order))).toEqual(order)
    expect(storedOrder(FILE_ORDER)).toBeNull()
  })

  it('keeps an order per file in session memory, and tells who listens', () => {
    const key = `test|order-${Math.random()}`
    const store = new OrderStore(key)
    let heard = 0
    const off = store.subscribe(() => heard++)
    store.set({ genomes: ['b', 'a'], contigs: {} })
    expect(heard).toBe(1)
    expect(new OrderStore(key).current.genomes).toEqual(['b', 'a'])
    store.set(FILE_ORDER)
    expect(new OrderStore(key).current).toBe(FILE_ORDER)
    off()
  })
})

describe('a block in the reader’s order', () => {
  it('is the same block where nothing moves', () => {
    const block = square(3, [
      { label: 'a', start: 0, end: 1 },
      { label: 'b', start: 1, end: 3 },
    ])
    expect(orderBlock(block, ranksOf(FILE_ORDER))).toBe(block)
  })

  it('moves the genomes of a genome × genome block, every value with its cells', () => {
    const groups = ['g1', 'g2', 'g3'].map((label, i) => ({ label, start: i, end: i + 1 }))
    const block = square(3, groups, { level: 'genome', rowExtent: [0, 3], colExtent: [0, 3] })
    const out = orderBlock(block, ranksOf({ genomes: ['g3', 'g1'], contigs: {} }))
    expect(out.rowGroups.map((g) => g.label)).toEqual(['g3', 'g1', 'g2'])
    expect(out.colGroups.map((g) => [g.start, g.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
    // New (0, 1) is old (g3, g1) = (2, 0); new (2, 0) is old (g2, g3) = (1, 2).
    expect(at(out, 0, 1)).toBe(200)
    expect(at(out, 2, 0)).toBe(102)
    // The block it came from is untouched.
    expect(at(block, 0, 1)).toBe(1)
  })

  it('moves whole genome runs, and the contigs inside one, origins shifted with them', () => {
    // g1 holds a (cells 0-1) and b (cell 2); g2 holds c (cells 3-4).
    const groups: AxisGroup[] = [
      { label: 'a', start: 0, end: 2, unitStart: 10, unitBin: 10 },
      { label: 'b', start: 2, end: 3, unitStart: 12, unitBin: 12 },
      { label: 'c', start: 3, end: 5, unitStart: 13, unitBin: 13 },
    ]
    const genomes: AxisGroup[] = [
      { label: 'g1', start: 0, end: 3 },
      { label: 'g2', start: 3, end: 5 },
    ]
    const block = square(5, groups, { rowGenomes: genomes, colGenomes: genomes, genomeBoundaries: true })
    const out = orderBlock(block, ranksOf({ genomes: ['g2', 'g1'], contigs: { g1: ['b', 'a'] } }))
    expect(out.rowGroups.map((g) => `${g.label}:${g.start}-${g.end}`)).toEqual(['c:0-2', 'b:2-3', 'a:3-5'])
    expect(out.rowGenomes?.map((g) => `${g.label}:${g.start}-${g.end}`)).toEqual(['g2:0-2', 'g1:2-5'])
    // A position in a contig is (extent start + offset − unitStart) × bin size:
    // c's first cell was offset 3 and is now offset 0, so its origin moves by −3.
    const c = out.rowGroups[0]
    expect(10 + c.start - (c.unitStart ?? 0)).toBe(10 + 3 - 13)
    expect(c.unitBin).toBe(13)
    // Old cells 3,4 then 2 then 0,1.
    expect(Array.from({ length: 5 }, (_, i) => at(out, i, i))).toEqual([3, 4, 2, 0, 1].map((k) => k * 101))
    expect(at(out, 0, 4)).toBe(301)
  })

  it('moves a cell of several contigs with the first of them the reader placed', () => {
    const groups: AxisGroup[] = [
      { label: 'a', start: 0, end: 1 },
      { label: 'b', start: 1, end: 2, merged: [{ label: 'b', unitLength: 5 }, { label: 'c', unitLength: 5 }] },
    ]
    const block = square(2, groups)
    const out = orderBlock(block, ranksOf({ genomes: null, contigs: { g: ['c', 'a', 'b'] } }), { rows: 'g', cols: 'g' })
    expect(out.rowGroups.map((g) => g.label)).toEqual(['b', 'a'])
  })

  it('moves each axis of a pair by its own genome', () => {
    const rows: AxisGroup[] = [
      { label: 'a1', start: 0, end: 1 },
      { label: 'a2', start: 1, end: 2 },
    ]
    const cols: AxisGroup[] = [
      { label: 'b1', start: 0, end: 1 },
      { label: 'b2', start: 1, end: 2 },
      { label: 'b3', start: 2, end: 3 },
    ]
    const values = new Float32Array(6).map((_, i) => i)
    const block: MatrixResult = {
      nrows: 2,
      ncols: 3,
      values,
      rowExtent: [0, 2],
      colExtent: [5, 8],
      rowGroups: rows,
      colGroups: cols,
      level: 'bin',
    }
    const out = orderBlock(block, ranksOf({ genomes: null, contigs: { A: ['a2', 'a1'], B: ['b3', 'b1', 'b2'] } }), {
      rows: 'A',
      cols: 'B',
    })
    expect(out.rowGroups.map((g) => g.label)).toEqual(['a2', 'a1'])
    expect(out.colGroups.map((g) => g.label)).toEqual(['b3', 'b1', 'b2'])
    // New (0, 0) is old (a2, b3) = row 1, col 2 = 5.
    expect(out.values[0]).toBe(5)
  })

  it('leaves an axis it cannot cut, and a block read round a circle, as they are', () => {
    const gappy = square(3, [
      { label: 'a', start: 0, end: 1 },
      { label: 'b', start: 2, end: 3 },
    ])
    expect(orderBlock(gappy, ranksOf({ genomes: null, contigs: { g: ['b', 'a'] } }), { rows: 'g', cols: 'g' })).toBe(gappy)
    const wrapped = square(2, [
      { label: 'a', start: 0, end: 1 },
      { label: 'b', start: 1, end: 2 },
    ], { wrapped: [0, 2] })
    expect(orderBlock(wrapped, ranksOf({ genomes: null, contigs: { g: ['b', 'a'] } }), { rows: 'g', cols: 'g' })).toBe(wrapped)
  })
})
