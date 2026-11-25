// @dev-feature curate
/**
 * Every curated genome as the session draws it, written (SPECS §33.8): the
 * AGP of every genome's sequences — laid out by its edit (§27.10), or as its
 * contigs — the table of which genome each sequence is of, and the FASTA's
 * records, each naming its genome.
 */

import { describe, expect, it } from 'vitest'

import { curatedAgp, curatedSequences, fastaObjects, sequenceGenomeTable } from '../../src/curate/layoutExports'
import { drawnLayouts, membersInOrder } from '../../src/curate/layouts'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type BaseBinning } from '../../src/genome/curation'
import { emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import { fastaOfObjects } from '../../src/edit/lifted'

/** B: c0–c2, A: c3–c4, E an element: c5; c6 in the pool. */
const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
  lengths: [300, 200, 100, 50, 40, 30, 20],
  genomeOf: Int32Array.from([0, 0, 0, 1, 1, 2, -1]),
  genomes: [
    { name: 'B', kind: 'mag' },
    { name: 'A', kind: 'mag' },
    { name: 'E', kind: 'element' },
  ],
  links: [],
}

function edited(binning: CuratedBinning, id: string, steps: EditStep[]): ReferenceEdit {
  const members = membersInOrder(binning, binning.indexOfId(id) as number, BASE.names, BASE.lengths)
  return steps.reduce((edit, step, i) => withStep(edit, step, 'reader', i), emptyEdit({ ...members, genome: id }))
}

function written() {
  const curation = withCurationStep(emptyCuration(fileBinning(BASE)), { op: 'rename', genome: 'B', name: 'Bee' }, 'reader', 0)
  const binning = CuratedBinning.of(BASE, curation)
  const b = edited(binning, 'B', [
    { op: 'join', a: 'c0', aEnd: 'end', b: 'c2', bEnd: 'end', gap: 100 },
    { op: 'aside', sequence: 'c1', from: 150, to: 200, why: 'debris' },
  ])
  const layouts = drawnLayouts({ binning, names: BASE.names, lengths: BASE.lengths, edits: new Map([['B', b]]) })
  return curatedSequences(binning, BASE, layouts)
}

describe('every curated genome’s sequences', () => {
  it('are a laid-out genome’s as its edit has them and any other’s its contigs, genomes by name, the pool left out', () => {
    const out = written()
    expect(out.genomes.map((genome) => [genome.name, genome.laidOut, genome.sequences])).toEqual([
      ['A', false, 2],
      ['Bee', true, 2],
      ['E', false, 1],
    ])
    expect(out.sequences.map((sequence) => `${sequence.genome}:${sequence.name}`)).toEqual(['A:c3', 'A:c4', 'Bee:c0_e1', 'Bee:c1_e1', 'E:c5'])
  })

  it('write an AGP 2.1 with each genome named, its asides said, and its objects', () => {
    const agp = curatedAgp(written(), { file: 'mm.metacool', by: 'chromosomix test', created: '2026-01-01', steps: 1 })
    const lines = agp.trimEnd().split('\n')
    expect(lines[0]).toBe('##agp-version\t2.1')
    expect(lines).toContain('# genome\tBee\tMAG\tlaid out')
    expect(lines).toContain('# genome\tA\tMAG\tas its contigs')
    expect(lines).toContain('# aside\tdebris\tc1:151-200')
    expect(lines).toContain('c0_e1\t1\t300\t1\tW\tc0\t1\t300\t+')
    expect(lines).toContain('c0_e1\t301\t400\t2\tU\t100\tscaffold\tyes\tproximity_ligation')
    expect(lines).toContain('c0_e1\t401\t500\t3\tW\tc2\t1\t100\t-')
    expect(lines).toContain('c3\t1\t50\t1\tW\tc3\t1\t50\t+')
    // The genome's comment comes before its objects.
    expect(lines.indexOf('# genome\tBee\tMAG\tlaid out')).toBeLessThan(lines.indexOf('c0_e1\t1\t300\t1\tW\tc0\t1\t300\t+'))
    expect(lines.some((line) => line.startsWith('c6\t'))).toBe(false)
  })

  it('write the table of which genome each sequence is of', () => {
    const table = sequenceGenomeTable(written(), BASE)
    expect(table.rows).toBe(5)
    expect(table.text.split('\n').slice(0, 4)).toEqual([
      'sequence\tgenome\tkind\tlength\tlaid_out\tparts',
      'c3\tA\tMAG\t50\tno\tc3+',
      'c4\tA\tMAG\t40\tno\tc4+',
      'c0_e1\tBee\tMAG\t500\tyes\tc0+,N100,c2-',
    ])
    expect(table.text).toContain('c1_e1\tBee\tMAG\t150\tyes\tc1:1-150+')
  })

  it('write a FASTA whose every record names its genome', async () => {
    const bases = new Map(BASE.names.map((name, c) => [name, 'ACGT'.repeat(100).slice(0, BASE.lengths[c])]))
    const out = await fastaOfObjects(fastaObjects(written()), async (name, start, end) => {
      const text = bases.get(name)
      return text === undefined ? null : new TextEncoder().encode(text.slice(start, end))
    })
    const text = new TextDecoder().decode(new Uint8Array(out!.parts.flatMap((part) => [...part])))
    const headers = text.split('\n').filter((line) => line.startsWith('>'))
    expect(headers).toEqual(['>c3 genome=A', '>c4 genome=A', '>c0_e1 genome=Bee', '>c1_e1 genome=Bee', '>c5 genome=E'])
    expect(out!.missing).toEqual([])
  })
})
