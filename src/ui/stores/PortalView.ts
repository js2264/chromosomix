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
import type { ShardFacet, StoreFront } from './registry'

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
  /**
   * The catalogue this page is showing changed — read, merged across shards, or
   * lost. The drawer offers a download of it, and that offer cannot exist until
   * there is something to download.
   */
  onLoaded?(): void
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

  /** The catalogue as this page has it: merged across shards, URIs resolved. */
  fileNow(): StoreFile | null {
    return this.file
  }

  /** Hold a catalogue, and say so — see `onLoaded`. */
  private hold(file: StoreFile | null): void {
    this.file = file
    this.props.onLoaded?.()
  }
  /**
   * The shards read so far, by their id, for a front published in several.
   *
   * Kept once read: a reader who ticks *hg19* beside *GRCh38* and unticks it
   * again has not asked for the same twenty-five megabytes twice. What is on
   * screen is the union of the ticked ones, stamped with the two values that
   * chose each (`stampShard`), so the rows say which shard they came from and
   * a link carries the choice as two ordinary facets.
   */
  private readonly shardFiles = new Map<string, StoreFile>()
  /** Why a shard could not be read, by its id — shown once, not on every paint. */
  private readonly shardErrors = new Map<string, string>()
  private sessions = new Map<string, StoreEntry>()
  private sessionsRead = false
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
      this.hold(this.props.file)
      this.paint()
      return
    }

    if (front.shards !== undefined) {
      await this.loadShards(token)
      return
    }
    const ref = this.rowsRef()
    if (ref === null) {
      this.showStatus({ kind: 'error', text: 'This store names no rows to read.' })
      return
    }
    if (ref.inline !== undefined) {
      this.hold(ref.inline)
      this.paint()
      return
    }
    if (ref.url === undefined) {
      this.showStatus({ kind: 'error', text: 'This store has no address to read from.' })
      return
    }

    this.hold(null)
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
    this.hold(result.store)
    if (sessions !== null) {
      const read = await sessions
      if (token !== this.pending || this.destroyed) return
      this.sessions = read
    }
    this.showStatus({ kind: 'none' })
    this.paint()
  }

  /**
   * Read every ticked shard that is not in hand, then show the union.
   *
   * The ones already read are kept and not asked for again; the ones ticked
   * and missing are fetched together, each with its own answer, so one shard
   * the workflow has not generated yet is a sentence in the status line and
   * not a blank store. Nothing is read for a value nobody ticked (§24.2).
   */
  private async loadShards(token: number): Promise<void> {
    const front = this.props.front
    const shards = front.shards
    if (shards === undefined) return
    const wanted = this.tickedShards()
    const missing = wanted.filter((shard) => !this.shardFiles.has(shard.id) && !this.shardErrors.has(shard.id))
    if (missing.length > 0) {
      this.showStatus({
        kind: 'loading',
        text: `Reading ${front.label} — ${missing.map((shard) => shard.label).join(', ')}…`,
      })
      this.paintRail()
      const sessions =
        front.sessions === undefined || this.sessionsRead ? null : this.loadSessions(front.sessions)
      const results = await Promise.all(
        missing.map(async (shard) => ({ shard, result: await fetchStore(shard.url) })),
      )
      if (token !== this.pending || this.destroyed) return
      for (const { shard, result } of results) {
        if (result.ok) {
          this.shardFiles.set(shard.id, stampShard(result.store, shards.facets, shard.first, shard.second))
        } else {
          this.shardErrors.set(shard.id, storeFailure(result, { id: shard.id, label: shard.label, url: shard.url, builtin: front.builtin }))
        }
      }
      if (sessions !== null) {
        const read = await sessions
        if (token !== this.pending || this.destroyed) return
        this.sessions = read
        this.sessionsRead = true
      }
    }
    const read = wanted.filter((shard) => this.shardFiles.has(shard.id))
    if (read.length === 0) {
      const why = wanted.map((shard) => this.shardErrors.get(shard.id)).find((text) => text !== undefined)
      this.hold(null)
      this.showStatus({ kind: 'error', text: why ?? 'Nothing is ticked, so nothing is read.' })
      this.paintRail()
      return
    }
    this.hold(mergeShards(read.map((shard) => this.shardFiles.get(shard.id) as StoreFile)))
    const failed = wanted.filter((shard) => this.shardErrors.has(shard.id))
    this.showStatus({ kind: 'none' })
    this.paint()
    if (failed.length > 0) {
      // Under the rows rather than instead of them: what was read is shown,
      // and what was not says so once.
      this.countEl.textContent = `${this.countEl.textContent} ${failed.map((shard) => `${shard.label}: ${this.shardErrors.get(shard.id) ?? ''}`).join(' ')}`
    }
  }

  /** The shards the view asks for: one per ticked pair, the first of each facet when nothing is. */
  private tickedShards(): Array<{ id: string; label: string; url: string; first: string; second: string }> {
    const shards = this.props.front.shards
    if (shards === undefined) return []
    const [first, second] = shards.facets
    const as = tickedValues(this.view.facets, first)
    const bs = tickedValues(this.view.facets, second)
    return as.flatMap((a) =>
      bs.map((b) => ({
        id: `${a}-${b}`,
        label: `${first.values.find((v) => v.id === a)?.label ?? a} · ${second.values.find((v) => v.id === b)?.label ?? b}`,
        url: shards.url(a, b),
        first: a,
        second: b,
      })),
    )
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

  /** The reference the rows come from, for a front published as one file. */
  private rowsRef(): StoreRef | null {
    return this.props.front.rows ?? null
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private setView(view: StoreView): void {
    const shards = this.props.front.shards
    const shardChanged =
      shards !== undefined &&
      shards.facets.some(
        (facet) => tickedValues(view.facets, facet).join('|') !== tickedValues(this.view.facets, facet).join('|'),
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
            ticked: new Map(
              front.shards.facets.map((facet) => [facet.key, new Set(tickedValues(this.view.facets, facet))] as const),
            ),
            counts: this.shardCounts(),
            onToggle: (key, id) => this.setView({ ...this.view, facets: toggleFacet(this.view.facets, key, id) }),
          }
    const file = this.file
    this.rail.paint(
      file?.columns ?? [],
      file === null ? new Map() : facetCounts(file.entries, file.columns, this.view),
      shard,
    )
  }

  /**
   * Rows behind each shard value, over the shards read: *hg19* counts every
   * hg19 shard in hand whose other value is ticked, so the number beside a
   * genome is what ticking it alone would show. A shard not read has no
   * number, and the rail says so.
   */
  private shardCounts(): Map<string, number> {
    const out = new Map<string, number>()
    const shards = this.props.front.shards
    if (shards === undefined) return out
    const [first, second] = shards.facets
    const as = tickedValues(this.view.facets, first)
    const bs = tickedValues(this.view.facets, second)
    const rows = (a: string, b: string): number | undefined => this.shardFiles.get(`${a}-${b}`)?.entries.length
    for (const value of first.values) {
      const partners = bs.length === 0 ? [second.values[0].id] : bs
      const counts = partners.map((b) => rows(value.id, b))
      if (counts.every((count) => count !== undefined)) out.set(`${first.key}|${value.id}`, counts.reduce((sum, n) => (sum ?? 0) + (n ?? 0), 0) ?? 0)
    }
    for (const value of second.values) {
      const partners = as.length === 0 ? [first.values[0].id] : as
      const counts = partners.map((a) => rows(a, value.id))
      if (counts.every((count) => count !== undefined)) out.set(`${second.key}|${value.id}`, counts.reduce((sum, n) => (sum ?? 0) + (n ?? 0), 0) ?? 0)
    }
    return out
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

/** The values ticked under a shard facet that the front knows, in the front's order. */
function tickedValues(facets: FacetSelection, facet: ShardFacet): string[] {
  const values = facets.get(facet.key)
  if (values === undefined) return []
  return facet.values.filter((value) => values.has(value.id)).map((value) => value.id)
}

/** The view with a shard ticked wherever the link named none: the first of each. */
function withShardDefaults(front: StoreFront, view: StoreView): StoreView {
  if (front.shards === undefined) return view
  let facets = view.facets
  for (const facet of front.shards.facets) {
    if (tickedValues(facets, facet).length === 0) facets = setFacet(facets, facet.key, [facet.values[0].id])
  }
  return { ...view, facets }
}

/**
 * A shard's rows with the two values that chose it written on every one, so
 * the union of several shards still says which genome and which kind of file
 * each row is — under the shard facets' own keys, which no shard's columns
 * carry, and which the link carries as two ordinary facets.
 */
function stampShard(
  file: StoreFile,
  facets: readonly [ShardFacet, ShardFacet],
  first: string,
  second: string,
): StoreFile {
  const [a, b] = facets
  return {
    ...file,
    entries: file.entries.map((entry) => ({
      ...entry,
      fields: { ...(entry.fields ?? {}), [a.key]: first, [b.key]: second },
    })),
  }
}

/** Several shards as one store: the first's name and columns, every column any of them declares, all the rows. */
function mergeShards(files: readonly StoreFile[]): StoreFile {
  const [head] = files
  const columns = [...head.columns]
  const known = new Set(columns.map((column) => column.key))
  for (const file of files.slice(1)) {
    for (const column of file.columns) {
      if (known.has(column.key)) continue
      known.add(column.key)
      columns.push(column)
    }
  }
  return {
    ...head,
    columns,
    entries: files.flatMap((file) => file.entries),
  }
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
 * A built-in that is not there is *not generated yet* — the shipped stores are
 * written by a workflow and a fresh fork has not run it — and saying "the host
 * answered 404" would send a reader to check a URL that is perfectly correct.
 *
 * **Not there arrives in two shapes and they are one state.** A 404 is the
 * plain one; a page of HTML is the other, and it is what a dev server and every
 * SPA-fallback host answer for a file they have not got. The second used to
 * print the diagnosis — the raw URL, "did not answer with JSON", "a dev server
 * with no generated stores" — which is a sentence for whoever runs the site and
 * not for the biologist who pressed the IGV tile. So a built-in says the same
 * thing either way, and a URL the reader typed keeps its URL, because on that
 * one the address *is* what they can act on (§10).
 */
export function storeFailure(
  result: Exclude<Awaited<ReturnType<typeof fetchStore>>, { ok: true }>,
  ref: StoreRef,
): string {
  const notJson = result.reason === 'refused' && result.refusal.reason === 'not-json'
  if (ref.builtin && (result.reason === 'missing' || notJson)) {
    return (
      `${ref.label} is not generated yet; the Stores workflow publishes it. ` +
      'Run it once (Actions → Stores → Run workflow) and this fills in.'
    )
  }
  // `refusalMessage` is the *workspace* reader's wording, and for the one
  // refusal both formats share it names the wrong kind of file: a store served
  // as HTML read "is not a JSON file, so it is not a saved workspace", about a
  // thing nobody was trying to open. The other refusals it gives are about the
  // config format and cannot arise here.
  if (result.reason === 'refused') {
    const where = ref.url ?? ref.label
    return notJson
      ? `${where} answered with a page, not a store file — a sign-in wall answers like this.`
      : refusalMessage(result.refusal, where)
  }
  return result.message
}
