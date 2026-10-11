/**
 * The store drawer: a store, as a page of its own, down the left of the window.
 *
 * The same kind of panel the Analysis drawer and the console are (§18.1, §23),
 * and for the same reason: a store is a place to *work* — narrow a catalogue,
 * tick four files, open them beside the map — and a modal would take the
 * keyboard and dismiss on a stray click, which is exactly wrong for a reader
 * comparing what a portal has against what they have open. So it floats over
 * the body with a shadow to say so, is dragged by the edge that faces the map,
 * Escape puts it down, and every shortcut keeps working behind it.
 *
 * **Down the left**, because that is where files come from: the Files column
 * is there, the header's three doors to a file are there, and the Analysis
 * drawer already has the right. **One per window** rather than one per tab,
 * on the Files column's argument (§20.4): a store is not a fact about the file
 * in front, and switching tabs should not lose the catalogue somebody was half
 * way through narrowing. What a row opens goes to the tab in front, or to a new
 * one — `ui/stores/host.ts` says which, and why a row never destroys a tab.
 *
 * ## The view is in the address bar
 *
 * `?store=encode&assay=ChIP-seq&view=matrix` is what the drawer writes as the
 * reader narrows (§24.2), replacing rather than pushing so the Back button
 * still walks the map's own history; closing the drawer takes it out again. A
 * reload with the store in the address reopens the drawer where it was, and
 * *copy link* hands the same address to a colleague. The hash is untouched
 * throughout — it belongs to the tab's view state (§5.5) — and `App.writeHash`
 * carries the query along when it writes the hash, so the two never fight.
 *
 * ## Nothing is fetched until a store is opened
 *
 * The tiles are descriptions (`ui/stores/registry.ts`). Opening one is the
 * gesture that reads its files, and a `?store=` in a link is a gesture arriving
 * from outside — somebody clicked a URL naming this store.
 */

import { el } from './dom'
import { icon, iconButton } from './icons'
import { resizeHandle } from './resizeHandle'
import { copyTextToClipboard } from './export'
import { messageToast } from './toast'
import { KEYS, withKey } from './commands'
import { EMPTY_VIEW, writeStoreView, type StoreView } from '../state/facets'
import { subscribeStores } from '../state/stores'
import { looksLikeHubUrl } from '../state/hub'
import { CustomView } from './stores/CustomView'
import { GalleryView } from './stores/GalleryView'
import { GenomesView } from './stores/GenomesView'
import { PortalView } from './stores/PortalView'
import { storeMark } from './stores/marks'
import { customStore, frontById, storeFronts, type StoreFront } from './stores/registry'
import { storeTiles } from './stores/tiles'
import { downloadBlob } from './export'
import type { StoreFile } from '../state/store'
import type { StoreHost } from './stores/host'

/**
 * Where the dragged width and the last store are kept.
 *
 * `localStorage`, on the reasoning the Analysis drawer gives for its width:
 * how wide a reader likes this drawer, and which store they were last in, are
 * preferences about this window rather than a train of thought about a file.
 * Whether it is *open* is not kept — the address bar carries that, which is
 * what makes a reload land where the reader was without a drawer opening over
 * every fresh visit.
 */
const WIDTH_KEY = 'chromosomix:store-drawer:width'
const LAST_KEY = 'chromosomix:store-drawer:last'

/** Below this the rail and the rows do not both fit. */
const MIN_WIDTH = 440
const DEFAULT_FRACTION = 0.64
/** Not 1: a sliver of the map showing is what says this is a drawer. */
const MAX_FRACTION = 0.95

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeStoredWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(WIDTH_KEY)
    else window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)))
  } catch {
    /* a browser that refuses storage still resizes correctly for this session */
  }
}

function readLast(): string | null {
  try {
    return window.localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

function writeLast(id: string): void {
  try {
    window.localStorage.setItem(LAST_KEY, id)
  } catch {
    /* as above */
  }
}

/** A control whose Escape means "leave this field", which outranks the drawer's. */
/**
 * Whether this id is one of the two **doors** rather than a store.
 *
 * A door is a URL box with nothing behind it until something is typed, so it is
 * never what *last store* should reopen — and it is the one front whose typed
 * URL is worth keeping when the drawer is closed, since there is no `rows` to
 * find it again from.
 */
function isDoor(id: string): boolean {
  return id === 'custom' || id === 'hub'
}

function takesEscape(node: HTMLElement): boolean {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true
  if (!(node instanceof HTMLInputElement)) return node.isContentEditable
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(node.type)
}

/**
 * What the downloaded catalogue is called.
 *
 * A built-in is its own id, which is the name its generator writes and the name
 * the site serves. A store read from a URL keeps that URL's file name where it
 * has one, so a reader who downloads what they typed gets back something they
 * recognise, and falls back to the catalogue's own name.
 */
function storeFileName(front: StoreFront, target: string): string {
  if (front.builtin) return `${front.id}.json`
  const last = (target.split(/[?#]/)[0].split('/').pop() ?? '').trim()
  if (last.toLowerCase().endsWith('.json')) return last
  const slug = front.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug === '' ? 'store' : slug}.json`
}

/** A page drawn in the drawer's body. */
interface StorePage {
  el: HTMLElement
  destroy(): void
  /**
   * The catalogue this page is showing, once it has one.
   *
   * Every front has a file behind it and not one of them was reachable: a
   * built-in's URL is never shown (RSG has no URL at all, shipping inline), and
   * *copy link* copies a `?store=` link carrying an id rather than the JSON. So
   * the one way to read what a store actually says was to guess the address.
   * This is what the head's download hands over.
   */
  fileNow(): StoreFile | null
}

export interface StoreDrawerOptions {
  host: StoreHost
  /** The drawer opened, closed or was resized, so the shell can tell the mounted view. */
  onLayout?(): void
}

export class StoreDrawer {
  readonly el: HTMLElement
  /** The header button. */
  readonly toggle: HTMLButtonElement

  private readonly markSlot = el('span', { class: 'store-head-mark' })
  private readonly downloadSlot = el('span', { class: 'store-head-actions' })
  private readonly titleEl = el('h2', { class: 'store-title' })
  private readonly blurbEl = el('p', { class: 'store-blurb' })
  private readonly tilesSlot = el('div', { class: 'store-head-tiles' })
  private readonly body = el('div', { class: 'store-body' })
  private readonly unsubscribe: () => void

  private current: {
    front: StoreFront
    view: StoreView
    /** What `?store=` says: a shipped id, or a URL. */
    target: string
    page: StorePage
  } | null = null
  /** The facet keys the last write put in the address, to clear on the next. */
  private written = new Set<string>()
  /**
   * Where each store was left, so reopening it lands there.
   *
   * A reader who narrowed ENCODE to CTCF on GRCh38, opened one file and comes
   * back for another should not find the rail unticked: the page is torn down
   * with the drawer, but its view is kept for the window's life, and the next
   * `open` of that store rebuilds from it. A view arriving with a link wins.
   */
  private readonly left = new Map<string, { view: StoreView; url?: string }>()
  private width: number | null = readStoredWidth()
  /** The front last opened in this drawer, custom included — see {@link open}. */
  private lastOpened: string | null = null

  constructor(private readonly options: StoreDrawerOptions) {
    this.toggle = el('button', {
      class: 'btn btn-icon',
      type: 'button',
      attrs: { 'aria-label': 'stores' },
    })
    this.toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()))
    this.paintToggle()

    this.el = el(
      'div',
      {
        class: 'store-drawer collapsed',
        attrs: { role: 'region', 'aria-label': 'stores' },
      },
      el(
        'div',
        { class: 'store-head' },
        // The row of stores first, and the store it is *on* under it. The two
        // were the other way round, and the head then opened with a name and a
        // sentence about the store already chosen — which is the one thing a
        // reader in this drawer already knows. What they came to the head for
        // is the row: it is how the drawer switches. The two buttons stay up
        // here with it, because a close is looked for at the top right corner
        // of a panel and nowhere else.
        el(
          'div',
          { class: 'store-head-row' },
          this.tilesSlot,
          iconButton(
            'link',
            'Copy a link to this store, narrowed as it is now.',
            () => void this.copyLink(),
            { class: 'btn btn-icon store-link', size: 14 },
          ),
          iconButton('x', 'Close the drawer. Nothing is lost.', () => this.close(), {
            class: 'btn-close',
            size: 14,
          }),
        ),
        el(
          'div',
          { class: 'store-head-current' },
          this.markSlot,
          el('div', { class: 'store-head-text' }, this.titleEl, this.blurbEl),
          this.downloadSlot,
        ),
      ),
      this.body,
      this.handle(),
    )

    this.unsubscribe = subscribeStores(() => this.paintTiles())
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onResize)
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  /** The store on screen, for whoever asks. */
  get storeId(): string | null {
    return this.current?.front.id ?? null
  }

  /**
   * Open a store — this one, the last one, or the first.
   *
   * Re-opening the store already on screen keeps its page: a reader who
   * presses the tile of the store they are in should not lose the facets they
   * ticked. A different view for the same store rebuilds it, which is what a
   * link arriving does.
   */
  open(id?: string, view?: StoreView, url?: string): void {
    // The store this drawer was last in wins over the one the browser
    // remembers across reloads: a reader who arrived on a store by URL and put
    // the drawer down expects the same store back, and its URL is still in
    // `left` for as long as this page lives — which is exactly as long as the
    // remembered id is worth anything.
    const wanted = id ?? this.lastOpened ?? readLast() ?? 'rsg'
    const front = frontById(wanted) ?? frontById('rsg')
    if (front === null) return
    if (this.current !== null && this.current.front.id === front.id && view === undefined && url === undefined) {
      this.paintTiles()
      return
    }
    this.current?.page.destroy()
    const kept = this.left.get(front.id)
    const initial = view ?? kept?.view ?? EMPTY_VIEW
    const page = this.build(front, initial, url ?? kept?.url)
    this.current = {
      front,
      view: initial,
      target: url ?? (front.builtin ? front.id : (front.rows?.url ?? front.id)),
      page,
    }
    this.lastOpened = front.id
    if (!isDoor(front.id)) writeLast(front.id)
    this.markSlot.replaceChildren(storeMark(front.mark, 30))
    this.titleEl.textContent = front.label
    this.blurbEl.textContent = front.blurb
    this.body.replaceChildren(page.el)
    this.paintDownload()
    this.body.scrollTop = 0
    this.el.classList.remove('collapsed')
    this.paintWidth()
    this.paintTiles()
    this.paintToggle()
    this.writeQuery()
    this.options.onLayout?.()
  }

  /**
   * Land on what a `?store=` link named: a shipped id, or a URL to read.
   *
   * A URL opens the *add* tile with the box filled and the store read, which is
   * where a reader who pastes one by hand ends up too — one road, arrived at
   * from outside.
   */
  openLink(target: string, view: StoreView): void {
    if (/^https?:\/\//i.test(target)) {
      // A hub link lands on the hub door rather than the store one. Both read
      // the same URL through the same `fetchStore` and arrive at the same
      // portal, so this changes nothing about what is shown — what it changes
      // is which tile is lit and which sentence is over the box, and a reader
      // who followed somebody's hub link should find the word *hub* where they
      // landed.
      this.open(looksLikeHubUrl(target) ? 'hub' : 'custom', view, target)
      return
    }
    if (frontById(target) !== null) this.open(target, view)
  }

  close(): void {
    if (this.current === null) return
    const { front, view, target } = this.current
    this.left.set(front.id, {
      view,
      ...(isDoor(front.id) && /^https?:\/\//i.test(target) ? { url: target } : {}),
    })
    this.current.page.destroy()
    this.current = null
    this.body.replaceChildren()
    this.el.classList.add('collapsed')
    this.paintToggle()
    this.writeQuery()
    this.options.onLayout?.()
  }

  /** The window or a column moved, so the width's ceiling has. */
  relayout(): void {
    if (this.current !== null) this.paintWidth()
  }

  destroy(): void {
    this.unsubscribe()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onResize)
    this.current?.page.destroy()
    this.el.remove()
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  private build(front: StoreFront, view: StoreView, url?: string): StorePage {
    const host = this.options.host
    const onView = (next: StoreView): void => {
      if (this.current === null || this.current.front.id !== front.id) return
      this.current.view = next
      this.writeQuery()
    }
    switch (front.kind) {
      case 'gallery':
        return new GalleryView({ front, host })
      case 'genomes':
        return new GenomesView({ front, host, onLoaded: () => this.paintDownload() })
      case 'portal':
        return new PortalView({ front, host, view, onView, onLoaded: () => this.paintDownload() })
      // One view for both doors. What differs between them is the sentence over
      // the box (`CustomView` reads `front.kind` for it) and nothing else: a
      // hub read from either lands in the same portal, and is remembered and
      // forgotten by the same two links.
      case 'custom':
      case 'hub':
        return new CustomView({
          front,
          host,
          view,
          onView,
          ...(url === undefined ? {} : { url }),
          onTarget: (loaded) => {
            if (this.current !== null && this.current.front.id === front.id) {
              this.current.target = loaded
              this.writeQuery()
            }
          },
          onName: (label, blurb) => {
            // Only while this front is the one in front: a read that lands
            // after the reader has moved on must not rename the store they
            // moved to.
            if (this.current === null || this.current.front.id !== front.id) return
            this.titleEl.textContent = label
            this.blurbEl.textContent = blurb
          },
          onChanged: () => this.paintTiles(),
          onLoaded: () => this.paintDownload(),
        })
    }
  }

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------

  /**
   * The two buttons on the store's own line: where it came from, and the file.
   *
   * The **home** link is drawn whenever the front declares one, read or not —
   * it is a fact about the store rather than about this reading of it, and a
   * reader whose catalogue failed to load is exactly the one who wants the
   * site it came from. It sits before the download because it is the older
   * question: *whose is this* comes before *give me a copy*.
   *
   * The **download** is absent rather than disabled while a store is still
   * being read or could not be (§8.5): a greyed button on a catalogue that
   * failed to load says the file exists and this build will not give it to you,
   * which is the one reading that is false.
   */
  private paintDownload(): void {
    this.downloadSlot.replaceChildren()
    const current = this.current
    if (current === null) return
    const home = current.front.home
    if (home !== undefined) {
      this.downloadSlot.appendChild(
        // An `<a>` and not a button that calls `window.open`: what this is *is*
        // a link, so it gets the middle-click, the copy-link-address and the
        // status bar that a reader expects of one — and `noopener` because the
        // page it opens is somebody else's.
        el(
          'a',
          {
            class: 'btn btn-icon store-home',
            attrs: {
              href: home,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: `${current.front.label} on the web — opens in a new tab.`,
              'aria-label': `${current.front.label} on the web`,
            },
          },
          icon('arrow-up-right', { size: 14 }),
        ),
      )
    }
    if (current.page.fileNow() === null) return
    this.downloadSlot.appendChild(
      iconButton(
        'download',
        `Download ${storeFileName(current.front, current.target)} — this catalogue as the drawer ` +
          'has it, which is every row before your filters, with its addresses resolved.',
        () => this.downloadStore(),
        { class: 'btn btn-icon', size: 14 },
      ),
    )
  }

  /**
   * Write the catalogue out.
   *
   * What is written is the file *as loaded* and not a copy of the bytes on the
   * host: shards are merged into the one file the reader is looking at, and
   * every `uri` is absolute, so what lands opens on its own — which a shard
   * with a relative `base` would not. RSG has no bytes on a host to copy.
   */
  private downloadStore(): void {
    const current = this.current
    const file = current?.page.fileNow() ?? null
    if (current === null || file === null) return
    void downloadBlob(
      new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }),
      storeFileName(current.front, current.target),
    )
  }

  private paintTiles(): void {
    this.tilesSlot.replaceChildren(
      storeTiles({
        fronts: storeFronts(),
        size: 'small',
        current: this.current?.front.id ?? null,
        onPick: (id) => this.open(id === 'custom' ? customStore().id : id),
      }),
    )
  }

  private paintToggle(): void {
    this.toggle.replaceChildren(icon('library'))
    // **No list of names.** It named four — the lab's data, IGV's genomes, 4DN,
    // ENCODE — while seven shipped, and a list kept anywhere but the registry
    // (`ui/stores/registry.ts`) goes stale with the next store added. The
    // drawer's own row of tiles names every one of them.
    this.toggle.title = withKey(
      `${this.isOpen ? 'Close' : 'Open'} the stores — every data store this viewer ships with, and any you connected`,
      KEYS.stores,
    )
    this.toggle.setAttribute('aria-expanded', String(this.isOpen))
  }

  /**
   * Escape puts the drawer down, on the Analysis drawer's terms and for its
   * reasons: the bubble phase, never an event something else handled, and a
   * caret in one of the drawer's own boxes keeps the key.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (this.current === null) return
    const active = document.activeElement
    if (active instanceof HTMLElement && this.el.contains(active) && takesEscape(active)) return
    event.preventDefault()
    this.close()
  }

  private readonly onResize = (): void => this.relayout()

  // -------------------------------------------------------------------------
  // The address bar
  // -------------------------------------------------------------------------

  /** This store, narrowed as it is, as an address somebody else can open. */
  private linkUrl(): string {
    const params = new URLSearchParams(window.location.search)
    // A link to a store is a link to the store: the page's own mounting
    // parameters stay, the tab's view state does not.
    if (this.current === null) {
      params.delete('store')
      writeStoreView(params, EMPTY_VIEW, this.written)
    } else {
      params.set('store', this.current.target)
      writeStoreView(params, this.current.view, this.written)
    }
    const search = params.toString()
    return `${window.location.origin}${window.location.pathname}${search === '' ? '' : `?${search}`}`
  }

  private async copyLink(): Promise<void> {
    try {
      await copyTextToClipboard(this.linkUrl())
      messageToast('Link copied. It opens this store, narrowed as it is now.')
    } catch (err) {
      messageToast(`The link could not be copied: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Mirror the store and its view into the query string, replacing in place.
   *
   * Only the keys this drawer wrote are cleared on the way (`written`), so a
   * parameter somebody else's deployment put in the address survives a store
   * being opened and closed under it.
   */
  private writeQuery(): void {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (this.current === null) {
      params.delete('store')
      writeStoreView(params, EMPTY_VIEW, this.written)
      this.written = new Set()
    } else {
      params.set('store', this.current.target)
      writeStoreView(params, this.current.view, this.written)
      this.written = new Set(this.current.view.facets.keys())
    }
    const search = params.toString()
    const url = `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`
    const now = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (url === now) return
    window.history.replaceState(null, '', url)
  }

  // -------------------------------------------------------------------------
  // Width
  // -------------------------------------------------------------------------

  private handle(): HTMLElement {
    return resizeHandle({
      // A left-sider: the handle is on its right edge, so rightward is wider.
      side: 'left',
      what: 'store drawer',
      width: () => this.widthNow(),
      resize: (px) => {
        this.width = px
        this.paintWidth()
      },
      commit: () => writeStoredWidth(this.widthNow()),
      reset: () => {
        this.width = null
        writeStoredWidth(null)
        this.paintWidth()
      },
    })
  }

  /** The body the drawer is laid over, which is what the fractions are of. */
  private bodyWidth(): number {
    const host = this.el.closest('.app-body') ?? this.el.parentElement
    const width = host?.getBoundingClientRect().width ?? 0
    return width > 0 ? width : window.innerWidth
  }

  private widthNow(): number {
    const body = this.bodyWidth()
    const max = Math.round(body * MAX_FRACTION)
    const floor = Math.min(MIN_WIDTH, max)
    return Math.max(floor, Math.min(max, this.width ?? Math.round(body * DEFAULT_FRACTION)))
  }

  private paintWidth(): void {
    this.el.style.width = `${this.widthNow()}px`
  }
}
