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
import type { DerivePresentation, MatrixPanel, TurnPresentation } from '../ui/MatrixPanel'
import type { ScaleState } from '../ui/GenomeView'
import { button, el, fmt } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { DeckFrame } from './DeckFrame'
import { MapPanel, VacantPanel, type VacancyOrigin } from './MapPanel'
import {
  DECK_LAYOUTS,
  MAX_PANELS,
  columnsFor,
  grownDeck,
  grownPlacement,
  isDeckLayout,
  moveItem,
  panelBudgetBytes,
  parseMaps,
  sameRefs,
  serialiseMaps,
  type DeckLayout,
  type GrowDirection,
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
  /**
   * Whether the deck is turned 45°, or `undefined`.
   *
   * A thunk and shared, on the derivation's argument taken one step further: a
   * turn changes the geometry rather than the values, so a lead drawn as a band
   * along its diagonal beside four squares is not one navigation over five
   * pictures of a place — it is five pictures in two coordinate systems under a
   * bar claiming otherwise.
   */
  turn?(): TurnPresentation | undefined
  /**
   * The bin size the session's own file is at, or `undefined`.
   *
   * Only for a companion that turns out to be a **collection** rather than a
   * map: an `.mcool` is a ladder of complete coolers and the rung to land on is
   * the lead's, because two files with the same ladder are comparable at any of
   * them and the finest-regardless rule would put a 1 kb map beside a 16 kb one
   * (§3.4, `MapPanelProps.preferBinsize`). The *file's* bin size and not the
   * lead panel's effective resolution: pooling is a fact about how much of the
   * block is on screen, and it is not what a resolution ladder is indexed by.
   */
  binsize?(): number | undefined
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

/**
 * What a reader is told when the deck will not open another cell.
 *
 * In the deck's own bar and on the `+` edges rather than on an error screen: a
 * refusal to open a *seventh* map is not a reason to take the six away.
 */
const NO_ROOM =
  `${MAX_PANELS} maps is the limit for one deck. Every panel is a worker and, for a ` +
  'whole-file view, a block held in memory — and each one added makes every panel’s share of ' +
  'this tab’s memory smaller. Close one to open another.'

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

  /** The `+` edges, wrapped round the grid — see {@link DeckFrame}. */
  private readonly edges: DeckFrame

  private slots: Slot[] = []
  private readonly lock = new ViewportLock()
  private lead: MatrixPanel | null = null
  private leadLocked = true
  private layout: DeckLayout = 'row'
  /**
   * The column count the reader **drew**, or `null` to follow {@link layout}.
   *
   * Two ways of saying the same thing, and both are needed. The three preset
   * buttons answer "arrange what is here", which is a function of how many maps
   * there are — `row` of four stays a row when a fifth arrives. A `+` answers
   * "make it this shape", which is a number, and it has to survive a map being
   * added or closed or it is not a shape at all: draw a 2 × 2, close one map,
   * and a preset would silently reflow the remaining three into a row.
   *
   * A preset click clears this and a `+` sets it, so exactly one of the two is
   * in charge at any moment and no lit button ever disagrees with the grid.
   */
  private columns: number | null = null
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
  /** Which block the deck was last showing, so a move to another resets the lock. */
  private place: string | null = null
  private destroyed = false

  constructor(private readonly props: PanelDeckProps) {
    this.layout = this.recallLayout()
    this.columns = this.recallColumns()
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
    // The same edges the session was showing a moment ago, now round the grid
    // instead of round one map — which is the whole reason they are a component
    // and not a pair of buttons in each place (`panels/DeckFrame.ts`).
    this.edges = new DeckFrame({ onGrow: (direction, file) => this.grow(direction, file) })
    this.el = el(
      'div',
      { class: 'deck' },
      this.toolbar,
      this.addRow,
      this.warning,
      this.edges.hold(this.grid),
    )
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
    // A different block is a different place, and the lock's currency is base
    // pairs *from each block's own first cell* — so a window carried across a
    // navigation still parses and means somewhere else. Cleared before anything
    // is pushed, so a companion that finishes reading before the lead catches up
    // to nothing rather than to the previous region's window.
    const place = placeKey(state)
    if (this.place !== null && this.place !== place) this.lock.reset()
    this.place = place

    this.state = state
    if (this.published === null || this.published.value !== state.maps) {
      const wanted = parseMaps(state.maps)
      if (!sameRefs(wanted, this.slots.map((slot) => slot.ref))) this.adopt(wanted)
      this.published = { value: state.maps }
    }
    for (const slot of this.slots) slot.panel?.apply(state)
    this.paintBar()
  }

  /**
   * Push the lead's clip down to every companion, where "one scale" is on.
   *
   * Called by the session *after* it has applied a colour change to the lead,
   * which is the whole of why this is a method rather than part of
   * {@link apply}: the deck is reconciled before the lead is recoloured — a
   * colour-only change is still a view its panels have to be handed — so reading
   * the lead's scale during `apply` reads the one it is about to stop having.
   *
   * Without this the setting worked once, when it was switched on, and every
   * later nudge of the lead's clip left the companions on the old one while the
   * toolbar went on claiming the same colour is the same number of contacts
   * across the deck — a claim a reader acts on when reading the figure.
   */
  syncSharedLook(): void {
    if (!this.shareLook) return
    const look = this.leadLook()
    for (const slot of this.slots) slot.panel?.applyLook(look)
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

  private build(ref: PanelRef, source?: SourceSpec, origin: VacancyOrigin = 'link'): Slot {
    const slot: Slot = { id: `p${nextSlotId++}`, ref, panel: null, vacancy: null, locked: true }
    if (ref.kind === 'vacant') {
      slot.vacancy = new VacantPanel({
        origin,
        onOpen: (file) => this.fill(slot, file),
        onClose: () => this.remove(slot),
        onMove: (delta) => this.move(slot, delta),
      })
      return slot
    }
    slot.panel = new MapPanel({
      uri: ref.uri,
      source: source ?? { kind: 'remote', url: splitPath(ref.uri) },
      // Divided between the cells that hold a **file**, not between the cells.
      // An empty card has no worker and no block, so counting it would shrink
      // every real panel's allowance to pay for rectangles that cost nothing —
      // and under §16.9 a reader draws the empty ones first, so a 2 × 2 deck
      // with two maps in it would read both at a quarter of the allowance
      // instead of a half. Still a live count, so filling the third cell still
      // makes the fourth read smaller (§16.7).
      budgetBytes: () => panelBudgetBytes(this.filled, deviceDenseBudgetBytes()),
      onSettled: () => this.settle(slot),
      onClose: () => this.remove(slot),
      onToggleLock: () => this.toggleLock(slot),
      isLocked: () => slot.locked,
      lockNote: () => this.lockNote(slot),
      derive: () => this.props.derive?.(),
      turn: () => this.props.turn?.(),
      // The lead's scale, clip included. A map opened beside another is opened
      // to be compared with it, and a comparison whose two halves are on two
      // clips is one the eye has to correct for before it can read anything —
      // so the honest default is the one that makes the same colour the same
      // number, and the reader who knows their libraries differ in depth takes
      // this panel off it with one nudge of its own clip. Not the *live* scale
      // but `baseScale`, which is the same thing minus whatever a derivation
      // borrowed: a lead under a two-file `ratio` is on `log2` and a diverging
      // ramp, and a companion drawing plain counts must not inherit that.
      initialLook: () => this.leadBaseLook(),
      preferBinsize: () => this.props.binsize?.(),
      onResolved: (uri) => this.resolveRef(slot, uri),
      onMove: (delta) => this.move(slot, delta),
    })
    slot.panel.syncLock()
    return slot
  }

  /**
   * A companion descended into an entry of a collection: publish what it opened.
   *
   * The link has to name the map rather than the `.mcool` it lives in, and not
   * as a nicety: a recipient's deck resolves the root the same way, but against
   * *their* lead's bin size, so the same link would show a different rung of
   * the ladder to the two people looking at it (§3.4, §16.6).
   */
  private resolveRef(slot: Slot, uri: string): void {
    if (slot.ref.kind === 'vacant' || slot.ref.uri === uri) return
    slot.ref = { kind: slot.ref.kind, uri }
    this.publish()
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

    // A turned panel's rows are **separation**, not position, so a row
    // disagreement there is a different fact from a column one and must not
    // borrow its sentence. The depth each band opens at is a fraction of its
    // own block rounded up to a whole bin (`MatrixPanel.turnDepth`), so two
    // files at different resolutions round it differently and the two bands
    // reach different distances from the diagonal — which is a real reason not
    // to share a row window, and is nothing whatever to do with the sequences
    // agreeing. Telling a reader their files resolved one name against
    // different sequences when they did not is worse than not telling them
    // anything: it is a claim they may act on. A cell is half a bin under a
    // turn and height is half of separation, so the number a reader wants is
    // twice the lock's (`render/rotate.ts`).
    if (map.isTurned() && lead.isTurned() && cols) {
      return (
        'not following while turned: this band reaches ' +
        `${fmt.bp(mine.rows * map.bpPerCell() * 2)} from the diagonal where the first map ` +
        `reaches ${fmt.bp(theirs.rows * lead.bpPerCell() * 2)}. Each map opens on a fraction of ` +
        'its own block and rounds that to a whole bin, so two files at different resolutions do ' +
        'not turn to the same depth — and one row window would be two distances. Turning the ' +
        'deck back off puts this panel in step.'
      )
    }

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

  /** Turn a vacancy into a map, in the position it was standing in. */
  private fill(slot: Slot, file: File): void {
    this.occupy(slot, { kind: 'local', uri: file.name }, { kind: 'local', file })
  }

  /** Put a file in a cell that had none, leaving every other cell alone. */
  private occupy(slot: Slot, ref: PanelRef, source?: SourceSpec): void {
    const index = this.slots.indexOf(slot)
    if (index < 0) return
    slot.vacancy?.destroy()
    const built = this.build(ref, source)
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

  /**
   * Open one more map: in the first empty cell if there is one, else at the end.
   *
   * The empty cell comes first because under §16.9 it is *the reader's own
   * instruction*. They drew the arrangement before they had the files, so a map
   * arriving by any road — the bar's URL box, the file chooser, the command
   * palette — belongs in the next place they left for it, and appending past
   * their empty cards to a cell they never asked for would make the two ways of
   * adding a map disagree about what the deck is.
   */
  add(ref: PanelRef, source?: SourceSpec): void {
    const empty = this.slots.find((slot) => slot.ref.kind === 'vacant')
    if (empty !== undefined) {
      this.warn('')
      this.addRow.classList.add('hidden')
      this.occupy(empty, ref, source)
      return
    }
    if (this.slots.length + 1 >= MAX_PANELS) {
      // In the deck's own bar, not on an error screen — see {@link NO_ROOM}.
      // Every other refusal a reader meets here (a name this file has not got,
      // a block this share of the budget will not lend) is already a line
      // beside the panel it is about.
      this.warn(NO_ROOM)
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
   * Open a column of empty cells beside the maps, or a row below them (§16.9).
   *
   * The deck's own half of the `+` gesture, and the only place the shape is
   * written down as a number: every other control here arranges the cells that
   * exist, and this one is how a reader says how many there should be.
   *
   * The maps are **re-seated**, not appended to, and that distinction is the
   * whole of {@link grownPlacement}: a cell's position is derived from its index
   * and the column count, so widening the deck re-maps every index at once and
   * pushing the new cells onto the end turns a 2 × 2 into a 3-wide row with one
   * map stranded underneath. Nothing here rebuilds a panel — the slots are the
   * same objects in a new order, so re-seating a deck of five costs a
   * `replaceChildren` and no reads.
   *
   * A file arrives with the press when it was **dropped** on the edge rather
   * than clicked, and it goes into the first cell that press opened — not into
   * the first empty cell in the deck, which is where {@link add} would put it.
   * The two rules differ only when the deck already had a hole somewhere, and
   * there the gesture is the tie-breaker: a reader who drops on the right edge
   * of a deck has aimed at the right edge of it.
   */
  grow(direction: GrowDirection, file?: File): void {
    const shape = { cells: this.slots.length + 1, columns: this.columnsNow() }
    const next = grownDeck(shape, direction)
    if (next.cells > MAX_PANELS) {
      // A file that came with the press is not lost with it. There is no room
      // for a cell, but there may be an empty one already — and dropping a
      // cooler on a full deck to be told a number is a worse answer than
      // opening it where the deck has space.
      if (file !== undefined) this.addLocal(file)
      else this.warn(NO_ROOM)
      return
    }
    this.warn('')

    // Cell 0 is the lead's and is not in `slots`, so the placement is walked
    // from 1. `grownPlacement` guarantees cell 0 keeps the lead — both growths
    // insert only *after* a row's existing cells — which is what lets the lead
    // stay a re-parented view rather than a panel that can be moved (§3.1 B2).
    const places = grownPlacement(shape, direction)
    const held = this.slots
    const seated: Slot[] = []
    let opened = -1
    for (let cell = 1; cell < places.length; cell++) {
      const from = places[cell]
      if (from === null) {
        // Drawn, not left by a link, and that is all the difference amounts to:
        // the card says "drop a map here" rather than telling the reader that a
        // map they never had used to be there (`panels/MapPanel.ts`).
        if (opened < 0) opened = seated.length
        seated.push(this.build({ kind: 'vacant' }, undefined, 'drawn'))
      } else {
        seated.push(held[from - 1])
      }
    }

    this.columns = next.columns
    remember(this.props.memoryKey(), 'deck:columns', next.columns)
    this.slots = seated
    // The first cell the press opened, in reading order — which for `beside` is
    // the top of the new column and for `below` the left of the new row, both
    // being the near end of the edge that was pressed.
    const first = opened < 0 ? undefined : this.slots[opened]
    if (file === undefined || first === undefined) {
      this.paintGrid()
      this.publish()
    } else {
      // Paints and publishes on its way through, with the cell already filled,
      // so the hash is written once rather than as a vacancy and then a map.
      this.fill(first, file)
    }
    this.paintBar()
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
    const shape = { cells: this.slots.length + 1, columns: this.columnsNow() }
    this.grid.style.setProperty('--deck-columns', String(shape.columns))
    // Asked of the same arithmetic the press will run, rather than of the panel
    // count, so an edge is lit exactly when pressing it would do something. A
    // deck of two rows has room for another row of two and not for another
    // column of two at five cells, and one answer for both edges would either
    // grey an edge that works or offer one that refuses.
    this.edges.setRoom(
      {
        beside: grownDeck(shape, 'beside').cells <= MAX_PANELS,
        below: grownDeck(shape, 'below').cells <= MAX_PANELS,
      },
      NO_ROOM,
    )
    for (const slot of this.slots) slot.panel?.remeasure()
  }

  /**
   * Cells in a row, right now.
   *
   * Clamped to the number of cells, because a `repeat(3, 1fr)` grid holding two
   * items draws them two thirds of the way across and leaves a third of the
   * width empty — which reads as a map that failed to load rather than as a
   * deck with a column fewer than it had.
   */
  private columnsNow(): number {
    const cells = this.slots.length + 1
    if (this.columns === null) return columnsFor(cells, this.layout)
    return Math.min(Math.max(1, this.columns), cells)
  }

  /** Cells with a file in them, lead included — the budget's divisor. */
  private get filled(): number {
    return 1 + this.slots.filter((slot) => slot.ref.kind !== 'vacant').length
  }

  /**
   * The bar above the grid: how many maps, how they are laid out, and the two
   * switches that are about the deck rather than about one panel.
   *
   * Repainted wholesale because it is a dozen nodes and it changes on every
   * addition; the panels below it are the expensive things and they are kept.
   */
  private paintBar(): void {
    const cells = this.slots.length + 1
    const filled = this.filled
    const empty = cells - filled
    const add = button('', () => this.toggleAdd(), {
      class: 'btn deck-plus',
      title:
        empty === 0
          ? 'Open another map beside these'
          : 'Open a map in the first empty cell of the deck',
    })
    add.replaceChildren(icon('plus', { size: 14 }), el('span', { text: 'add a map' }))

    // Lit only where the reader has not drawn a shape of their own. A `+` sets
    // a column count that is generally none of the three, and a preset left
    // glowing under it would claim the grid is an arrangement it is not.
    const chosen = this.columns === null
    const layoutButtons = DECK_LAYOUTS.map((name) => {
      const on = chosen && this.layout === name
      const control = iconButton(
        name === 'row' ? 'columns-2' : name === 'column' ? 'rows-3' : 'grid-2x2',
        name === 'row'
          ? 'Side by side, which is how a figure compares conditions'
          : name === 'column'
            ? 'Stacked, for a narrow window'
            : 'A near-square grid, which is what keeps four maps large enough to read',
        () => this.setLayout(name),
        { class: `btn btn-icon deck-layout${on ? ' is-on' : ''}`, size: 14 },
      )
      control.setAttribute('aria-pressed', String(on))
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
        // The empty cells are counted separately rather than folded into the
        // total, because "4 maps" over a 2 × 2 grid with two rectangles in it is
        // the deck telling the reader something they can see is untrue.
        text: empty === 0 ? `${filled} maps` : `${filled} of ${cells}`,
        title:
          `${this.rows()} × ${this.columnsNow()}` +
          (empty === 0 ? '' : `, ${empty} empty — drop a file on one to open it there`) +
          '. One navigation across every panel: the region, the level and the score are shared, ' +
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

  /** Rows the grid needs for the cells it has, at the current column count. */
  private rows(): number {
    return Math.ceil((this.slots.length + 1) / this.columnsNow())
  }

  private setLayout(layout: DeckLayout): void {
    this.layout = layout
    // A preset is the reader saying "arrange what is here", which is the answer
    // to a different question from the one a `+` answers — so it takes the
    // drawn column count off rather than fighting it. Forgotten as well as
    // cleared: a shape that came back on the next reload while the bar showed a
    // preset lit is the one state these two settings must never be in together.
    this.columns = null
    remember(this.props.memoryKey(), 'deck:layout', layout)
    remember(this.props.memoryKey(), 'deck:columns', null)
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

  /**
   * The drawn column count, if this file's deck had one.
   *
   * Validated rather than trusted: stored state outlives the code that wrote it
   * (§8.6), and a `columns` of `0` or `NaN` coming back from a session written
   * by an older build would divide the grid into no columns at all.
   */
  private recallColumns(): number | null {
    const stored = recall<number>(this.props.memoryKey(), 'deck:columns')
    if (typeof stored !== 'number' || !Number.isFinite(stored) || stored < 1) return null
    return Math.min(Math.floor(stored), MAX_PANELS)
  }
}

/** The file half of a `file::group` URI — what a byte source is pointed at. */
function splitPath(uri: string): string {
  const index = uri.indexOf('::')
  return index < 0 ? uri : uri.slice(0, index)
}

/**
 * What identifies the *block* a state selects, for the lock's purposes.
 *
 * The keys that choose data, and none of the ones that choose how it is drawn:
 * a clip nudge must not reset the deck's window, and a change of region must.
 * `level` is in it because a contig-level cell is a whole sequence rather than a
 * stretch of one, so the two grids are not the same grid however similar the
 * request looks.
 */
function placeKey(state: ViewState): string {
  return JSON.stringify([
    state.uri,
    state.view,
    state.genome,
    state.genome2,
    state.genomes,
    state.region,
    state.region2,
    state.regions,
    state.locus,
    state.level,
  ])
}
