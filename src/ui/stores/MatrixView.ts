/**
 * The matrix: two facets against each other, a count in every cell.
 *
 * ENCODE's own front page is this picture — assay down the side, biosample
 * along the top, and how many experiments sit at each crossing — and it is the
 * fastest way to see what a portal has *before* asking for anything: a glance
 * says which cell lines have Hi-C and which assays cover GM12878. The counts
 * come from `state/facets.ts`'s pivot, honouring the text and every facet that
 * is not on an axis; a cell is a button that ticks both of its values and hands
 * the reader back to the list, narrowed.
 *
 * ## Capped, and says so
 *
 * A grid of eight hundred biosamples is not a picture anybody reads. The axes
 * keep their most populous values and the line under the grid says how many
 * were left out, which is the cue to narrow with the rail or swap an axis —
 * both are one click away and neither is guessed at here.
 */

import { el, fmt } from '../dom'
import { isTicked, type FacetSelection, type Pivot } from '../../state/facets'
import type { StoreColumn } from '../../state/store'
import { labelOf } from './FacetRail'

export interface MatrixPaint {
  pivot: Pivot
  rowKey: string
  colKey: string
  columns: readonly StoreColumn[]
  selection: FacetSelection
}

export interface MatrixViewProps {
  /** A cell was pressed: tick both values and show the list. */
  onCell(rowKey: string, row: string, colKey: string, col: string): void
  /** An axis was changed. */
  onAxes(rowKey: string, colKey: string): void
}

export class MatrixView {
  readonly el = el('div', { class: 'matrix' })
  private readonly rowSelect = el('select', { class: 'select matrix-axis' })
  private readonly colSelect = el('select', { class: 'select matrix-axis' })
  private readonly grid = el('div', { class: 'matrix-grid' })
  private readonly note = el('p', { class: 'hint matrix-note' })

  constructor(private readonly props: MatrixViewProps) {
    const change = (): void => this.props.onAxes(this.rowSelect.value, this.colSelect.value)
    this.rowSelect.addEventListener('change', change)
    this.colSelect.addEventListener('change', change)
    this.el.append(
      el(
        'div',
        { class: 'matrix-axes' },
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'down' }), this.rowSelect),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'across' }), this.colSelect),
      ),
      this.grid,
      this.note,
    )
  }

  paint(paint: MatrixPaint): void {
    this.paintAxes(paint)
    const { pivot, rowKey, colKey } = paint
    let max = 1
    for (const row of pivot.rows) {
      for (const col of pivot.cols) max = Math.max(max, pivot.counts.get(row)?.get(col) ?? 0)
    }
    const head = el(
      'tr',
      {},
      el('th', { class: 'matrix-corner' }),
      ...pivot.cols.map((col) =>
        el(
          'th',
          { class: `matrix-col${isTicked(paint.selection, colKey, col) ? ' is-on' : ''}`, attrs: { scope: 'col' } },
          el('span', { class: 'matrix-col-text', text: labelOf(col), title: labelOf(col) }),
        ),
      ),
    )
    const body = pivot.rows.map((row) =>
      el(
        'tr',
        {},
        el(
          'th',
          { class: `matrix-row${isTicked(paint.selection, rowKey, row) ? ' is-on' : ''}`, attrs: { scope: 'row' } },
          el('span', { class: 'matrix-row-text', text: labelOf(row), title: labelOf(row) }),
        ),
        ...pivot.cols.map((col) => this.cell(row, col, pivot.counts.get(row)?.get(col) ?? 0, max, paint)),
      ),
    )
    this.grid.replaceChildren(
      el('table', { class: 'matrix-table' }, el('thead', {}, head), el('tbody', {}, ...body)),
    )
    this.note.textContent = matrixNote(paint)
  }

  private paintAxes(paint: MatrixPaint): void {
    const options = (chosen: string): HTMLOptionElement[] =>
      paint.columns.map((column) => {
        const option = el('option', { value: column.key, text: column.label })
        if (column.key === chosen) option.selected = true
        return option
      })
    this.rowSelect.replaceChildren(...options(paint.rowKey))
    this.colSelect.replaceChildren(...options(paint.colKey))
    this.rowSelect.value = paint.rowKey
    this.colSelect.value = paint.colKey
  }

  private cell(row: string, col: string, count: number, max: number, paint: MatrixPaint): HTMLElement {
    if (count === 0) return el('td', { class: 'matrix-cell matrix-cell-empty' })
    // Log-scaled, because the counts span three orders of magnitude and a
    // linear scale would leave every cell but the largest white.
    const strength = Math.log1p(count) / Math.log1p(max)
    const on = isTicked(paint.selection, paint.rowKey, row) && isTicked(paint.selection, paint.colKey, col)
    const node = el(
      'button',
      {
        class: `matrix-cell-button${on ? ' is-on' : ''}`,
        type: 'button',
        text: fmt.int(count),
        title: `${fmt.int(count)} ${count === 1 ? 'file' : 'files'}: ${labelOf(row)} × ${labelOf(col)}. Press to narrow the list to them.`,
      },
    )
    // A custom property, which `el`'s `style` cannot set: the stylesheet turns
    // it into the cell's tint.
    node.style.setProperty('--strength', strength.toFixed(3))
    node.addEventListener('click', () => this.props.onCell(paint.rowKey, row, paint.colKey, col))
    return el('td', { class: 'matrix-cell' }, node)
  }
}

/** The line under the grid: what it counts, and what the caps left out. */
export function matrixNote(paint: MatrixPaint): string {
  const { pivot, columns, rowKey, colKey } = paint
  const label = (key: string): string => columns.find((column) => column.key === key)?.label.toLowerCase() ?? key
  if (pivot.total === 0) return 'Nothing to count: no row passes the text and the other facets.'
  const parts = [`${fmt.int(pivot.total)} ${pivot.total === 1 ? 'file' : 'files'} counted.`]
  if (pivot.rows.length < pivot.rowValues) {
    parts.push(
      `The ${fmt.int(pivot.rows.length)} most populated of ${fmt.int(pivot.rowValues)} ${label(rowKey)} values are down the side.`,
    )
  }
  if (pivot.cols.length < pivot.colValues) {
    parts.push(
      `The ${fmt.int(pivot.cols.length)} most populated of ${fmt.int(pivot.colValues)} ${label(colKey)} values are across the top.`,
    )
  }
  if (parts.length > 1) parts.push('Narrow with the rail or the search to see the others.')
  return parts.join(' ')
}
