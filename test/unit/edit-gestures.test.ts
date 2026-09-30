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
  sequenceStretch,
  shiftStep,
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

  it('lands between two sequences at the edge between them, before the first and after the last', () => {
    expect(dropPlace(grid, 10, 9.8)).toEqual({ before: 'II' })
    expect(dropPlace(grid, 10, 10.2)).toEqual({ before: 'II' })
    expect(dropPlace(grid, 0, 0.3)).toEqual({ before: 'I' })
    expect(dropPlace(grid, 20, 20)).toEqual({ before: null })
    // Inside a sequence, it goes into it.
    expect(dropPlace(grid, 12, 12)).toEqual({ sequence: 'II', at: 2000 })
  })

  it('lands at the end of the sequence the pointer came from with ⇧ held, at an edge between two', () => {
    expect(dropPlace(grid, 10, 9.8, true)).toEqual({ sequence: 'I', at: 10_000 })
    expect(dropPlace(grid, 10, 10.2, true)).toEqual({ sequence: 'II', at: 0 })
    expect(dropPlace(grid, 20, 20, true)).toEqual({ sequence: 'III', at: 4000 })
  })

  it('places a whole sequence dropped between two in the order, joining nothing', () => {
    const step = dropStep(assembly, { sequence: 'III', from: 0, to: 4000 }, { before: 'I' }, 1, false)
    expect(step).toEqual({ op: 'place', sequence: 'III', from: 0, to: 4000, before: 'I', strand: 1, whole: true })
    const placed = EditedAssembly.of(withStep(value, step as EditStep, 'reader', 0))
    expect(placed.sequences.map((sequence) => sequence.name)).toEqual(['III', 'I', 'II'])
    expect(stepText(step as EditStep)).toBe('put III before I')
    // Where it already is, it is left — or turned, if it was flipped on the way.
    expect(dropStep(assembly, { sequence: 'II', from: 0, to: 6000 }, { before: 'III' }, 1, false)).toBeNull()
    expect(dropStep(assembly, { sequence: 'II', from: 0, to: 6000 }, { before: 'II' }, -1, false)).toEqual({ op: 'invert', sequence: 'II', from: 0, to: 6000 })
    // A copy has no place of its own to go.
    expect(dropStep(assembly, { sequence: 'II', from: 0, to: 6000 }, { before: 'I' }, 1, true)).toBeNull()
  })

  it('makes a stretch dropped between two a sequence of its own there', () => {
    const step = dropStep(assembly, { sequence: 'I', from: 2000, to: 5000 }, { before: null }, -1, false)
    expect(step).toEqual({ op: 'place', sequence: 'I', from: 2000, to: 5000, before: null, strand: -1 })
    const placed = EditedAssembly.of(withStep(value, step as EditStep, 'reader', 0))
    expect(placed.sequences.map((sequence) => [sequence.name, placed.lengthOf(sequence.name)])).toEqual([
      ['I_e1', 7000],
      ['II', 6000],
      ['III', 4000],
      ['I_e2', 3000],
    ])
    expect(placed.toOriginal('I_e2', 0)).toEqual({ sequence: 'I', bp: 4999, strand: -1 })
    expect(stepText(step as EditStep)).toBe('make I:2,001-5,000 a sequence of its own, last, turned')
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

  it('joins a whole sequence dropped on another’s end or start, as ⇧ lands it', () => {
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

describe('↑ and ↓', () => {
  it('move a whole sequence one place in the order, and no further than either end', () => {
    const assembly = EditedAssembly.of(emptyEdit(ORIGINAL))
    expect(shiftStep(assembly, { sequence: 'II', from: 0, to: 6000 }, -1)).toEqual({ op: 'place', sequence: 'II', from: 0, to: 6000, before: 'I', strand: 1, whole: true })
    expect(shiftStep(assembly, { sequence: 'I', from: 0, to: 10_000 }, 1)).toEqual({ op: 'place', sequence: 'I', from: 0, to: 10_000, before: 'III', strand: 1, whole: true })
    expect(shiftStep(assembly, { sequence: 'II', from: 0, to: 6000 }, 1)).toMatchObject({ before: null })
    expect(shiftStep(assembly, { sequence: 'I', from: 0, to: 10_000 }, -1)).toBeNull()
    expect(shiftStep(assembly, { sequence: 'III', from: 0, to: 4000 }, 1)).toBeNull()
    const down = EditedAssembly.of(withStep(emptyEdit(ORIGINAL), shiftStep(assembly, { sequence: 'I', from: 0, to: 10_000 }, 1) as EditStep, 'reader', 0))
    expect(down.sequences.map((sequence) => sequence.name)).toEqual(['II', 'I', 'III'])
  })

  it('move a piece among its sequence’s pieces, and never out of it', () => {
    // I joined to II: two pieces, I's then II's.
    const joined = edit({ op: 'join', a: 'I', aEnd: 'end', b: 'II', bEnd: 'start', gap: 0 })
    const assembly = EditedAssembly.of(joined)
    const name = assembly.sequences[0].name
    const second = { sequence: name, from: 10_000, to: 16_000 }
    const up = shiftStep(assembly, second, -1)
    expect(up).toEqual({ op: 'move', sequence: name, from: 10_000, to: 16_000, into: name, at: 0, strand: 1 })
    const swapped = EditedAssembly.of(withStep(joined, up as EditStep, 'reader', 1))
    expect(swapped.sequences).toHaveLength(2)
    expect(swapped.toOriginal(swapped.sequences[0].name, 0)).toEqual({ sequence: 'II', bp: 0, strand: 1 })
    expect(shiftStep(assembly, second, 1)).toBeNull()
    expect(shiftStep(assembly, { sequence: name, from: 0, to: 10_000 }, 1)).toEqual({ op: 'move', sequence: name, from: 0, to: 10_000, into: name, at: 6000, strand: 1 })
    // Neither a whole sequence nor a piece: nothing.
    expect(shiftStep(assembly, { sequence: name, from: 2000, to: 3000 }, 1)).toBeNull()
  })

  it('select a whole sequence from any unit of it', () => {
    const grid = lens(edit({ op: 'join', a: 'I', aEnd: 'end', b: 'II', bEnd: 'start', gap: 0 }))
    expect(sequenceStretch(grid, 12)).toEqual({ sequence: grid.sequences[0].name, from: 0, to: 16_000 })
    expect(sequenceStretch(grid, 17)).toEqual({ sequence: 'III', from: 0, to: 4000 })
  })
})

describe('a stretch set aside, put back', () => {
  it('comes back last, a sequence of its own, as the file reads it, and leaves the list', () => {
    const value = edit(
      { op: 'invert', sequence: 'I', from: 2000, to: 6000 },
      { op: 'aside', sequence: 'I_e1', from: 2000, to: 6000, why: 'debris' },
    )
    const before = EditedAssembly.of(value)
    expect(before.aside.map((item) => [item.piece.sequence, item.piece.start, item.piece.end, item.piece.strand])).toEqual([['I', 2000, 6000, -1]])
    const step: EditStep = { op: 'restore', sequence: 'I', start: 2000, end: 6000 }
    expect(stepText(step)).toBe('put back I:2,001-6,000')
    const after = EditedAssembly.of(withStep(value, step, 'reader', 2))
    expect(after.aside).toEqual([])
    expect(after.sequences.map((sequence) => [sequence.name, after.lengthOf(sequence.name)])).toEqual([
      ['I_e1', 6000],
      ['II', 6000],
      ['III', 4000],
      ['I_e2', 4000],
    ])
    // The way the file reads it, whatever way it was set aside.
    expect(after.toOriginal('I_e2', 0)).toEqual({ sequence: 'I', bp: 2000, strand: 1 })
    // And selected, whole, to be moved into place.
    expect(landed(before, after, step)).toEqual({ sequence: 'I_e2', from: 0, to: 4000 })
  })

  it('takes its own name back where it is a sequence of the file whole, and changes nothing that is not set aside', () => {
    const value = edit({ op: 'aside', sequence: 'II', from: 0, to: 6000, why: 'contaminant' })
    const back = EditedAssembly.of(withStep(value, { op: 'restore', sequence: 'II', start: 0, end: 6000 }, 'reader', 1))
    expect(back.sequences.map((sequence) => sequence.name)).toEqual(['I', 'III', 'II'])
    const none = EditedAssembly.of(withStep(value, { op: 'restore', sequence: 'I', start: 0, end: 1000 }, 'reader', 1))
    expect(none.sequences.map((sequence) => sequence.name)).toEqual(['I', 'III'])
    expect(none.aside).toHaveLength(1)
  })
})

describe('the selection follows the stretch', () => {
  it('to where a place put it, before the sequence it went before', () => {
    const before = EditedAssembly.of(emptyEdit(ORIGINAL))
    const whole: EditStep = { op: 'place', sequence: 'III', from: 0, to: 4000, before: 'II', strand: 1, whole: true }
    const afterWhole = EditedAssembly.of(withStep(emptyEdit(ORIGINAL), whole, 'reader', 0))
    expect(landed(before, afterWhole, whole)).toEqual({ sequence: 'III', from: 0, to: 4000 })
    const down: EditStep = { op: 'place', sequence: 'I', from: 0, to: 10_000, before: null, strand: 1, whole: true }
    expect(landed(before, EditedAssembly.of(withStep(emptyEdit(ORIGINAL), down, 'reader', 0)), down)).toEqual({ sequence: 'I', from: 0, to: 10_000 })
    const part: EditStep = { op: 'place', sequence: 'II', from: 1000, to: 3000, before: 'I', strand: 1 }
    const afterPart = EditedAssembly.of(withStep(emptyEdit(ORIGINAL), part, 'reader', 0))
    expect(afterPart.sequences.map((sequence) => sequence.name)).toEqual(['II_e2', 'I', 'II_e1', 'III'])
    expect(landed(before, afterPart, part)).toEqual({ sequence: 'II_e2', from: 0, to: 2000 })
  })

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
