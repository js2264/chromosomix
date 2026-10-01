/**
 * An edit of the reference, and the lens it makes (SPECS §27.2).
 *
 * The two directions are the whole contract: **edited → original** is a
 * function (every edited base is one original base, or a gap), **original →
 * edited** is a relation (a base lands once, not at all, or twice). Every step
 * is checked by asking both directions about the bases it moved, on sequences
 * small enough to reason about by hand.
 */

import { describe, expect, it } from 'vitest'
import {
  EditedAssembly,
  editFingerprint,
  emptyEdit,
  isGap,
  mismatch,
  redone,
  undone,
  wholeOriginal,
  withStep,
  type EditStep,
  type ReferenceEdit,
} from '../../src/genome/edit'

const ORIGINAL = { names: ['I', 'II', 'III'], lengths: [1000, 600, 300] }

function edited(...steps: EditStep[]): EditedAssembly {
  let edit: ReferenceEdit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return EditedAssembly.of(edit)
}

/** Every edited base of a sequence, as the original base it is, in order. */
function read(assembly: EditedAssembly, name: string): Array<string | null> {
  const length = assembly.lengthOf(name) ?? 0
  const out: Array<string | null> = []
  for (let bp = 0; bp < length; bp++) {
    const place = assembly.toOriginal(name, bp)
    out.push(place === null ? null : `${place.sequence}:${place.bp}${place.strand === 1 ? '+' : '-'}`)
  }
  return out
}

/** Original → edited → original, for every landing of every original base. */
function roundTrips(assembly: EditedAssembly): void {
  ORIGINAL.names.forEach((name, i) => {
    for (let bp = 0; bp < ORIGINAL.lengths[i]; bp += 7) {
      for (const landing of assembly.toEdited(name, bp)) {
        expect(assembly.toOriginal(landing.sequence, landing.bp)).toEqual({
          sequence: name,
          bp,
          strand: landing.strand,
        })
      }
    }
  })
}

describe('the identity', () => {
  it('is the original, name for name and base for base', () => {
    const assembly = edited()
    expect(assembly.isIdentity).toBe(true)
    expect(assembly.contigs()).toEqual([
      { name: 'I', length: 1000 },
      { name: 'II', length: 600 },
      { name: 'III', length: 300 },
    ])
    expect(assembly.toOriginal('II', 42)).toEqual({ sequence: 'II', bp: 42, strand: 1 })
    expect(assembly.toEdited('II', 42)).toEqual([{ sequence: 'II', bp: 42, strand: 1 }])
    expect(assembly.junctions()).toEqual([])
  })
})

describe('a cut', () => {
  it('marks an edit end and moves nothing, so the sequence keeps its name', () => {
    const assembly = edited({ op: 'cut', sequence: 'I', at: 400 })
    expect(assembly.lengthOf('I')).toBe(1000)
    expect(assembly.junctions()).toEqual([{ sequence: 'I', at: 400 }])
    expect(assembly.toOriginal('I', 400)).toEqual({ sequence: 'I', bp: 400, strand: 1 })
    roundTrips(assembly)
  })
})

describe('an inversion', () => {
  const assembly = edited({ op: 'invert', sequence: 'I', from: 100, to: 200 })

  it('reads the stretch backwards and renames the sequence, which is no longer the original', () => {
    expect(assembly.sequence('I')).toBeNull()
    const name = assembly.sequences[0].name
    expect(name).toBe('I_e1')
    expect(assembly.lengthOf(name)).toBe(1000)
    expect(assembly.toOriginal(name, 99)).toEqual({ sequence: 'I', bp: 99, strand: 1 })
    expect(assembly.toOriginal(name, 100)).toEqual({ sequence: 'I', bp: 199, strand: -1 })
    expect(assembly.toOriginal(name, 199)).toEqual({ sequence: 'I', bp: 100, strand: -1 })
    expect(assembly.toOriginal(name, 200)).toEqual({ sequence: 'I', bp: 200, strand: 1 })
    expect(assembly.toEdited('I', 150)).toEqual([{ sequence: name, bp: 149, strand: -1 }])
    roundTrips(assembly)
  })

  it('reads the inverted stretch base by base, backwards and on the other strand', () => {
    const name = assembly.sequences[0].name
    const bases = read(assembly, name)
    expect(bases.slice(98, 102)).toEqual(['I:98+', 'I:99+', 'I:199-', 'I:198-'])
    expect(bases.slice(198, 202)).toEqual(['I:101-', 'I:100-', 'I:200+', 'I:201+'])
  })

  it('undone by inverting the same stretch again, name and all', () => {
    const name = assembly.sequences[0].name
    let edit = withStep(emptyEdit(ORIGINAL), { op: 'invert', sequence: 'I', from: 100, to: 200 }, 'reader', 0)
    edit = withStep(edit, { op: 'invert', sequence: name, from: 100, to: 200 }, 'reader', 1)
    const back = EditedAssembly.of(edit)
    expect(back.isIdentity).toBe(true)
    expect(back.sequence('I')?.parts).toHaveLength(1)
  })
})

describe('a move', () => {
  it('within a sequence, forward, measured after the stretch is taken out', () => {
    // Take [100, 200) out, leaving 900 bases, and put it back at 500.
    const assembly = edited({ op: 'move', sequence: 'I', from: 100, to: 200, into: 'I', at: 500, strand: 1 })
    const name = assembly.sequences[0].name
    expect(assembly.lengthOf(name)).toBe(1000)
    expect(assembly.toOriginal(name, 100)).toEqual({ sequence: 'I', bp: 200, strand: 1 })
    expect(assembly.toOriginal(name, 500)).toEqual({ sequence: 'I', bp: 100, strand: 1 })
    expect(assembly.toOriginal(name, 599)).toEqual({ sequence: 'I', bp: 199, strand: 1 })
    expect(assembly.toOriginal(name, 600)).toEqual({ sequence: 'I', bp: 600, strand: 1 })
    roundTrips(assembly)
  })

  it('to another sequence, turned, and both sequences are renamed', () => {
    const assembly = edited({ op: 'move', sequence: 'I', from: 0, to: 100, into: 'III', at: 300, strand: -1 })
    expect(assembly.contigs().map((contig) => contig.length)).toEqual([900, 600, 400])
    const [first, , third] = assembly.sequences.map((sequence) => sequence.name)
    expect(first).toBe('I_e1')
    expect(third).toBe('III_e1')
    expect(assembly.toOriginal(third, 300)).toEqual({ sequence: 'I', bp: 99, strand: -1 })
    expect(assembly.toOriginal(third, 399)).toEqual({ sequence: 'I', bp: 0, strand: -1 })
    expect(assembly.toOriginal(first, 0)).toEqual({ sequence: 'I', bp: 100, strand: 1 })
    // II was not touched, and keeps its name.
    expect(assembly.sequence('II')).not.toBeNull()
    roundTrips(assembly)
  })
})

describe('a duplication', () => {
  it('lands the stretch twice, and every other base once', () => {
    const assembly = edited({ op: 'duplicate', sequence: 'II', from: 100, to: 200, into: 'II', at: 200, strand: 1 })
    const name = assembly.sequences[1].name
    expect(assembly.lengthOf(name)).toBe(700)
    expect(assembly.toEdited('II', 150).map((place) => place.bp)).toEqual([150, 250])
    expect(assembly.toEdited('II', 50)).toHaveLength(1)
    // Two pieces of one original, with ids of their own.
    const ids = assembly.landings('II').map((landing) => landing.piece.id)
    expect(new Set(ids).size).toBe(ids.length)
    roundTrips(assembly)
  })
})

describe('a join, a split and a stretch set aside', () => {
  it('joins II’s end to III’s end, which turns III round, with a gap between', () => {
    const assembly = edited({ op: 'join', a: 'II', aEnd: 'end', b: 'III', bEnd: 'end', gap: 100 })
    expect(assembly.sequences).toHaveLength(2)
    const joined = assembly.sequences[1]
    expect(assembly.lengthOf(joined.name)).toBe(600 + 100 + 300)
    expect(isGap(joined.parts[1])).toBe(true)
    expect(assembly.toOriginal(joined.name, 650)).toBeNull()
    expect(assembly.toOriginal(joined.name, 700)).toEqual({ sequence: 'III', bp: 299, strand: -1 })
    roundTrips(assembly)
  })

  it('splits I into two sequences, the right half named for it', () => {
    const assembly = edited({ op: 'split', sequence: 'I', at: 250 })
    expect(assembly.contigs().slice(0, 2)).toEqual([
      { name: 'I_e1', length: 250 },
      { name: 'I_e2', length: 750 },
    ])
    expect(assembly.toOriginal('I_e2', 0)).toEqual({ sequence: 'I', bp: 250, strand: 1 })
    roundTrips(assembly)
  })

  it('sets a stretch aside: it lands nowhere, and is listed with its reason', () => {
    const assembly = edited({ op: 'aside', sequence: 'III', from: 100, to: 150, why: 'contaminant' })
    expect(assembly.toEdited('III', 120)).toEqual([])
    expect(assembly.aside).toEqual([
      { piece: expect.objectContaining({ sequence: 'III', start: 100, end: 150, strand: 1 }), why: 'contaminant' },
    ])
    expect(assembly.lengthOf(assembly.sequences[2].name)).toBe(250)
    roundTrips(assembly)
  })

  it('keeps the name the reader gives a sequence, even one that is an original whole', () => {
    // Whole and forward, I would take its own name back; named, it keeps chrI.
    expect(edited({ op: 'rename', sequence: 'I', name: 'chrI' }).sequences.map((sequence) => sequence.name)).toEqual(['chrI', 'II', 'III'])
    // A turn undone by another is the original again, and keeps the name too.
    const back = edited(
      { op: 'invert', sequence: 'I', from: 0, to: 1000 },
      { op: 'rename', sequence: 'I_e1', name: 'chrI' },
      { op: 'invert', sequence: 'chrI', from: 0, to: 1000 },
    )
    expect(back.sequences[0].name).toBe('chrI')
    // A name of the file's own is refused for any stretch but that sequence whole.
    expect(edited({ op: 'rename', sequence: 'II', name: 'III' }).sequences.map((sequence) => sequence.name)).toEqual(['I', 'II', 'III'])
    expect(edited({ op: 'join', a: 'I', aEnd: 'end', b: 'II', bEnd: 'start', gap: 0 }, { op: 'rename', sequence: 'I_e1', name: 'II' }).sequences[0].name).toBe('I_e1')
    // …and taken by that sequence whole, renamed and given it back.
    expect(edited({ op: 'rename', sequence: 'I', name: 'chrI' }, { op: 'rename', sequence: 'chrI', name: 'I' }).sequences[0].name).toBe('I')
  })

  it('says which original a sequence is whole, which is the one name of the file’s it may have', () => {
    // What the stage's rename box asks before it refuses a name (§27.3).
    const original = emptyEdit(ORIGINAL).original
    const whole = (assembly: EditedAssembly, at: number): string | null => wholeOriginal(assembly.sequences[at], original)
    expect(whole(edited({ op: 'rename', sequence: 'I', name: 'chrI' }), 0)).toBe('I')
    // Turned, or a stretch, it is no original whole.
    expect(whole(edited({ op: 'invert', sequence: 'II', from: 0, to: 600 }), 1)).toBeNull()
    expect(whole(edited({ op: 'split', sequence: 'I', at: 400 }), 0)).toBeNull()
  })

  it('rotates a circle to start at its origin', () => {
    const assembly = edited({ op: 'rotate', sequence: 'III', at: 100 })
    const name = assembly.sequences[2].name
    expect(assembly.toOriginal(name, 0)).toEqual({ sequence: 'III', bp: 100, strand: 1 })
    expect(assembly.toOriginal(name, 200)).toEqual({ sequence: 'III', bp: 0, strand: 1 })
    roundTrips(assembly)
  })
})

describe('a stretch asked of the edited assembly', () => {
  it('comes back as the pieces it is made of, each clipped, reversed ones included', () => {
    const assembly = edited({ op: 'invert', sequence: 'I', from: 100, to: 200 })
    const name = assembly.sequences[0].name
    const pieces = assembly.piecesIn(name, 50, 150)
    expect(pieces).toEqual([
      { offset: 50, piece: expect.objectContaining({ start: 50, end: 100, strand: 1 }) },
      { offset: 100, piece: expect.objectContaining({ start: 150, end: 200, strand: -1 }) },
    ])
  })
})

describe('the history', () => {
  it('undoes and redoes by moving a cursor, and a new step drops what was undone', () => {
    let edit = withStep(emptyEdit(ORIGINAL), { op: 'cut', sequence: 'I', at: 10 }, 'reader', 0)
    edit = withStep(edit, { op: 'aside', sequence: 'I', from: 0, to: 10, why: 'debris' }, 'reader', 1)
    expect(EditedAssembly.of(edit).aside).toHaveLength(1)
    edit = undone(edit)
    expect(edit.cursor).toBe(1)
    expect(EditedAssembly.of(edit).aside).toHaveLength(0)
    edit = redone(edit)
    expect(EditedAssembly.of(edit).aside).toHaveLength(1)
    edit = undone(edit)
    edit = withStep(edit, { op: 'invert', sequence: 'II', from: 0, to: 600 }, 'reader', 2)
    expect(edit.history).toHaveLength(2)
    expect(edit.history[1].step.op).toBe('invert')
  })

  it('fingerprints the steps an edit applies, and nothing undone past them', () => {
    const one = withStep(emptyEdit(ORIGINAL), { op: 'invert', sequence: 'I', from: 0, to: 500 }, 'reader', 0)
    const two = withStep(one, { op: 'cut', sequence: 'II', at: 300 }, 'reader', 1)
    expect(editFingerprint(undone(two))).toBe(editFingerprint(one))
    expect(editFingerprint(two)).not.toBe(editFingerprint(one))
    // Who made a step, and when, is its history rather than its assembly.
    expect(editFingerprint(withStep(emptyEdit(ORIGINAL), { op: 'invert', sequence: 'I', from: 0, to: 500 }, 'auto', 9))).toBe(
      editFingerprint(one),
    )
    expect(editFingerprint(withStep(emptyEdit(ORIGINAL), { op: 'invert', sequence: 'I', from: 0, to: 501 }, 'reader', 0))).not.toBe(
      editFingerprint(one),
    )
  })

  it('refuses a file whose sequences are not the ones it was made on, naming the first', () => {
    const edit = emptyEdit(ORIGINAL)
    expect(mismatch(edit, ['I', 'II', 'III'], [1000, 600, 300])).toBeNull()
    expect(mismatch(edit, ['I', 'II', 'III'], [1000, 601, 300])).toBe('II is 600 bp in the edit and 601 bp here')
    expect(mismatch(edit, ['I', 'II'], [1000, 600])).toMatch(/3 sequences/)
  })
})
