/**
 * The cells table — the landing view of an `.scool` (spec §5.1, §3.7).
 *
 * The genomes table's sibling, and deliberately its near-twin: a sortable,
 * filterable list of everything in the file, tick boxes down the side, and one
 * button that turns the ticks into a picture. A reader who has used one has
 * used the other.
 *
 * What differs is what a tick *means*, and it is the whole of the difference.
 * Ticking genomes lays them out **beside** each other — each on the diagonal,
 * the blocks between them off it — because two MAGs are two places in one bin
 * space. Ticking cells **adds them up**: every cell of an scool indexes the
 * same bins, so a set of them is one map of the same genome with more contacts
 * in it. The button therefore says *sum*, and the hint says so in words, since
 * this is the one thing about the view a reader could otherwise get wrong.
 *
 * The selection is also **sticky**, which the genomes table's is not. It is not
 * only the subject of one picture; it is which cells the file is being read
 * through from here on, so it survives navigating into a chromosome and out
 * again (`app/Session.ts`). The count in the header is what says so.
 */

import { payloadColumnIsText, type CellsResult } from '../worker/protocol'
import { button, el, fmt } from './dom'
import { KEYS, keyedButton, withKey } from './commands'
import { SearchBox } from './SearchBox'
import { VirtualTable, type ColumnDef, type VirtualTableOptions } from './VirtualTable'

/** Columns every cooler writes, in the order they are shown. */
const CORE_ORDER = ['name', 'nnz', 'sum']

/** Above this many ticked cells, the button says the read is a big one. */
const MANY_CELLS = 64

export interface CellsTableOptions {
  data: CellsResult
  /** Total cells in the file, which is `data.table.length` — passed for clarity. */
  persistence?: VirtualTableOptions['persistence']
  /**
   * Sum the ticked cells and show them as one map.
   *
   * The plural of "open this cell", and the same call with one name in it: a
   * single cell is a sum of one, and nothing downstream distinguishes them.
   */
  onShowCells(names: string[]): void
  /** Every cell in the file, summed — the pseudo-bulk. */
  onShowAll(): void
}

export class CellsTable {
  readonly el: HTMLElement
  private readonly table: VirtualTable
  private readonly names: string[]
  private readonly search: SearchBox

  constructor(options: CellsTableOptions) {
    const { data } = options
    this.names = data.table.data['name'] as string[]
    const total = data.table.length

    const columns = buildColumns(data)
    const show = button('sum selected →', () => {
      const rows = this.table.selection
      if (rows.length > 0) options.onShowCells(rows.map((row) => this.names[row]))
    })
    show.disabled = true
    const none = button('clear selection', () => this.table.clearSelection(), {
      class: 'btn btn-quiet',
      title: 'Untick everything, including rows the filters are hiding',
    })
    none.disabled = true

    this.table = new VirtualTable({
      columns,
      rows: Array.from({ length: total }, (_, row) => row),
      selectable: true,
      searchKeys: ['name'],
      searchPlaceholder: 'search cell names…',
      emptyMessage: 'No cells match these filters.',
      ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
      // A click opens that cell on its own, which is the per-cell view and the
      // most common thing anybody does here.
      onOpen: (row) => options.onShowCells([this.names[row]]),
      onSelect: (rows) => {
        show.disabled = rows.length === 0
        none.disabled = rows.length === 0
        show.textContent =
          rows.length === 1
            ? `show ${this.names[rows[0]]} →`
            : rows.length > 1
              ? `sum ${fmt.int(rows.length)} cells →`
              : 'sum selected →'
        // A set this large is a walk of every one of their pixel tables, and
        // saying so on the button is cheaper than saying it in a dialog after
        // the click. The gate itself lives where the read is decided.
        show.title =
          rows.length > MANY_CELLS
            ? `Sum ${fmt.int(rows.length)} cells. This reads every one of their pixel tables, ` +
              'so it is a longer wait than a single cell.'
            : 'Add the ticked cells together and draw them as one map'
      },
    })
    this.table.addToolbarItem(none)
    this.table.addToolbarItem(show)
    this.table.addToolbarItem(
      keyedButton(`sum all ${fmt.int(total)} →`, KEYS.whole, () => options.onShowAll(), {
        title: withKey(
          `Every cell in this file added together — the pseudo-bulk map. Reads all ${fmt.int(total)} pixel tables.`,
          KEYS.whole,
        ),
      }),
    )

    this.search = new SearchBox({
      placeholder: 'cell name',
      title:
        'Jump to a cell by name. The box above the rows filters the list; this one goes ' +
        'straight to a cell and opens it.',
      onSubmit: (text) => {
        const wanted = text.trim()
        if (wanted === '') return
        const exact = this.names.indexOf(wanted)
        if (exact >= 0) {
          options.onShowCells([this.names[exact]])
          return
        }
        // No exact match: treat it as a prefix, which is what a reader typing
        // half a barcode meant. Several matches sum, which is the view this
        // table is for — `Diploid_10` is a plate, not a typo.
        const prefixed = this.names.filter((name) => name.startsWith(wanted))
        if (prefixed.length > 0) options.onShowCells(prefixed)
      },
    })

    this.el = el(
      'section',
      { class: 'view view-cells' },
      el(
        'header',
        { class: 'view-head' },
        el('h2', { text: `Cells (${fmt.int(total)})` }),
        el('p', {
          class: 'hint',
          text:
            'Click a cell to open its own contact map. Tick any number and they are ' +
            'added together — every cell here indexes the same bins, so a set of them is ' +
            'one map with their contacts summed, which is what makes a sparse single-cell ' +
            'matrix readable. The chosen cells stay chosen as you move into a chromosome ' +
            'and back out.',
        }),
        this.search.el,
      ),
      this.table.el,
    )
  }

  /** The `/` key, as in every other view: the name box, not the filter. */
  focusSearch(): void {
    this.search.focus()
  }

  destroy(): void {
    this.table.destroy()
  }

  clearSelection(): void {
    this.table.clearSelection()
  }
}

/**
 * Build the columns from whatever the cells' attributes turned out to hold.
 *
 * `name`, `nnz` and `sum` lead because every cooler writes the latter two and
 * they are what a single-cell library is ranked by — depth is the axis that
 * separates a usable cell from an empty one, and the file states it per cell
 * for nothing. Anything else the reader found *differing* across cells follows
 * in its own column; anything constant was dropped upstream, where it is a fact
 * about the file rather than about a cell (`MetaCooler.cellTable`).
 */
function buildColumns(data: CellsResult): ColumnDef[] {
  const payload = data.table
  const present = new Set(payload.columns)
  const ordered = [
    ...CORE_ORDER.filter((name) => present.has(name)),
    ...payload.columns.filter((name) => !CORE_ORDER.includes(name)),
  ]

  return ordered.map((name) => {
    const column = payload.data[name]
    if (payloadColumnIsText(column)) {
      return {
        key: name,
        label: name,
        kind: 'string',
        // Cell names are long — a barcode pair and a lane, routinely forty
        // characters — so the name column is given room the genomes table's
        // does not need, and the numbers stay narrow beside it.
        width: name === 'name' ? 'minmax(16rem, 2.4fr)' : 'minmax(7rem, 1fr)',
        value: (row) => (column[row] === '' ? undefined : column[row]),
      }
    }
    return {
      key: name,
      label: name === 'nnz' ? 'nnz' : name === 'sum' ? 'contacts' : name,
      kind: 'number',
      align: 'right',
      width: 'minmax(6rem, 0.7fr)',
      title:
        name === 'nnz'
          ? "Stored pixels in this cell's own matrix, from its attributes — no pixel is read."
          : name === 'sum'
            ? 'Total contacts in this cell, from its attributes. The depth a cell was sequenced to.'
            : undefined,
      value: (row) => column[row],
      format: (value) => (typeof value === 'number' ? fmt.num(value) : ''),
    }
  })
}
