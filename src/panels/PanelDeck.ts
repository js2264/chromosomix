/**
 * N maps on screen at once, navigating together (§16).
 *
 * The viewer already had two answers to "two files" and neither of them
 * generalises. A **tab** is a whole second session — its own worker, its own
 * tables, its own tracks, its own address bar entry — and only one is on screen
 * at a time, so it answers *open* rather than *compare*. The **lower-left
 * triangle** puts a second file in one square, which is the strongest possible
 * comparison and is why it is gated so hard: one grid, so one bin size, so one
 * chromosome list (`ui/CompareCard.ts`). Neither is HiGlass's actual
 * capability, which is several maps beside each other under one navigation, and
 * that is what this is.
 *
 * Both of the old answers survive unchanged. A deck's lead panel is still the
 * session's file and may still hold a second file in its lower triangle; the
 * deck is *beside* that, not instead of it. The two compose because they are
 * different claims: a blend says *these numbers share a grid*, and a panel says
 * *this picture is of the same place*.
 *
 * ---
 *
 * **What is shared, and what is not.** The view is shared and the presentation
 * is not. Which region, which level, which score, which balancing — all of that
 * is what is being *looked at*, and a deck showing four files at four different
 * regions is four unrelated pictures that happen to be adjacent. The colour
 * scale is per panel, and it has to be: `vmax` is a number of contacts, and two
 * libraries at different depths do not have the same one, so one clip across a
 * deck would draw the shallower file as an empty rectangle. That is the same
 * argument the two-file split settles with its "match depth" control, arrived
 * at from the other side.
 *
 * The **transform and the colormap** are seeded from the lead and then belong to
 * each panel, and "one scale for all" pushes the lead's clip down for the case
 * where the reader knows the files are comparable. Default off, because it is
 * the stronger claim.
 *
 * **The lock** is `panels/lock.ts`, whose currency is base pairs rather than
 * cells — that is what lets panels of different resolution follow each other.
 * It is a preference rather than view state: the hash has never carried a pan or
 * a zoom, so there is nothing there for a lock to be consistent with, and
 * whether a panel is off the lead is the same kind of fact as which side panel
 * is folded.
 *
 * **The three side panels** are left entirely alone, and that is deliberate.
 * They are the *session's* furniture and each describes the one file the session
 * is of — and one of them, Annotations, does not exist at all on a file with a
 * genome layer (§8.5), which is exactly the kind of file a deck is most useful
 * for. So the deck's controls ride above its own grid and each panel's colour
 * card rides inside its own panel, which is also the plainest possible statement
 * of what is shared and what is not. The grid is inside `.content`, which pins
 * the light palette for every descendant, so the maps do not change colour in
 * the dark theme without a rule being written here (`ui/styles.css`).
 */

import { deviceDenseBudgetBytes } from '../metacooler/matrix'
import { recall, remember } from '../state/UiMemory'
import type { ViewState } from '../types'
import type { SourceSpec } from '../worker/protocol'
import type { DerivePresentation, MatrixPanel } from '../ui/MatrixPanel'
import type { ScaleState } from '../ui/GenomeView'
import { button, el, fmt } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { MapPanel, VacantPanel } from './MapPanel'
import {
  DECK_LAYOUTS,
  MAX_PANELS,
  columnsFor,
  isDeckLayout,
  moveItem,
  panelBudgetBytes,
  parseMaps,
  sameRefs,
  serialiseMaps,
  type DeckLayout,
  type PanelRef,
} from './deck'
import { ViewportLock, spansAgree } from './lock'

/** The id the lock knows the session's own map by. */
const LEAD = 'lead'

export interface PanelDeckProps {
  /**
   * Rewrite the `maps` key. `replace` always: adding a panel is not a
   * navigation, and a deck built up one file at a time should leave one history
   * entry rather than five that each undo a file.
   */
  onMapsChange(maps: string | undefined): void
  /** Where the per-file preferences are remembered — the session's memory key. */
  memoryKey(): string
  /**
   * The derivation every panel of the deck draws (§7.5), or `undefined`.
   *
   * A thunk, and shared across the deck for the reason the score and the level
   * are: a deck exists to put N files' pictures of one place beside each other,
   * and one panel drawing O/E beside four drawing counts is four wrong
   * comparisons rather than a choice.
   */
  derive?(): DerivePresentation | undefined
}

/**
 * A companion, its slot, and whether it is on the lead.
 *
 * `held` is what distinguishes an open local file from the vacancy a link left:
 * a local companion has a source nothing can reconstruct from a URI, so the
 * deck holds it and writes `~` into the hash instead.
 */
interface Slot {
  /**
   * The lock's name for this panel, minted here rather than taken from the URI.
   *
   * A local companion's URI is its file name, and two files called `rep1.cool`
   * from two directories are two maps — a lock keyed on the name would drive
   * both from one report. A counter has no such coincidence.
   */
  id: string
  ref: PanelRef
  panel: MapPanel | null
  vacancy: VacantPanel | null
  /** What the reader asked for; whether it is *honoured* is {@link agrees}. */
  locked: boolean
}

let nextSlotId = 1

export class PanelDeck {
  /** The grid, parented into the session's content area. */
  readonly el: HTMLElement
  private readonly toolbar: HTMLElement
  private readonly grid: HTMLElement
  private readonly leadCell = el('div', { class: 'deck-panel is-lead' })
  private readonly addRow: HTMLElement
  private readonly urlInput: HTMLInputElement
  /** A refusal about the deck as a whole, rather than about one panel. */
  private readonly warning = el('p', { class: 'inline-error deck-warning hidden' })

  private slots: Slot[] = []
  private readonly lock = new ViewportLock()
  private lead: MatrixPanel | null = null
  private leadLocked = true
  private layout: DeckLayout = 'row'
  /** Whether the lead's clip is pushed down to every companion (§16.2). */
  private shareLook = false
  private state: ViewState | null = null
  /**
   * The `maps` value this deck last wrote, so it does not act on its own echo.
   *
   * The same shape as `App.writingHash`, and needed for the same reason plus
   * one: a **local** companion is published as `~` (§16.6), so the state that
   * comes back describes a vacancy where this deck is holding an open file.
   * Reconciling against it would destroy the panel the reader had just dropped
   * in and leave a drop rectangle in its place. Wrapped in an object rather
   * than compared against `undefined`, because "no key" is a legitimate value
   * to have published and has to be told apart from "never published".
   */
  private published: { value: string | undefined } | null = null
  private destroyed = false

  constructor(private readonly props: PanelDeckProps) {
    this.layout = this.recallLayout()
    this.shareLook = recall<boolean>(props.memoryKey(), 'deck:share-look') === true

    this.urlInput = el('input', {
      class: 'input input-tiny deck-url',
      type: 'url',
      placeholder: 'https://bucket.example.org/other.cool',
    })
    const fileInput = el('input', { class: 'hidden-input', type: 'file' })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file !== undefined) this.addLocal(file)
      fileInput.value = ''
    })
    this.addRow = el(
      'div',
      { class: 'deck-add hidden' },
      button('choose a file…', () => fileInput.click(), { class: 'btn' }),
      this.urlInput,
      button('add', () => this.addUrl(), { class: 'btn' }),
      fileInput,
    )
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.addUrl()
    })

    this.grid = el('div', { class: 'deck-grid' }, this.leadCell)
    this.toolbar = el('div', { class: 'deck-bar' })
    this.el = el('div', { class: 'deck' }, this.toolbar, this.addRow, this.warning, this.grid)
    this.paintBar()
    this.applyLayout()
  }

  // -------------------------------------------------------------------------
  // What the session drives
  // -------------------------------------------------------------------------

  /**
   * Put the mounted view inside the deck and hand back the element to mount.
   *
   * The lead's DOM is *re-parented* rather than rebuilt, which is what makes a
   * deck cost nothing on a view that would have been mounted anyway: the region
   * view, its map, its lanes and its canvas are exactly what they would have
   * been without a deck, one grid cell further in.
   */
  frame(lead: HTMLElement): HTMLElement {
    this.leadCell.replaceChildren(lead)
    return this.el
  }

  /**
   * The map the session just mounted, for the lock to drive.
   *
   * Re-registered on every mount because it is a different object on every
   * navigation — a region view builds its own panel — and a lock holding the
   * previous one would drive a canvas nobody can see.
   */
  setLead(panel: MatrixPanel | null): void {
    if (this.lead !== null && this.lead !== panel) this.lead.setViewportListener(null)
    this.lead = panel
    this.lock.leave(LEAD)
    if (panel === null) {
      // A table view has no map. The bar still repaints, because the chain on it
      // is about the lead and there is now nothing for it to hold.
      this.paintBar()
      return
    }
    this.lock.join({
      id: LEAD,
      bpPerCell: () => panel.bpPerCell(),
      cells: () => panel.cellCount(),
      locked: () => this.leadLocked,
      show: (rows, cols) => panel.showViewport(rows, cols),
    })
    panel.setViewportListener((rows, cols) => this.lock.report(LEAD, rows, cols))
    this.paintBar()
  }

  /**
   * Reconcile the companions against a view state, and hand it to them.
   *
   * The list first, so a link that names three maps has three panels before any
   * of them reads anything; then the view, which each panel resolves against
   * its own file.
   */
  apply(state: ViewState): void {
    this.state = state
    if (this.published === null || this.published.value !== state.maps) {
      const wanted = parseMaps(state.maps)
      if (!sameRefs(wanted, this.slots.map((slot) => slot.ref))) this.adopt(wanted)
      this.published = { value: state.maps }
    }
    for (const slot of this.slots) slot.panel?.apply(state)
    this.paintBar()
  }

  /** Show the add row and put the caret in it — the shell's "add a map". */
  promptAdd(): void {
    this.addRow.classList.remove('hidden')
    this.urlInput.focus()
  }

  /** `true` when there is nothing here but the lead — the deck may be put down. */
  get isEmpty(): boolean {
    return this.slots.length === 0
  }

  relayout(): void {
    for (const slot of this.slots) slot.panel?.remeasure()
  }

  destroy(): void {
    this.destroyed = true
    for (const slot of this.slots) {
      slot.panel?.destroy()
      slot.vacancy?.destroy()
    }
    this.slots = []
    this.lock.leave(LEAD)
    // The one thing here that outlives the deck. The lead's panel belongs to the
    // mounted view, so a listener left on it would go on reporting into a lock
    // nothing can reach, once per frame, for as long as that view is on screen.
    this.lead?.setViewportListener(null)
    this.lead = null
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  /**
   * Bring the held panels in line with a list of refs.
   *
   * Panels are matched by URI and **kept**, not rebuilt: a link that adds a
   * fourth map must not put down the three workers that are already open and
   * re-read their files. Everything that is not in the new list is destroyed
   * here, which is the one place a companion's worker is released other than
   * {@link destroy}.
   */
  private adopt(wanted: readonly PanelRef[]): void {
    // A *queue* per URI, not one slot per URI. The same file twice is a
    // legitimate deck — the plainest way to read one map at two colour scales —
    // and keyed one-to-one the second slot overwrote the first, so the first
    // never appeared in the reuse map, never reached the orphan loop, and kept
    // its worker, its h5wasm instance and its dense block for the life of the
    // tab with its element already dropped from the grid.
    const spare = new Map<string, Slot[]>()
    for (const slot of this.slots) {
      if (slot.ref.kind === 'vacant') continue
      const queue = spare.get(slot.ref.uri)
      if (queue === undefined) spare.set(slot.ref.uri, [slot])
      else queue.push(slot)
    }
    const reused = new Set<Slot>()
    const next: Slot[] = []
    for (const ref of wanted.slice(0, MAX_PANELS - 1)) {
      if (ref.kind !== 'vacant') {
        const existing = spare.get(ref.uri)?.shift()
        if (existing !== undefined) {
          reused.add(existing)
          next.push(existing)
          continue
        }
      }
      next.push(this.build(ref))
    }
    // Swept over what was actually held rather than over what is left in the
    // reuse map, which is what brings vacancies into the sweep: a vacancy has no
    // URI to be keyed by, so one that disappeared from the list used to be
    // dropped from `slots` with its drop rectangle still listening.
    for (const slot of this.slots) {
      if (reused.has(slot)) continue
      this.lock.leave(slot.id)
      slot.panel?.destroy()
      slot.vacancy?.destroy()
    }
    this.slots = next
    this.paintGrid()
  }

  private build(ref: PanelRef, source?: SourceSpec): Slot {
    const slot: Slot = { id: `p${nextSlotId++}`, ref, panel: null, vacancy: null, locked: true }
    if (ref.kind === 'vacant') {
      slot.vacancy = new VacantPanel({
        onOpen: (file) => this.fill(slot, file),
        onClose: () => this.remove(slot),
        onMove: (delta) => this.move(slot, delta),
      })
      return slot
    }
    slot.panel = new MapPanel({
      uri: ref.uri,
      source: source ?? { kind: 'remote', url: splitPath(ref.uri) },
      budgetBytes: () => panelBudgetBytes(this.slots.length + 1, deviceDenseBudgetBytes()),
      onSettled: () => this.settle(slot),
      onClose: () => this.remove(slot),
      onToggleLock: () => this.toggleLock(slot),
      isLocked: () => slot.locked,
      lockNote: () => this.lockNote(slot),
      derive: () => this.props.derive?.(),
      initialLook: () => {
        const look = this.leadBaseLook()
        return this.shareLook ? look : { transform: look.transform, colormap: look.colormap }
      },
      onMove: (delta) => this.move(slot, delta),
    })
    slot.panel.syncLock()
    return slot
  }

  /**
   * A companion finished a read: join it to the lock, or say why it cannot.
   *
   * The gate is `spansAgree` and it is checked against the *blocks* rather than
   * the files (`panels/lock.ts`). Two panels that resolved the same name to
   * spans of different length resolved it against different sequences, whatever
   * the name says, and a lock between them would draw one file's coordinate
   * under another's. Everything else — a different bin size above all — is
   * fine, and being fine is the whole point of panels over a blend.
   */
  private settle(slot: Slot): void {
    if (this.destroyed) return
    const map = slot.panel?.map ?? null
    if (map === null) {
      this.lock.leave(slot.id)
      slot.panel?.syncLock()
      return
    }
    if (this.shareLook) slot.panel?.applyLook(this.leadLook())
    this.lock.join({
      id: slot.id,
      bpPerCell: () => map.bpPerCell(),
      cells: () => map.cellCount(),
      locked: () => this.lockNote(slot) === null,
      show: (rows, cols) => map.showViewport(rows, cols),
    })
    map.setViewportListener((rows, cols) => this.lock.report(slot.id, rows, cols))
    slot.panel?.syncLock()
    this.lock.catchUp(slot.id)
    this.paintBar()
  }

  /**
   * Why this panel is not following the deck, or `null` when it is.
   *
   * One answer for the chain icon, the panel's own line and the lock itself, so
   * a panel that says it is following cannot be one the lock is skipping. That
   * disagreement is the only way a navigation lock can be *quietly* wrong, and
   * a reader would read the still map as data rather than as a refusal.
   */
  private lockNote(slot: Slot): string | null {
    if (!slot.locked) return 'moving on its own'
    const map = slot.panel?.map ?? null
    const lead = this.lead
    if (map === null || lead === null) return null
    const mine = map.cellCount()
    const theirs = lead.cellCount()
    const rows = spansAgree(
      { spanBp: mine.rows * map.bpPerCell(), bpPerCell: map.bpPerCell() },
      { spanBp: theirs.rows * lead.bpPerCell(), bpPerCell: lead.bpPerCell() },
    )
    const cols = spansAgree(
      { spanBp: mine.cols * map.bpPerCell(), bpPerCell: map.bpPerCell() },
      { spanBp: theirs.cols * lead.bpPerCell(), bpPerCell: lead.bpPerCell() },
    )
    if (rows && cols) return null
    return (
      'not following: this block spans ' +
      `${fmt.bp(mine.rows * map.bpPerCell())} × ${fmt.bp(mine.cols * map.bpPerCell())} where the ` +
      `first map spans ${fmt.bp(theirs.rows * lead.bpPerCell())} × ` +
      `${fmt.bp(theirs.cols * lead.bpPerCell())}. The same name resolved against different ` +
      'sequences, so one window would be two places.'
    )
  }

  private toggleLock(slot: Slot): void {
    slot.locked = !slot.locked
    slot.panel?.syncLock()
    if (slot.locked) this.lock.catchUp(slot.id)
  }

  private move(slot: Slot, delta: number): void {
    const from = this.slots.indexOf(slot)
    const to = from + delta
    if (from < 0 || to < 0 || to >= this.slots.length) return
    this.slots = moveItem(this.slots, from, to)
    this.paintGrid()
    this.publish()
  }

  private remove(slot: Slot): void {
    const index = this.slots.indexOf(slot)
    if (index < 0) return
    this.lock.leave(slot.id)
    slot.panel?.destroy()
    slot.vacancy?.destroy()
    this.slots.splice(index, 1)
    this.paintGrid()
    this.publish()
  }

  /** Turn a vacancy back into a map, in the position the link put it. */
  private fill(slot: Slot, file: File): void {
    const index = this.slots.indexOf(slot)
    if (index < 0) return
    slot.vacancy?.destroy()
    const built = this.build({ kind: 'local', uri: file.name }, { kind: 'local', file })
    this.slots[index] = built
    this.paintGrid()
    this.publish()
    if (this.state !== null) built.panel?.apply(this.state)
  }

  private addUrl(): void {
    const url = this.urlInput.value.trim()
    if (url === '') return
    this.urlInput.value = ''
    this.add({ kind: 'remote', uri: url })
  }

  private addLocal(file: File): void {
    this.add({ kind: 'local', uri: file.name }, { kind: 'local', file })
  }

  /** Open one more map beside the others. */
  add(ref: PanelRef, source?: SourceSpec): void {
    if (this.slots.length + 1 >= MAX_PANELS) {
      // In the deck's own bar, not on an error screen. A refusal to open a
      // *seventh* map is not a reason to take the six away, and every other
      // refusal a reader meets here — a name this file has not got, a block
      // this share of the budget will not lend — is already a line beside the
      // panel it is about.
      this.warn(
        `${MAX_PANELS} maps is the limit for one deck. Every panel is a worker and, for a ` +
          'whole-file view, a block held in memory — and each one added makes every panel’s ' +
          'share of this tab’s memory smaller. Close one to open another.',
      )
      return
    }
    this.warn('')
    const slot = this.build(ref, source)
    this.slots.push(slot)
    this.addRow.classList.add('hidden')
    this.paintGrid()
    this.publish()
    if (this.state !== null) slot.panel?.apply(this.state)
  }

  /**
   * Write the deck into the hash.
   *
   * A local companion becomes `~` on the way out and stays open here, so the
   * link a reader copies has a slot where their file is and the deck they are
   * looking at is untouched. See {@link serialiseMaps}.
   */
  private publish(): void {
    const value = serialiseMaps(this.slots.map((slot) => slot.ref))
    this.published = { value }
    this.paintBar()
    this.props.onMapsChange(value)
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  private paintGrid(): void {
    this.grid.replaceChildren(
      this.leadCell,
      ...this.slots.map((slot) => slot.panel?.el ?? slot.vacancy?.el ?? el('div')),
    )
    this.applyLayout()
  }

  private applyLayout(): void {
    const columns = columnsFor(this.slots.length + 1, this.layout)
    this.grid.style.setProperty('--deck-columns', String(columns))
    this.grid.classList.toggle('is-column', this.layout === 'column')
    for (const slot of this.slots) slot.panel?.remeasure()
  }

  /**
   * The bar above the grid: how many maps, how they are laid out, and the two
   * switches that are about the deck rather than about one panel.
   *
   * Repainted wholesale because it is a dozen nodes and it changes on every
   * addition; the panels below it are the expensive things and they are kept.
   */
  private paintBar(): void {
    const count = this.slots.length + 1
    const add = button('', () => this.toggleAdd(), {
      class: 'btn deck-plus',
      title: 'Open another map beside these',
    })
    add.replaceChildren(icon('plus', { size: 14 }), el('span', { text: 'add a map' }))

    const layoutButtons = DECK_LAYOUTS.map((name) => {
      const control = iconButton(
        name === 'row' ? 'columns-2' : name === 'column' ? 'rows-3' : 'grid-2x2',
        name === 'row'
          ? 'Side by side, which is how a figure compares conditions'
          : name === 'column'
            ? 'Stacked, for a narrow window'
            : 'A near-square grid, which is what keeps four maps large enough to read',
        () => this.setLayout(name),
        { class: `btn btn-icon deck-layout${this.layout === name ? ' is-on' : ''}`, size: 14 },
      )
      control.setAttribute('aria-pressed', String(this.layout === name))
      return control
    })

    const share = button(this.shareLook ? 'one scale' : 'own scales', () => this.toggleShare(), {
      class: `btn btn-quiet deck-share${this.shareLook ? ' is-on' : ''}`,
      title: this.shareLook
        ? 'Every panel is drawn on the lead map’s clip. The same colour is the same number of ' +
          'contacts across the deck — true only where the libraries are comparable.'
        : 'Each panel scales to its own values (§7.1). Two libraries at different depths are ' +
          'each readable; the same colour is not the same count.',
    })

    const leadLock = iconButton(
      this.leadLocked ? 'link' : 'unlink',
      this.leadLocked
        ? 'The first map is driving the deck. Click to let it move on its own.'
        : 'The first map is moving on its own. Click to put it back in step.',
      () => {
        this.leadLocked = !this.leadLocked
        if (this.leadLocked) this.lock.catchUp(LEAD)
        this.paintBar()
      },
      { class: `btn btn-icon deck-lock${this.leadLocked ? '' : ' is-off'}`, size: 14 },
    )

    this.toolbar.replaceChildren(
      el('span', {
        class: 'deck-count',
        text: `${count} maps`,
        title:
          'One navigation across every panel: the region, the level and the score are shared, ' +
          'and each panel keeps its own colour scale. The chain on a panel takes it off the lead.',
      }),
      leadLock,
      el('span', { class: 'deck-spacer' }),
      ...layoutButtons,
      share,
      add,
    )
  }

  private warn(message: string): void {
    this.warning.textContent = message
    this.warning.classList.toggle('hidden', message === '')
  }

  private toggleAdd(): void {
    this.addRow.classList.toggle('hidden')
    if (!this.addRow.classList.contains('hidden')) this.urlInput.focus()
  }

  private setLayout(layout: DeckLayout): void {
    this.layout = layout
    remember(this.props.memoryKey(), 'deck:layout', layout)
    this.applyLayout()
    this.paintBar()
  }

  private toggleShare(): void {
    this.shareLook = !this.shareLook
    remember(this.props.memoryKey(), 'deck:share-look', this.shareLook)
    if (this.shareLook) {
      const look = this.leadLook()
      for (const slot of this.slots) slot.panel?.applyLook(look)
    }
    this.paintBar()
  }

  /** The lead's colour scale, for the panels that have opted to share it. */
  private leadLook(): ScaleState {
    const scale = this.lead?.scale()
    if (scale === undefined) return {}
    return {
      transform: scale.transform,
      colormap: scale.colormap,
      ...(Number.isFinite(scale.vmin) ? { vmin: scale.vmin } : {}),
      ...(Number.isFinite(scale.vmax) ? { vmax: scale.vmax } : {}),
    }
  }

  /**
   * The lead's scale **without** whatever a derivation borrowed from it (§7.5).
   *
   * What a new companion opens on, and deliberately not {@link leadLook}. The
   * two differ exactly when the lead is drawing a derived field, and the case
   * that matters is the one a companion cannot share: two files in the lead's
   * square under `ratio` put it on `log2` and a diverging ramp, and a companion
   * has one file and draws plain counts. Seeded with the live look it would draw
   * them on `log2`, where every empty cell of a sparse block is `-Infinity` and
   * the ramp's middle means nothing — a broken picture, from a control the
   * reader never pointed at it.
   *
   * The derivations the deck *does* share need no exception: a companion turns
   * them on for itself and reaches the same presentation by the same route.
   */
  private leadBaseLook(): ScaleState {
    const base = this.lead?.baseScale()
    if (base === undefined) return this.leadLook()
    return {
      transform: base.transform,
      colormap: base.colormap,
      ...(base.vmin === undefined ? {} : { vmin: base.vmin }),
      ...(base.vmax === undefined ? {} : { vmax: base.vmax }),
    }
  }

  private recallLayout(): DeckLayout {
    const stored = recall<string>(this.props.memoryKey(), 'deck:layout')
    return isDeckLayout(stored) ? stored : 'row'
  }
}

/** The file half of a `file::group` URI — what a byte source is pointed at. */
function splitPath(uri: string): string {
  const index = uri.indexOf('::')
  return index < 0 ? uri : uri.slice(0, index)
}
