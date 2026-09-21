// @vitest-environment jsdom
/**
 * The landing view of a single-cell container (§3.8, §5.1).
 *
 * The genomes table's twin, and it is tested against the same two structural
 * rules — columns discovered rather than named, the button saying what pressing
 * it will do — plus the one thing that is genuinely different and is the whole
 * reason this is a separate view:
 *
 * **a tick adds, it does not arrange.** Ticking genomes lays them out beside
 * each other; ticking cells sums them, because every cell of an scool indexes
 * the same bins. The view has to say so in the button and in the hint, or a
 * reader arrives at a map of four thousand cells believing they are looking at
 * four thousand blocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CellsTable } from '@/ui/CellsTable'
import type { CellsResult } from '@/worker/protocol'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const NAMES = ['cell_a', 'cell_b', 'cell_c', 'cell_d']

const DATA: CellsResult = {
  table: {
    length: NAMES.length,
    // Out of order, and carrying one column cooler does not guarantee — the
    // reader kept `phase` because it *differs* between cells, and dropped the
    // ones that did not (`MetaCooler.cellTable`).
    columns: ['sum', 'name', 'phase', 'nnz'],
    data: {
      sum: Float64Array.from([4147, 2671, 159133, 8960]),
      name: [...NAMES],
      phase: ['G1', 'early-S', '', 'mid-S'],
      nnz: Float64Array.from([2802, 2015, 22690, 4691]),
    },
  },
  selected: Int32Array.from([0, 1, 2, 3]),
}

interface Made {
  view: CellsTable
  shown: string[][]
  alls: number
}

function make(): Made {
  const made: Made = { view: null as unknown as CellsTable, shown: [], alls: 0 }
  made.view = new CellsTable({
    data: DATA,
    onShowCells: (names) => made.shown.push(names),
    onShowAll: () => {
      made.alls++
    },
  })
  document.body.appendChild(made.view.el)
  return made
}

function shownNames(view: CellsTable): string[] {
  return all<HTMLElement>(view.el, '.tr').map((row) => (row.children[1]?.textContent ?? '').trim())
}

function tick(view: CellsTable, name: string): void {
  const index = shownNames(view).indexOf(name)
  all<HTMLInputElement>(view.el, '.tcheck')[index].click()
}

describe('the columns', () => {
  it('leads with name, nnz and sum, whatever order the payload was in', () => {
    const { view } = make()
    expect(textsOf(view.el, '.th span:first-child').slice(0, 3)).toEqual(['name', 'nnz', 'contacts'])
  })

  it('keeps a per-cell column the writer added, without learning its name', () => {
    const { view } = make()
    expect(textsOf(view.el, '.th span:first-child')).toContain('phase')
  })

  it('labels the depth columns as read from attributes, not from pixels', () => {
    const { view } = make()
    const heads = all<HTMLElement>(view.el, '.th')
    const nnz = heads.find((head) => head.textContent?.trim() === 'nnz')
    expect(nnz?.title).toContain('no pixel is read')
  })
})

describe('the heading says what the file holds', () => {
  // The count is the toolbar's, once. It used to be in the heading as well, a
  // few lines above the row count, and neither of the two landing tables beside
  // this one carries one — the three are near twins and should read like it.
  it('names itself without repeating the row count', () => {
    const { view } = make()
    expect(view.el.querySelector('h2')?.textContent).toBe('Cells')
    expect(view.el.querySelector('.table-status')?.textContent).toBe('4 rows')
  })

  it('says that ticks are summed, in words', () => {
    const { view } = make()
    const hint = view.el.querySelector('.hint')?.textContent ?? ''
    expect(hint).toContain('added together')
    expect(hint).toContain('same bins')
  })
})

describe('what the button says is what it does', () => {
  it('names the one cell when one is ticked, and opens exactly it', () => {
    const made = make()
    tick(made.view, 'cell_c')
    const show = buttonNamed(made.view.el, 'show cell_c →')
    expect(show).not.toBeNull()
    show?.click()
    expect(made.shown).toEqual([['cell_c']])
  })

  it('counts them when several are, and says sum rather than show', () => {
    const made = make()
    tick(made.view, 'cell_a')
    tick(made.view, 'cell_b')
    const show = buttonNamed(made.view.el, 'sum 2 cells →')
    expect(show).not.toBeNull()
    show?.click()
    expect(made.shown).toEqual([['cell_a', 'cell_b']])
  })

  it('is disabled with nothing ticked, so it never means the whole file by accident', () => {
    const { view } = make()
    expect(buttonNamed(view.el, 'sum selected →')?.disabled).toBe(true)
  })

  it('warns on its tooltip once the set is large enough to be a wait', () => {
    const made = make()
    tick(made.view, 'cell_a')
    expect(buttonNamed(made.view.el, 'show cell_a →')?.title).toContain('Add the ticked cells')
  })
})

describe('the whole file', () => {
  it('is its own button, and names the count it will sum', () => {
    const made = make()
    // By its label span, not its whole text: it is a keyed button, so the key
    // badge is inside it and `textContent` carries the letter too.
    const all4 = all<HTMLButtonElement>(made.view.el, 'button').find(
      (node) => node.querySelector('span')?.textContent === 'sum all 4 →',
    )
    expect(all4).toBeDefined()
    all4?.click()
    expect(made.alls).toBe(1)
    // …and it is not the same call as ticking everything: `null` is what tells
    // the state to write the sentinel rather than four thousand names.
    expect(made.shown).toEqual([])
  })
})

describe('a click on a row', () => {
  it('opens that cell alone — the per-cell view', () => {
    const made = make()
    all<HTMLElement>(made.view.el, '.tr')[2].click()
    expect(made.shown).toEqual([['cell_c']])
  })
})

describe('the name box', () => {
  it('takes a prefix and sums every cell under it', () => {
    const made = make()
    const box = made.view.el.querySelector<HTMLInputElement>('.search-box input')
    expect(box).not.toBeNull()
    if (box === null) return
    box.value = 'cell_'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(made.shown).toEqual([NAMES])
  })
})
