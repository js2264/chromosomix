// @vitest-environment jsdom
// @dev-feature curate metacool
/**
 * What the views say of a map drawn through a curation (SPECS §33.4).
 *
 * The genomes table: the curation's own columns — `kind`, `curation`, and
 * metaTOR's columns of the mobile elements — and the ones it recomputed say
 * so, and the file's other columns say they are empty for a genome the
 * curation changed. The contigs table names each contig's genome. The File
 * card counts the MAGs and the elements apart and says how many steps the
 * curation has, in a value short enough to read whole, and the Binning QC card
 * sets the file's pool beside the curated one where the two differ, each
 * quantity whole across a wrap. The heading's word on the genomes says
 * how many steps the session is drawn through, opens the stage, and puts the
 * file's binning back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CurationChip } from '@/curate/CurationChip'
import { resetDevFeatures } from '@/state/devFeatures'
import { ContigsTable } from '@/ui/ContigsTable'
import { GenomesTable } from '@/ui/GenomesTable'
import { InfoPanel, countKinds } from '@/ui/InfoPanel'
import type { GenomesResult, OpenResult } from '@/worker/protocol'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  resetDevFeatures(true)
})

afterEach(() => {
  resetDevFeatures()
  teardown()
})

const CURATED: GenomesResult = {
  table: {
    length: 4,
    columns: ['name', 'length', 'n_contigs', 'n_bins', 'kind', 'curation', 'Completeness', 'taxonomy', 'mge'],
    data: {
      name: ['__unbinned__', 'Kleb', 'MAG_2', 'MGE_1'],
      length: Float64Array.from([500, 11_000, 6_000, 800]),
      n_contigs: Float64Array.from([1, 3, 2, 1]),
      n_bins: Float64Array.from([1, 11, 6, 1]),
      kind: ['', 'MAG', 'MAG', 'element'],
      curation: ['as in the file', 'changed', 'as in the file', 'new'],
      Completeness: Float64Array.from([Number.NaN, 0.9, 0.5, Number.NaN]),
      taxonomy: ['', '', 'Yersinia', ''],
      mge: ['', 'False', 'False', 'True'],
    },
  },
  display: Int32Array.from([1, 2, 3]),
  density: Float64Array.from([1, 2, 3, 4]),
  curation: { steps: 3, owned: ['kind', 'curation', 'mge'], recomputed: ['Completeness'] },
}

describe('the genomes table under a curation', () => {
  it('titles the curation’s columns and the recomputed ones as such, and the file’s as left empty where it changed', () => {
    const view = new GenomesTable({ data: CURATED, onOpenGenome: () => undefined, onOpenSelection: () => undefined, onOpenWhole: () => undefined, onOpenRegion: () => undefined })
    document.body.appendChild(view.el)
    const heads = all<HTMLElement>(view.el, '.th')
    const title = (label: string): string => heads.find((head) => head.querySelector('span')?.textContent === label)?.title ?? ''
    expect(textsOf(view.el, '.th span:first-child').slice(0, 6)).toEqual(['name', 'length', 'contigs', 'bins', 'kind', 'curation'])
    expect(title('kind')).toContain('a MAG, or a mobile element')
    expect(title('curation')).toContain('as in the file')
    expect(title('mge')).toContain('written again from the curated genomes’ kinds and host links')
    expect(title('Completeness')).toContain('recomputed for the curated genome')
    expect(title('taxonomy')).toContain('empty for a genome the curation changed')
    // The rule before the file's own columns falls after the curation's.
    const joined = heads.filter((head) => head.classList.contains('is-joined'))
    expect(joined.map((head) => head.querySelector('span')?.textContent)).toEqual(['taxonomy'])
  })
})

describe('the contigs table of a metagenome', () => {
  it('names each contig’s genome rather than its row of /genomes', () => {
    const view = new ContigsTable({
      data: {
        table: {
          length: 3,
          columns: ['name', 'length', 'genome_id'],
          data: { name: ['c1', 'c2', 'c3'], length: Float64Array.from([10, 20, 30]), genome_id: Float64Array.from([1, 3, 0]) },
        },
      },
      genomeNames: CURATED.table.data['name'] as string[],
      onOpenContig: () => undefined,
    })
    document.body.appendChild(view.el)
    expect(textsOf(view.el, '.th span:first-child')).toContain('genome')
    expect(textsOf(view.el, '.th span:first-child')).not.toContain('genome_id')
    const cells = all<HTMLElement>(view.el, '.tr').map((row) => [...row.children].map((cell) => (cell.textContent ?? '').trim()))
    expect(cells.map((row) => row.slice(-1)[0])).toEqual(['Kleb', 'MGE_1', '__unbinned__'])
  })
})

function openResult(over: Partial<OpenResult> = {}): OpenResult {
  return {
    uri: 'mock.metacool',
    layout: { kind: 'metacool', group: '/' },
    info: { format: 'HDF5::Cooler', 'format-url': null, 'format-version': 3, 'bin-size': 1000, 'bin-type': 'fixed', ordering: 'genome-then-length', assembly: 'mock', 'storage-mode': 'symmetric-upper', nbins: 100, nnz: 1000, sum: 5000, ngenomes: 4, ncontigs: 7 },
    metadata: {},
    binsize: 1000,
    shape: [100, 100],
    nGenomes: 4,
    nContigs: 7,
    nBins: 100,
    unassigned: { genomeIndex: 0, contigs: 1, bins: 1, totalContigs: 7, totalBins: 100, contigFraction: 1 / 7, binFraction: 0.01 },
    displayExtent: [1, 100],
    entries: [],
    entryGroup: '',
    cells: [],
    activeCells: [],
    cellNnz: null,
    hasGenomes: true,
    hasWeights: false,
    scoreColumns: ['count'],
    sourceBytes: 1000,
    contacts: null,
    sourceKind: 'local',
    ...over,
  }
}

function fileCard(view: InfoPanel): Record<string, string> {
  const kv = all(view.el, '.file-host .kv')[0]
  const keys = textsOf(kv, '.k')
  const values = textsOf(kv, '.v')
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]))
}

describe('the File and Binning QC cards under a curation', () => {
  const curation = {
    refusal: null,
    steps: 3,
    key: '4:abc',
    file: { genomes: 3, unassigned: { genomeIndex: 0, contigs: 2, bins: 5, totalContigs: 7, totalBins: 100, contigFraction: 2 / 7, binFraction: 0.05 } },
  }

  it('counts the MAGs and the elements apart, and says how many steps the curation has', () => {
    expect(countKinds(CURATED.table)).toEqual({ mags: 2, elements: 1 })
    const view = new InfoPanel({ info: openResult({ curation }), genomeKinds: countKinds(CURATED.table) })
    document.body.appendChild(view.el)
    const rows = fileCard(view)
    expect(rows['MAGs']).toBe('2')
    expect(rows['elements']).toBe('1')
    expect(rows['genomes']).toBeUndefined()
    // Keyed `curation` and valued by its steps alone: the card keeps a row to one
    // line, and `binning curated · 17 steps` lost its `s` at the column's width.
    expect(rows['curation']).toBe('3 steps')
    expect(rows['binning']).toBeUndefined()
    // What the steps are of, under the pointer, since the value alone does not say.
    const kv = all(view.el, '.file-host .kv')[0]
    const at = textsOf(kv, '.k').indexOf('curation')
    expect(all(kv, '.v')[at].title).toBe('The genomes are drawn through a curation of 3 steps made on the file’s binning.')
    // Every other row's title is its value, as it was.
    expect(all(kv, '.v')[textsOf(kv, '.k').indexOf('MAGs')].title).toBe('2')
    const one = fileCard(new InfoPanel({ info: openResult({ curation: { ...curation, steps: 1 } }) }))
    expect(one['curation']).toBe('1 step')
    const many = fileCard(new InfoPanel({ info: openResult({ curation: { ...curation, steps: 1234 } }) }))
    expect(many['curation']).toBe('1,234 steps')
    // A map drawn as the file has it has no such row.
    expect(fileCard(new InfoPanel({ info: openResult() }))['curation']).toBeUndefined()
  })

  it('sets the file’s pool beside the curated one where they differ, and says nothing of it where they agree', () => {
    const view = new InfoPanel({ info: openResult({ curation }) })
    document.body.appendChild(view.el)
    expect(textsOf(view.el, '.qc .qc-stat').map((line) => line.replaceAll('\u00a0', ' '))).toEqual([
      'unassigned, curated: 1 contig (14.3%) · 1 bin (1.0%)',
      'in the file: 2 contigs (28.6%) · 5 bins (5.0%)',
    ])
    // Each quantity one unbreakable run, so a wrap never parts a count from its noun.
    expect(textsOf(view.el, '.qc .qc-stat')[1].split(' ')).toEqual(['in', 'the', 'file:', '2\u00a0contigs\u00a0(28.6%)', '·', '5\u00a0bins\u00a0(5.0%)'])
    const same = new InfoPanel({ info: openResult({ curation: { ...curation, file: { genomes: 3, unassigned: openResult().unassigned } } }) })
    expect(textsOf(same.el, '.qc .qc-stat')).toHaveLength(1)
    // A curation that leaves nothing in the pool says so of itself, not of the file.
    const clean = new InfoPanel({ info: openResult({ unassigned: null, curation }) })
    expect(clean.el.querySelector('.qc')?.textContent).toContain('The curated binning assigns every contig to a genome.')
  })

  it('reads metaTOR’s mge column where no curation says which is which, and nothing where neither does', () => {
    const mge = { columns: ['name', 'mge'], data: { name: ['__unbinned__', 'A', 'E'], mge: ['', 'False', 'True'] } }
    expect(countKinds(mge)).toEqual({ mags: 1, elements: 1 })
    expect(countKinds({ columns: ['name'], data: { name: ['A'] } })).toBeNull()
  })
})

describe('the heading’s word on the genomes (§33.4)', () => {
  it('says as in the file, or curated and by how many steps, lit while curated, and opens the stage or puts the file back', () => {
    let steps = 0
    const pressed: string[] = []
    const chip = new CurationChip({ steps: () => steps, onOpen: () => pressed.push('open'), onRevert: () => pressed.push('revert') })
    document.body.appendChild(chip.el)
    const button = chip.el.querySelector('.crumb-genomes-button') as HTMLButtonElement
    const revert = chip.el.querySelector('.crumb-genomes-revert') as HTMLButtonElement
    expect(chip.el.textContent).toBe('genomesas in the file')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(revert.classList.contains('hidden')).toBe(true)
    steps = 1
    chip.sync()
    expect(button.textContent).toBe('curated · 1 step')
    steps = 7
    chip.sync()
    expect(button.textContent).toBe('curated · 7 steps')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(revert.classList.contains('hidden')).toBe(false)
    button.click()
    revert.click()
    expect(pressed).toEqual(['open', 'revert'])
  })
})
