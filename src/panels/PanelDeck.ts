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

import type { NameContext } from '../genome/naming'
import { deviceDenseBudgetBytes } from '../metacooler/matrix'
import { recall, remember } from '../state/UiMemory'
import type { ViewState } from '../types'
import type { SourceSpec } from '../worker/protocol'
import type {
  AnnotationContext,
  DerivePresentation,
  MatrixPanel,
  PanelGeometry,
  TurnPresentation,
} from '../ui/MatrixPanel'
import type { ScaleState } from '../ui/GenomeView'
import { button, el, fmt } from '../ui/dom'
import {
  canvasToPng,
  copyPngToClipboard,
  downloadBlob,
  fileStamp,
  readPageBackground,
} from '../ui/export'
import { KEYS, withKey } from '../ui/commands'
import { iconButton } from '../ui/icons'
import { bucketBrowseButton } from '../ui/browseButton'
import type { PickedFile } from '../browse/folder'
import { DeckFrame } from './DeckFrame'
import { MapPanel, VacantPanel, type VacancyOrigin } from './MapPanel'
import {
  DECK_DRAG_TYPE,
  MAX_PANELS,
  carriedUnit,
  grownDeck,
  grownPlacement,
  panelBudgetBytes,
  deepestStacks,
  parseMaps,
  sameRefs,
  serialiseMaps,
  swapItems,
  localCompanions,
  withLocalCompanions,
  readDeckLook,
  withLook,
  type DeckLook,
  type GrowDirection,
  type PanelRef,
} from './deck'
import { ViewportLock, spansAgree } from './lock'
import type { PickHandlers } from '../ui/mapPick'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import { LANE_EDGES } from '../annotations/types'
import { fileLabel } from '../ui/labels'

/** The id the lock knows the session's own map by. */
const LEAD = 'lead'

/**
 * A remembered local companion, once the session has asked whether it can still
 * be opened.
 *
 * `source: null` is a real answer and not an absence: it means *this cell held a
 * file and the grant did not answer*, which is what earns the vacancy the
 * `remembered` wording and the file's own name. The asking happens in
 * `Session.syncDeck`, before the deck is handed the state, because it is
 * asynchronous and nothing inside this class may be.
 */
export interface ResolvedLocal {
  index: number
  uri: string
  source: SourceSpec | null
}

/**
 * A heading that can be typed into: an `<input>` that looks like text.
 *
 * The Tracks card's control, shared between the deck's own cell and a
 * companion's because they are one gesture on two headings — see
 * `ui/mapNames.ts` for what a map's name is and where it lives. An empty box
 * hands the map back to its file name, which is what makes the rename undoable.
 */
function renameBox(
  name: string,
  title: string,
  onRename: (name: string | null) => void,
): HTMLInputElement {
  const input = el('input', {
    class: 'input deck-name',
    type: 'text',
    value: name,
    title,
  })
  input.addEventListener('change', () => {
    const typed = input.value.trim()
    if (typed === name) {
      input.value = name
      return
    }
    onRename(typed === '' ? null : typed)
    // The name comes back through a repaint of this heading, so the box is put
    // back as it was rather than left holding a name nothing has accepted yet.
    input.value = name
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      input.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = name
      input.blur()
    }
    event.stopPropagation()
  })
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  return input
}

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
   * The star moved: which map an analysis now runs against (§18.2).
   *
   * The session's cue to re-price the Analysis column and re-read its context,
   * because both are answers about one file and the file has changed.
   */
  onStarChange?(): void
  /**
   * What to call the session's own map, for the heading over its cell.
   *
   * Every cell of a deck says which file it is, the first one included. Without
   * it the reader has four labelled rectangles and one that is simply *the
   * page*, and telling which of five conditions the unlabelled one is means
   * reading the breadcrumb — which is on the other side of the window and says
   * a region rather than a file.
   */
  leadName?(): string | undefined
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
   * One panel's lanes, by the id the deck knows it as.
   *
   * The session owns the store; the deck owns the ids. Handed as a function of
   * the slot rather than resolved here, because which tracks a map draws is the
   * session's business and the deck's only contribution is a name.
   */
  annotations?(map: string): AnnotationContext | undefined
  /**
   * How the session's own map names its sequences, for the companions to
   * follow (§5.9).
   *
   * A thunk for the same reason `derive` is one: the lead's contigs arrive
   * after the deck is built, and a value snapshotted at construction would be
   * `undefined` for the whole session.
   */
  leadNaming?(): NameContext | undefined
  /** What the session's own map is called, for the placement control's rows. */
  leadLabel?(): string
  /**
   * What to call a companion, which is not always what its file is called.
   *
   * A map can be renamed (`ui/mapNames.ts`), and the names live with the
   * session rather than with the deck — a deck is an arrangement of files and
   * the session is what is holding them. A thunk of the URI so a panel that
   * resolves itself into an entry of a collection asks again under the address
   * it ended up at.
   */
  mapLabel?(uri: string): string
  /** The reader typed a name into a companion's heading, or emptied the box. */
  onRenameMap?(uri: string, name: string | null): void
  /**
   * The same, for the session's own map in cell 0.
   *
   * A separate handler rather than {@link onRenameMap} with the lead's URI,
   * because the deck does not have that URI: it has a *name* for cell 0 and
   * nothing else, which is the whole of what {@link leadName} is.
   */
  onRenameLead?(name: string | null): void
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
   * Put a colour scale on the session's own map — "fix all scales" (§16.2).
   *
   * Through the session rather than onto the panel, and that is not ceremony:
   * `MatrixPanel.applyScale` writes the clip onto the panel and tells nobody, so
   * the next render — which rebuilds the lead's view from the *state* — would
   * put it straight back. The session's own colour controls patch the view
   * state, so this does too, and the choice sticks and travels in the link.
   *
   * Absent where the lead is a view with no scale to set, in which case the
   * toggle simply moves the companions.
   */
  onLeadScale?(scale: ScaleState): void
  /**
   * Read the session's own map at this bin size — "fix all resolutions".
   *
   * Only reachable when the star is on a companion: it is the one direction the
   * deck cannot take itself, because changing the lead's rung means reopening
   * the file the session *is* — the breadcrumb's own entry picker, from the
   * other end.
   */
  onLeadBinsize?(binsize: number): boolean
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
  /**
   * The score the session's own map resolved to — `count`, `balanced`, `ICE`, a
   * column name.
   *
   * Shared as a resolved id, because the *default* is a fact about a file and
   * is not in the hash: a cooler somebody balanced opens balanced. Two panels
   * each applying their own default disagreed silently, which is the one thing
   * a deck must not do about a quantity.
   */
  score?(): string | undefined
  /**
   * A companion's own scale, score or chain moved.
   *
   * Nothing to apply — the deck has already written it into this session's
   * memory — only somebody to tell, because the durable record and the exported
   * workspace are built from that memory and neither is rewritten by a change
   * that does not touch the view state. Without this, nudging four companions'
   * clips and closing the window lost all four: a clip is not a navigation, so
   * nothing on the state road ever fired.
   */
  onLooksChange?(): void
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
 * What a deck-wide figure is rasterised at, and the air between its cells.
 *
 * A fixed 300 dpi rather than a picker of its own: the per-panel export already
 * has one, and a second dpi control in the deck's bar would be a shared setting
 * that is not shared with anything. 300 is what a figure is for.
 */
const DECK_EXPORT_DPI = 300
const DECK_EXPORT_GAP = 0.02

/**
 * What a reader is told when the deck will not open another cell.
 *
 * In the deck's own bar and on the `+` edges rather than on an error screen: a
 * refusal to open a *sixty-fifth* map is not a reason to take the others away.
 */
const NO_ROOM =
  `A deck stops at ${MAX_PANELS} maps, which is a backstop rather than a judgement about how ` +
  'many are useful: every panel is a worker and, for a whole-file view, a block held in memory, ' +
  'and each one added makes every panel’s share of this tab’s memory smaller. Long before this ' +
  'it is the share that refuses, panel by panel and in bytes. Close one to open another.'

let nextSlotId = 1

export class PanelDeck {
  /** The grid, parented into the session's content area. */
  readonly el: HTMLElement
  private readonly toolbar: HTMLElement
  private readonly grid: HTMLElement
  private readonly leadHead = el('header', { class: 'deck-head deck-head-lead hidden' })
  /** The lead's half of the star; every companion carries its own. */
  private readonly leadStar = iconButton('star', '', () => this.setStarred(LEAD_MAP), {
    class: 'btn btn-icon deck-star is-on',
    size: 13,
  })
  /**
   * Where the lead view's own heading goes while a deck is on.
   *
   * The heading, the locus box, the back link and the block summary belong to
   * the *session*, not to the first cell of a grid — they answer "what am I
   * looking at", which is one question however many pictures are on screen. Left
   * inside cell 0 they made it a head taller than every other cell, so the first
   * map was drawn smaller than the maps it was there to be compared with, and
   * the reader had to correct for the difference before reading anything.
   */
  private readonly leadHeadHost = el('div', { class: 'deck-lead-head hidden' })
  /** What was hoisted out of which view, so it can be put back. */
  private hoisted: { head: HTMLElement; view: HTMLElement } | null = null
  /** The deck's own line in that summary — how many maps, and how many empty. */
  private readonly deckNote = el('span', { class: 'deck-maps' })
  private readonly leadCell = el('div', { class: 'deck-panel is-lead' }, this.leadHead)
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
  /**
   * The lead's last report, kept because the alignment is recomputed without it.
   *
   * A companion whose stack changes has to raise the deck's floor, and it has
   * no way to ask the lead what its own geometry is — that arrives as a push.
   * So the last one is held rather than the figures derived from it.
   */
  private leadGeometry: PanelGeometry = {
    lanes: { top: 0, right: 0, bottom: 0, left: 0 },
    plot: 0,
    plotHeight: 0,
  }
  /** Guards {@link align} against the reports its own writes provoke. */
  private aligning = false
  /**
   * How many cells are in a row, or `null` for one row of everything.
   *
   * The deck's whole shape, as one number. It used to be three preset buttons —
   * row, column, near-square — which answered "arrange however many maps are
   * here" and were therefore a function of the count: a `row` of four stayed a
   * row when a fifth arrived. A drawn deck (§16.9) needs the other thing, a
   * shape that *survives* the count changing, or closing one map out of a 2 × 2
   * silently reflows the other three into a row.
   *
   * Set by a `+` on an edge and by the columns picker in the bar, which is the
   * preset row's honest replacement: it says the same thing the three buttons
   * said, in the vocabulary the grid is actually in.
   */
  private columns: number | null = null
  /**
   * The map an analysis runs against — the star (§18.2).
   *
   * **Not the lead, and deliberately a second idea.** The lead is what the
   * session *is of*: the breadcrumb, the tables, the tracks and the second-file
   * split all name it, and it does not move (§16.9). What a reader wants a deck
   * for is often the other question — four replicates on screen and *this* one is
   * the one to measure — and answering it by changing which file the session is
   * of would rewrite the breadcrumb and the tables to run a P(s).
   *
   * So the star says only which picture the tasks read, it starts on the lead,
   * and it goes back to the lead the moment the map it named leaves. One
   * starred map at a time, because a task runs against one file: this is a radio
   * button drawn as five, which is the same shape the Annotations card's own
   * star has for the same reason (`ui/AnnotationCard.ts`).
   */
  private starred: MapId = LEAD_MAP

  /**
   * How each companion was last drawn, by file (`panels/deck.ts`'s `DeckLook`).
   *
   * Held here rather than on the panels because it has to outlive them. A panel
   * is destroyed and rebuilt by every reconcile that changes the list — closing
   * a neighbour, dragging a map to another cell, following a link — and a clip
   * kept on the instance is a clip the reader loses on the next thing they do to
   * the grid. It also has to outlive the *deck*, since the whole point is that a
   * saved workspace brings four replicates back on their own four scales.
   */
  private looks: DeckLook[] = []

  /**
   * The bin size the session's own map was last seen at.
   *
   * Watched rather than told, because there is no one place to be told from: a
   * reader changes the first map's resolution from the breadcrumb's own picker,
   * a link can arrive naming another rung, and *fix all resolutions* can move it
   * from the deck's bar. All three end in the same place — the session reopens
   * its file — so the deck notices the number change and takes every companion
   * with it (§16.2). `undefined` until the first view lands, which is why the
   * first sighting only records: a companion already opens on the first map's
   * bin size (§3.4) and has nothing to be moved to.
   */
  private leadBinsize: number | undefined
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
    this.columns = this.recallColumns()
    // Restored, then reconciled: a session written when four maps were open can
    // name a slot this one has not built, and `keepStarPresent` puts it back on
    // the lead rather than leaving the Analysis column pointed at nothing.
    const star = recall<string>(props.memoryKey(), 'deck:starred')
    if (typeof star === 'string' && star !== '') this.starred = star
    this.looks = this.recallLooks()

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
      bucketBrowseButton((url) => this.add({ kind: 'remote', uri: url })),
      fileInput,
    )
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.addUrl()
    })

    this.grid = el('div', { class: 'deck-grid' }, this.leadCell)
    this.watchArranging()
    this.toolbar = el('div', { class: 'deck-bar' })
    // The same edges the session was showing a moment ago, now round the grid
    // instead of round one map — which is the whole reason they are a component
    // and not a pair of buttons in each place (`panels/DeckFrame.ts`).
    this.edges = new DeckFrame({ onGrow: (direction, picked) => this.grow(direction, picked) })
    this.el = el(
      'div',
      { class: 'deck' },
      this.leadHeadHost,
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
    this.paintLeadHead()
    this.hoistHead(lead)
    this.leadCell.replaceChildren(this.leadHead, lead)
    this.paintBar()
    return this.el
  }

  /**
   * Take the view's own heading out of cell 0 and put it above the grid.
   *
   * Moved rather than rebuilt, so the region box keeps its caret, the stepper
   * keeps its listeners and the summary keeps whatever the last read wrote into
   * it. Every view a deck can frame has exactly one `.view-head` and it is the
   * first child of the view's root (§16.8 lists which they are); anything else
   * in there — a whole-genome view's gate and progress bar, say — is about the
   * *picture* and stays with it.
   *
   * The deck's own note goes immediately after the summary rather than into it:
   * a view rewrites that element on every read, and anything the deck had put
   * inside would go with the previous block's numbers.
   */
  private hoistHead(lead: HTMLElement): void {
    this.lowerHead()
    const head = lead.querySelector<HTMLElement>(':scope > .view-head')
    if (head === null) {
      this.leadHeadHost.replaceChildren()
      this.leadHeadHost.classList.add('hidden')
      return
    }
    this.hoisted = { head, view: lead }
    this.leadHeadHost.replaceChildren(head)
    this.leadHeadHost.classList.remove('hidden')
    const summary = head.querySelector(':scope > .summary, :scope > .match-kind')
    if (summary === null) head.append(this.deckNote)
    else summary.after(this.deckNote)
  }

  /** Give the heading back to the view it belongs to, first child as it was. */
  private lowerHead(): void {
    const held = this.hoisted
    this.hoisted = null
    this.deckNote.remove()
    if (held === null) return
    held.view.prepend(held.head)
  }

  /**
   * The map the session just mounted, for the lock to drive.
   *
   * Re-registered on every mount because it is a different object on every
   * navigation — a region view builds its own panel — and a lock holding the
   * previous one would drive a canvas nobody can see.
   */
  setLead(panel: MatrixPanel | null): void {
    if (this.lead !== null && this.lead !== panel) {
      this.lead.setViewportListener(null)
      this.lead.setLaneListener(null)
      this.lead.setHoverListener(null)
      this.lead.setLaneHoverListener(null)
    }
    this.lead = panel
    this.lock.leave(LEAD)
    panel?.setLaneListener((budget) => this.align(budget))
    panel?.setHoverListener((cell) => this.echoHover(LEAD, panel, cell))
    panel?.setLaneHoverListener((at) => this.echoLaneHover(LEAD, panel, at))
    if (panel === null) {
      this.align({ lanes: { top: 0, right: 0, bottom: 0, left: 0 }, plot: 0, plotHeight: 0 })
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
    panel.setViewportListener((rows, cols) => {
      this.lock.report(LEAD, rows, cols)
      // Before the notes, because it is one of the things they are about: a
      // companion whose band reaches a different distance is refused by
      // `lockNote`, and this is what stops that being a thing two boxes can
      // disagree into.
      this.syncTurnReach()
      // The lead's first report is the moment a companion's note can be
      // *answered*: until the lead has a block there is nothing to compare
      // against, so `lockNote` says nothing, and a real disagreement discovered
      // afterwards would otherwise sit unsaid until the next thing that happened
      // to repaint the panel.
      this.syncLockNotes()
    })
    this.paintBar()
  }

  /** Re-ask every companion's chain and line, after something they compare against moved. */
  private syncLockNotes(): void {
    for (const slot of this.slots) slot.panel?.syncLock()
  }

  /**
   * One distance from the diagonal across every turned panel (§17.2, §16.3).
   *
   * A turned map's band is cut as deep as its own box has rows for, which is the
   * right rule for one map and cannot work for several: a grid lays its cells
   * out over more than one frame, so two panels asking their own boxes at their
   * own moments get two answers and neither is wrong. What the reader saw was
   * two bands of visibly different depths, the lock refusing to move them
   * together, and `lockNote` blaming the files' *resolutions* for what was a
   * layout race — a claim about their data, made out of a timing accident, and
   * cured by turning the deck off and on again, which re-cuts both bands from
   * boxes that have by then settled.
   *
   * So the lead's reach is pushed down, in base pairs, exactly as the window is
   * and for the same reason: each panel converts to its own lattice, so panels
   * of unequal resolution reach the same distance rather than the same number of
   * bins. The lead keeps its box — it is the one map whose depth is a reader's,
   * through the height of the window they are looking at.
   *
   * Companions are released back to their own boxes when the lead is not turned,
   * which is what makes this leave a square deck exactly as it was.
   */
  private syncTurnReach(): void {
    const reach = this.lead?.turnReach() ?? null
    for (const slot of this.slots) slot.panel?.map?.setTurnReach(reach)
  }

  /**
   * Reconcile the companions against a view state, and hand it to them.
   *
   * The list first, so a link that names three maps has three panels before any
   * of them reads anything; then the view, which each panel resolves against
   * its own file.
   */
  apply(state: ViewState, locals: readonly ResolvedLocal[] = []): void {
    // A different block is a different place, and the lock's currency is base
    // pairs *from each block's own first cell* — so a window carried across a
    // navigation still parses and means somewhere else. Cleared before anything
    // is pushed, so a companion that finishes reading before the lead catches up
    // to nothing rather than to the previous region's window.
    const place = placeKey(state)
    if (this.place !== null && this.place !== place) this.lock.reset()
    this.place = place

    // The session's own map may have changed rung since the last view — from the
    // breadcrumb's picker, from a link, or from this deck's own button — and
    // every companion follows it there. Before the panels are handed the state,
    // so a companion that is about to re-read does it once at the new resolution
    // rather than twice.
    const binsize = this.props.binsize?.()
    if (binsize !== undefined && binsize > 0) {
      const moved = this.leadBinsize !== undefined && this.leadBinsize !== binsize
      this.leadBinsize = binsize
      if (moved) this.followLeadResolution(binsize)
    }

    this.state = state
    if (this.published === null || this.published.value !== state.maps) {
      // The hash says `~` for a local companion, which is all it can honestly
      // say (§16.6). What this session privately remembers about those cells is
      // merged back in here — resolved ones become live panels again, and the
      // rest stay vacancies that at least know what they were.
      const wanted = withLocalCompanions(
        parseMaps(state.maps),
        locals.filter((local) => local.source !== null),
      )
      if (!sameRefs(wanted, this.slots.map((slot) => slot.ref))) this.adopt(wanted, locals)
      // The **hash** value, never the merged list's. They serialise the same —
      // a local ref becomes `~` again — but recording what was merged would
      // make the next render see a difference and reconcile the deck away.
      this.published = { value: state.maps }
    }
    for (const slot of this.slots) slot.panel?.apply(state)
    this.paintBar()
  }

  /**
   * The colour scale the deck is being asked to put every panel on.
   *
   * The **starred** map's, which is the map every other "all of them" in this
   * bar is measured from — it is what a task runs against (§18.2), and making
   * it what the scale and the resolution come from too is one idea rather than
   * three. `null` where there is nothing to read one from: a first map that is a
   * table, a starred companion still opening.
   */
  private starredLook(): ScaleState | null {
    // The star's own map and never a fall-back to the first one: a starred
    // companion that has not drawn yet has no numbers, and answering with
    // somebody else's while the button says "the starred map" is worse than
    // answering with nothing.
    const panel = this.starred === LEAD_MAP ? this.lead : (this.starredPanel?.map ?? null)
    if (panel === null) return null
    // **What it is drawing with**, not what the reader has set on it. Those are
    // the same thing only where somebody has nudged a clip; everywhere else the
    // setting is `NaN` — §7.1's auto rule, resolved per read — and reading it
    // here is why the press used to carry the ramp and the transform across the
    // deck and leave every range where it was ({@link MatrixPanel.shownScale}).
    return scaleState(panel.shownScale())
  }

  /**
   * Draw every panel on the starred map's clip — the *fix all scales* press.
   *
   * **An action, and no longer a mode.** It used to be a switch that stayed on,
   * and a switch makes a promise it cannot keep: the moment it is lit, every
   * later nudge of any panel's clip either has to be undone or leaves the deck
   * claiming a shared scale it no longer has. A press says something a reader
   * can rely on — *these are all on that one's numbers now* — and the very next
   * nudge is honestly their own again. The same shape as the download beside it,
   * which is the other thing in this bar that does something rather than being
   * something.
   *
   * The first map goes through the session (see
   * {@link PanelDeckProps.onLeadScale}), because a clip written straight onto
   * its panel is one the next render puts back — its colour lives in the view
   * state. Every other panel is told directly: a companion's scale is its own
   * and is in no state to be restored from.
   */
  private fixScales(): void {
    const look = this.starredLook()
    if (look === null) return
    if (this.starred !== LEAD_MAP) this.props.onLeadScale?.(look)
    for (const slot of this.slots) {
      if (slot.id === this.starred) continue
      slot.panel?.applyLook(look)
    }
    this.warn('')
  }

  /** The bin size the deck is being asked to put every panel on. */
  private starredBinsize(): number | undefined {
    const panel = this.starredPanel
    if (panel !== null) return panel.binsize()
    return this.props.binsize?.()
  }

  /**
   * Read every panel at the starred map's bin size — the *fix all resolutions*
   * press.
   *
   * An action for {@link fixScales}'s reason, and **exact** for
   * {@link MapPanel.useBinsize}'s: a file that has not got that level stays
   * where it is and says so under its own map, rather than being moved to the
   * nearest thing and leaving the deck at two resolutions under a button that
   * has just claimed one. The first map is named in the deck's own line instead,
   * since it is the one panel with no frame of its own to be told in.
   */
  private fixResolutions(): void {
    const binsize = this.starredBinsize()
    if (binsize === undefined || !Number.isFinite(binsize) || binsize <= 0) return
    const refused: string[] = []
    if (this.starred !== LEAD_MAP && this.props.onLeadBinsize?.(binsize) === false) {
      refused.push(this.props.leadName?.() ?? 'the first map')
    }
    for (const slot of this.slots) {
      if (slot.id === this.starred || slot.panel === null) continue
      if (!slot.panel.useBinsize(binsize)) refused.push(fileLabel(slot.panel.uri))
    }
    this.warn(
      refused.length === 0
        ? ''
        : `${refused.join(', ')} ${refused.length === 1 ? 'has' : 'have'} no ` +
          `${fmt.bp(binsize)} level and stayed where ${refused.length === 1 ? 'it is' : 'they are'}.`,
    )
  }

  /**
   * Take every companion to the resolution the session's own map just moved to.
   *
   * A reader who changes the first map's rung means the deck, not one cell of
   * it: the whole claim a deck makes is that its pictures are of one place and
   * can be read against each other, and half of them at 1 kb beside the rest at
   * 10 kb is a claim it is no longer making. The same rule
   * {@link fixResolutions} follows — exact, or the panel stays where it is and
   * says why — because *this file has not got that level* is a fact about the
   * file that no amount of good intention changes.
   *
   * Watched from {@link apply} rather than reported by the session, so every
   * road to a new rung arrives here: the breadcrumb's picker, a link, and the
   * deck's own button.
   */
  private followLeadResolution(binsize: number): void {
    for (const slot of this.slots) slot.panel?.useBinsize(binsize)
  }

  /**
   * Show the add row and put the caret in it — the shell's "add a map", and the
   * bar's own button.
   *
   * The bar is repainted because the button is a toggle and says which way it
   * is pointing; that is cheap and it is what {@link paintBar} is for.
   */
  promptAdd(): void {
    this.addRow.classList.remove('hidden')
    this.paintBar()
    this.urlInput.focus()
  }

  /** Put the add row away again, without opening anything. */
  private hideAdd(): void {
    if (this.addRow.classList.contains('hidden')) return
    this.addRow.classList.add('hidden')
    this.paintBar()
  }

  /**
   * Every map a track can be drawn on, in the order they are on screen.
   *
   * The lead first, because it is cell 0 and always is. An empty cell is not
   * offered: a placement on a map that holds no file would be a lane waiting
   * for a picture, and the reader can place it the moment one arrives.
   */
  get mapList(): Array<{ id: string; label: string }> {
    const out = [{ id: LEAD_MAP, label: this.props.leadLabel?.() ?? 'this map' }]
    for (const slot of this.slots) {
      if (slot.panel === null) continue
      // The panel's **own** URI, which is neither the ref's nor the slot's id.
      // Not the id: it used to fall back to one for anything that was not a
      // remote file, which is every local companion — so a reader who dropped
      // `rep2.cool` on a cell was offered `p3` as the name of the map to draw
      // their bigWig on, in a list where every other row said what it was. And
      // not the ref's URI either, because a companion that descended into an
      // entry of a collection is showing `rep2.mcool::1000` and the ref catches
      // up to that only after `onResolved` has been round the houses.
      out.push({ id: slot.id, label: fileLabel(slot.panel.uri) })
    }
    return out
  }

  /** `true` when there is nothing here but the lead — the deck may be put down. */
  get isEmpty(): boolean {
    return this.slots.length === 0
  }

  relayout(): void {
    for (const slot of this.slots) slot.panel?.remeasure()
  }

  /** Ask every companion for a frame; see `MatrixPanel.repaint` (§8.12). */
  repaint(): void {
    for (const slot of this.slots) slot.panel?.repaint()
  }

  destroy(): void {
    this.destroyed = true
    // Before anything else: the heading is the *view's*, it outlives this deck,
    // and a session that puts its last companion down must get it back rather
    // than lose its locus box with the grid.
    this.lowerHead()
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
    this.lead?.setLaneListener(null)
    this.lead?.setHoverListener(null)
    this.lead?.setLaneHoverListener(null)
    // …and the room it was holding for maps that are no longer beside it, or the
    // last panel put down would leave the first one padded out for ever.
    this.lead?.setLaneFloor({ top: 0, right: 0, bottom: 0, left: 0 })
    this.lead = null
  }

  /**
   * Put a small mark where one panel's pointer is on every *other* panel.
   *
   * The full crosshair stays where the pointer is, and that asymmetry is the
   * whole design: exactly one map has a pointer over it, and five sets of rules
   * across five pictures claim five pointers while covering the data the deck
   * exists to compare. What the others owe the reader is *where is that here*,
   * which a cross the size of a cursor answers.
   *
   * Converted through **base pairs from each block's own start**, as the lock
   * is and for the same reason: a 1 kb file and a 5 kb file answer one name with
   * blocks of different cell counts, and a mark placed by cell index would land
   * five times too far along the coarse one. Cheap enough to run per pointer
   * move — two divisions per panel, and each panel repaints only when its own
   * cell actually changed.
   */
  private echoHover(
    from: string,
    source: MatrixPanel,
    cell: { row: number; col: number } | null,
  ): void {
    const bpPerCell = source.bpPerCell()
    const at =
      cell === null ? null : { rows: (cell.row + 0.5) * bpPerCell, cols: (cell.col + 0.5) * bpPerCell }
    const show = (id: string, panel: MatrixPanel | null): void => {
      if (panel === null || id === from) return
      if (at === null) {
        panel.showHoverEcho(null)
        return
      }
      const theirs = panel.bpPerCell()
      const extent = panel.cellCount()
      const row = Math.floor(at.rows / (theirs > 0 ? theirs : 1))
      const col = Math.floor(at.cols / (theirs > 0 ? theirs : 1))
      // Off the end of a shorter block is *nothing here*, not the last cell: a
      // mark clamped to the edge would say the pointer is over a place this
      // file has, which is the one thing a deck must not claim.
      const inside = row >= 0 && col >= 0 && row < extent.rows && col < extent.cols
      panel.showHoverEcho(inside ? { row, col } : null)
    }
    show(LEAD, this.lead)
    for (const slot of this.slots) show(slot.id, slot.panel?.map ?? null)
  }

  /**
   * The same, for a pointer on a **track** rather than on a map.
   *
   * A hand moving along one profile is asking "what is here" of every profile on
   * screen — that is what a deck is for — and until now it was asked of one. The
   * panel under the pointer draws its own full guide; the others get a tick in
   * the stacks that measure the same axis and a small mark where that place
   * stands on their picture ({@link MatrixPanel.showLaneEcho}).
   *
   * Converted through base pairs from each block's own start, exactly as
   * {@link echoHover} is and for the same reason — and here the conversion earns
   * its keep twice over, because a **turned** panel counts its columns in half
   * bins. A unit carried across untouched would land at half the position on a
   * band beside a square, or twice it the other way; a base pair is a base pair
   * on both.
   *
   * Fractional at the far end, unlike the cell echo: what is being carried is a
   * position rather than a cell, and rounding it onto a cell boundary would move
   * the mark by half a bin on the coarser panel — visible at the zoom a reader
   * hovers a track at, and pointless, since nothing downstream indexes with it.
   */
  private echoLaneHover(
    from: string,
    source: MatrixPanel,
    at: { axis: 'rows' | 'cols'; unit: number } | null,
  ): void {
    const bpPerCell = source.bpPerCell()
    const show = (id: string, panel: MatrixPanel | null): void => {
      if (panel === null || id === from) return
      if (at === null) {
        panel.showLaneEcho(null)
        return
      }
      const extent = panel.cellCount()
      const unit = carriedUnit(
        { unit: at.unit, bpPerCell },
        {
          bpPerCell: panel.bpPerCell(),
          cells: at.axis === 'cols' ? extent.cols : extent.rows,
        },
      )
      panel.showLaneEcho(unit === null ? null : { axis: at.axis, unit })
    }
    show(LEAD, this.lead)
    for (const slot of this.slots) show(slot.id, slot.panel?.map ?? null)
  }

  /**
   * Reserve, on every panel, the room the *deepest* stack on each edge takes.
   *
   * The deck's whole promise is that the pictures in it are of one place and
   * can be read against each other, and a map inset by a stack of tracks beside
   * a map that is not is a comparison the eye has to correct for first.
   *
   * This used to be the lead's own geometry pushed onto companions that had no
   * lanes at all. They can have them now — a track goes on any edge of any map
   * (§16.8) — so the figure is the largest across the deck, and every panel
   * including the lead pads out the difference between that and its own stack.
   *
   * **Pulled, not accumulated.** Each panel announces its stacks whenever they
   * change, and the announcements arrive in no particular order — a companion
   * that finishes reading first reports before the lead has drawn anything. A
   * maximum kept as panels report is therefore a maximum over whoever has
   * spoken so far, which reserved nothing at all on the first pass; asking all
   * of them at the moment of use has no such order to get wrong.
   */
  private align(geometry: PanelGeometry | null): void {
    if (geometry !== null) this.leadGeometry = geometry
    // A floor set on a panel resizes its plot, which is a report, which lands
    // back here. The floors are idempotent, so the second pass changes nothing
    // and stops — but it is still a layout per panel per pass, and this runs
    // from a resize observer.
    if (this.aligning) return
    this.aligning = true
    try {
      const held = this.leadGeometry
      const floor = deepestStacks([
        held.lanes,
        ...this.slots.map((slot) => ({
          top: slot.panel?.laneRoom('top') ?? 0,
          right: slot.panel?.laneRoom('right') ?? 0,
          bottom: slot.panel?.laneRoom('bottom') ?? 0,
          left: slot.panel?.laneRoom('left') ?? 0,
        })),
      ])
      for (const edge of LANE_EDGES) {
        this.grid.style.setProperty(`--deck-lane-${edge}`, `${floor[edge]}px`)
      }
      this.lead?.setLaneFloor(floor)
      for (const slot of this.slots) slot.panel?.setLaneFloor(floor)
      // The lead's plot size, **measured**, not derived a second time from the
      // same variables. A companion sized by the same stylesheet still lands
      // somewhere else — its cell holds different content, so one `clamp`
      // bottoms out where the other is capped by its column — and there is no
      // reading of the rules that fixes that, only a number both can be given.
      const plot = Math.round(held.plot)
      this.grid.style.setProperty('--deck-plot', plot > 0 ? `${plot}px` : '')
      // And its height, which is the width only while the picture is a square.
      // An empty cell is a card the size of a *map*, and it has no map to ask —
      // so with only the width to go on it drew itself square, which under a
      // turn is several times the height of the band beside it, set the height
      // of the whole grid row, and left every map in that row standing at the
      // foot of a rectangle of air (`ui/styles.css`'s `.deck-vacant`).
      const plotHeight = Math.round(held.plotHeight)
      this.grid.style.setProperty('--deck-plot-h', plotHeight > 0 ? `${plotHeight}px` : '')
      for (const slot of this.slots) slot.panel?.remeasure()
    } finally {
      this.aligning = false
    }
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
  private adopt(wanted: readonly PanelRef[], locals: readonly ResolvedLocal[] = []): void {
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
    for (const [index, ref] of wanted.slice(0, MAX_PANELS - 1).entries()) {
      if (ref.kind !== 'vacant') {
        const existing = spare.get(ref.uri)?.shift()
        if (existing !== undefined) {
          reused.add(existing)
          next.push(existing)
          continue
        }
      }
      const local = locals.find((entry) => entry.index === index)
      // A local ref reaching `build` **must** carry its source. Without one it
      // falls through to the remote default, which would fetch a bare file name
      // — against the site root on the web, against `app://viewer/` in the
      // desktop build — and fail in a way that looks like a broken deck rather
      // than a spent grant. `withLocalCompanions` only ever promotes a cell that
      // has one, so this pairing holds by construction; the `??` is the belt.
      if (ref.kind === 'local' && (local?.source ?? null) === null) {
        next.push(this.build({ kind: 'vacant' }, undefined, 'remembered', ref.uri))
        continue
      }
      next.push(
        local === undefined
          ? this.build(ref)
          : local.source === null
            ? this.build(ref, undefined, 'remembered', local.uri)
            : this.build(ref, local.source),
      )
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
    // A link, or a restored session, can name fewer maps than the star knew
    // about — and a star on a slot that was not rebuilt would leave the Analysis
    // column pointed at a picture that is not on screen. Reconciled by
    // `paintGrid`, along with every other way the list can change.
    this.paintGrid()
  }

  private build(
    ref: PanelRef,
    source?: SourceSpec,
    origin: VacancyOrigin = 'link',
    /** The file a `remembered` vacancy is standing in for. */
    name?: string,
  ): Slot {
    // A chain the reader deliberately opened stays open across a rebuild and
    // across a restore: a panel put back on the lead would jump to the deck's
    // window on the first pan, which is the one thing unhooking it said not to
    // do. `locked` where nothing was remembered, which is how a fresh panel
    // arrives (§16.2).
    const held = ref.kind === 'vacant' ? undefined : this.lookFor(ref.uri)
    const slot: Slot = {
      id: `p${nextSlotId++}`,
      ref,
      panel: null,
      vacancy: null,
      locked: held?.locked !== false,
    }
    if (ref.kind === 'vacant') {
      slot.vacancy = new VacantPanel({
        origin,
        ...(name === undefined ? {} : { name }),
        onOpen: (file) => this.fill(slot, { uri: file.name, source: { kind: 'local', file } }),
        // Through `occupy` like the file road, so the cell the reader typed into
        // is the cell that opens — {@link add} would look for the *first* empty
        // one, which in a 2 × 2 with three gaps is not the one they aimed at.
        onOpenUrl: (url) => this.occupy(slot, { kind: 'remote', uri: url }),
        onClose: () => this.remove(slot),
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
      onStar: () => this.setStarred(slot.id),
      isLocked: () => slot.locked,
      lockNote: () => this.lockNote(slot),
      // The region names every panel is following are the *lead's*, so the
      // lead's reading of its own numerals is the one a companion has to
      // resolve them under.
      naming: () => this.props.leadNaming?.(),
      derive: () => this.props.derive?.(),
      turn: () => this.props.turn?.(),
      annotations: () => this.props.annotations?.(slot.id),
      // A track placed on this panel alone changes what every other panel has
      // to leave room for, so its own stacks are the deck's business (§16.8).
      onLanes: () => this.align(null),
      score: () => this.props.score?.(),
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
      // Read against the ref as it stands rather than against the `ref` captured
      // above, because a companion handed a collection resolves itself to one of
      // its entries and rewrites the slot ({@link resolveRef}) — and it is the
      // resolved URI the look was written under.
      remembered: () => (slot.ref.kind === 'vacant' ? undefined : this.lookFor(slot.ref.uri)),
      onLook: (look) => {
        if (slot.ref.kind !== 'vacant') this.noteLook(slot.ref.uri, { ...look, locked: slot.locked })
      },
      preferBinsize: () => this.props.binsize?.(),
      onResolved: (uri) => this.resolveRef(slot, uri),
      onDragChange: (dragging) => this.setArranging(dragging),
      // Against the *slot's* ref rather than the one captured above, for
      // {@link remembered}'s reason: a companion handed a collection rewrites
      // itself into one of its entries, and a name is filed under the file.
      label: () => (slot.ref.kind === 'vacant' ? undefined : this.props.mapLabel?.(slot.ref.uri)),
      onRename: (name) => {
        if (slot.ref.kind !== 'vacant') this.props.onRenameMap?.(slot.ref.uri, name)
      },
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
    // A **starred** panel that moved rung is a different file to an analysis:
    // the facts it answers with name a URI, and the one it was holding pointed
    // at the resolution it used to be at. Nothing else re-reads them — the panel
    // fetches them once and keeps them, which is right, so the invalidation has
    // to happen where the address changes. Without this, picking `::5000` on the
    // starred companion and pressing a task ran it against `::1000` and captioned
    // the result with the rung on screen.
    if (slot.id !== this.starred || slot.panel === null) return
    void slot.panel.prepareAnalysis(() => this.props.onStarChange?.())
    this.props.onStarChange?.()
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
    // Nothing pushed here. A companion opens on the first map's base look and
    // its bin size (§3.4, {@link MapPanelProps.initialLook}), and what the two
    // buttons in the bar do is a *press* rather than a state a newcomer has to
    // be brought into line with.
    this.lock.join({
      id: slot.id,
      bpPerCell: () => map.bpPerCell(),
      cells: () => map.cellCount(),
      locked: () => this.lockNote(slot) === null,
      show: (rows, cols) => map.showViewport(rows, cols),
    })
    map.setViewportListener((rows, cols) => this.lock.report(slot.id, rows, cols))
    map.setHoverListener((cell) => this.echoHover(slot.id, map, cell))
    map.setLaneHoverListener((at) => this.echoLaneHover(slot.id, map, at))
    // Before the lock and before the note: a panel that has just cut its band
    // from whatever height its cell had while the grid was settling is put on
    // the deck's distance first, so `lockNote` is asked about two bands that
    // already agree rather than about a layout race.
    this.syncTurnReach()
    slot.panel?.syncLock()
    this.seedFromLead()
    this.lock.catchUp(slot.id)
    this.paintBar()
  }

  /**
   * Tell the lock where the lead is, for a panel about to be caught up to it.
   *
   * The lock learns a window from a panel *reporting* one, and a panel reports
   * when it draws. Both of the moments a deck catches a panel up are moments
   * where the lead may not have drawn since the lock was built:
   *
   * - a **deck is created** by the reader adding a second map, and the map they
   *   added it beside was drawn — and reported nothing, because until that press
   *   there was no lock listening — while they were choosing the file. So every
   *   pan and zoom they had made up to that point was invisible to the deck, and
   *   the companion opened on its own fitted view: a whole contig beside a lead
   *   showing 40 kb of it, under a bar claiming one navigation.
   * - a **navigation resets** the window ({@link ViewportLock.reset}), and a
   *   companion that finishes its read before the lead has drawn the new block
   *   lands in the same gap.
   *
   * It worked most of the time, which is what made it worth fixing rather than
   * leaving: re-parenting the lead into the grid resizes it, a resize is a
   * redraw and a redraw is a report, so the window usually arrived a frame after
   * the deck was built and a frame before the companion's file had been fetched
   * over the network. A deck that lines up because the network is slower than a
   * relayout is not a deck that lines up.
   *
   * Nothing is seeded from a lead the reader has taken off the lead themselves:
   * an unlocked first map is one that is deliberately not driving, and a
   * companion arriving beside it should be caught up to wherever the *deck* got
   * to, or to nowhere.
   */
  private seedFromLead(): void {
    if (!this.leadLocked) return
    const view = this.lead?.viewport()
    if (view === undefined || view === null) return
    this.lock.seed(view.rows, view.cols, this.lead?.bpPerCell() ?? 1)
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
    // **Neither panel is compared until both have a block.** A panel that has
    // not read one answers `1 × 1` cells, which multiplied by its bin size is a
    // span of one bin — and a companion settling while the lead was still
    // reading was told "this block spans 16.6 Mb × 16.6 Mb where the first map
    // spans 1.0 kb × 1.0 kb. The same name resolved against different
    // sequences", which is an accusation about the files built out of a race.
    // Nothing is owed here: `settle` runs again when the lead reports, and the
    // note is recomputed then against two real blocks.
    if (!map.hasBlock || !lead.hasBlock) return null
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
    // Recorded beside the scale, because to a reader it is the same kind of
    // decision about the same map: *this one is not like the others*. Only a
    // slot with a file behind it — a vacancy has no key to be remembered under.
    if (slot.ref.kind !== 'vacant') {
      const held = this.lookFor(slot.ref.uri) ?? { uri: slot.ref.uri }
      this.noteLook(slot.ref.uri, { ...held, locked: slot.locked })
    }
    if (!slot.locked) return
    this.seedFromLead()
    this.lock.catchUp(slot.id)
  }

  /**
   * The grid's half of the grip gesture: every cell but the lead's is a target.
   *
   * Delegated to the grid rather than wired per cell, because the cells are
   * rebuilt on every change to the deck and a listener per cell is a listener
   * per rebuild. The **lead is excluded** — it is the session's own view
   * re-parented into cell 0, and which file a session is of is not a thing that
   * should change by dragging (§16.9).
   */
  private watchArranging(): void {
    const cellAt = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Node)) return null
      const node = target instanceof Element ? target : target.parentElement
      const cell = node?.closest('.deck-panel') ?? null
      if (cell === null || cell.classList.contains('is-lead')) return null
      return this.grid.contains(cell) ? (cell as HTMLElement) : null
    }
    const indexOf = (cell: HTMLElement): number =>
      Array.prototype.indexOf.call(this.grid.children, cell) - 1
    this.grid.addEventListener('dragover', (event) => {
      // Only a map. A *file* dropped on a cell is a different gesture with a
      // different answer, and it is the cell's own (`MapPanel.VacantPanel`).
      if (event.dataTransfer?.types.includes(DECK_DRAG_TYPE) !== true) return
      const cell = cellAt(event.target)
      if (cell === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      for (const other of this.grid.children) other.classList.toggle('is-target', other === cell)
    })
    this.grid.addEventListener('drop', (event) => {
      if (event.dataTransfer?.types.includes(DECK_DRAG_TYPE) !== true) return
      const cell = cellAt(event.target)
      this.setArranging(false)
      if (cell === null) return
      event.preventDefault()
      const from = this.slots.findIndex((slot) => slot.panel?.el.classList.contains('is-dragging') === true)
      if (from >= 0) this.swap(from, indexOf(cell))
    })
    this.grid.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && this.grid.contains(event.relatedTarget)) return
      for (const other of this.grid.children) other.classList.remove('is-target')
    })
  }

  /**
   * Show the tiling while a map is being dragged, and hide it after.
   *
   * The cells are only worth seeing as *cells* while something is looking for
   * one: a permanent outline round every panel would be a grid drawn over four
   * pictures for the benefit of a gesture nobody is making.
   */
  private setArranging(on: boolean): void {
    this.grid.classList.toggle('is-arranging', on)
    if (!on) for (const cell of this.grid.children) cell.classList.remove('is-target')
  }

  /**
   * Exchange two cells — the drop half of the grip gesture.
   *
   * A swap rather than an insert; see {@link swapItems}. The lead is not in
   * `slots` and cannot be either end of one, which is §16.9's rule showing
   * through: the first map is the session's own view re-parented into cell 0,
   * and "which file is this session of" is not a thing that should change by
   * dragging.
   */
  private swap(from: number, to: number): void {
    // Out of range as well as equal: `swapItems` answers both with a copy, so a
    // drop that landed nowhere used to repaint the grid and rewrite the hash
    // with the list it already had. The identity check that stood here instead
    // could never fire — `swapItems` returns a new array unconditionally.
    if (from === to || from < 0 || to < 0 || from >= this.slots.length || to >= this.slots.length) {
      return
    }
    this.slots = swapItems(this.slots, from, to)
    this.paintGrid()
    this.publish()
  }

  /**
   * Arm every map in the deck for placing marks.
   *
   * The session arms its own panel beside this one and hands both the same
   * `onEnd`, so whichever map the reader places on — and whichever one they
   * press Escape over — ends the mode everywhere. Without that the gesture would
   * be armed on five panels and disarmed on one, and the four left over would
   * go on swallowing clicks that the reader had meant as navigation.
   *
   * @returns a function that disarms every panel this armed.
   */
  armPicking(handlers: PickHandlers, onEnd: () => void = () => {}): () => void {
    const cancels = this.slots
      .map((slot) => slot.panel?.armPicking(handlers, onEnd))
      .filter((cancel): cancel is () => void => cancel !== undefined)
    return () => {
      for (const cancel of cancels) cancel()
    }
  }

  /**
   * Every map that can be analysed, lead first and then the grid in reading
   * order — what "run this on all of them" means.
   *
   * A companion appears only once it has answered for itself: the two tables an
   * analysis needs are fetched on demand, so a panel still reading is a panel a
   * batch cannot yet price. Asked again on the next press rather than waited
   * for, because a reader pressing the button while a map is still opening has
   * asked about the maps that are *there*.
   */
  analysable(): Array<{ map: MapId; panel: MapPanel }> {
    const out: Array<{ map: MapId; panel: MapPanel }> = []
    for (const slot of this.slots) {
      if (slot.panel === null) continue
      out.push({ map: slot.id, panel: slot.panel })
    }
    return out
  }

  /** The map an analysis runs against; the lead unless a companion is starred. */
  get starredMap(): MapId {
    return this.starred
  }

  /**
   * The starred **companion**, or `null` when the star is on the lead.
   *
   * `null` is the ordinary answer and the one the session reads as "carry on as
   * before": the lead's own facts are the ones it has always used, and nothing
   * about the Analysis column changes while the star has not moved.
   */
  get starredPanel(): MapPanel | null {
    if (this.starred === LEAD_MAP) return null
    return this.slots.find((slot) => slot.id === this.starred)?.panel ?? null
  }

  /**
   * Move the star, or leave it where it is.
   *
   * Silent about a map that is not here: a starred slot that has been closed
   * comes back as the lead through {@link keepStarPresent}, and a caller asking
   * for one that never existed is asking about a deck it has stale knowledge of.
   */
  setStarred(map: MapId): void {
    if (map === this.starred) return
    if (map !== LEAD_MAP && !this.slots.some((slot) => slot.id === map)) return
    this.starred = map
    remember(this.props.memoryKey(), 'deck:starred', map)
    this.paintStars()
    // The bar's two switches say which map they read *from*, so moving the star
    // rewrites both of them — and applies them, because "fix all scales" over a
    // deck whose star has moved means the new map's scale from that moment.
    this.paintBar()
    // The facts an analysis needs are two reads a drawing panel never makes, so
    // they are fetched when the star lands rather than when the panel opens —
    // an eight-panel deck does not read sixteen tables to show eight pictures.
    // The column re-prices when they land, and again now for the star itself.
    const panel = this.starredPanel
    if (panel !== null) void panel.prepareAnalysis(() => this.props.onStarChange?.())
    this.props.onStarChange?.()
  }

  /**
   * Put the star back on the lead if the map it was on is not here.
   *
   * Called from {@link paintGrid}, so it runs on every change to the list
   * whatever caused it. A star pointing at a panel that is not on screen is
   * worse than one pointing at nothing: the Analysis column goes on offering
   * tasks priced against a file the reader cannot see, every result is adopted
   * onto a map with no panel to draw it, and no star anywhere is filled — so
   * there is no control to move it back with either.
   *
   * "Not here" and not "closed": the star is *restored* from this file's memory
   * (see {@link starred}), and a slot id is minted from a counter that keeps
   * climbing for the life of the tab. Across a reload the counter starts again
   * and the restored id names the same position in the same link, which is what
   * makes remembering it worth doing; within one session it names a slot that
   * was thrown away, and only a reconciliation that runs on *arrival* as well as
   * on departure catches that.
   */
  private keepStarPresent(): void {
    if (this.starred === LEAD_MAP) return
    if (this.slots.some((slot) => slot.id === this.starred)) return
    this.starred = LEAD_MAP
    remember(this.props.memoryKey(), 'deck:starred', LEAD_MAP)
    this.paintBar()
    this.props.onStarChange?.()
  }

  /**
   * A map was renamed: put the new name where the old one was.
   *
   * Pushed rather than pulled, unlike everything else the deck shares, because
   * a name is written into the DOM once and then left alone — the headings are
   * not rebuilt per frame, which is the property that lets a reader type into
   * one without it being taken away under them.
   */
  renamed(): void {
    this.paintLeadHead()
    for (const slot of this.slots) slot.panel?.syncName()
  }

  /** Repaint every star, so exactly one of them is filled. */
  private paintStars(): void {
    this.leadStar.classList.toggle('is-on', this.starred === LEAD_MAP)
    this.leadStar.setAttribute('aria-pressed', String(this.starred === LEAD_MAP))
    this.leadStar.disabled = this.starred === LEAD_MAP
    this.leadStar.title = starTitle(this.props.leadName?.() ?? 'this map', this.starred === LEAD_MAP)
    for (const slot of this.slots) slot.panel?.setStarred(this.starred === slot.id)
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
  private fill(slot: Slot, picked: PickedFile): void {
    this.occupy(
      slot,
      { kind: picked.source.kind === 'local' ? 'local' : 'remote', uri: picked.uri },
      picked.source,
    )
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
    this.addPicked({ uri: file.name, source: { kind: 'local', file } })
  }

  /**
   * One more map from a file that may be anywhere.
   *
   * The currency the edges and the vacant cells speak, since a row dragged out
   * of the Files panel is as likely to be an object on a bucket as a file on the
   * disk — and a `PickedFile` is exactly the pair `add` already takes, so this
   * is a rename rather than a second road in.
   */
  private addPicked(picked: PickedFile): void {
    this.add(
      { kind: picked.source.kind === 'local' ? 'local' : 'remote', uri: picked.uri },
      picked.source,
    )
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
      this.hideAdd()
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
    this.hideAdd()
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
  grow(direction: GrowDirection, picked?: PickedFile): void {
    const shape = { cells: this.slots.length + 1, columns: this.columnsNow() }
    const next = grownDeck(shape, direction)
    if (next.cells > MAX_PANELS) {
      // A file that came with the press is not lost with it. There is no room
      // for a cell, but there may be an empty one already — and dropping a
      // cooler on a full deck to be told a number is a worse answer than
      // opening it where the deck has space.
      if (picked !== undefined) this.addPicked(picked)
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
    if (picked === undefined || first === undefined) {
      this.paintGrid()
      this.publish()
    } else {
      // Paints and publishes on its way through, with the cell already filled,
      // so the hash is written once rather than as a vacancy and then a map.
      this.fill(first, picked)
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
    const refs = this.slots.map((slot) => slot.ref)
    const value = serialiseMaps(refs)
    this.published = { value }
    // …and the half the hash cannot carry, into this session's own memory
    // beside the columns and the star. Written on every publish rather than on
    // a save, for the reason every other scope here is: what storage holds *is*
    // the session, so a reload and an exported workspace restore the same deck.
    remember(this.props.memoryKey(), 'deck:locals', localCompanions(refs))
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
    // Every panel that has just been built needs to be told whether its star is
    // filled: which one it is belongs to the deck, and a panel has no way to
    // ask (see {@link starred}).
    // Before the stars are painted, because it decides which one is filled, and
    // here rather than at each of the places a cell leaves. It used to be called
    // from `adopt`, `remove` and `closeDeck`, which is every way a slot can
    // *depart* and not the way a dangling star actually arises: the star is
    // restored from this file's memory in the constructor, `adopt` runs only
    // when the hash names a different list from the one this deck published, and
    // a deck built by "add a map" publishes an empty list and matches. So a
    // reader who starred a companion, closed the deck and opened another one got
    // a deck whose star named a slot it had never built — no star filled
    // anywhere, the lead's own offering to make it the target it already was,
    // and every task's result adopted onto a map with no panel to draw it.
    this.keepStarPresent()
    this.paintStars()
    this.keepLanesOnLiveMaps()
    this.applyLayout()
  }

  /**
   * The heading over the session's own cell: its name, and no grip.
   *
   * No grip because the first map is always the lead (§16.9) — it is the
   * session's view re-parented into cell 0, it owns the breadcrumb and the
   * tables and the tracks, and "which file is this session of" is not a thing
   * that should change by dragging. A name, because every other cell has one.
   */
  private paintLeadHead(): void {
    const name = this.props.leadName?.()
    if (name === undefined) {
      this.leadHead.replaceChildren()
      this.leadHead.classList.add('hidden')
      return
    }
    this.leadHead.classList.remove('hidden')
    const title = `${name} — the map this session is of, and the one the others follow`
    const rename = this.props.onRenameLead
    this.leadHead.replaceChildren(
      rename === undefined
        ? el('span', { class: 'deck-name', text: name, title })
        : renameBox(name, title, rename),
      this.leadStar,
    )
    this.paintStars()
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
    // One row of everything until somebody says otherwise, which is what a deck
    // assembled a file at a time — through the palette, or from a link — has
    // always been: side by side is how a figure compares conditions.
    if (this.columns === null) return cells
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

    // The one control that puts a map *into* the deck, and the reason it is
    // here: the row of boxes below the bar takes a file or a URL, and until now
    // nothing on screen opened it. It was reachable from the command palette
    // alone — so a reader with a published cooler and a deck in front of them
    // had a drop rectangle for a local file and no way at all to name a remote
    // one, which is the road §11 exists for. A `+` on an edge draws a *cell*
    // (§16.9); this opens a map.
    const adding = !this.addRow.classList.contains('hidden')
    const addMap = button(
      adding ? 'cancel' : 'add a map…',
      () => (adding ? this.hideAdd() : this.promptAdd()),
      {
        class: `btn deck-add-toggle${adding ? ' is-on' : ''}`,
        title:
          'Open one more map beside these: choose a file, or paste the URL of a published one. It ' +
          'lands in the first empty cell if the deck has one, and at the end if it has not.',
      },
    )

    // **Two actions, not two modes**, and bordered like the chain beside them
    // because that is what they are: things that *do* something, pressed once
    // and finished, in a bar whose other members are the download and the copy.
    //
    // A mode here made a promise it could not keep. `one scale`, left on, meant
    // that every later nudge of any panel's clip either had to be undone or left
    // the deck claiming a shared scale it no longer had; and a resolution mode
    // has the same problem the moment a reader picks a rung on one panel. A
    // press says a thing that stays true — *these are all on that one's numbers
    // now* — and the very next nudge is honestly their own again.
    //
    // Both read from the **starred** map, which is the one every other "all of
    // them" in this app is measured from: it is what a task runs against
    // (§18.2), and making it what the scale and the rung come from too is one
    // idea rather than three.
    const starName = this.starredName()
    const share = button('fix all scales', () => this.fixScales(), {
      class: 'btn deck-share',
      title:
        `Draw every panel on ${starName}’s clip — the starred map — so the same colour is the ` +
        'same number of contacts across the deck. True only where the libraries are comparable, ' +
        'which is why it is a press rather than a setting: nudge any panel’s clip afterwards and ' +
        'that panel is on its own values again (§7.1).',
    })

    const resolutions = button('fix all resolutions', () => this.fixResolutions(), {
      class: 'btn deck-resolutions',
      title:
        `Read every panel at ${starName}’s bin size — the starred map. A file that has no such ` +
        'level stays where it is and says so under its own map, rather than being moved to the ' +
        'nearest thing and leaving the deck at two resolutions. Changing the first map’s ' +
        'resolution does this on its own.',
    })

    const leadLock = iconButton(
      this.leadLocked ? 'link' : 'unlink',
      this.leadLocked
        ? 'The first map is driving the deck. Click to let it move on its own.'
        : 'The first map is moving on its own. Click to put it back in step.',
      () => {
        this.leadLocked = !this.leadLocked
        if (this.leadLocked) {
          // Seeded first, so putting the first map back in step over a deck that
          // has not moved leaves the deck knowing where it is looking rather
          // than nowhere — which is what the next companion catches up to.
          this.seedFromLead()
          this.lock.catchUp(LEAD)
        }
        this.paintBar()
      },
      { class: `btn btn-icon deck-lock${this.leadLocked ? '' : ' is-off'}`, size: 14 },
    )

    // The preset row's honest replacement, and the only control here that is
    // about the deck's *shape*. Without it a deck that arrived in a link could
    // never be reshaped at all: a `+` only ever grows one.
    const columns = el('select', { class: 'select select-tiny deck-columns' })
    for (let n = 1; n <= cells; n++) {
      columns.appendChild(el('option', { value: String(n), text: `${n} across` }))
    }
    columns.value = String(this.columnsNow())
    columns.title = 'How many maps in a row. A `+` on an edge opens cells; this arranges them.'
    columns.addEventListener('change', () => this.setColumns(Number(columns.value)))

    const save = iconButton(
      'download',
      'Save the whole deck as one figure, laid out as it is on screen',
      () => void this.saveDeck(),
      { class: 'btn btn-icon deck-save', size: 14 },
    )

    // Beside the download, exactly as it is on a single map's Export card: they
    // are the same figure going to two places, and ⌘C is the key that reaches
    // this one (`ui/commands.ts`'s `copyPlot`, routed here by `app/Session.ts`
    // whenever a deck is on).
    const copy = iconButton(
      'clipboard-copy',
      withKey('Copy the whole deck as one PNG, laid out as it is on screen', KEYS.copyPlot),
      () => void this.copyDeck(),
      { class: 'btn btn-icon deck-copy', size: 14 },
    )

    // The one control that takes the deck away, and the only one on the right.
    //
    // Every button in this bar acts on the deck as it stands; this one ends it,
    // and a destructive control sitting in the middle of a row of adjustments is
    // one a hand reaches by accident. So the row is read from the left and this
    // is at the far end of it, which is where a window's close has been for
    // thirty years. What it closes is stated rather than implied — the maps and
    // whatever was loaded only for them ({@link closeDeck}).
    const close = iconButton(
      'x',
      'Close the deck: every companion map, and any track loaded only for them. The first map, ' +
        'and everything drawn on it, stays exactly as it is.',
      () => this.closeDeck(),
      // The same bare mark a panel's own close is, so the two read as one
      // gesture at two scales: this one takes the row, that one takes a cell.
      { class: 'btn-close deck-close', size: 14 },
    )

    // How many maps is a fact about *what is being looked at*, so it goes in the
    // line that already says that — beside the block's size and the window's
    // span, in the view's own summary — rather than in a bar of controls. The
    // empty cells are counted apart rather than folded in, because "4 maps"
    // over a 2 × 2 grid with two rectangles in it is the deck telling the reader
    // something they can see is untrue.
    // The separator only where there is something in front of it: the summary is
    // empty until the first block lands, and a line opening with a bullet is a
    // sentence with its first clause missing.
    const said = this.deckNote.previousElementSibling?.textContent ?? ''
    // Singular where there is one, which is a state a reader does see: pressing
    // "add a map" builds the deck and shows its bar *before* a file has been
    // chosen, and "1 maps" over one map is the deck's first sentence.
    const count = empty === 0 ? `${filled} map${filled === 1 ? '' : 's'}` : `${filled} of ${cells} maps`
    this.deckNote.textContent = `${said === '' ? '' : ' · '}${count}`
    this.deckNote.title =
      `A deck of ${this.rows()} × ${this.columnsNow()}` +
      (empty === 0 ? '' : `, ${empty} empty — drop a file on one to open it there`) +
      '. One navigation across every panel: the region, the level and the score are shared, ' +
      'and each panel keeps its own colour scale. The chain on a panel takes it off the lead.'

    // One left-aligned run, and one button at the far right.
    //
    // The spacer used to sit second, which split the bar into a chain on the
    // left and three controls floated over against the right-hand edge — two
    // groups, for a row that is one group. On a wide window the two halves ended
    // up a screen apart, so reading the bar meant looking in two places, and
    // which half a control was in said nothing about what it did. Everything
    // that *adjusts* the deck now reads left to right in one run, and the only
    // thing across the gap is the one that ends it.
    // Adding a map first, then the two presses, then the chain, then the shape,
    // then the two exports — which is the order a reader works in: get the maps
    // on screen, put them on one footing, decide whether they move together,
    // arrange them, take the picture. The one control that ends the deck stays
    // across the gap.
    this.toolbar.replaceChildren(
      addMap,
      share,
      resolutions,
      leadLock,
      columns,
      save,
      copy,
      el('span', { class: 'deck-spacer' }),
      close,
    )
  }

  /**
   * Put the whole deck down: every companion, and every lane that was on one.
   *
   * The maps are the easy half. The other half is the tracks, and the rule is
   * that a deck put down is a statement about **layout** and never about what
   * the reader has imported. A bigWig dropped on a companion's edge is an import
   * into the session's one track list (`annotations/placement.ts`), and the
   * lanes it had on the maps that are leaving go with them — but the track
   * itself stays, as a row on the Annotations panel that is drawn nowhere, which
   * is a state the model has always had and is one tick from being on the lead.
   *
   * It used to be a deletion, and the deletion was uneven in a way that read as
   * a bug: a track the reader had *also* put on the lead survived, and one they
   * had only ever put on a companion did not — so opening four replicates,
   * giving each its own bigWig and then closing the deck lost three imports to a
   * gesture about how many pictures are on screen.
   *
   * The lead is not in `slots` and is untouched throughout: §16.9's rule is that
   * the first map is the session's own view, and closing a deck must leave the
   * session exactly where closing the last companion one at a time would.
   */
  private closeDeck(): void {
    if (this.slots.length === 0) return
    for (const slot of this.slots) {
      this.lock.leave(slot.id)
      slot.panel?.destroy()
      slot.vacancy?.destroy()
    }
    this.slots = []
    // The star comes back to the lead and the lanes go with the maps, the
    // tracks staying behind — both from `paintGrid`, which runs for every other
    // way a cell can leave as well ({@link keepStarPresent},
    // {@link keepLanesOnLiveMaps}).
    this.paintGrid()
    // Which leaves the deck empty, so the session's next render puts it down and
    // hands the view back its own frame (`app/Session.ts`'s `syncDeck`).
    this.publish()
  }

  /**
   * Take a departed map's tracks *off the map*, and keep the tracks.
   *
   * A track and its placement are two different things (`annotations/placement.ts`),
   * and a map leaving the deck is a statement about the second. The map is gone,
   * so its lanes are gone with it — but the *import* is a file the reader
   * dropped, parsed once, named, coloured and possibly edited, and a cell being
   * closed is not a reason to have thrown it away. A track with no lanes is a
   * state the model has always had and is exactly the one this leaves: still on
   * the Annotations panel, drawn nowhere, one tick from being on the lead.
   *
   * It used to `remove` any track the departing maps were the only reason for,
   * which meant a reader who opened four replicates, gave each its own bigWig
   * and then closed the deck lost three imports to a gesture about layout. The
   * ones they had also put on the lead survived, which made the loss look
   * arbitrary rather than deliberate.
   *
   * **From `paintGrid`, so it runs wherever the list changes**, which is
   * `keepMaps`'s own stated contract — "reconciled against the deck rather than
   * driven by an event … doing it once per render cannot go stale" — and which
   * it was not getting. The only caller was the deck's own close, so closing
   * *one* companion out of four, or following a link that named fewer maps than
   * the deck held, left that map's lanes in the store bound to a slot id nothing
   * would ever mint again: invisible, because the placement control lists the
   * maps that exist and a lane on one that does not has no row to be unticked
   * from, and still counted by everything that asks a track how many maps it is
   * on.
   *
   * Keyed on the **slots**, not on the panels. A companion whose current view is
   * a table has no `MatrixPanel` for a moment (`panels/MapPanel.ts` drops it for
   * a plan of `none`) and is still very much a map in the deck; pruning against
   * the panels would delete the reader's placements the first time they opened a
   * genomes table.
   */
  private keepLanesOnLiveMaps(): void {
    const store = this.props.annotations?.(LEAD_MAP)?.store
    if (store === undefined) return
    // Which file each cell is showing, told to the store *while the cell is
    // alive* — a slot id is minted per deck and never minted again, so the
    // moment a map leaves there is nothing left to say which file it was. The
    // panel's own URI where there is one, so a companion that descended into an
    // entry of a collection is keyed by the map it is actually drawing.
    const files = new Map<MapId, string>()
    for (const slot of this.slots) {
      const uri = slot.panel?.uri ?? (slot.ref.kind === 'vacant' ? undefined : slot.ref.uri)
      if (uri !== undefined) files.set(slot.id, uri)
    }
    store.noteMapFiles(files)
    // Parks what left onto the lead, keyed by that file…
    store.keepMaps(new Set<MapId>([LEAD_MAP, ...this.slots.map((slot) => slot.id)]))
    // …and hands it back to whichever cell is showing that file now, which is
    // what makes closing a deck and opening it again put the tracks back where
    // the reader had them. Both directions in one pass, on every render, for
    // `keepMaps`'s own reason: a reconciliation cannot go stale and an event can.
    for (const [map, uri] of files) store.adoptHome(map, uri)
  }

  /**
   * Save the whole deck as one figure — the download in the bar.
   *
   * The picture is {@link composeDeck}'s; this is the half that names a file and
   * hands it to the browser. Its twin is {@link copyDeck}, and the two share the
   * drawing for the reason a single map's save and copy do: they are the same
   * figure going to two places, and a second composition would be a second thing
   * to keep in step.
   */
  private async saveDeck(): Promise<void> {
    const now = new Date()
    const out = this.composeDeck(now)
    if (out === null) return
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    if (blob === null) return
    downloadBlob(blob, `deck-${fileStamp(now)}-${DECK_EXPORT_DPI}dpi.png`)
  }

  /**
   * The same figure onto the clipboard — ⌘C, and the button beside the save.
   *
   * The key already copied *a* plot while a deck was on, and it copied the lead:
   * one cell out of six, which on a screen showing six is the answer to a
   * question nobody asked. With a deck up, "the figure" is the deck — that is
   * what the reader arranged and what they are looking at — so the key follows
   * the picture rather than the panel it happens to have been bound to
   * (`app/Session.ts`).
   *
   * PNG, like every other clipboard export here: a clipboard holds an image, and
   * a PDF pasted into a slide arrives as a file attachment instead of a picture.
   */
  async copyDeck(): Promise<void> {
    const out = this.composeDeck(new Date())
    if (out === null) return
    try {
      await copyPngToClipboard(canvasToPng(out))
      this.warn('')
    } catch (err) {
      // In the deck's own bar, where its other refusals go — see {@link NO_ROOM}.
      // A clipboard write can be refused outright by a browser that has not been
      // given permission, and a key that silently does nothing reads as broken.
      this.warn(err instanceof Error ? `copy failed: ${err.message}` : 'copy failed')
    }
  }

  /**
   * Every panel drawn into one canvas, laid out as it is on screen.
   *
   * The thing somebody assembling a figure actually wants, and the one export no
   * panel can produce for itself. Each panel draws its own — the same
   * `exportCanvas` the single map has always had, at the same dpi, with its own
   * key in its own corner — and they are placed into the grid the reader drew,
   * every cell the size of the largest so the columns line up. An empty cell is
   * left empty rather than closed up: it is part of the arrangement, and a
   * figure that silently reflowed on the way to disk would not be the picture
   * that was on screen.
   *
   * `null` only where there is no 2d context to draw into, which is a browser
   * that cannot export at all rather than a deck that cannot.
   */
  private composeDeck(now: Date): HTMLCanvasElement | null {
    const maps = [this.lead, ...this.slots.map((slot) => slot.panel?.map ?? null)]
    const drawn = maps.map((panel) => {
      try {
        return panel === null ? null : panel.exportCanvas(DECK_EXPORT_DPI, now)
      } catch {
        // One panel past what a browser will rasterise must not take the other
        // five with it; the gap says which one, and every other cell is right.
        return null
      }
    })
    const cellWidth = Math.max(1, ...drawn.map((canvas) => canvas?.width ?? 0))
    const cellHeight = Math.max(1, ...drawn.map((canvas) => canvas?.height ?? 0))
    const columns = this.columnsNow()
    const rows = Math.ceil(drawn.length / columns)
    const gap = Math.round(cellWidth * DECK_EXPORT_GAP)

    const out = document.createElement('canvas')
    out.width = columns * cellWidth + (columns - 1) * gap
    out.height = rows * cellHeight + (rows - 1) * gap
    const ctx = out.getContext('2d')
    if (ctx === null) return null
    ctx.fillStyle = readPageBackground()
    ctx.fillRect(0, 0, out.width, out.height)
    drawn.forEach((canvas, cell) => {
      if (canvas === null) return
      const column = cell % columns
      const row = Math.floor(cell / columns)
      ctx.drawImage(canvas, column * (cellWidth + gap), row * (cellHeight + gap))
    })
    return out
  }

  private warn(message: string): void {
    this.warning.textContent = message
    this.warning.classList.toggle('hidden', message === '')
  }

  /** Rows the grid needs for the cells it has, at the current column count. */
  private rows(): number {
    return Math.ceil((this.slots.length + 1) / this.columnsNow())
  }

  private setColumns(columns: number): void {
    this.columns = columns
    remember(this.props.memoryKey(), 'deck:columns', columns)
    this.applyLayout()
    this.paintBar()
  }

  /** What to call the starred map in a sentence about it. */
  private starredName(): string {
    if (this.starred === LEAD_MAP) return this.props.leadName?.() ?? 'the first map'
    const panel = this.starredPanel
    return panel === null ? 'the starred map' : fileLabel(panel.uri)
  }

  /** The lead's colour scale, for the panels that have opted to share it. */
  private leadLook(): ScaleState {
    const scale = this.lead?.scale()
    return scale === undefined ? {} : scaleState(scale)
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

  /** What a previous visit remembered about how each companion was drawn. */
  private recallLooks(): DeckLook[] {
    const stored = recall<unknown>(this.props.memoryKey(), LOOKS_SCOPE)
    if (!Array.isArray(stored)) return []
    const out: DeckLook[] = []
    for (const entry of stored as unknown[]) {
      const look = readDeckLook(entry)
      if (look !== null) out.push(look)
    }
    return out
  }

  /** This companion's remembered look, for the panel about to draw it. */
  private lookFor(uri: string): DeckLook | undefined {
    return this.looks.find((look) => look.uri === uri)
  }

  /**
   * Write down how one companion is drawn.
   *
   * Keyed by the file rather than by the slot, and merged rather than appended:
   * the reasons are `DeckLook`'s own. Written on every change rather than on a
   * save, for the reason every other scope here is written that way — what
   * storage holds *is* the session, so a reload, a durable restore and an
   * exported workspace all describe the same deck.
   */
  private noteLook(uri: string, look: Omit<DeckLook, 'uri'>): void {
    this.looks = withLook(this.looks, { ...look, uri })
    remember(this.props.memoryKey(), LOOKS_SCOPE, this.looks)
    this.props.onLooksChange?.()
  }
}

/** Where a deck's per-companion presentation lives in this session's memory. */
const LOOKS_SCOPE = 'deck:looks'

/**
 * A panel's live scale as the thing another panel can be handed.
 *
 * `NaN` is how a `ColorScale` spells *auto* and `undefined` is how a
 * {@link ScaleState} does, so the two cannot simply be copied across: a `NaN`
 * passed on as a clip is a clip nothing is ever inside.
 */
function scaleState(scale: {
  transform: ScaleState['transform']
  colormap: string
  vmin: number
  vmax: number
}): ScaleState {
  return {
    transform: scale.transform,
    colormap: scale.colormap,
    ...(Number.isFinite(scale.vmin) ? { vmin: scale.vmin } : {}),
    ...(Number.isFinite(scale.vmax) ? { vmax: scale.vmax } : {}),
  }
}

/** What a star says, filled or empty. */
function starTitle(name: string, on: boolean): string {
  return on
    ? `${name} is the map an analysis runs against`
    : `Run analyses against ${name} instead`
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
