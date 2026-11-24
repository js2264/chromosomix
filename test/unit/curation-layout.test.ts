// @dev-feature curate
/**
 * How a curated map lays its contigs and genomes out (SPECS §33.4), and what
 * its `/genomes` says, on a binning small enough to read by hand: the pool
 * first by name, then the genomes in code-point order, each genome's contigs
 * longest first with a tie by name — `metacooler reassign`'s order, which
 * `curation-lens.test.ts` holds against `reassign` itself — and metaTOR's
 * columns of the mobile elements written from the curated kinds and links.
 */

import { describe, expect, it } from 'vitest'

import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type BaseBinning, type Curation, type CurationStep } from '../../src/genome/curation'
import { codePointCompare, curatedBins, curatedGenomes, curationLayout, dependsOnAssignment, gatherColumn, sliceTable } from '../../src/metacooler/curationLens'
import { makeTable } from '../../src/h5/readTable'
import { stableKey } from '../../src/worker/answers'

/**
 * Seven contigs: c0–c2 in MAG `beta`, c3–c4 in MAG `Alpha`, c5 the element
 * `MGE_1`, c6 in the pool; `MGE_1` hosted by `beta`.
 */
const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
  lengths: [3000, 5000, 3000, 2000, 4000, 800, 500],
  genomeOf: Int32Array.from([0, 0, 0, 1, 1, 2, -1]),
  genomes: [
    { name: 'beta', kind: 'mag' },
    { name: 'Alpha', kind: 'mag' },
    { name: 'MGE_1', kind: 'element' },
  ],
  links: [{ element: 'MGE_1', mag: 'beta' }],
}

function curated(...steps: CurationStep[]): CuratedBinning {
  const curation = steps.reduce((held: Curation, step, i) => withCurationStep(held, step, 'reader', i), emptyCuration(fileBinning(BASE)))
  return CuratedBinning.of(BASE, curation)
}

describe('code-point order', () => {
  it('orders as Python’s sorted does, upper case before lower, not as a locale does', () => {
    const names = ['MetaTOR_MGE_00001', 'MM133_metator_00001', 'basic_curated', 'MAG_10', 'MAG_02']
    expect([...names].sort(codePointCompare)).toEqual(['MAG_02', 'MAG_10', 'MM133_metator_00001', 'MetaTOR_MGE_00001', 'basic_curated'])
    expect([...names].sort((a, b) => a.localeCompare(b))).not.toEqual([...names].sort(codePointCompare))
  })

  it('puts a character past the Basic Multilingual Plane after every one inside it', () => {
    expect(codePointCompare('a\u{1F600}', 'a�')).toBeGreaterThan(0)
    expect(codePointCompare('ab', 'abc')).toBeLessThan(0)
  })
})

describe('the curated layout', () => {
  it('is the pool first, then the genomes by name, each longest first with a tie by name', () => {
    const layout = curationLayout(BASE.names, BASE.lengths, curated({ op: 'move', contigs: ['c4'], to: 'beta' }))
    expect(layout.genomes.map((genome) => genome.name)).toEqual(['__unbinned__', 'Alpha', 'MGE_1', 'beta'])
    // beta: c1 (5000), c4 (4000), then c0 and c2 at 3000, by name.
    expect(Array.from(layout.order, (c) => BASE.names[c])).toEqual(['c6', 'c3', 'c5', 'c1', 'c4', 'c0', 'c2'])
    expect(Array.from(layout.genomeOffset)).toEqual([0, 1, 2, 3, 7])
    expect(Array.from(layout.genomeOf)).toEqual([0, 1, 2, 3, 3, 3, 3])
    for (let l = 0; l < layout.order.length; l++) expect(layout.inverse[layout.order[l]]).toBe(l)
  })

  it('has no pool where the curation leaves none', () => {
    const layout = curationLayout(BASE.names, BASE.lengths, curated({ op: 'move', contigs: ['c6'], to: 'Alpha' }))
    expect(layout.genomes.map((genome) => genome.name)).toEqual(['Alpha', 'MGE_1', 'beta'])
    expect(layout.genomes.every((genome) => genome.curated >= 0)).toBe(true)
  })

  it('carries each contig’s own bins to its new place', () => {
    const chromOffset = [0, 3, 8, 11, 13, 17, 18, 19]
    const layout = curationLayout(BASE.names, BASE.lengths, curated({ op: 'rename', genome: 'Alpha', name: 'zeta' }))
    const bins = curatedBins(layout.order, chromOffset)
    // pool c6; MGE_1 c5; beta c1, c0, c2; zeta c4, c3.
    expect(Array.from(layout.order, (c) => BASE.names[c])).toEqual(['c6', 'c5', 'c1', 'c0', 'c2', 'c4', 'c3'])
    expect(Array.from(bins.chromOffset)).toEqual([0, 1, 2, 7, 10, 13, 17, 19])
    expect(Array.from(bins.toOriginal)).toEqual([18, 17, 3, 4, 5, 6, 7, 0, 1, 2, 8, 9, 10, 13, 14, 15, 16, 11, 12])
  })
})

describe('the curated genomes table', () => {
  const file = makeTable(4, ['name', 'length', 'n_contigs', 'n_bins', 'mge', 'n_mges', 'mges', 'taxonomy', 'qc_inter_genome', 'kind'], {
    name: ['__unbinned__', 'beta', 'Alpha', 'MGE_1'],
    length: Float64Array.from([500, 11000, 6000, 800]),
    n_contigs: Float64Array.from([1, 3, 2, 1]),
    n_bins: Float64Array.from([1, 11, 6, 1]),
    mge: ['', 'False', 'False', 'True'],
    n_mges: Float64Array.from([Number.NaN, 1, 0, Number.NaN]),
    mges: ['', 'MGE_1', '', ''],
    taxonomy: ['', 'Klebsiella', 'Yersinia', ''],
    qc_inter_genome: Float64Array.from([1, 2, 3, 4]),
    kind: ['', 'chromosome', 'chromosome', 'plasmid'],
  })
  const tableOf = (binning: CuratedBinning) => {
    const layout = curationLayout(BASE.names, BASE.lengths, binning)
    return curatedGenomes({
      layout,
      binning,
      base: BASE,
      file,
      fileGenomeOf: Int32Array.from([1, 1, 1, 2, 2, 3, 0]),
      lengths: BASE.lengths,
      bins: BASE.lengths.map((length) => Math.ceil(length / 1000)),
      markers: [],
    })
  }

  it('counts each genome, says its kind and its curation, and keeps the file’s columns of one as in the file', () => {
    const { table, owned, recomputed } = tableOf(curated({ op: 'move', contigs: ['c6'], to: 'Alpha' }, { op: 'rename', genome: 'beta', name: 'Kleb' }))
    expect(table.columns).toEqual(['name', 'length', 'n_contigs', 'n_bins', 'kind', 'curation', 'mge', 'n_mges', 'mges', 'taxonomy', 'kind (file)'])
    expect(table.strings('name')).toEqual(['Alpha', 'Kleb', 'MGE_1'])
    expect(table.numbers('n_contigs')).toEqual([3, 3, 1])
    expect(table.numbers('length')).toEqual([6500, 11000, 800])
    expect(table.strings('kind')).toEqual(['MAG', 'MAG', 'element'])
    expect(table.strings('curation')).toEqual(['changed', 'as in the file', 'as in the file'])
    expect(table.strings('taxonomy')).toEqual(['', 'Klebsiella', ''])
    expect(table.strings('kind (file)')).toEqual(['', 'chromosome', 'plasmid'])
    // metaTOR's, from the links, under the names they have now.
    expect(table.strings('mge')).toEqual(['False', 'False', 'True'])
    expect(table.numbers('n_mges').map((n) => (Number.isNaN(n) ? null : n))).toEqual([0, 1, null])
    expect(table.strings('mges')).toEqual(['', 'MGE_1', ''])
    expect(owned).toEqual(['kind', 'curation', 'mge', 'n_mges', 'mges'])
    expect(recomputed).toEqual([])
  })

  it('writes a link the curation makes, and says a created genome is new', () => {
    const { table } = tableOf(
      curated({ op: 'create', id: 'e2', name: 'MGE_2', kind: 'element', contigs: ['c2'] }, { op: 'link', element: 'e2', mag: 'Alpha' }, { op: 'link', element: 'MGE_1', mag: 'Alpha' }),
    )
    expect(table.strings('name')).toEqual(['__unbinned__', 'Alpha', 'MGE_1', 'MGE_2', 'beta'])
    expect(table.strings('curation')).toEqual(['as in the file', 'as in the file', 'as in the file', 'new', 'changed'])
    expect(table.strings('mges')).toEqual(['', 'MGE_1,MGE_2', '', '', 'MGE_1'])
    expect(table.strings('mge')).toEqual(['', 'False', 'True', 'True', 'False'])
    // The pool as in the file keeps what the file says of it.
    expect(table.strings('kind')[0]).toBe('')
  })
})

describe('the pieces the handle is made of', () => {
  it('gathers a column of numbers or of text by its rows', () => {
    expect(Array.from(gatherColumn(Float64Array.from([10, 20, 30]), [2, 0, 1]) as Float64Array)).toEqual([30, 10, 20])
    expect(gatherColumn(['a', 'b', 'c'], [1, 1, 0])).toEqual(['b', 'b', 'a'])
  })

  it('slices and narrows a table as readTable does', () => {
    const table = makeTable(3, ['name', 'x'], { name: ['a', 'b', 'c'], x: Float64Array.from([1, 2, 3]) })
    const sliced = sliceTable(table, 1, 9, ['x'])
    expect(sliced.length).toBe(2)
    expect(sliced.columns).toEqual(['x'])
    expect(sliced.numbers('x')).toEqual([2, 3])
  })

  it('takes a weight that names the assignment as stale, and one that does not as kept', () => {
    expect(dependsOnAssignment({ depends_on: ['pixels', 'genome_id'] })).toBe(true)
    expect(dependsOnAssignment({ depends_on: ['pixels', 'contigs/Hit'] })).toBe(false)
    expect(dependsOnAssignment({})).toBe(false)
  })
})

describe('the name an open through a curation leaves the map under', () => {
  it('is the curated binning’s fingerprint, and never the history it carries', () => {
    const open = (key: string, steps: number) => ({
      kind: 'open',
      uri: 'm.metacool',
      curation: { key, held: { version: 1, history: Array.from({ length: steps }, (_, i) => ({ step: { op: 'move', contigs: [`c${i}`], to: null } })), cursor: steps } },
    })
    // Two histories reaching one binning name one map…
    expect(stableKey(open('3:abc', 2))).toBe(stableKey(open('3:abc', 400)))
    // …two binnings, two.
    expect(stableKey(open('3:abc', 2))).not.toBe(stableKey(open('3:abd', 2)))
    expect(stableKey(open('3:abc', 2))).not.toContain('c0')
  })
})
