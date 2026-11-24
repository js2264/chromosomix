// @dev-feature curate
/**
 * miComplete's four numbers, recomputed from the markers of a set of contigs
 * (SPECS §33.5): its arithmetic, its rounding, and metaTOR's choice of set.
 * The numbers against metaTOR's own run of miComplete on a real map are in the
 * demo map's suite; here, the definitions, on sets small enough to count by hand.
 */

import { describe, expect, it } from 'vitest'
import { bestQuality, markerCounts, markerTable, parseMarkers, pyRound, qualityOf, type MarkerSet } from '../../src/curate/quality'

describe('Python’s round, to the last bit', () => {
  // Each pair is Python's own answer (CPython 3.13): half to even on the exact
  // binary value, which toFixed is not.
  const cases: Array<[number, number, number]> = [
    [1.03125, 1.0312, 1.03],
    [0.125, 0.125, 0.12],
    [0.03125, 0.0312, 0.03],
    [2 / 3, 0.6667, 0.67],
    [1 / 7, 0.1429, 0.14],
    [0.00005, 0.0001, 0],
    [0.99995, 1, 1],
    [1.000049999, 1, 1],
    [12.34565, 12.3456, 12.35],
    [0.28125, 0.2812, 0.28],
    [1.0312500001, 1.0313, 1.03],
    [2.5, 2.5, 2.5],
  ]
  it.each(cases)('round(%s) is %s to four places and %s to two', (x, four, two) => {
    expect(pyRound(x, 4)).toBe(four)
    expect(pyRound(x, 2)).toBe(two)
    expect(pyRound(-x, 4)).toBe(four === 0 ? -0 : -four)
  })

  it('is not toFixed, on the ties toFixed rounds away from even', () => {
    expect((1.03125).toFixed(4)).toBe('1.0313')
    expect(pyRound(1.03125, 4)).toBe(1.0312)
  })
})

describe('a contig’s markers', () => {
  it('reads a count after a star, and one without', () => {
    expect([...parseMarkers('Ribosomal_L22,SecY*2')]).toEqual([
      ['Ribosomal_L22', 1],
      ['SecY', 2],
    ])
    expect(parseMarkers('').size).toBe(0)
  })

  it('skips what it cannot read rather than guess', () => {
    expect([...parseMarkers('A*0,B*x,,C*1.5,D')]).toEqual([['D', 1]])
  })
})

/** A set of four markers, weighted unevenly, as the metadata gives one. */
const SET: MarkerSet = { name: 'Bact4', markers: ['A', 'B', 'C', 'D'], weights: [0.1, 0.2, 0.3, 0.4] }

describe('miComplete’s four numbers', () => {
  it('count the markers present, the hits, and the weights of each', () => {
    // A twice, B once: two of four present, three hits.
    const q = qualityOf(SET, [2, 1, 0, 0])
    expect(q.present).toBe(2)
    expect(q.hits).toBe(3)
    expect(q.completeness).toBe(0.5)
    expect(q.redundancy).toBe(1.5)
    expect(q.weightedCompleteness).toBe(0.3)
    // A present twice weighs once: (0.1 + 0.3) / 0.3.
    expect(q.weightedRedundancy).toBe(pyRound((0.1 + (0.1 + 0.2)) / (0.1 + 0.2), 4))
  })

  it('divide the weighted redundancy by the weighted completeness before it is rounded', () => {
    const set: MarkerSet = { name: 'S', markers: ['A', 'B'], weights: [0.123456, 0.3] }
    const q = qualityOf(set, [3, 0])
    expect(q.weightedCompleteness).toBe(0.1235)
    expect(q.weightedRedundancy).toBe(2)
  })

  it('write a weighted completeness that rounds to nothing as 0.0001', () => {
    const set: MarkerSet = { name: 'S', markers: ['A', 'B'], weights: [0.00001, 0.99999] }
    expect(qualityOf(set, [1, 0]).weightedCompleteness).toBe(0.0001)
  })

  it('are all nought where no marker is present, as miComplete writes them', () => {
    expect(qualityOf(SET, [0, 0, 0, 0])).toMatchObject({ completeness: 0, redundancy: 0, weightedCompleteness: 0, weightedRedundancy: 0 })
  })
})

describe('a set of contigs', () => {
  const texts = ['A,B', 'A*2', '', 'C,Z', 'D']
  const table = markerTable(SET, texts)

  it('sums its contigs’ markers, and leaves out a marker the set does not list', () => {
    expect([...markerCounts(table, [0, 1, 3])]).toEqual([3, 1, 1, 0])
  })

  it('is judged by the set with the higher weighted completeness, the first on a tie', () => {
    const other: MarkerSet = { name: 'Arch2', markers: ['Z', 'D'], weights: [0.5, 0.5] }
    const tables = [table, markerTable(other, texts)]
    // Contigs 3 and 4: C and D of the first set (0.7), Z and D of the other (1.0).
    expect(bestQuality(tables, [3, 4])?.set).toBe('Arch2')
    // Contig 4 alone: D in both, 0.4 against 0.5.
    expect(bestQuality(tables, [4])?.set).toBe('Arch2')
    // Contigs 0 and 1: A and B of the first (0.3), nothing of the other.
    expect(bestQuality(tables, [0, 1])?.set).toBe('Bact4')
    const tie: MarkerSet = { name: 'Tie', markers: ['A', 'B'], weights: [0.1, 0.2] }
    expect(bestQuality([table, markerTable(tie, texts)], [0])?.set).toBe('Bact4')
  })
})
