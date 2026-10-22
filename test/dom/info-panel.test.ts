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
 * link. It is also the only place it is *counted*: the File card's `genomes` row
 * leaves it out, because the genomes table beside that card does.
 *
 * **A cooler is not a badly-binned metacool.** It was never binned, so there is
 * no binning to report on: a row reading `genomes 0` invites the question of
 * where they went, and "every contig was assigned to a bin" said about a file
 * with no bins is a false statement rather than a reassuring one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDevFeatures } from '@/state/devFeatures'

import { distEdges, type PairStats } from '@/pairs/stats'
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
    contacts: null,
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
  // The card below is a metacool's, which a page shows only with the dev
  // features switch on (§29); the case after it is the same card with it off.
  beforeEach(() => resetDevFeatures(true))
  afterEach(() => resetDevFeatures())

  it('leaves out the ordering, the multi-genome format\'s word, while that format is off (§29)', () => {
    resetDevFeatures(false)
    const rows = table(panel(openResult()))
    expect(rows['ordering']).toBeUndefined()
    expect(rows['bin size']).toBe('1 kb')
  })

  it('prints what the file says about itself', () => {
    const view = panel(openResult())
    const rows = table(view)
    expect(rows['uri']).toBe('sample.metacool')
    expect(rows['layout']).toBe('metacool')
    // The bin size as the crumb above it spells it. The card used to print the
    // file's raw attribute, `1,000 bp`, which made one number read as three
    // settings across one screen — `1 kb` in the crumb, `1.0 kb` in the map's
    // title, `1,000 bp` here (§26.2).
    expect(rows['bin size']).toBe('1 kb')
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

  it('names the normalisation a .hic’s balanced map is drawn with (§3.6)', () => {
    // The reader chooses the file's best vector by name — SCALE, then KR, then
    // the coverage ones — and it was chosen silently.
    const hic = (normalisation?: string): OpenResult =>
      openResult({
        uri: 'map.hic',
        hasGenomes: false,
        layout: { kind: 'cool', group: '/' },
        info: {
          ...openResult().info,
          format: 'HIC',
          'format-version': 9,
          ...(normalisation === undefined ? {} : { 'hic-normalisation': normalisation }),
        },
      })
    expect(table(panel(hic('SCALE')))['normalisation']).toBe('SCALE')
    // A rung with no vector at all says so: *balanced* is not on offer there.
    expect(table(panel(hic()))['normalisation']).toBe('none at this resolution')
    // A cooler's weights are its own column, not a choice among vectors, and it
    // gets no row.
    expect(table(panel(openResult()))['normalisation']).toBeUndefined()
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

/**
 * The File card is the starred map's (§16.5). A deck is several files, and a
 * card headed *File* that went on describing the first after the star had moved
 * was a card about a map the reader had said they were not looking at.
 */
describe('the file card in a deck', () => {
  it('describes the starred map’s file, and names that map with its star', () => {
    const view = panel(openResult({ uri: 'micro-c.cool' }))
    view.setShown({ kind: 'other', name: 'Hi-C (hic)', info: openResult({ uri: 'hic.hic', binsize: 5000 }) })
    expect(table(view)['uri']).toBe('hic.hic')
    expect(table(view)['bin size']).toBe('5 kb')
    const line = view.el.querySelector('.file-host .file-card-for')
    expect(line?.textContent).toBe('Hi-C (hic)')
    expect(line?.querySelector('.map-card-star')?.classList.contains('is-on')).toBe(true)
  })

  it('goes back to the session’s own file when the star does', () => {
    const view = panel(openResult({ uri: 'micro-c.cool' }))
    view.setShown({ kind: 'other', name: 'Hi-C (hic)', info: openResult({ uri: 'hic.hic' }) })
    view.setShown({ kind: 'own', name: 'micro-C (cool)', starred: true })
    expect(table(view)['uri']).toBe('micro-c.cool')
    expect(view.el.querySelector('.file-card-for')?.textContent).toBe('micro-C (cool)')
    // With no star at all it is still the session's file, and the line says so
    // without a lit star.
    view.setShown({ kind: 'own', name: 'micro-C (cool)', starred: false })
    expect(view.el.querySelector('.file-card-for .map-card-star')?.classList.contains('is-on')).toBe(false)
  })

  it('says so while the starred map’s file has not opened yet, rather than showing another', () => {
    const view = panel(openResult({ uri: 'micro-c.cool' }))
    view.setShown({ kind: 'other', name: 'Hi-C (hic)', info: null })
    // No table at all: the first map's facts under the starred map's name
    // would be the one wrong answer.
    expect(all(view.el, '.file-host .kv')).toHaveLength(0)
    expect(view.el.querySelector('.file-host .clip-note')?.textContent).toContain('once it has opened')
  })

  it('names nothing with no deck, where one map needs no name', () => {
    const view = panel(openResult())
    view.setShown(null)
    expect(view.el.querySelector('.file-card-for')).toBeNull()
  })

  it('keeps the first map’s two triangles off the card while a companion is starred', () => {
    const view = panel(openResult({ uri: 'micro-c.cool' }), () => {})
    view.setCompare(openResult({ uri: 'other.cool' }))
    view.setShown({ kind: 'other', name: 'Hi-C (hic)', info: openResult({ uri: 'hic.hic' }) })
    expect(textsOf(view.el, '.file-host .file-name')).toEqual(['File'])
    view.setShown({ kind: 'own', name: 'micro-C (cool)', starred: true })
    expect(textsOf(view.el, '.file-host .file-name')).toEqual(['File 1', 'File 2'])
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
    // Each quantity whole — a count and its own share — where the line used to
    // pair a count of contigs with a percentage of *bins* and leave the other
    // half of each to a paragraph under it (§7.4).
    expect(view.el.querySelector('.qc-stat')?.textContent).toBe(
      'unassigned: 1,204 contigs (30.1%) · 830 bins (8.3%)',
    )
    // §7.4: it opens nothing and selects nothing. The card's own fold chevron is
    // not a door — it is the one control every heading in every column carries,
    // and it reaches nothing but this card's own body.
    const doors = all(view.el, '.qc button, .qc a, .qc input').filter(
      (node) => node.closest('.card-head') === null,
    )
    expect(doors).toHaveLength(0)
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
    expect(view.el.querySelector('.qc-stat')?.textContent).toBe(
      'unassigned: 0 contigs (0.0%) · 0 bins (0.0%)',
    )
  })
})

/**
 * The stored metadata, and the shape it is drawn in.
 *
 * It had two: an uppercase iconed heading with a hint under it when the file
 * stored nothing, a plain `▶ Metadata` disclosure when it stored something — so
 * the absence was announced more loudly than the presence, and a reader moving
 * between a cooler and a metacool watched one strip of this column change its
 * typography rather than fill and empty. It is a card in both states now, like
 * every other block in the column (§26.6), and folded when there is JSON in it.
 */
describe('the stored metadata', () => {
  it('is a card, folded away, holding the file’s own JSON', () => {
    const view = panel(openResult({ metadata: { study: 'Hum53', replicate: 1 } }))
    const card = cardNamed(view, 'Metadata')
    expect(card?.classList.contains('is-folded')).toBe(true)
    expect(card?.querySelector('.card-fold')?.getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(card?.querySelector('pre')?.textContent ?? '{}')).toEqual({
      study: 'Hum53',
      replicate: 1,
    })
  })

  it('says there is none rather than showing an empty box, in the same card', () => {
    const view = panel(openResult({ metadata: {} }))
    const card = cardNamed(view, 'Metadata')
    expect(card?.classList.contains('is-folded')).toBe(false)
    expect(all(view.el, 'details.meta')).toHaveLength(0)
    expect(card?.textContent).toContain('No metadata was stored')
  })
})

/** The card whose heading reads `name`, whatever else the column is holding. */
function cardNamed(view: InfoPanel, name: string): HTMLElement | null {
  for (const head of all(view.el, '.card > .card-head')) {
    if (head.textContent?.trim().startsWith(name) === true) return head.parentElement
  }
  return null
}

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

describe('the pairs statistics (§3.7)', () => {
  /** A small library's counts, as `pairs/stats.ts` hands them over. */
  function counted(over: Partial<PairStats> = {}): PairStats {
    const edges = distEdges()
    const zeros = (): number[] => edges.map(() => 0)
    const distFreq = { '+-': zeros(), '-+': zeros(), '--': zeros(), '++': zeros() }
    distFreq['+-'][10] = 40
    distFreq['-+'][10] = 40
    distFreq['--'][10] = 40
    distFreq['++'][10] = 40
    return {
      total: 1000,
      totalUnmapped: 50,
      totalSingleSidedMapped: 50,
      totalMapped: 900,
      totalDups: 90,
      totalNodups: 810,
      cis: 720,
      trans: 90,
      pairTypes: [
        ['UU', 810],
        ['DD', 90],
        ['NN', 50],
        ['NU', 50],
      ],
      cisAtLeast: [
        [1, 360],
        [2, 300],
        [4, 240],
        [10, 160],
        [20, 80],
        [40, 40],
      ],
      chromFreq: [['chrI', 'chrI', 720]],
      distEdges: edges,
      distFreq,
      chromsizes: [['chrI', 230_218]],
      pairTypeColumn: true,
      scoped: false,
      ...over,
    }
  }

  function pairsResult(stats: PairStats | null): OpenResult {
    return openResult({
      uri: 'https://example.org/HCT116.pairs.gz',
      layout: { kind: 'cool', group: '/' },
      hasGenomes: false,
      pairs: {
        base: 1000,
        rungs: [1000],
        records: 900,
        nnz: 400,
        indexed: false,
        skippedUnknownContig: 0,
        skippedBadPosition: 0,
        clampedPosition: 0,
        requiredMerge: false,
        truncated: false,
        sequencesWithoutCisContacts: [],
        download: false,
        orientation: null,
        stats,
        binning: { base: 1000, rungs: 1 },
      },
    })
  }

  function rowsOf(view: InfoPanel): Record<string, string> {
    const kv = view.el.querySelector('.pairs-stats .kv') as HTMLElement
    const keys = textsOf(kv, '.k')
    const values = textsOf(kv, '.v')
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
  }

  it('is not there for a map that was not imported from a .pairs', () => {
    expect(panel(openResult()).el.querySelector('.pairs-stats')).toBeNull()
  })

  it('says what pairtools would, each share over pairtools’ own denominator', () => {
    const rows = rowsOf(panel(pairsResult(counted())))
    expect(rows['records']).toBe('1,000')
    expect(rows['mapped']).toBe('900 · 90.0%')
    expect(rows['duplicates']).toBe('90 · 10.0%')
    expect(rows['cis']).toBe('720 · 88.9%')
    expect(rows['cis ≥ 10 kb']).toBe('19.8%')
    expect(rows['library size']).toMatch(/molecules$/)
    // The four orientations agree everywhere in this library.
    expect(rows['strands meet']).toBe('everywhere')
  })

  it('lists every pair type, one chip a type', () => {
    const view = panel(pairsResult(counted()))
    expect(textsOf(view.el, '.pairs-stats-type')).toEqual(['UU 810', 'DD 90', 'NN 50', 'NU 50'])
  })

  it('says when no record could be counted as a duplicate, and estimates no library', () => {
    const view = panel(pairsResult(counted({ pairTypeColumn: false, pairTypes: [], totalDups: 0, totalNodups: 900 })))
    expect(rowsOf(view)['duplicates']).toBe('not marked')
    expect(rowsOf(view)['library size']).toBe('not estimated')
    expect(view.el.querySelector('.pairs-stats')?.textContent).toContain('no pair_type column')
  })

  it('says when an index scoped the import to part of the file', () => {
    const view = panel(pairsResult(counted({ scoped: true })))
    expect(view.el.querySelector('.pairs-stats')?.textContent).toContain('not the whole file')
  })

  it('saves the counts as pairtools writes them, under pairtools’ name', async () => {
    const written: Array<{ name: string; text: string }> = []
    ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options: { suggestedName: string }) => ({
      name: options.suggestedName,
      createWritable: async () => {
        const parts: Blob[] = []
        return {
          write: async (blob: Blob) => {
            parts.push(blob)
          },
          close: async () => {
            written.push({ name: options.suggestedName, text: await new Blob(parts).text() })
          },
        }
      },
    })
    try {
      const view = panel(pairsResult(counted()))
      ;(view.el.querySelector('.pairs-stats-save') as HTMLButtonElement).click()
      await new Promise((settled) => setTimeout(settled, 0))
      await new Promise((settled) => setTimeout(settled, 0))
      expect(written.map((file) => file.name)).toEqual(['HCT116.stats'])
      expect(written[0].text.split('\n').slice(0, 3)).toEqual(['total\t1000', 'total_unmapped\t50', 'total_single_sided_mapped\t50'])
      expect(written[0].text).toContain('pair_types/DD\t90')
      expect(written[0].text).toContain('chromsizes/chrI\t230218')
    } finally {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
    }
  })
})
