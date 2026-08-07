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

import { icon } from './icons'
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
  /**
   * Show the leading checkbox column, and let any number of rows be ticked.
   *
   * It used to be `maxSelection: 2`, because the only thing a selection could
   * do was open the pair view and a third tick had to drop the oldest. A
   * selection is now a picture of however many rows are in it, so the cap has
   * no meaning and its silent eviction would be a bug.
   */
  selectable?: boolean
  /** Columns the free-text box searches; defaults to every string column. */
  searchKeys?: string[]
  searchPlaceholder?: string
  emptyMessage?: string
  /**
   * Save and restore the filter/sort/search state across navigation.
   *
   * The table calls `save` whenever the state changes and reads `initial` once
   * at construction. It lives outside the table because *where* to keep it (per
   * file, per scope) is the caller's question — see `state/UiMemory`.
   */
  persistence?: {
    initial: TableUiState | null
    save(state: TableUiState): void
  }
}

/** The user-typed table state that survives leaving the view and coming back. */
export interface TableUiState {
  filters: Record<string, string>
  search: string
  sortKey: string | null
  sortDir: 1 | -1
}

type Predicate = (row: number) => boolean

const OVERSCAN = 6

/**
 * One collator for every string comparison in every table.
 *
 * `String.prototype.localeCompare` constructs a collator per call. Hoisting it
 * is the single largest win in the sort, and `numeric: true` also gives
 * `NODE_2` before `NODE_10`, which is what a reader of contig names expects.
 */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export class VirtualTable {
  readonly el: HTMLElement

  private readonly options: Required<Pick<VirtualTableOptions, 'rowHeight'>> & VirtualTableOptions
  private readonly filters = new Map<string, string>()
  private readonly selected = new Set<number>()
  private readonly pool: HTMLElement[] = []

  private source: number[]
  private visible: number[] = []
  /** Memoised sort order; see {@link sorted}. */
  private sortCache: { key: string; dir: 1 | -1; source: number[]; order: number[] } | null = null
  /**
   * Position of {@link active} within {@link visible}.
   *
   * Kept rather than searched for: `visible.indexOf(active)` is 154,468
   * comparisons per keypress on the reference file, at the key-repeat rate.
   */
  private activePosition = -1
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private readonly onResize: () => void
  /** Cached sticky-header height; a geometry read per keypress otherwise. */
  private headHeightCache = -1
  /** Lowercased search haystacks, per column key; see {@link lowercased}. */
  private readonly searchCache = new Map<string, Map<number, string>>()
  private sortKey: string | null = null
  private sortDir: 1 | -1 = 1
  private search = ''
  private active = -1

  private readonly viewport: HTMLElement
  /** Intrinsic-width wrapper inside the scroller; keeps header and rows aligned. */
  private readonly grid: HTMLElement
  /** Sticky header block, whose height offsets every row coordinate. */
  private readonly head: HTMLElement
  private readonly body: HTMLElement
  private readonly header: HTMLElement
  private readonly filterRow: HTMLElement
  private readonly status: HTMLElement
  private readonly toolbar: HTMLElement
  /** The filter field, so `/` can reach it — see {@link focusSearch}. */
  private readonly searchBox: HTMLInputElement
  /**
   * The box in the filter row's gutter: tick, or untick, everything showing.
   *
   * Built unconditionally and mounted only when the table is selectable, so
   * {@link syncHeadCheck} has one thing to write to rather than a lookup that
   * may find nothing.
   */
  private readonly headCheck = el('input', {
    class: 'checkbox tf-check-box',
    type: 'checkbox',
  })

  constructor(options: VirtualTableOptions) {
    this.options = { rowHeight: 28, ...options }
    this.source = options.rows

    // Restored state is untrusted: it may have been written by an older build
    // against a file whose columns have since changed, so every field is
    // validated rather than assigned.
    const saved = options.persistence?.initial ?? null
    if (saved !== null) {
      const known = new Set(options.columns.map((column) => column.key))
      for (const [key, value] of Object.entries(saved.filters ?? {})) {
        if (known.has(key) && typeof value === 'string' && value !== '') this.filters.set(key, value)
      }
      if (typeof saved.search === 'string') this.search = saved.search.trim().toLowerCase()
      if (typeof saved.sortKey === 'string' && known.has(saved.sortKey)) {
        this.sortKey = saved.sortKey
        this.sortDir = saved.sortDir === -1 ? -1 : 1
      }
    }

    const template = this.gridTemplate()
    this.status = el('span', { class: 'table-status' })
    const searchBox = el('input', {
      class: 'search',
      type: 'search',
      placeholder: options.searchPlaceholder ?? 'search names…',
    })
    this.searchBox = searchBox
    searchBox.value = this.search
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
      // `.tf-input` rather than every input in the row: the row also holds the
      // select-everything-showing box, and blanking that would be clearing a
      // *selection* from a button that says it clears filters.
      for (const input of this.filterRow.querySelectorAll('.tf-input')) {
        if (!(input instanceof HTMLInputElement)) continue
        input.value = ''
        input.classList.remove('active')
      }
      this.recompute()
    })
    this.toolbar = el('div', { class: 'table-toolbar' }, searchBox, this.status, reset)

    this.headCheck.title =
      'Tick every row the filters are showing, or untick them if they all are. ' +
      'Rows a filter is hiding are left alone.'
    this.headCheck.addEventListener('click', (event) => {
      // The header is inside the scroller and the filter row sits over the
      // columns; a press here is about the selection and nothing else.
      event.stopPropagation()
      this.toggleVisible()
    })

    this.header = el('div', { class: 'thead-row', style: { gridTemplateColumns: template } })
    this.filterRow = el('div', { class: 'tfilter-row', style: { gridTemplateColumns: template } })
    this.buildHeader()
    this.paintSortArrows()

    this.body = el('div', { class: 'tbody' })
    this.head = el('div', { class: 'thead' }, this.header, this.filterRow)

    // The header lives *inside* the scroller, sticky to its top.
    //
    // With the header outside it, a horizontal scroll moved the rows and left
    // the headings behind, so the columns you scrolled to see were unlabelled —
    // which is the one moment you need the labels. One scroll container makes
    // horizontal movement shared and vertical stickiness automatic; `.tgrid`
    // carries the intrinsic width so both stay aligned when the columns
    // overflow.
    this.grid = el(
      'div',
      { class: 'tgrid' },
      this.head,
      this.body,
    )
    this.viewport = el(
      'div',
      { class: 'tviewport', attrs: { tabindex: '0', role: 'grid' } },
      this.grid,
    )
    this.viewport.addEventListener('scroll', () => this.paint())
    // The header can re-wrap at a different width, which is the one thing that
    // changes its height without going through `recompute`.
    this.onResize = () => {
      this.headHeightCache = -1
    }
    window.addEventListener?.('resize', this.onResize)
    this.viewport.addEventListener('keydown', (event) => this.onKeyDown(event))

    this.el = el('div', { class: 'table' }, this.toolbar, this.viewport)

    this.recompute()
    // The viewport has no height until it is in the document; repaint once the
    // browser has laid it out so the first screen is not blank.
    requestAnimationFrame(() => this.paint())
  }

  /**
   * Release the resize listener and write out any pending filter state.
   *
   * The flush is the point: {@link persistLater} coalesces a burst of typing
   * into one `sessionStorage` write, and a user who types a filter and
   * immediately clicks a row would otherwise leave before it landed and come
   * back to an unfiltered table.
   */
  destroy(): void {
    window.removeEventListener?.('resize', this.onResize)
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
      this.persist()
    }
  }

  /**
   * Put the caret in the filter field — the `/` key.
   *
   * A table's box is a filter rather than a place to type a coordinate, but it
   * is the same gesture and the same question: *where is the thing I am after*.
   * One key for both is what makes it worth having.
   */
  focusSearch(): void {
    this.searchBox.focus()
    this.searchBox.select()
  }

  /** Extra controls placed in the toolbar by the owning view. */
  addToolbarItem(node: HTMLElement): void {
    this.toolbar.appendChild(node)
  }

  /** Replace the candidate rows (used when the underlying table changes). */
  setRows(rows: number[]): void {
    this.source = rows
    this.selected.clear()
    this.searchCache.clear()
    this.sortCache = null
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

  /**
   * Tick or untick everything the reader can currently see — the filtered,
   * searched set, and never the whole file.
   *
   * That is what makes the control worth having: filter to completeness above
   * 90, then take all of them. Rows a filter is hiding are left exactly as they
   * were, in both directions, because the box sits in the header of the column
   * it applies to and what that column is showing is what it can honestly speak
   * for. Emptying the selection outright is a different question and has its own
   * button beside the table.
   *
   * The direction is decided by what is on screen, which is the behaviour every
   * header checkbox has: all of them ticked means the press unticks, anything
   * less means it ticks the rest.
   */
  toggleVisible(): void {
    const all = this.allVisibleSelected()
    for (const row of this.visible) {
      if (all) this.selected.delete(row)
      else this.selected.add(row)
    }
    this.options.onSelect?.([...this.selected])
    this.paint()
  }

  /** `true` when every visible row is ticked — and there is one to tick. */
  private allVisibleSelected(): boolean {
    return this.visible.length > 0 && this.visible.every((row) => this.selected.has(row))
  }

  private gridTemplate(): string {
    const tracks = this.options.columns.map((column) => column.width ?? 'minmax(6rem, 1fr)')
    if (this.options.selectable === true) tracks.unshift('2rem')
    return tracks.join(' ')
  }

  private buildHeader(): void {
    if (this.options.selectable === true) {
      this.header.appendChild(el('div', { class: 'th th-check', text: '' }))
      // In the **filter** row, not the label row, and that is where it belongs:
      // it selects what the filters left, so it sits on the line the filters are
      // on, in the gutter directly above the boxes it ticks. In the label row it
      // would have read as a heading for the column of checkboxes — a thing to
      // sort by — which is what a box in a `<th>` looks like.
      this.filterRow.appendChild(el('div', { class: 'tf tf-check' }, this.headCheck))
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
      const restored = this.filters.get(column.key)
      if (restored !== undefined) {
        input.value = restored
        input.classList.add('active')
      }
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
    this.paintSortArrows()
    this.recompute()
  }

  /** Reflect `sortKey`/`sortDir` in the header, including a restored sort. */
  private paintSortArrows(): void {
    for (const [index, cell] of [...this.header.querySelectorAll('.th')].entries()) {
      const offset = this.options.selectable === true ? 1 : 0
      const column = this.options.columns[index - offset]
      const arrow = cell.querySelector('.sort-arrow')
      if (arrow === null || column === undefined) continue
      if (this.sortKey !== column.key) arrow.replaceChildren()
      else arrow.replaceChildren(icon(this.sortDir === 1 ? 'chevron-up' : 'chevron-down', { size: 13 }))
    }
  }

  /** Queue a {@link persist}, coalescing a burst of typing into one write. */
  private persistLater(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persist()
    }, 500)
  }

  /** Hand the user-typed state to the caller's store, if there is one. */
  private persist(): void {
    this.options.persistence?.save({
      filters: Object.fromEntries(this.filters),
      search: this.search,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
    })
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
      // Lowercased once per column, not once per row per keystroke: 154,468
      // fresh strings per recompute, at up to eight recomputes a second while
      // typing, is ~31 MB/s of garbage for a comparison that never changes.
      const haystacks = columns.map((column) => this.lowercased(column))
      list.push((row) => haystacks.some((byRow) => byRow.get(row)?.includes(needle) === true))
    }
    return list
  }

  /**
   * The source rows in sort order, computed once per (column, direction).
   *
   * Two things were wrong with sorting inside `recompute`. It ran on **every
   * debounced keystroke** — typing an eight-character prefix with a name sort
   * active re-sorted eight times — and it sorted through the comparator, which
   * called `column.value(row)` twice per comparison and `localeCompare` once.
   * For 154,468 contigs that is ~2.7 M comparisons: 5.3 M closure calls and
   * 2.7 M collations, on the main thread, per keystroke.
   *
   * Decorate-sort-undecorate fixes the first half: the keys are extracted once,
   * `n` calls instead of `2n log n`. A single shared `Intl.Collator` fixes the
   * second — `String.prototype.localeCompare` builds a collator per call, which
   * is where most of the time went. And caching the result by sort key fixes the
   * third, so filtering is a stable pass over an order that already exists.
   */
  private sorted(): number[] {
    const key = this.sortKey
    if (key === null) return this.source
    if (this.sortCache !== null && this.sortCache.key === key && this.sortCache.dir === this.sortDir) {
      if (this.sortCache.source === this.source) return this.sortCache.order
    }
    const column = this.options.columns.find((c) => c.key === key)
    if (column === undefined) return this.source

    const dir = this.sortDir
    const numeric = column.kind === 'number'
    const n = this.source.length
    // One pass for the values, so `value()` is called once per row.
    const values: Array<string | number | undefined> = new Array<string | number | undefined>(n)
    const missing = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const v = column.value(this.source[i])
      values[i] = v
      // Missing sorts last regardless of direction: a blank taxonomy is not
      // "smaller" than a filled one, it is absent.
      missing[i] = v === undefined || (numeric && Number.isNaN(v as number)) ? 1 : 0
    }
    const order = Array.from({ length: n }, (_, i) => i)
    order.sort((a, b) => {
      if (missing[a] !== 0 || missing[b] !== 0) {
        return missing[a] !== 0 && missing[b] !== 0 ? 0 : missing[a] !== 0 ? 1 : -1
      }
      if (numeric) return ((values[a] as number) - (values[b] as number)) * dir
      return COLLATOR.compare(String(values[a]), String(values[b])) * dir
    })
    const rows = order.map((i) => this.source[i])
    this.sortCache = { key, dir, source: this.source, order: rows }
    return rows
  }

  /** A column's values, lowercased, built once per column and kept. */
  private lowercased(column: ColumnDef): Map<number, string> {
    let cached = this.searchCache.get(column.key)
    if (cached === undefined) {
      cached = new Map<number, string>()
      for (const row of this.source) {
        const value = column.value(row)
        if (value !== undefined) cached.set(row, String(value).toLowerCase())
      }
      this.searchCache.set(column.key, cached)
    }
    return cached
  }

  private recompute(): void {
    const tests = this.predicates()
    // Filtering a sorted array preserves its order, so the sort happens once
    // per column click rather than once per keystroke.
    this.headHeightCache = -1
    const ordered = this.sorted()
    this.visible = tests.length === 0 ? [...ordered] : ordered.filter((row) => tests.every((t) => t(row)))

    const total = this.source.length
    const shown = this.visible.length
    this.status.textContent = shown === total ? `${total.toLocaleString()} rows` : `${shown.toLocaleString()} of ${total.toLocaleString()} rows`
    // Debounced separately and more slowly than the filter it follows:
    // `JSON.stringify` plus a synchronous `sessionStorage.setItem` is not
    // something to do eight times a second while someone types, and nothing
    // reads it until the view is left.
    this.persistLater()
    // The body reserves the full height of the virtual row set; only the rows
    // in view exist as elements.
    this.body.style.height = `${this.visible.length * this.options.rowHeight}px`
    this.viewport.scrollTop = 0
    // The active row's *position* is meaningless in a different visible set.
    this.activePosition = this.active < 0 ? -1 : this.visible.indexOf(this.active)
    this.paint()
  }

  /**
   * Height of the sticky header, cached.
   *
   * Constant while the user scrolls and keys around, and re-read only when the
   * filter row could have changed shape — so a keypress does not force a layout.
   */
  private headHeight(): number {
    if (this.headHeightCache < 0) this.headHeightCache = this.head.offsetHeight
    return this.headHeightCache
  }

  /**
   * The header box against what is on screen: ticked, part-ticked, or empty.
   *
   * `indeterminate` for a partial selection, because "some of these" is a third
   * state and drawing it as either of the other two is a lie a reader acts on —
   * an empty box over four ticked rows reads as "nothing is selected".
   */
  private syncHeadCheck(): void {
    if (this.options.selectable !== true) return
    const all = this.allVisibleSelected()
    const some = !all && this.visible.some((row) => this.selected.has(row))
    this.headCheck.checked = all
    this.headCheck.indeterminate = some
  }

  private paint(): void {
    this.syncHeadCheck()
    const { rowHeight } = this.options
    const height = this.viewport.clientHeight || 400
    // The sticky header scrolls with the content, so it occupies the first
    // `head.offsetHeight` pixels of `scrollTop`; row 0 begins after it.
    const scrolled = Math.max(0, this.viewport.scrollTop - this.headHeight())
    const first = Math.max(0, Math.floor(scrolled / rowHeight) - OVERSCAN)
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
    if (this.options.selectable === true) {
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
    const offset = this.options.selectable === true ? 1 : 0
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
    else this.selected.add(row)
    this.options.onSelect?.([...this.selected])
    this.paint()
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.visible.length === 0) return
    // `activePosition` rather than `visible.indexOf(this.active)`: the linear
    // scan was 154,468 comparisons per keypress at reference scale, repeated at
    // the key-repeat rate.
    const position = this.activePosition
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
        if (this.active >= 0 && this.options.selectable === true) {
          event.preventDefault()
          this.toggleSelection(this.active)
        }
        return
      default:
        return
    }
    event.preventDefault()
    next = Math.min(Math.max(next, 0), this.visible.length - 1)
    this.activePosition = next
    this.active = this.visible[next]
    // Row coordinates are relative to the body, which starts below the sticky
    // header; scroll positions are relative to the scroller. Hence the offset,
    // and hence keeping the row clear of the header rather than under it.
    const headHeight = this.headHeight()
    const top = next * this.options.rowHeight + headHeight
    const bottom = top + this.options.rowHeight
    if (top - headHeight < this.viewport.scrollTop) this.viewport.scrollTop = top - headHeight
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
