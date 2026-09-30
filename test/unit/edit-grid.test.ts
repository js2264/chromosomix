/**
 * The lens at the picture's grid (SPECS §27.2, §27.9): which picture cell each
 * cell of the edited axis shows, the axis the lanes are drawn through, and the
 * two directions between the axis and edited base pairs.
 */

import { describe, expect, it } from 'vitest'

import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import { LensGrid, type GridLayout } from '../../src/edit/grid'

/** `I` 10 kb and `II` 5.5 kb at 1 kb a cell: 10 and 6 cells, the last one short. */
const LAYOUT: GridLayout = {
  binsize: 1000,
  sequences: [
    { name: 'I', length: 10_000, firstCell: 0, cells: 10 },
    { name: 'II', length: 5_500, firstCell: 10, cells: 6 },
  ],
}
const ORIGINAL = { names: ['I', 'II'], lengths: [10_000, 5_500] }

function grid(...steps: EditStep[]): LensGrid {
  let edit: ReferenceEdit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return LensGrid.of(EditedAssembly.of(edit), LAYOUT)
}

describe('the identity', () => {
  it('shows every cell of the picture where it is', () => {
    const lens = grid()
    expect(lens.n).toBe(16)
    expect(Array.from(lens.cellMap)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(lens.junctions()).toEqual([])
    expect(lens.boundaries()).toEqual([0, 10, 16])
    expect(lens.axis?.segments.map((segment) => segment.contig)).toEqual(['I', 'II'])
  })
})

describe('an inversion', () => {
  const lens = grid({ op: 'invert', sequence: 'I', from: 2000, to: 5000 })

  it('shows the turned stretch’s cells backwards', () => {
    expect(Array.from(lens.cellMap.subarray(0, 10))).toEqual([0, 1, 4, 3, 2, 5, 6, 7, 8, 9])
    expect(lens.junctions()).toEqual([2, 5])
  })

  it('places a unit at the base pair under it, and back', () => {
    const name = lens.sequences[0].name
    // The turned piece's first cell is the original's `[4 kb, 5 kb)`, read down.
    const at = lens.place(2.25)
    expect(at?.sequence).toBe(name)
    expect(at?.bp).toBeCloseTo(2250, 6)
    expect(lens.unitOf(name, 2250)).toBeCloseTo(2.25, 6)
    // A junction is exact both ways.
    expect(lens.place(5)?.bp).toBe(5000)
    expect(lens.unitOf(name, 5000)).toBe(5)
  })

  it('draws the lanes through the turned piece backwards', () => {
    const turned = lens.axis?.segments[1]
    expect(turned).toMatchObject({ contig: 'I', unitStart: 2, unitEnd: 5, bpStart: 5000, strand: -1, bpFrom: 2000, bpTo: 5000 })
    expect(lens.axis?.unitToLocus(2.5)).toEqual({ contig: 'I', bp: 4500 })
  })
})

describe('a piece that does not end on a cell', () => {
  it('moves its bins whole, to the nearest edge', () => {
    // `[2.4 kb, 6.6 kb)` of I to the end of II: its cells are 2…6, since 2.4
    // rounds to 2 and 6.6 to 7.
    const lens = grid({ op: 'move', sequence: 'I', from: 2400, to: 6600, into: 'II', at: 5500, strand: 1 })
    const ii = lens.sequences[1]
    expect(ii.to - ii.from).toBe(6 + 5)
    expect(Array.from(lens.cellMap.subarray(ii.from + 6, ii.to))).toEqual([2, 3, 4, 5, 6])
    // …and its bases stay exact: the edited sequence is 5.5 kb + 4.2 kb.
    expect(ii.length).toBe(9700)
  })

  it('keeps a sequence’s short last cell', () => {
    const lens = grid({ op: 'invert', sequence: 'II', from: 0, to: 5500 })
    const ii = lens.sequences[1]
    expect(Array.from(lens.cellMap.subarray(ii.from, ii.to))).toEqual([15, 14, 13, 12, 11, 10])
  })
})

describe('a gap', () => {
  it('is cells that show nothing, and a place inside it is a fraction of it', () => {
    const lens = grid({ op: 'join', a: 'I', aEnd: 'end', b: 'II', bEnd: 'start', gap: 2000 })
    expect(lens.sequences).toHaveLength(1)
    expect(Array.from(lens.cellMap.subarray(9, 13))).toEqual([9, -1, -1, 10])
    const inGap = lens.place(11)
    expect(inGap?.part.piece).toBeNull()
    expect(inGap?.bp).toBe(11_000)
    expect(lens.junctions()).toEqual([10, 12])
  })
})

describe('set aside', () => {
  it('leaves the stretch’s cells out of the axis', () => {
    const lens = grid({ op: 'aside', sequence: 'I', from: 0, to: 3000, why: 'debris' })
    expect(lens.n).toBe(13)
    expect(lens.cellMap[0]).toBe(3)
  })
})
