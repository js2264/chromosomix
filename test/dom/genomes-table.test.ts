// @vitest-environment jsdom
/**
 * The landing view, and the two spec rules that are structural in it.
 *
 * §5.1: opening a file lands on a sortable MAG table rather than on a heatmap,
 * because that is the operation a metagenomics reader actually performs. What
 * makes the table right is two rules that are easy to state and easy to break
 * silently:
 *
 * - **no column names are hard-coded.** Four columns lead because the format
 *   guarantees them; everything the binner joined in — completeness,
 *   contamination, taxonomy, a genomad score — is discovered from the payload.
 *   A view that had learned the names would show a file's own columns in the
 *   wrong order, or not at all, and look entirely normal doing it.
 * - **`__unbinned__` is absent, with no toggle** (§7.4), and nothing is
 *   renumbered to achieve it — the omitted row keeps its index, so every lookup
 *   past it is by the *file's* row number and an off-by-one here would label
 *   every genome with its neighbour's name.
 *
 * And one thing that is not a rule but is a promise the button makes: what
 * "show selected" says is what pressing it will open.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GenomesTable } from '@/ui/GenomesTable'
import type { GenomesResult } from '@/worker/protocol'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** Row 2 is `__unbinned__`, and it keeps its index by being left out of `display`. */
const NAMES = ['MAG_007', 'MAG_012', '__unbinned__', 'MAG_031']

const DATA: GenomesResult = {
  table: {
    length: NAMES.length,
    // Deliberately out of order and with a column the format does not guarantee.
    columns: ['completeness', 'name', 'n_bins', 'length', 'taxonomy'],
    data: {
      completeness: Float64Array.from([98.6, 71.25, Number.NaN, 40]),
      name: [...NAMES],
      n_bins: Float64Array.from([457, 120, 9, 61]),
      length: Float64Array.from([4_573_673, 1_200_000, 90_000, 610_000]),
      taxonomy: ['Bacteroides', '', 'x', 'Prevotella'],
    },
  },
  display: Int32Array.from([0, 1, 3]),
  density: Float64Array.from([120_000, 30_000, 400, 9_000]),
}

interface Made {
  view: GenomesTable
  opened: string[]
  selections: string[][]
  wholes: number
  regions: string[]
}

function make(): Made {
  const made: Made = {
    view: null as unknown as GenomesTable,
    opened: [],
    selections: [],
    wholes: 0,
    regions: [],
  }
  made.view = new GenomesTable({
    data: DATA,
    onOpenGenome: (name) => made.opened.push(name),
    onOpenSelection: (names) => made.selections.push(names),
    onOpenWhole: () => {
      made.wholes++
    },
    onOpenRegion: (region) => made.regions.push(region),
  })
  document.body.appendChild(made.view.el)
  return made
}

function shownNames(view: GenomesTable): string[] {
  return all<HTMLElement>(view.el, '.tr').map((row) => (row.children[1]?.textContent ?? '').trim())
}

/** The tick in a row, by the genome it belongs to. */
function tick(view: GenomesTable, name: string): void {
  const index = shownNames(view).indexOf(name)
  all<HTMLInputElement>(view.el, '.tcheck')[index].click()
}

describe('the columns', () => {
  it('leads with the ones the format guarantees, in that order', () => {
    const { view } = make()
    // In the app's own words, not the file's identifiers: the four the format
    // guarantees are the four this table knows the names of, and the File card
    // beside it calls the same things `contigs` and `bins`. Everything after
    // them is whatever the creator joined in, rendered under its own name.
    expect(textsOf(view.el, '.th span:first-child').slice(0, 4)).toEqual([
      'name',
      'length',
      'bins',
      'completeness',
    ])
  })

  it('keeps whatever else the file carried, without learning its name', () => {
    const { view } = make()
    expect(textsOf(view.el, '.th span:first-child')).toContain('taxonomy')
  })

  it('ends with the density proxy, labelled as one in the header and its tooltip', () => {
    const { view } = make()
    const heads = all<HTMLElement>(view.el, '.th')
    const last = heads[heads.length - 1]
    // The words §5.1 uses for it, which are the File card's words too: `nnz
    // rows` was the worker's name for a slice of `bin1_offset`.
    expect(last.textContent?.trim()).toBe('non-zero pixels (proxy)')
    expect(last.title).toContain('NOT a contact count')
  })

  it('reads an empty fixed-length string as missing rather than as a value', () => {
    const { view } = make()
    // Otherwise `taxonomy` filters would match blank rows, and a sort would
    // treat padding as a value smaller than every real one.
    const row = all<HTMLElement>(view.el, '.tr')[1]
    expect((row.children[5]?.textContent ?? '').trim()).toBe('')
  })
})

describe('__unbinned__', () => {
  it('is not among the rows, and there is no control to bring it back', () => {
    const { view } = make()
    expect(shownNames(view)).toEqual(['MAG_007', 'MAG_012', 'MAG_031'])
    expect(view.el.textContent).not.toContain('__unbinned__')
  })

  it('does not renumber what follows it', () => {
    const { view, opened } = make()
    all<HTMLElement>(view.el, '.tr')[2].click()
    // The third row on screen is the file's row 3, not its row 2.
    expect(opened).toEqual(['MAG_031'])
  })

  it('leaves the density column reading against the file’s own rows', () => {
    const { view } = make()
    const rows = all<HTMLElement>(view.el, '.tr')
    const density = (row: HTMLElement): string =>
      (row.children[row.children.length - 1]?.textContent ?? '').trim()
    expect([density(rows[0]), density(rows[1]), density(rows[2])]).toEqual([
      '120,000',
      '30,000',
      '9,000',
    ])
  })
})

describe('the selection button', () => {
  it('is spent until something is ticked', () => {
    const { view } = make()
    expect(buttonNamed(view.el, 'show selected →')?.disabled).toBe(true)
    expect(buttonNamed(view.el, 'clear selection')?.disabled).toBe(true)
  })

  it('names both genomes when there are two, because two is the comparison', () => {
    const { view } = make()
    tick(view, 'MAG_007')
    tick(view, 'MAG_031')
    expect(buttonNamed(view.el, 'show MAG_007 × MAG_031 →')).not.toBeNull()
  })

  it('counts them past two, where the names would be longer than the button', () => {
    const { view } = make()
    for (const name of ['MAG_007', 'MAG_012', 'MAG_031']) tick(view, name)
    expect(buttonNamed(view.el, 'show 3 selected →')?.disabled).toBe(false)
  })

  it('opens exactly what it says it will', () => {
    const { view, selections } = make()
    tick(view, 'MAG_012')
    tick(view, 'MAG_031')
    buttonNamed(view.el, 'show MAG_012 × MAG_031 →')?.click()
    expect(selections).toEqual([['MAG_012', 'MAG_031']])
  })

  it('goes back to being spent when the ticks are cleared', () => {
    const { view } = make()
    tick(view, 'MAG_007')
    buttonNamed(view.el, 'clear selection')?.click()
    expect(buttonNamed(view.el, 'show selected →')?.disabled).toBe(true)
    expect(buttonNamed(view.el, 'clear selection')?.disabled).toBe(true)
  })
})

describe('the other doors', () => {
  it('opens a genome by clicking its row', () => {
    const { view, opened } = make()
    all<HTMLElement>(view.el, '.tr')[1].click()
    expect(opened).toEqual(['MAG_012'])
  })

  it('offers the whole file, with the key that reaches it', () => {
    const made = make()
    const button = all<HTMLButtonElement>(made.view.el, '.table-toolbar button').find((node) =>
      (node.textContent ?? '').includes('whole metagenome →'),
    )
    expect(button?.title).toContain('Every genome at once')
    // The badge is part of the button, so the label is not its whole text.
    expect(button?.textContent).toContain('w')
    button?.click()
    expect(made.wholes).toBe(1)
  })

  // 1-based inclusive in, the machine form out (§26.1). This box used to hand
  // the digits to the region reader untouched, which reads them 0-based and
  // half-open — so the same coordinates named one window here and another in
  // the browser's box over the same file.
  it('takes a window without opening the genome around it', () => {
    const { view, regions } = make()
    const box = view.el.querySelector<HTMLInputElement>('.search-input')
    if (box === null) throw new Error('no locus box')
    box.value = 'contig_9:1200000-1210000'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(regions).toEqual(['contig_9:1199999-1210000'])
  })

  it('ignores an empty box rather than opening nothing', () => {
    const { view, regions } = make()
    const box = view.el.querySelector<HTMLInputElement>('.search-input')
    box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(regions).toEqual([])
  })

  it('sends the / key to the locus box and not to the filter', () => {
    const { view } = make()
    view.focusSearch()
    expect((document.activeElement as HTMLElement).classList.contains('search-input')).toBe(true)
  })
})
