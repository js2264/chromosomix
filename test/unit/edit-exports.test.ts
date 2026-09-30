/**
 * What an edit is written as, and read back from (SPECS §27.8): AGP 2.1,
 * chrom.sizes, a Juicebox `.assembly` and a liftOver chain. The contract worth
 * testing is the round trip — an edit written and read back is the same edit,
 * piece for piece and reason for reason — and the refusals: a file of another
 * assembly, and a duplication the `.assembly` cannot say.
 */

import { describe, expect, it } from 'vitest'

import { agpOf, assemblyObjects, chainOf, chromSizesOf, juiceboxAssemblyOf, readAgp, readJuiceboxAssembly } from '../../src/edit/exports'
import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'

const ORIGINAL = { names: ['I', 'II', 'III'], lengths: [1000, 600, 300] }
const CONTEXT = { file: 'test.cool', by: 'metacooler-viewer test', created: '2026-09-30', steps: [] as string[] }

function editOf(...steps: EditStep[]): ReferenceEdit {
  let edit: ReferenceEdit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return edit
}

const assemblyOf = (...steps: EditStep[]): EditedAssembly => EditedAssembly.of(editOf(...steps))

/** What an assembly is, without the piece ids a replay mints afresh. */
function shape(assembly: EditedAssembly): unknown {
  return {
    sequences: assembly.sequences.map((sequence) => ({
      name: sequence.name,
      parts: sequence.parts.map((part) => ('gap' in part ? { gap: part.gap } : { sequence: part.sequence, start: part.start, end: part.end, strand: part.strand })),
    })),
    aside: assembly.aside.map((item) => ({ sequence: item.piece.sequence, start: item.piece.start, end: item.piece.end, why: item.why })),
  }
}

/** Read a layout back onto the original, as the stage applies it. */
function applied(step: EditStep): EditedAssembly {
  return EditedAssembly.of(withStep(emptyEdit(ORIGINAL), step, 'reader', 0))
}

const SCRAMBLE: EditStep[] = [
  { op: 'invert', sequence: 'I', from: 200, to: 500 },
  { op: 'join', a: 'II', aEnd: 'end', b: 'III', bEnd: 'end', gap: 100 },
  { op: 'aside', sequence: 'I_e1', from: 900, to: 1000, why: 'debris' },
  { op: 'aside', sequence: 'I_e1', from: 0, to: 50, why: 'unplaced' },
]

describe('the AGP', () => {
  it('writes the file as it is as one component per sequence', () => {
    const text = agpOf(assemblyOf(), CONTEXT)
    const rows = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    expect(text.startsWith('##agp-version\t2.1\n')).toBe(true)
    expect(rows).toEqual(['I\t1\t1000\t1\tW\tI\t1\t1000\t+', 'II\t1\t600\t1\tW\tII\t1\t600\t+', 'III\t1\t300\t1\tW\tIII\t1\t300\t+'])
  })

  it('writes turned pieces as -, a join’s N as a scaffold gap, and the history in its header', () => {
    const text = agpOf(assemblyOf(...SCRAMBLE), { ...CONTEXT, steps: ['turn I:201-500', 'join II’s end to III’s end'] })
    expect(text).toContain('# 1. turn I:201-500\n# 2. join II’s end to III’s end\n')
    const rows = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    expect(rows).toEqual([
      'I_e1\t1\t150\t1\tW\tI\t51\t200\t+',
      'I_e1\t151\t450\t2\tW\tI\t201\t500\t-',
      'I_e1\t451\t850\t3\tW\tI\t501\t900\t+',
      'II_e1\t1\t600\t1\tW\tII\t1\t600\t+',
      'II_e1\t601\t700\t2\tN\t100\tscaffold\tyes\tproximity_ligation',
      'II_e1\t701\t1000\t3\tW\tIII\t1\t300\t-',
      'I_unplaced1\t1\t50\t1\tW\tI\t1\t50\t+',
    ])
    expect(text).toContain('# aside\tunplaced\tI_unplaced1\n')
    expect(text).toContain('# aside\tdebris\tI:901-1000\n')
  })

  it('reads back as the edit it was: every piece, every gap, and what was set aside and why', () => {
    const assembly = assemblyOf(...SCRAMBLE)
    const read = readAgp(agpOf(assembly, CONTEXT), ORIGINAL, 'test.agp')
    if (!read.ok) throw new Error(read.why)
    expect(shape(applied(read.step))).toEqual(shape(assembly))
  })

  it('reads another tool’s scaffolds, and sets aside, unplaced, whatever it leaves out', () => {
    const agp = [
      '##agp-version 2.1',
      'scaffold_1\t1\t300\t1\tW\tIII\t1\t300\t-',
      'scaffold_1\t301\t500\t2\tN\t200\tscaffold\tyes\tproximity_ligation',
      'scaffold_1\t501\t1100\t3\tW\tII\t1\t600\t+',
      'scaffold_2\t1\t800\t1\tW\tI\t1\t800\t+',
    ].join('\n')
    const read = readAgp(agp, ORIGINAL, 'yahs.agp')
    if (!read.ok) throw new Error(read.why)
    const assembly = applied(read.step)
    expect(assembly.contigs()).toEqual([
      { name: 'scaffold_1', length: 1100 },
      { name: 'scaffold_2', length: 800 },
    ])
    expect(assembly.toOriginal('scaffold_1', 0)).toEqual({ sequence: 'III', bp: 299, strand: -1 })
    expect(assembly.aside.map((item) => [item.piece.sequence, item.piece.start, item.piece.end, item.why])).toEqual([['I', 800, 1000, 'unplaced']])
  })

  it('refuses an AGP of another assembly, naming what the map does not have', () => {
    const read = readAgp('chrI\t1\t100\t1\tW\tchr9\t1\t100\t+\n', ORIGINAL, 'other.agp')
    expect(read).toEqual({ ok: false, why: 'it names chr9 (line 1), which the map does not have: it is an AGP of another assembly' })
    const past = readAgp('x\t1\t2000\t1\tW\tI\t1\t2000\t+\n', ORIGINAL, 'past.agp')
    expect(past.ok).toBe(false)
  })
})

describe('chrom.sizes', () => {
  it('lists every sequence the files write, an unplaced stretch among them', () => {
    expect(chromSizesOf(assemblyOf(...SCRAMBLE))).toBe('I_e1\t850\nII_e1\t1000\nI_unplaced1\t50\n')
    expect(assemblyObjects(assemblyOf(...SCRAMBLE)).map((object) => object.unplaced)).toEqual([false, false, true])
  })
})

describe('the Juicebox .assembly', () => {
  it('cuts the original into fragments at every piece’s ends, and lists each sequence as signed fragments', () => {
    const written = juiceboxAssemblyOf(assemblyOf(...SCRAMBLE))
    if (!written.ok) throw new Error(written.why)
    expect(written.text.split('\n').filter((line) => line !== '')).toEqual([
      '>I:::fragment_1 1 50',
      '>I:::fragment_2 2 150',
      '>I:::fragment_3 3 300',
      '>I:::fragment_4 4 400',
      '>I:::fragment_5:::debris 5 100',
      '>II 6 600',
      '>III 7 300',
      '2 -3 4',
      '6 -7',
      '1',
      '5',
    ])
  })

  it('reads back as the edit it was, a join’s gap aside', () => {
    const assembly = assemblyOf(...SCRAMBLE)
    const written = juiceboxAssemblyOf(assembly)
    if (!written.ok) throw new Error(written.why)
    const read = readJuiceboxAssembly(written.text, ORIGINAL, 'test.assembly')
    if (!read.ok) throw new Error(read.why)
    const back = applied(read.step)
    // The .assembly has no gaps and no names: the join's 100 N is put back as the
    // stage's own join gap, and the sequences are numbered in the file's order.
    expect(back.contigs()).toEqual([
      { name: 'scaffold_1', length: 850 },
      { name: 'scaffold_2', length: 1000 },
      { name: 'scaffold_3', length: 50 },
    ])
    expect(back.aside.map((item) => [item.piece.sequence, item.piece.start, item.piece.end, item.why])).toEqual([['I', 900, 1000, 'debris']])
    expect(back.toOriginal('scaffold_1', 150)).toEqual({ sequence: 'I', bp: 499, strand: -1 })
  })

  it('refuses a stretch placed twice, which the format cannot say', () => {
    const written = juiceboxAssemblyOf(assemblyOf({ op: 'duplicate', sequence: 'I', from: 100, to: 200, into: 'II', at: 0, strand: 1 }))
    expect(written).toEqual({ ok: false, why: 'I is placed twice from 101, and an .assembly lists every fragment once' })
  })

  it('refuses fragments that do not add up to the map’s sequences', () => {
    const read = readJuiceboxAssembly('>I 1 999\n>II 2 600\n>III 3 300\n1\n2\n3\n', ORIGINAL, 'short.assembly')
    expect(read).toEqual({ ok: false, why: 'its fragments of I add up to 999 bp, and I is 1,000 bp' })
  })
})

describe('the liftOver chain', () => {
  it('maps each piece from the original to the edited sequence, turned pieces on the query’s minus strand', () => {
    const text = chainOf(assemblyOf({ op: 'invert', sequence: 'I', from: 200, to: 500 }), CONTEXT)
    const chains = text.split('\n').filter((line) => line.startsWith('chain'))
    expect(chains).toEqual([
      'chain 200 I 1000 + 0 200 I_e1 1000 + 0 200 1',
      // Reversed: counted from the query's end — 1000 - 500 = 500 to 800.
      'chain 300 I 1000 + 200 500 I_e1 1000 - 500 800 2',
      'chain 500 I 1000 + 500 1000 I_e1 1000 + 500 1000 3',
      'chain 600 II 600 + 0 600 II 600 + 0 600 4',
      'chain 300 III 300 + 0 300 III 300 + 0 300 5',
    ])
  })
})
