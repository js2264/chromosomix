/**
 * The chooser of the curation stage (SPECS §33.3): the popover `move to…`,
 * `merge into…` and `link to…` open — every genome the selection could go to,
 * the ones the contacts name first, a filter box, ↑ ↓ Enter Escape, and the
 * step the row under the keyboard would make, priced before it is made.
 *
 * - **move** (contigs): the genomes the contigs meet most — each contig's own
 *   where it meets that at least as densely as any other MAG, else the MAG it
 *   meets most ({@link contigHomes}) — by how many of them name each, then by
 *   their affinity; then where the contigs at home would go next; then *a new
 *   MAG*, *a new element* and *unbinned*; then every other genome.
 * - **merge** (genomes of one kind): the genomes of that kind the selection
 *   meets most densely, by pair affinity — with several selected, each of them
 *   first, as the one that keeps its name.
 * - **link** (elements): the MAGs that would host them, by host affinity; one
 *   MAG selected, the elements it would host.
 *
 * It chooses and returns the target ({@link CurateDropTarget}); the caller makes
 * the step, and {@link chooseStep} makes it as the drop grammar does
 * (`curate/drop.ts`). One chooser is open at a time.
 */

import { el } from '../../ui/dom'
import { TAB_WALKS } from '../../ui/tabWalk'
import { icon, type IconName } from '../../ui/icons'
import { keyBadge } from '../../ui/commands'
import { fmt } from '../../units'
import type { GenomeKind } from '../../genome/curation'
import type { CurationStateResult } from '../../worker/curateProtocol'
import type { DropPlan } from '../drop'
import { lowerAffinity } from '../method'
import type { CurateModel, CurateSelection } from '../model'
import type { Suggestion } from '../suggest'
import type { CurateContext, CurateDragged, CurateDropTarget } from './context'
import { affinityText, confidenceText, contactsText, previewKey, priceList, swatch } from './cards/card'

/** What a chooser chooses: where contigs go, what genomes merge into, what an element is linked to. */
export type ChooserKind = 'move' | 'merge' | 'link'

/** One row of a chooser: a target and what the contacts say of it. */
export interface ChooserRow {
  /** Stable across counts, so the row under the keyboard stays under it. */
  key: string
  target: CurateDropTarget
  /** The genome a genome row names, as an index of the answer's. */
  genome: number
  /** A row that is not a genome: `a new MAG`, `a new element`, `unbinned`. */
  label: string | null
  /** What the contacts say of it, in words: `6 of 9 meet it most · affinity 2.41`. */
  evidence: string
  /** The confidence of a suggestion on offer for this target, where one is. */
  confidence: number | null
  /** Which group it is listed in. */
  group: 'ranked' | 'extra' | 'rest'
}

/** Everything a chooser lists, for the selection as it stands. */
export interface ChooserPlan {
  /** What is chosen for, in words: `move 9 contigs to…`. */
  title: string
  /** What the choice would carry, as a drop would. */
  dragged: CurateDragged | null
  /** One MAG to link an element to, where the selection is one MAG and the rows are elements. */
  linkTo: string | null
  rows: ChooserRow[]
  /** Why there is nothing to choose, or `null`. */
  empty: string | null
  /** The kind it answers, which a selection of the other sort turns: `move` for genomes is `merge`. */
  kind: ChooserKind
}

/** What a plan is built from: the answer as it stands, the selection, the stage's order and the suggestions on offer. */
export interface ChooserInput {
  kind: ChooserKind
  answer: CurationStateResult
  selection: CurateSelection
  /** The genomes' ids in the stage's order: MAGs, then elements. */
  order: readonly string[]
  offered: readonly Suggestion[]
  /** Every contig's name, in the file's order. */
  names: readonly string[]
  /** A genome's name as the stage prints it. */
  shortName?: (id: string) => string
}

/** The most rows listed past the ranked ones before the filter is asked for. */
export const CHOOSER_REST = 300

/**
 * The rows a chooser lists for the selection as it stands: pure, so the ranks
 * are tested without a DOM.
 */
export function chooserPlan(input: ChooserInput): ChooserPlan {
  const { answer, selection } = input
  const short = input.shortName ?? ((id: string) => answer.genomes.find((genome) => genome.id === id)?.name ?? id)
  const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
  const genomes = selection.genomes.map((id) => index.get(id)).filter((g): g is number => g !== undefined)
  const contigs = selection.contigs.filter((c) => c >= 0 && c < answer.genomeOf.length)
  // M is one key for both: contigs move, genomes merge.
  let kind = input.kind
  if (kind === 'move' && contigs.length === 0 && genomes.length > 0) kind = 'merge'
  else if (kind === 'merge' && genomes.length === 0 && contigs.length > 0) kind = 'move'
  const nothing = (title: string, empty: string): ChooserPlan => ({ title, dragged: null, linkTo: null, rows: [], empty, kind })
  const ordered = input.order.map((id) => index.get(id)).filter((g): g is number => g !== undefined)
  // A genome a count made after the order was kept: at the end, as the order would put it.
  for (let g = 0; g < answer.genomes.length; g++) if (!ordered.includes(g)) ordered.push(g)
  const sizeWords = (g: number): string => `${fmt.bp(answer.genomes[g].length)} · ${fmt.int(answer.genomes[g].contigs)} ${answer.genomes[g].contigs === 1 ? 'contig' : 'contigs'}`
  const genomeRow = (g: number, group: ChooserRow['group'], evidence: string, confidence: number | null): ChooserRow => ({
    key: `g:${answer.genomes[g].id}`,
    target: { kind: 'genome', id: answer.genomes[g].id },
    genome: g,
    label: null,
    evidence,
    confidence,
    group,
  })

  if (kind === 'move') {
    if (contigs.length === 0) return nothing('move to…', 'Select contigs to move: press them in the list, or lasso them on the scatter.')
    const one = contigs.length === 1
    const what = one ? (input.names[contigs[0]] ?? 'a contig') : `${fmt.int(contigs.length)} contigs`
    const holders = new Set(contigs.map((c) => answer.genomeOf[c]))
    // The genome every one of them is in already: moving there makes nothing.
    const allIn = holders.size === 1 ? [...holders][0] : -2
    const chosen = new Set(contigs)
    const offered = new Map<number, number>()
    for (const s of input.offered) {
      if ((s.kind !== 'recruit' && s.kind !== 'move') || !s.contigs.some((c) => chosen.has(c))) continue
      const g = s.genomes[0]
      if (g !== undefined) offered.set(g, Math.max(offered.get(g) ?? 0, s.confidence))
    }
    const { most, next } = contigHomes(answer, contigs)
    const rows: ChooserRow[] = []
    const listed = new Set<number>()
    const c = contigs[0]
    const own = answer.contigs.ownAffinity[c]
    const ownWords = one && answer.genomeOf[c] >= 0 && Number.isFinite(own) ? ` · its own ${affinityText(own)}` : ''
    for (const home of most) {
      if (home.genome === allIn) continue
      listed.add(home.genome)
      const already = home.contigs.length - home.movers.length
      const evidence = one
        ? `affinity ${affinityText(home.affinity)}${ownWords}`
        : `${fmt.int(home.contigs.length)} of ${fmt.int(contigs.length)} meet it most · affinity ${affinityText(home.affinity)}${already > 0 ? ` · ${fmt.int(already)} in it already` : ''}`
      rows.push(genomeRow(home.genome, 'ranked', evidence, offered.get(home.genome) ?? null))
    }
    // The contigs at home meet another genome next: where a reader moving them anyway would look.
    for (const home of next) {
      if (home.genome === allIn || listed.has(home.genome)) continue
      listed.add(home.genome)
      const evidence = one
        ? `meets it next · affinity ${affinityText(home.affinity)}${ownWords}`
        : `${fmt.int(home.contigs.length)} of ${fmt.int(contigs.length)} meet it next · affinity ${affinityText(home.affinity)}`
      rows.push(genomeRow(home.genome, 'ranked', evidence, offered.get(home.genome) ?? null))
    }
    const of = one ? `of ${what}` : `of the ${what}`
    rows.push(
      { key: 'section:mags', target: { kind: 'section', section: 'mags' }, genome: -1, label: 'a new MAG', evidence: of, confidence: null, group: 'extra' },
      { key: 'section:elements', target: { kind: 'section', section: 'elements' }, genome: -1, label: 'a new element', evidence: of, confidence: null, group: 'extra' },
    )
    if (contigs.some((c) => answer.genomeOf[c] >= 0)) {
      rows.push({ key: 'pool', target: { kind: 'pool' }, genome: -1, label: 'unbinned', evidence: 'out of every genome', confidence: null, group: 'extra' })
    }
    for (const g of ordered) if (!listed.has(g) && g !== allIn) rows.push(genomeRow(g, 'rest', sizeWords(g), offered.get(g) ?? null))
    return { title: `move ${what} to…`, dragged: { kind: 'contigs', contigs }, linkTo: null, rows, empty: null, kind }
  }

  if (genomes.length === 0) return nothing(kind === 'merge' ? 'merge into…' : 'link to…', kind === 'merge' ? 'Select the genomes to merge.' : 'Select an element to link, or the MAG to host one.')

  if (kind === 'merge') {
    const kinds = new Set(genomes.map((g) => answer.genomes[g].kind))
    if (kinds.size > 1) return nothing('merge into…', 'Merge MAGs or elements, one kind at a time: an element and a MAG are linked.')
    const genomeKind = answer.genomes[genomes[0]].kind
    const what = genomes.length === 1 ? short(answer.genomes[genomes[0]].id) : `${fmt.int(genomes.length)} ${kindWord(genomeKind, true)}`
    const chosen = new Set(genomes)
    const meets = new Map<number, { affinity: number; contacts: number }>()
    const { pairs } = answer
    for (let k = 0; k < pairs.a.length; k++) {
      const a = pairs.a[k]
      const b = pairs.b[k]
      const other = chosen.has(a) && !chosen.has(b) ? b : chosen.has(b) && !chosen.has(a) ? a : -1
      if (other < 0 || answer.genomes[other].kind !== genomeKind) continue
      const held = meets.get(other)
      if (held === undefined || pairs.affinity[k] > held.affinity) meets.set(other, { affinity: pairs.affinity[k], contacts: pairs.contacts[k] })
    }
    const offered = new Map<number, number>()
    for (const s of input.offered) {
      if (s.kind !== 'merge' || s.genomes.length < 2) continue
      const [a, b] = s.genomes
      const other = chosen.has(a) && !chosen.has(b) ? b : chosen.has(b) && !chosen.has(a) ? a : -1
      if (other >= 0) offered.set(other, Math.max(offered.get(other) ?? 0, s.confidence))
    }
    const rows: ChooserRow[] = []
    if (genomes.length > 1) {
      // Which of them keeps its name: the longest first, as merge does unasked.
      for (const g of [...genomes].sort((x, y) => answer.genomes[y].length - answer.genomes[x].length || x - y)) {
        rows.push(genomeRow(g, 'ranked', `${fmt.bp(answer.genomes[g].length)} · the others merge into it`, null))
      }
    }
    const ranked = [...meets].sort((x, y) => y[1].affinity - x[1].affinity || x[0] - y[0])
    for (const [g, { affinity, contacts }] of ranked) {
      rows.push(genomeRow(g, 'ranked', `affinity ${affinityText(affinity)} (at least ${affinityText(lowerAffinity(affinity, contacts))}) · ${contactsText(contacts)}`, offered.get(g) ?? null))
    }
    for (const g of ordered) {
      if (chosen.has(g) || meets.has(g) || answer.genomes[g].kind !== genomeKind) continue
      rows.push(genomeRow(g, 'rest', sizeWords(g), null))
    }
    const empty = rows.length === 0 ? `No other ${kindWord(genomeKind, false)} to merge with.` : null
    return { title: `merge ${what} into…`, dragged: { kind: 'genomes', ids: genomes.map((g) => answer.genomes[g].id) }, linkTo: null, rows, empty, kind }
  }

  // Link.
  const elements = genomes.filter((g) => answer.genomes[g].kind === 'element')
  const mags = genomes.filter((g) => answer.genomes[g].kind === 'mag')
  const linked = new Set(answer.links.map((link) => `${link.element}\t${link.mag}`))
  const isLinked = (e: number, m: number): boolean => linked.has(`${answer.genomes[e].id}\t${answer.genomes[m].id}`)
  if (elements.length > 0) {
    const chosen = new Set(elements)
    const what = elements.length === 1 ? short(answer.genomes[elements[0]].id) : `${fmt.int(elements.length)} elements`
    const hosts = new Map<number, { affinity: number; share: number; contacts: number; meeting: number }>()
    for (const pair of answer.hosts) {
      if (!chosen.has(pair.element)) continue
      const held = hosts.get(pair.mag)
      if (held === undefined) hosts.set(pair.mag, { affinity: pair.affinity, share: pair.share, contacts: pair.contacts, meeting: 1 })
      else {
        held.meeting++
        if (pair.affinity > held.affinity) Object.assign(held, { affinity: pair.affinity, share: pair.share, contacts: pair.contacts })
      }
    }
    const offered = new Map<number, number>()
    for (const s of input.offered) {
      if (s.kind !== 'link' || !chosen.has(s.genomes[0])) continue
      const m = s.genomes[1]
      offered.set(m, Math.max(offered.get(m) ?? 0, s.confidence))
    }
    // A MAG every one of them is linked to already: linking makes nothing.
    const done = (m: number): boolean => elements.every((e) => isLinked(e, m))
    const rows: ChooserRow[] = [...hosts]
      .filter(([m]) => !done(m))
      .sort((x, y) => y[1].affinity - x[1].affinity || x[0] - y[0])
      .map(([m, h]) =>
        genomeRow(
          m,
          'ranked',
          `${elements.length > 1 ? `${fmt.int(h.meeting)} of ${fmt.int(elements.length)} meet it · ` : ''}affinity ${affinityText(h.affinity)} · ${fmt.pct(h.share, 0)} of its MAG contacts · ${contactsText(h.contacts)}`,
          offered.get(m) ?? null,
        ),
      )
    for (const g of ordered) if (answer.genomes[g].kind === 'mag' && !hosts.has(g) && !done(g)) rows.push(genomeRow(g, 'rest', sizeWords(g), null))
    const empty = rows.length === 0 ? 'No MAG to link to.' : null
    return { title: `link ${what} to…`, dragged: { kind: 'genomes', ids: elements.map((g) => answer.genomes[g].id) }, linkTo: null, rows, empty, kind }
  }
  if (mags.length !== 1) return nothing('link to…', 'Link elements to a MAG: select the elements, or the one MAG to host them.')
  const m = mags[0]
  const rows: ChooserRow[] = answer.hosts
    .filter((pair) => pair.mag === m && !isLinked(pair.element, m))
    .sort((x, y) => y.affinity - x.affinity || x.element - y.element)
    .map((pair) => {
      const s = input.offered.find((o) => o.kind === 'link' && o.genomes[0] === pair.element && o.genomes[1] === m)
      return genomeRow(pair.element, 'ranked', `affinity ${affinityText(pair.affinity)} · ${fmt.pct(pair.share, 0)} of its MAG contacts · ${contactsText(pair.contacts)}`, s?.confidence ?? null)
    })
  const listed = new Set(rows.map((row) => row.genome))
  for (const g of ordered) if (answer.genomes[g].kind === 'element' && !listed.has(g) && !isLinked(g, m)) rows.push(genomeRow(g, 'rest', sizeWords(g), null))
  return {
    title: `link ${short(answer.genomes[m].id)} to…`,
    dragged: null,
    linkTo: answer.genomes[m].id,
    rows,
    empty: rows.length === 0 ? 'No element to link to it.' : null,
    kind,
  }
}

/** Where some contigs meet most, one genome at a time. */
export interface ContigHome {
  /** The genome, as an index of the answer's. */
  genome: number
  /** The contigs that meet it most — or next, in {@link contigHomes}' `next`. */
  contigs: number[]
  /** Those of them not in it: what a move there moves. */
  movers: number[]
  /** Their mean affinity with it. */
  affinity: number
}

/**
 * Where contigs meet most: each its own genome where it meets that at least as
 * densely as any other MAG (`ContigPlaces.ownAffinity` against `bestAffinity`),
 * else the MAG it meets most; and, for the contigs at home, the MAG they meet
 * next. Each list the most contigs first, then the densest. A contig the
 * contacts place nowhere — an element's, one meeting no MAG — counts in neither.
 */
export function contigHomes(answer: CurationStateResult, contigs: readonly number[]): { most: ContigHome[]; next: ContigHome[] } {
  const places = answer.contigs
  const most = new Map<number, { contigs: number[]; movers: number[]; sum: number }>()
  const next = new Map<number, { contigs: number[]; movers: number[]; sum: number }>()
  const add = (to: typeof most, g: number, c: number, a: number): void => {
    const held = to.get(g) ?? { contigs: [], movers: [], sum: 0 }
    held.contigs.push(c)
    if (answer.genomeOf[c] !== g) held.movers.push(c)
    held.sum += Number.isFinite(a) ? a : 0
    to.set(g, held)
  }
  for (const c of contigs) {
    const own = answer.genomeOf[c]
    const best = places.best[c]
    const ownA = places.ownAffinity[c]
    const bestA = places.bestAffinity[c]
    if (own >= 0 && Number.isFinite(ownA) && (best < 0 || !(bestA > ownA))) {
      add(most, own, c, ownA)
      if (best >= 0 && best !== own) add(next, best, c, bestA)
    } else if (best >= 0) add(most, best, c, bestA)
  }
  const sorted = (from: typeof most): ContigHome[] =>
    [...from]
      .map(([genome, held]) => ({ genome, contigs: held.contigs, movers: held.movers, affinity: held.sum / held.contigs.length }))
      .sort((x, y) => y.contigs.length - x.contigs.length || y.affinity - x.affinity || x.genome - y.genome)
  return { most: sorted(most), next: sorted(next) }
}

function kindWord(kind: GenomeKind, plural: boolean): string {
  return kind === 'mag' ? (plural ? 'MAGs' : 'MAG') : plural ? 'elements' : 'element'
}

/** The steps a row would make, and their words; `null` before the first count. */
export function rowStep(model: CurateModel, plan: ChooserPlan, target: CurateDropTarget, shortName?: (id: string) => string): DropPlan | null {
  if (plan.linkTo !== null) {
    if (target.kind !== 'genome') return { refused: 'Link an element to it.' }
    const answer = model.answer
    const name = (id: string): string => shortName?.(id) ?? answer?.genomes.find((genome) => genome.id === id)?.name ?? id
    return { steps: [{ op: 'link', element: target.id, mag: plan.linkTo }], words: `link ${name(target.id)} to ${name(plan.linkTo)}` }
  }
  if (plan.dragged === null) return null
  return model.dropPlan(plan.dragged, target)
}

/**
 * What choosing a row makes, in words, the genomes by the names the stage
 * prints (`00700_00002`, not the file's `MM133_metator_00700_00002`): the drop
 * grammar's sentence (`curate/drop.ts`) with short names; `null` for nothing.
 */
export function chooserWords(
  answer: CurationStateResult,
  plan: ChooserPlan,
  target: CurateDropTarget,
  names: readonly string[],
  short: (id: string) => string,
): string | null {
  const contigWords = (contigs: readonly number[]): string => (contigs.length === 1 ? (names[contigs[0]] ?? 'a contig') : `${fmt.int(contigs.length)} contigs`)
  const genomeWords = (ids: readonly string[]): string => (ids.length <= 3 ? ids.map(short).join(', ') : `${fmt.int(ids.length)} genomes`)
  if (plan.linkTo !== null) return target.kind === 'genome' ? `link ${short(target.id)} to ${short(plan.linkTo)}` : null
  const dragged = plan.dragged
  if (dragged === null) return null
  if (dragged.kind === 'contigs') {
    if (target.kind === 'section') return `a new ${target.section === 'mags' ? 'MAG' : 'element'} of ${contigWords(dragged.contigs)}`
    if (target.kind === 'pool') {
      const binned = dragged.contigs.filter((c) => answer.genomeOf[c] >= 0)
      return binned.length === 0 ? null : `unbin ${contigWords(binned)}`
    }
    const g = answer.genomes.findIndex((genome) => genome.id === target.id)
    const moving = dragged.contigs.filter((c) => answer.genomeOf[c] !== g)
    if (moving.length === 0) return null
    return `${moving.every((c) => answer.genomeOf[c] < 0) ? 'recruit' : 'move'} ${contigWords(moving)} into ${short(target.id)}`
  }
  if (target.kind !== 'genome') return null
  if (plan.kind === 'merge') {
    const others = dragged.ids.filter((id) => id !== target.id)
    return others.length === 0 ? null : `merge ${genomeWords(others)} into ${short(target.id)}`
  }
  const linked = new Set(answer.links.filter((link) => link.mag === target.id).map((link) => link.element))
  const fresh = dragged.ids.filter((id) => !linked.has(id))
  return fresh.length === 0 ? null : `link ${genomeWords(fresh)} to ${short(target.id)}`
}

/** The plan for the selection as it stands, from a context. */
function planOf(ctx: CurateContext, kind: ChooserKind): ChooserPlan | null {
  const answer = ctx.model.answer
  if (answer === null) return null
  return chooserPlan({
    kind,
    answer,
    selection: ctx.model.selection,
    order: ctx.model.order,
    offered: ctx.model.offered(),
    names: ctx.data.file.names,
    shortName: (id) => ctx.shortName(id),
  })
}

/**
 * Make the step a choice names, for the selection as it stands: contigs moved
 * to it, genomes merged into it, elements linked to it — as dropping the
 * selection on it would (`curate/drop.ts`) — or, the selection one MAG, the
 * element chosen linked to it. `false` when it makes nothing.
 */
export function chooseStep(ctx: CurateContext, kind: ChooserKind, target: CurateDropTarget): boolean {
  const plan = planOf(ctx, kind)
  if (plan === null) return false
  if (plan.linkTo !== null) return target.kind === 'genome' && ctx.model.link(target.id, plan.linkTo, true)
  if (plan.dragged === null) return false
  return ctx.model.drop(plan.dragged, target)
}

/** How long the keyboard rests on a row before its step is priced, in ms. */
const PRICE_DELAY = 90

let serial = 0

/** The popover. */
export class Chooser {
  private static openOne: Chooser | null = null

  /**
   * Open a chooser for the selection as it stands, under an element or at a
   * point of the viewport. A chooser already open closes first.
   *
   * @param onChoose Told the target chosen, after the chooser has closed; it
   *   makes the step (see {@link chooseStep}).
   */
  static open(ctx: CurateContext, kind: ChooserKind, anchor: HTMLElement | { x: number; y: number }, onChoose: (target: CurateDropTarget) => void): Chooser {
    Chooser.openOne?.cancel()
    const chooser = new Chooser(ctx, kind, anchor, onChoose)
    Chooser.openOne = chooser
    chooser.mount()
    return chooser
  }

  /** Whether a chooser is open: the stage's Escape closes it before anything else. */
  static isOpen(): boolean {
    return Chooser.openOne !== null
  }

  /** Close the chooser open, if one is, as Escape does: `true` when one was. */
  static closeOpen(): boolean {
    const open = Chooser.openOne
    if (open === null) return false
    open.cancel()
    return true
  }

  readonly element: HTMLElement
  private readonly head: HTMLElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLElement
  private readonly foot: HTMLElement
  private plan: ChooserPlan | null = null
  /** The rows the filter keeps, in the order listed. */
  private shown: ChooserRow[] = []
  private nodes: HTMLElement[] = []
  private active = -1
  private closed = false
  private priceTimer: ReturnType<typeof setTimeout> | null = null
  /** The step this chooser previews, by its key. */
  private previewKey: string | null = null
  private readonly opener: Element | null
  private readonly id = `curate-chooser-${++serial}`
  private readonly unsubscribe: Array<() => void> = []

  private constructor(
    private readonly ctx: CurateContext,
    private readonly kind: ChooserKind,
    private readonly anchor: HTMLElement | { x: number; y: number },
    private readonly onChoose: (target: CurateDropTarget) => void,
  ) {
    this.opener = document.activeElement
    this.head = el('span', { class: 'curate-chooser-title' })
    this.input = el('input', {
      class: 'curate-chooser-filter',
      type: 'text',
      placeholder: 'filter by name…',
      attrs: {
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-autocomplete': 'list',
        'aria-controls': `${this.id}-list`,
        'aria-label': 'Filter the genomes by name',
        spellcheck: 'false',
        autocomplete: 'off',
        [TAB_WALKS]: '',
      },
      on: {
        input: () => this.refilter(true),
        keydown: (event: KeyboardEvent) => this.key(event),
      },
    })
    this.list = el('div', {
      class: 'curate-chooser-list',
      id: `${this.id}-list`,
      attrs: { role: 'listbox', 'aria-label': 'Where to' },
      on: {
        // A press on a row keeps the caret in the box: the keys stay the chooser's.
        // The mouse's own press is the one that moves the focus.
        pointerdown: (event: PointerEvent) => keepCaret(event),
        mousedown: (event: MouseEvent) => keepCaret(event),
      },
    })
    this.foot = el('div', { class: 'curate-chooser-foot', attrs: { 'aria-live': 'polite' } })
    const keys = el(
      'div',
      { class: 'curate-chooser-keys' },
      keyBadge('↑', { class: 'kbd-inline' }),
      keyBadge('↓', { class: 'kbd-inline' }),
      el('span', { text: 'to choose' }),
      keyBadge('⏎', { class: 'kbd-inline' }),
      el('span', { text: 'to take' }),
      keyBadge('Esc', { class: 'kbd-inline' }),
      el('span', { text: 'to close' }),
    )
    this.element = el(
      'div',
      {
        class: 'curate-chooser',
        attrs: { role: 'dialog', 'aria-labelledby': `${this.id}-title`, 'data-chooser': kind },
        on: {
          // A press anywhere in it but the box — its title, a group's head, the
          // foot, the scrollbar — keeps the caret in the box: the keys stay the
          // chooser's, never the stage's behind it.
          pointerdown: (event: PointerEvent) => keepCaretInside(event, this.input),
          mousedown: (event: MouseEvent) => keepCaretInside(event, this.input),
          focusout: (event: FocusEvent) => {
            const to = event.relatedTarget
            if (to instanceof Node && !this.element.contains(to)) this.cancel()
          },
        },
      },
      el('div', { class: 'curate-chooser-head' }, this.head, icon('search', { size: 13, class: 'curate-chooser-glyph' })),
      this.input,
      this.list,
      this.foot,
      keys,
    )
    this.head.id = `${this.id}-title`
    this.unsubscribe.push(
      ctx.model.subscribe((change) => {
        if (this.closed) return
        if (change === 'selection') this.cancel()
        else if (change === 'state') this.replan()
        else if (change === 'preview') this.paintFoot()
      }),
    )
  }

  /** The rows listed now, in order, the filter applied: for the tests and the stage. */
  get rows(): readonly ChooserRow[] {
    return this.shown
  }

  /** The row under the keyboard, or `null`. */
  get activeRow(): ChooserRow | null {
    return this.shown[this.active] ?? null
  }

  /**
   * Close without choosing: the preview this chooser priced is let go of, its
   * own only — the stage prices review's question again, rather than a copy
   * of whatever was held when it opened being put back.
   */
  cancel(): void {
    if (this.closed) return
    const mine = this.previewKey !== null && previewKey(this.ctx.model.previewSteps) === this.previewKey
    this.teardown()
    if (mine) this.ctx.model.preview(null)
  }

  /** Close: as {@link cancel}. */
  close(): void {
    this.cancel()
  }

  /**
   * Choose a row: the chooser closes, then the caller hears the target —
   * not while a step is counted, when its rows are of the binning before it.
   */
  choose(row: ChooserRow | null = this.activeRow): void {
    if (this.closed || row === null) return
    if (this.ctx.model.stale) {
      this.element.classList.add('is-waiting')
      return
    }
    const mine = this.previewKey
    this.teardown()
    this.onChoose(row.target)
    // A choice that made no step leaves the preview it was priced by: let go of it.
    if (mine !== null && previewKey(this.ctx.model.previewSteps) === mine) this.ctx.model.preview(null)
  }

  private mount(): void {
    const host = this.host()
    host.appendChild(this.element)
    this.replan()
    this.place()
    window.addEventListener('pointerdown', this.outside, true)
    window.addEventListener('resize', this.resized)
    window.addEventListener('scroll', this.scrolled, true)
    this.input.focus({ preventScroll: true })
  }

  /** The dialog on top that holds the anchor, so the chooser is inside it: not inert, under its keys. */
  private host(): HTMLElement {
    const anchor = this.anchor instanceof HTMLElement ? this.anchor.closest('.modal-backdrop') : null
    if (anchor instanceof HTMLElement) return anchor
    const dialogs = document.querySelectorAll<HTMLElement>('.modal-backdrop')
    return dialogs[dialogs.length - 1] ?? document.body
  }

  /**
   * Under its anchor, or above it where there is more room there than below
   * and too little below; inside the window. Held by the edge that faces the
   * anchor and kept to the room on that side, so the rows and the price it
   * grows by once counted push it away from the anchor, never over it or out
   * of the window: the list scrolls instead.
   */
  private place(): void {
    const style = this.element.style
    style.top = ''
    style.bottom = ''
    style.maxHeight = ''
    const box = this.element.getBoundingClientRect()
    const width = box.width
    const height = box.height
    const viewWidth = window.innerWidth
    const viewHeight = window.innerHeight
    const x = this.anchor instanceof HTMLElement ? this.anchor.getBoundingClientRect().left : this.anchor.x
    style.left = `${Math.round(Math.max(MARGIN, Math.min(x, viewWidth - width - MARGIN)))}px`
    // An anchor scrolled out of the window: the chooser stands in the window all
    // the same, where the anchor would come in, never off it with the keyboard in it.
    const anchorRect = this.anchor instanceof HTMLElement ? this.anchor.getBoundingClientRect() : null
    if (anchorRect !== null && (anchorRect.top >= viewHeight || anchorRect.bottom < 0)) {
      const y = anchorRect.top >= viewHeight ? viewHeight - height - MARGIN : MARGIN
      const top = Math.max(MARGIN, y)
      style.top = `${Math.round(top)}px`
      style.maxHeight = roomOf(viewHeight - MARGIN - top)
      return
    }
    if (this.anchor instanceof HTMLElement) {
      const rect = this.anchor.getBoundingClientRect()
      const below = viewHeight - MARGIN - (rect.bottom + GAP)
      const above = rect.top - GAP - MARGIN
      if (height <= below || below >= above) {
        style.top = `${Math.round(rect.bottom + GAP)}px`
        style.maxHeight = roomOf(below)
      } else {
        style.bottom = `${Math.round(viewHeight - rect.top + GAP)}px`
        style.maxHeight = roomOf(above)
      }
      return
    }
    const y = Math.max(MARGIN, Math.min(this.anchor.y, viewHeight - height - MARGIN))
    style.top = `${Math.round(y)}px`
    style.maxHeight = roomOf(viewHeight - MARGIN - y)
  }

  private readonly outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && this.element.contains(event.target)) return
    this.cancel()
  }

  private readonly resized = (): void => this.cancel()

  private readonly scrolled = (event: Event): void => {
    if (event.target instanceof Node && this.element.contains(event.target)) return
    this.cancel()
  }

  private teardown(): void {
    if (this.closed) return
    this.closed = true
    if (Chooser.openOne === this) Chooser.openOne = null
    if (this.priceTimer !== null) clearTimeout(this.priceTimer)
    this.priceTimer = null
    for (const off of this.unsubscribe) off()
    window.removeEventListener('pointerdown', this.outside, true)
    window.removeEventListener('resize', this.resized)
    window.removeEventListener('scroll', this.scrolled, true)
    const hadFocus = this.element.contains(document.activeElement)
    this.element.remove()
    if (hadFocus && this.opener instanceof HTMLElement && this.opener.isConnected) this.opener.focus({ preventScroll: true })
  }

  // -------------------------------------------------------------------------
  // The rows.
  // -------------------------------------------------------------------------

  /** Plan again: on opening, and after a count, keeping the filter and the row under the keyboard. */
  private replan(): void {
    const key = this.activeRow?.key ?? null
    this.plan = planOf(this.ctx, this.kind)
    this.head.textContent = this.plan?.title ?? 'counting the genomes…'
    this.element.setAttribute('aria-label', this.head.textContent)
    this.refilter(false, key)
  }

  /** The rows the filter keeps, drawn; the keyboard on `key`, else on the first. */
  private refilter(typed: boolean, key: string | null = null): void {
    const plan = this.plan
    const query = this.input.value.trim().toLowerCase()
    const answer = this.ctx.model.answer
    const rows = plan?.rows ?? []
    this.shown =
      query === '' || answer === null
        ? rows
        : rows.filter((row) => {
            if (row.label !== null) return row.label.toLowerCase().includes(query)
            const genome = answer.genomes[row.genome]
            return genome.name.toLowerCase().includes(query) || this.ctx.shortName(genome.id).toLowerCase().includes(query)
          })
    // Past the cap, the genomes the contacts do not name wait for the filter.
    const ranked = this.shown.filter((row) => row.group !== 'rest')
    const rest = this.shown.filter((row) => row.group === 'rest')
    const hidden = Math.max(0, rest.length - CHOOSER_REST)
    this.shown = [...ranked, ...rest.slice(0, CHOOSER_REST)]
    let active = key === null ? -1 : this.shown.findIndex((row) => row.key === key)
    if (active < 0) {
      // Typed: the first genome that matches, never a new genome nobody named.
      if (typed && query !== '') active = this.shown.findIndex((row) => row.label === null)
      else active = this.shown.length > 0 ? 0 : -1
    }
    this.active = active
    this.draw(hidden)
    this.activate(this.active, false)
  }

  private draw(hidden: number): void {
    const plan = this.plan
    const answer = this.ctx.model.answer
    this.nodes = []
    const parts: HTMLElement[] = []
    if (plan === null || answer === null) {
      parts.push(el('div', { class: 'curate-chooser-empty', text: 'Counting the genomes…' }))
    } else if (plan.empty !== null) {
      parts.push(el('div', { class: 'curate-chooser-empty', text: plan.empty }))
    } else if (this.shown.length === 0) {
      parts.push(el('div', { class: 'curate-chooser-empty', text: 'Nothing here is named like that.' }))
    } else {
      // Before the network's pass there is nothing to rank by: the genomes in the stage's order.
      if (!answer.counted) parts.push(el('div', { class: 'curate-chooser-note', text: 'Not ranked until the contacts are read.' }))
      let group: ChooserRow['group'] | null = null
      this.shown.forEach((row, k) => {
        if (row.group !== group) {
          group = row.group
          const words = groupWords(plan, row, answer)
          if (words !== null) parts.push(el('div', { class: 'curate-chooser-group', text: words, attrs: { role: 'presentation' } }))
        }
        const node = this.rowNode(row, k, answer)
        this.nodes.push(node)
        parts.push(node)
      })
      if (hidden > 0) parts.push(el('div', { class: 'curate-chooser-more', text: `and ${fmt.int(hidden)} more: type a name to find them` }))
    }
    this.list.replaceChildren(...parts)
  }

  private rowNode(row: ChooserRow, k: number, answer: CurationStateResult): HTMLElement {
    const node = el('div', {
      class: `curate-chooser-row is-${row.group}`,
      id: `${this.id}-row-${k}`,
      attrs: { role: 'option', 'aria-selected': 'false', 'data-key': row.key },
      on: {
        pointermove: () => {
          if (this.active !== k) this.activate(k, false)
        },
        click: () => this.choose(row),
      },
    })
    if (row.label === null) {
      const genome = answer.genomes[row.genome]
      node.dataset.genome = genome.id
      node.append(
        swatch(this.ctx.colourOf(genome.id).css, genome.kind),
        el('span', {
          class: 'curate-chooser-name',
          text: this.ctx.shortName(genome.id),
          title: `${genome.name} · ${genome.kind === 'mag' ? 'MAG' : 'element'} · ${fmt.bp(genome.length)} · ${fmt.int(genome.contigs)} ${genome.contigs === 1 ? 'contig' : 'contigs'}`,
        }),
      )
    } else {
      node.append(icon(EXTRA_ICON[row.key] ?? 'plus', { size: 13, class: 'curate-chooser-glyph' }), el('span', { class: 'curate-chooser-name', text: row.label }))
    }
    node.append(el('span', { class: 'curate-chooser-evidence', text: row.evidence, title: row.evidence }))
    if (row.confidence !== null) {
      node.append(el('span', { class: 'curate-chooser-confidence', text: confidenceText(row.confidence), title: 'The surest suggestion on offer towards this genome, for some or all of what is chosen for: its confidence.' }))
    }
    return node
  }

  /** Put the keyboard on row `k`, show it, and price its step a moment later. */
  private activate(k: number, reveal: boolean): void {
    this.active = k
    this.nodes.forEach((node, i) => {
      node.classList.toggle('is-active', i === k)
      node.setAttribute('aria-selected', String(i === k))
    })
    const node = this.nodes[k]
    if (node === undefined) this.input.removeAttribute('aria-activedescendant')
    else {
      this.input.setAttribute('aria-activedescendant', node.id)
      if (reveal) revealIn(this.list, node)
    }
    this.paintFoot()
    if (this.priceTimer !== null) clearTimeout(this.priceTimer)
    this.priceTimer = setTimeout(() => {
      this.priceTimer = null
      this.price()
    }, PRICE_DELAY)
  }

  /** Price the row under the keyboard: its step counted, not drawn. */
  private price(): void {
    if (this.closed || this.plan === null) return
    const row = this.activeRow
    const plan = row === null ? null : rowStep(this.ctx.model, this.plan, row.target, (id) => this.ctx.shortName(id))
    const step = plan?.steps?.length === 1 ? plan.steps[0] : null
    // Nothing to count for it — no step, or a link, which moves no contig and
    // changes no genome's quality: a preview of this chooser's goes.
    if (step === null || step.op === 'link' || step.op === 'unlink') {
      if (this.previewKey !== null && previewKey(this.ctx.model.previewSteps) === this.previewKey) this.ctx.model.preview(null)
      this.previewKey = null
      this.paintFoot()
      return
    }
    this.previewKey = previewKey(step)
    this.ctx.model.preview(step, false)
    this.paintFoot()
  }

  /** The foot: what the row under the keyboard makes, and what it costs. */
  private paintFoot(): void {
    if (this.closed) return
    const row = this.activeRow
    const plan = this.plan
    if (row === null || plan === null) {
      this.foot.replaceChildren()
      this.foot.classList.add('hidden')
      return
    }
    this.foot.classList.remove('hidden')
    const step = rowStep(this.ctx.model, plan, row.target, (id) => this.ctx.shortName(id))
    const parts: HTMLElement[] = []
    if (step === null || step.refused !== undefined) {
      parts.push(el('div', { class: 'curate-chooser-words is-refused', text: step?.refused ?? '' }))
    } else {
      const model = this.ctx.model
      const answer = model.answer
      const words = answer === null ? null : chooserWords(answer, plan, row.target, this.ctx.data.file.names, (id) => this.ctx.shortName(id))
      parts.push(el('div', { class: 'curate-chooser-words', text: words ?? step.words }))
      const key = step.steps.length === 1 ? previewKey(step.steps[0]) : null
      if (key !== null && answer !== null && previewKey(model.previewSteps) === key) {
        const after = model.previewed
        if (after === null) parts.push(el('div', { class: 'curate-chooser-counting', text: 'counting what it makes…' }))
        else {
          const price = priceList(answer, after, (id, name) => (answer.genomes.some((genome) => genome.id === id) ? this.ctx.shortName(id) : name))
          if (price !== null) parts.push(price)
        }
      }
    }
    this.foot.replaceChildren(...parts)
  }

  // -------------------------------------------------------------------------
  // The keys: the box's, and the chooser's.
  // -------------------------------------------------------------------------

  private key(event: KeyboardEvent): void {
    if (event.isComposing) return
    const n = this.shown.length
    const move = (to: number): void => {
      event.preventDefault()
      event.stopPropagation()
      if (n === 0) return
      this.activate(Math.max(0, Math.min(n - 1, to)), true)
    }
    switch (event.key) {
      case 'ArrowDown':
        move(this.active < 0 ? 0 : this.active + 1 >= n ? 0 : this.active + 1)
        return
      case 'ArrowUp':
        move(this.active <= 0 ? n - 1 : this.active - 1)
        return
      case 'PageDown':
        move(this.active + 8)
        return
      case 'PageUp':
        move(this.active - 8)
        return
      case 'Enter':
        event.preventDefault()
        event.stopPropagation()
        // Held down, the key repeats: one press, one choice — never a chain of them.
        if (event.repeat) return
        this.choose()
        return
      case 'Tab':
        // The chooser is a popover over the dialog, not one of its stops: Tab
        // leaves it as Escape does, the keyboard back where it came from.
        event.preventDefault()
        event.stopPropagation()
        this.cancel()
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        this.cancel()
        return
      default:
        // Every other key is the box's: the stage's letters stand down in a field.
        event.stopPropagation()
    }
  }
}

/** The mark of each row that is not a genome. */
const EXTRA_ICON: Record<string, IconName> = { 'section:mags': 'plus', 'section:elements': 'circle-dot', pool: 'minus' }

/** The words over a group of rows, or `null` for none. */
function groupWords(plan: ChooserPlan, row: ChooserRow, answer: CurationStateResult): string | null {
  switch (row.group) {
    case 'ranked':
      if (plan.kind === 'move') return 'where they meet most'
      if (plan.kind === 'merge') return plan.dragged?.kind === 'genomes' && plan.dragged.ids.length > 1 ? 'keeps its name · meets them most' : 'meets it most'
      return plan.linkTo === null ? 'hosts, by the contacts' : 'elements it would host'
    case 'extra':
      return 'or'
    case 'rest':
      if (plan.kind === 'move') return 'every other genome'
      return answer.genomes[row.genome]?.kind === 'element' ? 'every other element' : 'every other MAG'
  }
}

/** How far the chooser stands from its anchor, and from the window's edges, in CSS pixels. */
const GAP = 4
const MARGIN = 8

/** The most the chooser may be tall on a side with `room` pixels: the stylesheet's own cap, or the room. */
function roomOf(room: number): string {
  return `min(32rem, 72vh, ${Math.max(120, Math.floor(room))}px)`
}

/** A press on a row keeps the caret in the filter box, so the keys stay the chooser's. */
function keepCaret(event: Event): void {
  if ((event.target as Element | null)?.closest('.curate-chooser-row') !== null) event.preventDefault()
}

/** A press anywhere in the chooser but its box keeps the caret in the box. */
function keepCaretInside(event: Event, box: HTMLInputElement): void {
  if (event.target !== box) event.preventDefault()
}

/**
 * Scroll `list` so `node` is in view, by their boxes: a row's `offsetTop` is
 * from the chooser, the list's nearest positioned ancestor, not from the list.
 */
function revealIn(list: HTMLElement, node: HTMLElement): void {
  const box = list.getBoundingClientRect()
  const row = node.getBoundingClientRect()
  if (row.top < box.top) list.scrollTop -= box.top - row.top
  else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom
}
