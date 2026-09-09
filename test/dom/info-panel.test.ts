// @vitest-environment jsdom
/**
 * What the General column says about the file.
 *
 * Two of these rules are §7.4's, and both are the kind that decay silently.
 *
 * **The unassigned statistic is a number, not a view.** It is the sole place
 * `__unbinned__` is visible at all, it opens nothing and selects nothing, and the
 * panel receives four integers rather than an index — so no code path can reach
 * the reserved genome through it. A regression here does not throw; it grows a
 * link.
 *
 * **A cooler is not a badly-binned metacool.** It was never binned, so there is
 * no binning to report on: a row reading `genomes 0` invites the question of
 * where they went, and "every contig was assigned to a bin" said about a file
 * with no bins is a false statement rather than a reassuring one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InfoPanel } from '@/ui/InfoPanel'
import type { OpenResult } from '@/worker/protocol'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

function openResult(over: Partial<OpenResult> = {}): OpenResult {
  return {
    uri: 'sample.metacool',
    layout: { kind: 'metacool', group: '/' },
    info: {
      format: 'HDF5::Cooler',
      'format-url': null,
      'format-version': 3,
      'bin-size': 1000,
      'bin-type': 'fixed',
      ordering: 'genome-then-length',
      assembly: 'basic_assembly',
      'storage-mode': 'symmetric-upper',
      nbins: 661,
      nnz: 21_633,
      sum: 50_000,
      ngenomes: 11,
      ncontigs: 44,
    },
    metadata: {},
    binsize: 1000,
    shape: [661, 661],
    nGenomes: 11,
    nContigs: 44,
    nBins: 661,
    unassigned: null,
    displayExtent: [0, 661],
    entries: [],
    entryGroup: 'entries',
    cells: [],
    activeCells: [],
    cellNnz: null,
    hasGenomes: true,
    hasWeights: true,
    scoreColumns: ['count'],
    sourceBytes: 1_234_567,
    sourceKind: 'local',
    ...over,
  }
}

function panel(info: OpenResult, onCloseFile?: (which: 1 | 2) => void): InfoPanel {
  const view = new InfoPanel({ info, ...(onCloseFile === undefined ? {} : { onCloseFile }) })
  document.body.appendChild(view.el)
  return view
}

/** The file card as `key → value`, which is how a reader reads it. */
function table(view: InfoPanel, card = 0): Record<string, string> {
  const kv = all(view.el, '.file-host .kv')[card]
  const keys = textsOf(kv, '.k')
  const values = textsOf(kv, '.v')
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
}

describe('the file card', () => {
  it('prints what the file says about itself', () => {
    const view = panel(openResult())
    const rows = table(view)
    expect(rows['uri']).toBe('sample.metacool')
    expect(rows['layout']).toBe('metacool')
    expect(rows['bin size']).toBe('1,000 bp')
    expect(rows['ordering']).toBe('genome-then-length')
    expect(rows['storage mode']).toBe('symmetric-upper')
    expect(rows['format']).toBe('HDF5::Cooler v3')
    expect(rows['non-zero pixels']).toBe('21,633')
    expect(rows['sum']).toBe('50,000')
    expect(rows['source']).toBe('local file (1.2 MB)')
  })

  it('says a dash where the file says nothing, rather than “null”', () => {
    const view = panel(
      openResult({
        binsize: null,
        info: { ...openResult().info, 'bin-type': null, assembly: null, nnz: null, sum: null },
      }),
    )
    const rows = table(view)
    expect(rows['bin size']).toBe('—')
    expect(rows['bin type']).toBe('—')
    expect(rows['assembly']).toBe('—')
    expect(rows['non-zero pixels']).toBe('—')
    expect(rows['sum']).toBe('—')
  })

  it('calls a cooler’s sequences chromosomes, and does not count genomes it has none of', () => {
    const view = panel(openResult({ hasGenomes: false, nGenomes: 1, layout: { kind: 'cool', group: '/' } }))
    const rows = table(view)
    expect(rows['genomes']).toBeUndefined()
    expect(rows['chromosomes']).toBe('44')
    expect(rows['contigs']).toBeUndefined()
  })

  it('numbers the two file cards, and marks which triangle each is', () => {
    const view = panel(openResult(), () => {})
    view.setCompare(openResult({ uri: 'other.cool' }))
    expect(textsOf(view.el, '.file-host .file-name')).toEqual(['File 1', 'File 2'])
    const marks = all(view.el, '.compare-mark')
    expect(marks[0].classList.contains('compare-upper')).toBe(true)
    expect(marks[1].classList.contains('compare-lower')).toBe(true)
    expect(table(view, 1)['uri']).toBe('other.cool')
  })

  it('offers a way out of the comparison from where it is described', () => {
    const closed: Array<1 | 2> = []
    const view = panel(openResult(), (which) => closed.push(which))
    view.setCompare(openResult({ uri: 'other.cool' }))
    const buttons = all<HTMLButtonElement>(view.el, '.file-host .btn-close')
    expect(buttons).toHaveLength(2)
    buttons[1].click()
    expect(closed).toEqual([2])

    // …and the button is gone once there is only one file again.
    view.setCompare(null)
    expect(all(view.el, '.file-host .btn-close')).toHaveLength(0)
    expect(textsOf(view.el, '.file-host .file-name')).toEqual(['File'])
  })
})

describe('the binning QC statistic', () => {
  it('is one number, and is not a door', () => {
    const view = panel(
      openResult({
        unassigned: {
          genomeIndex: 0,
          contigs: 1204,
          bins: 830,
          totalContigs: 4000,
          totalBins: 10_000,
          contigFraction: 0.301,
          binFraction: 0.083,
        },
      }),
    )
    expect(view.el.querySelector('.qc-stat')?.textContent).toBe(
      'unassigned: 1,204 contigs / 8.3% of bins',
    )
    // §7.4: it opens nothing and selects nothing.
    expect(all(view.el, '.qc button')).toHaveLength(0)
    expect(all(view.el, '.qc a')).toHaveLength(0)
    expect(all(view.el, '.qc input')).toHaveLength(0)
  })

  it('says so when there is no __unbinned__ genome at all', () => {
    const view = panel(openResult({ unassigned: null }))
    const qc = view.el.querySelector('.qc')
    expect(qc?.classList.contains('qc-clean')).toBe(true)
    expect(qc?.textContent).toContain('every contig was assigned to a bin')
  })

  it('reports nothing at all about a file that was never binned', () => {
    // Saying "every contig was assigned to a bin" about a cooler is a false
    // statement, not a reassuring one.
    const view = panel(openResult({ hasGenomes: false, unassigned: null }))
    expect(all(view.el, '.qc')).toHaveLength(0)
  })

  it('divides by nothing rather than printing NaN%', () => {
    const view = panel(
      openResult({
        unassigned: {
          genomeIndex: 0,
          contigs: 0,
          bins: 0,
          totalContigs: 0,
          totalBins: 0,
          contigFraction: 0,
          binFraction: 0,
        },
      }),
    )
    expect(view.el.querySelector('.qc-stat')?.textContent).toBe('unassigned: 0 contigs / 0.0% of bins')
  })
})

describe('the stored metadata', () => {
  it('is folded away, and is the file’s own JSON', () => {
    const view = panel(openResult({ metadata: { study: 'Hum53', replicate: 1 } }))
    const details = view.el.querySelector('details.meta')
    expect(details?.querySelector('summary')?.textContent).toBe('Metadata')
    expect(JSON.parse(details?.querySelector('pre')?.textContent ?? '{}')).toEqual({
      study: 'Hum53',
      replicate: 1,
    })
  })

  it('says there is none rather than showing an empty box', () => {
    const view = panel(openResult({ metadata: {} }))
    expect(all(view.el, 'details.meta')).toHaveLength(0)
    expect(view.el.querySelector('.meta-empty')?.textContent).toContain('No metadata was stored')
  })
})

describe('the two hosts the shell fills', () => {
  it('takes the record card down when the view has no record', () => {
    const view = panel(openResult())
    view.setRecords([
      { heading: 'Genome', icon: 'dna', name: 'MAG_01', fields: [{ key: 'length', value: '4,000' }] },
    ])
    expect(all(view.el, '.record-host .card')).toHaveLength(1)
    expect(view.el.querySelector('.record-name')?.textContent).toBe('MAG_01')
    // A genome card left standing over the genomes table would describe a heatmap
    // that is no longer there.
    view.setRecords([])
    expect(all(view.el, '.record-host .card')).toHaveLength(0)
  })

  it('holds the Sequences card the session built, rather than building one', () => {
    const view = panel(openResult())
    const card = document.createElement('div')
    card.className = 'card sequence-card'
    view.setSequences(card)
    expect(view.el.querySelector('.sequence-host .sequence-card')).toBe(card)
    view.setSequences(null)
    expect(view.el.querySelector('.sequence-host')?.childElementCount).toBe(0)
  })
})
