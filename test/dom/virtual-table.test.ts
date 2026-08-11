// @vitest-environment jsdom
/**
 * The table both tables are.
 *
 * `VirtualTable` is under the genomes list and the contigs list, which between
 * them are where a reader of a metagenome spends most of their time, and until
 * now every one of its behaviours was asserted by reading it: that a filter box
 * narrows the rows, that a sort click cycles up → down → off, that the header
 * checkbox speaks for *what the filters left* rather than for the file, that
 * `clear filters` does not quietly clear a selection, that only the rows in view
 * exist as elements.
 *
 * Those are all statements about a DOM, and none of them is a statement about
 * arithmetic — which is exactly the half of this application `test/support/dom.ts`
 * exists to reach. Each one below is also a thing that has a wrong version which
 * looks right: a header box that ticks the whole file, a `clear filters` that
 * empties the ticks, a sort that never turns off.
 *
 * The debounces are real rather than faked. They are 120 ms and 150 ms, the
 * timers are what the boxes actually run on, and a test that replaced them would
 * be asserting about a table nobody uses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VirtualTable, numberFilter, stringFilter, type ColumnDef } from '@/ui/VirtualTable'
import { all, buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** Past both debounces (120 ms and 150 ms) with room to spare. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 220))
}

const NAMES = ['bin.1', 'bin.2', 'bin.10', 'unbinned', 'bin.3']
const LENGTHS = [1000, 25_000, 300, 40, 7000]
const DENSITY = [0.5, 0.002, 0.000_012, Number.NaN, 0.25]

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'name', kind: 'string', value: (row) => NAMES[row] },
  { key: 'length', label: 'length', kind: 'number', align: 'right', value: (row) => LENGTHS[row] },
  {
    key: 'density',
    label: 'density',
    kind: 'number',
    align: 'right',
    title: 'not a contact count',
    value: (row) => (Number.isNaN(DENSITY[row]) ? undefined : DENSITY[row]),
  },
]

interface Made {
  table: VirtualTable
  opened: number[]
  selected: number[][]
}

function make(options: Partial<Parameters<typeof buildOptions>[0]> = {}): Made {
  const opened: number[] = []
  const selected: number[][] = []
  const table = new VirtualTable(buildOptions({ opened, selected, ...options }))
  document.body.appendChild(table.el)
  return { table, opened, selected }
}

function buildOptions(options: {
  opened: number[]
  selected: number[][]
  selectable?: boolean
  rows?: number[]
  persistence?: ConstructorParameters<typeof VirtualTable>[0]['persistence']
}): ConstructorParameters<typeof VirtualTable>[0] {
  return {
    columns: COLUMNS,
    rows: options.rows ?? [0, 1, 2, 3, 4],
    searchKeys: ['name'],
    onOpen: (row) => options.opened.push(row),
    onSelect: (rows) => options.selected.push(rows),
    ...(options.selectable === true ? { selectable: true } : {}),
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
  }
}

/** The source row index of every row element, in the order they are laid out. */
function shownRows(table: VirtualTable): number[] {
  return all<HTMLElement>(table.el, '.tr').map((node) => Number(node.dataset.row))
}

/** The name cell of every row on screen. */
function shownNames(table: VirtualTable): string[] {
  return shownRows(table).map((row) => NAMES[row])
}

function filterBox(table: VirtualTable, key: string): HTMLInputElement {
  const index = COLUMNS.findIndex((column) => column.key === key)
  const boxes = all<HTMLInputElement>(table.el, '.tf-input')
  const box = boxes[index]
  if (box === undefined) throw new Error(`no filter box for ${key}`)
  return box
}

function type(box: HTMLInputElement, text: string): Promise<void> {
  box.value = text
  box.dispatchEvent(new Event('input'))
  return settle()
}

// ---------------------------------------------------------------------------

describe('what it puts on screen', () => {
  it('draws a row per source row, in file order', () => {
    const { table } = make()
    expect(shownNames(table)).toEqual(NAMES)
  })

  it('formats a missing number as an empty cell rather than as NaN', () => {
    const { table } = make()
    // `unbinned` is row 3, whose density column answers `undefined`.
    const row = all<HTMLElement>(table.el, '.tr')[3]
    expect(textsOf(row, '.td')[2]).toBe('')
  })

  it('counts the rows, and says so only when a filter has hidden some', async () => {
    const { table } = make()
    expect(textsOf(table.el, '.table-status')).toEqual(['5 rows'])
    await type(filterBox(table, 'name'), 'bin.')
    expect(textsOf(table.el, '.table-status')).toEqual(['4 of 5 rows'])
  })

  it('says nothing matched rather than showing an empty grid', async () => {
    const { table } = make()
    await type(filterBox(table, 'name'), 'nothing at all')
    expect(shownRows(table)).toEqual([])
    expect(textsOf(table.el, '.tempty')).toEqual(['No rows match these filters.'])
  })

  it('comes back from empty when the filter is cleared', async () => {
    const { table } = make()
    await type(filterBox(table, 'name'), 'nothing at all')
    await type(filterBox(table, 'name'), '')
    expect(table.el.querySelector('.tempty')).toBeNull()
    expect(shownNames(table)).toEqual(NAMES)
  })

  it('carries the header tooltip a column asked for', () => {
    const { table } = make()
    const heads = all<HTMLElement>(table.el, '.th')
    expect(heads.map((node) => node.title)).toEqual(['name', 'length', 'not a contact count'])
  })
})

describe('filtering', () => {
  it('narrows to a substring, case-insensitively', async () => {
    const { table } = make()
    await type(filterBox(table, 'name'), 'BIN.1')
    expect(shownNames(table)).toEqual(['bin.1', 'bin.10'])
  })

  it('ANDs the boxes together', async () => {
    const { table } = make()
    await type(filterBox(table, 'name'), 'bin.')
    await type(filterBox(table, 'length'), '>500')
    expect(shownNames(table)).toEqual(['bin.1', 'bin.2', 'bin.3'])
  })

  it('never matches a missing value, even under a negation', async () => {
    const { table } = make()
    // Row 3's density is absent; `!5` is true of every number that is not 5, and
    // a filter selects rows it can positively vouch for.
    await type(filterBox(table, 'density'), '!=5')
    expect(shownNames(table)).not.toContain('unbinned')
  })

  it('marks a box that is doing something', async () => {
    const { table } = make()
    const box = filterBox(table, 'name')
    expect(box.classList.contains('active')).toBe(false)
    await type(box, 'bin')
    expect(box.classList.contains('active')).toBe(true)
    await type(box, '')
    expect(box.classList.contains('active')).toBe(false)
  })

  it('leaves the column alone while a comparison is half typed', async () => {
    const { table } = make()
    await type(filterBox(table, 'length'), '>')
    // Not an empty table: `>` is a filter nobody has finished writing.
    expect(shownNames(table)).toEqual(NAMES)
  })

  it('searches the keys it was given and not every column', async () => {
    const { table } = make()
    const search = table.el.querySelector<HTMLInputElement>('.search')
    if (search === null) throw new Error('no search box')
    search.value = '25000'
    search.dispatchEvent(new Event('input'))
    await settle()
    // `searchKeys: ['name']`, so a number that appears only in `length` is not a hit.
    expect(shownRows(table)).toEqual([])
  })
})

describe('clear filters', () => {
  it('empties every box and the search, and shows everything again', async () => {
    const { table } = make()
    await type(filterBox(table, 'name'), 'bin.')
    await type(filterBox(table, 'length'), '>500')
    buttonNamed(table.el, 'clear filters')?.click()
    expect(shownNames(table)).toEqual(NAMES)
    expect(all<HTMLInputElement>(table.el, '.tf-input').map((box) => box.value)).toEqual(['', '', ''])
  })

  it('leaves the selection alone — it says filters, and it means filters', async () => {
    const { table, selected } = make({ selectable: true })
    all<HTMLInputElement>(table.el, '.tcheck')[1].click()
    expect(table.selection).toEqual([1])
    await type(filterBox(table, 'name'), 'bin.')
    buttonNamed(table.el, 'clear filters')?.click()
    expect(table.selection).toEqual([1])
    expect(selected).toEqual([[1]])
  })
})

describe('sorting', () => {
  it('cycles a column up, then down, then off', () => {
    const { table } = make()
    const head = all<HTMLElement>(table.el, '.th')[1]
    head.click()
    expect(shownNames(table)).toEqual(['unbinned', 'bin.10', 'bin.1', 'bin.3', 'bin.2'])
    head.click()
    expect(shownNames(table)).toEqual(['bin.2', 'bin.3', 'bin.1', 'bin.10', 'unbinned'])
    head.click()
    expect(shownNames(table)).toEqual(NAMES)
  })

  it('shows the direction in the header, and takes the mark away again', () => {
    const { table } = make()
    const head = all<HTMLElement>(table.el, '.th')[1]
    expect(head.querySelector('.sort-arrow')?.childElementCount).toBe(0)
    head.click()
    expect(head.querySelector('.sort-arrow')?.childElementCount).toBe(1)
    head.click()
    head.click()
    expect(head.querySelector('.sort-arrow')?.childElementCount).toBe(0)
  })

  it('collates names the way a reader of contig names expects', () => {
    const { table } = make()
    all<HTMLElement>(table.el, '.th')[0].click()
    // `numeric: true`: bin.2 before bin.10, not after it.
    expect(shownNames(table)).toEqual(['bin.1', 'bin.2', 'bin.3', 'bin.10', 'unbinned'])
  })

  it('sorts a missing value last in both directions', () => {
    const { table } = make()
    const head = all<HTMLElement>(table.el, '.th')[2]
    head.click()
    expect(shownNames(table).at(-1)).toBe('unbinned')
    head.click()
    expect(shownNames(table).at(-1)).toBe('unbinned')
  })

  it('keeps a sort while a filter narrows under it', async () => {
    const { table } = make()
    all<HTMLElement>(table.el, '.th')[1].click()
    await type(filterBox(table, 'name'), 'bin.')
    expect(shownNames(table)).toEqual(['bin.10', 'bin.1', 'bin.3', 'bin.2'])
  })
})

describe('selecting', () => {
  it('offers no ticks at all unless asked', () => {
    const { table } = make()
    expect(table.el.querySelectorAll('.tcheck')).toHaveLength(0)
    expect(table.el.querySelector('.tf-check-box')).toBeNull()
  })

  it('ticks a row without opening it', () => {
    const { table, opened, selected } = make({ selectable: true })
    all<HTMLInputElement>(table.el, '.tcheck')[2].click()
    expect(table.selection).toEqual([2])
    expect(selected.at(-1)).toEqual([2])
    expect(opened).toEqual([])
  })

  it('opens a row that is merely clicked', () => {
    const { table, opened } = make({ selectable: true })
    all<HTMLElement>(table.el, '.tr')[2].click()
    expect(opened).toEqual([2])
    expect(table.selection).toEqual([])
  })

  it('ticks rather than opens when the click is modified', () => {
    const { table, opened } = make({ selectable: true })
    all<HTMLElement>(table.el, '.tr')[2].dispatchEvent(
      new MouseEvent('click', { ctrlKey: true, bubbles: true }),
    )
    expect(opened).toEqual([])
    expect(table.selection).toEqual([2])
  })

  it('takes any number of rows', () => {
    const { table } = make({ selectable: true })
    for (const box of all<HTMLInputElement>(table.el, '.tcheck')) box.click()
    expect(table.selection).toHaveLength(5)
  })

  it('empties the whole selection on request, hidden rows included', async () => {
    const { table, selected } = make({ selectable: true })
    all<HTMLInputElement>(table.el, '.tcheck')[3].click()
    await type(filterBox(table, 'name'), 'bin.')
    expect(table.selection).toEqual([3])
    table.clearSelection()
    expect(table.selection).toEqual([])
    expect(selected.at(-1)).toEqual([])
  })
})

describe('the box in the filter row’s gutter', () => {
  it('ticks everything the filters are showing, and nothing else', async () => {
    const { table } = make({ selectable: true })
    await type(filterBox(table, 'name'), 'bin.')
    const head = table.el.querySelector<HTMLInputElement>('.tf-check-box')
    head?.click()
    expect(table.selection.sort()).toEqual([0, 1, 2, 4])
    expect(table.selection).not.toContain(3)
  })

  it('unticks them again when they are all ticked', async () => {
    const { table } = make({ selectable: true })
    const head = table.el.querySelector<HTMLInputElement>('.tf-check-box')
    head?.click()
    expect(table.selection).toHaveLength(5)
    head?.click()
    expect(table.selection).toEqual([])
  })

  it('leaves a row a filter is hiding exactly as it was', async () => {
    const { table } = make({ selectable: true })
    all<HTMLInputElement>(table.el, '.tcheck')[3].click()
    await type(filterBox(table, 'name'), 'bin.')
    const head = table.el.querySelector<HTMLInputElement>('.tf-check-box')
    // Everything showing is unticked, so this ticks; `unbinned` is untouched.
    head?.click()
    expect(table.selection).toContain(3)
    head?.click()
    expect(table.selection).toEqual([3])
  })

  it('draws itself part-ticked for a partial selection', () => {
    const { table } = make({ selectable: true })
    const head = table.el.querySelector<HTMLInputElement>('.tf-check-box')
    if (head === null) throw new Error('no header box')
    expect(head.checked).toBe(false)
    expect(head.indeterminate).toBe(false)
    all<HTMLInputElement>(table.el, '.tcheck')[0].click()
    expect(head.checked).toBe(false)
    expect(head.indeterminate).toBe(true)
    head.click()
    expect(head.checked).toBe(true)
    expect(head.indeterminate).toBe(false)
  })
})

describe('the keyboard', () => {
  function press(table: VirtualTable, key: string): void {
    const viewport = table.el.querySelector('.tviewport')
    viewport?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }

  it('walks down the rows and marks where it is', () => {
    const { table } = make()
    press(table, 'ArrowDown')
    expect(all<HTMLElement>(table.el, '.tr.active').map((n) => n.dataset.row)).toEqual(['0'])
    press(table, 'ArrowDown')
    expect(all<HTMLElement>(table.el, '.tr.active').map((n) => n.dataset.row)).toEqual(['1'])
  })

  it('stops at both ends rather than wrapping', () => {
    const { table } = make()
    press(table, 'End')
    expect(all<HTMLElement>(table.el, '.tr.active').map((n) => n.dataset.row)).toEqual(['4'])
    press(table, 'ArrowDown')
    expect(all<HTMLElement>(table.el, '.tr.active').map((n) => n.dataset.row)).toEqual(['4'])
    press(table, 'Home')
    press(table, 'ArrowUp')
    expect(all<HTMLElement>(table.el, '.tr.active').map((n) => n.dataset.row)).toEqual(['0'])
  })

  it('opens the row it is on', () => {
    const { table, opened } = make()
    press(table, 'ArrowDown')
    press(table, 'ArrowDown')
    press(table, 'Enter')
    expect(opened).toEqual([1])
  })

  it('ticks with the space bar, and only where ticking is offered', () => {
    const { table } = make({ selectable: true })
    press(table, 'ArrowDown')
    press(table, ' ')
    expect(table.selection).toEqual([0])

    const plain = make()
    press(plain.table, 'ArrowDown')
    press(plain.table, ' ')
    expect(plain.table.selection).toEqual([])
  })

  it('walks the filtered rows rather than the file’s', async () => {
    const { table, opened } = make()
    await type(filterBox(table, 'name'), 'bin.1')
    press(table, 'ArrowDown')
    press(table, 'ArrowDown')
    press(table, 'Enter')
    // Rows 0 and 2 are what `bin.1` left; the second of them is row 2.
    expect(opened).toEqual([2])
  })

  it('forgets the row it was on when a filter takes that row away', async () => {
    const { table, opened } = make({ selectable: true })
    press(table, 'End')
    await type(filterBox(table, 'name'), 'bin.1')
    // The cursor was on `bin.3`, which the filter has hidden. Enter must not
    // navigate to it and the space bar must not tick it: a keypress aimed at the
    // list in front of the reader, answered with a row that is not in it, is a
    // wrong answer they have no way to see. Only the *position* used to be
    // cleared here; the row itself survived the recompute.
    press(table, 'Enter')
    press(table, ' ')
    expect(opened).toEqual([])
    expect(table.selection).toEqual([])

    // …and the walk starts again from the top of what is showing.
    press(table, 'ArrowDown')
    press(table, 'Enter')
    expect(opened).toEqual([0])
  })
})

describe('virtualisation', () => {
  it('builds elements for a screenful rather than for the file', () => {
    const rows = Array.from({ length: 4000 }, (_, index) => index)
    const table = new VirtualTable({
      columns: [{ key: 'name', label: 'name', kind: 'string', value: (row) => `c${row}` }],
      rows,
      onOpen: () => {},
    })
    document.body.appendChild(table.el)
    const drawn = table.el.querySelectorAll('.tr').length
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(100)
    // The height is still the whole set's, so the scrollbar tells the truth.
    expect(table.el.querySelector<HTMLElement>('.tbody')?.style.height).toBe(`${4000 * 28}px`)
    table.destroy()
  })
})

describe('what it remembers', () => {
  it('opens with the filters, search and sort it was handed', () => {
    const { table } = make({
      persistence: {
        initial: { filters: { name: 'bin.' }, search: '', sortKey: 'length', sortDir: -1 },
        save: () => {},
      },
    })
    expect(filterBox(table, 'name').value).toBe('bin.')
    expect(filterBox(table, 'name').classList.contains('active')).toBe(true)
    expect(shownNames(table)).toEqual(['bin.2', 'bin.3', 'bin.1', 'bin.10'])
  })

  it('drops a restored filter naming a column this file has not got', () => {
    const { table } = make({
      persistence: {
        initial: {
          filters: { gc: '>0.5' },
          search: '',
          sortKey: 'gc',
          sortDir: 1,
        },
        save: () => {},
      },
    })
    expect(shownNames(table)).toEqual(NAMES)
    expect(all<HTMLElement>(table.el, '.th .sort-arrow').map((n) => n.childElementCount)).toEqual([
      0, 0, 0,
    ])
  })

  it('writes the state out, coalescing a burst of typing into one', async () => {
    const saved: unknown[] = []
    const { table } = make({
      persistence: { initial: null, save: (state) => saved.push(state) },
    })
    await type(filterBox(table, 'name'), 'b')
    await type(filterBox(table, 'name'), 'bi')
    expect(saved).toEqual([])
    // The flush on the way out is what stops a filter typed and immediately
    // navigated away from being lost.
    table.destroy()
    expect(saved).toEqual([
      { filters: { name: 'bi' }, search: '', sortKey: null, sortDir: 1 },
    ])
  })
})

describe('the filter grammar', () => {
  it('reads every comparison the box advertises', () => {
    const cases: Array<[string, number, boolean]> = [
      ['>10', 11, true],
      ['>10', 10, false],
      ['>=10', 10, true],
      ['<10', 9, true],
      ['<=10', 10, true],
      ['=10', 10, true],
      ['!=10', 10, false],
      ['10', 10, true],
      ['1..5', 3, true],
      ['1..5', 6, false],
    ]
    for (const [expression, value, wanted] of cases) {
      expect(numberFilter(expression)?.(value), expression).toBe(wanted)
    }
  })

  it('reads a number written with a negative exponent', () => {
    // `-?[\d.eE+]+` had no `-` past the first character, so `1e-5` did not parse
    // and `>1e-5` came back `null` — which leaves the column *unfiltered*, on
    // exactly the column (a density) a reader writes that way.
    expect(numberFilter('1e-5')).not.toBeNull()
    expect(numberFilter('>1e-5')?.(1e-4)).toBe(true)
    expect(numberFilter('>1e-5')?.(1e-6)).toBe(false)
    expect(numberFilter('1e-5..1e-3')?.(1e-4)).toBe(true)
    expect(numberFilter('1e-5..1e-3')?.(1)).toBe(false)
    expect(numberFilter('>-2.5e2')?.(-100)).toBe(true)
  })

  it('refuses what it cannot parse, rather than emptying the column', () => {
    expect(numberFilter('>')).toBeNull()
    expect(numberFilter('')).toBeNull()
    expect(numberFilter('abc')).toBeNull()
    expect(stringFilter('/[/')).toBeNull()
  })

  it('never matches a missing value', () => {
    expect(numberFilter('>0')?.(undefined)).toBe(false)
    expect(numberFilter('!=1')?.(undefined)).toBe(false)
    expect(stringFilter('a')?.(undefined)).toBe(false)
    expect(stringFilter('!a')?.(undefined)).toBe(false)
  })

  it('reads a regex, and makes it case-insensitive unless told otherwise', () => {
    expect(stringFilter('/^BIN/')?.('bin.1')).toBe(true)
    expect(stringFilter('/^bin/')?.('BIN.1')).toBe(true)
  })

  it('reads a leading bang as “does not contain”', () => {
    expect(stringFilter('!bin')?.('unbinned')).toBe(false)
    expect(stringFilter('!bin')?.('scaffold')).toBe(true)
  })
})
