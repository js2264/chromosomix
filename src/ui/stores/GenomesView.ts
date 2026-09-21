/**
 * IGV's store: one card per reference genome, with the tracks it ships.
 *
 * IGV's genome table is not a catalogue of experiments and is not drawn like
 * one: what distinguishes two rows is which assembly they belong to, and what
 * a reader wants of an assembly is *the sequence with its gene track*, placed
 * — which is exactly the pre-configured session the generator writes for each
 * genome (§24.3). So the card is the session: the genome's name, its assembly,
 * how many tracks, and *open with its tracks*. The files are under a fold on
 * each card, with the two verbs every store row has, for the reader who wants
 * hg38's genes over their own map.
 *
 * Two files are read on the gesture that opened the store, the sessions and
 * the rows, and either may be missing on a fork whose workflow has not run:
 * with sessions alone the cards have no files, with rows alone they have no
 * button, and with neither the front says what generates them.
 */

import { button, el, fmt } from '../dom'
import { iconButton } from '../icons'
import { valueOf } from '../../state/facets'
import { fetchStore, type StoreEntry, type StoreFile } from '../../state/store'
import { rowActions, type StoreHost } from './host'
import { storeFailure } from './PortalView'
import type { StoreFront } from './registry'

export interface GenomesViewProps {
  front: StoreFront
  host: StoreHost
  /** The catalogue landed; the drawer can offer a download of it. */
  onLoaded?(): void
}

interface Genome {
  assembly: string
  label: string
  session: StoreEntry | null
  files: StoreEntry[]
}

/** `Human (GRCh38/hg38)` → `Human`: the name IGV gives a genome, without the assembly it brackets after it. */
export function shortName(label: string): string {
  const short = label.replace(/\s*\([^()]*\)\s*$/, '').trim()
  return short === '' ? label : short
}

export class GenomesView {
  readonly el: HTMLElement
  private readonly filter: HTMLInputElement
  private readonly toolbar: HTMLElement
  private readonly statusEl = el('div', { class: 'portal-status hidden' })
  private readonly cards = el('div', { class: 'genomes-cards' })
  private genomes: Genome[] = []
  private destroyed = false

  constructor(private readonly props: GenomesViewProps) {
    this.filter = el('input', {
      class: 'input portal-search',
      type: 'search',
      placeholder: 'filter by genome or assembly',
      attrs: { 'aria-label': 'filter the genomes' },
    })
    this.filter.addEventListener('input', () => this.paint())
    // Hidden until there is something to narrow. It used to stand above the
    // status line whatever the status said, so a store still being read — or one
    // that failed — offered a box a reader could type into with nothing behind
    // it (§8.5). The portal fronts of this same drawer hide their whole main
    // while a status shows; this is that rule, for the one front that did not.
    this.toolbar = el('div', { class: 'portal-toolbar hidden' }, this.filter)
    this.el = el('div', { class: 'genomes' }, this.toolbar, this.statusEl, this.cards)
    void this.load()
  }

  destroy(): void {
    this.destroyed = true
  }

  /** The catalogue as read: IGV's rows, not the sessions shelf beside them. */
  fileNow(): StoreFile | null {
    return this.rowsFile
  }

  private rowsFile: StoreFile | null = null

  private async load(): Promise<void> {
    const front = this.props.front
    this.say(`Reading ${front.label}…`, false)
    const [sessions, rows] = await Promise.all([
      front.sessions?.url === undefined ? null : fetchStore(front.sessions.url),
      front.rows?.url === undefined ? null : fetchStore(front.rows.url),
    ])
    if (this.destroyed) return
    const byAssembly = new Map<string, Genome>()
    const genome = (assembly: string, label: string): Genome => {
      let held = byAssembly.get(assembly)
      if (held === undefined) {
        held = { assembly, label, session: null, files: [] }
        byAssembly.set(assembly, held)
      }
      return held
    }
    if (sessions?.ok === true) {
      for (const entry of sessions.store.entries) {
        if (entry.kind !== 'workspace') continue
        const assembly = valueOf(entry, 'dataset') || valueOf(entry, 'assembly')
        if (assembly === '') continue
        genome(assembly, valueOf(entry, 'subject') || assembly).session = entry
      }
    }
    // The rows file *is* this store's catalogue; the sessions beside it are a
    // separate published file and a separate shelf, so a download of "this
    // store" is this one.
    if (rows?.ok === true) this.rowsFile = rows.store
    this.props.onLoaded?.()
    if (rows?.ok === true) {
      for (const entry of rows.store.entries) {
        const assembly = valueOf(entry, 'assembly')
        if (assembly === '') continue
        const held = genome(assembly, valueOf(entry, 'genome') || assembly)
        held.files.push(entry)
        if (held.label === assembly && valueOf(entry, 'genome') !== '') held.label = valueOf(entry, 'genome')
      }
    }
    this.genomes = [...byAssembly.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
    )
    if (this.genomes.length === 0) {
      const failed = sessions !== null && !sessions.ok ? sessions : rows !== null && !rows.ok ? rows : null
      const ref = sessions !== null && !sessions.ok ? front.sessions : front.rows
      this.say(
        failed !== null && ref !== undefined ? storeFailure(failed, ref) : 'This store lists nothing.',
        true,
      )
      return
    }
    this.say('', false)
    this.paint()
  }

  private say(text: string, bad: boolean): void {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('hidden', text === '')
    this.statusEl.classList.toggle('portal-status-error', bad)
    this.toolbar.classList.toggle('hidden', this.genomes.length === 0)
  }

  private paint(): void {
    const needle = this.filter.value.trim().toLowerCase()
    const shown = this.genomes.filter(
      (genome) =>
        needle === '' ||
        genome.label.toLowerCase().includes(needle) ||
        genome.assembly.toLowerCase().includes(needle),
    )
    this.cards.replaceChildren(
      ...(shown.length === 0
        ? [el('p', { class: 'hint', text: `Nothing matches. ${fmt.int(this.genomes.length)} genomes in this store.` })]
        : shown.map((genome) => this.card(genome))),
    )
  }

  /**
   * One genome: its name and the one verb on a line, the chips under them,
   * and its files behind a fold — the shape the lab's figure cards have
   * (`GalleryView.ts`). The verb is the session with every track IGV ships,
   * and a genome with rows but no session says so where the verb would be.
   */
  private card(genome: Genome): HTMLElement {
    const session = genome.session
    const tracks = session === null ? '' : valueOf(session, 'tracks')
    return el(
      'article',
      { class: 'gallery-card genomes-card' },
      el(
        'div',
        { class: 'gallery-card-head' },
        // The name without the assembly in brackets IGV appends to it — *Human
        // (GRCh38/hg38)* — because the assembly is the chip under it, and a
        // card that says it twice is a card that reads slowly. The whole name
        // stays in the tooltip and is what the filter box searches.
        el('h4', { class: 'gallery-card-title', text: shortName(genome.label), title: genome.label }),
        session === null
          ? null
          : iconButton(
              'new-session',
              `Open ${genome.label} in a new tab — the sequence and every track IGV ships for it, in the 1D browser.`,
              () => this.props.host.open(session),
              { class: 'btn btn-icon row-verb row-verb-new gallery-card-open', size: 16 },
            ),
      ),
      el(
        'div',
        { class: 'gallery-card-chips' },
        el('span', { class: 'portal-chip', text: genome.assembly }),
        tracks === '' ? null : el('span', { class: 'portal-chip portal-chip-dim', text: `${tracks} ${tracks === '1' ? 'track' : 'tracks'}` }),
      ),
      session === null
        ? el('p', { class: 'hint gallery-card-line', text: 'IGV published no session for this genome.' })
        : null,
      genome.files.length === 0
        ? null
        : el(
            'details',
            { class: 'gallery-card-more' },
            el('summary', { text: `${fmt.int(genome.files.length)} ${genome.files.length === 1 ? 'file' : 'files'}` }),
            el('div', { class: 'gallery-card-files' }, ...genome.files.map((entry) => this.fileRow(entry))),
          ),
    )
  }

  private fileRow(entry: StoreEntry): HTMLElement {
    const role = valueOf(entry, 'role')
    return el(
      'div',
      { class: 'portal-row' },
      el(
        'div',
        { class: 'portal-row-text' },
        button(entry.label, () => this.props.host.open(entry), { class: 'btn-link portal-name', title: entry.note ?? '' }),
        role === '' ? null : el('span', { class: 'portal-chip portal-chip-dim', text: role }),
      ),
      entry.size === undefined ? null : el('span', { class: 'portal-size', text: fmt.bytes(entry.size) }),
      el('div', { class: 'portal-row-actions' }, ...rowActions(entry, this.props.host)),
    )
  }
}
