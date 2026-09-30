/**
 * One genome of a metagenome, edited on its own (SPECS §27.10): its contigs
 * the original, checked as part of the file's; a stretch sent to another
 * genome, which the AGP says and reads back; a contig of another genome
 * brought in, once, and kept by the store as one the edit may name.
 */

import { describe, expect, it } from 'vitest'

import { binningTable } from '@/edit/binning'
import { agpOf, readAgp } from '@/edit/exports'
import { stepText } from '@/edit/words'
import { EditedAssembly, emptyEdit, mismatch, withStep, type EditStep, type OriginalAssembly } from '@/genome/edit'
import { EditStore, genomeEditKey } from '@/state/referenceEdit'

/** The file: two genomes' contigs and one of no genome. */
const FILE = { names: ['a1', 'a2', 'b1', 'u1'], lengths: [1000, 600, 800, 300] }

/** Genome A's edit, which may bring in `b1` of genome B. */
const GENOME_A: OriginalAssembly = {
  names: ['a1', 'a2'],
  lengths: [1000, 600],
  genome: 'A',
  elsewhere: [{ name: 'b1', length: 800, genome: 'B' }],
}

const CONTEXT = { file: 'meta.metacool', by: 'test', created: '2026-09-30', steps: [] as string[] }

function assemblyOf(original: OriginalAssembly, ...steps: EditStep[]): EditedAssembly {
  let edit = emptyEdit(original)
  steps.forEach((step, i) => (edit = withStep(edit, step, 'reader', i)))
  return EditedAssembly.of(edit)
}

describe('a genome’s edit', () => {
  it('is checked as part of the file: every contig of it, and every one it may bring in, the file’s and as long', () => {
    const edit = emptyEdit(GENOME_A)
    expect(mismatch(edit, FILE.names, FILE.lengths)).toBeNull()
    expect(mismatch(edit, ['a1', 'a2', 'u1'], [1000, 600, 300])).toBe('the edit names b1, which this file does not have')
    expect(mismatch(edit, FILE.names, [1000, 601, 800, 300])).toBe('a2 is 600 bp in the edit and 601 bp here')
  })

  it('brings a contig of another genome in whole, after the others, and once', () => {
    const assembly = assemblyOf(GENOME_A, { op: 'bring', sequence: 'b1' }, { op: 'bring', sequence: 'b1' })
    expect(assembly.sequences.map((sequence) => sequence.name)).toEqual(['a1', 'a2', 'b1'])
    expect(assembly.lengthOf('b1')).toBe(800)
    // Nothing it may not: a contig of no genome it was not given.
    expect(assemblyOf(GENOME_A, { op: 'bring', sequence: 'u1' }).sequences).toHaveLength(2)
    // Brought and joined, it is a scaffold of the genome like any other.
    const joined = assemblyOf(GENOME_A, { op: 'bring', sequence: 'b1' }, { op: 'join', a: 'a1', aEnd: 'end', b: 'b1', bEnd: 'start', gap: 100 })
    expect(joined.sequences.map((sequence) => [sequence.name, joined.lengthOf(sequence.name)])).toEqual([
      ['a1_e1', 1900],
      ['a2', 600],
    ])
    expect(stepText({ op: 'bring', sequence: 'b1' })).toBe('bring in b1')
  })

  it('sends a stretch to another genome, says so, and writes it in the AGP to be read back', () => {
    const send: EditStep = { op: 'aside', sequence: 'a2', from: 0, to: 600, why: 'contaminant', genome: 'B' }
    expect(stepText(send)).toBe('send a2:1-600 to B')
    const assembly = assemblyOf(GENOME_A, send)
    expect(assembly.aside.map((item) => [item.piece.sequence, item.why, item.genome])).toEqual([['a2', 'contaminant', 'B']])
    const text = agpOf(assembly, CONTEXT)
    expect(text).toContain('# aside\tcontaminant\ta2:1-600\tB\n')
    const read = readAgp(text, GENOME_A, 'a.agp')
    if (!read.ok) throw new Error(read.why)
    const back = EditedAssembly.of(withStep(emptyEdit(GENOME_A), read.step, 'reader', 0))
    expect(back.aside.map((item) => [item.piece.sequence, item.why, item.genome])).toEqual([['a2', 'contaminant', 'B']])
  })
})

describe('the store of a genome’s edit', () => {
  it('makes a contig of another genome one it may name, and brings it in as a step to undo', () => {
    const key = genomeEditKey('store|meta.metacool', 'A')
    const store = new EditStore(key, { names: GENOME_A.names, lengths: GENOME_A.lengths, genome: 'A' }, () => 3, FILE)
    store.bring({ name: 'b1', length: 800, genome: 'B' })
    expect(store.edit.original.elsewhere).toEqual([{ name: 'b1', length: 800, genome: 'B' }])
    expect(store.assembly.sequences.map((sequence) => sequence.name)).toEqual(['a1', 'a2', 'b1'])
    store.undo()
    expect(store.assembly.sequences.map((sequence) => sequence.name)).toEqual(['a1', 'a2'])
    expect(store.edit.original.elsewhere).toHaveLength(1)
    // Read back under the genome's key, and refused under another genome's.
    const again = new EditStore(key, { names: GENOME_A.names, lengths: GENOME_A.lengths, genome: 'A' }, undefined, FILE)
    expect(again.refusal).toBeNull()
    expect(again.edit.original.elsewhere).toEqual([{ name: 'b1', length: 800, genome: 'B' }])
    const other = new EditStore(key, { names: ['b1'], lengths: [800], genome: 'B' }, undefined, FILE)
    expect(other.refusal).toBe('The edit kept for this file was made on another assembly: it is of A, and this of B.')
  })
})

describe('the contig → MAG table', () => {
  const contigs = [
    { name: 'a1', genome: 'A' },
    { name: 'a2', genome: 'A' },
    { name: 'b1', genome: 'B' },
    { name: 'u1', genome: '__unbinned__' },
  ]
  const editOf = (original: OriginalAssembly, ...steps: EditStep[]) => {
    let edit = emptyEdit(original)
    steps.forEach((step, i) => (edit = withStep(edit, step, 'reader', i)))
    return edit
  }

  it('is the file’s binning where nothing was edited, a contig of no genome left out', () => {
    const table = binningTable(contigs, new Map())
    expect(table.text).toBe('a1\tA\na2\tA\nb1\tB\n')
    expect([table.contigs, table.genomes, table.moved]).toEqual([3, 2, 0])
  })

  it('moves a contig sent away and one brought in, drops one set aside, and keeps a join’s contigs where they are', () => {
    const a = editOf(
      { names: ['a1', 'a2'], lengths: [1000, 600], genome: 'A', elsewhere: [{ name: 'u1', length: 300, genome: '__unbinned__' }] },
      { op: 'bring', sequence: 'u1' },
      { op: 'join', a: 'a1', aEnd: 'end', b: 'u1', bEnd: 'start', gap: 100 },
      { op: 'aside', sequence: 'a2', from: 0, to: 600, why: 'contaminant', genome: 'B' },
    )
    const b = editOf({ names: ['b1'], lengths: [800], genome: 'B' }, { op: 'aside', sequence: 'b1', from: 0, to: 800, why: 'debris' })
    const table = binningTable(contigs, new Map([['A', a], ['B', b]]))
    expect(table.text).toBe('a1\tA\na2\tB\nu1\tA\n')
    expect(table.moved).toBe(3)
    expect(table.notes).toEqual([])
  })

  it('keeps a contig only part of which was sent away, and says so', () => {
    const a = editOf({ names: ['a1', 'a2'], lengths: [1000, 600], genome: 'A' }, { op: 'aside', sequence: 'a1', from: 0, to: 100, why: 'contaminant', genome: 'B' })
    const table = binningTable(contigs, new Map([['A', a]]))
    expect(table.text).toBe('a1\tA\na2\tA\nb1\tB\n')
    expect(table.notes).toEqual(['part of a1 was sent from A to B, and part kept: the table keeps it in A'])
  })
})
