// @dev-feature curate
/**
 * The curation's tables (SPECS §33.8): contig → genome for `metacooler
 * reassign`, the elements, and the element ↔ host pairs with who decided each.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type BaseBinning, type Curation, type CurationStep } from '../../src/genome/curation'
import { contigGenomeTable, elementHostTable, elementsTable, linkDeciders } from '../../src/curate/exports'
import type { HostPair } from '../../src/curate/suggest'

const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'p0', 'p1', 'u0'],
  lengths: [5000, 4000, 3000, 800, 700, 500],
  genomeOf: Int32Array.from([0, 0, 1, 2, 2, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
    { name: 'P', kind: 'element' },
  ],
  links: [{ element: 'P', mag: 'A' }],
}

function curation(...steps: Array<[CurationStep, 'reader' | 'suggestion' | 'auto']>): Curation {
  return steps.reduce((held: Curation, [step, by], i) => withCurationStep(held, step, by, i), emptyCuration(fileBinning(BASE)))
}

describe('the contig → genome table', () => {
  it('lists every contig in the file’s order with a header, the pool as __unbinned__', () => {
    const held = curation([{ op: 'move', contigs: ['u0'], to: 'B' }, 'reader'], [{ op: 'rename', genome: 'A', name: 'K_pneumoniae' }, 'reader'], [{ op: 'move', contigs: ['c1'], to: null }, 'reader'])
    const table = contigGenomeTable(CuratedBinning.of(BASE, held), BASE.names)
    expect(table.text).toBe('contig_name\tgenome_name\nc0\tK_pneumoniae\nc1\t__unbinned__\nc2\tB\np0\tP\np1\tP\nu0\tB\n')
    expect(table.rows).toBe(6)
    expect(table.note).toMatch(/6 contigs in 3 genomes, 1 in none/)
  })
})

describe('the elements table', () => {
  it('gives each element its length, contigs and hosts', () => {
    const table = elementsTable(CuratedBinning.of(BASE, curation([{ op: 'link', element: 'P', mag: 'B' }, 'suggestion'])), BASE.names, BASE.lengths)
    expect(table.text).toBe('element\tlength\tn_contigs\tcontigs\tn_hosts\thosts\nP\t1500\t2\tp0,p1\t2\tA,B\n')
  })
})

describe('the element ↔ host table', () => {
  const pairs: HostPair[] = [
    { element: 2, mag: 1, contacts: 40, affinity: 0.4321, share: 0.8, confidence: 0.97, linked: false },
    { element: 2, mag: 0, contacts: 10, affinity: 0.05, share: 0.2, confidence: 0.1, linked: true },
  ]

  it('writes every pair in contact, linked or not, and who decided each', () => {
    const held = curation([{ op: 'link', element: 'P', mag: 'B' }, 'suggestion'])
    const table = elementHostTable(CuratedBinning.of(BASE, held), pairs, held)
    expect(table.text.split('\n')).toEqual([
      'element\tmag\tcontacts\taffinity\tshare\tconfidence\tlinked\tdecided_by',
      'P\tB\t40\t0.4321\t0.8\t0.97\tyes\tsuggestion',
      'P\tA\t10\t0.05\t0.2\t0.1\tyes\tfile',
      '',
    ])
  })

  it('says a link turned down is no longer one, and by whom', () => {
    const held = curation([{ op: 'unlink', element: 'P', mag: 'A' }, 'auto'])
    const table = elementHostTable(CuratedBinning.of(BASE, held), pairs, held)
    expect(table.text).toContain('P\tA\t10\t0.05\t0.2\t0.1\tno\tauto')
    expect(linkDeciders(held).get('P\tA')).toEqual({ by: 'auto', linked: false })
  })

  it('writes a link with no contact at all, which holds all the same', () => {
    const table = elementHostTable(CuratedBinning.of(BASE, null), [], null)
    expect(table.text).toBe('element\tmag\tcontacts\taffinity\tshare\tconfidence\tlinked\tdecided_by\nP\tA\t0\t0\t0\t\tyes\tfile\n')
  })
})
