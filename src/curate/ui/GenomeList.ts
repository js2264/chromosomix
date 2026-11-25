/**
 * The curation stage's genome list (SPECS §33.3): the MAGs, the elements and
 * the unbinned pool, each a section, every genome a row that opens on its
 * contigs. A virtual list — only the rows in view are elements — over the rows
 * `curate/listRows.ts` decides, so twenty thousand contigs scroll as smoothly as
 * fifty genomes.
 *
 * One selection with the pictures: a press selects a row, ⌘/Ctrl toggles one,
 * ⇧ extends; ↑ ↓ walk the rows, → opens a genome, ← closes it or climbs to it,
 * Home and End go to the first and last row, F2 renames, ⌘A selects every row
 * shown — Enter is the stage's close-up. A row dragged is the selection when it
 * is in it, and drops on a genome's row or one of its contigs (*into it*), a
 * section's head (*a new one*, *of that kind*) or the pool (*out*).
 */

import { el } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { keyLabel, withKey } from '../../ui/commands'
import { TAB_WALKS, tabStep } from '../../ui/tabWalk'
import { fmt } from '../../units'
import { changeChip, changeWords, counted, curationChanges, type CurationChanges } from '../changes'
import { redundancyText } from '../price'
import { contigShortName } from '../names'
import { listRows, readFilter, rowKey, type GenomeSort, type ListChip, type ListRow, type ListRows, type ListSection, type PoolSort } from '../listRows'
import { affinityText } from '../method'
import { displayPercent, type CurateChange } from '../model'
import type { Suggestion } from '../suggest'
import type { CurationStateResult } from '../../worker/curateProtocol'
import type { CurateContext, CurateFrame } from './context'
import { grade } from './grade'

/** A row's height, in CSS pixels. */
export const LIST_ROW = 28
/** Lists made, for their rows' ids. */
let lists = 0
/** Rows drawn past each edge of the view. */
const OVERSCAN = 8
/** How far a press moves before it is a drag. */
const DRAG_PX = 4

/** What the list keeps of one answer: counted once per answer. */
interface Derived {
  answer: CurationStateResult
  changes: CurationChanges
  /** Suggestions on offer naming each genome. */
  suggested: Int32Array
  /** Whether each genome wears a change chip: what the *changed* chip keeps. */
  changed: boolean[]
  /** Each contig's best suggestion on offer that would move it, if any. */
  best: Map<number, Suggestion>
  likeliness: Float64Array
}

const SECTION_WORD: Record<ListSection, string> = { mags: 'MAGs', elements: 'elements', pool: 'unbinned' }

const CHIPS: ReadonlyArray<{ chip: ListChip; label: string; title: string }> = [
  { chip: 'changed', label: 'changed', title: 'Only the genomes the curation changed.' },
  { chip: 'suggested', label: 'suggested', title: 'Only what a suggestion on offer names.' },
  { chip: 'complete', label: '≥ 50%', title: 'Only the MAGs at least half complete, by the weighted completeness.' },
  { chip: 'redundant', label: 'redundant', title: 'Only the MAGs whose weighted redundancy is above 1.10.' },
  { chip: 'unhosted', label: 'no host', title: 'Only the elements linked to no MAG.' },
]

const SORTS: ReadonlyArray<{ sort: GenomeSort; label: string }> = [
  { sort: 'order', label: 'as on the map' },
  { sort: 'length', label: 'length' },
  { sort: 'completeness', label: 'completeness' },
  { sort: 'redundancy', label: 'redundancy' },
  { sort: 'contigs', label: 'contigs' },
  { sort: 'suggestions', label: 'suggestions' },
  { sort: 'name', label: 'name' },
]

export class GenomeList {
  readonly element: HTMLElement
  private readonly scroller: HTMLElement
  private readonly spacer: HTMLElement
  private readonly sticky: HTMLElement
  private readonly filterBox: HTMLInputElement
  private readonly filterNote: HTMLElement
  private readonly chipRow: HTMLElement
  private readonly sortSelect: HTMLSelectElement
  private readonly poolSelect: HTMLSelectElement
  private derived: Derived | null = null
  private rows: ListRows = { rows: [], missing: [], found: { genomes: [], contigs: [] } }
  private readonly open = new Set<string>()
  /** Genomes the filter opened on their contigs and the reader closed; forgotten with the filter. */
  private readonly closed = new Set<string>()
  /**
   * Genomes a frame opened on the contigs it shows — review's question, a
   * card's suggestion —, closed again by the next frame and by a change of
   * mode, as the filter's openings close with the filter; the reader's own
   * once they open or close one themselves.
   */
  private readonly framed = new Set<string>()
  private filterText = ''
  private readonly folded = new Set<ListSection>()
  private genomeSort: GenomeSort = 'order'
  private poolSort: PoolSort = 'likeliest'
  private readonly chips = new Set<ListChip>()
  /** Rows drawn, by key. */
  private readonly drawn = new Map<string, HTMLElement>()
  /** The row the keyboard is on, by key, and the row a ⇧-press extends from. */
  private active: string | null = null
  /** Where the keyboard's row was: ↓ goes on from there when its row has gone. */
  private activeAt = -1
  private anchor: string | null = null
  private renaming: { id: string; input: HTMLInputElement; cancel: () => void } | null = null
  /** This list's own, so two lists' rows never share an id. */
  private readonly uid = ++lists
  private press: { x: number; y: number; row: ListRow; pointer: number } | null = null
  private frame = 0
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly ctx: CurateContext) {
    this.filterBox = el('input', {
      class: 'curate-filter',
      type: 'search',
      placeholder: 'filter genomes and contigs…',
      title: withKey('Part of a name, a /pattern/, or a pasted list of names', '/'),
      attrs: { 'aria-label': 'Filter genomes and contigs', spellcheck: 'false' },
      on: { input: () => this.recompute() },
      // Each row an id, for the tree's active descendant.
    })
    this.filterNote = el('div', { class: 'curate-filter-note hidden', attrs: { role: 'status' } })
    this.chipRow = el('div', { class: 'curate-chips', attrs: { role: 'group', 'aria-label': 'Show only' } })
    for (const { chip, label, title } of CHIPS) {
      const button = el('button', {
        class: 'btn btn-toggle btn-chip',
        text: label,
        title,
        attrs: { type: 'button', 'aria-pressed': 'false', 'data-chip': chip },
        on: {
          click: () => {
            if (this.chips.has(chip)) this.chips.delete(chip)
            else this.chips.add(chip)
            button.setAttribute('aria-pressed', String(this.chips.has(chip)))
            this.recompute()
          },
        },
      })
      this.chipRow.appendChild(button)
    }
    this.sortSelect = el('select', {
      class: 'curate-sort',
      title: 'How the MAGs and the elements are sorted; the pictures keep the map’s order',
      attrs: { 'aria-label': 'Sort the genomes by' },
      on: {
        change: () => {
          this.genomeSort = this.sortSelect.value as GenomeSort
          this.recompute()
        },
      },
    })
    for (const { sort, label } of SORTS) this.sortSelect.appendChild(el('option', { text: label, value: sort }))
    this.poolSelect = el('select', {
      class: 'curate-sort',
      title: 'How the unbinned contigs are sorted',
      attrs: { 'aria-label': 'Sort the unbinned contigs by' },
      on: {
        change: () => {
          this.poolSort = this.poolSelect.value as PoolSort
          this.recompute()
        },
      },
    })
    for (const [value, label] of [
      ['likeliest', 'likeliest first'],
      ['length', 'length'],
      ['name', 'name'],
    ] as const)
      this.poolSelect.appendChild(el('option', { text: label, value }))
    const sorts = el(
      'div',
      { class: 'curate-sorts' },
      el('label', { class: 'curate-sort-label' }, el('span', { text: 'sort' }), this.sortSelect),
      el('label', { class: 'curate-sort-label' }, el('span', { text: 'pool' }), this.poolSelect),
    )
    this.spacer = el('div', { class: 'curate-list-spacer' })
    this.scroller = el('div', {
      class: 'curate-list-scroll',
      attrs: { role: 'tree', 'aria-label': 'Genomes', 'aria-multiselectable': 'true', tabindex: '0' },
      on: {
        scroll: () => this.schedule(),
        keydown: (event: KeyboardEvent) => {
          if (this.key(event)) {
            event.preventDefault()
            event.stopPropagation()
          }
        },
        pointerleave: () => this.leave(),
      },
    })
    this.scroller.appendChild(this.spacer)
    this.sticky = el('div', {
      class: 'curate-list-sticky curate-row-section hidden',
      attrs: { 'aria-hidden': 'true' },
      on: {
        pointerdown: (event: PointerEvent) => {
          if (event.button !== 0 || this.stickySection === null) return
          event.preventDefault()
          const section = this.stickySection
          this.toggleFold(section)
          // The section folded stays in view, its head where the reader pressed it.
          const k = this.rows.rows.findIndex((row) => row.kind === 'section' && row.section === section)
          if (k >= 0) {
            this.scroller.scrollTop = k * LIST_ROW
            this.schedule()
          }
        },
        // It stands over the list, not in it: the wheel on it scrolls the list.
        wheel: (event: WheelEvent) => {
          this.scroller.scrollTop += event.deltaY
        },
      },
    })
    // Three drop targets that never scroll away: what is held dropped here makes
    // a new MAG, a new element, or goes to the pool.
    const dock = el(
      'div',
      { class: 'curate-dock', attrs: { 'aria-label': 'Drop here' } },
      el('div', { class: 'curate-dock-target', text: '+ MAG', title: 'Drop contigs here for a new MAG of them, or genomes to make them MAGs', attrs: { 'data-drop-section': 'mags' } }),
      el('div', { class: 'curate-dock-target', text: '+ element', title: 'Drop contigs here for a new element of them, or genomes to make them elements', attrs: { 'data-drop-section': 'elements' } }),
      el('div', { class: 'curate-dock-target', text: 'unbinned', title: 'Drop contigs here to unbin them, or genomes to dissolve them', attrs: { 'data-drop-section': 'pool' } }),
    )
    this.element = el(
      'section',
      { class: 'curate-list', attrs: { 'data-pane': 'list' } },
      el('div', { class: 'curate-list-head' }, this.filterBox, this.filterNote, this.chipRow, sorts),
      el('div', { class: 'curate-list-body' }, this.scroller, this.sticky),
      dock,
    )
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.unsubscribe.push(ctx.onFrame((target) => this.frameOn(target)))
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.schedule())
      observer.observe(this.scroller)
      this.unsubscribe.push(() => observer.disconnect())
    }
    this.recompute()
  }

  /** Put the keyboard in the list, on its active row. */
  focus(): void {
    this.scroller.focus({ preventScroll: true })
  }

  /** Put the caret in the filter box. */
  focusFilter(): void {
    this.filterBox.focus()
    this.filterBox.select()
  }

  /** Whether an element is in the list: the stage routes its keys here first. */
  contains(node: EventTarget | null): boolean {
    return node instanceof Node && this.element.contains(node)
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    for (const off of this.unsubscribe) off()
  }

  // -------------------------------------------------------------------------
  // What changed.
  // -------------------------------------------------------------------------

  update(change: CurateChange): void {
    switch (change) {
      case 'mode':
        // Review left, or entered: what its frames opened closes (the next
        // question's frame opens its own).
        this.closeFramed()
        this.recompute()
        return
      case 'state':
      case 'current':
        this.recompute()
        return
      case 'selection':
      case 'hover':
        this.restyle()
        return
      default:
        return
    }
  }

  private derive(): Derived | null {
    const answer = this.ctx.model.answer
    if (answer === null) return null
    if (this.derived?.answer === answer) return this.derived
    const offered = this.ctx.model.offered()
    const suggested = new Int32Array(answer.genomes.length)
    const best = new Map<number, Suggestion>()
    const likeliness = new Float64Array(answer.genomeOf.length)
    for (const s of offered) {
      for (const g of s.genomes) if (g >= 0 && g < suggested.length) suggested[g]++
      if (s.kind !== 'recruit' && s.kind !== 'move') continue
      for (const c of s.contigs) {
        const held = best.get(c)
        if (held === undefined || s.confidence > held.confidence) best.set(c, s)
        if (s.confidence > likeliness[c]) likeliness[c] = s.confidence
      }
    }
    const changes = curationChanges(answer, this.ctx.data.file)
    this.derived = { answer, changes, suggested, changed: changes.genomes.map((change) => changeChip(change) !== null), best, likeliness }
    return this.derived
  }

  /** The rows again: after a count, a filter, a sort, a chip, a fold. */
  private recompute(): void {
    const derived = this.derive()
    if (derived === null) {
      this.rows = { rows: [], missing: [], found: { genomes: [], contigs: [] } }
      this.paintNote()
      this.schedule(true)
      return
    }
    const { file } = this.ctx.data
    if (this.filterBox.value !== this.filterText) {
      this.filterText = this.filterBox.value
      this.closed.clear()
    }
    this.rows = listRows({
      answer: derived.answer,
      order: this.ctx.model.order,
      names: file.names,
      lengths: file.lengths,
      open: this.open,
      closed: this.closed,
      changed: derived.changed,
      prefixes: { mag: this.ctx.prefixOf('mag'), element: this.ctx.prefixOf('element') },
      folded: this.folded,
      genomeSort: this.genomeSort,
      poolSort: this.poolSort,
      filter: readFilter(this.filterBox.value),
      chips: this.chips,
      suggested: derived.suggested,
      poolLikeliness: derived.likeliness,
    })
    this.paintNote()
    this.schedule(true)
  }

  private paintNote(): void {
    const filter = readFilter(this.filterBox.value)
    const note = this.filterNote
    if (filter === null) {
      note.classList.add('hidden')
      note.replaceChildren()
      return
    }
    const { genomes, contigs } = this.rows.found
    const found = genomes.length + contigs.length
    const parts: Array<string | HTMLElement> = []
    if (filter.kind === 'invalid') {
      note.replaceChildren(el('span', { class: 'curate-filter-missing', text: `not a pattern: ${filter.reason}` }))
      note.classList.remove('hidden')
      return
    }
    if (filter.kind === 'names') {
      const asked = filter.names.size
      parts.push(`${fmt.int(asked - this.rows.missing.length)} of ${fmt.int(asked)} found`)
      if (this.rows.missing.length > 0) {
        parts.push(
          el('span', {
            class: 'curate-filter-missing',
            text: ` · not found: ${this.rows.missing.slice(0, 3).join(', ')}${this.rows.missing.length > 3 ? '…' : ''}`,
            title: this.rows.missing.join('\n'),
          }),
        )
      }
      const hidden = this.rows.hidden ?? 0
      if (hidden > 0) parts.push(el('span', { class: 'curate-filter-missing', text: ` · ${fmt.int(hidden)} hidden by the chips` }))
    } else parts.push(`${fmt.int(found)} found`)
    if (found > 0) {
      parts.push(' · ')
      parts.push(
        el('button', {
          class: 'btn-link',
          text: 'select them',
          attrs: { type: 'button' },
          on: { click: () => this.selectFound() },
        }),
      )
    }
    note.replaceChildren(...parts)
    note.classList.remove('hidden')
  }

  /** Select what the filter found: the contigs where it found any, else the genomes. */
  private selectFound(): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    const { genomes, contigs } = this.rows.found
    if (contigs.length > 0) this.ctx.model.select({ genomes: [], contigs })
    else this.ctx.model.select({ genomes: genomes.map((g) => answer.genomes[g].id), contigs: [] })
  }

  // -------------------------------------------------------------------------
  // Drawing: the rows in view.
  // -------------------------------------------------------------------------

  /** The row the name is being typed in: kept through every redraw, or the letters typed next would be the stage's keys. */
  private renamingRow(): HTMLElement | null {
    return this.renaming === null ? null : (this.renaming.input.closest('.curate-row') as HTMLElement | null)
  }

  private schedule(rebuild = false): void {
    if (rebuild) {
      const keep = this.renamingRow()
      for (const node of this.drawn.values()) if (node !== keep) node.remove()
      this.drawn.clear()
      if (keep !== null && this.renaming !== null) this.drawn.set(`g:${this.renaming.id}`, keep)
    }
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.draw())
  }

  private draw(): void {
    const rows = this.rows.rows
    this.spacer.style.height = `${rows.length * LIST_ROW}px`
    const top = this.scroller.scrollTop
    const height = this.scroller.clientHeight || 600
    const first = Math.max(0, Math.floor(top / LIST_ROW) - OVERSCAN)
    const last = Math.min(rows.length, Math.ceil((top + height) / LIST_ROW) + OVERSCAN)
    const keep = new Set<string>()
    const typing = this.renamingRow()
    for (let k = first; k < last; k++) {
      const row = rows[k]
      const key = rowKey(row)
      keep.add(key)
      let node = this.drawn.get(key)
      if (node === typing && node !== undefined) continue
      if (node === undefined || node.dataset.at !== String(k)) {
        node?.remove()
        node = this.rowElement(row, k)
        this.drawn.set(key, node)
        this.scroller.appendChild(node)
      }
    }
    for (const [key, node] of this.drawn) {
      if (keep.has(key) || node === typing) continue
      node.remove()
      this.drawn.delete(key)
    }
    // The row being renamed goes where its genome is now, in view or not; its genome gone, the box closes.
    if (typing !== null && this.renaming !== null) {
      const id = this.renaming.id
      const k = rows.findIndex((row) => row.kind === 'genome' && row.id === id)
      if (k < 0) this.renaming.cancel()
      else {
        typing.style.transform = `translateY(${k * LIST_ROW}px)`
        typing.dataset.at = String(k)
      }
    }
    this.restyle()
    this.paintSticky(first + OVERSCAN <= rows.length ? Math.floor(top / LIST_ROW) : 0)
  }

  /** The head of the section the first row in view is in, held at the top once its own row scrolled away. */
  private paintSticky(firstVisible: number): void {
    const rows = this.rows.rows
    let head: Extract<ListRow, { kind: 'section' }> | undefined
    let at = -1
    for (let k = Math.min(firstVisible, rows.length - 1); k >= 0; k--) {
      const row = rows[k]
      if (row.kind === 'section') {
        head = row
        at = k
        break
      }
    }
    if (head === undefined || at === firstVisible || this.scroller.scrollTop <= at * LIST_ROW) {
      this.sticky.classList.add('hidden')
      return
    }
    this.sticky.replaceChildren(...this.sectionContent(head))
    // A head like the one it stands for: a press folds it, a drop on it lands there, not on the row it covers.
    this.sticky.dataset.dropSection = head.section
    this.stickySection = head.section
    this.markHeld(this.sticky, head.section === 'pool' ? this.heldCounts().pool : 0, 0)
    this.sticky.classList.remove('hidden')
  }

  private stickySection: ListSection | null = null

  /** A row's id, for the tree's active descendant. */
  private rowId(row: ListRow): string {
    return `curate-row-${this.uid}-${rowKey(row).replace(/[^A-Za-z0-9_-]/g, '_')}`
  }

  private rowElement(row: ListRow, at: number): HTMLElement {
    const node = el('div', {
      class: `curate-row curate-row-${row.kind}`,
      attrs: {
        role: 'treeitem',
        id: this.rowId(row),
        'data-key': rowKey(row),
        'data-at': String(at),
        // Heads, then genomes and the pool's contigs, then a genome's contigs.
        'aria-level': row.kind === 'section' ? '1' : row.kind === 'contig' && row.genome >= 0 ? '3' : '2',
      },
      style: { transform: `translateY(${at * LIST_ROW}px)` },
    })
    switch (row.kind) {
      case 'section':
        node.append(...this.sectionContent(row))
        node.setAttribute('aria-expanded', String(row.open))
        node.dataset.dropSection = row.section
        break
      case 'genome':
        this.genomeContent(node, row)
        break
      case 'contig':
        this.contigContent(node, row)
        break
    }
    node.addEventListener('pointerdown', (event) => this.pointerDown(event, row))
    node.addEventListener('pointerenter', () => this.hoverRow(row))
    node.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement
      // A double press in the name box selects a word, nothing more.
      if (target.closest('input') !== null) return
      if (row.kind === 'genome' && target.closest('.curate-row-name') !== null) this.startRename(row.id)
      else if (row.kind === 'genome') this.toggleOpen(row.id)
    })
    return node
  }

  private sectionContent(row: Extract<ListRow, { kind: 'section' }>): HTMLElement[] {
    const chevron = icon(row.open ? 'chevron-down' : 'chevron-right', { size: 14, class: 'curate-row-chevron' })
    const word = SECTION_WORD[row.section]
    // One form for every head: the whole, or what is shown of it — `3 of 50`,
    // `0 of 12,785 contigs` — the pool's in contigs, a genome section's in its own word.
    const pool = row.section === 'pool'
    const total = pool ? row.contigs : row.genomes
    const count = row.shown !== total ? `${fmt.int(row.shown)} of ${pool ? counted(total, 'contig') : fmt.int(total)}` : pool ? `${counted(total, 'contig')} · ${fmt.bp(row.length)}` : fmt.int(total)
    const title = el('span', { class: 'curate-section-title', text: word })
    const countNode = el('span', {
      class: 'curate-section-count',
      text: count,
      ...(row.shown !== total ? { title: `${fmt.int(row.shown)} of the ${pool ? counted(total, 'contig') : `${fmt.int(total)} ${word}`} shown: the filter and the chips hide the rest.` } : {}),
    })
    const holder = el('span', { class: 'curate-section-chevron' })
    holder.appendChild(chevron)
    // The prefix every name of the section shares, printed once here: the
    // `…` stands outside the part that gives way, so a prefix cut short
    // still says it is one and keeps what it shows of its own.
    const prefix = pool ? '' : this.ctx.prefixOf(row.section === 'mags' ? 'mag' : 'element')
    const prefixNode =
      prefix === ''
        ? null
        : el('span', { class: `curate-section-prefix${row.section === 'mags' ? ' is-mags' : ''}`, title: `Every name here begins ${prefix}` }, el('span', { class: 'curate-section-prefix-text', text: prefix }), '…')
    if (prefix !== '') title.title = `Every name here begins ${prefix}`
    // What a selection of contigs holds of the pool, filled by `restyle`.
    const held = pool ? el('span', { class: 'edit-chip curate-row-held' }) : null
    if (row.section !== 'mags') return [holder, title, ...(prefixNode === null ? [] : [prefixNode]), ...(held === null ? [] : [held]), countNode]
    // The MAGs' numbers named, in their order on a row: the count beside the title, the legend at the right.
    countNode.classList.add('is-beside')
    const legend = el('span', {
      class: 'curate-section-legend',
      text: 'length · complete · redundant',
      title: 'A MAG’s length, and its completeness and redundancy weighted by its markers, as miComplete gives them: 1.00 is every marker once; past 1.05 a MAG is no longer high quality, past 1.10 contaminated, and a third decimal shows near those bounds.',
    })
    return prefixNode === null ? [holder, title, countNode, legend] : [holder, title, countNode, prefixNode, legend]
  }

  private genomeContent(node: HTMLElement, row: Extract<ListRow, { kind: 'genome' }>): void {
    const derived = this.derived
    if (derived === null) return
    const genome = derived.answer.genomes[row.genome]
    node.dataset.dropGenome = genome.id
    node.dataset.genome = genome.id
    node.setAttribute('aria-expanded', String(row.open))
    const colour = this.ctx.colourOf(genome.id)
    const disclosure = el('button', {
      class: 'curate-row-disclosure',
      title: row.open ? 'Hide its contigs' : 'Show its contigs',
      attrs: { type: 'button', tabindex: '-1', 'aria-label': row.open ? 'Hide its contigs' : 'Show its contigs' },
      on: {
        click: (event: MouseEvent) => {
          event.stopPropagation()
          this.toggleOpen(genome.id)
        },
      },
    })
    disclosure.appendChild(icon(row.open ? 'chevron-down' : 'chevron-right', { size: 13 }))
    const swatch = el('span', { class: `curate-swatch curate-swatch-${genome.kind}`, attrs: { 'aria-hidden': 'true' } })
    swatch.style.setProperty('--swatch', colour.css)
    const change = derived.changes.genomes[row.genome]
    const chip = changeChip(change)
    node.classList.toggle('has-change', chip !== null)
    const name = el('span', { class: 'curate-row-name', text: this.ctx.shortName(genome.id), title: `${genome.name} · ${counted(genome.contigs, 'contig')} · ${fmt.bp(genome.length)}` })
    const parts: Array<HTMLElement | null> = [
      disclosure,
      swatch,
      name,
      // How many of its contigs are selected, a lasso's among them: filled by `restyle`.
      el('span', { class: 'edit-chip curate-row-held' }),
      chip === null ? null : el('span', { class: 'edit-chip curate-change', text: chip, title: changeWords(change) }),
      el('span', { class: 'curate-row-length', text: fmt.bp(genome.length) }),
    ]
    if (genome.kind === 'mag') {
      const q = genome.quality
      // No markers: a dash, and the redundancy's room kept, so the discs stay in one column.
      if (q === null) parts.push(el('span', { class: 'curate-row-quality is-none', text: '—', title: 'No marker genes stored for its contigs.' }), el('span', { class: 'curate-row-redundant' }))
      else {
        const g = grade(q.weightedCompleteness, q.weightedRedundancy)
        const bar = el('span', { class: 'curate-bar', attrs: { 'aria-hidden': 'true' } })
        const fill = el('span', { class: `curate-bar-fill${g === 'high' ? ' is-high' : ''}` })
        fill.style.width = `${Math.max(0, Math.min(1, q.weightedCompleteness)) * 100}%`
        bar.appendChild(fill)
        const title = `${fmt.pct(q.weightedCompleteness, 1)} complete and ${fmt.fixed(q.weightedRedundancy, 3)} redundant, weighted (${q.set}); ${fmt.pct(q.completeness, 1)} and ${fmt.fixed(q.redundancy, 3)} unweighted; ${q.present} of ${q.markers} markers${g === null ? '' : ` · ${g === 'contaminated' ? 'contaminated' : `${g} quality`}`}`
        parts.push(
          // The percentage over its bar, which takes no width of its own: `--ok` at high quality.
          el('span', { class: 'curate-row-quality', title }, el('span', { class: 'curate-row-complete', text: fmt.pct(q.weightedCompleteness, 0) }), bar),
          el('span', { class: `curate-row-redundant${q.weightedRedundancy > 1.1 ? ' is-warn' : ''}`, text: redundancyText(q.weightedRedundancy), title }),
        )
      }
    } else {
      const links = derived.answer.links.filter((link) => link.element === genome.id)
      const hosts = links.map((link) => this.ctx.shortName(link.mag))
      // The title keeps the whole name, as titles do (§33.3).
      const whole = links.map((link) => derived.answer.genomes.find((g) => g.id === link.mag)?.name ?? link.mag)
      const text = hosts.length === 0 ? 'no host' : hosts.length === 1 ? `→ ${hosts[0]}` : `${hosts.length} hosts`
      parts.push(el('span', { class: `curate-row-hosts${hosts.length === 0 ? ' is-faint' : ''}`, text, title: hosts.length === 0 ? 'Linked to no MAG.' : `Hosted by ${whole.join(', ')}.` }))
    }
    const n = derived.suggested[row.genome]
    parts.push(
      n > 0
        ? el('button', {
            class: 'curate-row-suggested',
            text: String(n),
            title: `${counted(n, 'suggestion')} on offer name it: select it and show it`,
            attrs: { type: 'button', tabindex: '-1' },
            on: {
              click: (event: MouseEvent) => {
                event.stopPropagation()
                this.ctx.model.selectGenomes([genome.id])
                this.ctx.frame({ genomes: [genome.id] })
              },
            },
          })
        : el('span', { class: 'curate-row-suggested is-none' }),
    )
    for (const part of parts) if (part !== null) node.appendChild(part)
  }

  private contigContent(node: HTMLElement, row: Extract<ListRow, { kind: 'contig' }>): void {
    const derived = this.derived
    if (derived === null) return
    const { file, gc } = this.ctx.data
    const c = row.contig
    node.dataset.contig = String(c)
    if (row.genome < 0) node.classList.add('is-pooled')
    // A contig's row takes a drop as its genome's does, a pool contig's as the pool's.
    if (row.genome < 0) node.dataset.dropSection = 'pool'
    else {
      const id = derived.answer.genomes[row.genome]?.id
      if (id !== undefined) node.dataset.dropGenome = id
    }
    const name = file.names[c] ?? `#${c}`
    const parts: HTMLElement[] = [
      el('span', { class: 'curate-row-indent' }),
      // An assembler's name without the length the row prints beside it: the whole in the title.
      el('span', { class: 'curate-row-name', text: contigShortName(name), title: `${name} · ${fmt.bp(file.lengths[c] ?? 0)}${gc !== null && Number.isFinite(gc[c]) ? ` · GC ${gc[c].toFixed(0)}%` : ''}` }),
      el('span', { class: 'curate-row-length', text: fmt.bp(file.lengths[c] ?? 0) }),
    ]
    if (gc !== null) parts.push(el('span', { class: 'curate-row-gc', text: Number.isFinite(gc[c]) ? `GC ${gc[c].toFixed(0)}%` : '' }))
    const best = derived.best.get(c)
    const was = derived.changes.fileGenomeOf[c]
    const now = derived.answer.genomeOf[c] < 0 ? null : derived.answer.genomes[derived.answer.genomeOf[c]].id
    node.classList.toggle('has-offer', best !== undefined)
    if (best !== undefined) {
      const target = best.genomes[0] === undefined ? '' : this.ctx.shortName(derived.answer.genomes[best.genomes[0]]?.id ?? '')
      parts.push(el('span', { class: 'curate-row-offer', text: `→ ${target} ${Math.min(99, Math.round(best.confidence * 100))}%`, title: best.words }))
    } else if (was !== now) {
      const from = was === null ? 'from the pool' : `from ${this.fileName(was)}`
      parts.push(el('span', { class: 'curate-row-moved', text: from, title: `In ${was === null ? 'no genome' : this.wholeName(was)} in the file.` }))
    }
    node.append(...parts)
  }

  /** A file genome's whole name now, by its id: its new name where it was renamed. */
  private wholeName(id: string): string {
    return this.derived?.answer.genomes.find((genome) => genome.id === id)?.name ?? id
  }

  /** A file genome's name now, by its id, short: its new name where it was renamed. */
  private fileName(id: string): string {
    return this.derived?.answer.genomes.some((genome) => genome.id === id) === true ? this.ctx.shortName(id) : id
  }

  /**
   * Selection, hover, the keyboard's row and the review's marks, on the rows
   * drawn: classes only, but for the count a genome's row — and the pool's
   * head — says of the contigs selected in it, where they are many and
   * mostly out of sight (a lasso of 270 contigs from 33 genomes).
   */
  private restyle(): void {
    const model = this.ctx.model
    const selection = model.selection
    const genomes = new Set(selection.genomes)
    const contigs = new Set(selection.contigs)
    const hovered = model.hovered
    const current = model.current
    const answer = model.answer
    const currentGenomes = new Set(current === null || answer === null ? [] : current.genomes.map((g) => answer.genomes[g]?.id))
    const currentContigs = new Set(current?.contigs ?? [])
    const held = this.heldCounts()
    for (const [key, node] of this.drawn) {
      const genome = node.dataset.genome
      const contig = node.dataset.contig === undefined ? -1 : Number(node.dataset.contig)
      const selected = (genome !== undefined && genomes.has(genome)) || (contig >= 0 && contigs.has(contig))
      node.classList.toggle('is-selected', selected)
      // A head is not a thing to select: it says nothing of it.
      if (!node.classList.contains('curate-row-section')) node.setAttribute('aria-selected', String(selected))
      node.classList.toggle('is-lit', (genome !== undefined && hovered.genome === genome) || (contig >= 0 && hovered.contig === contig))
      node.classList.toggle('is-active', key === this.active)
      if (key === this.active) this.scroller.setAttribute('aria-activedescendant', node.id)
      node.classList.toggle('is-current', (genome !== undefined && currentGenomes.has(genome)) || (contig >= 0 && currentContigs.has(contig)))
      if (genome !== undefined) {
        const n = held.genomes.get(genome) ?? 0
        this.markHeld(node, n, n > 0 ? (answer?.genomes.find((g) => g.id === genome)?.contigs ?? 0) : 0)
      } else if (key === 's:pool') this.markHeld(node, held.pool, 0)
    }
    if (this.stickySection === 'pool') this.markHeld(this.sticky, held.pool, 0)
  }

  /** The selected contigs each genome holds, by id, and the pool's: counted once a selection and an answer. */
  private held: { contigs: readonly number[]; answer: CurationStateResult | null; genomes: Map<string, number>; pool: number } | null = null

  private heldCounts(): { genomes: Map<string, number>; pool: number } {
    const contigs = this.ctx.model.selection.contigs
    const answer = this.ctx.model.answer
    if (this.held !== null && this.held.contigs === contigs && this.held.answer === answer) return this.held
    const genomes = new Map<string, number>()
    let pool = 0
    if (answer !== null) {
      for (const c of contigs) {
        const g = answer.genomeOf[c] ?? -1
        if (g < 0) pool++
        else {
          const id = answer.genomes[g].id
          genomes.set(id, (genomes.get(id) ?? 0) + 1)
        }
      }
    }
    this.held = { contigs, answer, genomes, pool }
    return this.held
  }

  /**
   * A row's count of selected contigs and its half rule; nothing where it
   * holds none. The count alone, in the selection's colours — `12 selected`
   * would not fit beside a MAG's numbers —, the words in its title.
   */
  private markHeld(node: HTMLElement, n: number, of: number): void {
    node.classList.toggle('has-held', n > 0)
    const chip = node.querySelector<HTMLElement>(':scope > .curate-row-held')
    if (chip === null) return
    const text = n > 0 ? fmt.int(n) : ''
    if (chip.textContent !== text) chip.textContent = text
    chip.title = n === 0 ? '' : of > 0 ? `${fmt.int(n)} of its ${counted(of, 'contig')} selected` : `${counted(n, 'contig')} of the pool selected`
  }

  // -------------------------------------------------------------------------
  // The hand.
  // -------------------------------------------------------------------------

  /** What the list said on the readout last: a row under the pointer. */
  private said: string | null = null

  private hoverRow(row: ListRow): void {
    if (this.ctx.dragging !== null) return
    if (row.kind === 'genome') this.ctx.model.hover(row.id)
    else if (row.kind === 'contig') {
      const answer = this.ctx.model.answer
      const g = answer?.genomeOf[row.contig] ?? -1
      this.ctx.model.hover(g < 0 || answer === null ? null : answer.genomes[g].id, row.contig)
    } else this.ctx.model.hover(null)
    // The row's whole name and its numbers on the readout, as a picture's hover says them.
    this.say(this.rowWords(row))
  }

  /** The pointer off the list: nothing lit, and what it said let go of — not a drag's words, which are the stage's. */
  private leave(): void {
    if (this.ctx.dragging !== null) {
      this.said = null
      return
    }
    this.ctx.model.hover(null)
    this.say(null)
  }

  private say(words: string | null): void {
    if (words === this.said) return
    this.said = words
    this.ctx.say(words)
  }

  /**
   * A row in words: a genome's whole name, length, contigs and numbers — or
   * its hosts —, what the curation changed of it, its selected contigs and
   * the suggestions on offer naming it; a contig's whole name, length, GC,
   * genome, how densely it meets its own and the MAG it meets most, and the
   * suggestion that would move it. `null` for a head.
   */
  private rowWords(row: ListRow): string | null {
    const derived = this.derived
    if (derived === null || row.kind === 'section') return null
    const answer = derived.answer
    if (row.kind === 'genome') {
      const genome = answer.genomes[row.genome]
      if (genome === undefined) return null
      const parts = [genome.name, fmt.bp(genome.length), counted(genome.contigs, 'contig')]
      if (genome.kind === 'mag') {
        const q = genome.quality
        const g = q === null ? null : grade(q.weightedCompleteness, q.weightedRedundancy)
        if (q === null) parts.push('no marker genes')
        else parts.push(`${fmt.pct(q.weightedCompleteness, 0)} complete`, `${redundancyText(q.weightedRedundancy)} redundant`, ...(g === null ? [] : [g === 'contaminated' ? 'contaminated' : `${g} quality`]))
      } else {
        const hosts = answer.links.filter((link) => link.element === genome.id).map((link) => this.ctx.shortName(link.mag))
        parts.push(hosts.length === 0 ? 'an element, no host' : `an element, hosted by ${hosts.join(', ')}`)
      }
      // What the curation changed of it, the change chip in words.
      const change = derived.changes.genomes[row.genome]
      if (change?.created === true) parts.push('made by the curation')
      else if (change !== undefined) {
        if (change.absorbed.length > 0) parts.push(`merged with ${change.absorbed.join(', ')}`)
        if (change.gained > 0 || change.lost > 0) parts.push(`${counted(change.gained, 'contig')} in, ${fmt.int(change.lost)} out`)
        if (change.renamedFrom !== null) parts.push(`${change.renamedFrom} in the file`)
        if (change.retypedFrom !== null) parts.push(change.retypedFrom === 'element' ? 'an element in the file' : 'a MAG in the file')
      }
      const held = this.heldCounts().genomes.get(genome.id) ?? 0
      if (held > 0) parts.push(`${fmt.int(held)} of its contigs selected`)
      const offers = derived.suggested[row.genome]
      if (offers > 0) parts.push(`${counted(offers, 'suggestion')} on offer`)
      return parts.join(' · ')
    }
    const { file, gc } = this.ctx.data
    const c = row.contig
    const parts = [file.names[c] ?? `#${c}`, fmt.bp(file.lengths[c] ?? 0)]
    if (gc !== null && Number.isFinite(gc[c])) parts.push(`GC ${gc[c].toFixed(0)}%`)
    const g = answer.genomeOf[c] ?? -1
    parts.push(g < 0 ? 'unbinned' : `in ${this.ctx.shortName(answer.genomes[g].id)}`)
    const was = derived.changes.fileGenomeOf[c]
    const now = g < 0 ? null : answer.genomes[g].id
    if (was !== now) parts.push(was === null ? 'from the pool' : `from ${this.fileName(was)}`)
    if (answer.counted) {
      const own = answer.contigs.ownAffinity[c]
      if (own !== undefined && Number.isFinite(own)) parts.push(`own affinity ${affinityText(own)}`)
      const best = answer.contigs.best[c] ?? -1
      if (best >= 0 && answer.genomes[best] !== undefined) parts.push(`best ${this.ctx.shortName(answer.genomes[best].id)}, affinity ${affinityText(answer.contigs.bestAffinity[c])}`)
    }
    const offer = derived.best.get(c)
    const target = offer === undefined ? undefined : answer.genomes[offer.genomes[0]]
    if (offer !== undefined && target !== undefined) parts.push(`${offer.kind === 'recruit' ? 'recruit into' : 'move to'} ${this.ctx.shortName(target.id)} ${displayPercent(offer.confidence)}%`)
    return parts.join(' · ')
  }

  private pointerDown(event: PointerEvent, row: ListRow): void {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('input, select, .curate-row-disclosure, .curate-row-suggested') !== null) return
    this.focus()
    if (row.kind === 'section') {
      this.toggleFold(row.section)
      return
    }
    this.press = { x: event.clientX, y: event.clientY, row, pointer: event.pointerId }
    const done = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const move = (moved: PointerEvent): void => {
      const press = this.press
      if (press === null || moved.pointerId !== press.pointer) return
      if (Math.hypot(moved.clientX - press.x, moved.clientY - press.y) < DRAG_PX) return
      this.press = null
      done()
      this.startDrag(press.row, moved)
    }
    const up = (released: PointerEvent): void => {
      const press = this.press
      // Another pointer's release is not this press's.
      if (press !== null && released.pointerId !== press.pointer) return
      done()
      this.press = null
      if (press === null) return
      this.choose(press.row, released.shiftKey ? 'range' : released.metaKey || released.ctrlKey ? 'toggle' : 'replace')
    }
    // A gesture the browser took over — a swipe that scrolls the list — is no
    // press: the next tap anywhere must not select the row it began on.
    const cancel = (cancelled: PointerEvent): void => {
      if (this.press !== null && cancelled.pointerId !== this.press.pointer) return
      done()
      this.press = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  /** Drag a row: the selection when the row is in it, else the row alone. */
  private startDrag(row: ListRow, event: PointerEvent): void {
    const selection = this.ctx.model.selection
    if (row.kind === 'genome') {
      const ids = selection.genomes.includes(row.id) ? selection.genomes : [row.id]
      this.ctx.startDrag({ kind: 'genomes', ids }, event)
    } else if (row.kind === 'contig') {
      const contigs = selection.contigs.includes(row.contig) ? selection.contigs : [row.contig]
      this.ctx.startDrag({ kind: 'contigs', contigs }, event)
    }
  }

  /** A press on a row, or ↑ ↓ to it. */
  private choose(row: ListRow, how: 'replace' | 'toggle' | 'range'): void {
    const key = rowKey(row)
    const rows = this.rows.rows
    this.active = key
    this.activeAt = rows.findIndex((r) => rowKey(r) === key)
    const selection = this.ctx.model.selection
    // One kind at a time: ⌘ on a row of the other kind starts again from it.
    if (how === 'toggle' && ((row.kind === 'genome' && selection.contigs.length > 0) || (row.kind === 'contig' && selection.genomes.length > 0))) how = 'replace'
    // ⇧ extends from the selection: from the last of its rows in the list where
    // the anchor is not in it (a press on a picture since).
    if (how === 'range') {
      const inSelection = (r: ListRow): boolean => (r.kind === 'genome' && selection.genomes.includes(r.id)) || (r.kind === 'contig' && selection.contigs.includes(r.contig))
      const anchored = this.anchor === null ? undefined : rows.find((r) => rowKey(r) === this.anchor)
      if (anchored === undefined || !inSelection(anchored)) {
        const last = [...rows].reverse().find(inSelection)
        this.anchor = last === undefined ? null : rowKey(last)
      }
    }
    if (how === 'range' && this.anchor !== null) {
      const from = rows.findIndex((r) => rowKey(r) === this.anchor)
      const to = rows.findIndex((r) => rowKey(r) === key)
      if (from >= 0 && to >= 0 && rows[from].kind === row.kind) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const span = rows.slice(lo, hi + 1)
        if (row.kind === 'genome') this.ctx.model.selectGenomes(span.flatMap((r) => (r.kind === 'genome' ? [r.id] : [])))
        else if (row.kind === 'contig') this.ctx.model.selectContigs(span.flatMap((r) => (r.kind === 'contig' ? [r.contig] : [])))
        this.restyle()
        return
      }
    }
    this.anchor = key
    const mode = how === 'toggle' ? 'toggle' : 'replace'
    if (row.kind === 'genome') this.ctx.model.selectGenomes([row.id], mode)
    else if (row.kind === 'contig') this.ctx.model.selectContigs([row.contig], mode)
    this.restyle()
  }

  private toggleOpen(id: string): void {
    // Opened or closed by the reader, it is theirs: no frame closes it.
    this.framed.delete(id)
    const row = this.rows.rows.find((r) => r.kind === 'genome' && r.id === id)
    // A row the filter shows on its hits opens and closes for as long as the
    // filter stands, whatever the reader had open before it.
    if (row?.kind === 'genome' && row.byFilter === true) {
      if (row.open) this.closed.add(id)
      else this.closed.delete(id)
    } else if (this.open.has(id)) this.open.delete(id)
    else this.open.add(id)
    this.recompute()
  }

  private toggleFold(section: ListSection): void {
    if (this.folded.has(section)) this.folded.delete(section)
    else this.folded.add(section)
    this.recompute()
  }

  /** The list's own keys, while it has the keyboard; `true` when taken. */
  key(event: KeyboardEvent): boolean {
    if (this.renaming !== null) return false
    const rows = this.rows.rows
    const mod = event.metaKey || event.ctrlKey
    const at = this.active === null ? -1 : rows.findIndex((row) => rowKey(row) === this.active)
    const row = at >= 0 ? rows[at] : undefined
    const step = (by: number): boolean => {
      // The keyboard's row gone (merged away, folded, filtered out): ↓ goes on
      // to the row now where it was, ↑ to the one before.
      let k: number
      if (at >= 0) k = at
      else if (this.activeAt >= 0 && this.activeAt < rows.length) k = this.activeAt - (by > 0 ? 1 : 0)
      // From past the end — the filter left fewer rows — the last row there is.
      else if (this.activeAt >= rows.length) {
        const last = rows.length - 1 - [...rows].reverse().findIndex((r) => r.kind !== 'section')
        if (last >= rows.length) return true
        k = last + (by > 0 ? -1 : 1)
      } else k = by > 0 ? -1 : rows.length
      for (;;) {
        k += by
        if (k < 0 || k >= rows.length) return true
        if (rows[k].kind !== 'section') break
      }
      this.choose(rows[k], event.shiftKey ? 'range' : 'replace')
      if (!event.shiftKey) this.anchor = rowKey(rows[k])
      this.reveal(k)
      return true
    }
    switch (event.key) {
      case 'ArrowDown':
        return step(1)
      case 'ArrowUp':
        return step(-1)
      case 'ArrowRight':
        if (row?.kind === 'genome' && !row.open) {
          this.toggleOpen(row.id)
          return true
        }
        // Into an open genome's first contig; a contig is a leaf.
        if (row?.kind === 'genome') return step(1)
        return row !== undefined

      case 'ArrowLeft':
        if (row?.kind === 'genome' && row.open) {
          this.toggleOpen(row.id)
          return true
        }
        if (row?.kind === 'contig' && row.genome >= 0) {
          for (let k = at - 1; k >= 0; k--) {
            const up = rows[k]
            if (up.kind === 'genome') {
              this.choose(up, 'replace')
              this.reveal(k)
              return true
            }
          }
        }
        return false
      case 'F2':
        if (row?.kind === 'genome') {
          this.startRename(row.id)
          return true
        }
        return false
      case 'Home':
      case 'End': {
        const k = event.key === 'Home' ? rows.findIndex((r) => r.kind !== 'section') : rows.length - 1 - [...rows].reverse().findIndex((r) => r.kind !== 'section')
        if (k < 0 || k >= rows.length) return true
        this.choose(rows[k], event.shiftKey ? 'range' : 'replace')
        if (!event.shiftKey) this.anchor = rowKey(rows[k])
        this.reveal(k)
        return true
      }
      case 'a':
      case 'A':
        if (!mod) return false
        this.selectShown(row?.kind === 'contig' ? 'contig' : 'genome')
        return true
      default:
        return false
    }
  }

  /** Select every row shown of one kind: ⌘A. */
  private selectShown(kind: 'genome' | 'contig'): void {
    const rows = this.rows.rows
    if (kind === 'genome') this.ctx.model.selectGenomes(rows.flatMap((r) => (r.kind === 'genome' ? [r.id] : [])))
    else this.ctx.model.selectContigs(rows.flatMap((r) => (r.kind === 'contig' ? [r.contig] : [])))
  }

  /** Scroll so row `k` is in view. */
  private reveal(k: number): void {
    const top = k * LIST_ROW
    const view = this.scroller.clientHeight
    // Below the sticky head, which covers the first row.
    if (top < this.scroller.scrollTop + LIST_ROW) this.scroller.scrollTop = Math.max(0, top - LIST_ROW)
    else if (top + LIST_ROW > this.scroller.scrollTop + view) this.scroller.scrollTop = top + LIST_ROW - view
    this.schedule()
  }

  /**
   * Show what a pane asked: open the genomes of contigs asked, and scroll to
   * the first. What the last frame opened closes first, unless this one shows
   * it too, so a pass through review leaves the list as the reader had it.
   */
  private frameOn(target: CurateFrame): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    const shows = new Set<string>()
    for (const c of target.contigs ?? []) {
      const g = answer.genomeOf[c]
      if (g >= 0) shows.add(answer.genomes[g].id)
    }
    let opened = this.closeFramed(shows)
    const unfold = (section: ListSection): void => {
      if (!this.folded.has(section)) return
      this.folded.delete(section)
      opened = true
    }
    const sectionOf = (g: number): ListSection => (answer.genomes[g].kind === 'mag' ? 'mags' : 'elements')
    for (const id of target.genomes ?? []) {
      const g = answer.genomes.findIndex((genome) => genome.id === id)
      if (g >= 0) unfold(sectionOf(g))
    }
    for (const c of target.contigs ?? []) {
      const g = answer.genomeOf[c]
      // One the reader has open stays theirs; one this frame opens is the frame's.
      if (g >= 0 && !this.open.has(answer.genomes[g].id)) {
        this.open.add(answer.genomes[g].id)
        this.framed.add(answer.genomes[g].id)
        opened = true
      }
      unfold(g < 0 ? 'pool' : sectionOf(g))
    }
    if (opened) this.recompute()
    const keys = new Set([...(target.genomes ?? []).map((id) => `g:${id}`), ...(target.contigs ?? []).map((c) => `c:${c}`)])
    const k = this.rows.rows.findIndex((row) => keys.has(rowKey(row)))
    if (k < 0) return
    this.active = rowKey(this.rows.rows[k])
    this.activeAt = k
    this.reveal(k)
  }

  /**
   * Close what frames opened, but what `keep` names (the next frame's): `true`
   * when a genome closed. The rows are the caller's to count again.
   */
  private closeFramed(keep: ReadonlySet<string> = new Set()): boolean {
    let closed = false
    for (const id of [...this.framed]) {
      if (keep.has(id)) continue
      this.framed.delete(id)
      if (this.open.delete(id)) closed = true
    }
    return closed
  }

  // -------------------------------------------------------------------------
  // Renaming in place.
  // -------------------------------------------------------------------------

  /**
   * Open a genome's name for typing (F2, a double press, a new genome): its
   * section unfolded if it was folded; a genome a step has just made, once the
   * step is counted and it has a row; one the filter or the chips hide, never,
   * and the readout says why.
   */
  startRename(id: string, waited = false): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    const find = (): number => this.rows.rows.findIndex((row) => row.kind === 'genome' && row.id === id)
    let k = find()
    const genome = answer.genomes.find((g) => g.id === id)
    if (k < 0 && genome !== undefined) {
      const section: ListSection = genome.kind === 'mag' ? 'mags' : 'elements'
      if (this.folded.has(section)) {
        this.folded.delete(section)
        this.recompute()
        k = find()
      }
    }
    if (k < 0) {
      if (!waited && (genome === undefined || this.ctx.model.stale)) {
        // Once counted — unless a name is being typed meanwhile: that box is the reader's.
        void this.ctx.model.settled().then(() => {
          if (this.renaming === null) this.startRename(id, true)
        })
        return
      }
      if (genome !== undefined) this.ctx.say('Its row is hidden by the filter or the chips: clear them to rename it.')
      return
    }
    this.active = `g:${id}`
    this.reveal(k)
    this.draw()
    const node = this.drawn.get(`g:${id}`)
    const name = node?.querySelector('.curate-row-name')
    if (node === undefined || name === null || name === undefined || genome === undefined) return
    const input = el('input', {
      class: 'curate-rename',
      value: genome.name,
      attrs: { 'aria-label': `Rename ${genome.name}`, spellcheck: 'false', [TAB_WALKS]: '' },
    })
    name.replaceWith(input)
    this.renaming = { id, input, cancel: () => finish(false) }
    input.focus()
    input.select()
    const finish = (commit: boolean, then?: 1 | -1, keepFocus = false): void => {
      if (this.renaming?.input !== input) return
      if (commit) {
        const refused = this.ctx.model.rename(id, input.value)
        if (refused !== null) {
          input.classList.add('is-refused')
          input.title = refused
          this.ctx.say(refused)
          input.focus()
          return
        }
      }
      this.renaming = null
      this.ctx.say(null)
      this.schedule(true)
      // The keyboard back to the list after Enter, Escape or Tab; a press
      // elsewhere keeps the focus it went to — the filter box, a card's field —
      // or the letters typed next would be the stage's keys.
      if (!keepFocus) this.focus()
      if (then !== undefined) {
        const genomes = this.rows.rows.filter((row): row is Extract<ListRow, { kind: 'genome' }> => row.kind === 'genome')
        const at = genomes.findIndex((row) => row.id === id)
        const next = genomes[at + then]
        if (next !== undefined) requestAnimationFrame(() => this.startRename(next.id))
      }
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      // Mid-composition the keys are the input method's (§26.8).
      if (event.isComposing) return
      const walk = tabStep(event)
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      } else if (walk !== null) {
        event.preventDefault()
        finish(true, walk)
      } else input.classList.remove('is-refused')
    })
    input.addEventListener('blur', () => {
      // A press elsewhere leaves the old name, as Escape does, and the focus where it went.
      if (this.renaming?.input === input) finish(false, undefined, true)
    })
  }

  /** Whether a name is being typed: Escape is the box's then. */
  get isRenaming(): boolean {
    return this.renaming !== null
  }
}

/** The list's key for focusing its filter. */
export const FILTER_KEY = '/'

/** The filter's key as printed, for the stage's key sheet. */
export function filterKeyLabel(): string {
  return keyLabel(FILTER_KEY)
}
