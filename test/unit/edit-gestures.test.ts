/**
 * The stage's hand, as arithmetic (SPECS §27.4): snapping, the stretch a drag
 * names, where a dropped stretch lands, the step the drop makes, and the
 * selection following what was moved.
 */

import { describe, expect, it } from 'vitest'

import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import {
  dropPlace,
  dropStep,
  endTargets,
  landed,
  partStretch,
  snapUnit,
  stretchBetween,
  type SnapTarget,
} from '../../src/edit/gestures'
import { LensGrid, type GridLayout } from '../../src/edit/grid'
import { stepText } from '../../src/edit/words'

const LAYOUT: GridLayout = {
  binsize: 1000,
  sequences: [
    { name: 'I', length: 10_000, firstCell: 0, cells: 10 },
    { name: 'II', length: 6_000, firstCell: 10, cells: 6 },
    { name: 'III', length: 4_000, firstCell: 16, cells: 4 },
  ],
}
const ORIGINAL = { names: ['I', 'II', 'III'], lengths: [10_000, 6_000, 4_000] }

function edit(...steps: EditStep[]): ReferenceEdit {
  let out = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    out = withStep(out, step, 'reader', i)
  })
  return out
}
const lens = (value: ReferenceEdit): LensGrid => LensGrid.of(EditedAssembly.of(value), LAYOUT)

describe('snapping', () => {
  const targets: SnapTarget[] = [
    { unit: 10, kind: 'end' },
    { unit: 16, kind: 'end' },
    { unit: 16, kind: 'selection' },
  ]

  it('takes the nearest target in reach, and an edit end over a selection’s', () => {
    expect(snapUnit(10.4, targets, 1)).toEqual({ unit: 10, target: { unit: 10, kind: 'end' } })
    expect(snapUnit(15.5, targets, 1).target?.kind).toBe('end')
  })

  it('falls back to the nearest cell edge, and ⌥ always does', () => {
    expect(snapUnit(12.6, targets, 1)).toEqual({ unit: 13, target: null })
    expect(snapUnit(10.2, targets, 1, true)).toEqual({ unit: 10, target: null })
  })

  it('snaps to every junction and every sequence end', () => {
    const grid = lens(edit({ op: 'invert', sequence: 'I', from: 2000, to: 5000 }))
    expect(endTargets(grid).map((target) => target.unit)).toEqual([0, 2, 5, 10, 16, 20])
  })
})

describe('the stretch a gesture names', () => {
  const grid = lens(emptyEdit(ORIGINAL))

  it('runs between two units, inside the sequence the first is in', () => {
    expect(stretchBetween(grid, 3, 7)).toEqual({ sequence: 'I', from: 3000, to: 7000 })
    expect(stretchBetween(grid, 7, 3)).toEqual({ sequence: 'I', from: 3000, to: 7000 })
    // Past the end of I: clamped to I.
    expect(stretchBetween(grid, 8, 14)).toEqual({ sequence: 'I', from: 8000, to: 10_000 })
  })

  it('is the part under the pointer for a press on the diagonal', () => {
    const cut = lens(edit({ op: 'cut', sequence: 'II', at: 2000 }))
    expect(partStretch(cut, 13.5)).toEqual({ sequence: 'II', from: 2000, to: 6000 })
  })
})

describe('a drop', () => {
  const value = emptyEdit(ORIGINAL)
  const assembly = EditedAssembly.of(value)
  const grid = lens(value)

  it('lands at the end of the sequence the pointer came from, at an edge between two', () => {
    expect(dropPlace(grid, 10, 9.8)).toEqual({ sequence: 'I', at: 10_000 })
    expect(dropPlace(grid, 10, 10.2)).toEqual({ sequence: 'II', at: 0 })
    expect(dropPlace(grid, 12, 12)).toEqual({ sequence: 'II', at: 2000 })
    expect(dropPlace(grid, 20, 20)).toEqual({ sequence: 'III', at: 4000 })
  })

  it('moves, measuring the place after the stretch is out', () => {
    const step = dropStep(assembly, { sequence: 'I', from: 1000, to: 3000 }, { sequence: 'I', at: 8000 }, 1, false)
    expect(step).toEqual({ op: 'move', sequence: 'I', from: 1000, to: 3000, into: 'I', at: 6000, strand: 1 })
  })

  it('changes nothing dropped on itself, and turns it if it was flipped on the way', () => {
    const on = { sequence: 'I', at: 2000 }
    expect(dropStep(assembly, { sequence: 'I', from: 1000, to: 3000 }, on, 1, false)).toBeNull()
    expect(dropStep(assembly, { sequence: 'I', from: 1000, to: 3000 }, on, -1, false)).toEqual({
      op: 'invert',
      sequence: 'I',
      from: 1000,
      to: 3000,
    })
  })

  it('copies with ⌥ held', () => {
    const step = dropStep(assembly, { sequence: 'II', from: 0, to: 1000 }, { sequence: 'II', at: 1000 }, 1, true)
    expect(step?.op).toBe('duplicate')
  })

  it('joins a whole sequence dropped on another’s end or start', () => {
    const end = dropStep(assembly, { sequence: 'III', from: 0, to: 4000 }, { sequence: 'II', at: 6000 }, 1, false)
    expect(end).toMatchObject({ op: 'join', a: 'II', aEnd: 'end', b: 'III', bEnd: 'start' })
    const start = dropStep(assembly, { sequence: 'III', from: 0, to: 4000 }, { sequence: 'I', at: 0 }, 1, false)
    expect(start).toMatchObject({ op: 'join', a: 'III', aEnd: 'end', b: 'I', bEnd: 'start', place: 'b' })
    // …and the join takes I's place, III first.
    const joined = EditedAssembly.of(withStep(value, start as EditStep, 'reader', 0))
    expect(joined.sequences.map((sequence) => sequence.name)).toEqual(['III_e1', 'II'])
    expect(joined.toOriginal('III_e1', 0)).toEqual({ sequence: 'III', bp: 0, strand: 1 })
  })
})

describe('the selection follows the stretch', () => {
  it('to where a move put it, in the sequence’s new name', () => {
    const before = EditedAssembly.of(emptyEdit(ORIGINAL))
    const step: EditStep = { op: 'move', sequence: 'I', from: 1000, to: 3000, into: 'II', at: 6000, strand: 1 }
    const after = EditedAssembly.of(withStep(emptyEdit(ORIGINAL), step, 'reader', 0))
    expect(landed(before, after, step)).toEqual({ sequence: 'II_e1', from: 6000, to: 8000 })
  })

  it('past a sequence the move emptied', () => {
    const before = EditedAssembly.of(emptyEdit(ORIGINAL))
    const step: EditStep = { op: 'move', sequence: 'I', from: 0, to: 10_000, into: 'III', at: 2000, strand: -1 }
    const after = EditedAssembly.of(withStep(emptyEdit(ORIGINAL), step, 'reader', 0))
    expect(after.sequences).toHaveLength(2)
    expect(landed(before, after, step)).toEqual({ sequence: 'III_e1', from: 2000, to: 12_000 })
  })
})

describe('a step in words', () => {
  it('names the stretch in the display form', () => {
    expect(stepText({ op: 'invert', sequence: 'IV', from: 1_000_000, to: 1_400_000 })).toBe('turn IV:1,000,001-1,400,000')
    expect(stepText({ op: 'move', sequence: 'I', from: 0, to: 10, into: 'II', at: 5, strand: -1 })).toBe(
      'move I:1-10 after II:5, turned',
    )
    expect(stepText({ op: 'duplicate', sequence: 'I', from: 0, to: 10, into: 'II', at: 0, strand: 1 })).toBe(
      'copy I:1-10 before II:1',
    )
    expect(stepText({ op: 'aside', sequence: 'III', from: 0, to: 100, why: 'contaminant' })).toBe(
      'set aside III:1-100 as a contaminant',
    )
  })
})
