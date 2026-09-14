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
import { icon } from '../icons'
import { withNewMark } from '../rowVerbs'
import { valueOf } from '../../state/facets'
import type { StoreEntry } from '../../state/store'
import { rowActions, type StoreHost } from './host'
import type { StoreFront } from './registry'

export interface GalleryViewProps {
  front: StoreFront
  host: StoreHost
}

export class GalleryView {
  readonly el: HTMLElement

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
    if (figures.length > 0) {
      this.el.appendChild(
        el(
          'section',
          { class: 'gallery-section' },
          el('h3', { class: 'gallery-heading', text: 'Figures' }),
          el('p', {
            class: 'hint',
            text: 'Each one is a saved session: a window over the lab’s data with its tracks placed, read over the network exactly as a file on your own bucket would be.',
          }),
          el('div', { class: 'gallery-cards' }, ...figures.map((entry) => this.card(entry))),
        ),
      )
    }
    if (files.length > 0) this.el.appendChild(this.files(files))
  }

  destroy(): void {
    /* nothing subscribed */
  }

  private card(entry: StoreEntry): HTMLElement {
    const assembly = valueOf(entry, 'assembly')
    const provenance = valueOf(entry, 'provenance')
    const detail = valueOf(entry, 'detail')
    return el(
      'article',
      { class: 'gallery-card' },
      el(
        'div',
        { class: 'gallery-card-chips' },
        assembly === '' ? null : el('span', { class: 'portal-chip', text: assembly }),
        provenance === '' ? null : el('span', { class: 'portal-chip portal-chip-dim', text: provenance, title: 'Where the data came from' }),
      ),
      el('h4', { class: 'gallery-card-title', text: entry.label }),
      entry.note === undefined ? null : el('p', { class: 'gallery-card-line', text: entry.note }),
      detail === ''
        ? null
        : el(
            'details',
            { class: 'gallery-card-more' },
            el('summary', { text: 'what is on screen' }),
            el('p', { class: 'hint', text: detail }),
          ),
      el(
        'div',
        { class: 'gallery-card-actions' },
        withNewMark(
          button('open', () => this.props.host.open(entry), {
            class: 'btn btn-primary',
            title: `Open ${entry.label} as its own tab, with every track it names.`,
          }),
        ),
      ),
    )
  }

  private files(files: readonly StoreEntry[]): HTMLElement {
    // Grouped by the folder they are published in, which for a gallery is
    // the dataset: the yeast files together, the mock community's together.
    const groups = new Map<string, StoreEntry[]>()
    for (const entry of files) {
      const key = valueOf(entry, 'dataset') || valueOf(entry, 'assembly')
      const held = groups.get(key)
      if (held === undefined) groups.set(key, [entry])
      else held.push(entry)
    }
    return el(
      'section',
      { class: 'gallery-section' },
      el('h3', { class: 'gallery-heading', text: 'Files' }),
      el('p', {
        class: 'hint',
        text: 'The data the figures are made of, one file at a time: a map opens as a map, anything else as a track on what is open.',
      }),
      ...[...groups].map(([key, entries]) =>
        el(
          'div',
          { class: 'gallery-files' },
          key === '' ? null : el('div', { class: 'portal-group' }, el('span', { class: 'portal-group-key', text: key })),
          ...entries.map((entry) => this.fileRow(entry)),
        ),
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
