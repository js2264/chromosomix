/**
 * The inspector's selection card (SPECS §33.3): what is selected, and what it
 * can do, by what it is —
 *
 * - **nothing**: how to select, the MAGs by grade — the ones under 50%
 *   complete counted too —, and what the curation changed so far;
 * - **one MAG**: its length, contigs and change since the file, its quality —
 *   and, while a step is priced, what the step would leave of it; the genomes
 *   it meets most densely, `merge` on those whose contacts stand out of the
 *   background; the contigs the suggestions would bring into it (`take`, and
 *   `take N at 50% or more`, one step) and send out of it (`move`);
 * - **several genomes**: their counts and length, the step's price, their
 *   affinities with one another;
 * - **contigs**: how long, where they are, the genomes they meet most — how
 *   many meet each most, and how many of those are in it already;
 * - **one element**: its hosts held and offered, and the elements that meet
 *   it, each with its own best host;
 * - **an element and a MAG**: the pair's numbers, `link` or `unlink`.
 *
 * Every affinity is put against the map's background, the rate of spurious
 * ligation (`0.39 (at least 14× background)`, `below the background`), what
 * `at least` means said once; every confidence says what it is sure of (`99%
 * one organism`, `98% its host`, under `belong here` `79% sure`), never a bare
 * percent beside a price; and a row's act is the card's acts' size.
 *
 * Its acts are the stage's keys printed (F2, M, L, B, E, ⌫, ⏎); hovering one
 * prices its step (`model.preview(step, false)`), so its outcome is read before
 * it is made. An act that makes a step answers nothing while the last step is
 * counted, as the review does — the card still shows the binning before it,
 * and a second press would make the step twice — and the card dims while it
 * weighs. Renaming is the list's, the close-up the contact map's and the
 * chooser the stage's: the card asks for them through its hooks.
 *
 * Its lists read the answer as it stands (`model.answer`), not a preview drawn:
 * a row's act makes its step on the binning the row describes.
 */

import { el } from '../../../ui/dom'
import { fmt } from '../../../units'
import type { CurationStep } from '../../../genome/curation'
import type { CurationStateResult } from '../../../worker/curateProtocol'
import { changeChip, changeWords, curationChanges, type CurationChanges } from '../../changes'
import { LIKELY, lowerAffinity } from '../../method'
import type { CurateChange, CurateSelection, CurateTally } from '../../model'
import { priceOf, redundancyText } from '../../price'
import type { Quality } from '../../quality'
import type { Question } from '../../questions'
import type { Suggestion } from '../../suggest'
import type { CurateContext } from '../context'
import { AFFINITY_SATURATES, FALLBACK_BACKGROUND } from '../contactLayout'
import { grade } from '../grade'
import { Chooser, contigHomes } from '../Chooser'
import { act, acts, affinityText, card, confidenceText, contactsText, nameSpan, previewKey, priceList, qualityShift, refuse, swatch, type Shift } from './card'

type Genome = CurationStateResult['genomes'][number]

/** What the stage does for the card: renaming is the list's, the close-up the contact map's, the chooser the stage's. */
export interface SelectionHooks {
  /** Open a genome's name for typing, in the list. */
  rename(id: string): void
  /** Open the close-up of the selection on the contact map. */
  closeUp(): void
  /** Open the chooser of this kind for the selection; `anchor` is the act pressed, to open it under. */
  choose(kind: 'move' | 'merge' | 'link', anchor?: HTMLElement): void
}

/** The keys the card prints on its acts; the stage binds them (`⌫` is Backspace or Delete, `⏎` Enter). */
export const SELECTION_KEYS = {
  rename: 'F2',
  /** `move to…` for contigs, `merge into…` for genomes, `merge` for several. */
  merge: 'm',
  link: 'l',
  /** `new MAG` for contigs; `make it a MAG`, `make them MAGs` for genomes. */
  newMag: 'b',
  /** `new element` for contigs; `make it an element`, `make them elements` for genomes. */
  newElement: 'e',
  /** `dissolve`, `unbin`, `unlink`. */
  remove: '⌫',
  closeUp: '⏎',
} as const

/** How long the pointer rests on an act before its step is priced, in ms. */
const PRICE_DELAY = 150

/** Rows a list shows before `show all`. */
const LIST_ROWS = 6

/** The genomes the pairwise affinities are shown for, at most. */
const MATRIX_MOST = 6

/** The confidence `take N at 50% or more` takes from, as the card prints it. */
const LIKELY_PERCENT = Math.round(LIKELY * 100)

/** What is selected, as the card shows it. */
type View =
  | { kind: 'none' }
  | { kind: 'contigs'; contigs: number[] }
  | { kind: 'genome'; g: number }
  | { kind: 'pair'; element: number; mag: number }
  | { kind: 'genomes'; genomes: number[] }

/** What the selection is: contigs win over genomes, as the last gesture made them. */
function viewOf(answer: CurationStateResult | null, selection: CurateSelection): View {
  if (answer === null) return { kind: 'none' }
  const contigs = selection.contigs.filter((c) => c >= 0 && c < answer.genomeOf.length)
  if (contigs.length > 0) return { kind: 'contigs', contigs }
  const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
  const genomes = selection.genomes.map((id) => index.get(id)).filter((g): g is number => g !== undefined)
  if (genomes.length === 0) return { kind: 'none' }
  if (genomes.length === 1) return { kind: 'genome', g: genomes[0] }
  if (genomes.length === 2) {
    const [a, b] = genomes
    const ka = answer.genomes[a].kind
    if (ka !== answer.genomes[b].kind) return ka === 'element' ? { kind: 'pair', element: a, mag: b } : { kind: 'pair', element: b, mag: a }
  }
  return { kind: 'genomes', genomes }
}

/** One row of a card's list: a genome or contigs, what the contacts say, and its act. */
interface RowSpec {
  /** The genome it names, by id, for the hover; and the contigs. */
  genome?: string
  contigs?: readonly number[]
  /** The suggestion it shows, by key: lit while it is the review's, or a member of it. */
  suggestion?: string
  lead: Array<Node | null>
  /** What opens the second line, before its words: where a contig would go. */
  detailLead?: Array<Node | string | null>
  detail: string
  /** The row in a line, in the names the stage prints: the readout's words while the pointer is on it. */
  words: string
  /** The same with full names, for its title. */
  title?: string
  /** A suggestion's confidence and what it is sure of — `99% one organism`, never a bare percent — and that in a sentence. */
  confidence?: string | null
  confidenceTitle?: string
  /** Whether its words lean on the cautious lower bound (`at least`), which the card explains once. */
  bounded?: boolean
  /** Its act: it makes a step, so it answers nothing while the last one is counted. */
  act?: { label: string; title: string; run: () => void; step?: () => CurationStep | null } | null
}

/** A row drawn, as the lights find it: kept here, not read back from the page. */
interface LitRow {
  node: HTMLElement
  genome: string | undefined
  contigs: ReadonlySet<number> | null
  suggestion: string | undefined
}

/** Where a price is drawn: over what follows the acts, for an act's step; at the card's foot, for a row's or one priced elsewhere. */
type PriceSlot = 'acts' | 'rows'

/** Where the keyboard was in the card before it was drawn again. */
interface HeldFocus {
  /** The act's `data-focus`: its view's word, or its row's and its word. */
  key: string | null
  /** Its place among the card's buttons that could take it. */
  at: number
}

export class SelectionCard {
  readonly element: HTMLElement
  private readonly head: HTMLElement
  private readonly body: HTMLElement
  private changes: { answer: CurationStateResult; changes: CurationChanges } | null = null
  private numbers: { answer: CurationStateResult; pooled: number; pooledLength: number; tally: CurateTally | null } | null = null
  /** Where the quality table and the price are drawn again when a step is priced. */
  private qualitySlot: { node: HTMLElement; genome: Genome } | null = null
  /**
   * The price's places, neither of which moves an act or a row the pointer may
   * rest on: under the acts, a popover over what follows them, for an act's
   * step; at the card's foot, in the flow, for a row's step or one priced
   * elsewhere. In the flow above the acts, the price pushed the act priced out
   * from under the pointer, which let go of the price, which brought the act
   * back — a flicker for as long as the pointer stayed; in the flow under
   * them, the rows jumped as the pointer left the acts for them.
   */
  private priceSlots: { acts: HTMLElement | null; rows: HTMLElement | null } = { acts: null, rows: null }
  /** The acts the chooser opens from, for the stage to anchor it. */
  private readonly chooseActs = new Map<'move' | 'merge' | 'link', HTMLButtonElement>()
  /** The lists opened past their first rows, by genome or selection and list. */
  private readonly expanded = new Set<string>()
  /** The rows drawn, for the lights. */
  private lit: LitRow[] = []
  /** Whether a row's hover is on the model and the readout: let go of when the rows are drawn again. */
  private saying = false
  /** Whether the reader's last gesture in the card was a key: only then is the keyboard put back on an act after a repaint. */
  private byKeys = false
  /** Whether the card, as drawn now, has said what `at least` means: once a drawing. */
  private keyed = false
  private dirty = { all: true, preview: false, hover: false }
  private frame = 0
  private priceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The step an act's hover prices, where the act is (in the acts or a list's
   * row), and the preview held before it — one step or a question's — given
   * back when the pointer leaves.
   */
  private pricing: { key: string; from: PriceSlot } | null = null
  private disposed = false
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly ctx: CurateContext,
    private readonly hooks: SelectionHooks,
  ) {
    const built = card('selection')
    this.element = built.element
    this.head = built.head
    this.body = built.body
    this.element.classList.add('curate-selection-card')
    // A key pressed in the card, or the focus brought in by one (Tab from outside); a press of the pointer.
    this.element.addEventListener('keydown', () => (this.byKeys = true), true)
    this.element.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && focusVisible(event.target)) this.byKeys = true
    })
    this.element.addEventListener('pointerdown', () => (this.byKeys = false), true)
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.schedule('all')
  }

  /** What changed: repaints in the next frame, once however many changes came. */
  update(change: CurateChange): void {
    switch (change) {
      case 'state':
      case 'selection':
        this.markWeighing()
        this.schedule('all')
        return
      case 'counting':
      case 'error':
        this.markWeighing()
        return
      case 'preview':
        this.schedule('preview')
        return
      case 'hover':
      case 'current':
      case 'mode':
        this.schedule('hover')
        return
      default:
        return
    }
  }

  /** The act a chooser of this kind opens from, where the card shows one: the stage anchors the chooser to it. */
  anchorFor(kind: 'move' | 'merge' | 'link'): HTMLElement | null {
    const button = this.chooseActs.get(kind)
    return button !== undefined && button.isConnected ? button : null
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.endPricing()
    this.letGoOfHover()
    for (const off of this.unsubscribe) off()
  }

  // -------------------------------------------------------------------------
  // Painting.
  // -------------------------------------------------------------------------

  private schedule(what: 'all' | 'preview' | 'hover'): void {
    if (this.disposed) return
    this.dirty[what] = true
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paint())
  }

  private paint(): void {
    if (this.disposed) return
    const dirty = this.dirty
    this.dirty = { all: false, preview: false, hover: false }
    if (dirty.all) this.paintAll()
    else if (dirty.preview) this.paintPreview()
    this.paintLit()
  }

  /**
   * Whether a step is counted: what the card shows is the binning before it.
   * Dimmed, after a moment so a quick count does not flicker it, and at once
   * when an act was pressed meanwhile; its acts answer nothing till then.
   */
  private markWeighing(): void {
    const model = this.ctx.model
    const weighing = model.stale && model.answer !== null
    this.element.classList.toggle('is-weighing', weighing)
    if (!weighing) this.element.classList.remove('is-waiting')
    if (weighing) this.element.setAttribute('aria-busy', 'true')
    else this.element.removeAttribute('aria-busy')
  }

  private paintAll(): void {
    // Where the keyboard was, to put it back on the same act once drawn again.
    const focus = this.heldFocus()
    // The acts are drawn again: a step one of them priced is let go, and a row
    // under the pointer is no longer there to light its genome.
    this.endPricing()
    this.letGoOfHover()
    this.qualitySlot = null
    this.priceSlots = { acts: null, rows: null }
    this.chooseActs.clear()
    this.lit = []
    this.keyed = false
    const model = this.ctx.model
    const answer = model.answer
    const view = viewOf(answer, model.selection)
    this.element.dataset.selection = view.kind === 'genome' && answer !== null ? answer.genomes[view.g].kind : view.kind
    if (answer === null || view.kind === 'none') this.paintNothing(answer)
    else if (view.kind === 'contigs') this.paintContigs(answer, view.contigs)
    else if (view.kind === 'genome') {
      if (answer.genomes[view.g].kind === 'mag') this.paintMag(answer, view.g)
      else this.paintElement(answer, view.g)
    } else if (view.kind === 'pair') this.paintPair(answer, view.element, view.mag)
    else this.paintGenomes(answer, view.genomes)
    // A step priced already — the review's question, a suggestion hovered — in its place.
    this.paintPrice()
    this.markWeighing()
    this.restoreFocus(focus)
  }

  /**
   * The act the keyboard is on, if it is in the card and the reader is at the
   * keys: its key and its place. After a press of the pointer the focus is left
   * to fall with the act — put back on a button nobody sees focused, it would
   * take the stage's Space and Enter (a focused button's own, §26.4), and Space
   * in review would press it rather than show the question as it would be.
   */
  private heldFocus(): HeldFocus | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !this.body.contains(active)) return null
    if (!this.byKeys) return null
    const buttons = this.focusable()
    return { key: active.dataset.focus ?? null, at: buttons.indexOf(active as HTMLButtonElement) }
  }

  /**
   * The keyboard back where it was once the card is drawn again: on the act of
   * the same name, else on the one at its place — the next row's `take` once a
   * row's was taken — so a reader at the keys is never dropped out of the card.
   */
  private restoreFocus(held: HeldFocus | null): void {
    if (held === null || this.body.contains(document.activeElement)) return
    const buttons = this.focusable()
    if (buttons.length === 0) return
    const same = held.key === null ? undefined : buttons.find((button) => button.dataset.focus === held.key)
    const next = same ?? buttons[Math.min(Math.max(0, held.at), buttons.length - 1)]
    next.focus({ preventScroll: true })
  }

  private focusable(): HTMLButtonElement[] {
    return [...this.body.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !button.disabled)
  }

  /** The selection's lit rows: the genome or contig under the pointer anywhere, the question in review and its members. */
  private paintLit(): void {
    const model = this.ctx.model
    const { genome, contig } = model.hovered
    const current = model.current
    const asked = new Set(current === null ? [] : [current.key, ...current.members.map((member) => member.key)])
    for (const row of this.lit) {
      row.node.classList.toggle('is-lit', (genome !== null && row.genome === genome) || (contig >= 0 && row.contigs !== null && row.contigs.has(contig)))
      row.node.classList.toggle('is-current', row.suggestion !== undefined && asked.has(row.suggestion))
    }
  }

  /** What a priced step would leave: the quality table's after column, the price under what priced it. */
  private paintPreview(): void {
    const slot = this.qualitySlot
    if (slot !== null && slot.node.isConnected) slot.node.replaceChildren(...this.qualityParts(slot.genome))
    this.paintPrice()
  }

  /** The price of the step priced now in its place, the other place emptied. */
  private paintPrice(): void {
    const { acts, rows } = this.priceSlots
    // An act's step over what follows the acts; a row's, or one priced elsewhere — the review's
    // question, a suggestion hovered — at the foot, where it moves nothing that is priced.
    const into = this.pricing?.from === 'acts' && acts !== null ? acts : rows
    const list = into === null ? null : this.priceNow()
    for (const node of [acts, rows]) {
      if (node === null || !node.isConnected) continue
      const shown = node === into && list !== null
      node.replaceChildren(...(shown && list !== null ? [list] : []))
      node.classList.toggle('hidden', !shown)
    }
  }

  /**
   * The pool and the curation's tally, once an answer: both read every contig,
   * which at two million is a frame's worth of work for a card at rest.
   */
  private mapNumbers(answer: CurationStateResult): { pooled: number; pooledLength: number; tally: CurateTally | null } {
    const held = this.numbers
    if (held?.answer === answer) return held
    let pooled = 0
    let pooledLength = 0
    const lengths = this.ctx.data.file.lengths
    for (let c = 0; c < answer.genomeOf.length; c++) {
      if (answer.genomeOf[c] >= 0) continue
      pooled++
      pooledLength += lengths[c] ?? 0
    }
    this.numbers = { answer, pooled, pooledLength, tally: this.ctx.model.tally() }
    return this.numbers
  }

  private changesOf(answer: CurationStateResult): CurationChanges {
    if (this.changes?.answer !== answer) this.changes = { answer, changes: curationChanges(answer, this.ctx.data.file) }
    return this.changes.changes
  }

  // -------------------------------------------------------------------------
  // Nothing selected.
  // -------------------------------------------------------------------------

  private paintNothing(answer: CurationStateResult | null): void {
    this.head.replaceChildren('selection')
    const parts: HTMLElement[] = [
      el('p', {
        class: 'edit-empty',
        text: 'Press a genome in the list or on a map, drag along the map’s diagonal for a run of them, or lasso contigs on the scatter.',
      }),
    ]
    if (answer !== null) {
      const mags = answer.genomes.filter((genome) => genome.kind === 'mag')
      const elements = answer.genomes.length - mags.length
      const { pooled, pooledLength, tally: t } = this.mapNumbers(answer)
      // Every MAG counted once, the counts adding up to the MAGs: by its grade,
      // or under 50% complete — the fragments curation works on, which metaTOR
      // does not grade. With markers stored, every MAG has a quality.
      const grades = { high: 0, medium: 0, low: 0, contaminated: 0, under: 0 }
      let graded = false
      for (const genome of mags) {
        const q = genome.quality
        if (q === null) continue
        graded = true
        grades[grade(q.weightedCompleteness, q.weightedRedundancy) ?? 'under']++
      }
      const tally = el('div', { class: 'curate-selection-tally' })
      tally.appendChild(
        el('div', {
          text: `${countWords(mags.length, 'MAG', 'MAGs')} · ${countWords(elements, 'element', 'elements')} · ${countWords(pooled, 'unbinned contig', 'unbinned contigs')}${pooled > 0 ? ` (${fmt.bp(pooledLength)})` : ''}`,
        }),
      )
      if (graded) {
        const named = { high: 'high quality', medium: 'medium', low: 'low', contaminated: 'contaminated', under: 'under 50% complete' } as const
        // A count and its grade kept on one line: the line breaks between them only.
        const words = (['high', 'medium', 'low', 'contaminated', 'under'] as const).filter((g) => grades[g] > 0).map((g) => `${fmt.int(grades[g])} ${named[g]}`.replace(/ /g, '\u00a0'))
        tally.appendChild(
          el('div', {
            class: 'curate-selection-grades',
            text: words.join(' · '),
            title: 'Every MAG by metaTOR’s grades, on the weighted numbers: high quality at 90% complete or more and 1.05 redundant or less, medium at 70%, low at 50%, contaminated above 1.10 — and under 50% complete, which metaTOR does not grade',
          }),
        )
      }
      if (t !== null) {
        const changed: string[] = []
        if (t.contigsMoved > 0) changed.push(`${countWords(t.contigsMoved, 'contig', 'contigs')} moved (${fmt.bp(t.basesMoved)})`)
        if (t.changed > 0) changed.push(`${fmt.int(t.changed)} changed`)
        if (t.created > 0) changed.push(`${fmt.int(t.created)} new`)
        if (t.gone > 0) changed.push(`${fmt.int(t.gone)} gone`)
        if (t.linksAdded > 0) changed.push(`${countWords(t.linksAdded, 'link', 'links')} added`)
        if (t.linksDropped > 0) changed.push(`${countWords(t.linksDropped, 'link', 'links')} dropped`)
        tally.appendChild(
          el('div', {
            class: 'curate-selection-steps',
            text: t.steps === 0 && changed.length === 0 ? 'as in the file' : `${countWords(t.steps, 'step', 'steps')}${changed.length === 0 ? '' : `: ${changed.join(' · ')}`}`,
          }),
        )
      }
      parts.push(tally)
    }
    this.body.replaceChildren(...parts)
  }

  // -------------------------------------------------------------------------
  // One MAG.
  // -------------------------------------------------------------------------

  private paintMag(answer: CurationStateResult, g: number): void {
    const genome = answer.genomes[g]
    this.setHead('MAG · ', genome)
    const parts: Array<HTMLElement | null> = [this.facts(answer, g)]
    parts.push(this.qualityBlock(genome))
    const model = this.ctx.model
    const merge = this.chooseAct('merge', 'merge into…', 'merge', `Merge ${this.short(genome.id)} into another MAG, which keeps its name`)
    parts.push(
      this.acts(
        this.act('rename', 'pencil', `Rename ${this.short(genome.id)}, in the list`, () => this.hooks.rename(genome.id), SELECTION_KEYS.rename),
        merge,
        this.act('close-up', 'zoom-in', 'Its contigs, and the ones that may belong in it, on the contact map', () => this.hooks.closeUp(), SELECTION_KEYS.closeUp),
        // A retype moves no contig: there is no price to show for it.
        this.stepAct('make it an element', 'arrow-left-right', 'Declare it a mobile element: a plasmid or a phage, never graded; its links go', () => model.retypeSelected('element'), SELECTION_KEYS.newElement),
        this.priced(this.stepAct('dissolve', 'trash-2', 'Send its contigs to the pool: the genome is gone', () => model.dissolveSelected(), SELECTION_KEYS.remove), () => ({ op: 'dissolve', genome: genome.id })),
      ),
    )
    if (!answer.counted) parts.push(this.uncounted('What it meets most, and what may belong in it, once the contacts are read.'))
    else {
      const offered = model.offered()
      parts.push(...this.meetsMost(answer, g, offered))
      parts.push(...this.belongHere(answer, g, offered))
      parts.push(...this.belongElsewhere(answer, g, offered))
    }
    this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
  }

  /** `2.05 Mb · 24 contigs`, its change since the file, and what it hosts or is hosted by. */
  private facts(answer: CurationStateResult, g: number): HTMLElement {
    const genome = answer.genomes[g]
    const change = this.changesOf(answer).genomes[g]
    const chip = change === undefined ? null : changeChip(change)
    const line = el(
      'div',
      { class: 'curate-selection-facts' },
      el('span', { text: `${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}` }),
      chip === null ? null : el('span', { class: 'edit-chip', text: chip, title: changeWords(change) }),
    )
    // A MAG's elements; an element's hosts have a section of their own.
    const hosted = genome.kind === 'mag' ? answer.links.filter((link) => link.mag === genome.id) : []
    if (hosted.length > 0) {
      const names = hosted.map((link) => answer.genomes.find((other) => other.id === link.element)?.name ?? link.element)
      line.appendChild(el('span', { class: 'curate-selection-hosts', text: `hosts ${countWords(hosted.length, 'element', 'elements')}`, title: names.join(', ') }))
    }
    return line
  }

  /** The quality table and its grade, or why there is none. */
  private qualityBlock(genome: Genome): HTMLElement {
    if (genome.quality === null) {
      return el('p', {
        class: 'edit-note',
        text: this.ctx.data.markerSets.length === 0 ? 'No marker genes stored: run metator markers for its completeness and redundancy.' : 'No marker gene of the map’s sets is on its contigs.',
      })
    }
    const node = el('div', { class: 'curate-selection-quality-block' })
    node.replaceChildren(...this.qualityParts(genome))
    this.qualitySlot = { node, genome }
    return node
  }

  /**
   * Completeness and redundancy, weighted and plain, now — and, while a step
   * is priced, after it in the plain numbers' place: metaTOR grades on the
   * weighted ones, and two columns of numbers beside the labels are what the
   * side has room for at its narrowest without cutting one. The table keeps its
   * height either way: it stands above the acts.
   */
  private qualityParts(genome: Genome): HTMLElement[] {
    const q = genome.quality
    if (q === null) return []
    const after = this.afterOf(genome.id)
    const file = this.ctx.model.fileAnswer?.genomes.find((g) => g.id === genome.id)
    const wasQ = genome.asInFile ? null : (file?.quality ?? null)
    const grid = el('div', { class: `curate-selection-quality${after === null ? '' : ' has-after'}`, attrs: { role: 'table', 'aria-label': 'Quality' } })
    const cell = (text: string, cls: string, title?: string): HTMLElement => el('span', { class: cls, text, attrs: { role: 'cell' }, ...(title === undefined ? {} : { title }) })
    const heads = [cell('', 'is-label'), cell('weighted', 'is-head')]
    heads.push(after === null ? cell('plain', 'is-head', 'Every marker counted alike') : cell(after.head, 'is-head is-after', after.title))
    grid.append(el('div', { class: 'curate-selection-quality-row', attrs: { role: 'row' } }, ...heads))
    const row = (label: string, weighted: string, plain: string, warn: boolean, was: string | null, afterText: string | null, shift: Shift): void => {
      const cells = [cell(label, 'is-label', label), cell(weighted, `is-value${warn ? ' is-warn' : ''}`, was === null ? undefined : `${was} in the file`)]
      cells.push(after === null ? cell(plain, 'is-value is-plain') : cell(afterText ?? '—', `is-value is-after${shift === null ? '' : ` is-${shift}`}`, after.title))
      grid.append(el('div', { class: 'curate-selection-quality-row', attrs: { role: 'row' } }, ...cells))
    }
    const pct = (x: number): string => fmt.pct(x, 1)
    const ratio = redundancyText
    const aq = after?.quality ?? null
    // The number that moves its grade, and only that one, wears the colour.
    const shift = aq === null ? { completeness: null, redundancy: null } : qualityShift(q, aq)
    row('completeness', pct(q.weightedCompleteness), pct(q.completeness), false, wasQ === null ? null : pct(wasQ.weightedCompleteness), aq === null ? null : pct(aq.weightedCompleteness), shift.completeness)
    row('redundancy', ratio(q.weightedRedundancy), ratio(q.redundancy), q.weightedRedundancy > 1.1, wasQ === null ? null : ratio(wasQ.weightedRedundancy), aq === null ? null : ratio(aq.weightedRedundancy), shift.redundancy)
    const g = grade(q.weightedCompleteness, q.weightedRedundancy)
    const gradeText = g === null ? 'under 50% complete' : g === 'contaminated' ? 'contaminated' : `${g} quality`
    // What a redundancy above 1 is made of, named in the title.
    const duplicated = q.duplicated
    const line = el(
      'div',
      { class: 'curate-selection-grade' },
      el('span', { text: `${q.set} · ${fmt.int(q.present)} of ${fmt.int(q.markers)} markers · ` }),
      duplicated.length === 0
        ? null
        : el('span', {
            class: 'curate-selection-duplicated',
            text: `${fmt.int(duplicated.length)} duplicated · `,
            title: `Present twice or more: ${duplicated.slice(0, 40).join(', ')}${duplicated.length > 40 ? `, and ${fmt.int(duplicated.length - 40)} more` : ''}`,
          }),
      el('span', { class: g === 'high' ? 'is-high' : g === 'contaminated' ? 'is-warn' : '', text: gradeText, title: 'metaTOR’s grades, on the weighted numbers: high at 90% and 1.05, medium at 70%, low at 50%, contaminated above 1.10' }),
    )
    return [grid, line]
  }

  /** What the step priced now would leave of a genome, or `null` when no step is priced or it leaves the genome as it is. */
  private afterOf(id: string): { quality: Quality | null; head: string; title: string } | null {
    const model = this.ctx.model
    const before = model.answer
    const after = model.previewed
    if (before === null || after === null) return null
    const rows = priceOf(before, after)
    const own = rows.find((row) => row.id === id)
    if (own !== undefined) return { quality: own.after, head: 'after', title: 'As the step priced would leave it' }
    const into = rows.find((row) => row.from.some((from) => from.id === id))
    if (into !== undefined) {
      const name = before.genomes.some((genome) => genome.id === into.id) ? this.short(into.id) : into.name
      return { quality: into.after, head: `in ${name}`, title: `The step priced puts its contigs in ${into.name}: that genome as it would be` }
    }
    if (!after.genomes.some((genome) => genome.id === id)) return { quality: null, head: 'after', title: 'The step priced leaves nothing of it' }
    return null
  }

  /**
   * The genomes of its kind it meets most densely, each affinity put against
   * the background, and `merge` on those whose contacts stand out of it — or
   * whose merge is on offer: a pair that meets no more than strangers do is
   * listed, and the act is left to `merge into…`, so no row offers a merge as
   * prominently at forty times under the background as at forty over it.
   */
  private meetsMost(answer: CurationStateResult, g: number, offered: readonly Suggestion[]): HTMLElement[] {
    const genome = answer.genomes[g]
    const met = this.metBy(answer, g).filter((m) => answer.genomes[m.other].kind === genome.kind)
    if (met.length === 0) return [this.sub(genome.kind === 'mag' ? 'meets most' : 'elements that meet it'), this.note(genome.kind === 'mag' ? 'It meets no other MAG.' : 'No other element meets it.')]
    const merges = offeredMerges(answer, offered)
    const best = genome.kind === 'element' ? this.bestHosts(answer) : null
    const rho = this.background()
    const rows = met.slice(0, 5).map(({ other, affinity, contacts }): RowSpec => {
      const them = answer.genomes[other]
      const s = merges.get(pairKey(genome.id, them.id))
      // The longer keeps its name, as merge does unasked; a merge on offer, as it is offered.
      const [keep, fold] = them.length > genome.length ? [them, genome] : [genome, them]
      const step = (): CurationStep => s?.step ?? { op: 'merge', into: keep.id, genomes: [fold.id] }
      const evidence = this.against(affinity, contacts)
      let detail = `affinity ${evidence.words} · ${contactsText(contacts)}`
      let full = this.affinityInFull(affinity, contacts)
      let chip: HTMLElement | null = null
      if (best !== null) {
        const theirs = best.get(other)
        if (theirs !== undefined) {
          detail += ` · best host ${this.short(answer.genomes[theirs].id)}`
          full += ` · best host ${answer.genomes[theirs].name}`
        }
        if (theirs !== undefined && theirs === best.get(g)) chip = el('span', { class: 'edit-chip', text: 'same best host', title: 'Its strongest MAG is this element’s strongest too: one molecule’s pieces, likely' })
      }
      // A merge's confidence is that the two are one organism's fragments, not that the merge makes a better MAG: its price says that.
      const sure = s === undefined ? null : sureOf(s.confidence, 'one organism')
      const offer = sure === null ? '' : ` · ${sure}`
      const mergeable = s !== undefined || standsOut(affinity, contacts, rho)
      return {
        genome: them.id,
        suggestion: s?.key,
        lead: [swatch(this.ctx.colourOf(them.id).css, them.kind), this.nameOf(them), chip],
        detail,
        words: `${this.short(genome.id)} × ${this.short(them.id)} · ${detail}${offer}`,
        title: `${genome.name} × ${them.name} · ${full}${offer}`,
        confidence: sure,
        confidenceTitle:
          s === undefined ? undefined : `A merge on offer: the method is ${confidenceText(s.confidence)} sure the two are fragments of one organism — what the merge does to the grades is its price, shown while the pointer rests on merge`,
        bounded: evidence.bounded,
        act: mergeable
          ? {
              label: 'merge',
              title: `Merge ${fold.name} into ${keep.name}, which keeps its name`,
              run: () => this.merge(s, keep.id, fold.id),
              // An element's merge is never graded, and its view has no price to show:
              // nothing is counted for it.
              ...(genome.kind === 'mag' ? { step } : {}),
            }
          : null,
      }
    })
    const head = this.sub(genome.kind === 'mag' ? 'meets most' : 'elements that meet it')
    return [head, ...nonNull([this.affinityKey(bounded(rows))]), this.list(rows)]
  }

  /** The offered recruits and moves into a MAG, each with `take`, and all the likely ones in one press. */
  private belongHere(answer: CurationStateResult, g: number, offered: readonly Suggestion[]): HTMLElement[] {
    const into = offered.filter((s) => (s.kind === 'recruit' || s.kind === 'move') && s.genomes[0] === g)
    if (into.length === 0) return []
    const genome = answer.genomes[g]
    const rows = into.map((s): RowSpec => this.contigSuggestionRow(answer, s, 'take', 'in'))
    const parts: HTMLElement[] = [this.sub(`belong here · ${fmt.int(into.length)}`), ...nonNull([this.affinityKey(bounded(rows))]), ...this.capped(`${genome.id}:in`, rows)]
    const likely = into.filter((s) => s.confidence >= LIKELY)
    if (likely.length >= 2) {
      const question = this.takeQuestion(answer, g, likely)
      const length = question.contigs.reduce((sum, c) => sum + (this.ctx.data.file.lengths[c] ?? 0), 0)
      parts.push(
        acts(
          this.priced(
            this.stepAct(
              `take ${fmt.int(likely.length)} at ${LIKELY_PERCENT}% or more`,
              'check',
              `Take the ${fmt.int(likely.length)} suggestions into ${genome.name} at ${LIKELY_PERCENT}% or more, as one step: ${countWords(question.contigs.length, 'contig', 'contigs')}, ${fmt.bp(length)}`,
              () => this.ctx.model.accept(question),
            ),
            () => question.steps[0],
          ),
        ),
      )
    }
    return parts
  }

  /**
   * The likely suggestions into a MAG as one question: one step that moves
   * every contig they name into it — one gesture, undone at once — and every
   * one of them learned as taken, as the review's questions are
   * (`curate/questions.ts`).
   */
  private takeQuestion(answer: CurationStateResult, g: number, list: readonly Suggestion[]): Question {
    const target = answer.genomes[g]
    const names = this.ctx.data.file.names
    const members = [...list].sort((x, y) => y.confidence - x.confidence || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    const contigs = [...new Set(members.flatMap((s) => s.contigs))]
    const fromPool = contigs.every((c) => answer.genomeOf[c] < 0)
    const step: CurationStep = { op: 'move', contigs: contigs.map((c) => names[c]).filter((name): name is string => name !== undefined), to: target.id }
    const contacts = members.reduce((sum, s) => sum + s.contacts, 0)
    const what = contigs.length === 1 ? (names[contigs[0]] ?? 'a contig') : `${fmt.int(contigs.length)} contigs`
    return {
      key: `take:${target.id}:${members.map((s) => s.key).sort().join(',')}`,
      kind: fromPool ? 'recruit' : 'move',
      step,
      words: `${fromPool ? 'recruit' : 'move'} ${what} into ${target.name}`,
      confidence: Math.min(...members.map((s) => s.confidence)),
      features: members[members.length - 1].features,
      evidence: [`${fmt.int(members.length)} suggestions`, `each at ${LIKELY_PERCENT}% or more`, contactsText(contacts)],
      genomes: [g],
      contigs,
      affinity: Math.min(...members.map((s) => s.affinity)),
      contacts,
      members,
      steps: [step],
    }
  }

  /** The offered moves out of a MAG, each with `move`. */
  private belongElsewhere(answer: CurationStateResult, g: number, offered: readonly Suggestion[]): HTMLElement[] {
    const out = offered.filter((s) => s.kind === 'move' && s.genomes[1] === g)
    if (out.length === 0) return []
    const rows = out.map((s): RowSpec => this.contigSuggestionRow(answer, s, 'move', 'out'))
    return [this.sub(`may belong elsewhere · ${fmt.int(out.length)}`), ...nonNull([this.affinityKey(bounded(rows))]), ...this.capped(`${answer.genomes[g].id}:out`, rows)]
  }

  /** A recruit or a move as a row: the contig, where from or where to, its numbers, its act. */
  private contigSuggestionRow(answer: CurationStateResult, s: Suggestion, label: string, side: 'in' | 'out'): RowSpec {
    const names = this.ctx.data.file.names
    const target = answer.genomes[s.genomes[0]]
    const one = s.contigs.length === 1
    const c = s.contigs[0]
    const own = answer.genomeOf[c]
    const lead: Array<Node | null> = [
      el('span', { class: 'curate-selection-row-name', text: one ? (names[c] ?? `#${c}`) : `${fmt.int(s.contigs.length)} contigs`, title: one ? names[c] : s.contigs.map((k) => names[k]).join(', ') }),
    ]
    // Out: where it would go opens the second line, so neither name is cut to make room for the other.
    const detailLead: Array<Node | string | null> = []
    if (side === 'out') detailLead.push(el('span', { class: 'curate-selection-to' }, el('span', { class: 'curate-selection-arrow', text: '→' }), swatch(this.ctx.colourOf(target.id).css, target.kind), this.nameOf(target)), ' · ')
    // A group of recruits carries its least affinity and every member's contacts: no bound is drawn from the two.
    const there = this.against(s.affinity, one ? s.contacts : null)
    let detail: string
    if (side === 'out') detail = `its own ${this.plainAffinity(answer.contigs.ownAffinity[c])} · there ${there.words} · ${contactsText(s.contacts)}`
    else {
      const from = one ? (own < 0 ? 'from the pool' : `from ${this.short(answer.genomes[own].id)}`) : fmt.bp(s.contigs.reduce((sum, k) => sum + (this.ctx.data.file.lengths[k] ?? 0), 0))
      detail = `${from} · affinity ${there.words} · ${contactsText(s.contacts)}`
    }
    // What the confidence is sure of — that the contig belongs where the step
    // would put it — is the list's heading (`belong here`, `may belong
    // elsewhere`): the row says `sure`, its title the sentence.
    const sure = sureOf(s.confidence, 'sure')
    const what = one ? (names[c] ?? `#${c}`) : `${fmt.int(s.contigs.length)} contigs`
    return {
      genome: side === 'out' ? target.id : undefined,
      contigs: s.contigs,
      suggestion: s.key,
      lead,
      detailLead,
      detail,
      words: `${what} ${side === 'out' ? '→' : 'into'} ${this.short(target.id)} · ${detail} · ${sure}`,
      title: `${s.words} · ${sure} · ${s.evidence.join(' · ')}`,
      confidence: sure,
      confidenceTitle: `The method is ${confidenceText(s.confidence)} sure ${one ? 'it belongs' : 'they belong'} in ${target.name}`,
      bounded: there.bounded,
      act: { label, title: `${capitalise(s.words)}: ${sure}`, run: () => this.ctx.model.accept(s), step: () => s.step },
    }
  }

  // -------------------------------------------------------------------------
  // One element.
  // -------------------------------------------------------------------------

  private paintElement(answer: CurationStateResult, g: number): void {
    const genome = answer.genomes[g]
    this.setHead('element · ', genome)
    const model = this.ctx.model
    const parts: Array<HTMLElement | null> = [this.facts(answer, g)]
    parts.push(
      this.acts(
        this.chooseAct('link', 'link to…', 'link', `Link ${this.short(genome.id)} to the MAG that hosts it`),
        this.chooseAct('merge', 'merge into…', 'merge', `Merge ${this.short(genome.id)} into another element, which keeps its name`),
        this.act('rename', 'pencil', `Rename ${this.short(genome.id)}, in the list`, () => this.hooks.rename(genome.id), SELECTION_KEYS.rename),
        // An element is never graded: neither act has a price to show.
        this.stepAct('make it a MAG', 'arrow-left-right', 'Declare it a MAG, graded by its markers; its links go', () => model.retypeSelected('mag'), SELECTION_KEYS.newMag),
        this.stepAct('dissolve', 'trash-2', 'Send its contigs to the pool: the element is gone', () => model.dissolveSelected(), SELECTION_KEYS.remove),
      ),
    )
    const offered = model.offered()
    parts.push(...this.hosts(answer, g, offered))
    if (!answer.counted) parts.push(this.uncounted('Its hosts’ numbers, and the elements that meet it, once the contacts are read.'))
    else parts.push(...this.meetsMost(answer, g, offered))
    this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
  }

  /** An element's hosts: the links held, then the links offered. */
  private hosts(answer: CurationStateResult, e: number, offered: readonly Suggestion[]): HTMLElement[] {
    const element = answer.genomes[e]
    const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
    const rows: RowSpec[] = []
    for (const link of answer.links) {
      if (link.element !== element.id) continue
      const m = index.get(link.mag)
      if (m === undefined) continue
      const mag = answer.genomes[m]
      const pair = answer.hosts.find((h) => h.element === e && h.mag === m)
      const s = offered.find((o) => o.kind === 'unlink' && o.genomes[0] === e && o.genomes[1] === m)
      const numbers = !answer.counted ? '' : pair === undefined ? ' · no contact between them' : ` · ${this.hostNumbers(pair)}`
      // An unlink's confidence is that the MAG does not host it.
      const sure = s === undefined ? null : sureOf(s.confidence, 'not its host')
      rows.push({
        genome: mag.id,
        suggestion: s?.key,
        lead: [swatch(this.ctx.colourOf(mag.id).css, mag.kind), this.nameOf(mag), el('span', { class: 'edit-chip', text: 'linked' })],
        detail: `${link.fromFile ? 'from the file' : 'added'}${numbers}`,
        words: `${this.short(element.id)} ↔ ${this.short(mag.id)} · linked, ${link.fromFile ? 'from the file' : 'added'}${numbers}${sure === null ? '' : ` · unlink offered, ${sure}`}`,
        title: `${element.name} ↔ ${mag.name} · linked, ${link.fromFile ? 'from the file' : 'added'}${pair === undefined || !answer.counted ? numbers : ` · ${this.hostNumbers(pair, true)}`}`,
        confidence: sure,
        confidenceTitle: s === undefined ? undefined : `An unlink on offer: the method is ${confidenceText(s.confidence)} sure ${mag.name} does not host ${element.name}`,
        bounded: pair !== undefined && answer.counted && this.against(pair.affinity, pair.contacts).bounded,
        act: {
          label: 'unlink',
          title: s === undefined ? `Unlink ${element.name} from ${mag.name}` : `${capitalise(s.words)}: ${sure}`,
          run: () => (s === undefined ? this.ctx.model.link(element.id, mag.id, false) : this.ctx.model.accept(s)),
        },
      })
    }
    for (const s of offered) {
      if (s.kind !== 'link' || s.genomes[0] !== e) continue
      const m = s.genomes[1]
      const mag = answer.genomes[m]
      if (mag === undefined) continue
      const pair = answer.hosts.find((h) => h.element === e && h.mag === m)
      const numbers = pair === undefined ? '' : this.hostNumbers(pair)
      // A link's confidence is that the MAG hosts it.
      const sure = sureOf(s.confidence, 'its host')
      rows.push({
        genome: mag.id,
        suggestion: s.key,
        lead: [swatch(this.ctx.colourOf(mag.id).css, mag.kind), this.nameOf(mag)],
        detail: `offered · ${numbers}`,
        words: `${this.short(element.id)} ↔ ${this.short(mag.id)} · link offered, ${sure} · ${numbers}`,
        title: [s.words, sure, ...(pair === undefined ? [] : [this.hostNumbers(pair, true)])].join(' · '),
        confidence: sure,
        confidenceTitle: `A link on offer: the method is ${confidenceText(s.confidence)} sure ${mag.name} hosts ${element.name}`,
        bounded: pair !== undefined && this.against(pair.affinity, pair.contacts).bounded,
        act: { label: 'link', title: `${capitalise(s.words)}: ${sure}`, run: () => this.ctx.model.accept(s) },
      })
    }
    if (rows.length === 0) return [this.sub('hosts'), this.note(answer.counted ? 'Linked to no MAG, and no link is offered.' : 'Linked to no MAG.')]
    return [this.sub('hosts'), ...nonNull([this.affinityKey(bounded(rows))]), this.list(rows)]
  }

  /**
   * `affinity 0.53 (at least 20× background) · 99% of its MAG contacts · 120
   * contacts`; `full`, the affinity's numbers in full, for a title.
   */
  private hostNumbers(pair: CurationStateResult['hosts'][number], full = false): string {
    const affinity = full ? this.affinityInFull(pair.affinity, pair.contacts) : `affinity ${this.against(pair.affinity, pair.contacts).words}`
    return `${affinity} · ${fmt.pct(pair.share, 0)} of its MAG contacts${full ? '' : ` · ${contactsText(pair.contacts)}`}`
  }

  /** Every element's strongest MAG, by the host map's affinity. */
  private bestHosts(answer: CurationStateResult): Map<number, number> {
    const best = new Map<number, { mag: number; affinity: number }>()
    for (const pair of answer.hosts) {
      const held = best.get(pair.element)
      if (held === undefined || pair.affinity > held.affinity) best.set(pair.element, { mag: pair.mag, affinity: pair.affinity })
    }
    return new Map([...best].map(([e, { mag }]) => [e, mag]))
  }

  // -------------------------------------------------------------------------
  // An element and a MAG.
  // -------------------------------------------------------------------------

  private paintPair(answer: CurationStateResult, e: number, m: number): void {
    const element = answer.genomes[e]
    const mag = answer.genomes[m]
    this.head.replaceChildren('pair · ', nameSpan(this.short(element.id), element.name), ' ↔ ', nameSpan(this.short(mag.id), mag.name))
    const model = this.ctx.model
    const link = answer.links.find((l) => l.element === element.id && l.mag === mag.id)
    const pair = answer.hosts.find((h) => h.element === e && h.mag === m)
    const offered = model.offered()
    const s = offered.find((o) => (o.kind === 'link' || o.kind === 'unlink') && o.genomes[0] === e && o.genomes[1] === m)
    const parts: Array<HTMLElement | null> = [
      el(
        'div',
        { class: 'curate-selection-pair' },
        ...[element, mag].map((genome) =>
          el(
            'div',
            { class: 'curate-selection-pair-genome' },
            swatch(this.ctx.colourOf(genome.id).css, genome.kind),
            this.nameOf(genome),
            el('span', { class: 'curate-selection-dim', text: `${genome.kind === 'mag' ? 'MAG' : 'element'} · ${fmt.bp(genome.length)}` }),
          ),
        ),
      ),
      el('div', {
        class: 'curate-selection-facts',
        text: link === undefined ? 'not linked' : `linked, ${link.fromFile ? 'from the file' : 'added by the curation'}`,
      }),
    ]
    if (!answer.counted) parts.push(this.uncounted('The pair’s numbers once the contacts are read.'))
    else if (pair === undefined) parts.push(this.note('No contact between them.'))
    else {
      parts.push(
        el('div', {
          class: 'curate-selection-numbers',
          text: this.hostNumbers(pair),
          title: `Its affinity with the MAG against the background, the share of its contacts with MAGs that go to this one, and the contacts — ${this.hostNumbers(pair, true)}`,
        }),
      )
    }
    // What the method is sure of, said as such: a link's confidence is that the MAG hosts it, an unlink's that it does not.
    const hosts = s !== undefined ? (s.kind === 'link' ? sureOf(s.confidence, 'its host') : sureOf(s.confidence, 'not its host')) : pair !== undefined && answer.counted ? sureOf(pair.confidence, 'its host') : null
    if (hosts !== null) {
      const sentence = (confidence: number, not: boolean): string => `the method is ${confidenceText(confidence)} sure ${mag.name} ${not ? 'does not host' : 'hosts'} ${element.name}`
      parts.push(
        el(
          'div',
          { class: `curate-selection-offer${s === undefined ? ' is-quiet' : ''}` },
          el('span', {
            text: s === undefined ? hosts : `${s.kind === 'link' ? 'link' : 'unlink'} offered: ${hosts}`,
            title: s === undefined ? `Nothing is offered: ${sentence(pair?.confidence ?? 0, false)}` : `${capitalise(sentence(s.confidence, s.kind === 'unlink'))} · ${s.evidence.join(' · ')}`,
          }),
        ),
      )
    }
    // What `at least` means, under what the method is sure of rather than between the two.
    if (answer.counted && pair !== undefined) parts.push(this.affinityKey(this.against(pair.affinity, pair.contacts).bounded))
    const linkAct = this.stepAct('link', 'link', `Link ${element.name} to ${mag.name}: the MAG hosts it`, () => (s?.kind === 'link' ? model.accept(s) : model.link(element.id, mag.id, true)), SELECTION_KEYS.link)
    const unlinkAct = this.stepAct('unlink', 'unlink', `Unlink ${element.name} from ${mag.name}`, () => (s?.kind === 'unlink' ? model.accept(s) : model.link(element.id, mag.id, false)), SELECTION_KEYS.remove)
    parts.push(this.acts(link === undefined ? linkAct : unlinkAct, this.act('close-up', 'zoom-in', 'Their contigs on the contact map', () => this.hooks.closeUp(), SELECTION_KEYS.closeUp)))
    this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
  }

  // -------------------------------------------------------------------------
  // Several genomes.
  // -------------------------------------------------------------------------

  private paintGenomes(answer: CurationStateResult, genomes: number[]): void {
    const model = this.ctx.model
    const kinds = new Set(genomes.map((g) => answer.genomes[g].kind))
    const mags = genomes.filter((g) => answer.genomes[g].kind === 'mag')
    const elements = genomes.filter((g) => answer.genomes[g].kind === 'element')
    this.head.replaceChildren(kinds.size > 1 ? `${fmt.int(genomes.length)} genomes` : `${fmt.int(genomes.length)} ${mags.length > 0 ? 'MAGs' : 'elements'}`)
    const length = genomes.reduce((sum, g) => sum + answer.genomes[g].length, 0)
    const contigs = genomes.reduce((sum, g) => sum + answer.genomes[g].contigs, 0)
    // The head counts one kind; of two, the facts say how many of each.
    const counts = kinds.size > 1 ? [countWords(mags.length, 'MAG', 'MAGs'), countWords(elements.length, 'element', 'elements')] : []
    const parts: Array<HTMLElement | null> = [el('div', { class: 'curate-selection-facts', text: [...counts, fmt.bp(length), countWords(contigs, 'contig', 'contigs')].join(' · ') })]
    // The longest keeps its name, as `merge` makes it.
    const survivor = [...genomes].sort((x, y) => answer.genomes[y].length - answer.genomes[x].length)[0]
    const merge = this.priced(
      this.stepAct('merge', 'merge', `Merge them into ${answer.genomes[survivor].name}, the longest, which keeps its name`, () => model.mergeSelected(), SELECTION_KEYS.merge),
      () => ({ op: 'merge', into: answer.genomes[survivor].id, genomes: genomes.filter((g) => g !== survivor).map((g) => answer.genomes[g].id) }),
    )
    if (kinds.size > 1) refuse(merge, 'Only genomes of one kind merge: an element and a MAG are linked')
    const link = this.stepAct(
      'link',
      'link',
      mags.length === 1 ? `Link the ${elements.length === 1 ? 'element' : `${fmt.int(elements.length)} elements`} to ${answer.genomes[mags[0]].name}` : 'Link elements to a MAG',
      () => this.linkAll(answer, elements, mags),
      SELECTION_KEYS.link,
    )
    if (elements.length === 0) refuse(link, 'Select an element and the MAG that hosts it to link them')
    else if (mags.length !== 1) refuse(link, mags.length === 0 ? 'Select the MAG that hosts them too' : 'Link elements to one MAG at a time')
    parts.push(
      this.pricedActs(
        merge,
        kinds.size > 1 ? link : null,
        this.act('close-up', 'zoom-in', 'Their contigs, side by side, on the contact map', () => this.hooks.closeUp(), SELECTION_KEYS.closeUp),
        mags.length > 0 ? this.stepAct('make them elements', 'arrow-left-right', 'Declare them mobile elements; their links go', () => model.retypeSelected('element'), SELECTION_KEYS.newElement) : null,
        elements.length > 0 ? this.stepAct('make them MAGs', 'arrow-left-right', 'Declare them MAGs; their links go', () => model.retypeSelected('mag'), SELECTION_KEYS.newMag) : null,
        this.stepAct('dissolve', 'trash-2', 'Send their contigs to the pool: the genomes are gone', () => model.dissolveSelected(), SELECTION_KEYS.remove),
      ),
    )
    const shown = genomes.slice(0, MATRIX_MOST)
    const rows = shown.map((g, k): RowSpec => {
      const genome = answer.genomes[g]
      const q = genome.quality
      return {
        genome: genome.id,
        lead: [el('span', { class: 'curate-selection-index', text: String(k + 1) }), swatch(this.ctx.colourOf(genome.id).css, genome.kind), this.nameOf(genome)],
        detail: `${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}${q === null ? '' : ` · ${fmt.pct(q.weightedCompleteness, 0)} complete · ${redundancyText(q.weightedRedundancy)} redundant`}`,
        words: `${this.short(genome.id)} · ${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}`,
        title: `${genome.name} · ${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}`,
      }
    })
    parts.push(this.list(rows))
    if (genomes.length > shown.length) parts.push(this.note(`and ${fmt.int(genomes.length - shown.length)} more, left out of the affinities`))
    if (!answer.counted) parts.push(this.uncounted('Their affinities with one another, once the contacts are read.'))
    else parts.push(this.sub('affinities'), this.matrix(answer, shown, model.offered()))
    parts.push(this.priceBlock('rows'))
    this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
  }

  /**
   * Each two genomes' affinity, a cell each, tinted as the contact map colours
   * the pair — by the lower bound its contacts allow, on a log scale from the
   * background to twice a genome's own density — in the ink, since a tint is
   * no act; a merge on offer ringed in the accent, as the map marks one.
   */
  private matrix(answer: CurationStateResult, genomes: number[], offered: readonly Suggestion[]): HTMLElement {
    const at = new Map<string, { affinity: number; contacts: number }>()
    const { pairs } = answer
    for (let k = 0; k < pairs.a.length; k++) at.set(`${pairs.a[k]}:${pairs.b[k]}`, { affinity: pairs.affinity[k], contacts: pairs.contacts[k] })
    const merges = offeredMerges(answer, offered)
    const measured = this.background()
    const rho = measured ?? FALLBACK_BACKGROUND
    const low = Math.log10(rho)
    const high = Math.log10(AFFINITY_SATURATES)
    const grid = el('div', { class: 'curate-selection-matrix', attrs: { role: 'table', 'aria-label': 'Affinities' } })
    grid.style.setProperty('--n', String(genomes.length))
    grid.appendChild(el('span', { class: 'curate-selection-matrix-corner' }))
    genomes.forEach((g, k) => grid.appendChild(el('span', { class: 'curate-selection-matrix-head', text: String(k + 1), title: answer.genomes[g].name })))
    genomes.forEach((a, i) => {
      grid.appendChild(el('span', { class: 'curate-selection-matrix-head is-row', text: String(i + 1), title: answer.genomes[a].name }))
      genomes.forEach((b, j) => {
        if (i === j) {
          grid.appendChild(el('span', { class: 'curate-selection-cell is-self', text: '·', title: `${answer.genomes[a].name}: 1 is its own density` }))
          return
        }
        const pair = at.get(a < b ? `${a}:${b}` : `${b}:${a}`)
        const names = `${answer.genomes[a].name} × ${answer.genomes[b].name}`
        if (pair === undefined) {
          grid.appendChild(el('span', { class: 'curate-selection-cell is-none', text: '—', title: `${names}: no contact` }))
          return
        }
        const lower = lowerAffinity(pair.affinity, pair.contacts)
        const heat = lower > 0 ? Math.max(0, Math.min(1, (Math.log10(lower) - low) / (high - low))) : 0
        const s = merges.get(pairKey(answer.genomes[a].id, answer.genomes[b].id))
        const title = `${names} · ${this.affinityInFull(pair.affinity, pair.contacts)}${s === undefined ? '' : ` · a merge on offer, ${sureOf(s.confidence, 'one organism')}`}`
        // A pair that meets no more than strangers do is quiet, as its tint is.
        const under = measured !== null && pair.affinity <= measured
        const cell = el('span', { class: `curate-selection-cell${s === undefined ? '' : ' is-offered'}${under ? ' is-under' : ''}`, text: affinityNumber(pair.affinity), title })
        cell.style.setProperty('--heat', heat.toFixed(3))
        grid.appendChild(cell)
      })
    })
    return grid
  }

  // -------------------------------------------------------------------------
  // Contigs.
  // -------------------------------------------------------------------------

  private paintContigs(answer: CurationStateResult, contigs: number[]): void {
    const { file, gc, coverage, coverageLabel } = this.ctx.data
    const model = this.ctx.model
    const one = contigs.length === 1
    if (one) this.head.replaceChildren('contig · ', nameSpan(file.names[contigs[0]] ?? `#${contigs[0]}`))
    else this.head.replaceChildren(`${fmt.int(contigs.length)} contigs`)
    const length = contigs.reduce((sum, c) => sum + (file.lengths[c] ?? 0), 0)
    // Where they are: the pool, then each genome by how many it holds.
    const where = new Map<number, number>()
    for (const c of contigs) where.set(answer.genomeOf[c], (where.get(answer.genomeOf[c]) ?? 0) + 1)
    const pooled = where.get(-1) ?? 0
    const held = [...where].filter(([g]) => g >= 0).sort((x, y) => y[1] - x[1] || x[0] - y[0])
    const parts: Array<HTMLElement | null> = []
    if (one) {
      const c = contigs[0]
      const bits = [fmt.bp(file.lengths[c] ?? 0)]
      if (gc !== null && Number.isFinite(gc[c])) bits.push(`GC ${fmt.pct(gc[c] / 100, 1)}`)
      if (coverage !== null && Number.isFinite(coverage[c])) bits.push(`${fmt.fixed(coverage[c], 1)} ${coverageLabel}`)
      bits.push(answer.genomeOf[c] < 0 ? 'unbinned' : `in ${this.short(answer.genomes[answer.genomeOf[c]].id)}`)
      parts.push(el('div', { class: 'curate-selection-facts', text: bits.join(' · ') }))
    } else {
      const bits = [fmt.bp(length)]
      if (pooled > 0) bits.push(`${fmt.int(pooled)} unbinned`)
      for (const [g, n] of held.slice(0, 3)) bits.push(`${fmt.int(n)} in ${this.short(answer.genomes[g].id)}`)
      if (held.length > 3) bits.push(`${fmt.int(held.slice(3).reduce((sum, [, n]) => sum + n, 0))} in ${fmt.int(held.length - 3)} more`)
      parts.push(el('div', { class: 'curate-selection-facts', text: bits.join(' · ') }))
    }
    const names = contigs.map((c) => file.names[c]).filter((name): name is string => name !== undefined)
    const binned = contigs.filter((c) => answer.genomeOf[c] >= 0)
    const unbin = this.priced(this.stepAct('unbin', 'minus', one ? 'Send it to the pool, out of every genome' : 'Send them to the pool, out of every genome', () => model.moveSelected(null), SELECTION_KEYS.remove), () =>
      binned.length === 0 ? null : { op: 'move', contigs: binned.map((c) => file.names[c]), to: null },
    )
    if (binned.length === 0) refuse(unbin, one ? 'It is unbinned already' : 'They are unbinned already')
    parts.push(
      this.pricedActs(
        this.chooseAct('move', 'move to…', 'move', one ? 'Move it to a genome, chosen by what it meets most' : 'Move them to a genome, chosen by what they meet most'),
        this.priced(this.stepAct('new MAG', 'plus', one ? 'A new MAG of it' : 'A new MAG of them', () => model.createFromSelected('mag'), SELECTION_KEYS.newMag), () => {
          const minted = model.mint('mag')
          return { op: 'create', id: minted.id, name: minted.name, kind: 'mag', contigs: names }
        }),
        this.priced(this.stepAct('new element', 'circle-dot', one ? 'A new mobile element of it' : 'A new mobile element of them', () => model.createFromSelected('element'), SELECTION_KEYS.newElement), () => {
          const minted = model.mint('element')
          return { op: 'create', id: minted.id, name: minted.name, kind: 'element', contigs: names }
        }),
        unbin,
      ),
    )
    if (!answer.counted) parts.push(this.uncounted(one ? 'The genomes it meets most, once the contacts are read.' : 'The genomes they meet most, once the contacts are read.'))
    else parts.push(...this.contigsMeet(answer, contigs))
    parts.push(this.priceBlock('rows'))
    this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
  }

  /**
   * The genomes the contigs meet most: each contig's own where it meets it at
   * least as densely as any other MAG, else the MAG it meets most — counted, and
   * the ones not in it moved there by its row's act.
   */
  private contigsMeet(answer: CurationStateResult, contigs: number[]): HTMLElement[] {
    const places = answer.contigs
    const one = contigs.length === 1
    const { most, next } = contigHomes(answer, contigs)
    // One contig at home: where it would go next, for a reader who moves it anyway.
    const homes = one ? [...most, ...next.slice(0, 1).map((home) => ({ ...home, next: true }))] : most.slice(0, 5)
    if (homes.length === 0) return [this.sub(one ? 'meets most' : 'meet most'), this.note(one ? 'It meets no MAG.' : 'They meet no MAG.')]
    const offered = this.ctx.model.offered()
    const chosen = new Set(contigs)
    const c = contigs[0]
    const ownWords = answer.genomeOf[c] >= 0 && Number.isFinite(places.ownAffinity[c]) ? ` · its own ${this.plainAffinity(places.ownAffinity[c])}` : ''
    const rows = homes.map((home): RowSpec => {
      const genome = answer.genomes[home.genome]
      const { movers } = home
      const moving = new Set(movers)
      // A suggestion on offer that moves exactly these contigs there is taken as the suggestion.
      const s = offered.find((o) => (o.kind === 'recruit' || o.kind === 'move') && o.genomes[0] === home.genome && o.contigs.length === moving.size && o.contigs.every((k) => moving.has(k)))
      const anyOffer = offered.filter((o) => (o.kind === 'recruit' || o.kind === 'move') && o.genomes[0] === home.genome && o.contigs.some((k) => chosen.has(k)))
      const surest = anyOffer.reduce<Suggestion | null>((most, o) => (most === null || o.confidence > most.confidence ? o : most), null)
      const affinity = this.plainAffinity(home.affinity)
      let detail: string
      if (one) {
        if ('next' in home) detail = `meets it next · affinity ${affinity}${ownWords}`
        else if (movers.length === 0) detail = `its own · affinity ${affinity}`
        else detail = `affinity ${affinity}${ownWords}`
      } else {
        // Counted over the contigs that meet it most, which the row's act moves —
        // the ones of them in it already, never the selection's in it, which the
        // facts count: `3 of them in it already` beside `move 1` adds up to the `4`.
        const n = home.contigs.length
        const already = n - movers.length
        const held = already === 0 ? '' : already === n ? (n === 1 ? ', in it already' : ', all in it already') : `, ${fmt.int(already)} of them in it already`
        detail = `${fmt.int(n)} of ${fmt.int(contigs.length)} ${n === 1 ? 'meets' : 'meet'} it most${held} · affinity ${affinity}`
      }
      // The surest move or recruit on offer towards it, as what it is sure of.
      const sure = surest === null ? null : sureOf(surest.confidence, `${surest.contigs.length === 1 ? 'belongs' : 'belong'} there`)
      const offerWords =
        surest === null
          ? undefined
          : `${surest.kind === 'recruit' ? 'A recruit' : 'A move'} on offer: the method is ${confidenceText(surest.confidence)} sure ${surest.contigs.length === 1 ? `${this.ctx.data.file.names[surest.contigs[0]] ?? 'its contig'} belongs` : `its ${fmt.int(surest.contigs.length)} contigs belong`} in ${genome.name}`
      return {
        genome: genome.id,
        contigs: home.contigs,
        suggestion: s?.key,
        lead: [swatch(this.ctx.colourOf(genome.id).css, genome.kind), this.nameOf(genome)],
        detail,
        words: `${this.nameWords(home.contigs)} · ${this.short(genome.id)} · ${detail}${sure === null ? '' : ` · ${sure}`}`,
        title: `${this.nameWords(home.contigs)} · ${genome.name} · ${detail}${offerWords === undefined ? '' : ` · ${offerWords}`}`,
        confidence: sure,
        confidenceTitle: offerWords,
        act:
          movers.length === 0
            ? null
            : {
                label: one || movers.length === contigs.length ? 'move' : `move ${fmt.int(movers.length)}`,
                title:
                  s === undefined
                    ? `Move ${this.nameWords(movers)} to ${genome.name}`
                    : `${capitalise(s.words)}: ${sureOf(s.confidence, `${s.contigs.length === 1 ? 'belongs' : 'belong'} there`)}`,
                run: () => (s === undefined ? this.ctx.model.drop({ kind: 'contigs', contigs: movers }, { kind: 'genome', id: genome.id }) : this.ctx.model.accept(s)),
                step: () => s?.step ?? { op: 'move', contigs: movers.map((k) => this.ctx.data.file.names[k]), to: genome.id },
              },
      }
    })
    return [this.sub(one ? 'meets most' : 'meet most'), this.list(rows)]
  }

  // -------------------------------------------------------------------------
  // The parts every view is made of.
  // -------------------------------------------------------------------------

  /** `MAG · ` and the genome's name in its own case, short, the full name in its title. */
  private setHead(words: string, genome: Genome): void {
    this.head.replaceChildren(words, nameSpan(this.short(genome.id), genome.name))
  }

  private short(id: string): string {
    return this.ctx.shortName(id)
  }

  private nameOf(genome: Genome): HTMLElement {
    return el('span', { class: 'curate-selection-row-name', text: this.short(genome.id), title: genome.name })
  }

  /** Contigs as words: a name for one, a count for more. */
  private nameWords(contigs: readonly number[]): string {
    return contigs.length === 1 ? (this.ctx.data.file.names[contigs[0]] ?? 'a contig') : `${fmt.int(contigs.length)} contigs`
  }

  private sub(text: string): HTMLElement {
    return el('h4', { class: 'edit-card-sub curate-selection-sub', text })
  }

  private note(text: string): HTMLElement {
    return el('p', { class: 'edit-note', text })
  }

  private uncounted(text: string): HTMLElement {
    return el('p', { class: 'edit-note curate-selection-uncounted', text })
  }

  /** The map's background, the rate of spurious ligation, once the contacts are read. */
  private background(): number | null {
    const rho = this.ctx.data.background
    return rho !== null && rho > 0 ? rho : null
  }

  /** An affinity put against the background (`affinityAgainst`). */
  private against(a: number, contacts: number | null): { words: string; bounded: boolean } {
    return affinityAgainst(a, contacts, this.background())
  }

  /**
   * An affinity a step's evidence is weighed against rather than the evidence
   * itself — a contig's with its own genome, where contigs meet a genome most
   * on average —: its number, or `below the background` at or under it.
   */
  private plainAffinity(a: number): string {
    const rho = this.background()
    return rho !== null && a > 0 && a <= rho ? 'below the background' : affinityNumber(a)
  }

  /**
   * An affinity in full, for a title: the number, the bound its contacts allow,
   * and where that stands against the background — `affinity 1.50, at least
   * 1.42 on 540 contacts: 60× the background (0.024)`.
   */
  private affinityInFull(a: number, contacts: number): string {
    const rho = this.background()
    const lower = lowerAffinity(a, contacts)
    const words = `affinity ${affinityText(a)}, at least ${affinityText(lower)} on ${contactsText(contacts)}`
    if (rho === null || !(a > 0)) return words
    const where = lower > rho ? `${timesText(lower / rho)} the background` : a > rho ? 'within the background' : 'below the background'
    return `${words}: ${where} (${affinityText(rho)})`
  }

  /**
   * What `at least` means, said once a drawing, under the first list that
   * leans on it, with the background every affinity is put against: the
   * lower bound is what the contact map colours by and the method trusts.
   */
  private affinityKey(needed: boolean): HTMLElement | null {
    const rho = this.background()
    if (!needed || this.keyed || rho === null) return null
    this.keyed = true
    return el('p', {
      class: 'curate-selection-key',
      text: `at least: the cautious lower bound the contacts allow · the background ${affinityText(rho)}`,
      title: `Affinity is how densely they meet against how densely a genome’s own contigs meet each other: 1 is as its own. At least is its one-sided 90% lower bound on the contacts it rests on, which the contact map colours by — cautious where they are few. The background, ${affinityText(rho)}, is the rate of spurious ligation: a pair at or under it meets no more than strangers do.`,
    })
  }

  /**
   * A place for the price of the step priced now: over what follows the acts
   * (`acts`, a popover the pointer passes through), or at the card's foot
   * (`rows`); hidden while no step that concerns the selection is priced there.
   */
  private priceBlock(slot: PriceSlot): HTMLElement {
    const node = el('div', { class: `curate-selection-price${slot === 'acts' ? ' is-over' : ''} hidden`, attrs: { 'aria-live': 'polite', 'data-slot': slot } })
    this.priceSlots[slot] = node
    return node
  }

  /** The selection's acts with a place for their steps' price, over what follows them. */
  private pricedActs(...buttons: Array<HTMLButtonElement | null>): HTMLElement {
    const row = this.acts(...buttons)
    row.appendChild(this.priceBlock('acts'))
    return row
  }

  /**
   * What the step priced now leaves, genome by genome — where it concerns the
   * selection: moves one of its contigs, or changes one of its genomes. The
   * review's question about other genomes is its band's to price, and the
   * chooser prices its own row under it.
   */
  private priceNow(): HTMLElement | null {
    const model = this.ctx.model
    const before = model.answer
    const after = model.previewed
    if (before === null || after === null || Chooser.isOpen() || !this.concerns(before, after)) return null
    return priceList(before, after, (id, name) => (before.genomes.some((genome) => genome.id === id) ? this.short(id) : name))
  }

  /** Whether the binning as it would be changes the selection: one of its contigs elsewhere, or one of its genomes' contigs. */
  private concerns(before: CurationStateResult, after: CurationStateResult): boolean {
    const selection = this.ctx.model.selection
    const idOf = (answer: CurationStateResult, g: number): string | null => (g < 0 ? null : (answer.genomes[g]?.id ?? null))
    if (selection.contigs.length > 0) return selection.contigs.some((c) => idOf(before, before.genomeOf[c] ?? -1) !== idOf(after, after.genomeOf[c] ?? -1))
    const chosen = new Set(selection.genomes)
    return priceOf(before, after).some((row) => chosen.has(row.id) || row.from.some((from) => chosen.has(from.id)))
  }

  /** The selection's acts, in a grid: their words and their keys in columns. */
  private acts(...buttons: Array<HTMLButtonElement | null>): HTMLElement {
    const row = acts(...buttons)
    row.classList.add('curate-selection-acts')
    return row
  }

  /** An act, named for the keyboard to find it again when the card is drawn anew. */
  private act(label: string, iconName: Parameters<typeof act>[1], title: string, run: () => void, keys?: string): HTMLButtonElement {
    const button = act(label, iconName, title, run, keys)
    button.dataset.focus = `act:${label}`
    return button
  }

  /** An act that makes a step: it answers nothing while the last step is counted. */
  private stepAct(label: string, iconName: Parameters<typeof act>[1], title: string, run: () => unknown, keys?: string): HTMLButtonElement {
    return this.act(label, iconName, title, this.stepping(run), keys)
  }

  /**
   * A press that makes a step. While the last step is counted it answers
   * nothing, as review does — the card still shows the binning before it, and
   * a second press would make the step twice — and the card dims at once.
   */
  private stepping(run: () => unknown): () => void {
    return () => {
      // Nor after a count that failed: the binning shown is the one before the step.
      if (!this.ctx.model.answerable) {
        this.element.classList.add('is-waiting')
        return
      }
      // Pressed: a price still waiting for the pointer to rest is not wanted.
      this.cancelPriceTimer()
      run()
    }
  }

  /** An act that opens the chooser, under itself. */
  private chooseAct(kind: 'move' | 'merge' | 'link', label: string, iconName: 'move' | 'merge' | 'link', title: string): HTMLButtonElement {
    // Gated as a step is: a chooser opened while a step is counted would list the binning before it.
    const button: HTMLButtonElement = this.act(label, iconName, title, this.stepping(() => this.hooks.choose(kind, button)), kind === 'link' ? SELECTION_KEYS.link : SELECTION_KEYS.merge)
    button.setAttribute('aria-haspopup', 'dialog')
    button.dataset.choose = kind
    this.chooseActs.set(kind, button)
    return button
  }

  /**
   * An act whose step is priced while the pointer or the keyboard rests on it:
   * in the card's acts, or in a row of a list (`from`), which says where its
   * price is drawn.
   */
  private priced(button: HTMLButtonElement, step: () => CurationStep | null, from: PriceSlot = 'acts'): HTMLButtonElement {
    const start = (): void => {
      if (button.disabled) return
      this.cancelPriceTimer()
      this.priceTimer = setTimeout(() => {
        this.priceTimer = null
        this.startPricing(step(), from)
      }, PRICE_DELAY)
    }
    const stop = (): void => {
      this.cancelPriceTimer()
      this.endPricing()
    }
    button.addEventListener('pointerenter', start)
    button.addEventListener('pointerleave', stop)
    button.addEventListener('focus', start)
    button.addEventListener('blur', stop)
    return button
  }

  private cancelPriceTimer(): void {
    if (this.priceTimer !== null) clearTimeout(this.priceTimer)
    this.priceTimer = null
  }

  private startPricing(step: CurationStep | null, from: PriceSlot): void {
    const model = this.ctx.model
    // A step counted meanwhile: the act's step is of the binning before it.
    if (step === null || this.disposed || model.stale) return
    const key = previewKey(step) as string
    if (this.pricing === null) this.pricing = { key, from }
    else Object.assign(this.pricing, { key, from })
    model.preview(step, false)
    // Priced already (asked again): drawn where this act wants it.
    this.schedule('preview')
  }

  /**
   * Let go of the step an act priced, where the preview is still the act's:
   * the stage prices review's question again — never a copy of what was held
   * before put back, which a chooser opened meanwhile would take for its own.
   */
  private endPricing(): void {
    this.cancelPriceTimer()
    const held = this.pricing
    this.pricing = null
    if (held === null) return
    const model = this.ctx.model
    if (previewKey(model.previewSteps) === held.key) model.preview(null)
  }

  /** A row's hover given back: the genome it lit and the words it said. */
  private letGoOfHover(): void {
    if (!this.saying) return
    this.saying = false
    this.ctx.model.hover(null)
    this.ctx.say(null)
  }

  /** A list of rows, each lit with its genome, framed on a press, its act priced on a hover. */
  private list(rows: readonly RowSpec[]): HTMLElement {
    const list = el('ul', { class: 'curate-selection-list' })
    for (const spec of rows) list.appendChild(this.row(spec))
    return list
  }

  /** The first rows of a list, and `show all` for the rest. */
  private capped(key: string, rows: readonly RowSpec[]): HTMLElement[] {
    if (rows.length <= LIST_ROWS || this.expanded.has(key)) return [this.list(rows)]
    const more = el('button', {
      class: 'btn-link curate-selection-more',
      text: `show all ${fmt.int(rows.length)}`,
      attrs: { type: 'button' },
      on: {
        click: () => {
          this.expanded.add(key)
          this.schedule('all')
        },
      },
    })
    more.dataset.focus = `more:${key}`
    return [this.list(rows.slice(0, LIST_ROWS)), more]
  }

  private row(spec: RowSpec): HTMLElement {
    const node = el('li', { class: 'curate-selection-row', title: spec.title ?? spec.words })
    if (spec.genome !== undefined) node.dataset.genome = spec.genome
    if (spec.suggestion !== undefined) node.dataset.suggestion = spec.suggestion
    this.lit.push({ node, genome: spec.genome, contigs: spec.contigs === undefined || spec.contigs.length === 0 ? null : new Set(spec.contigs), suggestion: spec.suggestion })
    // Its swatch, name and chips held together; the confidence goes under them where the side is narrow.
    const lead = el('span', { class: 'curate-selection-row-lead' })
    for (const part of spec.lead) if (part !== null) lead.appendChild(part)
    const main = el('span', { class: 'curate-selection-row-main' }, lead)
    if (spec.confidence !== undefined && spec.confidence !== null) {
      main.appendChild(el('span', { class: 'curate-selection-row-confidence', text: spec.confidence, ...(spec.confidenceTitle === undefined ? {} : { title: spec.confidenceTitle }) }))
    }
    node.append(main, el('span', { class: 'curate-selection-row-detail' }, ...(spec.detailLead ?? []), spec.detail))
    const a = spec.act
    if (a !== undefined && a !== null) {
      const press = this.stepping(a.run)
      const button = el('button', {
        class: 'btn curate-selection-row-act',
        text: a.label,
        title: a.title,
        attrs: { type: 'button' },
        on: {
          click: (event: MouseEvent) => {
            event.stopPropagation()
            press()
          },
        },
      })
      button.dataset.focus = `row:${spec.suggestion ?? spec.genome ?? spec.contigs?.join(',') ?? ''}:${a.label}`
      node.appendChild(a.step === undefined ? button : this.priced(button, a.step, 'rows'))
    }
    node.addEventListener('pointerenter', () => {
      if (this.ctx.dragging !== null) return
      const contig = spec.contigs !== undefined && spec.contigs.length === 1 ? spec.contigs[0] : -1
      const genome = spec.genome ?? (contig >= 0 ? this.genomeOfContig(contig) : null)
      this.ctx.model.hover(genome, contig)
      this.ctx.say(spec.words)
      this.saying = true
    })
    node.addEventListener('pointerleave', () => {
      this.saying = false
      this.ctx.model.hover(null)
      this.ctx.say(null)
    })
    node.addEventListener('click', () => {
      if (spec.contigs !== undefined && spec.contigs.length > 0) this.ctx.frame({ contigs: spec.contigs, ...(spec.genome === undefined ? {} : { genomes: [spec.genome] }) })
      else if (spec.genome !== undefined) this.ctx.frame({ genomes: [spec.genome] })
    })
    return node
  }

  private genomeOfContig(c: number): string | null {
    const answer = this.ctx.model.answer
    const g = answer?.genomeOf[c] ?? -1
    return answer === null || g < 0 ? null : answer.genomes[g].id
  }

  /** The genomes `g` meets, the densest first. */
  private metBy(answer: CurationStateResult, g: number): Array<{ other: number; affinity: number; contacts: number }> {
    const out: Array<{ other: number; affinity: number; contacts: number }> = []
    const { pairs } = answer
    for (let k = 0; k < pairs.a.length; k++) {
      if (pairs.a[k] === g) out.push({ other: pairs.b[k], affinity: pairs.affinity[k], contacts: pairs.contacts[k] })
      else if (pairs.b[k] === g) out.push({ other: pairs.a[k], affinity: pairs.affinity[k], contacts: pairs.contacts[k] })
    }
    return out.sort((x, y) => y.affinity - x.affinity || x.other - y.other)
  }

  /** Merge two genomes: as the suggestion on offer, or the shorter into the longer; the one kept stays selected. */
  private merge(s: Suggestion | undefined, keep: string, fold: string): void {
    const model = this.ctx.model
    if (s !== undefined && s.step.op === 'merge') {
      const into = s.step.into
      // The genome kept selected only where the merge was made.
      if (model.accept(s)) model.selectGenomes([into])
      return
    }
    model.drop({ kind: 'genomes', ids: [fold] }, { kind: 'genome', id: keep })
  }

  /** Link the selected elements to the selected MAG, in one gesture. */
  private linkAll(answer: CurationStateResult, elements: readonly number[], mags: readonly number[]): void {
    if (elements.length === 0 || mags.length !== 1) return
    this.ctx.model.drop({ kind: 'genomes', ids: elements.map((g) => answer.genomes[g].id) }, { kind: 'genome', id: answer.genomes[mags[0]].id })
  }
}

/** Whether an element shows its focus — put there by the keys — where the browser can say. */
function focusVisible(node: Element): boolean {
  try {
    return node.matches(':focus-visible')
  } catch {
    return false
  }
}

/** The merges on offer, by their two genomes' ids. */
function offeredMerges(answer: CurationStateResult, offered: readonly Suggestion[]): Map<string, Suggestion> {
  const merges = new Map<string, Suggestion>()
  for (const s of offered) {
    if (s.kind !== 'merge' || s.genomes.length < 2) continue
    const a = answer.genomes[s.genomes[0]]
    const b = answer.genomes[s.genomes[1]]
    if (a !== undefined && b !== undefined) merges.set(pairKey(a.id, b.id), s)
  }
  return merges
}

/** Whether any of the rows leans on the lower bound. */
function bounded(rows: readonly RowSpec[]): boolean {
  return rows.some((row) => row.bounded === true)
}

function nonNull<T>(items: ReadonlyArray<T | null>): T[] {
  return items.filter((item): item is T => item !== null)
}

/** `1 contig`, `2,286 contigs`. */
function countWords(n: number, one: string, many: string): string {
  return `${fmt.int(n)} ${n === 1 ? one : many}`
}

/**
 * An affinity's number as the card prints it: the stage's one rule
 * (`method.ts`'s `affinityText`) — never an exponent, whose hyphen a line may
 * break at, and under a ten-thousandth `< 0.0001`, its space unbreakable.
 */
export function affinityNumber(value: number): string {
  return affinityText(value)
}

/** How many times the background: `1.3×`, `14×`, `1,200×`. */
function timesText(multiple: number): string {
  if (multiple >= 10) return `${fmt.int(Math.round(multiple))}×`
  return `${Number(multiple.toPrecision(2))}×`
}

/**
 * An affinity as the card prints it (§33.3), put against the map's background
 * `rho` — the rate of spurious ligation, the contact map's key's foot: the
 * number and, where the contacts it rests on are known, how far the cautious
 * lower bound they allow stands above the background (`0.39 (at least 14×
 * background)`); where they are not — a group of recruits carries its least
 * affinity and all their contacts —, the number's own multiple (`0.95 (40×
 * background)`); `(within the background)`
 * where only the bound falls in it; and at or under the background `below the
 * background` alone, whose digits would be noise printed to a false precision.
 * `0` where there is no contact; the number alone where no background is known.
 *
 * `bounded` is whether the words lean on the lower bound, for the card to say
 * once what `at least` means.
 */
export function affinityAgainst(a: number, contacts: number | null, rho: number | null): { words: string; bounded: boolean } {
  if (!Number.isFinite(a)) return { words: '—', bounded: false }
  if (a <= 0) return { words: '0', bounded: false }
  if (rho === null || !(rho > 0)) return { words: affinityNumber(a), bounded: false }
  if (a <= rho) return { words: 'below the background', bounded: false }
  if (contacts === null) return { words: `${affinityNumber(a)} (${timesText(a / rho)} background)`, bounded: false }
  const lower = lowerAffinity(a, contacts)
  if (lower <= rho) return { words: `${affinityNumber(a)} (within the background)`, bounded: true }
  return { words: `${affinityNumber(a)} (at least ${timesText(lower / rho)} background)`, bounded: true }
}

/** Whether a pair's contacts stand out of the background: the cautious lower bound they allow above it. */
function standsOut(a: number, contacts: number, rho: number | null): boolean {
  if (rho === null || !(rho > 0)) return a > 0
  return lowerAffinity(a, contacts) > rho
}

/** A confidence and what it is sure of: `99% one organism`, `98% its host`, `79% sure` under a heading that says of what. */
function sureOf(confidence: number, of: string): string {
  return `${confidenceText(confidence)} ${of}`
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`
}

function capitalise(text: string): string {
  return text === '' ? text : `${text[0].toUpperCase()}${text.slice(1)}`
}
