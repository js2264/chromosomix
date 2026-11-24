/**
 * The curation stage's genome list (SPECS §33.3): the MAGs, the elements and
 * the unbinned pool, each a section, every genome a row that opens on its
 * contigs. A virtual list — only the rows in view are elements — over the rows
 * `curate/listRows.ts` decides, so twenty thousand contigs scroll as smoothly as
 * fifty genomes.
 *
 * One selection with the pictures: a press selects a row, ⌘/Ctrl toggles one,
 * ⇧ extends; ↑ ↓ walk the rows, → opens a genome, ← closes it or climbs to it,
 * Enter opens or closes, F2 renames, ⌘A selects every row shown. A row dragged
 * is the selection when it is in it, and drops on a genome's row (*into it*),
 * a section's head (*a new one*, *of that kind*) or the pool (*out*).
 */

import { el } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { keyLabel, withKey } from '../../ui/commands'
import { TAB_WALKS } from '../../ui/tabWalk'
import { fmt } from '../../units'
import { changeChip, changeWords, curationChanges, type CurationChanges } from '../changes'
import { listRows, readFilter, rowKey, type GenomeSort, type ListChip, type ListRow, type ListRows, type ListSection, type PoolSort } from '../listRows'
import type { CurateChange } from '../model'
import type { Suggestion } from '../suggest'
import type { CurationStateResult } from '../../worker/curateProtocol'
import type { CurateContext, CurateFrame } from './context'

/** A row's height, in CSS pixels. */
export const LIST_ROW = 28
/** Rows drawn past each edge of the view. */
const OVERSCAN = 8
/** How far a press moves before it is a drag. */
const DRAG_PX = 4

/** metaTOR's grades (`validation.py::bin_quality`), on the weighted pair. */
export function grade(completeness: number, redundancy: number): 'high' | 'medium' | 'low' | 'contaminated' | null {
  if (!Number.isFinite(completeness) || !Number.isFinite(redundancy)) return null
  if (redundancy > 1.1) return 'contaminated'
  if (completeness >= 0.9 && redundancy <= 1.05) return 'high'
  if (completeness >= 0.7) return 'medium'
  if (completeness >= 0.5) return 'low'
  return null
}

/** What the list keeps of one answer: counted once per answer. */
interface Derived {
  answer: CurationStateResult
  changes: CurationChanges
  /** Suggestions on offer naming each genome. */
  suggested: Int32Array
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
  private readonly folded = new Set<ListSection>()
  private genomeSort: GenomeSort = 'order'
  private poolSort: PoolSort = 'likeliest'
  private readonly chips = new Set<ListChip>()
  /** Rows drawn, by key. */
  private readonly drawn = new Map<string, HTMLElement>()
  /** The row the keyboard is on, by key, and the row a ⇧-press extends from. */
  private active: string | null = null
  private anchor: string | null = null
  private renaming: { id: string; input: HTMLInputElement } | null = null
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
        pointerleave: () => this.ctx.model.hover(null),
      },
    })
    this.scroller.appendChild(this.spacer)
    this.sticky = el('div', { class: 'curate-list-sticky hidden', attrs: { 'aria-hidden': 'true' } })
    this.element = el(
      'section',
      { class: 'curate-list', attrs: { 'data-pane': 'list' } },
      el('div', { class: 'curate-list-head' }, this.filterBox, this.filterNote, this.chipRow, sorts),
      el('div', { class: 'curate-list-body' }, this.scroller, this.sticky),
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
  contains(node: Node | null): boolean {
    return node !== null && this.element.contains(node)
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
      case 'state':
      case 'current':
      case 'mode':
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
    this.derived = { answer, changes: curationChanges(answer, this.ctx.data.file), suggested, best, likeliness }
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
    this.rows = listRows({
      answer: derived.answer,
      order: this.ctx.model.order,
      names: file.names,
      lengths: file.lengths,
      open: this.open,
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

  private schedule(rebuild = false): void {
    if (rebuild) for (const node of this.drawn.values()) node.remove()
    if (rebuild) this.drawn.clear()
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
    for (let k = first; k < last; k++) {
      const row = rows[k]
      const key = rowKey(row)
      keep.add(key)
      let node = this.drawn.get(key)
      if (node === undefined || node.dataset.at !== String(k) || this.renaming?.input.closest('.curate-row') === node) {
        if (node !== undefined && this.renaming?.input.closest('.curate-row') === node) {
          node.style.transform = `translateY(${k * LIST_ROW}px)`
          node.dataset.at = String(k)
          continue
        }
        node?.remove()
        node = this.rowElement(row, k)
        this.drawn.set(key, node)
        this.scroller.appendChild(node)
      }
    }
    for (const [key, node] of this.drawn) {
      if (keep.has(key)) continue
      node.remove()
      this.drawn.delete(key)
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
    this.sticky.classList.remove('hidden')
  }

  private rowElement(row: ListRow, at: number): HTMLElement {
    const node = el('div', {
      class: `curate-row curate-row-${row.kind}`,
      attrs: { role: 'treeitem', 'data-key': rowKey(row), 'data-at': String(at) },
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
      if (row.kind === 'genome' && (event.target as HTMLElement).closest('.curate-row-name') !== null) this.startRename(row.id)
      else if (row.kind === 'genome') this.toggleOpen(row.id)
    })
    return node
  }

  private sectionContent(row: Extract<ListRow, { kind: 'section' }>): HTMLElement[] {
    const chevron = icon(row.open ? 'chevron-down' : 'chevron-right', { size: 14, class: 'curate-row-chevron' })
    const word = SECTION_WORD[row.section]
    const count =
      row.section === 'pool'
        ? `${fmt.int(row.contigs)} contigs · ${fmt.bp(row.length)}`
        : `${fmt.int(row.genomes)}${row.shown !== row.genomes ? ` · ${fmt.int(row.shown)} shown` : ''}`
    const title = el('span', { class: 'curate-section-title', text: word })
    const counted = el('span', { class: 'curate-section-count', text: count })
    const holder = el('span', { class: 'curate-section-chevron' })
    holder.appendChild(chevron)
    return [holder, title, counted]
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
    const name = el('span', { class: 'curate-row-name', text: genome.name, title: `${genome.name} · ${fmt.int(genome.contigs)} contigs · ${fmt.bp(genome.length)}` })
    const parts: Array<HTMLElement | null> = [
      disclosure,
      swatch,
      name,
      chip === null ? null : el('span', { class: 'edit-chip curate-change', text: chip, title: changeWords(change) }),
      el('span', { class: 'curate-row-length', text: fmt.bp(genome.length) }),
    ]
    if (genome.kind === 'mag') {
      const q = genome.quality
      if (q === null) parts.push(el('span', { class: 'curate-row-quality is-none', text: '—', title: 'No marker genes stored for its contigs.' }))
      else {
        const g = grade(q.weightedCompleteness, q.weightedRedundancy)
        const bar = el('span', { class: 'curate-bar', attrs: { 'aria-hidden': 'true' } })
        const fill = el('span', { class: `curate-bar-fill${g === 'high' ? ' is-high' : ''}` })
        fill.style.width = `${Math.max(0, Math.min(1, q.weightedCompleteness)) * 100}%`
        bar.appendChild(fill)
        const title = `${fmt.pct(q.weightedCompleteness, 1)} complete and ${fmt.fixed(q.weightedRedundancy, 3)} redundant, weighted (${q.set}); ${fmt.pct(q.completeness, 1)} and ${fmt.fixed(q.redundancy, 3)} unweighted; ${q.present} of ${q.markers} markers${g === null ? '' : ` · ${g === 'contaminated' ? 'contaminated' : `${g} quality`}`}`
        parts.push(
          el('span', { class: 'curate-row-quality', title }, bar, el('span', { class: 'curate-row-complete', text: fmt.pct(q.weightedCompleteness, 0) })),
          el('span', { class: `curate-row-redundant${q.weightedRedundancy > 1.1 ? ' is-warn' : ''}`, text: fmt.fixed(q.weightedRedundancy, 2), title }),
        )
      }
    } else {
      const hosts = derived.answer.links.filter((link) => link.element === genome.id).map((link) => derived.answer.genomes.find((g) => g.id === link.mag)?.name ?? link.mag)
      const text = hosts.length === 0 ? 'no host' : hosts.length === 1 ? `→ ${hosts[0]}` : `${hosts.length} hosts`
      parts.push(el('span', { class: `curate-row-hosts${hosts.length === 0 ? ' is-faint' : ''}`, text, title: hosts.length === 0 ? 'Linked to no MAG.' : `Hosted by ${hosts.join(', ')}.` }))
    }
    const n = derived.suggested[row.genome]
    parts.push(
      n > 0
        ? el('button', {
            class: 'curate-row-suggested',
            text: String(n),
            title: `${n} suggestion${n === 1 ? '' : 's'} on offer name it: show only what a suggestion names`,
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
    const name = file.names[c] ?? `#${c}`
    const parts: HTMLElement[] = [
      el('span', { class: 'curate-row-indent' }),
      el('span', { class: 'curate-row-name', text: name, title: name }),
      el('span', { class: 'curate-row-length', text: fmt.bp(file.lengths[c] ?? 0) }),
    ]
    if (gc !== null) parts.push(el('span', { class: 'curate-row-gc', text: Number.isFinite(gc[c]) ? `GC ${gc[c].toFixed(0)}%` : '' }))
    const best = derived.best.get(c)
    const was = derived.changes.fileGenomeOf[c]
    const now = derived.answer.genomeOf[c] < 0 ? null : derived.answer.genomes[derived.answer.genomeOf[c]].id
    if (best !== undefined) {
      const target = best.genomes[0] === undefined ? '' : (derived.answer.genomes[best.genomes[0]]?.name ?? '')
      parts.push(el('span', { class: 'curate-row-offer', text: `→ ${target} ${Math.min(99, Math.round(best.confidence * 100))}%`, title: best.words }))
    } else if (was !== now) {
      const from = was === null ? 'from the pool' : `from ${this.fileName(was)}`
      parts.push(el('span', { class: 'curate-row-moved', text: from, title: `In ${was === null ? 'no genome' : this.fileName(was)} in the file.` }))
    }
    node.append(...parts)
  }

  /** A file genome's name now, by its id: its new name where it was renamed. */
  private fileName(id: string): string {
    return this.derived?.answer.genomes.find((genome) => genome.id === id)?.name ?? id
  }

  /** Selection, hover, the keyboard's row and the review's marks, on the rows drawn: classes only. */
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
    for (const [key, node] of this.drawn) {
      const genome = node.dataset.genome
      const contig = node.dataset.contig === undefined ? -1 : Number(node.dataset.contig)
      const selected = (genome !== undefined && genomes.has(genome)) || (contig >= 0 && contigs.has(contig))
      node.classList.toggle('is-selected', selected)
      node.setAttribute('aria-selected', String(selected))
      node.classList.toggle('is-lit', (genome !== undefined && hovered.genome === genome) || (contig >= 0 && hovered.contig === contig))
      node.classList.toggle('is-active', key === this.active)
      node.classList.toggle('is-current', (genome !== undefined && currentGenomes.has(genome)) || (contig >= 0 && currentContigs.has(contig)))
    }
  }

  // -------------------------------------------------------------------------
  // The hand.
  // -------------------------------------------------------------------------

  private hoverRow(row: ListRow): void {
    if (this.ctx.dragging !== null) return
    if (row.kind === 'genome') this.ctx.model.hover(row.id)
    else if (row.kind === 'contig') {
      const answer = this.ctx.model.answer
      const g = answer?.genomeOf[row.contig] ?? -1
      this.ctx.model.hover(g < 0 || answer === null ? null : answer.genomes[g].id, row.contig)
    } else this.ctx.model.hover(null)
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
    const move = (moved: PointerEvent): void => {
      const press = this.press
      if (press === null || moved.pointerId !== press.pointer) return
      if (Math.hypot(moved.clientX - press.x, moved.clientY - press.y) < DRAG_PX) return
      this.press = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.startDrag(press.row, moved)
    }
    const up = (released: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const press = this.press
      this.press = null
      if (press === null) return
      this.choose(press.row, released.shiftKey ? 'range' : released.metaKey || released.ctrlKey ? 'toggle' : 'replace')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
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
    this.active = key
    if (how === 'range' && this.anchor !== null) {
      const rows = this.rows.rows
      const from = rows.findIndex((r) => rowKey(r) === this.anchor)
      const to = rows.findIndex((r) => rowKey(r) === key)
      if (from >= 0 && to >= 0) {
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
    if (this.open.has(id)) this.open.delete(id)
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
      let k = at < 0 ? (by > 0 ? -1 : rows.length) : at
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
        return step(1)
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
      case 'Enter':
        if (row?.kind === 'genome') {
          this.toggleOpen(row.id)
          return true
        }
        return false
      case 'F2':
        if (row?.kind === 'genome') {
          this.startRename(row.id)
          return true
        }
        return false
      case 'Home':
        return step(-rows.length)
      case 'End':
        return step(rows.length)
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

  /** Show what a pane asked: open the genomes of contigs asked, and scroll to the first. */
  private frameOn(target: CurateFrame): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    let opened = false
    for (const c of target.contigs ?? []) {
      const g = answer.genomeOf[c]
      if (g >= 0 && !this.open.has(answer.genomes[g].id)) {
        this.open.add(answer.genomes[g].id)
        opened = true
      }
      if (g < 0 && this.folded.has('pool')) {
        this.folded.delete('pool')
        opened = true
      }
    }
    if (opened) this.recompute()
    const keys = new Set([...(target.genomes ?? []).map((id) => `g:${id}`), ...(target.contigs ?? []).map((c) => `c:${c}`)])
    const k = this.rows.rows.findIndex((row) => keys.has(rowKey(row)))
    if (k < 0) return
    this.active = rowKey(this.rows.rows[k])
    this.reveal(k)
  }

  // -------------------------------------------------------------------------
  // Renaming in place.
  // -------------------------------------------------------------------------

  /** Open a genome's name for typing (F2, a double press, a new genome). */
  startRename(id: string): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    const k = this.rows.rows.findIndex((row) => row.kind === 'genome' && row.id === id)
    if (k < 0) return
    this.active = `g:${id}`
    this.reveal(k)
    this.draw()
    const node = this.drawn.get(`g:${id}`)
    const name = node?.querySelector('.curate-row-name')
    if (node === undefined || name === null || name === undefined) return
    const genome = answer.genomes.find((g) => g.id === id)
    if (genome === undefined) return
    const input = el('input', {
      class: 'curate-rename',
      value: genome.name,
      attrs: { 'aria-label': `Rename ${genome.name}`, spellcheck: 'false', [TAB_WALKS]: '' },
    })
    name.replaceWith(input)
    this.renaming = { id, input }
    input.focus()
    input.select()
    const finish = (commit: boolean, then?: 1 | -1): void => {
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
      this.focus()
      if (then !== undefined) {
        const genomes = this.rows.rows.filter((row): row is Extract<ListRow, { kind: 'genome' }> => row.kind === 'genome')
        const at = genomes.findIndex((row) => row.id === id)
        const next = genomes[at + then]
        if (next !== undefined) requestAnimationFrame(() => this.startRename(next.id))
      }
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        finish(true, event.shiftKey ? -1 : 1)
      } else input.classList.remove('is-refused')
    })
    input.addEventListener('blur', () => {
      // A press elsewhere leaves the old name, as Escape does.
      if (this.renaming?.input === input) finish(false)
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
