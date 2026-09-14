/**
 * A store the reader connected by URL — or is about to.
 *
 * Two shapes of the same page. The **add** tile has no store yet: a box for a
 * URL, and once one has been read, the same portal view every catalogue gets
 * plus the offer to remember it. A **remembered** store has its URL already and
 * opens straight into the portal view, with the URL on its heading and the way
 * to forget it beside — the other half of remembering, so that *forget
 * everything* under About is not the only way to drop one lab's shelf.
 *
 * Remembering is written straight to storage (`state/stores.ts`) rather than
 * handed up: it is a fact about this browser, exactly as a bucket entry is,
 * and the drawer hears the change back through the subscription and puts the
 * new tile in its row.
 */

import { button, el } from '../dom'
import { canonicalUrl } from '../../sources/rewrite'
import { fetchStore, type StoreFile } from '../../state/store'
import { addStoreRow, readStoreRows, removeStoreRow } from '../../state/stores'
import type { StoreView } from '../../state/facets'
import { PortalView, storeFailure } from './PortalView'
import type { StoreHost } from './host'
import type { StoreFront } from './registry'

export interface CustomViewProps {
  front: StoreFront
  host: StoreHost
  view: StoreView
  onView(view: StoreView): void
  /** A URL to read on arrival — what `?store=<url>` names. */
  url?: string
  /** A store was read from this URL, which is what the address bar should now name. */
  onTarget?(url: string): void
  /** The reader remembered or forgot a store; the drawer redraws its tiles. */
  onChanged?(): void
}

export class CustomView {
  readonly el: HTMLElement
  private readonly urlInput: HTMLInputElement
  private readonly statusEl = el('p', { class: 'hint portal-status hidden' })
  private readonly keepSlot = el('span', { class: 'custom-keep' })
  private readonly body = el('div', { class: 'custom-body' })
  private portal: PortalView | null = null
  private pending = 0
  private destroyed = false

  constructor(private readonly props: CustomViewProps) {
    this.urlInput = el('input', {
      class: 'input custom-url',
      type: 'url',
      placeholder: 'https://lab.example.org/store.json',
      attrs: { 'aria-label': 'the URL of a store file' },
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.loadTyped()
    })
    const remembered = props.front.rows?.url
    const head =
      remembered === undefined
        ? el(
            'div',
            { class: 'custom-form' },
            el('p', {
              class: 'hint',
              text:
                'A store is one JSON file a lab publishes beside its data — its maps, genomes and saved sessions, with columns to narrow on. Nothing is fetched until you press open.',
            }),
            el(
              'div',
              { class: 'custom-row' },
              this.urlInput,
              button('open', () => void this.loadTyped(), {
                class: 'btn btn-primary',
                title: 'Read the store at this URL.',
              }),
            ),
          )
        : el(
            'div',
            { class: 'custom-form' },
            el('span', { class: 'custom-address', text: remembered }),
            button('forget this store', () => this.forget(), {
              class: 'btn-link',
              title: 'Take it out of the row in this browser. Nothing on the host changes.',
            }),
          )
    this.el = el('div', { class: 'custom' }, head, this.statusEl, this.keepSlot, this.body)
    if (remembered !== undefined) void this.load(remembered)
    else if (props.url !== undefined) {
      this.urlInput.value = props.url
      void this.load(props.url)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.pending++
    this.portal?.destroy()
  }

  private async loadTyped(): Promise<void> {
    // Canonicalised so a `gs://` or `s3://` shelf is the https URL it stands
    // for before the scheme is judged (§24.5).
    const url = canonicalUrl(this.urlInput.value.trim())
    if (url === '') return
    if (!/^https?:\/\//i.test(url)) {
      this.say(`${url} is not an http(s) URL, so there is nothing to fetch.`, true)
      return
    }
    await this.load(url)
  }

  private async load(url: string): Promise<void> {
    const token = ++this.pending
    this.portal?.destroy()
    this.portal = null
    this.body.replaceChildren()
    this.keepSlot.replaceChildren()
    this.say(`Reading ${url}…`, false)
    const result = await fetchStore(url)
    if (token !== this.pending || this.destroyed) return
    if (!result.ok) {
      this.say(storeFailure(result, { id: 'typed', label: url, url, builtin: false }), true)
      return
    }
    this.say('', false)
    this.show(result.store, url)
  }

  private show(file: StoreFile, url: string): void {
    const front: StoreFront = {
      ...this.props.front,
      label: file.name === '' ? this.props.front.label : file.name,
      rows: { id: this.props.front.id, label: file.name, url, builtin: false },
    }
    this.portal = new PortalView({
      front,
      host: this.props.host,
      view: this.props.view,
      onView: (view) => this.props.onView(view),
      file,
    })
    this.body.replaceChildren(this.portal.el)
    this.props.onTarget?.(url)
    this.offerRemember(file, url)
  }

  /** Offer to keep a store reached by URL, or to forget one already kept. */
  private offerRemember(file: StoreFile, url: string): void {
    this.keepSlot.replaceChildren()
    if (this.props.front.rows?.url !== undefined) return
    const kept = readStoreRows().find((row) => row.url === url)
    if (kept !== undefined) {
      this.keepSlot.appendChild(
        button('forget this store', () => {
          removeStoreRow(kept.id)
          this.props.onChanged?.()
          this.offerRemember(file, url)
        }, { class: 'btn-link' }),
      )
      return
    }
    this.keepSlot.appendChild(
      button('remember this store', () => {
        addStoreRow({ label: file.name === '' ? url : file.name, url })
        this.props.onChanged?.()
        this.offerRemember(file, url)
      }, {
        class: 'btn-link',
        title: 'Keep it as a tile, in this browser. The stored-data screen lists it.',
      }),
    )
  }

  private forget(): void {
    const url = this.props.front.rows?.url
    const kept = url === undefined ? undefined : readStoreRows().find((row) => row.url === url)
    if (kept !== undefined) removeStoreRow(kept.id)
    this.props.onChanged?.()
  }

  private say(text: string, bad: boolean): void {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('hidden', text === '')
    this.statusEl.classList.toggle('portal-status-error', bad)
  }
}
