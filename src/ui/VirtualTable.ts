/**
 * A sortable, filterable, virtualised table.
 *
 * Shared by the genomes table (§5.1) and the contigs table (§9). Virtualisation
 * is not a nicety: the reference file has 4,395 genomes and 154,468 contigs, and
 * 154 k rows of DOM is several seconds of layout before anything appears.
 * Only the rows in view (plus a small overscan) exist as elements; the rest is
 * a spacer of the right height.
 *
 * The filter grammar deliberately follows the shape of `metacooler`'s own
 * `--filter`: one comparison per box, ANDed across boxes, and **a missing value
 * never matches** — including under a negated comparison — because a filter
 * selects rows it can positively vouch for.
 */

import { clear, debounce, el } from './dom'

export type ColumnKind = 'string' | 'number'

export interface ColumnDef {
  /** Stable key; also the filter box's identity. */
  key: string
  label: string
  kind: ColumnKind
  /** Cell value for a source row index. `undefined` means missing. */
  value(row: number): string | number | undefined
  /** Display string; defaults to a formatted `value`. */
  format?(value: string | number | undefined, row: number): string
  /** Header tooltip — where the density column's "not a contact count" lives. */
  title?: string
  /** CSS grid track for this column. */
  width?: string
  align?: 'left' | 'right'
}

export interface VirtualTableOptions {
  columns: ColumnDef[]
  /** Source row indices, in the order the file wrote them. */
  rows: number[]
  rowHeight?: number
  /** Activating a row (click or Enter). */
  onOpen(row: number): void
  /** Called whenever the checked set changes. */
  onSelect?(rows: number[]): void
  /** Enables the leading checkbox column when set. */
  maxSelection?: number
  /** Columns the free-text box searches; defaults to every string column. */
  searchKeys?: string[]
  searchPlaceholder?: string
  emptyMessage?: string
}

type Predicate = (row: number) => boolean

const OVERSCAN = 6

export class VirtualTable {
  readonly el: HTMLElement

  private readonly options: Required<Pick<VirtualTableOptions, 'rowHeight'>> & VirtualTableOptions
  private readonly filters = new Map<string, string>()
  private readonly selected = new Set<number>()
  private readonly pool: HTMLElement[] = []

  private source: number[]
  private visible: number[] = []
  private sortKey: string | null = null
  private sortDir: 1 | -1 = 1
  private search = ''
  private active = -1

  private readonly viewport: HTMLElement
  private readonly spacer: HTMLElement
  private readonly body: HTMLElement
  private readonly header: HTMLElement
  private readonly filterRow: HTMLElement
  private readonly status: HTMLElement
  private readonly toolbar: HTMLElement

  constructor(options: VirtualTableOptions) {
    this.options = { rowHeight: 28, ...options }
    this.source = options.rows

    const template = this.gridTemplate()
    this.status = el('span', { class: 'table-status' })
    const searchBox = el('input', {
      class: 'search',
      type: 'search',
      placeholder: options.searchPlaceholder ?? 'search names…',
    })
    searchBox.addEventListener(
      'input',
      debounce(() => {
        this.search = searchBox.value.trim().toLowerCase()
        this.recompute()
      }, 120),
    )
    const reset = el('button', { class: 'btn btn-quiet', text: 'clear filters', type: 'button' })
    reset.addEventListener('click', () => {
      this.filters.clear()
      this.search = ''
      searchBox.value = ''
      for (const input of this.filterRow.querySelectorAll('input')) input.value = ''
      this.recompute()
    })
    this.toolbar = el('div', { class: 'table-toolbar' }, searchBox, this.status, reset)

    this.header = el('div', { class: 'thead-row', style: { gridTemplateColumns: template } })
    this.filterRow = el('div', { class: 'tfilter-row', style: { gridTemplateColumns: template } })
    this.buildHeader()

    this.body = el('div', { class: 'tbody' })
    this.spacer = el('div', { class: 'tspacer' })
    this.viewport = el(
      'div',
      { class: 'tviewport', attrs: { tabindex: '0', role: 'grid' } },
      this.spacer,
      this.body,
    )
    this.viewport.addEventListener('scroll', () => this.paint())
    this.viewport.addEventListener('keydown', (event) => this.onKeyDown(event))

    this.el = el(
      'div',
      { class: 'table' },
      this.toolbar,
      el('div', { class: 'thead' }, this.header, this.filterRow),
      this.viewport,
    )

    this.recompute()
    // The viewport has no height until it is in the document; repaint once the
    // browser has laid it out so the first screen is not blank.
    requestAnimationFrame(() => this.paint())
  }

  /** Extra controls placed in the toolbar by the owning view. */
  addToolbarItem(node: HTMLElement): void {
    this.toolbar.appendChild(node)
  }

  /** Replace the candidate rows (used when the underlying table changes). */
  setRows(rows: number[]): void {
    this.source = rows
    this.selected.clear()
    this.recompute()
  }

  get selection(): number[] {
    return [...this.selected]
  }

  clearSelection(): void {
    this.selected.clear()
    this.options.onSelect?.([])
    this.paint()
  }

  private gridTemplate(): string {
    const tracks = this.options.columns.map((column) => column.width ?? 'minmax(6rem, 1fr)')
    if (this.options.maxSelection !== undefined) tracks.unshift('2rem')
    return tracks.join(' ')
  }

  private buildHeader(): void {
    if (this.options.maxSelection !== undefined) {
      this.header.appendChild(el('div', { class: 'th th-check', text: '' }))
      this.filterRow.appendChild(el('div', { class: 'tf' }))
    }
    for (const column of this.options.columns) {
      const label = el('span', { text: column.label })
      const arrow = el('span', { class: 'sort-arrow', text: '' })
      const cell = el(
        'div',
        {
          class: `th${column.align === 'right' ? ' num' : ''}`,
          title: column.title ?? column.label,
          attrs: { role: 'columnheader' },
        },
        label,
        arrow,
      )
      cell.addEventListener('click', () => this.toggleSort(column.key))
      this.header.appendChild(cell)

      const input = el('input', {
        class: 'tf-input',
        type: 'text',
        placeholder: column.kind === 'number' ? '>0' : 'contains',
        title:
          column.kind === 'number'
            ? 'Numeric filter: >x, >=x, <x, <=x, =x, !=x, or a..b. Missing values never match.'
            : 'Text filter: substring, /regex/, or !substring. Missing values never match.',
      })
      input.addEventListener(
        'input',
        debounce(() => {
          const value = input.value.trim()
          if (value === '') this.filters.delete(column.key)
          else this.filters.set(column.key, value)
          input.classList.toggle('active', value !== '')
          this.recompute()
        }, 150),
      )
      this.filterRow.appendChild(el('div', { class: 'tf' }, input))
    }
  }

  private toggleSort(key: string): void {
    if (this.sortKey === key) {
      if (this.sortDir === 1) this.sortDir = -1
      else {
        this.sortKey = null
        this.sortDir = 1
      }
    } else {
      this.sortKey = key
      this.sortDir = 1
    }
    for (const [index, cell] of [...this.header.querySelectorAll('.th')].entries()) {
      const offset = this.options.maxSelection !== undefined ? 1 : 0
      const column = this.options.columns[index - offset]
      const arrow = cell.querySelector('.sort-arrow')
      if (arrow === null || column === undefined) continue
      arrow.textContent = this.sortKey === column.key ? (this.sortDir === 1 ? '▲' : '▼') : ''
    }
    this.recompute()
  }

  private predicates(): Predicate[] {
    const list: Predicate[] = []
    for (const column of this.options.columns) {
      const expression = this.filters.get(column.key)
      if (expression === undefined) continue
      const test = column.kind === 'number' ? numberFilter(expression) : stringFilter(expression)
      if (test === null) continue
      list.push((row) => test(column.value(row)))
    }
    if (this.search !== '') {
      const keys = this.options.searchKeys ?? this.options.columns.filter((c) => c.kind === 'string').map((c) => c.key)
      const columns = this.options.columns.filter((column) => keys.includes(column.key))
      const needle = this.search
      list.push((row) =>
        columns.some((column) => {
          const value = column.value(row)
          return value !== undefined && String(value).toLowerCase().includes(needle)
        }),
      )
    }
    return list
  }

  private recompute(): void {
    const tests = this.predicates()
    this.visible = tests.length === 0 ? [...this.source] : this.source.filter((row) => tests.every((t) => t(row)))

    if (this.sortKey !== null) {
      const column = this.options.columns.find((c) => c.key === this.sortKey)
      if (column !== undefined) {
        const dir = this.sortDir
        const numeric = column.kind === 'number'
        this.visible.sort((a, b) => {
          const va = column.value(a)
          const vb = column.value(b)
          // Missing sorts last regardless of direction: a blank taxonomy is not
          // "smaller" than a filled one, it is absent.
          const ma = va === undefined || (numeric && Number.isNaN(va as number))
          const mb = vb === undefined || (numeric && Number.isNaN(vb as number))
          if (ma || mb) return ma && mb ? 0 : ma ? 1 : -1
          if (numeric) return ((va as number) - (vb as number)) * dir
          return String(va).localeCompare(String(vb)) * dir
        })
      }
    }

    const total = this.source.length
    const shown = this.visible.length
    this.status.textContent = shown === total ? `${total.toLocaleString()} rows` : `${shown.toLocaleString()} of ${total.toLocaleString()} rows`
    this.spacer.style.height = `${this.visible.length * this.options.rowHeight}px`
    this.viewport.scrollTop = 0
    this.paint()
  }

  private paint(): void {
    const { rowHeight } = this.options
    const height = this.viewport.clientHeight || 400
    const first = Math.max(0, Math.floor(this.viewport.scrollTop / rowHeight) - OVERSCAN)
    const count = Math.min(this.visible.length - first, Math.ceil(height / rowHeight) + 2 * OVERSCAN)

    if (this.visible.length === 0) {
      clear(this.body)
      this.pool.length = 0
      this.body.appendChild(
        el('div', { class: 'tempty', text: this.options.emptyMessage ?? 'No rows match these filters.' }),
      )
      return
    }
    if (this.body.firstChild instanceof HTMLElement && this.body.firstChild.classList.contains('tempty')) {
      clear(this.body)
    }

    while (this.pool.length < count) {
      const row = this.buildRow()
      this.pool.push(row)
      this.body.appendChild(row)
    }
    while (this.pool.length > count) {
      const row = this.pool.pop()
      row?.remove()
    }

    for (let i = 0; i < count; i++) {
      this.fillRow(this.pool[i], this.visible[first + i], (first + i) * rowHeight)
    }
  }

  private buildRow(): HTMLElement {
    const template = this.gridTemplate()
    const row = el('div', {
      class: 'tr',
      style: { gridTemplateColumns: template, height: `${this.options.rowHeight}px` },
      attrs: { role: 'row' },
    })
    if (this.options.maxSelection !== undefined) {
      const check = el('input', { class: 'tcheck', type: 'checkbox' })
      check.addEventListener('click', (event) => {
        event.stopPropagation()
        const index = Number(row.dataset.row)
        this.toggleSelection(index)
      })
      row.appendChild(el('div', { class: 'td td-check' }, check))
    }
    for (const column of this.options.columns) {
      row.appendChild(el('div', { class: `td${column.align === 'right' ? ' num' : ''}` }))
    }
    row.addEventListener('click', (event) => {
      const index = Number(row.dataset.row)
      if (event.ctrlKey || event.metaKey) this.toggleSelection(index)
      else this.options.onOpen(index)
    })
    return row
  }

  private fillRow(node: HTMLElement, row: number, top: number): void {
    node.dataset.row = String(row)
    node.style.transform = `translateY(${top}px)`
    node.classList.toggle('selected', this.selected.has(row))
    node.classList.toggle('active', this.active === row)
    const offset = this.options.maxSelection !== undefined ? 1 : 0
    if (offset === 1) {
      const check = node.children[0]?.firstChild
      if (check instanceof HTMLInputElement) check.checked = this.selected.has(row)
    }
    this.options.columns.forEach((column, index) => {
      const cell = node.children[index + offset]
      if (!(cell instanceof HTMLElement)) return
      const value = column.value(row)
      const text = column.format ? column.format(value, row) : defaultFormat(value)
      cell.textContent = text
      cell.title = text
    })
  }

  private toggleSelection(row: number): void {
    if (this.selected.has(row)) this.selected.delete(row)
    else {
      const max = this.options.maxSelection ?? 0
      if (this.selected.size >= max) {
        // Drop the oldest so a third click re-targets rather than silently
        // doing nothing — two-genome selection is how the pair view is reached.
        const first = this.selected.values().next().value
        if (first !== undefined) this.selected.delete(first)
      }
      this.selected.add(row)
    }
    this.options.onSelect?.([...this.selected])
    this.paint()
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.visible.length === 0) return
    const position = this.visible.indexOf(this.active)
    let next = position
    switch (event.key) {
      case 'ArrowDown':
        next = position + 1
        break
      case 'ArrowUp':
        next = position - 1
        break
      case 'PageDown':
        next = position + 10
        break
      case 'PageUp':
        next = position - 10
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = this.visible.length - 1
        break
      case 'Enter':
        if (this.active >= 0) this.options.onOpen(this.active)
        return
      case ' ':
        if (this.active >= 0 && this.options.maxSelection !== undefined) {
          event.preventDefault()
          this.toggleSelection(this.active)
        }
        return
      default:
        return
    }
    event.preventDefault()
    next = Math.min(Math.max(next, 0), this.visible.length - 1)
    this.active = this.visible[next]
    const top = next * this.options.rowHeight
    const bottom = top + this.options.rowHeight
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top
    else if (bottom > this.viewport.scrollTop + this.viewport.clientHeight) {
      this.viewport.scrollTop = bottom - this.viewport.clientHeight
    }
    this.paint()
  }
}

function defaultFormat(value: string | number | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : ''
  return value
}

/**
 * Compile a numeric filter box. Returns `null` for an expression that does not
 * parse, which leaves the column unfiltered rather than emptying the table
 * while the user is still typing `>`.
 */
export function numberFilter(expression: string): ((value: string | number | undefined) => boolean) | null {
  const range = /^(-?[\d.eE+]+)\.\.(-?[\d.eE+]+)$/.exec(expression)
  if (range !== null) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    if (Number.isNaN(lo) || Number.isNaN(hi)) return null
    return (value) => isNumber(value) && value >= lo && value <= hi
  }
  const comparison = /^(>=|<=|!=|>|<|=)?\s*(-?[\d.eE+]+)$/.exec(expression)
  if (comparison === null) return null
  const operator = comparison[1] ?? '='
  const bound = Number(comparison[2])
  if (Number.isNaN(bound)) return null
  return (value) => {
    if (!isNumber(value)) return false
    switch (operator) {
      case '>':
        return value > bound
      case '>=':
        return value >= bound
      case '<':
        return value < bound
      case '<=':
        return value <= bound
      case '!=':
        return value !== bound
      default:
        return value === bound
    }
  }
}

/** Compile a text filter box: `/regex/`, `!substring`, or a plain substring. */
export function stringFilter(expression: string): ((value: string | number | undefined) => boolean) | null {
  const regex = /^\/(.*)\/([a-z]*)$/.exec(expression)
  if (regex !== null) {
    try {
      const compiled = new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`)
      return (value) => value !== undefined && compiled.test(String(value))
    } catch {
      return null
    }
  }
  if (expression.startsWith('!')) {
    const needle = expression.slice(1).toLowerCase()
    // Missing still fails: a filter selects rows it can vouch for, even negated.
    return (value) => value !== undefined && !String(value).toLowerCase().includes(needle)
  }
  const needle = expression.toLowerCase()
  return (value) => value !== undefined && String(value).toLowerCase().includes(needle)
}

function isNumber(value: string | number | undefined): value is number {
  return typeof value === 'number' && !Number.isNaN(value)
}
