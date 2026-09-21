/**
 * The lab's own store: a gallery of composed figures, and the files under them.
 *
 * What a first-time reader should meet is the application doing its job — a
 * window worth looking at, tracks on both edges of the map, two strands
 * sharing a lane — and all of that is what a saved workspace writes down
 * (`ui/examples.ts`). So the front of this store is *cards*, one per published
 * session: what it shows, on which assembly, where the data came from, and one
 * button. The bare files are underneath, for the reader who wants the `.cool`
 * alone, drawn as rows with the same two verbs every store row has.
 *
 * Each card says enough to choose and no more: a title, one line, two chips.
 * The paragraph that used to be the whole row is behind a fold, because a
 * gallery of four paragraphs is a page to read rather than a shelf to pick
 * from.
 */

import { button, el } from '../dom'
import { icon, iconButton } from '../icons'
import { valueOf } from '../../state/facets'
import type { StoreEntry, StoreFile } from '../../state/store'
import { rowActions, type StoreHost } from './host'
import type { StoreFront } from './registry'

export interface GalleryViewProps {
  front: StoreFront
  host: StoreHost
}

export class GalleryView {
  readonly el: HTMLElement

  /**
   * The catalogue, which for this front is inline and therefore never pending:
   * it ships inside the bundle, so there is nothing to wait for and no
   * `onLoaded` to raise.
   */
  fileNow(): StoreFile | null {
    return this.props.front.rows?.inline ?? null
  }

  constructor(private readonly props: GalleryViewProps) {
    const file = props.front.rows?.inline ?? null
    this.el = el('div', { class: 'gallery' })
    if (file === null) {
      this.el.appendChild(
        el('p', { class: 'hint', text: 'This store carries nothing inline, so there is nothing to draw.' }),
      )
      return
    }
    const figures = file.entries.filter((entry) => entry.kind === 'workspace')
    const files = file.entries.filter((entry) => entry.kind !== 'workspace')
    const byUri = new Map(files.map((entry) => [entry.uri, entry] as const))
    this.el.appendChild(
      el('div', { class: 'gallery-cards' }, ...figures.map((entry) => this.card(entry, byUri))),
    )
    // A file no figure names still has a row, under the cards rather than
    // nowhere: the two maps published without a session of their own.
    const named = new Set(figures.flatMap((entry) => filesOf(entry)))
    const loose = files.filter((entry) => !named.has(entry.uri))
    if (loose.length > 0) {
      this.el.appendChild(
        el(
          'details',
          { class: 'gallery-card-more gallery-loose' },
          el('summary', { text: `${loose.length} more ${loose.length === 1 ? 'file' : 'files'}, in no figure` }),
          el('div', { class: 'gallery-card-files' }, ...loose.map((entry) => this.fileRow(entry))),
        ),
      )
    }
  }

  destroy(): void {
    /* nothing subscribed */
  }

  /**
   * One figure: its name and the one verb on a line, the chips under them, the
   * line that says what is on screen, and its files behind a fold — the same
   * shape IGV's genome cards have (`GenomesView.ts`), so the two galleries
   * read as one kind of thing.
   */
  private card(entry: StoreEntry, byUri: ReadonlyMap<string, StoreEntry>): HTMLElement {
    const assembly = valueOf(entry, 'assembly')
    const provenance = valueOf(entry, 'provenance')
    const detail = valueOf(entry, 'detail')
    const files = filesOf(entry)
      .map((uri) => byUri.get(uri))
      .filter((row): row is StoreEntry => row !== undefined)
    return el(
      'article',
      { class: 'gallery-card' },
      el(
        'div',
        { class: 'gallery-card-head' },
        el('h4', { class: 'gallery-card-title', text: entry.label }),
        iconButton(
          'new-session',
          `Open ${entry.label} in a new session — the figure with every track it names.`,
          () => this.props.host.open(entry),
          { class: 'btn btn-icon row-verb row-verb-new gallery-card-open', size: 16 },
        ),
      ),
      el(
        'div',
        { class: 'gallery-card-chips' },
        assembly === '' ? null : el('span', { class: 'portal-chip', text: assembly }),
        // The chip clips at 22rem, so an accession and a DOI together end in an
        // ellipsis — and a reader who came to cite the dataset had nowhere to
        // read the rest: the title said what the chip was rather than what it
        // held. It now carries the whole string.
        provenance === ''
          ? null
          : el('span', {
              class: 'portal-chip portal-chip-dim',
              text: provenance,
              title: `Where the data came from: ${provenance}`,
            }),
      ),
      entry.note === undefined ? null : el('p', { class: 'gallery-card-line', text: entry.note, title: detail }),
      files.length === 0
        ? null
        : el(
            'details',
            { class: 'gallery-card-more' },
            el('summary', { text: `${files.length} ${files.length === 1 ? 'file' : 'files'}` }),
            el('div', { class: 'gallery-card-files' }, ...files.map((row) => this.fileRow(row))),
          ),
    )
  }

  private fileRow(entry: StoreEntry): HTMLElement {
    const format = valueOf(entry, 'format')
    return el(
      'div',
      { class: 'portal-row' },
      el(
        'span',
        { class: `portal-kind portal-kind-${entry.kind}` },
        icon(entry.kind === 'map' ? 'grid-2x2' : 'dna', { size: 12 }),
      ),
      el(
        'div',
        { class: 'portal-row-text' },
        button(entry.label, () => this.props.host.open(entry), { class: 'btn-link portal-name', title: entry.note ?? '' }),
        format === '' ? null : el('span', { class: 'portal-chip portal-chip-dim', text: format }),
      ),
      el('div', { class: 'portal-row-actions' }, ...rowActions(entry, this.props.host)),
    )
  }
}

/** The URIs of the rows a figure is made of, from its `files` field. */
function filesOf(entry: StoreEntry): string[] {
  const held = valueOf(entry, 'files')
  return held === '' ? [] : held.split('|')
}
