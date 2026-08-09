/**
 * The sparse 4C accumulator, checked against the dense one it must agree with.
 *
 * There are two implementations of "sum a band of a symmetric matrix" in this
 * app and they have to give the same answer: `bandSums`, which walks a mirrored
 * dense square and is what the task uses when a block is already in hand, and
 * `ViewpointAccumulator`, which walks stored pixels and is what a profile read
 * from the file is built from. The two paths of one task must not disagree.
 *
 * The one place they can differ is the diagonal — the only cell that is its own
 * mirror — so the last test builds one matrix, reads it both ways, and compares.
 */

import { describe, expect, it } from 'vitest'

import { ViewpointAccumulator, bandSums } from '@/analysis/viewpoint'

describe('ViewpointAccumulator', () => {
  it('gives a contact to the far end of the pixel', () => {
    const acc = new ViewpointAccumulator(6, { from: 1, to: 2 })
    acc.add(1, 4, 3)
    const out = acc.finish()
    expect(out[4]).toBe(3)
    // The anchor's own bin receives nothing from a pixel that leaves it: the
    // profile is what the anchor *touches*.
    expect(out[1]).toBe(0)
  })

  it('gives a contact to both ends when both are inside the anchor', () => {
    const acc = new ViewpointAccumulator(6, { from: 1, to: 4 })
    acc.add(1, 3, 5)
    const out = acc.finish()
    expect(out[1]).toBe(5)
    expect(out[3]).toBe(5)
  })

  it('counts a diagonal pixel once, not twice', () => {
    // The regression this kernel was extracted for. A diagonal cell is its own
    // mirror, and doubling it puts a spike on the anchor itself — precisely
    // where a reader expects the self-contact peak and would not question one.
    const acc = new ViewpointAccumulator(6, { from: 2, to: 3 })
    acc.add(2, 2, 9)
    expect(acc.finish()[2]).toBe(9)
  })

  it('takes a pixel whose second end is in the anchor', () => {
    const acc = new ViewpointAccumulator(6, { from: 3, to: 4 })
    acc.add(0, 3, 7)
    expect(acc.finish()[0]).toBe(7)
  })

  it('stops being reachable once bin1 is past the anchor', () => {
    // Pixels are ordered by bin1 and stored with bin1 <= bin2, so this is what
    // lets the scan read half the file instead of all of it.
    const acc = new ViewpointAccumulator(10, { from: 2, to: 5 })
    expect(acc.reachable(4)).toBe(true)
    expect(acc.reachable(5)).toBe(false)
  })

  it('reports an untouched bin as zero and a dropped bin as a gap', () => {
    const acc = new ViewpointAccumulator(4, { from: 0, to: 1 })
    acc.add(0, 1, 2)
    const out = acc.finish((bin) => bin !== 3)
    expect(out[2]).toBe(0)
    expect(out[3]).toBeNaN()
  })

  it('skips a NaN cell rather than poisoning the column', () => {
    const acc = new ViewpointAccumulator(4, { from: 0, to: 1 })
    acc.add(0, 2, Number.NaN)
    acc.add(0, 2, 4)
    expect(acc.finish()[2]).toBe(4)
  })

  it('agrees with bandSums over the same matrix, diagonal included', () => {
    const n = 6
    // Stored pairs of an upper-triangular file, including cells inside the
    // anchor, cells leaving it, and two on the diagonal.
    const pairs: Array<[number, number, number]> = [
      [0, 0, 1],
      [1, 1, 2],
      [1, 2, 3],
      [1, 5, 4],
      [2, 2, 5],
      [2, 4, 6],
      [3, 4, 7],
    ]
    const band = { from: 1, to: 3 }

    const sparse = new ViewpointAccumulator(n, band)
    for (const [a, b, v] of pairs) sparse.add(a, b, v)

    // The same file as a mirrored dense square, which is what the reader hands
    // the map and what `bandSums` is written against.
    const values = new Float32Array(n * n)
    for (const [a, b, v] of pairs) {
      values[a * n + b] = v
      values[b * n + a] = v
    }
    const dense = bandSums(
      { nrows: n, ncols: n, values, rowExtent: [0, n], colExtent: [0, n] },
      [band.from, band.to],
      'cols',
    )

    expect(Array.from(sparse.finish())).toEqual(Array.from(dense))
  })
})
