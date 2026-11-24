/**
 * The inspector's selection card (SPECS §33.3): what is selected, and what it
 * can do, by what it is —
 *
 * - **nothing**: how to select, and what the curation changed so far;
 * - **one MAG**: its length, contigs and change since the file, its quality —
 *   and, while a step is priced, what the step would leave of it; the genomes
 *   it meets most densely, each with `merge`; the contigs the suggestions would
 *   bring into it (`take`, and `take N at 50% or more`) and send out of it
 *   (`move`);
 * - **several genomes**: their counts and length, the step's price, their
 *   affinities with one another;
 * - **contigs**: how long, where they are, the genomes they meet most;
 * - **one element**: its hosts held and offered, and the elements that meet
 *   it, each with its own best host;
 * - **an element and a MAG**: the pair's numbers, `link` or `unlink`.
 *
 * Its acts are the stage's keys printed (F2, M, L, B, E, ⌫, ⏎); hovering one
 * prices its step (`model.preview(step, false)`), so its outcome is read before
 * it is made. Renaming is the list's, the close-up the contact map's and the
 * chooser the stage's: the card asks for them through its hooks.
 */

import { el } from '../../../ui/dom'
import { fmt } from '../../../units'
import type { CurationStep } from '../../../genome/curation'
import type { CurationStateResult } from '../../../worker/curateProtocol'
import { changeChip, changeWords, curationChanges, type CurationChanges } from '../../changes'
import { LIKELY, lowerAffinity } from '../../method'
import type { CurateChange, CurateSelection, CurateTally } from '../../model'
import { priceOf } from '../../price'
import type { Quality } from '../../quality'
import type { Suggestion } from '../../suggest'
import type { CurateContext } from '../context'
import { grade } from '../grade'
import { contigHomes } from '../Chooser'
import { act, acts, affinityText, card, confidenceText, contactsText, nameSpan, priceList, qualityShift, refuse, swatch, type Shift } from './card'

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
  newMag: 'b',
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
  /** The suggestion it shows, by key: lit while it is the review's. */
  suggestion?: string
  lead: Array<Node | null>
  detail: string
  /** The row in a line, in the names the stage prints: the readout's words while the pointer is on it. */
  words: string
  /** The same with full names, for its title. */
  title?: string
  confidence?: string | null
  act?: { label: string; title: string; run: () => void; step?: () => CurationStep | null } | null
}

export class SelectionCard {
  readonly element: HTMLElement
  private readonly head: HTMLElement
  private readonly body: HTMLElement
  private changes: { answer: CurationStateResult; changes: CurationChanges } | null = null
  private numbers: { answer: CurationStateResult; pooled: number; pooledLength: number; tally: CurateTally | null } | null = null
  /** Where the quality table and the price are drawn again when a step is priced. */
  private qualitySlot: { node: HTMLElement; genome: Genome } | null = null
  private priceSlot: HTMLElement | null = null
  /** The acts the chooser opens from, for the stage to anchor it. */
  private readonly chooseActs = new Map<'move' | 'merge' | 'link', HTMLButtonElement>()
  /** The lists opened past their first rows, by genome or selection and list. */
  private readonly expanded = new Set<string>()
  private dirty = { all: true, preview: false, hover: false }
  private frame = 0
  private priceTimer: ReturnType<typeof setTimeout> | null = null
  /** The step an act's hover prices, and the preview held before it, given back when the pointer leaves. */
  private pricing: { key: string; before: CurationStep | null; drawn: boolean } | null = null
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
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.schedule('all')
  }

  /** What changed: repaints in the next frame, once however many changes came. */
  update(change: CurateChange): void {
    switch (change) {
      case 'state':
      case 'selection':
        this.schedule('all')
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

  private paintAll(): void {
    // The acts are drawn again: a step one of them priced is let go.
    this.endPricing()
    this.qualitySlot = null
    this.priceSlot = null
    this.chooseActs.clear()
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
  }

  /** The selection's lit rows: the genome or contig under the pointer anywhere, the suggestion in review. */
  private paintLit(): void {
    const { genome, contig } = this.ctx.model.hovered
    const current = this.ctx.model.current?.key ?? null
    for (const row of this.body.querySelectorAll<HTMLElement>('.curate-selection-row')) {
      const contigs = row.dataset.contigs?.split(',') ?? []
      row.classList.toggle('is-lit', (genome !== null && row.dataset.genome === genome) || (contig >= 0 && contigs.includes(String(contig))))
      row.classList.toggle('is-current', current !== null && row.dataset.suggestion === current)
    }
  }

  /** What a priced step would leave: the quality table's after column, the price. */
  private paintPreview(): void {
    const slot = this.qualitySlot
    if (slot !== null && slot.node.isConnected) slot.node.replaceChildren(...this.qualityParts(slot.genome))
    const price = this.priceSlot
    if (price !== null && price.isConnected) {
      const list = this.priceNow()
      price.replaceChildren(...(list === null ? [] : [list]))
      price.classList.toggle('hidden', list === null)
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
      const grades = { high: 0, medium: 0, low: 0, contaminated: 0 }
      let graded = false
      for (const genome of mags) {
        const q = genome.quality
        if (q === null) continue
        graded = true
        const g = grade(q.weightedCompleteness, q.weightedRedundancy)
        if (g !== null) grades[g]++
      }
      const tally = el('div', { class: 'curate-selection-tally' })
      tally.appendChild(
        el('div', {
          text: `${countWords(mags.length, 'MAG', 'MAGs')} · ${countWords(elements, 'element', 'elements')} · ${countWords(pooled, 'unbinned contig', 'unbinned contigs')}${pooled > 0 ? ` (${fmt.bp(pooledLength)})` : ''}`,
        }),
      )
      if (graded) {
        const words = (['high', 'medium', 'low', 'contaminated'] as const).filter((g) => grades[g] > 0).map((g) => `${g} ${fmt.int(grades[g])}`)
        tally.appendChild(
          el('div', {
            class: 'curate-selection-grades',
            text: words.length === 0 ? 'no MAG reaches the low grade' : `graded ${words.join(' · ')}`,
            title: 'The MAGs by metaTOR’s grades: high at 90% complete or more and 1.05 redundant or less, medium at 70%, low at 50%, contaminated above 1.10',
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
        act('rename', 'pencil', `Rename ${this.short(genome.id)}, in the list`, () => this.hooks.rename(genome.id), SELECTION_KEYS.rename),
        merge,
        act('close-up', 'zoom-in', 'Its contigs, and the ones that may belong in it, on the contact map', () => this.hooks.closeUp(), SELECTION_KEYS.closeUp),
        this.priced(act('make it an element', 'arrow-left-right', 'Declare it a mobile element: a plasmid or a phage, never graded; its links go', () => model.retypeSelected('element')), () => ({ op: 'retype', genome: genome.id, kind: 'element' })),
        this.priced(act('dissolve', 'trash-2', 'Send its contigs to the pool: the genome is gone', () => model.dissolveSelected(), SELECTION_KEYS.remove), () => ({ op: 'dissolve', genome: genome.id })),
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

  /** Completeness and redundancy, weighted and not, now — and after, while a step is priced. */
  private qualityParts(genome: Genome): HTMLElement[] {
    const q = genome.quality
    if (q === null) return []
    const after = this.afterOf(genome.id)
    const file = this.ctx.model.fileAnswer?.genomes.find((g) => g.id === genome.id)
    const wasQ = genome.asInFile ? null : (file?.quality ?? null)
    const grid = el('div', { class: `curate-selection-quality${after === null ? '' : ' has-after'}`, attrs: { role: 'table', 'aria-label': 'Quality' } })
    const cell = (text: string, cls: string, title?: string): HTMLElement => el('span', { class: cls, text, attrs: { role: 'cell' }, ...(title === undefined ? {} : { title }) })
    const heads = [cell('', 'is-label'), cell('weighted', 'is-head'), cell('plain', 'is-head', 'Every marker counted alike')]
    if (after !== null) heads.push(cell(after.head, 'is-head is-after', after.title))
    grid.append(el('div', { class: 'curate-selection-quality-row', attrs: { role: 'row' } }, ...heads))
    const row = (label: string, weighted: string, plain: string, warn: boolean, was: string | null, afterText: string | null, shift: Shift): void => {
      const cells = [
        cell(label, 'is-label'),
        cell(weighted, `is-value${warn ? ' is-warn' : ''}`, was === null ? undefined : `${was} in the file`),
        cell(plain, 'is-value is-plain'),
      ]
      if (after !== null) cells.push(cell(afterText ?? '—', `is-value is-after${shift === null ? '' : ` is-${shift}`}`, after.title))
      grid.append(el('div', { class: 'curate-selection-quality-row', attrs: { role: 'row' } }, ...cells))
    }
    const pct = (x: number): string => fmt.pct(x, 1)
    const ratio = (x: number): string => fmt.fixed(x, 2)
    const aq = after?.quality ?? null
    // The number that moves its grade, and only that one, wears the colour.
    const shift = aq === null ? { completeness: null, redundancy: null } : qualityShift(q, aq)
    row('completeness', pct(q.weightedCompleteness), pct(q.completeness), false, wasQ === null ? null : pct(wasQ.weightedCompleteness), aq === null ? null : pct(aq.weightedCompleteness), shift.completeness)
    row('redundancy', ratio(q.weightedRedundancy), ratio(q.redundancy), q.weightedRedundancy > 1.1, wasQ === null ? null : ratio(wasQ.weightedRedundancy), aq === null ? null : ratio(aq.weightedRedundancy), shift.redundancy)
    const g = grade(q.weightedCompleteness, q.weightedRedundancy)
    const gradeText = g === null ? 'under 50% complete' : g === 'contaminated' ? 'contaminated' : `${g} quality`
    // What a redundancy above 1 is made of, named in the title.
    const duplicated = q.duplicated ?? []
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

  /** The genomes of its kind it meets most densely, each with `merge`. */
  private meetsMost(answer: CurationStateResult, g: number, offered: readonly Suggestion[]): HTMLElement[] {
    const genome = answer.genomes[g]
    const met = this.metBy(answer, g).filter((m) => answer.genomes[m.other].kind === genome.kind)
    if (met.length === 0) return [this.sub(genome.kind === 'mag' ? 'meets most' : 'elements that meet it'), this.note(genome.kind === 'mag' ? 'It meets no other MAG.' : 'No other element meets it.')]
    const merges = new Map<string, Suggestion>()
    for (const s of offered) if (s.kind === 'merge' && s.genomes.length === 2) merges.set(pairKey(answer.genomes[s.genomes[0]].id, answer.genomes[s.genomes[1]].id), s)
    const best = genome.kind === 'element' ? this.bestHosts(answer) : null
    const rows = met.slice(0, 5).map(({ other, affinity, contacts }): RowSpec => {
      const them = answer.genomes[other]
      const s = merges.get(pairKey(genome.id, them.id))
      // The longer keeps its name, as merge does unasked; a merge on offer, as it is offered.
      const [keep, fold] = them.length > genome.length ? [them, genome] : [genome, them]
      const step = (): CurationStep => s?.step ?? { op: 'merge', into: keep.id, genomes: [fold.id] }
      let detail = `affinity ${affinityText(affinity)} (at least ${affinityText(lowerAffinity(affinity, contacts))}) · ${contactsText(contacts)}`
      let chip: HTMLElement | null = null
      if (best !== null) {
        const theirs = best.get(other)
        if (theirs !== undefined) detail += ` · best host ${this.short(answer.genomes[theirs].id)}`
        if (theirs !== undefined && theirs === best.get(g)) chip = el('span', { class: 'edit-chip', text: 'same best host', title: 'Its strongest MAG is this element’s strongest too: one molecule’s pieces, likely' })
      }
      const offer = s === undefined ? '' : ` · merge ${confidenceText(s.confidence)}`
      return {
        genome: them.id,
        suggestion: s?.key,
        lead: [swatch(this.ctx.colourOf(them.id).css, them.kind), this.nameOf(them), chip],
        detail,
        words: `${this.short(genome.id)} × ${this.short(them.id)} · ${detail}${offer}`,
        title: `${genome.name} × ${them.name} · ${detail}${offer}`,
        confidence: s === undefined ? null : `merge ${confidenceText(s.confidence)}`,
        act: {
          label: 'merge',
          title: `Merge ${fold.name} into ${keep.name}, which keeps its name`,
          run: () => this.merge(s, keep.id, fold.id),
          step,
        },
      }
    })
    return [this.sub(genome.kind === 'mag' ? 'meets most' : 'elements that meet it'), this.list(rows)]
  }

  /** The offered recruits and moves into a MAG, each with `take`, and all the likely ones in one press. */
  private belongHere(answer: CurationStateResult, g: number, offered: readonly Suggestion[]): HTMLElement[] {
    const into = offered.filter((s) => (s.kind === 'recruit' || s.kind === 'move') && s.genomes[0] === g)
    if (into.length === 0) return []
    const genome = answer.genomes[g]
    const rows = into.map((s): RowSpec => this.contigSuggestionRow(answer, s, 'take', 'in'))
    const parts: HTMLElement[] = [this.sub(`belong here · ${fmt.int(into.length)}`), ...this.capped(`${genome.id}:in`, rows)]
    const likely = into.filter((s) => s.confidence >= LIKELY)
    if (likely.length >= 2) {
      const contigs = likely.reduce((sum, s) => sum + s.contigs.length, 0)
      const length = likely.reduce((sum, s) => sum + s.contigs.reduce((l, c) => l + (this.ctx.data.file.lengths[c] ?? 0), 0), 0)
      parts.push(
        acts(
          act(
            `take ${fmt.int(likely.length)} at 50% or more`,
            'check',
            `Take the ${fmt.int(likely.length)} suggestions into ${genome.name} at 50% or more: ${countWords(contigs, 'contig', 'contigs')}, ${fmt.bp(length)}`,
            () => this.takeAll(likely),
          ),
        ),
      )
    }
    return parts
  }

  /** The offered moves out of a MAG, each with `move`. */
  private belongElsewhere(answer: CurationStateResult, g: number, offered: readonly Suggestion[]): HTMLElement[] {
    const out = offered.filter((s) => s.kind === 'move' && s.genomes[1] === g)
    if (out.length === 0) return []
    const rows = out.map((s): RowSpec => this.contigSuggestionRow(answer, s, 'move', 'out'))
    return [this.sub(`may belong elsewhere · ${fmt.int(out.length)}`), ...this.capped(`${answer.genomes[g].id}:out`, rows)]
  }

  /** A recruit or a move as a row: the contig, where from or where to, its numbers, its act. */
  private contigSuggestionRow(answer: CurationStateResult, s: Suggestion, label: string, side: 'in' | 'out'): RowSpec {
    const names = this.ctx.data.file.names
    const target = answer.genomes[s.genomes[0]]
    const one = s.contigs.length === 1
    const c = s.contigs[0]
    const own = answer.genomeOf[c]
    const lead: Array<Node | null> = []
    if (side === 'out') lead.push(el('span', { class: 'curate-selection-row-name', text: names[c] ?? `#${c}`, title: names[c] }), el('span', { class: 'curate-selection-arrow', text: '→' }), swatch(this.ctx.colourOf(target.id).css, target.kind), this.nameOf(target))
    else lead.push(el('span', { class: 'curate-selection-row-name', text: one ? (names[c] ?? `#${c}`) : `${fmt.int(s.contigs.length)} contigs`, title: one ? names[c] : s.contigs.map((k) => names[k]).join(', ') }))
    const lower = affinityText(lowerAffinity(s.affinity, s.contacts))
    let detail: string
    if (side === 'out') detail = `its own ${affinityText(answer.contigs.ownAffinity[c])} · there ${affinityText(s.affinity)} (at least ${lower}) · ${contactsText(s.contacts)}`
    else {
      const from = one ? (own < 0 ? 'from the pool' : `from ${this.short(answer.genomes[own].id)}`) : fmt.bp(s.contigs.reduce((sum, k) => sum + (this.ctx.data.file.lengths[k] ?? 0), 0))
      detail = `${from} · affinity ${affinityText(s.affinity)}${one ? ` (at least ${lower})` : ''} · ${contactsText(s.contacts)}`
    }
    return {
      genome: side === 'out' ? target.id : undefined,
      contigs: s.contigs,
      suggestion: s.key,
      lead,
      detail,
      words: `${one ? (names[c] ?? `#${c}`) : `${fmt.int(s.contigs.length)} contigs`} ${side === 'out' ? '→' : 'into'} ${this.short(target.id)} · ${detail} · ${confidenceText(s.confidence)}`,
      title: `${s.words} · ${confidenceText(s.confidence)} · ${s.evidence.join(' · ')}`,
      confidence: confidenceText(s.confidence),
      act: { label, title: `${capitalise(s.words)}: ${confidenceText(s.confidence)}`, run: () => this.ctx.model.accept(s), step: () => s.step },
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
        act('rename', 'pencil', `Rename ${this.short(genome.id)}, in the list`, () => this.hooks.rename(genome.id), SELECTION_KEYS.rename),
        this.priced(act('make it a MAG', 'arrow-left-right', 'Declare it a MAG, graded by its markers; its links go', () => model.retypeSelected('mag')), () => ({ op: 'retype', genome: genome.id, kind: 'mag' })),
        this.priced(act('dissolve', 'trash-2', 'Send its contigs to the pool: the element is gone', () => model.dissolveSelected(), SELECTION_KEYS.remove), () => ({ op: 'dissolve', genome: genome.id })),
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
      rows.push({
        genome: mag.id,
        suggestion: s?.key,
        lead: [swatch(this.ctx.colourOf(mag.id).css, mag.kind), this.nameOf(mag), el('span', { class: 'edit-chip', text: 'linked' })],
        detail: `${link.fromFile ? 'from the file' : 'added'}${numbers}`,
        words: `${this.short(element.id)} ↔ ${this.short(mag.id)} · linked, ${link.fromFile ? 'from the file' : 'added'}${numbers}`,
        title: `${element.name} ↔ ${mag.name} · linked, ${link.fromFile ? 'from the file' : 'added'}${numbers}`,
        confidence: s === undefined ? null : `unlink ${confidenceText(s.confidence)}`,
        act: {
          label: 'unlink',
          title: s === undefined ? `Unlink ${element.name} from ${mag.name}` : `${capitalise(s.words)}: ${confidenceText(s.confidence)}`,
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
      rows.push({
        genome: mag.id,
        suggestion: s.key,
        lead: [swatch(this.ctx.colourOf(mag.id).css, mag.kind), this.nameOf(mag)],
        detail: `offered · ${numbers}`,
        words: `${this.short(element.id)} ↔ ${this.short(mag.id)} · link offered at ${confidenceText(s.confidence)} · ${numbers}`,
        title: `${s.words} · ${confidenceText(s.confidence)} · ${numbers}`,
        confidence: `link ${confidenceText(s.confidence)}`,
        act: { label: 'link', title: `${capitalise(s.words)}: ${confidenceText(s.confidence)}`, run: () => this.ctx.model.accept(s) },
      })
    }
    if (rows.length === 0) return [this.sub('hosts'), this.note(answer.counted ? 'Linked to no MAG, and no link is offered.' : 'Linked to no MAG.')]
    return [this.sub('hosts'), this.list(rows)]
  }

  /** `affinity 0.53 (at least 0.47) · 99% of its MAG contacts · 120 contacts`. */
  private hostNumbers(pair: CurationStateResult['hosts'][number]): string {
    return `affinity ${affinityText(pair.affinity)} (at least ${affinityText(lowerAffinity(pair.affinity, pair.contacts))}) · ${fmt.pct(pair.share, 0)} of its MAG contacts · ${contactsText(pair.contacts)}`
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
        el('div', { class: 'curate-selection-numbers', text: `${this.hostNumbers(pair)} · host ${confidenceText(pair.confidence)}`, title: 'Its affinity with the MAG, the lower bound its contacts allow, the share of its contacts with MAGs that go to this one, and how sure the method is that the MAG hosts it' }),
      )
    }
    if (s !== undefined) {
      parts.push(
        el(
          'div',
          { class: 'curate-selection-offer' },
          el('span', { text: `${s.kind === 'link' ? 'link' : 'unlink'} offered at ${confidenceText(s.confidence)}`, title: s.evidence.join(' · ') }),
        ),
      )
    }
    const linkAct = act('link', 'link', `Link ${element.name} to ${mag.name}: the MAG hosts it`, () => (s?.kind === 'link' ? model.accept(s) : model.link(element.id, mag.id, true)), SELECTION_KEYS.link)
    const unlinkAct = act('unlink', 'unlink', `Unlink ${element.name} from ${mag.name}`, () => (s?.kind === 'unlink' ? model.accept(s) : model.link(element.id, mag.id, false)), SELECTION_KEYS.remove)
    parts.push(this.acts(link === undefined ? linkAct : unlinkAct, act('close-up', 'zoom-in', 'Their contigs on the contact map', () => this.hooks.closeUp(), SELECTION_KEYS.closeUp)))
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
    parts.push(this.priceBlock())
    // The longest keeps its name, as `merge` makes it.
    const survivor = [...genomes].sort((x, y) => answer.genomes[y].length - answer.genomes[x].length)[0]
    const merge = this.priced(
      act('merge', 'merge', `Merge them into ${answer.genomes[survivor].name}, the longest, which keeps its name`, () => model.mergeSelected(), SELECTION_KEYS.merge),
      () => ({ op: 'merge', into: answer.genomes[survivor].id, genomes: genomes.filter((g) => g !== survivor).map((g) => answer.genomes[g].id) }),
    )
    if (kinds.size > 1) refuse(merge, 'Only genomes of one kind merge: an element and a MAG are linked')
    const link = act('link', 'link', mags.length === 1 ? `Link the ${elements.length === 1 ? 'element' : `${fmt.int(elements.length)} elements`} to ${answer.genomes[mags[0]].name}` : 'Link elements to a MAG', () => this.linkAll(answer, elements, mags), SELECTION_KEYS.link)
    if (elements.length === 0) refuse(link, 'Select an element and the MAG that hosts it to link them')
    else if (mags.length !== 1) refuse(link, mags.length === 0 ? 'Select the MAG that hosts them too' : 'Link elements to one MAG at a time')
    parts.push(
      this.acts(
        merge,
        kinds.size > 1 ? link : null,
        act('close-up', 'zoom-in', 'Their contigs, side by side, on the contact map', () => this.hooks.closeUp(), SELECTION_KEYS.closeUp),
        mags.length > 0 ? act('make them elements', 'arrow-left-right', 'Declare them mobile elements; their links go', () => model.retypeSelected('element')) : null,
        elements.length > 0 ? act('make them MAGs', 'arrow-left-right', 'Declare them MAGs; their links go', () => model.retypeSelected('mag')) : null,
        act('dissolve', 'trash-2', 'Send their contigs to the pool: the genomes are gone', () => model.dissolveSelected(), SELECTION_KEYS.remove),
      ),
    )
    const shown = genomes.slice(0, MATRIX_MOST)
    const rows = shown.map((g, k): RowSpec => {
      const genome = answer.genomes[g]
      const q = genome.quality
      return {
        genome: genome.id,
        lead: [el('span', { class: 'curate-selection-index', text: String(k + 1) }), swatch(this.ctx.colourOf(genome.id).css, genome.kind), this.nameOf(genome)],
        detail: `${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}${q === null ? '' : ` · ${fmt.pct(q.weightedCompleteness, 0)} complete · ${fmt.fixed(q.weightedRedundancy, 2)}`}`,
        words: `${this.short(genome.id)} · ${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}`,
        title: `${genome.name} · ${fmt.bp(genome.length)} · ${countWords(genome.contigs, 'contig', 'contigs')}`,
      }
    })
    parts.push(this.list(rows))
    if (genomes.length > shown.length) parts.push(this.note(`and ${fmt.int(genomes.length - shown.length)} more; the affinities are the first ${fmt.int(shown.length)}’s`))
    if (!answer.counted) parts.push(this.uncounted('Their affinities with one another, once the contacts are read.'))
    else parts.push(this.sub('affinities'), this.matrix(answer, shown))
    this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
  }

  /** Each two genomes' affinity, a cell each, tinted from the background up to twice a genome's own density. */
  private matrix(answer: CurationStateResult, genomes: number[]): HTMLElement {
    const at = new Map<string, { affinity: number; contacts: number }>()
    const { pairs } = answer
    for (let k = 0; k < pairs.a.length; k++) at.set(`${pairs.a[k]}:${pairs.b[k]}`, { affinity: pairs.affinity[k], contacts: pairs.contacts[k] })
    const rho = this.ctx.data.background ?? 0.01
    const low = Math.log10(Math.max(1e-6, rho))
    const high = Math.log10(2)
    const grid = el('div', { class: 'curate-selection-matrix', attrs: { role: 'table', 'aria-label': 'Affinities' } })
    grid.style.setProperty('--n', String(genomes.length))
    grid.appendChild(el('span', { class: 'curate-selection-matrix-corner' }))
    genomes.forEach((_, k) => grid.appendChild(el('span', { class: 'curate-selection-matrix-head', text: String(k + 1) })))
    genomes.forEach((a, i) => {
      grid.appendChild(el('span', { class: 'curate-selection-matrix-head is-row', text: String(i + 1), title: answer.genomes[a].name }))
      genomes.forEach((b, j) => {
        if (i === j) {
          grid.appendChild(el('span', { class: 'curate-selection-cell is-self', text: '·', title: `${answer.genomes[a].name}: 1 is its own density` }))
          return
        }
        const pair = at.get(a < b ? `${a}:${b}` : `${b}:${a}`)
        const affinity = pair?.affinity ?? 0
        const heat = affinity > 0 ? Math.max(0, Math.min(1, (Math.log10(affinity) - low) / (high - low))) : 0
        const title =
          pair === undefined
            ? `${answer.genomes[a].name} × ${answer.genomes[b].name}: no contact`
            : `${answer.genomes[a].name} × ${answer.genomes[b].name} · affinity ${affinityText(affinity)} (at least ${affinityText(lowerAffinity(affinity, pair.contacts))}) · ${contactsText(pair.contacts)}`
        const cell = el('span', { class: 'curate-selection-cell', text: pair === undefined ? '—' : affinityText(affinity), title })
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
    parts.push(this.priceBlock())
    const names = contigs.map((c) => file.names[c]).filter((name): name is string => name !== undefined)
    const binned = contigs.filter((c) => answer.genomeOf[c] >= 0)
    const unbin = this.priced(act('unbin', 'minus', one ? 'Send it to the pool, out of every genome' : 'Send them to the pool, out of every genome', () => model.moveSelected(null), SELECTION_KEYS.remove), () =>
      binned.length === 0 ? null : { op: 'move', contigs: binned.map((c) => file.names[c]), to: null },
    )
    if (binned.length === 0) refuse(unbin, one ? 'It is unbinned already' : 'They are unbinned already')
    parts.push(
      this.acts(
        this.chooseAct('move', 'move to…', 'move', one ? 'Move it to a genome, chosen by what it meets most' : 'Move them to a genome, chosen by what they meet most'),
        this.priced(act('new MAG', 'plus', one ? 'A new MAG of it' : 'A new MAG of them', () => model.createFromSelected('mag'), SELECTION_KEYS.newMag), () => {
          const minted = model.mint('mag')
          return { op: 'create', id: minted.id, name: minted.name, kind: 'mag', contigs: names }
        }),
        this.priced(act('new element', 'circle-dot', one ? 'A new mobile element of it' : 'A new mobile element of them', () => model.createFromSelected('element'), SELECTION_KEYS.newElement), () => {
          const minted = model.mint('element')
          return { op: 'create', id: minted.id, name: minted.name, kind: 'element', contigs: names }
        }),
        unbin,
      ),
    )
    if (!answer.counted) parts.push(this.uncounted(one ? 'The genomes it meets most, once the contacts are read.' : 'The genomes they meet most, once the contacts are read.'))
    else parts.push(...this.contigsMeet(answer, contigs))
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
    const ownWords = answer.genomeOf[c] >= 0 && Number.isFinite(places.ownAffinity[c]) ? ` · its own ${affinityText(places.ownAffinity[c])}` : ''
    const rows = homes.map((home): RowSpec => {
      const genome = answer.genomes[home.genome]
      const { movers } = home
      // A suggestion on offer that moves exactly these contigs there is taken as the suggestion.
      const s = offered.find((o) => (o.kind === 'recruit' || o.kind === 'move') && o.genomes[0] === home.genome && o.contigs.length === movers.length && o.contigs.every((k) => movers.includes(k)))
      const anyOffer = offered.filter((o) => (o.kind === 'recruit' || o.kind === 'move') && o.genomes[0] === home.genome && o.contigs.some((k) => chosen.has(k)))
      const surest = anyOffer.reduce((most, o) => Math.max(most, o.confidence), 0)
      const already = home.contigs.length - movers.length
      let detail: string
      if (one) {
        if ('next' in home) detail = `meets it next · affinity ${affinityText(home.affinity)}${ownWords}`
        else if (movers.length === 0) detail = `its own · affinity ${affinityText(home.affinity)}`
        else detail = `affinity ${affinityText(home.affinity)}${ownWords}`
      } else detail = `${fmt.int(home.contigs.length)} of ${fmt.int(contigs.length)} · affinity ${affinityText(home.affinity)}${already > 0 ? ` · ${fmt.int(already)} in it already` : ''}`
      return {
        genome: genome.id,
        contigs: home.contigs,
        suggestion: s?.key,
        lead: [swatch(this.ctx.colourOf(genome.id).css, genome.kind), this.nameOf(genome)],
        detail,
        words: `${this.nameWords(home.contigs)} · ${this.short(genome.id)} · ${detail}`,
        title: `${this.nameWords(home.contigs)} · ${genome.name} · ${detail}`,
        confidence: anyOffer.length === 0 ? null : confidenceText(surest),
        act:
          movers.length === 0
            ? null
            : {
                label: one || movers.length === contigs.length ? 'move' : `move ${fmt.int(movers.length)}`,
                title: s === undefined ? `Move ${this.nameWords(movers)} to ${genome.name}` : `${capitalise(s.words)}: ${confidenceText(s.confidence)}`,
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

  /** The price of the step priced now, for the genomes it changes; hidden while none is. */
  private priceBlock(): HTMLElement {
    const node = el('div', { class: 'curate-selection-price', attrs: { 'aria-live': 'polite' } })
    const list = this.priceNow()
    if (list === null) node.classList.add('hidden')
    else node.appendChild(list)
    this.priceSlot = node
    return node
  }

  private priceNow(): HTMLElement | null {
    const model = this.ctx.model
    const before = model.answer
    const after = model.previewed
    if (before === null || after === null) return null
    return priceList(before, after, (id, name) => (before.genomes.some((genome) => genome.id === id) ? this.short(id) : name))
  }

  /** The selection's acts, in a grid: their words and their keys in columns. */
  private acts(...buttons: Array<HTMLButtonElement | null>): HTMLElement {
    const row = acts(...buttons)
    row.classList.add('curate-selection-acts')
    return row
  }

  /** An act that opens the chooser, under itself. */
  private chooseAct(kind: 'move' | 'merge' | 'link', label: string, iconName: 'move' | 'merge' | 'link', title: string): HTMLButtonElement {
    const button: HTMLButtonElement = act(label, iconName === 'move' ? 'move' : iconName, title, () => this.hooks.choose(kind, button), kind === 'link' ? SELECTION_KEYS.link : SELECTION_KEYS.merge)
    button.setAttribute('aria-haspopup', 'dialog')
    this.chooseActs.set(kind, button)
    return button
  }

  /** An act whose step is priced while the pointer or the keyboard rests on it. */
  private priced(button: HTMLButtonElement, step: () => CurationStep | null): HTMLButtonElement {
    const start = (): void => {
      if (button.disabled) return
      if (this.priceTimer !== null) clearTimeout(this.priceTimer)
      this.priceTimer = setTimeout(() => {
        this.priceTimer = null
        this.startPricing(step())
      }, PRICE_DELAY)
    }
    const stop = (): void => {
      if (this.priceTimer !== null) clearTimeout(this.priceTimer)
      this.priceTimer = null
      this.endPricing()
    }
    button.addEventListener('pointerenter', start)
    button.addEventListener('pointerleave', stop)
    button.addEventListener('focus', start)
    button.addEventListener('blur', stop)
    return button
  }

  private startPricing(step: CurationStep | null): void {
    if (step === null || this.disposed) return
    const model = this.ctx.model
    const key = JSON.stringify(step)
    if (this.pricing === null) this.pricing = { key, before: model.previewStep, drawn: model.previewing }
    else this.pricing.key = key
    model.preview(step, false)
  }

  /** Let go of the step an act priced: the preview held before it is held again. */
  private endPricing(): void {
    if (this.priceTimer !== null) clearTimeout(this.priceTimer)
    this.priceTimer = null
    const held = this.pricing
    this.pricing = null
    if (held === null) return
    const model = this.ctx.model
    if (JSON.stringify(model.previewStep) === held.key) model.preview(held.before, held.drawn)
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
    return [this.list(rows.slice(0, LIST_ROWS)), more]
  }

  private row(spec: RowSpec): HTMLElement {
    const node = el('li', { class: 'curate-selection-row', title: spec.title ?? spec.words })
    if (spec.genome !== undefined) node.dataset.genome = spec.genome
    if (spec.contigs !== undefined) node.dataset.contigs = spec.contigs.join(',')
    if (spec.suggestion !== undefined) node.dataset.suggestion = spec.suggestion
    const main = el('span', { class: 'curate-selection-row-main' })
    for (const part of spec.lead) if (part !== null) main.appendChild(part)
    if (spec.confidence !== undefined && spec.confidence !== null) main.appendChild(el('span', { class: 'curate-selection-row-confidence', text: spec.confidence }))
    node.append(main, el('span', { class: 'curate-selection-row-detail', text: spec.detail }))
    const a = spec.act
    if (a !== undefined && a !== null) {
      const button = el('button', {
        class: 'btn curate-selection-row-act',
        text: a.label,
        title: a.title,
        attrs: { type: 'button' },
        on: {
          click: (event: MouseEvent) => {
            event.stopPropagation()
            a.run()
          },
        },
      })
      node.appendChild(a.step === undefined ? button : this.priced(button, a.step))
    }
    node.addEventListener('pointerenter', () => {
      if (this.ctx.dragging !== null) return
      const contig = spec.contigs !== undefined && spec.contigs.length === 1 ? spec.contigs[0] : -1
      const genome = spec.genome ?? (contig >= 0 ? this.genomeOfContig(contig) : null)
      this.ctx.model.hover(genome, contig)
      this.ctx.say(spec.words)
    })
    node.addEventListener('pointerleave', () => {
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
      model.accept(s)
      model.selectGenomes([into])
      return
    }
    model.drop({ kind: 'genomes', ids: [fold] }, { kind: 'genome', id: keep })
  }

  /** Take every suggestion of a list, the surest first. */
  private takeAll(list: readonly Suggestion[]): void {
    for (const s of [...list].sort((x, y) => y.confidence - x.confidence)) this.ctx.model.accept(s)
  }

  /** Link the selected elements to the selected MAG, in one gesture. */
  private linkAll(answer: CurationStateResult, elements: readonly number[], mags: readonly number[]): void {
    if (elements.length === 0 || mags.length !== 1) return
    this.ctx.model.drop({ kind: 'genomes', ids: elements.map((g) => answer.genomes[g].id) }, { kind: 'genome', id: answer.genomes[mags[0]].id })
  }
}

/** `1 contig`, `2,286 contigs`. */
function countWords(n: number, one: string, many: string): string {
  return `${fmt.int(n)} ${n === 1 ? one : many}`
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`
}

function capitalise(text: string): string {
  return text === '' ? text : `${text[0].toUpperCase()}${text.slice(1)}`
}
