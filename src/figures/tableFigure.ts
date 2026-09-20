/**
 * A result table the reader can search, sort and narrow.
 *
 * The table the drawer has always drawn was a *record*: rows in the order the
 * task produced them, every column, no controls, checkable by eye and
 * exportable as TSV. That is the right thing for twelve rows and the wrong
 * thing for four thousand MAGs, where the question is almost never "what is in
 * row 1,207" and almost always "which of these is worst".
 *
 * So the rows are a view of the output rather than a printing of it, and the
 * view is a {@link FigureStyle} — the same object the charts are styled by,
 * remembered in the same place. Which means the filter a reader typed survives
 * a re-run, and the TSV beside the table can offer what they are looking at.
 *
 * Still not a {@link VirtualTable}: virtualisation exists here for 154,000
 * contigs, and a task's table is hundreds to a few thousand rows, which is one
 * layout pass. The typography is the virtual table's, because a number in a
 * result should be set like a number in a genomes table.
 */

import { el, fmt } from '../ui/dom'
import type { TableColumn } from '../analysis/types'
import type { TableFigureSpec } from './spec'
import type { FigureStyle } from './style'

export interface TableView {
  el: HTMLElement
  destroy(): void
}

/** What a cell says. `NaN` is *no value here* — an em dash, never a zero. */
export function cellText(column: TableColumn, raw: string | number | undefined): string {
  if (raw === undefined) return '—'
  if (column.kind !== 'number') return String(raw)
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return '—'
  return column.digits === undefined ? fmt.int(value) : value.toFixed(column.digits)
}

/**
 * The rows a style leaves, in the order it asks for.
 *
 * The filter is a plain substring over every cell's *text*, which is the search
 * a reader means when they type `bin.4` into a box over a table. Matching the
 * underlying numbers instead would make `98` fail to find a completeness of
 * `98.2` on a column rounded to one place, which is the number they can see.
 *
 * Sorting puts what is missing last whichever way the column runs, because a
 * row with no value is not a row with the smallest one.
 */
export function viewRows(
  spec: TableFigureSpec,
  style: FigureStyle,
): Array<Record<string, string | number>> {
  const needle = style.filter.trim().toLowerCase()
  let rows = spec.rows
  if (needle !== '') {
    rows = rows.filter((row) =>
      spec.columns.some((column) => cellText(column, row[column.key]).toLowerCase().includes(needle)),
    )
  }
  const key = style.sortKey
  if (key === null) return rows
  const column = spec.columns.find((entry) => entry.key === key)
  if (column === undefined) return rows
  const sign = style.sortDown ? -1 : 1
  const missing = (value: string | number | undefined): boolean =>
    value === undefined || (column.kind === 'number' && !Number.isFinite(Number(value)))
  return [...rows].sort((a, b) => {
    const left = a[key]
    const right = b[key]
    if (missing(left) !== missing(right)) return missing(left) ? 1 : -1
    if (missing(left)) return 0
    if (column.kind === 'number') return sign * (Number(left) - Number(right))
    return sign * String(left).localeCompare(String(right))
  })
}

/** The columns a style leaves, in the table's own order. */
export function viewColumns(spec: TableFigureSpec, style: FigureStyle): TableColumn[] {
  const shown = style.columns
  if (shown === null) return spec.columns
  const kept = spec.columns.filter((column) => shown.includes(column.key))
  // A style that hid every column is a style that hides the table; the columns
  // come back rather than leaving a reader with an empty box and no way out.
  return kept.length === 0 ? spec.columns : kept
}

/**
 * The table, as the style leaves it.
 *
 * A column head is a button that sorts by it, which is what a head that looks
 * like a head promises. Pressing the column that is already the sort turns it
 * round, which is the gesture every table in this app already has.
 */
export function tableView(
  spec: TableFigureSpec,
  style: FigureStyle,
  onSort: (key: string, down: boolean) => void,
): TableView {
  const columns = viewColumns(spec, style)
  const rows = viewRows(spec, style)

  const head = el(
    'thead',
    { class: 'thead' },
    el(
      'tr',
      {},
      ...columns.map((column) => {
        const sorted = style.sortKey === column.key
        const cell = el('th', {
          class: `td figure-th${sorted ? ' is-sorted' : ''}${column.kind === 'number' ? ' num' : ''}`,
          text: `${column.label}${sorted ? (style.sortDown ? ' ↓' : ' ↑') : ''}`,
          title: column.hint ?? `Sort by ${column.label}`,
          attrs: { role: 'button', tabindex: '0' },
        })
        const flip = (): void => onSort(column.key, sorted ? !style.sortDown : false)
        cell.addEventListener('click', flip)
        cell.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          flip()
        })
        return cell
      }),
    ),
  )

  const body = el('tbody', {})
  for (const row of rows) {
    body.appendChild(
      el(
        'tr',
        { style: { borderTop: '1px solid var(--border)' } },
        ...columns.map((column) =>
          el('td', {
            class: column.kind === 'number' ? 'td num' : 'td',
            text: cellText(column, row[column.key]),
          }),
        ),
      ),
    )
  }

  const table = el(
    'table',
    {
      style: {
        borderCollapse: 'collapse',
        width: '100%',
        // Digits of the same width, so a column of numbers can be compared by
        // its shape.
        fontVariantNumeric: 'tabular-nums',
      },
    },
    head,
    body,
  )

  const empty =
    spec.rows.length === 0
      ? 'This run produced no rows.'
      : `No row matches “${style.filter}”. ${spec.rows.length} were produced.`

  const host = el(
    'div',
    { class: 'analysis-figure-scroll' },
    rows.length === 0 ? el('div', { class: 'tempty', text: empty }) : table,
  )

  return { el: host, destroy(): void {} }
}
