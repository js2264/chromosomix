/**
 * A portal store on screen: a rail of facets, a search box, and the rows that
 * survive them — as a grouped list or as a matrix — with a tray for what is
 * ticked.
 *
 * This is the front the two portals and every store a lab publishes are drawn
 * with (`ui/stores/registry.ts`). It holds the whole catalogue in memory and
 * narrows it on every keystroke without going back to the network
 * (`state/facets.ts`), which is what a static store file buys: 4DN's 25,000
 * rows are read once, on the gesture that opened the store, and every filter
 * afterwards is free. Asking a portal's own search API from the browser was
 * built and withdrawn (§24.4); the shelf *is* the search.
 *
 * ## The view is a link
 *
 * Every change — a tick, a word typed, the matrix turned on — is reported to
 * the drawer, which writes it into the query string (`?store=encode&assay=…`),
 * so a narrowed store is something a reader can send to a colleague and a
 * reload puts them back where they were. The view arrives the same way: the
 * drawer hands this class the `StoreView` the link carried.
 *
 * ## Shards
 *
 * ENCODE's rows are twelve files chosen by assembly and kind of file, and the
 * choice is two radio groups at the top of the rail, held in the view under
 * the keys `group` and `category`. Changing one fetches the shard it names;
 * everything else about the view survives the fetch, so a reader who ticked
 * *ChIP-seq* on GRCh38 and switches to hg19 keeps *ChIP-seq* ticked.
 */

import { button, el } from '../dom'
import { icon } from '../icons'
import { refusalMessage } from '../../state/SessionConfig'
import {
  EMPTY_VIEW,
  clearFacet,
  facetCounts,
  isEmptyQuery,
  pivot,
  select,
  setFacet,
  toggleFacet,
  valueOf,
  type FacetSelection,
  type StoreView,
} from '../../state/facets'
import { fetchStore, type StoreEntry, type StoreFile, type StoreRef } from '../../state/store'
import { FacetRail, type ShardChoice } from './FacetRail'
import { MatrixView } from './MatrixView'
import { ResultList, countLine } from './ResultList'
import { SelectionTray } from './SelectionTray'
import type { StoreHost } from './host'
import type { StoreFront } from './registry'

export interface PortalViewProps {
  front: StoreFront
  host: StoreHost
  /** The view to open on — what the link carried, or the default. */
  view: StoreView
  /** The view changed; the drawer writes it into the address bar. */
  onView(view: StoreView): void
  /**
   * A store already in hand, to draw instead of fetching the front's rows.
   *
   * The custom front reads a URL the reader typed and hands the result over;
   * a remembered front has a URL of its own and this is absent.
   */
  file?: StoreFile
}

/** What the main area shows while there are no rows to draw. */
type Status = { kind: 'loading'; text: string } | { kind: 'error'; text: string } | { kind: 'none' }

export class PortalView {
  readonly el: HTMLElement

  private readonly search: HTMLInputElement
  private readonly countEl = el('p', { class: 'hint portal-count' })
  private readonly listButton: HTMLButtonElement
  private readonly matrixButton: HTMLButtonElement
  private readonly rail: FacetRail
  private readonly list: ResultList
  private readonly matrix: MatrixView
  private readonly tray: SelectionTray
  private readonly main = el('div', { class: 'portal-main' })
  private readonly statusEl = el('div', { class: 'portal-status hidden' })

  private file: StoreFile | null = null
  private sessions = new Map<string, StoreEntry>()
  private view: StoreView
  private readonly selected = new Map<string, StoreEntry>()
  /** Bumped on every load, so a slow shard cannot overwrite a fast one. */
  private pending = 0
  private debounce: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(private readonly props: PortalViewProps) {
    this.view = withShardDefaults(props.front, props.view)

    this.search = el('input', {
      class: 'input portal-search',
      type: 'search',
      placeholder: 'search the names, notes and cells',
      value: this.view.text,
      attrs: { 'aria-label': 'search this store' },
    })
    this.search.addEventListener('input', () => {
      if (this.debounce !== null) clearTimeout(this.debounce)
      // A breath after the last keystroke: the narrowing is cheap, the
      // thousand rows it redraws are not, and a reader typing a word does not
      // want the list rebuilt five times on the way to the fifth letter.
      this.debounce = setTimeout(() => {
        this.debounce = null
        this.setView({ ...this.view, text: this.search.value })
      }, 120)
    })

    this.listButton = button('', () => this.setView({ ...this.view, mode: 'list' }), {
      class: 'btn btn-icon portal-mode',
      title: 'The rows, grouped by what they belong to',
    })
    this.listButton.replaceChildren(icon('list'))
    this.matrixButton = button('', () => this.setView({ ...this.view, mode: 'matrix' }), {
      class: 'btn btn-icon portal-mode',
      title: 'A matrix: two facets against each other, a count in every cell',
    })
    this.matrixButton.replaceChildren(icon('grid-3x3'))

    this.rail = new FacetRail({
      onToggle: (key, value) =>
        this.setView({ ...this.view, facets: toggleFacet(this.view.facets, key, value) }),
      onClear: (key) => this.setView({ ...this.view, facets: clearFacet(this.view.facets, key) }),
    })
    this.rail.el.addEventListener('facet-rail-repaint', () => this.paint())
    this.list = new ResultList({
      host: props.host,
      onTick: (entry, on) => this.tick([entry], on),
      onTickAll: (entries, on) => this.tick(entries, on),
    })
    this.matrix = new MatrixView({
      onCell: (rowKey, row, colKey, col) =>
        this.setView({
          ...this.view,
          mode: 'list',
          facets: setFacet(setFacet(this.view.facets, rowKey, [row]), colKey, [col]),
        }),
      onAxes: (rowKey, colKey) => this.setView({ ...this.view, axes: [rowKey, colKey] }),
    })
    this.tray = new SelectionTray({
      host: props.host,
      onClear: () => {
        this.selected.clear()
        this.paint()
      },
    })

    const clearAll = button('clear filters', () => this.setView({ ...EMPTY_VIEW, mode: this.view.mode, ...(this.view.axes === undefined ? {} : { axes: this.view.axes }), facets: shardOnly(this.props.front, this.view.facets) }), {
      class: 'btn-link portal-clear',
      title: 'Untick every facet and empty the search.',
    })

    this.el = el(
      'div',
      { class: 'portal' },
      el(
        'div',
        { class: 'portal-toolbar' },
        this.search,
        this.countEl,
        clearAll,
        el('div', { class: 'portal-modes' }, this.listButton, this.matrixButton),
      ),
      el('div', { class: 'portal-body' }, this.rail.el, el('div', { class: 'portal-content' }, this.statusEl, this.main)),
      this.tray.el,
    )

    void this.load()
  }

  destroy(): void {
    this.destroyed = true
    this.pending++
    if (this.debounce !== null) clearTimeout(this.debounce)
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /** Read the rows (and the sessions beside them), then paint. */
  private async load(): Promise<void> {
    const token = ++this.pending
    const front = this.props.front
    this.props.onView(this.view)

    if (this.props.file !== undefined) {
      this.file = this.props.file
      this.paint()
      return
    }

    const ref = this.rowsRef()
    if (ref === null) {
      this.showStatus({ kind: 'error', text: 'This store names no rows to read.' })
      return
    }
    if (ref.inline !== undefined) {
      this.file = ref.inline
      this.paint()
      return
    }
    if (ref.url === undefined) {
      this.showStatus({ kind: 'error', text: 'This store has no address to read from.' })
      return
    }

    this.file = null
    this.showStatus({ kind: 'loading', text: `Reading ${ref.label}…` })
    this.paintRail()
    // The sessions ride alongside and are not waited for: a shelf whose session
    // file is missing is still a shelf, and the group headings simply lack their
    // button.
    const sessions = front.sessions === undefined ? null : this.loadSessions(front.sessions)
    const result = await fetchStore(ref.url)
    if (token !== this.pending || this.destroyed) return
    if (!result.ok) {
      this.showStatus({ kind: 'error', text: storeFailure(result, ref) })
      return
    }
    this.file = result.store
    if (sessions !== null) {
      const read = await sessions
      if (token !== this.pending || this.destroyed) return
      this.sessions = read
    }
    this.showStatus({ kind: 'none' })
    this.paint()
  }

  /** The sessions beside the rows, keyed by group and assembly. Empty on any failure. */
  private async loadSessions(ref: StoreRef): Promise<Map<string, StoreEntry>> {
    const out = new Map<string, StoreEntry>()
    if (ref.url === undefined) return out
    const result = await fetchStore(ref.url)
    if (!result.ok) return out
    for (const entry of result.store.entries) {
      if (entry.kind !== 'workspace') continue
      const group = valueOf(entry, 'dataset')
      if (group === '') continue
      out.set(`${group}|${valueOf(entry, 'assembly')}`, entry)
    }
    return out
  }

  /** The reference the rows come from: the front's file, or the chosen shard. */
  private rowsRef(): StoreRef | null {
    const front = this.props.front
    if (front.shards !== undefined) {
      const [first, second] = front.shards.facets
      const a = chosenShard(this.view.facets, first.key)
      const b = chosenShard(this.view.facets, second.key)
      if (a === null || b === null) return null
      const label = `${front.label} — ${first.values.find((v) => v.id === a)?.label ?? a}, ${second.values.find((v) => v.id === b)?.label ?? b}`
      return { id: `${front.id}-${a}-${b}`, label, url: front.shards.url(a, b), builtin: front.builtin }
    }
    return front.rows ?? null
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private setView(view: StoreView): void {
    const shardChanged =
      this.props.front.shards !== undefined &&
      this.props.front.shards.facets.some(
        (facet) => chosenShard(view.facets, facet.key) !== chosenShard(this.view.facets, facet.key),
      )
    this.view = view
    if (this.search.value !== view.text) this.search.value = view.text
    this.props.onView(view)
    if (shardChanged) {
      void this.load()
      return
    }
    this.paint()
  }

  private tick(entries: readonly StoreEntry[], on: boolean): void {
    for (const entry of entries) {
      if (on) this.selected.set(entry.uri, entry)
      else this.selected.delete(entry.uri)
    }
    this.paint()
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  private showStatus(status: Status): void {
    this.statusEl.classList.toggle('hidden', status.kind === 'none')
    this.statusEl.classList.toggle('portal-status-error', status.kind === 'error')
    this.statusEl.textContent = status.kind === 'none' ? '' : status.text
    this.main.classList.toggle('hidden', status.kind !== 'none')
    this.countEl.textContent = ''
  }

  private paintRail(): void {
    const front = this.props.front
    const shard: ShardChoice | undefined =
      front.shards === undefined
        ? undefined
        : {
            facets: front.shards.facets,
            chosen: new Map(
              front.shards.facets.flatMap((facet) => {
                const value = chosenShard(this.view.facets, facet.key)
                return value === null ? [] : [[facet.key, value] as const]
              }),
            ),
            onChoose: (key, id) => this.setView({ ...this.view, facets: setFacet(this.view.facets, key, [id]) }),
          }
    const file = this.file
    this.rail.paint(
      file?.columns ?? [],
      file === null ? new Map() : facetCounts(file.entries, file.columns, this.view),
      shard,
    )
  }

  private paint(): void {
    this.paintRail()
    this.listButton.classList.toggle('is-on', this.view.mode === 'list')
    this.matrixButton.classList.toggle('is-on', this.view.mode === 'matrix')
    this.listButton.setAttribute('aria-pressed', String(this.view.mode === 'list'))
    this.matrixButton.setAttribute('aria-pressed', String(this.view.mode === 'matrix'))
    const file = this.file
    if (file === null) return
    this.showStatus({ kind: 'none' })

    const matching = select(file.entries, file.columns, this.view)
    this.countEl.textContent = countLine(file.entries.length, matching.length, !isEmptyQuery(this.view) || tickedBeyondShards(this.props.front, this.view.facets))

    if (this.view.mode === 'matrix' && file.columns.length >= 2) {
      const [rowKey, colKey] = this.axesOf(file)
      this.matrix.paint({
        pivot: pivot(file.entries, file.columns, this.view, rowKey, colKey),
        rowKey,
        colKey,
        columns: file.columns,
        selection: this.view.facets,
      })
      this.main.replaceChildren(this.matrix.el)
    } else {
      this.list.paint({
        entries: matching,
        columns: file.columns,
        ...(this.props.front.group === undefined ? {} : { group: this.props.front.group }),
        ...(this.props.front.headline === undefined ? {} : { headline: this.props.front.headline }),
        sessions: this.sessions,
        selected: new Set(this.selected.keys()),
      })
      this.main.replaceChildren(this.list.el)
    }
    this.tray.paint([...this.selected.values()])
  }

  /** The matrix's axes: the view's, else the front's, else the first two columns. */
  private axesOf(file: StoreFile): [string, string] {
    const keys = file.columns.map((column) => column.key)
    const wanted = this.view.axes ?? this.props.front.axes
    if (wanted !== undefined && keys.includes(wanted[0]) && keys.includes(wanted[1]) && wanted[0] !== wanted[1]) {
      return [wanted[0], wanted[1]]
    }
    return [keys[0], keys[1]]
  }
}

/** The one value chosen under a shard facet, or `null`. */
function chosenShard(facets: FacetSelection, key: string): string | null {
  const values = facets.get(key)
  if (values === undefined || values.size === 0) return null
  return [...values][0]
}

/** The view with a shard chosen wherever the link named none: the first of each. */
function withShardDefaults(front: StoreFront, view: StoreView): StoreView {
  if (front.shards === undefined) return view
  let facets = view.facets
  for (const facet of front.shards.facets) {
    const chosen = chosenShard(facets, facet.key)
    const known = chosen !== null && facet.values.some((value) => value.id === chosen)
    if (!known) facets = setFacet(facets, facet.key, [facet.values[0].id])
  }
  return { ...view, facets }
}

/** Only the shard choices out of a selection — what *clear filters* keeps. */
function shardOnly(front: StoreFront, facets: FacetSelection): FacetSelection {
  if (front.shards === undefined) return new Map()
  const out = new Map<string, ReadonlySet<string>>()
  for (const facet of front.shards.facets) {
    const held = facets.get(facet.key)
    if (held !== undefined && held.size > 0) out.set(facet.key, held)
  }
  return out
}

/** Whether anything but a shard choice is ticked. */
function tickedBeyondShards(front: StoreFront, facets: FacetSelection): boolean {
  const shardKeys = new Set(front.shards?.facets.map((facet) => facet.key) ?? [])
  for (const [key, values] of facets) {
    if (!shardKeys.has(key) && values.size > 0) return true
  }
  return false
}

/**
 * What a store that could not be read says, in the reader's terms.
 *
 * A built-in that answers 404 is *not generated yet* — the shipped stores are
 * written by a workflow and a fresh fork has not run it — and saying "the host
 * answered 404" would send a reader to check a URL that is perfectly correct.
 */
export function storeFailure(
  result: Exclude<Awaited<ReturnType<typeof fetchStore>>, { ok: true }>,
  ref: StoreRef,
): string {
  if (result.reason === 'missing' && ref.builtin) {
    return (
      `${ref.label} is not generated yet; the Stores workflow publishes it. ` +
      'Run it once (Actions → Stores → Run workflow) and this fills in.'
    )
  }
  if (result.reason === 'refused') return refusalMessage(result.refusal, ref.url ?? ref.label)
  return result.message
}
