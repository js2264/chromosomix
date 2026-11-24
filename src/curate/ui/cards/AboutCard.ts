/**
 * The inspector's card *about the map* (SPECS §33.3, §33.5): what the stage
 * read and what it weighs by — the pairs of contigs in contact and the pixels
 * they were read from, the background (the rate of spurious ligation) and how
 * it was measured, the marker sets the quality is counted on, the scatter's
 * height, and the confidences a suggestion is offered, first and taken at.
 *
 * The contacts' read is the stage's: it hands its result over through
 * `network`, or as `data.network` where the stage keeps it there; without it
 * the card says what the answers alone tell — the contacts read and the
 * background.
 */

import { el } from '../../../ui/dom'
import { fmt } from '../../../units'
import type { CurationNetworkResult, CurationStateResult } from '../../../worker/curateProtocol'
import { AUTO_THRESHOLD, LIKELY, OFFER_FLOOR } from '../../method'
import type { CurateChange } from '../../model'
import type { CurateContext, CurateData } from '../context'
import { affinityText, card } from './card'

export interface AboutOptions {
  /** The contacts' read once it is done, or `null` before: what the card says of it. */
  network?: () => CurationNetworkResult | null
}

/** A confidence as the card prints a threshold: `15%`. */
function percent(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** How the background was measured, in words (`curate/method.ts`'s `background`). */
function measured(network: CurationNetworkResult): string {
  const { how, pairs } = network.background
  switch (how) {
    case 'median':
      return `the median, over ${fmt.int(pairs)} ${pairs === 1 ? 'pair' : 'pairs'} of MAGs, of their contacts over the contacts expected`
    case 'total':
      return `every pair of MAGs’ contacts over the contacts expected, since most pairs share none: a stricter background, for a shallow library`
    default:
      return 'one contact over every contact read: no two MAGs are in contact'
  }
}

export class AboutCard {
  readonly element: HTMLElement
  private readonly body: HTMLElement
  private readonly network: () => CurationNetworkResult | null
  /** Every contact read, within contigs and between two, counted once from an answer: no step changes it. */
  private contacts: number | null = null
  private frame = 0
  private disposed = false
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly ctx: CurateContext,
    options: AboutOptions = {},
  ) {
    const built = card('about the map')
    this.element = built.element
    this.body = built.body
    this.element.classList.add('curate-about-card')
    // The stage's read, handed over, or kept on the data where the stage keeps it.
    this.network = options.network ?? (() => (ctx.data as CurateData & { network?: CurationNetworkResult | null }).network ?? null)
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.paint()
  }

  /** What changed: the contacts read, or a count — once; the rest is the file's. */
  update(change: CurateChange): void {
    if (change === 'state' || change === 'error') this.schedule()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const off of this.unsubscribe) off()
  }

  private schedule(): void {
    if (this.disposed) return
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paint())
  }

  private paint(): void {
    if (this.disposed) return
    const { data } = this.ctx
    const network = this.network()
    const answer = this.ctx.model.answer
    if (this.contacts === null && answer !== null && answer.counted) this.contacts = totalContacts(answer)
    const rows: HTMLElement[] = []
    const fact = (label: string, value: string, note?: string, title?: string): void => {
      rows.push(
        el('dt', { class: 'curate-about-label', text: label }),
        el('dd', { class: 'curate-about-value', ...(title === undefined ? {} : { title }) }, el('span', { text: value }), note === undefined ? null : el('span', { class: 'curate-about-note', text: note })),
      )
    }
    const read = network !== null || answer?.counted === true
    if (network !== null) {
      fact(
        'contacts',
        `${fmt.int(network.pairs)} ${network.pairs === 1 ? 'pair' : 'pairs'} of contigs in contact`,
        `${fmt.int(network.within + network.between)} contacts, from ${fmt.int(network.pixels)} stored ${network.pixels === 1 ? 'pixel' : 'pixels'}`,
        `${fmt.int(network.between)} contacts between two contigs and ${fmt.int(network.within)} within one, over ${fmt.int(network.contigs)} contigs`,
      )
    } else if (this.contacts !== null) fact('contacts', `${fmt.int(this.contacts)} contacts read`)
    else fact('contacts', 'not read yet', 'the maps, the hosts and the suggestions come with them')
    const rho = network?.background.rho ?? data.background
    if (rho !== null && read) {
      fact('background', affinityText(rho), network === null ? 'the rate of spurious ligation' : measured(network), 'The rate of spurious ligation, contacts observed over expected: a suggestion’s contacts must stand out of it, and the contact map’s key starts at it')
    }
    if (data.markerSets.length === 0) fact('markers', 'no marker genes stored: run metator markers')
    else fact('markers', data.markerSets.join(' · '), 'a genome is judged by the set it is most complete in')
    fact('scatter', data.gc === null ? 'no GC content stored' : `GC × ${data.coverageLabel}`, data.coverage === null && data.gc !== null ? 'the height once the contacts are read' : undefined)
    fact('suggestions', `offered from ${percent(OFFER_FLOOR)} · first from ${percent(LIKELY)} · auto from ${percent(AUTO_THRESHOLD)}`)
    this.body.replaceChildren(el('dl', { class: 'curate-about-facts' }, ...rows))
  }
}

/** Every contact read: each contig's hits count a contact between two contigs once at each end, and one within it twice. */
function totalContacts(answer: CurationStateResult): number {
  let sum = 0
  const hits = answer.contigs.hits
  for (let c = 0; c < hits.length; c++) sum += hits[c]
  return Math.round(sum / 2)
}
