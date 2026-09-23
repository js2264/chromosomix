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
 *
 * ## A store that asks for cards
 *
 * The same page draws any store whose file declares `layout: "cards"` and a
 * `group` (§24.1): a lab's shelf of organisms is IGV's shelf of genomes in every
 * way that matters to a reader — one thing per card, the whole of it one press
 * away, its files a fold down. Such a store is **one** file with its sessions
 * among its rows — handed over already read when it came through the URL box,
 * or fetched here for a shipped one with no sessions file beside it (the
 * DNA Bacterial Zoo, §24.3) — and is drawn the same either way: a card per
 * value of the group, in the store's own order, whose button is the group's
 * workspace row — or, where it has none, the row carrying a shelf of tracks,
 * which is the rule the portal's group heading follows (`ResultList.ts`). The
 * chips are the store's `headline` fields and the session's track count. A row
 * with no value for the group is not dropped: it sits under the cards in a fold
 * of its own, as the lab gallery's unfigured files do.
 */

import { button, el, fmt } from '../dom'
import { iconButton } from '../icons'
import { valueOf } from '../../state/facets'
import { fetchStore, type StoreEntry, type StoreFile } from '../../state/store'
import { rowActions, type StoreHost } from './host'
import { storeFailure } from './PortalView'
import type { StoreFront } from './registry'

export interface GenomesViewProps {
  /**
   * IGV's front names two files, the rows and the sessions beside them. A front
   * naming the rows alone is one file of cards grouped by its `group`.
   */
  front: StoreFront
  host: StoreHost
  /** A store already read that asked for cards, grouped by `front.group`: nothing is fetched. */
  file?: StoreFile
  /** The catalogue landed; the drawer can offer a download of it. */
  onLoaded?(): void
}

interface Card {
  /** What the card is filtered and grouped by: an assembly, a species. */
  key: string
  title: string
  /** The whole name, where the title shortens it. */
  tooltip: string
  /** What the card is of — an assembly, a store's headline fields — drawn solid, then its counts, dim. */
  chips: Array<{ text: string; count: boolean }>
  /** What the filter box matches against. */
  search: string[]
  session: StoreEntry | null
  files: StoreEntry[]
}

/** `Human (GRCh38/hg38)` → `Human`: the name IGV gives a genome, without the assembly it brackets after it. */
export function shortName(label: string): string {
  const short = label.replace(/\s*\([^()]*\)\s*$/, '').trim()
  return short === '' ? label : short
}

/**
 * A row's label inside the card it belongs to, less the card's own name.
 *
 * `A_muris · Insulation boundaries` under a card already headed *A_muris* is the
 * same name eighteen times down a fold. Only a name followed by a separator is
 * taken off, so `A_muris_v2 …` under *A_muris* is left whole; and only for the
 * drawing — the row keeps its whole label as the name the file takes when it
 * opens (§24.2), because on another organism's map the organism is the point.
 */
function withinCard(label: string, title: string): string {
  if (!label.startsWith(title)) return label
  const rest = label.slice(title.length)
  const trimmed = rest.replace(/^\s*[·—–:]\s*/, '')
  return trimmed === rest || trimmed === '' ? label : trimmed
}

function tracksChip(session: StoreEntry | null): Array<{ text: string; count: boolean }> {
  const tracks = session === null ? '' : valueOf(session, 'tracks')
  return tracks === '' ? [] : [{ text: `${tracks} ${tracks === '1' ? 'track' : 'tracks'}`, count: true }]
}

export class GenomesView {
  readonly el: HTMLElement
  private readonly filter: HTMLInputElement
  private readonly toolbar: HTMLElement
  private readonly statusEl = el('div', { class: 'portal-status hidden' })
  private readonly cards = el('div', { class: 'genomes-cards' })
  private readonly looseEl = el('div')
  private all: Card[] = []
  private loose: StoreEntry[] = []
  private destroyed = false
  /** IGV's two files, rather than one file of cards. */
  private readonly igv: boolean

  constructor(private readonly props: GenomesViewProps) {
    const file = props.file
    this.igv = file === undefined && props.front.sessions !== undefined
    this.filter = el('input', {
      class: 'input portal-search',
      type: 'search',
      placeholder: this.igv ? 'filter by genome or assembly' : `filter by ${this.groupLabel()}`,
      attrs: { 'aria-label': this.igv ? 'filter the genomes' : 'filter the cards' },
    })
    this.filter.addEventListener('input', () => this.paint())
    // Hidden until there is something to narrow. It used to stand above the
    // status line whatever the status said, so a store still being read — or one
    // that failed — offered a box a reader could type into with nothing behind
    // it (§8.5). The portal fronts of this same drawer hide their whole main
    // while a status shows; this is that rule, for the one front that did not.
    this.toolbar = el('div', { class: 'portal-toolbar hidden' }, this.filter)
    this.el = el('div', { class: 'genomes' }, this.toolbar, this.statusEl, this.cards, this.looseEl)
    if (file !== undefined) this.read(file)
    else if (this.igv) void this.load()
    else void this.loadOne()
  }

  destroy(): void {
    this.destroyed = true
  }

  /** The catalogue as read: IGV's rows, not the sessions shelf beside them. */
  fileNow(): StoreFile | null {
    return this.rowsFile
  }

  private rowsFile: StoreFile | null = null

  /** What the group is called, for the filter and the fold of rows in none: the column's own label. */
  private groupLabel(): string {
    const key = this.props.front.group ?? ''
    const column = (this.props.file ?? this.rowsFile)?.columns.find((one) => one.key === key)
    return (column?.label ?? key).toLowerCase()
  }

  private async load(): Promise<void> {
    const front = this.props.front
    this.say(`Reading ${front.label}…`, false)
    const [sessions, rows] = await Promise.all([
      front.sessions?.url === undefined ? null : fetchStore(front.sessions.url),
      front.rows?.url === undefined ? null : fetchStore(front.rows.url),
    ])
    if (this.destroyed) return
    const byAssembly = new Map<string, { label: string; session: StoreEntry | null; files: StoreEntry[] }>()
    const genome = (assembly: string, label: string) => {
      let held = byAssembly.get(assembly)
      if (held === undefined) {
        held = { label, session: null, files: [] }
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
    this.all = [...byAssembly.entries()]
      .map(([assembly, held]): Card => ({
        key: assembly,
        // The name without the assembly in brackets IGV appends to it — *Human
        // (GRCh38/hg38)* — because the assembly is the chip under it, and a
        // card that says it twice is a card that reads slowly. The whole name
        // stays in the tooltip and is what the filter box searches.
        title: shortName(held.label),
        tooltip: held.label,
        chips: [{ text: assembly, count: false }, ...tracksChip(held.session)],
        search: [held.label, assembly],
        session: held.session,
        files: held.files,
      }))
      .sort((a, b) => a.tooltip.localeCompare(b.tooltip, undefined, { numeric: true, sensitivity: 'base' }))
    if (this.all.length === 0) {
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

  /** A shipped store of cards: its one file, read on the gesture that opened it. */
  private async loadOne(): Promise<void> {
    const ref = this.props.front.rows
    this.say(`Reading ${this.props.front.label}…`, false)
    const got = ref?.url === undefined ? null : await fetchStore(ref.url)
    if (this.destroyed) return
    if (got === null || ref === undefined) {
      this.say('This store lists nothing.', true)
      return
    }
    if (!got.ok) {
      this.say(storeFailure(got, ref), true)
      return
    }
    this.read(got.store)
    // The column's own label, which was not known until the file was.
    this.filter.placeholder = `filter by ${this.groupLabel()}`
  }

  /** A store of cards: one per value of its group, from the file in hand. */
  private read(file: StoreFile): void {
    const key = this.props.front.group ?? ''
    const headline = this.props.front.headline ?? []
    const byKey = new Map<string, Card>()
    for (const entry of file.entries) {
      const value = valueOf(entry, key)
      if (value === '') {
        this.loose.push(entry)
        continue
      }
      let card = byKey.get(value)
      if (card === undefined) {
        card = { key: value, title: value, tooltip: value, chips: [], search: [value], session: null, files: [] }
        byKey.set(value, card)
      }
      // The group's first session is its button, and is not also a row under
      // the fold; a second one is a row like any other file.
      if (entry.kind === 'workspace' && card.session === null) card.session = entry
      else card.files.push(entry)
    }
    for (const card of byKey.values()) {
      const first = card.session ?? card.files[0]
      const named = headline.map((field) => valueOf(first, field)).filter((value) => value !== '' && value !== card.title)
      card.chips = [...named.map((text) => ({ text, count: false })), ...tracksChip(card.session)]
      card.search = [card.title, ...named]
    }
    this.all = [...byKey.values()]
    this.rowsFile = file
    this.props.onLoaded?.()
    if (this.all.length === 0 && this.loose.length === 0) {
      this.say('This store lists nothing.', true)
      return
    }
    this.say('', false)
    this.paint()
  }

  private say(text: string, bad: boolean): void {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('hidden', text === '')
    this.statusEl.classList.toggle('portal-status-error', bad)
    this.toolbar.classList.toggle('hidden', this.all.length === 0)
  }

  private paint(): void {
    const needle = this.filter.value.trim().toLowerCase()
    const shown = this.all.filter(
      (card) =>
        needle === '' || card.search.some((text) => text.toLowerCase().includes(needle)),
    )
    const what = this.igv
      ? `${fmt.int(this.all.length)} genomes`
      : `${fmt.int(this.all.length)} ${this.all.length === 1 ? 'card' : 'cards'}`
    this.cards.replaceChildren(
      ...(shown.length === 0 && this.all.length > 0
        ? [el('p', { class: 'hint', text: `Nothing matches. ${what} in this store.` })]
        : shown.map((card) => this.card(card))),
    )
    // Under the cards and only while nothing is filtered: the filter narrows
    // cards, and rows in no card are not an answer to it.
    this.looseEl.replaceChildren(
      ...(needle !== '' || this.loose.length === 0
        ? []
        : [
            el(
              'details',
              { class: 'gallery-card-more gallery-loose' },
              el('summary', {
                text: `${fmt.int(this.loose.length)} more ${this.loose.length === 1 ? 'file' : 'files'}, in no ${this.groupLabel()}`,
              }),
              el('div', { class: 'gallery-card-files' }, ...this.loose.map((entry) => this.fileRow(entry, null))),
            ),
          ]),
    )
  }

  /**
   * One card: its name and the one verb on a line, the chips under them, and
   * its files behind a fold — the shape the lab's figure cards have
   * (`GalleryView.ts`). IGV's verb is the session with every track IGV ships,
   * and a genome with rows but no session says so where the verb would be.
   */
  private card(card: Card): HTMLElement {
    const igv = this.igv
    return el(
      'article',
      { class: 'gallery-card genomes-card' },
      el(
        'div',
        { class: 'gallery-card-head' },
        el('h4', { class: 'gallery-card-title', text: card.title, title: card.tooltip }),
        this.verb(card),
      ),
      el(
        'div',
        { class: 'gallery-card-chips' },
        ...card.chips.map((chip) =>
          el('span', { class: chip.count ? 'portal-chip portal-chip-dim' : 'portal-chip', text: chip.text }),
        ),
      ),
      igv && card.session === null
        ? el('p', { class: 'hint gallery-card-line', text: 'IGV published no session for this genome.' })
        : null,
      card.files.length === 0
        ? null
        : el(
            'details',
            { class: 'gallery-card-more' },
            el('summary', { text: `${fmt.int(card.files.length)} ${card.files.length === 1 ? 'file' : 'files'}` }),
            el('div', { class: 'gallery-card-files' }, ...card.files.map((entry) => this.fileRow(entry, card))),
          ),
    )
  }

  /** The card's one verb: its session, or the row that brings a shelf of tracks; none when it has neither. */
  private verb(card: Card): HTMLElement | null {
    const options = { class: 'btn btn-icon row-verb row-verb-new gallery-card-open', size: 16 }
    const session = card.session
    if (session !== null) {
      const title = this.igv
        ? `Open ${card.tooltip} in a new tab — the sequence and every track IGV ships for it, in the 1D browser.`
        : `Open ${session.label} in a new tab${session.note === undefined ? '' : ` — ${session.note}`}`
      return iconButton('new-session', title, () => this.props.host.open(session), options)
    }
    if (this.igv) return null
    const lead = card.files.find((entry) => entry.tracks !== undefined && entry.tracks.length > 0)
    if (lead === undefined) return null
    const count = lead.tracks?.length ?? 0
    return iconButton(
      'new-session',
      `Open ${lead.label} in a new tab, with its ${count} ${count === 1 ? 'track' : 'tracks'} already on`,
      () => this.props.host.openWithTracks(lead),
      options,
    )
  }

  private fileRow(entry: StoreEntry, card: Card | null): HTMLElement {
    const role = valueOf(entry, 'role')
    const shown =
      card === null || this.igv ? entry.label : withinCard(entry.label, card.title)
    const tooltip = [shown === entry.label ? '' : entry.label, entry.note ?? ''].filter((part) => part !== '').join(' — ')
    return el(
      'div',
      { class: 'portal-row' },
      el(
        'div',
        { class: 'portal-row-text' },
        button(shown, () => this.props.host.open(entry), { class: 'btn-link portal-name', title: tooltip }),
        role === '' ? null : el('span', { class: 'portal-chip portal-chip-dim', text: role }),
      ),
      entry.size === undefined ? null : el('span', { class: 'portal-size', text: fmt.bytes(entry.size) }),
      el('div', { class: 'portal-row-actions' }, ...rowActions(entry, this.props.host)),
    )
  }
}
