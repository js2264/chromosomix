// @dev-feature curate
/**
 * The curated genomes as their edits lay them out (SPECS §27.10, §33.4): what
 * an edit holds and lets go, what is drawn of each genome as the curation moves
 * contigs under its edit, the edit a genome's stage opens on, and the curation
 * steps an edit's change makes.
 */

import { describe, expect, it } from 'vitest'
import {
  CuratedBinning,
  emptyCuration,
  fileBinning,
  withCurationStep,
  type BaseBinning,
  type Curation,
  type CurationStep,
} from '../../src/genome/curation'
import { EditedAssembly, emptyEdit, isGap, withStep, type EditStep, type Part, type ReferenceEdit } from '../../src/genome/edit'
import { drawnLayouts, layoutMembership, layoutsFingerprint, membersInOrder, mirroredMoves, rebasedEdit, type DrawnLayout } from '../../src/curate/layouts'

/**
 * Seven contigs: c0–c2 in MAG A, c3–c4 in MAG B, c5 the element E, c6 in the
 * pool — as `curation.test.ts` has them.
 */
const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
  lengths: [5000, 4000, 3000, 2000, 1000, 800, 500],
  genomeOf: Int32Array.from([0, 0, 0, 1, 1, 2, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
    { name: 'E', kind: 'element' },
  ],
  links: [{ element: 'E', mag: 'A' }],
}

const INDEX = new Map(BASE.names.map((name, c) => [name, c]))

function curated(...steps: CurationStep[]): CuratedBinning {
  const curation = steps.reduce((held: Curation, step, i) => withCurationStep(held, step, 'reader', i), emptyCuration(fileBinning(BASE)))
  return CuratedBinning.of(BASE, curation)
}

/** A genome's edit, made on its contigs as the file holds them, with these steps. */
function editOf(genome: string, steps: EditStep[], binning = curated()): ReferenceEdit {
  const g = binning.indexOfId(genome) as number
  const members = membersInOrder(binning, g, BASE.names, BASE.lengths)
  return steps.reduce((edit, step, i) => withStep(edit, step, 'reader', i), emptyEdit({ ...members, genome }))
}

/** A sequence's parts in words: `c0+ N100 c2-`, a stretch `c1:0-2000+`. */
function words(parts: readonly Part[]): string {
  return parts
    .map((part) => {
      if (isGap(part)) return `N${part.gap}`
      const whole = part.start === 0 && part.end === BASE.lengths[INDEX.get(part.sequence) as number]
      return `${part.sequence}${whole ? '' : `:${part.start}-${part.end}`}${part.strand === 1 ? '+' : '-'}`
    })
    .join(' ')
}

/** Every layout drawn, by genome id: each sequence `name = parts`. */
function drawn(layouts: readonly DrawnLayout[]): Record<string, string[]> {
  return Object.fromEntries(layouts.map((layout) => [layout.id, layout.sequences.map((sequence) => `${sequence.name} = ${words(sequence.parts)}`)]))
}

function layoutsOf(binning: CuratedBinning, edits: Record<string, ReferenceEdit>): DrawnLayout[] {
  return drawnLayouts({ binning, names: BASE.names, lengths: BASE.lengths, edits: new Map(Object.entries(edits)) })
}

/** A's c0 and c2 joined, c2 turned, and c1 turned. */
const JOINED: EditStep[] = [
  { op: 'join', a: 'c0', aEnd: 'end', b: 'c2', bEnd: 'end', gap: 100 },
  { op: 'invert', sequence: 'c1', from: 0, to: 4000 },
]

describe('what an edit holds of its genome', () => {
  it('holds a contig with a stretch placed, or set aside unplaced, and lets go one set aside whole otherwise', () => {
    const edit = editOf('A', [
      { op: 'aside', sequence: 'c2', from: 0, to: 3000, why: 'debris' },
      { op: 'aside', sequence: 'c1', from: 0, to: 1000, why: 'unplaced' },
      { op: 'aside', sequence: 'c0', from: 0, to: 5000, why: 'contaminant', genome: 'B' },
    ])
    const membership = layoutMembership(EditedAssembly.of(edit))
    expect([...membership.held]).toEqual(['c1'])
    expect([...membership.released]).toEqual([
      ['c2', null],
      ['c0', 'B'],
    ])
  })

  it('keeps a contig only part of which is set aside: membership is per whole contig', () => {
    const edit = editOf('A', [{ op: 'aside', sequence: 'c0', from: 0, to: 1000, why: 'haplotig' }])
    const membership = layoutMembership(EditedAssembly.of(edit))
    expect(membership.held.has('c0')).toBe(true)
    expect(membership.released.size).toBe(0)
  })

  it('sends a contig set aside in two stretches where its longer stretch went, and the pool’s name to the pool', () => {
    const edit = editOf('A', [
      { op: 'aside', sequence: 'c0', from: 0, to: 1000, why: 'contaminant', genome: 'B' },
      // c0 is c0_e1 once part of it is set aside.
      { op: 'aside', sequence: 'c0_e1', from: 0, to: 4000, why: 'contaminant', genome: '__unbinned__' },
    ])
    expect(layoutMembership(EditedAssembly.of(edit)).released.get('c0')).toBeNull()
  })
})

describe('what is drawn of each genome', () => {
  it('draws nothing otherwise where no edit changes anything', () => {
    expect(layoutsOf(curated(), {})).toEqual([])
    // An edit undone to the start, and one whose steps change nothing, draw nothing either.
    const undone = { ...editOf('A', JOINED), cursor: 0 }
    const back = editOf('A', [
      { op: 'invert', sequence: 'c1', from: 0, to: 4000 },
      { op: 'invert', sequence: 'c1_e1', from: 0, to: 4000 },
    ])
    expect(layoutsOf(curated(), { A: undone })).toEqual([])
    expect(layoutsOf(curated(), { A: back })).toEqual([])
  })

  it('draws a genome as its edit lays it out', () => {
    expect(drawn(layoutsOf(curated(), { A: editOf('A', JOINED) }))).toEqual({
      A: ['c0_e1 = c0+ N100 c2-', 'c1_e1 = c1-'],
    })
  })

  it('breaks a sequence where a contig the curation moved away was, and draws that contig whole where it went', () => {
    const binning = curated({ op: 'move', contigs: ['c2'], to: 'B' })
    expect(drawn(layoutsOf(binning, { A: editOf('A', JOINED) }))).toEqual({
      // c0 alone again is c0, whole: its own name back.
      A: ['c0 = c0+', 'c1_e1 = c1-'],
    })
  })

  it('draws a contig the curation brought in whole, last, longest first', () => {
    const binning = curated({ op: 'move', contigs: ['c4', 'c3'], to: 'A' })
    expect(drawn(layoutsOf(binning, { A: editOf('A', JOINED) }))).toEqual({
      A: ['c0_e1 = c0+ N100 c2-', 'c1_e1 = c1-', 'c3 = c3+', 'c4 = c4+'],
    })
  })

  it('carries the layout of a genome merged away into the one it was merged into, as a block after its own', () => {
    const binning = curated({ op: 'merge', into: 'B', genomes: ['A'] })
    const b = editOf('B', [{ op: 'invert', sequence: 'c4', from: 0, to: 1000 }])
    expect(drawn(layoutsOf(binning, { A: editOf('A', JOINED), B: b }))).toEqual({
      B: ['c3 = c3+', 'c4_e1 = c4-', 'c0_e1 = c0+ N100 c2-', 'c1_e1 = c1-'],
    })
    // …and alone, where the genome merged into has no edit of its own.
    expect(drawn(layoutsOf(binning, { A: editOf('A', JOINED) }))).toEqual({
      B: ['c0_e1 = c0+ N100 c2-', 'c1_e1 = c1-', 'c3 = c3+', 'c4 = c4+'],
    })
  })

  it('draws a contig once, by the genome’s own layout, where a stale one still holds it', () => {
    // B brought c0 in (the curation moved it); A's edit still joins it to c2.
    const binning = curated({ op: 'move', contigs: ['c0'], to: 'B' })
    const b = editOf('B', [{ op: 'bring', sequence: 'c0' }])
    const bWithC0 = { ...b, original: { ...b.original, elsewhere: [{ name: 'c0', length: 5000, genome: 'A' }] } }
    const layouts = layoutsOf(binning, { A: editOf('A', JOINED), B: bWithC0 })
    expect(drawn(layouts)).toEqual({
      A: ['c2_e1 = c2-', 'c1_e1 = c1-'],
      B: ['c3 = c3+', 'c4 = c4+', 'c0 = c0+'],
    })
  })

  it('draws a stretch set aside unplaced as a sequence of its own, named as the AGP names it, and keeps the others aside', () => {
    const edit = editOf('A', [
      { op: 'aside', sequence: 'c1', from: 0, to: 1000, why: 'unplaced' },
      { op: 'aside', sequence: 'c0', from: 4000, to: 5000, why: 'debris' },
    ])
    const [layout] = layoutsOf(curated(), { A: edit })
    expect(drawn([layout])).toEqual({
      A: ['c0_e1 = c0:0-4000+', 'c1_e1 = c1:1000-4000+', 'c2 = c2+', 'c1_unplaced1 = c1:0-1000+'],
    })
    expect(layout.sequences.map((sequence) => sequence.unplaced === true)).toEqual([false, false, false, true])
    expect(layout.aside.map((item) => [item.piece.sequence, item.piece.start, item.piece.end, item.why])).toEqual([['c0', 4000, 5000, 'debris']])
  })

  it('gives every drawn sequence a name no other has, nor any contig of the file', () => {
    const a = editOf('A', [{ op: 'rename', sequence: 'c1', name: 'chr1' }])
    const b = editOf('B', [
      { op: 'rename', sequence: 'c3', name: 'chr1' },
      { op: 'rename', sequence: 'c4', name: 'c6' },
    ])
    expect(drawn(layoutsOf(curated(), { A: a, B: b }))).toEqual({
      A: ['c0 = c0+', 'chr1 = c1+', 'c2 = c2+'],
      B: ['chr1_e1 = c3+', 'c6_e1 = c4+'],
    })
  })

  it('draws no edit kept under another genome’s key, nor one made on another assembly', () => {
    const a = editOf('A', JOINED)
    const wrongLength = { ...a, original: { ...a.original, lengths: [5000, 4000, 2999] } }
    expect(layoutsOf(curated(), { B: a })).toEqual([])
    expect(layoutsOf(curated(), { A: wrongLength })).toEqual([])
  })

  it('has a fingerprint that changes with what is drawn, and is empty for nothing', () => {
    const one = layoutsOf(curated(), { A: editOf('A', JOINED) })
    const two = layoutsOf(curated(), { A: editOf('A', [JOINED[0]]) })
    expect(layoutsFingerprint([])).toBe('')
    expect(layoutsFingerprint(one)).not.toBe(layoutsFingerprint(two))
    expect(layoutsFingerprint(one)).toBe(layoutsFingerprint(layoutsOf(curated(), { A: editOf('A', JOINED) })))
  })
})

describe('the edit a genome’s stage opens on', () => {
  const membersOf = (binning: CuratedBinning, id: string): { names: string[]; lengths: number[] } =>
    membersInOrder(binning, binning.indexOfId(id) as number, BASE.names, BASE.lengths)

  it('is the kept edit as it is where it holds exactly the genome’s contigs', () => {
    const binning = curated()
    expect(rebasedEdit({ id: 'A', name: 'A', members: membersOf(binning, 'A'), kept: editOf('A', JOINED), drawn: null, when: 9 })).toBeNull()
  })

  it('is one step laying the genome out as it is drawn where the curation moved its contigs since', () => {
    const binning = curated({ op: 'move', contigs: ['c2'], to: 'B' }, { op: 'move', contigs: ['c3'], to: 'A' })
    const layouts = layoutsOf(binning, { A: editOf('A', JOINED) })
    const rebased = rebasedEdit({ id: 'A', name: 'A', members: membersOf(binning, 'A'), kept: editOf('A', JOINED), drawn: layouts[0], when: 9 })
    expect(rebased).not.toBeNull()
    const edit = rebased as ReferenceEdit
    expect(edit.original).toEqual({ names: ['c0', 'c1', 'c3'], lengths: [5000, 4000, 2000], genome: 'A' })
    expect(edit.cursor).toBe(1)
    expect(edit.history[0].by).toBe('auto')
    expect(edit.history[0].step.op).toBe('layout')
    const assembly = EditedAssembly.of(edit)
    expect(assembly.sequences.map((sequence) => `${sequence.name} = ${words(sequence.parts)}`)).toEqual(['c0 = c0+', 'c1_e1 = c1-', 'c3 = c3+'])
    // What the stage then shows is what the map draws.
    expect(drawn(layoutsOf(binning, { A: edit }))).toEqual(drawn(layouts))
  })

  it('is a fresh edit of the genome’s contigs where what is drawn of them is every contig whole', () => {
    const binning = curated({ op: 'move', contigs: ['c2'], to: 'B' })
    const kept = editOf('A', [{ op: 'invert', sequence: 'c2', from: 0, to: 3000 }])
    const rebased = rebasedEdit({ id: 'A', name: 'A', members: membersOf(binning, 'A'), kept, drawn: null, when: 9 })
    expect(rebased).toEqual(emptyEdit({ names: ['c0', 'c1'], lengths: [5000, 4000], genome: 'A' }))
  })

  it('leaves an edit kept under another genome’s key to its store to refuse', () => {
    const binning = curated({ op: 'move', contigs: ['c2'], to: 'B' })
    expect(rebasedEdit({ id: 'B', name: 'B', members: membersOf(binning, 'B'), kept: editOf('A', JOINED), drawn: null, when: 9 })).toBeNull()
  })
})

describe('the curation steps an edit’s change makes', () => {
  const membership = (edit: ReferenceEdit) => layoutMembership(EditedAssembly.of(edit))

  function mirror(before: ReferenceEdit, after: ReferenceEdit, binning: CuratedBinning, here = 'A'): CurationStep[] {
    const origin = new Map((after.original.elsewhere ?? []).map((contig) => [contig.name, contig.genome]))
    return mirroredMoves({ here, before: membership(before), after: membership(after), origin, binning, contigIndex: INDEX })
  }

  const withBrought = (edit: ReferenceEdit): ReferenceEdit => ({ ...edit, original: { ...edit.original, elsewhere: [{ name: 'c3', length: 2000, genome: 'B' }] } })

  it('moves a contig brought in to the genome', () => {
    const before = withBrought(editOf('A', []))
    const after = withStep(before, { op: 'bring', sequence: 'c3' }, 'reader', 1)
    expect(mirror(before, after, curated())).toEqual([{ op: 'move', contigs: ['c3'], to: 'A' }])
  })

  it('moves a bring undone back where the contig came from', () => {
    // The bring was mirrored: c3 is A's.
    const binning = curated({ op: 'move', contigs: ['c3'], to: 'A' })
    const brought = withStep(withBrought(editOf('A', [])), { op: 'bring', sequence: 'c3' }, 'reader', 1)
    const undone = { ...brought, cursor: 0 }
    expect(mirror(brought, undone, binning)).toEqual([{ op: 'move', contigs: ['c3'], to: 'B' }])
  })

  it('moves a contig set aside whole to the pool, or to the genome it was sent to', () => {
    const before = editOf('A', [])
    const debris = withStep(before, { op: 'aside', sequence: 'c1', from: 0, to: 4000, why: 'debris' }, 'reader', 1)
    const sent = withStep(debris, { op: 'aside', sequence: 'c2', from: 0, to: 3000, why: 'contaminant', genome: 'B' }, 'reader', 2)
    expect(mirror(before, sent, curated())).toEqual([
      { op: 'move', contigs: ['c1'], to: null },
      { op: 'move', contigs: ['c2'], to: 'B' },
    ])
    // Put back: the contig comes home.
    const binning = curated({ op: 'move', contigs: ['c1'], to: null })
    expect(mirror(debris, before, binning)).toEqual([{ op: 'move', contigs: ['c1'], to: 'A' }])
  })

  it('moves nothing for a stretch set aside of a contig that stays, nor for one set aside unplaced', () => {
    const before = editOf('A', [])
    const part = withStep(before, { op: 'aside', sequence: 'c1', from: 0, to: 1000, why: 'debris' }, 'reader', 1)
    const unplaced = withStep(before, { op: 'aside', sequence: 'c2', from: 0, to: 3000, why: 'unplaced' }, 'reader', 1)
    expect(mirror(before, part, curated())).toEqual([])
    expect(mirror(before, unplaced, curated())).toEqual([])
  })

  it('sends a contig to the pool where the genome it was sent to is gone, and leaves one the curation moved since', () => {
    const before = editOf('A', [])
    const sent = withStep(before, { op: 'aside', sequence: 'c2', from: 0, to: 3000, why: 'contaminant', genome: 'B' }, 'reader', 1)
    expect(mirror(before, sent, curated({ op: 'dissolve', genome: 'B' }))).toEqual([{ op: 'move', contigs: ['c2'], to: null }])
    // c2 is E's now: the curation's, whatever the edit says.
    expect(mirror(before, sent, curated({ op: 'move', contigs: ['c2'], to: 'E' }))).toEqual([])
  })
})
