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
import { fetchStore, storeFromText, type StoreFile } from '../../state/store'
import { addStoreRow, readStoreRows, removeStoreRow } from '../../state/stores'
import { exampleHubText, exampleStoreText } from '../examples'
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
  /**
   * The store that landed calls itself this.
   *
   * A door is named for the errand — *A track hub*, *Your own store* — and that
   * is right until one has been read, at which point the page is about a
   * particular shelf and the heading should say which. Handed up rather than
   * written here, because the heading belongs to the drawer and this view owns
   * only its body.
   */
  onName?(label: string, blurb: string): void
  /** The reader remembered or forgot a store; the drawer redraws its tiles. */
  onChanged?(): void
  /** The catalogue landed, or was cleared; the drawer redraws its download. */
  onLoaded?(): void
}

export class CustomView {
  readonly el: HTMLElement
  private readonly urlInput: HTMLInputElement
  /** The paste box, and the base its relative names hang off. */
  private readonly textInput: HTMLTextAreaElement
  private readonly baseInput: HTMLInputElement
  private readonly statusEl = el('p', { class: 'hint portal-status hidden' })
  private readonly keepSlot = el('span', { class: 'custom-keep' })
  private readonly body = el('div', { class: 'custom-body' })
  private portal: PortalView | null = null
  private pending = 0
  private destroyed = false

  constructor(private readonly props: CustomViewProps) {
    const hub = props.front.kind === 'hub'
    this.urlInput = el('input', {
      class: 'input custom-url',
      type: 'url',
      placeholder: hub
        ? 'https://lab.example.org/myHub/hub.txt'
        : 'https://lab.example.org/store.json',
      attrs: { 'aria-label': hub ? 'the URL of a hub.txt' : 'the URL of a store file' },
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.loadTyped()
    })

    // The other way in: the text itself. A host that will not allow a
    // cross-origin GET — `genome.ucsc.edu` among them — cannot be read by any
    // browser-only viewer, and a lab writing its own shelf wants to edit and
    // re-read without publishing between each try (`state/store.ts`).
    this.textInput = el('textarea', {
      class: 'input custom-text',
      attrs: {
        rows: '10',
        spellcheck: 'false',
        'aria-label': hub ? 'the text of a hub' : 'the text of a store file',
        placeholder: hub
          ? 'hub myHub\nshortLabel My hub\n\ngenome hg38\n\ntrack signal\nbigDataUrl https://…/signal.bw\ntype bigWig'
          : '{ "kind": "metacooler.store", "name": "My shelf", "entries": [ … ] }',
      },
    }) as HTMLTextAreaElement
    this.baseInput = el('input', {
      class: 'input custom-base',
      type: 'url',
      placeholder: 'https://lab.example.org/data/  (only if the names above are relative)',
      attrs: { 'aria-label': 'the base URL relative names hang off' },
    })
    const remembered = props.front.rows?.url
    const head =
      remembered === undefined
        ? el(
            'div',
            { class: 'custom-form' },
            el('p', {
              class: 'hint',
              text: hub
                ? 'A UCSC track hub: the hub.txt that names a genomes.txt and a trackDb per assembly. Its genomes and every track this viewer can draw become a shelf you can narrow, open and remember. An assembly hub opens its own .2bit as the sequence, with its tracks on the shelf beside it.'
                : 'A store is one JSON file a lab publishes beside its data — its maps, genomes and saved sessions, with columns to narrow on. Nothing is fetched until you press open.',
            }),
            el(
              'div',
              { class: 'custom-row' },
              this.urlInput,
              button('open', () => void this.loadTyped(), {
                class: 'btn btn-primary',
                title: hub ? 'Read the hub at this URL.' : 'Read the store at this URL.',
              }),
            ),
            // Folded, because a URL is the ordinary way in and a box of text is
            // the answer to a problem most readers will not have.
            el(
              'details',
              { class: 'custom-paste' },
              el('summary', { text: hub ? 'or paste the hub' : 'or paste the store' }),
              el('p', {
                class: 'hint',
                text: hub
                  ? 'Paste the whole hub: a one-file hub, or the hub.txt, genomes.txt and trackDb.txt one after another — concatenated, they are the same file. Use this when the host will not allow a cross-origin GET (genome.ucsc.edu does not), or while you are still writing one.'
                  : 'Paste the store’s JSON. Use this when the host will not allow a cross-origin GET, or while you are still writing one.',
              }),
              this.textInput,
              el('div', { class: 'custom-row' }, this.baseInput),
              el(
                'div',
                { class: 'custom-row' },
                button('open what is pasted', () => void this.loadPasted(), {
                  class: 'btn btn-primary',
                  title: hub ? 'Read this text as a hub.' : 'Read this text as a store.',
                }),
                // A worked example, and one that **opens**: it names the
                // published demo files, so the first press draws a shelf and the
                // reader's first edit is to something that already worked rather
                // than to a template whose state they cannot tell
                // (`ui/examples.ts`).
                button('fill in an example', () => this.fillExample(), {
                  class: 'btn custom-example',
                  title: hub
                    ? 'Put a small working hub in the box, over the demo data. Press open, then edit it into your own.'
                    : 'Put a small working store in the box, over the demo data. Press open, then edit it into your own.',
                }),
              ),
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

  /**
   * Put a worked example in the box.
   *
   * It **replaces** what is there, and asks first when that is not empty: the
   * box is where somebody's half-written hub lives, and the one thing this
   * button must not be is a way to lose it to a misclick. The base is cleared
   * with it, because the example's own URLs are absolute and a base left over
   * from a previous paste would resolve nothing and confuse the next refusal.
   */
  private fillExample(): void {
    const hub = this.props.front.kind === 'hub'
    if (
      this.textInput.value.trim() !== '' &&
      !window.confirm('Replace what is in the box with the example?')
    ) {
      return
    }
    this.textInput.value = hub ? exampleHubText() : exampleStoreText()
    this.baseInput.value = ''
    this.say(
      hub
        ? 'An example hub over the demo data. Press open, then edit it into your own.'
        : 'An example store over the demo data. Press open, then edit it into your own.',
      false,
    )
    this.textInput.focus()
    // The **top**, and both of these are needed: the caret goes there on its
    // own, the scroll does not, and a box that lands showing its last five
    // lines has hidden the two comment lines that say what the reader is
    // looking at and where `twoBitPath` would go.
    this.textInput.setSelectionRange(0, 0)
    this.textInput.scrollTop = 0
  }

  /**
   * Read what is in the paste box.
   *
   * No URL to remember afterwards and none to put in the address bar: a pasted
   * shelf exists in this tab and nowhere else, which is why `onTarget` is not
   * called and *remember this store* is not offered. A store worth keeping is a
   * store with an address, and the honest way to get one is to publish the file.
   */
  private async loadPasted(): Promise<void> {
    const token = ++this.pending
    this.portal?.destroy()
    this.portal = null
    this.props.onLoaded?.()
    this.body.replaceChildren()
    this.keepSlot.replaceChildren()
    this.say('Reading what you pasted…', false)
    const result = await storeFromText(this.textInput.value, canonicalUrl(this.baseInput.value.trim()))
    if (token !== this.pending || this.destroyed) return
    if (!result.ok) {
      this.say(
        result.reason === 'refused' && result.message === ''
          ? storeFailure(result, { id: 'pasted', label: 'what you pasted', builtin: false })
          : result.message,
        true,
      )
      return
    }
    this.say('', false)
    this.show(result.store, '')
  }

  /** Whatever the portal inside is holding — this view reads, it does not keep. */
  fileNow(): StoreFile | null {
    return this.portal?.fileNow() ?? null
  }

  private async load(url: string): Promise<void> {
    const token = ++this.pending
    this.portal?.destroy()
    this.portal = null
    this.props.onLoaded?.()
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
      ...(this.props.onLoaded === undefined ? {} : { onLoaded: this.props.onLoaded }),
      file,
    })
    this.body.replaceChildren(this.portal.el)
    // A pasted shelf has no address, so there is nothing to put in the address
    // bar and nothing to remember: both of those are a URL, and the one this
    // was read from is the box above.
    if (url !== '') {
      this.props.onTarget?.(url)
      this.offerRemember(file, url)
    }
    this.props.onName?.(front.label, file.description ?? (url === '' ? 'read from pasted text' : url))
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
