// @dev-feature curate
/**
 * A genome's edit of the reference opened inside a curation (SPECS §27.10,
 * §33.4): the session's two stores side by side, a step of the edit that takes
 * a contig in or lets one go made a move of the curation, an undo of it moving
 * the contig back, and the edit the stage opens on once the curation has moved
 * the genome's contigs since — held, not kept, until a step is made.
 */

import { describe, expect, it } from 'vitest'

import { assignmentOf, curatedIdOf, mirrorIntoCuration } from '@/curate/genomeEdits'
import { drawnLayouts, membersInOrder, rebasedEdit } from '@/curate/layouts'
import { fileBinning, UNBINNED, type BaseBinning } from '@/genome/curation'
import { EditedAssembly } from '@/genome/edit'
import { CurationStore } from '@/state/curation'
import { EDIT_SCOPE, EditStore, genomeEditKey } from '@/state/referenceEdit'
import { recall } from '@/state/UiMemory'

/** A: c0–c2, B: c3–c4, the pool: c5. */
const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
  lengths: [5000, 4000, 3000, 2000, 1000, 500],
  genomeOf: Int32Array.from([0, 0, 0, 1, 1, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
  ],
  links: [],
}

let files = 0

/** A fresh file's two stores, and A's edit opened as the session opens it. */
function open(id = 'A'): { curation: CurationStore; edit: EditStore; key: string; stop: () => void } {
  const file = `genome-edits-${++files}.metacool`
  const curation = new CurationStore(file, BASE, fileBinning(BASE), () => 1)
  const g = curation.binning.indexOfId(id) as number
  const members = membersInOrder(curation.binning, g, BASE.names, BASE.lengths)
  const key = genomeEditKey(file, id)
  const edit = new EditStore(key, { ...members, genome: id }, () => 1, { names: BASE.names, lengths: BASE.lengths })
  return { curation, edit, key, stop: mirrorIntoCuration(edit, curation, id) }
}

/** Each contig's genome, by name, `-` for the pool. */
function where(curation: CurationStore): string {
  const binning = curation.binning
  return BASE.names.map((_, c) => (binning.genomeOf[c] < 0 ? '-' : binning.genomes[binning.genomeOf[c]].name)).join(' ')
}

describe('a genome’s edit inside a curation', () => {
  it('makes a contig sent to another genome a move of the curation, and an undo a move back', () => {
    const { curation, edit } = open()
    edit.apply({ op: 'aside', sequence: 'c2', from: 0, to: 3000, why: 'contaminant', genome: 'B' })
    expect(where(curation)).toBe('A A B B B -')
    expect(curation.curation.history.map((entry) => entry.step)).toEqual([{ op: 'move', contigs: ['c2'], to: 'B' }])
    edit.undo()
    expect(where(curation)).toBe('A A A B B -')
    // Each a step of the curation's own history, to undo there as well.
    expect(curation.applied).toBe(2)
  })

  it('sends a contig set aside whole as debris to the pool, and keeps one only part of which is', () => {
    const { curation, edit } = open()
    edit.apply({ op: 'aside', sequence: 'c1', from: 0, to: 4000, why: 'debris' })
    edit.apply({ op: 'aside', sequence: 'c0', from: 0, to: 1000, why: 'haplotig' })
    expect(where(curation)).toBe('A - A B B -')
    expect(curation.applied).toBe(1)
  })

  it('makes a contig brought in the genome’s, and a bring undone the genome’s it came from', () => {
    const { curation, edit } = open()
    edit.bring({ name: 'c3', length: 2000, genome: 'B' })
    expect(where(curation)).toBe('A A A A B -')
    edit.undo()
    expect(where(curation)).toBe('A A A B B -')
    // A genome renamed since is found by its name now; one gone sends it to the pool.
    edit.redo()
    curation.apply({ op: 'dissolve', genome: 'B' })
    edit.undo()
    expect(where(curation)).toBe('A A A - - -')
  })

  it('stops when told', () => {
    const { curation, edit, stop } = open()
    stop()
    edit.apply({ op: 'aside', sequence: 'c2', from: 0, to: 3000, why: 'debris' })
    expect(curation.applied).toBe(0)
  })

  it('names the curated genome a name means, and the partners by the curation as it stands', () => {
    const { curation } = open()
    curation.apply({ op: 'rename', genome: 'B', name: 'Bee' })
    expect(curatedIdOf(curation, 'Bee')).toBe('B')
    expect(curatedIdOf(curation, 'B')).toBe('B')
    expect(curatedIdOf(curation, 'nothing')).toBeUndefined()
    const assignment = assignmentOf(curation)
    expect(assignment.genomes).toEqual(['A', 'Bee', UNBINNED])
    expect(Array.from(assignment.genomeOf)).toEqual([0, 0, 0, 1, 1, 2])
  })
})

describe('the edit a genome’s stage opens on, once the curation moved its contigs', () => {
  it('is held, not kept, until a step is made — and that step keeps it', () => {
    const { curation, edit, key } = open()
    edit.apply({ op: 'join', a: 'c0', aEnd: 'end', b: 'c2', bEnd: 'end', gap: 100 })
    edit.apply({ op: 'invert', sequence: 'c1', from: 0, to: 4000 })
    const kept = edit.edit
    // The curation, since, moves c2 to B and c3 into A.
    curation.applyAll([{ step: { op: 'move', contigs: ['c2'], to: 'B' } }, { step: { op: 'move', contigs: ['c3'], to: 'A' } }])
    const binning = curation.binning
    const g = binning.indexOfId('A') as number
    const members = membersInOrder(binning, g, BASE.names, BASE.lengths)
    const again = new EditStore(key, { ...members, genome: 'A' }, () => 2, { names: BASE.names, lengths: BASE.lengths })
    expect(again.edit).toEqual(kept)
    const drawn = drawnLayouts({ binning, names: BASE.names, lengths: BASE.lengths, edits: new Map([['A', again.edit]]) }).find((layout) => layout.id === 'A') ?? null
    const rebased = rebasedEdit({ id: 'A', name: 'A', members, kept: again.edit, drawn, when: 2 })
    expect(rebased).not.toBeNull()
    again.provisional(rebased!)
    // c0 without c2 is c0 again; c1 still turned; c3 whole, last.
    expect(again.assembly.sequences.map((sequence) => sequence.name)).toEqual(['c0', 'c1_e1', 'c3'])
    // Held: the record is still the edit as it was kept.
    expect(recall(key, EDIT_SCOPE)).toEqual(kept)
    again.apply({ op: 'invert', sequence: 'c3', from: 0, to: 2000 })
    const saved = recall(key, EDIT_SCOPE) as typeof kept
    expect(saved.history.map((entry) => entry.step.op)).toEqual(['layout', 'invert'])
    expect(EditedAssembly.of(saved).sequences.map((sequence) => sequence.name)).toEqual(['c0', 'c1_e1', 'c3_e1'])
  })
})
