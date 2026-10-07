/**
 * One companion map: a file, a worker, a picture, and nothing else.
 *
 * The asymmetry with the lead panel is the design and not an economy. A session
 * has one file that answers *what am I looking at* — it owns the breadcrumb,
 * the genomes and contigs tables, the tracks, the record card and the
 * second-file split — and a deck of maps does not make that question have three
 * answers. So a companion carries the smallest thing that is still a map: its
 * own reader, its own colour scale, its own block, and a heading with its name
 * on it. Everything it is *of* comes from the shared view state.
 *
 * That is also what makes it cheap to state what a companion does when it
 * cannot answer. It is asked for a view by **name** — `chrI:20,000-80,000`,
 * `MAG_7`, a list of ticked sequences — and it resolves the name through its own
 * reader, so a file that has no `chrI` is refused by
 * `parse_metacooler_range`'s own error with its own list of what it does have
 * (§5.4). No gate had to be written for that case, and no gate could have
 * phrased it better.
 *
 * The one thing this file does hold that the lead does not is a **budget**:
 * every read is capped at the deck's share (`panels/deck.ts`), because N dense
 * blocks are N times a limit that was written for one (§2, §16.7).
 */

import { ViewerError } from '../errors'
import { devFeature } from '../state/devFeatures'
import { describeTier, type NameContext, type NameMatch } from '../genome/naming'
import { DECK_DRAG_TYPE, mapStarTitle, type DeckLook } from './deck'
import { matrixLevel, selectionOf } from '../state/ViewState'
import type { ViewState } from '../types'
import { ReaderClient } from '../worker/client'
import type { DrawnDepth } from '../contacts'
import type { Census } from '../metacooler/resample'
import type { ResampleTarget } from '../analysis/worker/protocol'
import type {
  ContigsResult,
  GenomesResult,
  MatrixResult,
  OpenResult,
  SourceSpec,
} from '../worker/protocol'

/**
 * What an analysis needs to know about a map that is not the session's own.
 *
 * The session builds its `AnalysisContext` from exactly these — the file's info
 * and its two tables — so a starred companion answering with the same shape
 * needs no second code path in `analysis/context.ts`. `genomes` is `null` on a
 * plain cooler, which has no genome layer to read (§8.5).
 */
export interface AnalysisFacts {
  uri: string
  source: SourceSpec
  info: OpenResult
  contigs: ContigsResult
  genomes: GenomesResult | null
}
import type { AnnotationStore } from '../annotations/store'
import type { LaneEdge } from '../annotations/types'
import type { PickHandlers } from '../ui/mapPick'
import {
  MatrixPanel,
  axisRegion,
  type AnnotationContext,
  type DerivePresentation,
  type SelectedRegion,
  type TurnPresentation,
} from '../ui/MatrixPanel'
import { zoomedRegion } from '../ui/RegionView'
import { regionLabel } from '../genome/assembly'
import { BALANCED_SCORE, COUNT_SCORE, scoreChoices, scoreFor } from '../ui/scores'
import { parseSmooth } from '../render/smooth'
import type { ScaleState } from '../ui/GenomeView'
import {
  STRUCTURE_DRAG_TYPE,
  TRACK_DRAG_TYPE,
  dragHasFiles,
  dragHasMapRow,
  dragHasStructure,
  dragHasTrack,
  dropEffectFor,
  el,
  fmt,
  readMapRow,
  type MapRow,
} from '../ui/dom'
import { dragHasFileRow, readFileDrag } from '../ui/fileDrag'
import type { PickedFile } from '../browse/folder'
import { resolutionLabel } from '../units'
import { firstEntry } from '../ui/FilePicker'
import { attachRefine, rungsOf, type BlockLadder } from '../ui/refine'
import { icon, iconButton } from '../ui/icons'
import { entryLabel, fileBaseLabel, fileLabel, splitUri } from '../ui/labels'

/**
 * What block a view state asks a companion for, before any file has been
 * consulted.
 *
 * Pure, and separated from the reading so it can be stated as a table in a test:
 * this is the whole of "the view is shared", and the way it goes wrong is by
 * quietly answering a *different* view in the companion than in the lead.
 *
 * Note how few kinds there are. Almost every view of a contact map is "a block
 * named by one or two labels", and a label means the same thing in every file
 * that has it — which is precisely why the selection can be shared across files
 * of different bin size when the *bins* could not be.
 */
export type BlockPlan =
  | { kind: 'names'; rows: string; cols?: string }
  | { kind: 'whole' }
  | { kind: 'selection'; unit: 'genome' | 'contig'; names: string[] }
  | { kind: 'none'; reason: string }

/** The block `state` asks for, in the vocabulary a companion can act on. */
export function planFor(state: ViewState): BlockPlan {
  switch (state.view) {
    case 'region':
      return state.region === undefined
        ? { kind: 'none', reason: 'no region named' }
        : {
            kind: 'names',
            rows: state.region,
            ...(state.region2 === undefined ? {} : { cols: state.region2 }),
          }
    case 'genome':
      return state.genome === undefined
        ? { kind: 'none', reason: 'no genome named' }
        : { kind: 'names', rows: state.genome }
    case 'pair':
      return state.genome === undefined || state.genome2 === undefined
        ? { kind: 'none', reason: 'no pair named' }
        : { kind: 'names', rows: state.genome, cols: state.genome2 }
    case 'whole':
      return { kind: 'whole' }
    case 'selection': {
      const selection = selectionOf(state)
      return selection === null
        ? { kind: 'none', reason: 'nothing selected' }
        : { kind: 'selection', unit: selection.kind, names: selection.names }
    }
    default:
      // The tables, the whole-metagenome scan and the 1D browser. Each is a
      // picture of a *file* rather than of a place in one, so there is nothing
      // for a second file to show beside it — a genomes table of another file
      // is not the same genomes table, it is another file's.
      return {
        kind: 'none',
        // A genome is one of the places a second file can show only on a
        // multi-genome file, a dev feature (§29): the sentence offers what the
        // reader's page can open.
        reason: devFeature('metacool')
          ? 'this view is of one file — pick a region, a genome or a selection'
          : 'this view is of one file — pick a region or a selection',
      }
  }
}

export interface MapPanelProps {
  /** The URI as requested, which is what the hash carries. */
  uri: string
  source: SourceSpec
  /**
   * What this panel may spend on one block, now.
   *
   * A function, not a number: the share shrinks as maps are added and the panel
   * outlives the addition. See {@link panelBudgetBytes}.
   */
  budgetBytes(): number
  /** The panel finished a read, or failed one; the deck relocks and repaints. */
  onSettled(): void
  /**
   * The panel's file answered for the total it holds, or for what it was drawn
   * to (§6.5) — the breadcrumb's contacts box re-reads every map's.
   */
  onDrawn?(): void
  /** The × on this panel's heading: the map is hidden, not let go (§16.9). */
  onClose(): void
  /** The chain on this panel's heading — follow the deck, or go it alone. */
  onToggleLock(): void
  /** Whether the reader has asked for this panel to follow the deck. */
  isLocked(): boolean
  /**
   * The naming context of the map whose region names this panel is following.
   *
   * Two booleans out of the lead's own contig list, and the panel forwards them
   * with every range it resolves. They are what lets a companion read `chrX`
   * out of a yeast lead as chromosome ten rather than as a sex chromosome the
   * file has not got (§5.9); a lead that has not read its contigs yet, and a
   * deck of one, both answer `undefined` and lose nothing by it.
   */
  naming?(): NameContext | undefined
  /**
   * The sequences the session declares circular (§8.15), as the first map's
   * file names them.
   *
   * The declaration is the session's, and a companion is another file of the
   * same genome: a window the first map frames across a circle's origin —
   * `ori`, written `NC_000913.3:2,016,731-2,016,729` — is a window across that
   * molecule's origin in every map of the deck. A companion that was not told
   * read the end below the start as a typing mistake, and said so where its map
   * should have been.
   */
  circular?(): readonly string[]
  /**
   * Why it is not following anyway, or `null` when it is.
   *
   * Asking is not the same as being followed: a block that spans a different
   * stretch of genome cannot honestly share a window, and the deck refuses
   * rather than drawing one file's coordinate under another's. A chain that
   * looked closed while the lock skipped the panel would be the one way a
   * navigation lock can be quietly wrong.
   */
  lockNote(): string | null
  /**
   * The colour scale this panel opens at, read once when its map is built.
   *
   * The lead's transform and colormap, always — a deck whose panels are drawn
   * with different ramps is one where the eye has to translate before it can
   * compare, which is the whole thing a deck is for. The lead's *clip* only
   * where the reader has asked for one scale (§16.2), because a clip is a
   * number of contacts and two depths do not share one.
   */
  initialLook(): ScaleState
  /**
   * The first map's derivation, as a thunk so it is never stale.
   *
   * What a companion **opens on** and what it borrows the machinery from — the
   * workers a correlation and an adaptive smoothing run on — and no longer what
   * it draws: the O/E, the smoothing and the score are each map's own, seeded
   * from the first map's and set from the *Map* card while this map is starred
   * (§16.2, §16.5). See {@link MapPanel.derivation}.
   */
  derive(): DerivePresentation | undefined
  /**
   * This panel's own lanes (`annotations/placement.ts`), or `undefined` while
   * the session has no annotation stores — a file still building them.
   *
   * A thunk so it is never stale, like the two beside it. The store is the
   * session's one store — the tracks are a single list however many maps are on
   * screen — and what makes it *this* panel's is the map id inside.
   */
  annotations(): AnnotationContext | undefined
  /**
   * This panel's own stack changed thickness.
   *
   * The deck reserves the *largest* stack on each edge across every panel
   * (§16.8), so a companion gaining a track moves a number the whole grid is
   * laid out from — and the lead, which is the only panel that used to report,
   * knows nothing about it.
   */
  onLanes?(): void
  /**
   * Whether the deck is turned 45°, as a thunk so it is never stale.
   *
   * Shared for the same reason the derivation is, and more visibly: a flip
   * changes the *shape* of the picture, so a deck whose lead is a triangular
   * band beside four squares is not four maps of one place with one of them
   * emphasised — it is a bar that says "one navigation" over five pictures that
   * are no longer in the same coordinates. Carries no `onChange`, which is what
   * makes a companion apply the turn without offering a sixth copy of the
   * control, and no `onAvailable`, because whether *this* file's block has a
   * diagonal is not a reason to un-turn the deck (`ui/MatrixPanel.ts`).
   */
  turn(): TurnPresentation | undefined
  /**
   * The bin size the lead is at, for a companion that turns out to be a
   * *collection* rather than a map (§3.4).
   *
   * An `.mcool` is a stack of complete coolers under `/resolutions` and is not
   * a map at its root, so opening one by name is a `KeyError` — the reader is
   * handed a sentence about a URI syntax they never typed, in a rectangle where
   * they expected their file. Somebody who dropped an `.mcool` on a deck meant
   * *this data, beside that*, and the resolution to land on is the lead's: two
   * files with the same ladder are comparable at any rung, and opening the
   * finest regardless would put a 1 kb map beside a 16 kb one and call it a
   * comparison. Where the collection has no such rung, its finest is the
   * fallback and the deck's own gate says so if the blocks then disagree.
   *
   * The same rule, from the same function, as the second file of a blend
   * (`Session.openCompare`) and as a collection dropped on the picker.
   */
  preferBinsize(): number | undefined
  /**
   * The score the **lead** resolved to, or `undefined`.
   *
   * Shared, and shared as a resolved id rather than left to each panel to work
   * out from the state, because the default is a fact about a *file*: a cooler
   * somebody balanced opens balanced, and that choice is not written into the
   * hash. Two panels each applying their own default therefore disagreed
   * silently — a balanced lead beside a companion drawing raw counts, under a
   * bar saying the score is one of the things a deck shares. Resolved against
   * this file's own columns all the same, so a name it has not got falls back
   * to counts rather than to a read it cannot answer.
   *
   * **A seed, not a rule.** A companion opens on this and from then on reads
   * its own score (§16.2): the *Map* card sets the starred map alone, so the
   * first map's score moving must not move the others with it.
   */
  score(): string | undefined
  /** Rewrite this panel's URI after it resolved a collection to one of its entries. */
  onResolved(uri: string): void
  /**
   * The grip before this panel's name was taken hold of, or let go.
   *
   * The deck shows its tiling while one is held, because a reader dragging a
   * map has to be able to see where the map can *go* — the cells are only
   * visible as cells while something is looking for one.
   */
  onDragChange(dragging: boolean): void
  /**
   * This panel was starred: make it the map an analysis runs against (§18.2).
   *
   * The deck owns which one it is — one star at a time is the whole point — so
   * this reports the press and the answer comes back through
   * {@link MapPanel.setStarred}.
   */
  onStar(): void
  /**
   * How this panel was drawn last time it showed this file, or `undefined`.
   *
   * The counterpart of {@link initialLook} and read *before* it: what a reader
   * set on this map beats what the lead is on, and the lead's scale is the
   * default a companion nobody has touched opens at. Read once, at construction,
   * because that is the moment {@link scoreOverride} has to exist by — the score
   * decides which block is fetched, so learning it after the first read would
   * mean reading the file twice to draw it once.
   */
  remembered?(): DeckLook | undefined
  /**
   * The reader changed what *this* map looks like: its scale, or its score.
   *
   * Reported rather than written here, because the memory is keyed by file and
   * a panel does not know which of its deck's slots it is nor what the session's
   * memory key is. See `panels/deck.ts`'s `DeckLook`.
   */
  onLook?(look: Omit<DeckLook, 'uri'>): void
  /**
   * What this map is called: the reader's name for it, or its file's.
   *
   * A thunk, because a rename happens outside this panel — the names belong to
   * the session, which is what holds the maps (`ui/mapNames.ts`) — and because
   * a panel that resolves itself into an entry of a collection has to ask again
   * under the address it ended up at.
   */
  label?(): string | undefined
  /**
   * The reader typed a name into this panel's heading, or emptied the box.
   *
   * `null` is the empty box, which hands the map back to its file name and is
   * what makes a rename undoable. Reported rather than written here, for
   * {@link onLook}'s reason: the memory is the session's and a panel does not
   * know its key.
   */
  onRename?(name: string | null): void
  /**
   * This map's *Map* card was built, rebuilt or taken down — the element
   * {@link MapPanel.card} answers with has changed.
   *
   * The deck's cue to tell the session, which is what places the **starred**
   * map's card in the Aesthetics column (§16.5): a card that was rebuilt under
   * a new annotation store would otherwise leave the column holding the old
   * one, bound to a picture that no longer exists.
   */
  onCardChange?(): void
  /**
   * A box was drawn on this map — the Option-Shift drag that, on the first
   * map, re-reads the window it frames (§16.3).
   *
   * The deck decides what it means, because the answer depends on the chain:
   * a map following the deck moves the deck there, and one moving on its own
   * reads that window for itself ({@link MapPanel.readOwn}). Absent, the box
   * zooms the picture this map already holds, which is what it always did.
   */
  onSelectRegion?(selection: SelectedRegion): void
  /**
   * This map's own window was widened, narrowed or given back (§16.3) — the
   * deck's cue to re-ask the lock and the echoes, which read it.
   */
  onOwnPlace?(): void
}

/**
 * A window a companion reads **for itself** rather than the deck's (§16.3), in
 * the grammar a region box takes: a region on the diagonal, or a pair of them.
 */
export interface OwnPlace {
  rows: string
  cols?: string
}

export class MapPanel {
  readonly el: HTMLElement
  /**
   * The map, once there is a file behind it.
   *
   * Built at the first successful read rather than at construction, because a
   * `MatrixPanel` with no block is a grey rectangle with a colourbar on it, and
   * a deck of five of those while five files open is worse than five headings
   * that say what they are doing.
   */
  private panel: MatrixPanel | null = null
  /** The deck's reserved lane room, held until there is a panel to give it to. */
  private laneFloor: Record<LaneEdge, number> = { top: 0, right: 0, bottom: 0, left: 0 }
  private readonly client = new ReaderClient()
  private readonly body = el('div', { class: 'deck-body' })
  private readonly note = el('p', { class: 'deck-note' })
  /** Kept apart from {@link note}: one is about the read, the other the lock. */
  private readonly lockNoteEl = el('p', { class: 'deck-note deck-unlocked hidden' })
  /**
   * Why this panel did not follow the deck to another resolution.
   *
   * A third line, and a third line rather than a reuse of either of the two
   * above because it outlives both of them: {@link note} is cleared by the next
   * successful read, which is the very next thing that happens, and the lock's
   * is rewritten whenever anything moves. This one stands until the panel is
   * asked for a resolution it *can* reach.
   */
  private readonly resNoteEl = el('p', { class: 'deck-note deck-res-note deck-unlocked hidden' })
  /**
   * That this panel answered a name it does not itself write.
   *
   * A fourth line, for {@link resNoteEl}'s reason and one of its own: a map
   * showing somebody else's chromosome under its own label is the single way
   * §5.9 can be quietly wrong, so the rename is stated on the picture rather
   * than left in a tooltip. It stands until the next read, which is when it
   * either happens again or stops being true.
   */
  private readonly renameNoteEl = el('p', { class: 'deck-note deck-rename-note hidden' })
  private refusal: string | null = null
  private readonly nameEl: HTMLInputElement
  private readonly lockButton: HTMLElement
  /** This panel's half of the deck's star; the deck decides which is filled. */
  private readonly starButton: HTMLButtonElement
  /**
   * What an analysis needs to run against this map, once it has been asked for.
   *
   * `null` until {@link prepareAnalysis} has fetched it, which is on purpose: a
   * companion opens to *draw a picture*, and the picture needs the file's info
   * and one block. The two tables below are a further pair of reads that only a
   * starred panel ever needs, so an eight-panel deck does not fetch sixteen
   * tables to show eight rectangles.
   */
  private facts: AnalysisFacts | null = null
  private preparing: Promise<void> | null = null
  private opening: Promise<OpenResult> | null = null
  private disposed = false
  /**
   * The state the last read was issued for.
   *
   * A deck is reconciled on every render, and most renders change nothing about
   * the block — a colour nudge, a tab switch, another panel finishing. Without
   * this each of them re-reads every companion.
   */
  private read: string | null = null
  /** Colour scale, per panel; see {@link applyLook}. */
  private look: ScaleState = {}
  /**
   * A score this panel was told to read, overriding the deck's.
   *
   * `null` until the reader picks one here, and that asymmetry is the design.
   * The score is one of the things a deck shares (§16.2) and it should stay
   * shared by default: four replicates read as counts while a fifth is balanced
   * is a row of pictures that cannot be compared, which is the one thing a deck
   * is for. But *shared* is not the same as *imposed*, and two cases break it —
   * a companion whose file carries a column the lead has not got, and a
   * comparison a reader deliberately wants at two normalisations. Both were
   * unreachable, because the panel simply had no picker.
   *
   * So it is an opt-out, per panel, and it is sticky: once this reader has said
   * what this map's cells are, the deck's later choices are the deck's business.
   * A `null` here follows the lead exactly as before, which is what every panel
   * nobody has touched does.
   */
  private scoreOverride: string | null = null
  /**
   * Whether this map divides by its distance baseline, and how much it is
   * smoothed — each map's own (§16.2), for {@link scoreOverride}'s reason.
   *
   * `null` until seeded from the first map's, which is what a companion
   * nobody has touched draws; set from the *Map* card while this map is the
   * starred one, and remembered with its scale ({@link reportLook}).
   */
  private expectedOwn: boolean | null = null
  private smoothOwn: string | null = null
  /**
   * This map's own reading along the arms (§8.15): the window while it divides
   * by the decay along both arms, `undefined` while it does not — each map's
   * own, for {@link expectedOwn}'s reason. `null` until seeded from the first
   * map's.
   */
  private armsOwn: { window: number | undefined } | null = null
  /**
   * The whole sequence, in this file's bins, where the block on screen was read
   * across a circle's origin (§8.15) — which every refine of it has to be read
   * across too — and `undefined` for every other block.
   */
  private wrap: [number, number] | undefined = undefined
  /**
   * The window this map reads for itself, or `null` for the deck's (§16.3).
   *
   * Set by a box drawn on it while its chain is open, which is the one gesture
   * that on the first map re-reads the window it frames — and on a companion
   * used only to magnify the block it already held, so a 10 kb rung reading a
   * whole mouse chromosome could never be drawn at 10 kb: the block was pooled
   * to fit the budget, and zooming into it drew the pooled cells larger.
   * Reading the window itself is what makes each map's resolution its own.
   * Taken off by the pill in the heading and by closing the chain again.
   */
  private ownPlace: OwnPlace | null = null
  /** The pill in the heading naming {@link ownPlace}, hidden while there is none. */
  private readonly placeEl = el('span', { class: 'deck-place hidden' })
  /**
   * The annotation store the current panel draws its lanes from.
   *
   * Held so a *new* one can be noticed. The session replaces its store on every
   * open, and a panel built against the previous one draws nothing that anybody
   * has put on this map since — see {@link show}.
   */
  private laneStore: AnnotationStore | null = null
  /**
   * The entry this panel descended into, when it was handed a collection.
   *
   * Held rather than pushed back into `props.uri`, which is the deck's copy and
   * is what the link is written from — the deck is told through `onResolved`
   * and rewrites its own ref, so the URI a reader shares names the map they are
   * looking at rather than the collection they dropped.
   */
  private resolved: string | null = null
  /**
   * The last view this panel was handed, so a change of *resolution* can re-read
   * it without waiting for a navigation.
   *
   * Held rather than asked for, because there is nobody to ask: the state
   * arrives through {@link apply} from a deck that is reconciling every panel at
   * once, and a companion that wanted it back would have to reach up through the
   * deck into the session for a value it was already given.
   */
  private state: ViewState | null = null
  /** The sibling entries of the collection this map is inside; `[]` for a plain file. */
  private entries: string[] = []
  /**
   * What the last open answered with, for the questions a deck asks between
   * reads — which rung this panel is on, above all.
   *
   * Held rather than re-requested: `open()` is memoised on a promise, so asking
   * again is free but asynchronous, and the deck prices its toggles on a repaint.
   */
  private opened: OpenResult | null = null

  /**
   * What this panel's file said when it opened — its facts, for the General
   * column's File card while this map is starred (§16.5) — or `null` before
   * the first open has answered.
   */
  get openInfo(): OpenResult | null {
    return this.opened
  }

  /**
   * What the worker was last told to draw this map to (§6.5), and what it
   * answered. `undefined` after an open, which puts a map back as stored.
   */
  private drawnAt: number | null | undefined = undefined
  private depthHeld: DrawnDepth | null = null
  private refusalHeld: string | null = null
  /** The census this map was counted by: kept across totals, since it does not depend on one. */
  private census: Census | null = null
  /**
   * The contacts the reader counted, for a file that does not say how many it
   * holds (a `.hic`); `null` while counting, `undefined` before asking.
   */
  private counted: number | null | undefined = undefined

  /** The contacts this map holds as stored: counted, where a census has, else as the file says. */
  get contactsTotal(): number | null {
    return this.census?.total ?? this.counted ?? this.opened?.contacts ?? null
  }

  /** Ask the reader to count this map's contacts, once per open, where its file does not say. */
  private countContacts(info: OpenResult): void {
    if (info.contacts !== null || this.counted !== undefined) return
    this.counted = null
    this.client
      // Followed silently — see `Session.countOf`.
      .request<'contacts'>({ kind: 'contacts' }, () => undefined)
      .then(({ total }) => {
        if (this.disposed || this.opened !== info) return
        this.counted = total
        this.props.onDrawn?.()
      })
      .catch(() => undefined)
  }

  /** Why this map could not be drawn to the tab's total, or `null`. */
  get drawRefusal(): string | null {
    return this.refusalHeld
  }

  /** What this map is drawn to, as its caption says it; `null` as stored. */
  get drawnDepth(): DrawnDepth | null {
    return this.depthHeld
  }

  /**
   * The total a task on this map is drawn to, with the census it can skip
   * (§6.5). The deck's — the state this panel was last handed — and not what
   * the worker has answered yet: a task run while the draw is still counting
   * must still read the drawn map.
   */
  resampleTarget(): { resample?: ResampleTarget } {
    const contacts = this.state?.contacts ?? null
    if (contacts === null) return {}
    return { resample: { contacts, ...(this.census === null ? {} : { census: this.census }) } }
  }

  /**
   * Tell the worker what to draw this map to, where it was told otherwise.
   * Awaited: a refusal is this panel's to say in its own frame, and the read
   * after it would only say the same thing.
   */
  private async drawTo(contacts: number | null): Promise<void> {
    if (this.drawnAt === undefined ? contacts === null : this.drawnAt === contacts) {
      const opened = this.drawnAt === undefined
      this.drawnAt = contacts
      // The first answer since an open, as stored: the file's own total is
      // known now, and the box's chevrons count this map.
      if (opened) this.props.onDrawn?.()
      return
    }
    this.drawnAt = contacts
    this.depthHeld = null
    this.refusalHeld = null
    const file = this.opened
    try {
      const result = await this.client.request<'resample'>({ kind: 'resample', contacts })
      // An answer about the file before the one now open is not about this one.
      if (this.disposed || this.opened !== file) return
      if (result.census !== null) this.census = result.census
      if (this.drawnAt !== contacts) return
      this.depthHeld =
        contacts === null || result.total === null
          ? null
          : { contacts, total: result.total, mode: result.mode }
    } catch (error) {
      if (this.drawnAt === contacts && this.opened === file) {
        this.refusalHeld = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally {
      this.props.onDrawn?.()
    }
  }
  /**
   * A bin size the deck asked for **before this panel had opened**, held until
   * it can be answered.
   *
   * Nothing about this file's resolution ladder is known until the first open
   * lands: {@link entries} is empty and {@link binsize} is `undefined`, so
   * {@link useBinsize} would read a three-rung `.mcool` as a file that "carries
   * one resolution only" and print that under a panel whose very next act is to
   * descend onto the rung it was said to lack — `firstEntry` lands a collection
   * on {@link MapPanelProps.preferBinsize}, which is this same number. Held
   * rather than refused, because the refusal is a claim about the file made out
   * of a race, and nothing on the descent path ever clears it.
   */
  private wantedBinsize: number | undefined
  /**
   * The zoom's own reader for this panel.
   *
   * Its ceiling is the block this panel read, not the file: a companion
   * follows the deck's navigation, and one that widened on its own would be
   * showing a window the lock is about to drag it out of. Refining *in* is a
   * different matter — the lock's currency is base pairs (§16.3), so five
   * panels each at their own resolution stay in step by construction, which
   * is the property that lets them refine independently.
   */
  private ladder: BlockLadder | null = null
  /** The group they live under — `resolutions` for an mcool, `entries` for an mmetacool. */
  private entryGroup = ''
  /** The `::1000` in the heading: a picker, where there is more than one rung. */
  private readonly entryPicker: HTMLSelectElement

  constructor(private readonly props: MapPanelProps) {
    // The *file's* name only, until a reader says otherwise. The entry beside it
    // is the picker below, and a heading that printed `rep1.mcool::1000` and
    // then offered `::1000` again would be saying the same thing twice, once as
    // a fact and once as a control.
    //
    // An `<input>` that looks like text rather than a label that swaps itself
    // for one, which is `ui/AnnotationCard.ts`'s reasoning for a track's lane
    // label: the swap is a frame of flicker and a lost first keystroke, and
    // there is nothing the plain text could do that the quiet input does not.
    this.nameEl = this.name()
    this.entryPicker = el('select', { class: 'select select-tiny deck-entry hidden' })
    this.entryPicker.addEventListener('change', () => {
      void this.openEntry(this.entryPicker.value)
    })
    this.starButton = iconButton('star', '', () => props.onStar(), {
      class: 'btn btn-icon deck-star',
      size: 13,
    })
    this.lockButton = iconButton(
      'link',
      'Following the other maps. Click to move this one on its own.',
      () => props.onToggleLock(),
      { class: 'btn btn-icon deck-lock', size: 14 },
    )
    // Before anything is read, because the score decides *which* block is read:
    // learning it after the first fetch would mean reading the file twice to
    // draw it once, and the reader would watch the panel settle on the deck's
    // score and then move off it.
    const held = props.remembered?.()
    if (held !== undefined) {
      this.look = {
        ...(held.transform === undefined ? {} : { transform: held.transform }),
        ...(held.colormap === undefined ? {} : { colormap: held.colormap }),
        ...(held.vmin === undefined ? {} : { vmin: held.vmin }),
        ...(held.vmax === undefined ? {} : { vmax: held.vmax }),
      }
      if (held.score !== undefined) this.scoreOverride = held.score
      if (held.oe !== undefined) this.expectedOwn = held.oe
      if (held.smooth !== undefined) this.smoothOwn = held.smooth
      if (held.arms !== undefined) this.armsOwn = { window: held.arms ?? undefined }
      // Only on a map that is still off the deck: a window of its own is what
      // an open chain is for, and one restored under a closed chain would be a
      // map the lock follows reading somewhere the others are not.
      if (held.place !== undefined && held.locked === false) this.ownPlace = held.place
    }
    this.seed()
    this.el = el(
      'section',
      { class: 'deck-panel' },
      el(
        'header',
        { class: 'deck-head' },
        this.grip(),
        this.nameEl,
        this.entryPicker,
        this.placeEl,
        this.starButton,
        this.lockButton,
        iconButton('x', `Hide ${fileLabel(props.uri)} — it stays on the Contact maps card, whose eye brings it back`, () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      this.note,
      this.lockNoteEl,
      this.resNoteEl,
      this.renameNoteEl,
      this.body,
    )
    this.say('opening…')
    this.paintPlace()
  }

  /**
   * What this map is called, on its heading and in its exported figure.
   *
   * Editable in place, by clicking it: the file name is a starting point rather
   * than an answer, and a deck of four replicates is four labels differing in a
   * digit. An empty box hands the map back to its file name, which is what
   * makes a rename undoable — the same rule the tab strip follows, and the same
   * refusal a track's lane label makes for a name that would leave a row it
   * cannot be told from its neighbour by.
   *
   * The pointer events are stopped because the heading is a *deck* heading: the
   * grip beside this makes the panel draggable, and a browser reads a drag that
   * begins in a text box as a drag of the panel rather than as a selection.
   */
  private name(): HTMLInputElement {
    const input = el('input', {
      class: 'input deck-name',
      type: 'text',
      value: this.props.label?.() ?? fileBaseLabel(this.props.uri),
      title: this.props.uri,
    })
    const revert = (): void => {
      input.value = this.props.label?.() ?? fileBaseLabel(this.props.uri)
    }
    input.addEventListener('change', () => {
      const typed = input.value.trim()
      if (typed === (this.props.label?.() ?? fileBaseLabel(this.props.uri))) {
        revert()
        return
      }
      this.props.onRename?.(typed === '' ? null : typed)
      revert()
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        revert()
        input.blur()
      }
      event.stopPropagation()
    })
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
    return input
  }

  /**
   * Put the name back in the box after somebody else changed it.
   *
   * Pushed by the deck rather than read per frame, and skipped while the caret
   * is in it: the panel repaints on every read and every lock change, and
   * rewriting the box under a reader mid-word is the one way an editable
   * heading is worse than a printed one.
   */
  syncName(): void {
    if (document.activeElement === this.nameEl) return
    const label = this.props.label?.() ?? fileBaseLabel(this.props.uri)
    if (this.nameEl.value !== label) this.nameEl.value = label
    // Both, because a companion's heading *is* its map's name — see
    // `ui/MatrixPanel.ts`'s {@link MatrixPanel.retitle}.
    this.panel?.setMapLabels(label)
    this.panel?.retitle(label)
  }

  /**
   * The handle a map is dragged by, before its name.
   *
   * A grip and not a pair of arrows. `◀` `▶` could only ever say *one place
   * along a list*, which is a poor description of a 2 × 2: moving the bottom-left
   * map to the top-right is three presses, each of them shuffling everything in
   * between. A deck is an arrangement (§16.9), and the gesture for rearranging
   * one is picking a map up and putting it where it goes.
   *
   * On the grip rather than on the whole heading, because the heading holds a
   * chain and a close and the map below it takes a drag as a pan — a panel that
   * is draggable everywhere is a panel a reader cannot navigate.
   */
  private grip(): HTMLElement {
    const node = el('span', {
      class: 'deck-grip',
      title: 'Drag to move this map to another cell of the deck',
      attrs: { draggable: 'true', 'aria-label': 'Move this map' },
    })
    node.append(icon('grip-vertical', { size: 12 }))
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DECK_DRAG_TYPE, this.props.uri)
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
      this.el.classList.add('is-dragging')
      this.props.onDragChange(true)
    })
    node.addEventListener('dragend', () => {
      this.el.classList.remove('is-dragging')
      this.props.onDragChange(false)
    })
    return node
  }

  /** What this panel is actually reading — the entry, where it descended into one. */
  get uri(): string {
    return this.resolved ?? this.props.uri
  }

  /** Where this panel's bytes come from, so the map can be opened again elsewhere. */
  get sourceSpec(): SourceSpec {
    return this.props.source
  }

  /** The map, for the deck's lock; `null` until this panel has read a block. */
  get map(): MatrixPanel | null {
    return this.panel
  }

  /**
   * The bin size this panel is reading at, or `undefined` before its first open.
   *
   * The **file's** bin size and not the effective resolution of what is drawn:
   * pooling is a fact about how much of a block is on screen, and a resolution
   * ladder is not indexed by it — the same distinction
   * {@link MapPanelProps.preferBinsize} makes.
   */
  binsize(): number | undefined {
    return this.opened?.binsize ?? undefined
  }

  /**
   * Read at `bp`, if this file has that resolution — and say so if it has not.
   *
   * **Exact, and never the nearest.** The deck asks this of every panel when the
   * first map changes rung and when the reader presses *fix all resolutions*,
   * and the promise both of those make is that the maps are then reading the
   * same data at the same grid. A nearest-rung fallback keeps every panel doing
   * *something*, which is the wrong kind of helpful here: it answers "put these
   * on one resolution" with a deck at two, and says nothing about it. A file
   * that cannot follow says why, in its own frame, and stays where it is — a
   * complete picture at a resolution the reader can read, which is the same
   * answer a companion gives to every other thing it cannot do (§16.1).
   *
   * A plain cooler has one resolution: it follows when that is the one asked
   * for, and otherwise says it has only the one. Published through
   * {@link MapPanelProps.onResolved} by {@link openEntry}, so a rung reached
   * this way is in the link exactly as one the reader picked is.
   *
   * **A panel that has not opened yet says nothing and follows later**, which
   * is a different state from having one rung and is now told apart from it:
   * see {@link wantedBinsize} and the answer {@link load} gives it.
   */
  useBinsize(bp: number): boolean {
    if (!Number.isFinite(bp) || bp <= 0) return false
    // **A panel that has not opened is held, not accused.** See
    // {@link wantedBinsize}: before the first read this file has no known
    // ladder at all, so every one of the answers below would be about
    // `this.entries` being empty rather than about the file — and a collection
    // is on its way to this very rung anyway. `true` because the deck's
    // question is "will you follow", and the honest answer is yes-as-soon-as-I-
    // can; naming it in the bar's list of files that could not follow is the
    // same false claim in the deck's own voice.
    if (this.opened === null) {
      this.wantedBinsize = bp
      return true
    }
    // Already there, whatever the ladder looks like — including a plain cooler
    // that happens to be at the resolution the deck is moving to.
    if (this.binsize() === bp) {
      this.sayResolution(null)
      return true
    }
    const rungs = rungsOf(this.entries)
    const match = rungs.find((rung) => rung.binsize === bp)
    if (match === undefined) {
      const here = this.binsize()
      // "Staying at 0 bp" is what `?? 0` used to render for a file whose open
      // answered no bin size at all — a measurement in a sentence about
      // honesty, and not one this panel has. Where there is no number the
      // sentence simply does not offer one.
      this.sayResolution(
        `${here === undefined ? 'staying where it is' : `staying at ${resolutionLabel(here)}`}: ` +
          `this file has no ${resolutionLabel(bp)} level` +
          (rungs.length === 0
            ? ', and carries one resolution only.'
            : ` — it has ${rungs.map((rung) => resolutionLabel(rung.binsize)).join(', ')}.`),
      )
      return false
    }
    this.sayResolution(null)
    if (match.name === entryLabel(this.uri)) return true
    void this.openEntry(match.name)
    return true
  }

  /**
   * Everything an analysis needs about this map, or `null` if it has not been
   * asked for yet.
   *
   * Synchronous, because the Analysis column is priced on every repaint and a
   * promise there would be a column that flickers. {@link prepareAnalysis} is
   * the asking, and the session does it when the star lands here.
   */
  analysisFacts(): AnalysisFacts | null {
    return this.facts
  }

  /**
   * Read what an analysis needs, once, and say when it is there.
   *
   * The info arrives with the picture — this panel is opening the file anyway —
   * and the two tables are the extra. Held after the first call, because they do
   * not change under a file: a companion's URI is fixed for the life of the
   * panel, and descending into another entry of a collection rebuilds it.
   */
  async prepareAnalysis(onReady: () => void): Promise<void> {
    if (this.facts !== null || this.disposed) return
    this.preparing ??= (async (): Promise<void> => {
      const info = await this.open()
      const [contigs, genomes] = await Promise.all([
        this.client.request<'contigs'>({ kind: 'contigs' }),
        info.hasGenomes
          ? this.client.request<'genomes'>({ kind: 'genomes' })
          : Promise.resolve(null),
      ])
      if (this.disposed) return
      // `this.uri` and never `props.uri`: an `.mcool` or `.mmetacool` companion
      // is opened at its *root*, refused, and re-opened one rung down
      // ({@link openOrDescend}), and it is that descended address the panel is
      // actually showing. Handing an analysis the root instead is handing it a
      // collection, which the worker refuses with `mcool-root` — the same
      // refusal the reader was never meant to see, arriving from a task rather
      // than from a picture. Read after `open()`, which is where the descent
      // happens and therefore where `resolved` is filled in.
      this.facts = { uri: this.uri, source: this.props.source, info, contigs, genomes }
    })()
    try {
      await this.preparing
    } catch {
      // A companion that cannot answer for itself is one the Analysis column
      // says nothing about; the panel's own note already carries the refusal.
      this.preparing = null
      return
    }
    if (!this.disposed) onReady()
  }

  /**
   * Fill or empty this panel's star.
   *
   * Told rather than asked, because exactly one map in a deck is starred and
   * that is a fact about the deck. A filled star is also a dead button: the way
   * to move it is to press another one, and a press that does nothing is a
   * control that has to be tried to be understood.
   */
  setStarred(on: boolean): void {
    this.starButton.classList.toggle('is-on', on)
    this.starButton.setAttribute('aria-pressed', String(on))
    // `this.uri`, so a companion that descended into an entry names the rung it
    // is actually reading — which is the file a task would run against, and the
    // one thing this button is about.
    this.starButton.title = mapStarTitle(this.props.label?.() ?? fileLabel(this.uri), on)
  }

  /**
   * This map's *Map* card — the one the Aesthetics column shows while this map
   * is starred (§16.5) — or `null` before the first block has built the map.
   */
  get card(): HTMLElement | null {
    return this.panel?.controlsEl ?? null
  }

  /**
   * Say on this map's card which map it sets; see `MatrixPanel.setCardFor`.
   * Held as well as passed down, because the map is built at the first read
   * and a line set before it existed would otherwise be lost.
   */
  setCardFor(target: Parameters<MatrixPanel['setCardFor']>[0]): void {
    this.cardTarget = target
    this.panel?.setCardFor(target)
  }

  private cardTarget: Parameters<MatrixPanel['setCardFor']>[0] = null

  /**
   * Read this map as `id` — the score picker on its card, or the first map's
   * card setting every map (§16.5).
   *
   * The clip goes back to auto, and that is not tidiness: a clip is a pair of
   * numbers in one score's units, and a balanced matrix is fractions where a
   * count matrix is integers. Kept across the switch, a perfectly good map is
   * drawn as a black rectangle from a control the reader never touched — which
   * is the same argument {@link show} makes for not lending a companion the
   * lead's clip when the two are drawing different quantities.
   *
   * Nothing is published. The hash carries the first map's score, and a
   * companion's is in the position its clip is already in (§16.6): remembered
   * in this session's memory, beside the look.
   */
  useScore(id: string): void {
    if (this.scoreOverride === id) return
    this.scoreOverride = id
    this.panel?.applyScale({ ...this.look, vmin: undefined, vmax: undefined })
    this.look = { ...this.look, vmin: undefined, vmax: undefined }
    this.reportLook()
    if (this.state !== null) void this.load(this.state)
  }

  /** Divide this map by its distance baseline, or stop (§7.5) — its own O/E. */
  useExpected(on: boolean): void {
    if (this.expectedOwn === on) return
    this.expectedOwn = on
    this.reportLook()
    this.panel?.rederive(this.derivation(), undefined, this.props.turn())
  }

  /**
   * Smooth this map by `token`, its own despeckle (§7.5). The adaptive window
   * turns the O/E on, exactly as it does on the first map: it is sized on the
   * counts and divided by a baseline averaged over that window.
   */
  useSmooth(token: string): void {
    if (this.smoothOwn === token) return
    this.smoothOwn = token
    if (parseSmooth(token)?.kind === 'adaptive') this.expectedOwn = true
    this.reportLook()
    this.panel?.rederive(this.derivation(), undefined, this.props.turn())
  }

  /**
   * Divide this map by the decay along both arms, or stop (§8.15) — its own, as
   * its O/E is. On turns the O/E on with it, as it does on the first map: it is
   * a reading of the ratio and nothing else.
   */
  useArms(window: number | undefined): void {
    if (this.armsOwn !== null && this.armsOwn.window === window) return
    this.armsOwn = { window }
    if (window !== undefined) this.expectedOwn = true
    this.reportLook()
    this.panel?.rederive(this.derivation(), undefined, this.props.turn())
  }

  /** Put part of a scale on this map and keep the rest of its own. */
  mergeLook(look: ScaleState): void {
    this.applyLook({ ...(this.panel?.baseScale() ?? this.look), ...look })
  }

  /**
   * What this map draws: the first map's derivation machinery, with **its own**
   * O/E, smoothing and score in it (§16.2).
   *
   * The normalisation, the correlation and the baseline are answers to *what
   * are these cells*, which is the score, so they are read off this map's own
   * choice — picking `VC` on a companion used to label it VC and draw it
   * however the *first* map was normalised, because those three came from the
   * first map's score. The handlers are this map's, so the O/E toggle and the
   * smoothing on its card set this map alone.
   */
  private derivation(): DerivePresentation | undefined {
    const shared = this.props.derive()
    if (shared === undefined) return undefined
    const { normalise: _first, ...rest } = shared
    const choice = this.opened === null || this.state === null ? null : this.scoreOf(this.opened, this.state)
    const normalise = choice === null ? shared.normalise : choice.normalise
    // The arms are the first map's frame — the sequence, its length and its
    // origin, which are facts about the molecule and so this map's too, placed
    // on each block by base pairs (`MatrixPanel.armsFor`) — read with this map's
    // own window, and its own control. `ori` stays the deck's: the region is
    // shared, so framing it on the origin frames every map there.
    const lead = shared.arms
    const arms =
      lead === undefined
        ? undefined
        : {
            ...lead,
            window: this.armsOwn === null ? lead.window : this.armsOwn.window,
            onChange: (window: number | undefined) => this.useArms(window),
          }
    return {
      ...rest,
      ...(normalise === undefined ? {} : { normalise }),
      ...(arms === undefined ? {} : { arms }),
      expected: this.expectedOwn ?? shared.expected,
      smooth: this.smoothOwn ?? shared.smooth,
      correlate: choice === null ? shared.correlate : choice.correlate === true,
      baseline: choice === null ? shared.baseline : choice.baseline === true,
      alongArms: choice === null ? shared.alongArms === true : choice.alongArms === true,
      onExpectedChange: (on) => this.useExpected(on),
      onSmoothChange: (token) => this.useSmooth(token),
      // The one caller is a correlation that failed, and "off" can only mean
      // the score it stood on: balanced counts, the nearest picture to it.
      onCorrelateChange: (on) => {
        if (!on) this.useScore(BALANCED_SCORE)
      },
    }
  }

  /**
   * Take the first map's score, O/E and smoothing as this map's own, where it
   * has none yet (§16.2). Asked at construction and again at every read, since
   * a companion can be built before the first map has resolved a score.
   */
  private seed(): void {
    if (this.scoreOverride === null) this.scoreOverride = this.props.score() ?? null
    const shared = this.props.derive()
    if (shared === undefined) return
    this.expectedOwn ??= shared.expected
    this.smoothOwn ??= shared.smooth
    // Only once the first map is on a sequence that has arms at all: seeded
    // from a view with none, this map would be pinned off along the arms
    // before the first map had been asked.
    if (this.armsOwn === null && shared.arms !== undefined) this.armsOwn = { window: shared.arms.window }
  }

  // -------------------------------------------------------------------------
  // A window of its own (§16.3)
  // -------------------------------------------------------------------------

  /** The block this map reads: the deck's, or its own window where it has one. */
  private planOf(state: ViewState): BlockPlan {
    const shared = planFor(state)
    // A view of the file rather than of a place has nothing for a window to be
    // a window *of*, and the deck is not framed over one anyway.
    if (shared.kind === 'none' || this.ownPlace === null) return shared
    return {
      kind: 'names',
      rows: this.ownPlace.rows,
      ...(this.ownPlace.cols === undefined ? {} : { cols: this.ownPlace.cols }),
    }
  }

  /**
   * The level this map reads at: the deck's, or bins in a window of its own —
   * a window is a stretch of sequence, and a whole chromosome drawn as one
   * contig-level cell would be a window of nothing.
   */
  private levelOf(state: ViewState): ReturnType<typeof matrixLevel> {
    return this.ownPlace === null ? matrixLevel(state) : 'bin'
  }

  /** Whether this map is reading a window of its own rather than the deck's. */
  get hasOwnPlace(): boolean {
    return this.ownPlace !== null
  }

  /** What this map's block is of, for telling two maps' blocks apart; `''` for the deck's. */
  get placeKey(): string {
    return this.ownPlace === null ? '' : JSON.stringify(this.ownPlace)
  }

  /**
   * Read the window a box drawn on this map frames, **for this map alone**
   * (§16.3) — at its own rung, pooled only as far as its share of the budget
   * needs, exactly as the first map re-reads the window a box frames on it.
   */
  readOwn(selection: SelectedRegion): void {
    this.setOwnPlace({
      rows: axisRegion(selection.rows),
      ...(selection.diagonal ? {} : { cols: axisRegion(selection.cols) }),
    })
  }

  /** Read the deck's window again — the pill's ×, and the chain being closed. */
  clearOwnPlace(): void {
    this.setOwnPlace(null)
  }

  private setOwnPlace(place: OwnPlace | null): void {
    if (this.placeKey === (place === null ? '' : JSON.stringify(place))) return
    this.ownPlace = place
    this.paintPlace()
    this.reportLook()
    this.props.onOwnPlace?.()
    // `read` is keyed on the plan, which has just changed, so this reads.
    if (this.state !== null) void this.load(this.state)
  }

  /**
   * Widen this map's own window threefold about what is on screen — the first
   * map's `⊖3×`, for the one map a box has narrowed and nothing else can
   * widen: a scroll stops at the edge of what was read, and a second box can
   * only narrow it. One press from the whole sequence is the whole sequence.
   */
  private widenOwn(): void {
    const framed = this.panel?.framedRegion() ?? null
    const own = this.ownPlace
    if (framed === null || own === null || own.cols !== undefined) return
    const wider = zoomedRegion(framed, 3, { floor: this.binsize() ?? 1 })
    if (wider !== null) this.setOwnPlace({ rows: wider })
  }

  /**
   * The pill in the heading: the window this map reads for itself, a `⊖3×` to
   * widen it, and a `×` to read the deck's again. A bordered pill so the `×`
   * inside it reads as closing *the window* and not the cell, whose own `×` is
   * at the far end of the heading.
   */
  private paintPlace(): void {
    const own = this.ownPlace
    this.placeEl.classList.toggle('hidden', own === null)
    if (own === null) {
      this.placeEl.replaceChildren()
      return
    }
    const label =
      own.cols === undefined ? regionLabel(own.rows) : `${regionLabel(own.rows)} × ${regionLabel(own.cols)}`
    this.placeEl.title =
      `This map is reading ${label} for itself, at its own resolution, and not the window the ` +
      'others are showing. Draw another box on it to narrow it again.'
    const widen = iconButton('zoom-out', 'Widen this map’s own window 3× about what is on screen', () => this.widenOwn(), {
      class: 'btn btn-icon deck-place-widen',
      size: 12,
    })
    // Only a window on the diagonal has one range to widen; a pair is two.
    widen.disabled = own.cols !== undefined
    this.placeEl.replaceChildren(
      icon('scan', { size: 12 }),
      el('span', { class: 'deck-place-label', text: label }),
      widen,
      iconButton('x', 'Back to the deck’s window: read the region the other maps are showing', () => this.clearOwnPlace(), {
        class: 'btn btn-icon deck-place-clear',
        size: 12,
      }),
    )
  }

  /**
   * Draw and name this map's chain from the state it is in.
   *
   * The second sentence is the one every chain in the deck says: *click to move
   * it on its own*, *click to put it back in step*. The three surfaces that
   * carry the icon each had their own pair of verbs — press or click, unhook or
   * move on its own, bring back or put back — which reads as three controls
   * wearing one glyph (§25.3). The first sentence stays each surface's own,
   * because what they are doing genuinely differs: a tracks cell follows the
   * maps *and* they follow it, and the lead drives.
   */
  syncLock(): void {
    const wanted = this.props.isLocked()
    const refusal = this.props.lockNote()
    const following = wanted && refusal === null
    this.lockButton.replaceChildren(icon(following ? 'link' : 'unlink', { size: 14 }))
    this.lockButton.title = following
      ? 'Following the other maps. Click to move this one on its own.'
      : wanted
        ? (refusal ?? 'Not following the other maps.')
        : 'Moving on its own. Click to put it back in step with the others.'
    this.lockButton.setAttribute('aria-pressed', String(following))
    this.lockButton.setAttribute('aria-label', this.lockButton.title)
    this.el.classList.toggle('is-unlocked', !following)
    // The refusal is a sentence and belongs where a reader looking at the still
    // map will find it, not only in a tooltip on a 14 px icon. Only when the
    // reader *asked* for the lock: a panel deliberately let off the lead needs
    // no explanation, and one printed under it would read as a fault.
    this.refusal = wanted ? refusal : null
    this.sayRefusal()
  }

  /**
   * Adopt the shared view.
   *
   * Everything a companion is *of* arrives here, and nothing it looks like
   * does: the colour scale is {@link applyLook}'s, and the two are separate
   * because they answer to different owners (§16.2).
   */
  apply(state: ViewState): void {
    // The derivation and the turn first, and separately from the read: both are
    // transforms over cells that are already here, so `keyFor` deliberately
    // carries neither and a change to either would otherwise short-circuit
    // against an unchanged key — leaving this companion drawing counts beside a
    // lead drawing a ratio, or square beside a lead on its diagonal.
    this.panel?.rederive(this.derivation(), undefined, this.props.turn())
    void this.load(state)
  }

  /**
   * Adopt a colour scale from outside — the deck's "one scale for all".
   *
   * Off by default, and the default is the argument: `vmax` is a number of
   * contacts, and two libraries sequenced to different depths do not have the
   * same one. Sharing a *transform* and a *colormap* is a claim about the
   * picture; sharing a clip is a claim about the numbers, and only the reader
   * knows whether these files support it.
   */
  applyLook(look: ScaleState): void {
    this.look = look
    this.panel?.applyScale(look)
    // Written down like any other change to this map's scale. "Fix all scales"
    // is a press rather than a mode (`PanelDeck.fixScales`), so what it leaves
    // behind is N panels each on a clip of their own that happen to agree — and
    // a workspace that did not record them would come back with the press
    // undone.
    this.reportLook()
  }

  /**
   * How much room this panel's own stack takes on one edge.
   *
   * Asked of every panel so the deck can reserve the largest (§16.8). Zero
   * before the map exists, which is right: a panel with no picture yet has no
   * stack to make room for.
   */
  laneRoom(edge: LaneEdge): number {
    return this.panel?.laneExtent(edge) ?? 0
  }

  /**
   * Room to leave on each edge, whatever this panel's own tracks take.
   *
   * Held here as well as pushed down, because the matrix panel is built lazily —
   * the first block is what creates it — and a floor set while a companion was
   * still reading would otherwise be lost.
   */
  setLaneFloor(floor: Record<LaneEdge, number>): void {
    this.laneFloor = { ...floor }
    this.panel?.setLaneFloor(this.laneFloor)
  }

  /**
   * Arm this panel's map for placing marks, or answer that it has none.
   *
   * A companion is a map like the lead's and a mark is a coordinate, so there
   * was never a reason for the gesture to work on one and not the other — only
   * a picker that had been given the session's own panel and nothing else. The
   * marks are already drawn on every panel that shows the locus, because they
   * live in one store that every panel draws from (`ui/MatrixPanel.ts`); this is
   * the half that lets them be *put* there.
   *
   * A panel that is still reading has no map to arm and answers with a cancel
   * that does nothing, which is the same shape a torn-down panel answers with.
   */
  armPicking(handlers: PickHandlers, onEnd: () => void = () => {}): () => void {
    return this.panel?.armPicking(handlers, onEnd) ?? ((): void => {})
  }

  remeasure(): void {
    this.panel?.remeasure()
  }

  /** Ask for a frame; see `MatrixPanel.repaint` (§8.12). */
  repaint(): void {
    this.panel?.repaint()
  }

  destroy(): void {
    this.disposed = true
    this.ladder?.destroy()
    this.ladder = null
    this.panel?.destroy()
    this.panel = null
    this.client.terminate()
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async open(): Promise<OpenResult> {
    this.opening ??= this.openOrDescend()
    return this.opening
  }

  /**
   * Offer the other rungs of the ladder this map is on, as the `::1000` beside
   * its name.
   *
   * A companion's resolution is the one thing about *what it reads* that the
   * deck cannot share, and until now it was also the one thing a reader could
   * not change. The deck lands an `.mcool` on the lead's bin size (§3.4,
   * {@link MapPanelProps.preferBinsize}), which is the right guess and only a
   * guess: two files rarely have the same ladder, and the rung that makes a
   * comparison legible is not always the one that matches a number. So the entry
   * is a picker rather than a fact — the same control the breadcrumb gives the
   * session's own file (`ui/Breadcrumb.ts`), in the only place a companion has
   * for a control, which is its heading.
   *
   * Hidden where there is nothing to pick: a plain cooler has no siblings, and a
   * one-rung collection offers a choice that cannot be made.
   */
  private paintEntries(info: OpenResult): void {
    this.entries = info.entries
    this.entryGroup = info.entryGroup === '' ? 'entries' : info.entryGroup
    const current = entryLabel(this.uri)
    const offer = info.entries.length > 1 && current !== undefined
    this.entryPicker.classList.toggle('hidden', !offer)
    if (!offer) return
    // Rebuilt only when the list itself changed, which is once per file: this
    // runs on every read, and replacing a `<select>`'s options while its own
    // menu is open closes it under the pointer.
    const listed = Array.from(this.entryPicker.options).map((option) => option.value)
    if (listed.length !== info.entries.length || listed.some((name, i) => name !== info.entries[i])) {
      this.entryPicker.replaceChildren(
        // `::1000`, written the way the URI writes it, because that is what the
        // reader will paste into a link and what the tooltip on the name says.
        ...info.entries.map((name) => el('option', { value: name, text: `::${name}` })),
      )
    }
    this.entryPicker.value = current
    this.entryPicker.title =
      this.entryGroup === 'resolutions'
        ? 'Which resolution this map is read at. Only this map moves — the region, the level and ' +
          'the score stay shared, and the deck keeps navigating as one.'
        : 'Which map of this collection is drawn here.'
  }

  /**
   * Read this panel's file at another rung, keeping everything else.
   *
   * The worker is told to open a different address inside the same bytes, so a
   * local companion keeps the handle it was dropped with and a remote one keeps
   * its range source. `read` is cleared because the cache key is about the
   * *view* — the block plan, the level, the score — and none of those has
   * changed, so without this the panel would decide it had already read this and
   * go on drawing the old grid.
   *
   * The choice is published through {@link MapPanelProps.onResolved}, which is
   * what makes it stick: the deck rewrites this panel's ref, so the entry is
   * part of what the panel *is* from then on, and every later navigation reopens
   * at it rather than at the lead's guess.
   */
  private async openEntry(entry: string): Promise<void> {
    // Compared as *entries*, not as URIs: a link may write `::/resolutions/1000`
    // and this builds `::resolutions/1000`, which are the same address spelled
    // two ways, and a string comparison would reopen the file to arrive back
    // where it already was.
    if (entry === entryLabel(this.uri) || !this.entries.includes(entry)) return
    const uri = `${splitUri(this.uri).path}::${this.entryGroup}/${entry}`
    this.resolved = uri
    // The reader has chosen a rung for this panel, so whatever the deck last
    // said about one it could not reach is no longer the state of things.
    this.sayResolution(null)
    // Every cache that is keyed on the address, in this order: the open is
    // memoised on the promise, the read on a key that cannot tell two
    // resolutions apart, and the analysis facts on nothing at all — they are
    // fetched once and held, which is right for a panel whose URI never moves
    // and wrong for the one control that moves it. A starred panel is
    // re-prepared by the deck, which is told through `onResolved` below and is
    // the only thing that knows whether anybody is going to ask.
    this.opening = null
    this.read = null
    this.facts = null
    this.preparing = null
    // Another rung is another map: as stored until it is told otherwise, and
    // counted by a census of its own (§6.5).
    this.drawnAt = undefined
    this.depthHeld = null
    this.refusalHeld = null
    this.census = null
    this.counted = undefined
    this.nameEl.title = uri
    this.props.onResolved(uri)
    this.panel?.setBusy(true)
    this.say('')
    if (this.state !== null) await this.load(this.state)
  }

  /**
   * Open the file, or open one of the maps inside it (§3.4).
   *
   * A collection — an `.mcool` of resolutions, an `.mmetacool` of entries — is
   * not a map at its root, and the reader mirrors Python's `KeyError` for it
   * faithfully. Faithful is right for the reader and wrong here: somebody who
   * dropped an `.mcool` on a deck meant *this data beside that*, and answering
   * with a sentence about `::` syntax in the rectangle where their map should
   * be is an error message standing in for a feature.
   *
   * One hop, never two. `firstEntry` only answers for a collection root, and
   * the URI it produces names an entry, so a second refusal is a real one —
   * looping on it would hammer the worker with the same failing open.
   */
  private async openOrDescend(): Promise<OpenResult> {
    try {
      return await this.client.request<'open'>({
        kind: 'open',
        uri: this.uri,
        source: this.props.source,
      })
    } catch (err) {
      const landing = firstEntry(err, this.props.preferBinsize())
      if (landing === null) throw err
      // The *path* with a group on it, so a local file keeps the handle it was
      // dropped with: `source` is unchanged because it is the same bytes, and
      // only the address inside them has moved.
      this.resolved = `${splitUri(this.uri).path}::${landing.group}/${landing.entry}`
      this.nameEl.title = this.resolved
      this.props.onResolved(this.resolved)
      return this.client.request<'open'>({
        kind: 'open',
        uri: this.resolved,
        source: this.props.source,
      })
    }
  }

  private async load(state: ViewState): Promise<void> {
    this.state = state
    this.seed()
    const plan = this.planOf(state)
    if (plan.kind === 'none') {
      this.read = null
      this.body.replaceChildren()
      const had = this.panel !== null
      this.panel?.destroy()
      this.panel = null
      if (had) this.props.onCardChange?.()
      this.say(plan.reason)
      // Cleared here and in the catch below, for the reason the selection
      // branch of `readBlock` gives: a rename note left standing over a panel
      // that now says "nothing to draw" describes a picture that is gone.
      this.sayRename([])
      this.props.onSettled()
      return
    }

    try {
      const info = await this.open()
      if (this.disposed) return
      this.opened = info
      this.countContacts(info)
      this.paintEntries(info)
      // The ladder is known now, so a press this panel was too early to answer
      // can be answered honestly: either this *is* the rung it asked for and
      // there was never anything to say, or it is one this file has — in which
      // case `openEntry` has moved this panel's address — or it is one this
      // file has not, and the note it writes now has a real bin size in it.
      // See {@link wantedBinsize}.
      const wanted = this.wantedBinsize
      this.wantedBinsize = undefined
      if (wanted !== undefined && wanted !== info.binsize) {
        // **Abandoned on a descent, and only on one.** `openEntry` clears
        // `opening` and `read` and re-enters `load` at the new rung; carrying
        // on here would then key *this* read against the old address, overwrite
        // the key the new one is waiting on, and leave the panel drawing the
        // rung the reader has just moved off. The address is what says a
        // descent happened, and a refusal — or the rung it is already on —
        // leaves it alone and draws the block this read was for.
        const was = this.uri
        if (this.useBinsize(wanted) && this.uri !== was) return
      }
      // Drawn to the tab's total before anything is read from it (§6.5). The
      // worker queues the read behind the census either way; awaiting it here
      // is what lets a refusal be said once, in this panel's own frame.
      await this.drawTo(state.contacts ?? null)
      if (this.disposed) return
      const key = this.keyFor(state, plan, info)
      if (key === this.read) return
      this.read = key
      this.panel?.setBusy(true)
      this.say('')
      const { block: result, wrap } = await this.readBlock(state, plan, info)
      if (this.disposed || this.read !== key) return
      // Kept only for the read that is drawn: a read overtaken by a newer one
      // must not leave its lap behind for the ladder of a block it is not.
      this.wrap = wrap
      this.show(result, info, state)
      this.props.onSettled()
    } catch (err) {
      if (this.disposed) return
      this.sayRename([])
      // The key is *kept*. Every refusal a companion meets is deterministic — a
      // name this file has not got, a block this share of the budget will not
      // lend — so clearing it would re-issue the same refused read on every
      // repaint, which for a colour slider is one per nudge. Changing the region
      // changes the key, which is what retries.
      this.panel?.setBusy(false)
      // A companion never replaces the page with an error screen. The lead's
      // map is a complete picture on its own and the reader is looking at it;
      // what a companion owes them is one sentence in its own frame saying why
      // its rectangle is empty. That covers the two failures that are actually
      // common — a name this file does not have (§5.4) and a block this share
      // of the budget will not lend (§16.7) — and it keeps the deck usable
      // while one of its files is wrong.
      this.say(err instanceof ViewerError || err instanceof Error ? err.message : String(err))
      this.props.onSettled()
    }
  }

  /**
   * What was read, as a string — the cache key of {@link read}.
   *
   * Everything that changes the *block*, and nothing that changes its colour.
   * A key that carried the transform would re-read the file on every nudge of
   * the clip; one that omitted the level would keep a bin-level block on screen
   * under a contig-level axis.
   */
  private keyFor(state: ViewState, plan: Exclude<BlockPlan, { kind: 'none' }>, info: OpenResult): string {
    // The lead's naming context is part of the key, because it is part of what
    // the names *mean* (§5.9): a block resolved before the lead's contigs had
    // arrived was resolved with no context, and reusing it afterwards would
    // pin a panel to the reading it made while it was still guessing.
    // …and whether the sequence is declared round, which decides whether a
    // window across its origin reads at all (§8.15): a tick in the Chromosomes
    // table has to re-read a companion that refused the window a moment ago.
    const sequence = plan.kind === 'names' && plan.cols === undefined ? plan.rows.split(':')[0] : null
    return JSON.stringify([
      plan,
      this.levelOf(state),
      this.scoreOf(info, state).id,
      this.props.naming?.() ?? null,
      sequence !== null && (this.props.circular?.() ?? []).includes(sequence),
      // The total it is drawn to (§6.5): another number is another map.
      state.contacts ?? null,
    ])
  }

  /**
   * The score this panel reads, resolved against **its own** columns.
   *
   * The deck's choice first, because the score is one of the things a deck
   * shares and the lead's default is not written into the hash for a companion
   * to find (see {@link MapPanelProps.score}). Then the state, then the file's
   * own default — and `scoreFor` lands on counts for any of them this file
   * cannot serve, which is the same rule a hash naming a missing column meets.
   */
  private scoreOf(info: OpenResult, state: ViewState) {
    const choices = this.scoreChoicesOf(info)
    // This panel's own choice first, where the reader has made one: it is the
    // most specific thing anybody has said about *these* cells, and the deck's
    // is a default rather than a rule (see {@link scoreOverride}).
    const shared = this.scoreOverride ?? this.props.score()
    return scoreFor(choices, shared === undefined ? state : { ...state, score: shared })
  }

  /**
   * What this file's cells could be — its weights, and its extra columns — and,
   * where the first map is on one sequence declared circular, the baseline
   * along its two arms: the arms are the first map's frame, which is this map's
   * too (§8.15).
   */
  private scoreChoicesOf(info: OpenResult) {
    const arms = this.props.derive()?.arms
    return scoreChoices({
      hasWeights: info.hasWeights,
      scoreColumns: info.scoreColumns,
      circle: arms !== undefined && arms.refusal === null && arms.frame?.circular === true,
    })
  }

  /**
   * Tell the deck how this map is drawn now, so it can be written down.
   *
   * Every road that changes it ends here — this map's *Map* card, the first
   * map's card while nothing is starred, and the deck's own "match all scales"
   * — because the memory is of *what this map looks like*, not of which control
   * was touched.
   */
  private reportLook(): void {
    // **Minus whatever a derivation borrowed**, which is the same distinction
    // `PanelDeck.leadBaseLook` makes and for a sharper reason here. A panel under
    // `O/E` is forced onto `log2` and a diverging ramp with its clip dropped
    // (`MatrixPanel.syncDivergingScale`); writing that down would record the
    // *deck's* current derivation as this map's own choice, and a session
    // reopened without `O/E` would come back drawing plain counts on a ratio's
    // scale. `baseScale` is that scale with the borrowing undone, which is what
    // the reader actually set.
    const look = this.panel?.baseScale() ?? this.look
    this.props.onLook?.({
      ...(look.transform === undefined ? {} : { transform: look.transform }),
      ...(look.colormap === undefined ? {} : { colormap: look.colormap }),
      ...(look.vmin === undefined ? {} : { vmin: look.vmin }),
      ...(look.vmax === undefined ? {} : { vmax: look.vmax }),
      ...(this.scoreOverride === null ? {} : { score: this.scoreOverride }),
      ...(this.expectedOwn === null ? {} : { oe: this.expectedOwn }),
      ...(this.smoothOwn === null ? {} : { smooth: this.smoothOwn }),
      ...(this.armsOwn === null ? {} : { arms: this.armsOwn.window ?? null }),
      ...(this.ownPlace === null ? {} : { place: this.ownPlace }),
    })
  }

  private async readBlock(
    state: ViewState,
    plan: Exclude<BlockPlan, { kind: 'none' }>,
    info: OpenResult,
  ): Promise<{ block: MatrixResult; wrap?: [number, number] }> {
    const choice = this.scoreOf(info, state)
    const level = this.levelOf(state)
    // Resolved against *this* file's columns rather than carried over from the
    // lead: a hash naming `expected` is naming a column, and the file beside it
    // may not have one. Falling back to counts is the same rule `scoreFor`
    // applies to a hash naming a column the lead does not have.
    const value = choice.value === undefined || choice.value === COUNT_SCORE ? {} : { value: choice.value }
    const balance = choice.balance ? { balance: true } : {}
    const budgetBytes = this.props.budgetBytes()
    // How the map whose names these are counts its own sequences, forwarded to
    // every request that resolves one. See {@link MapPanelProps.naming}: it is
    // two booleans, and it is the only thing a name cannot carry (§5.9).
    const naming = this.props.naming?.()

    if (plan.kind === 'selection') {
      const result = await this.client.request<'selection'>({
        kind: 'selection',
        unit: plan.unit,
        names: plan.names,
        ...(naming === undefined ? {} : { naming }),
        budgetBytes,
        ...balance,
        ...value,
      })
      // Said here too, and this early return is why: a selection that skipped
      // the note left the previous view's rename standing over an unrelated
      // picture, which is worse than not saying it at all.
      this.sayRename(result.matched ?? [])
      return { block: result }
    }

    // **A window on a declared circle is asked as one** (§8.15). The declaration
    // is the session's, in the first map's spelling of the sequence, and the
    // worker checks a wrap against *this* file's — so the sequence is looked up
    // bare first, which is also the lap a window across its origin is read
    // modulo. Only for one sequence on the diagonal: a two-axis block has two
    // sequences and nothing to wrap, exactly as on the first map.
    const declared = plan.kind === 'names' && plan.cols === undefined ? this.props.circular?.() ?? [] : []
    const sequence = plan.kind === 'names' ? plan.rows.split(':')[0] : ''
    const lap =
      declared.includes(sequence)
        ? await this.client.request<'range'>({
            kind: 'range',
            range: sequence,
            ...(naming === undefined ? {} : { naming }),
          })
        : null
    const round = lap !== null && lap.kind === 'contig' ? [lap.label] : undefined
    // The resolved ranges are kept whole rather than reduced to their extents: a
    // range that had to be matched across conventions says so, and the panel
    // prints it.
    const rowRange =
      plan.kind === 'whole'
        ? null
        : await this.client.request<'range'>({
            kind: 'range',
            range: plan.rows,
            ...(naming === undefined ? {} : { naming }),
            ...(round === undefined ? {} : { circular: round }),
          })
    const colRange =
      plan.kind === 'names' && plan.cols !== undefined
        ? await this.client.request<'range'>({ kind: 'range', range: plan.cols, ...(naming === undefined ? {} : { naming }) })
        : null
    this.sayRename([rowRange?.matched, colRange?.matched])
    const rows: [number, number] = rowRange === null ? info.displayExtent : rowRange.extent
    const cols = colRange === null ? {} : { cols: colRange.extent }
    // The lap, where the window runs off the end of it — `ori`'s frame, or a
    // window typed backwards across the origin — and nothing where it does not,
    // so every other read on a circle is the read it always was.
    const wrap = round !== undefined && lap !== null && rows[1] > lap.extent[1] ? lap.extent : undefined

    if (level === 'contig') {
      const block = await this.client.request<'aggregate'>({
        kind: 'aggregate',
        rows,
        ...cols,
        level: 'contig',
        ...balance,
        ...value,
        budgetBytes,
      })
      return { block }
    }
    const block = await this.client.request<'matrix'>({
      kind: 'matrix',
      rows,
      ...cols,
      ...(wrap === undefined ? {} : { wrap }),
      ...balance,
      ...value,
      budgetBytes,
    })
    return wrap === undefined ? { block } : { block, wrap }
  }

  /**
   * Put a block on screen, building the map the first time.
   *
   * The panel is built with the session's annotations — the one store, read
   * through this map's id, so the tracks placed on it are drawn here — and with
   * **no** compare and no level toggle. Not an oversight: each of those two is
   * a control over something the deck shares, and offering five copies of a
   * shared control is five ways for a reader to put the deck out of step with
   * itself. The tracks' own cards stay the session's too (see below).
   *
   * The **score** used to be on that list and is not any more. The argument for
   * keeping it off was right about the default and wrong about the choice: the
   * cells of five replicates should be one quantity unless somebody says
   * otherwise, and "unless somebody says otherwise" needs a control to say it
   * with. Two ordinary cases had none — a companion carrying a column its lead
   * has not got, and a pair a reader wants at two normalisations — and both
   * ended at a picker that does not exist. So the score is offered here, it
   * starts on whatever the deck resolved, and picking one takes *this* panel off
   * the shared answer and leaves every other panel where it was
   * ({@link scoreOverride}).
   */
  private show(result: MatrixResult, info: OpenResult, state: ViewState): void {
    // Recorded before `setData` reads it and on every block, because a panel
    // outlives the derivation it was constructed with: the reader may have
    // turned O/E on, or flipped the deck, while this companion was fetching.
    // Recorded rather than applied — `rederive` would rebuild the picture from
    // the block that is about to be replaced.
    this.panel?.setDerive(this.derivation())
    this.panel?.setTurn(this.props.turn())
    // **The store the lanes are read from is captured at construction, and the
    // session builds a new one on every open.** A change of resolution is a
    // fresh open — so is re-dropping the file, so is following a link into
    // another entry — and `Session.setUpAnnotations` puts down the old
    // `AnnotationStore` and makes another, keyed on the new URI. The lead's view
    // is rebuilt around it and a companion's is not, so from that moment the
    // companion was subscribed to a store nobody writes to: every track placed
    // on it, computed or dropped, went into the live store and was drawn
    // nowhere. Rebuilt rather than reconciled, because the store is threaded
    // through the lanes, the editor, the groups card and four canvases, and one
    // of them holding the previous one is the same bug again. The block is
    // already in hand — `setData` runs below — so this costs a construction and
    // no read.
    const context = this.props.annotations()
    // `?? null` on both sides: the context is `undefined` while the session has
    // no stores yet, and `undefined !== null` would rebuild the map on every
    // block it read until it had.
    const store = context?.store ?? null
    if (this.panel !== null && store !== this.laneStore) {
      this.panel.destroy()
      this.panel = null
    }
    if (this.panel === null) {
      this.laneStore = store
      // Read once, here, rather than held from construction: a companion is
      // built before its file has been opened and the lead may have been
      // recoloured in between.
      //
      // The lead's **clip** only where this panel is drawing the same quantity.
      // A clip is a pair of numbers in one score's units, and a file with no
      // weight column falls back to counts (see {@link scoreOf}) — handing it a
      // lead's balanced `[-3.8, -0.4]` would draw a perfectly good map as a
      // black rectangle, from a control the reader never pointed at it. The
      // transform and the ramp are handed over either way: a deck whose panels
      // are drawn with different ramps is one where the eye has to translate
      // before it can compare.
      const look = this.props.initialLook()
      const shared = this.props.score()
      const comparable = shared === undefined || shared === this.scoreOf(info, state).id
      this.look = {
        ...(comparable ? look : { transform: look.transform, colormap: look.colormap }),
        ...this.look,
      }
      const turn = this.props.turn()
      const derive = this.derivation()
      this.panel = new MatrixPanel({
        binsize: info.binsize ?? 1,
        balance: this.scoreOf(info, state).balance,
        initial: this.look,
        ...(derive === undefined ? {} : { derive }),
        ...(turn === undefined ? {} : { turn }),
        ...(context === undefined ? {} : { annotations: context }),
        detachedControls: true,
        hideTitle: true,
        caption: { file: fileLabel(this.uri), depth: () => this.depthHeld },
        // Built from **this** file's columns, not from the lead's: what a
        // companion's cells can be is a fact about its own `/pixels`, and a
        // dropdown offering a column this file has not got would refuse the one
        // thing it appeared to promise.
        scores: {
          choices: this.scoreChoicesOf(info),
          current: this.scoreOf(info, state).id,
          onChange: (choice) => this.useScore(choice.id),
        },
        // A box drawn on this map is the deck's to answer (§16.3): it moves the
        // deck while this map follows it, and reads a window for this map alone
        // while it does not. Without the handler the renderer would only
        // magnify the block already here, which is what a companion used to do.
        ...(this.props.onSelectRegion === undefined
          ? {}
          : { onSelectRegion: (selection: SelectedRegion) => this.props.onSelectRegion?.(selection) }),
        // The clip a companion arrives at is its own — see {@link applyLook}.
        onScaleChange: (scale) => {
          this.look = scale
          this.reportLook()
        },
      })
      // Nothing under the picture and nothing on it. A companion's settings
      // are its *Map* card, which the Aesthetics column shows while this map
      // is starred (§16.5) — the corner menu that used to hold them put a
      // second place to set a map beside the column that sets every other
      // picture. Not the Tracks card and not Groups either: both are about
      // the annotations, which are the session's.
      this.panel.setCardFor(this.cardTarget)
      // Reported for the deck's benefit, not this panel's: a companion lays
      // nothing out, but the room its stack takes is the deck's business.
      this.panel.setLaneListener(() => this.props.onLanes?.())
      // Whatever the deck reserved while this panel was still reading its file.
      this.panel.setLaneFloor(this.laneFloor)
      this.body.replaceChildren(this.panel.el)
      this.props.onCardChange?.()
    }
    // After the panel exists, and on every block. `readBlock` runs *before* the
    // first one is built, so a score applied there is applied to nothing — which
    // left a balanced companion labelled `Count` and, worse, scaled as one.
    const score = this.scoreOf(info, state)
    this.panel.setScoreLabel(score.label)
    this.panel.setBalanced(score.balance)
    // …and the picker, which is not the source of the answer while this panel is
    // still following the deck: the lead's own picker, a link and the back
    // button can all move the shared score, and a dropdown left on the previous
    // one is a control lying about the map it sits on. The list with it, since
    // a circle ticked under the deck offers the baseline along its arms (§8.15).
    this.panel.offerScores(this.scoreChoicesOf(info), score.id)
    this.say('')
    this.panel.setResolution((info.binsize ?? 1) * (result.binsPerCell ?? 1))
    // Both on every block, not only at construction: a panel outlives a change
    // of rung, and an exported figure captioned with the entry this map *was*
    // at is wrong in the one place nobody re-checks.
    // The reader's name where they have given one, on `ui/mapNames.ts`'s rule
    // that a map is called the same thing everywhere it is named — the heading,
    // the readout, the key, and the caption on the figure this exports.
    const label = this.props.label?.() ?? fileLabel(this.uri)
    this.panel.setCaptionFile(label)
    this.panel.setData(result, label)
    this.armRefine(result, info, state)
    this.nameEl.title =
      `${this.uri} — ${resolutionLabel(info.binsize ?? 0)} bins, ` +
      `${fmt.int(result.nrows)}×${fmt.int(result.ncols)} cells` +
      (state.view === 'whole' ? ' (whole file)' : '')
  }

  /**
   * Let this panel's zoom read, inside what it already has.
   *
   * Bin level and a positional axis only, and the ceiling is the block itself —
   * see {@link ladder}. The score and the balance come from {@link scoreOf},
   * which resolves against *this* file's columns rather than the lead's, exactly
   * as {@link readBlock} does: a companion refining with the lead's choice would
   * be drawing a column it may not have.
   */
  private armRefine(result: MatrixResult, info: OpenResult, state: ViewState): void {
    this.ladder?.destroy()
    this.ladder = null
    if (result.level !== 'bin' || (result.contigsPerCell ?? 1) > 1) return
    const choice = this.scoreOf(info, state)
    const value = choice.value === undefined || choice.value === COUNT_SCORE ? {} : { value: choice.value }
    const balance = choice.balance ? { balance: true } : {}
    // A block read across a circle's origin is refined across it too — the
    // ceiling is that frame, and a read inside it past the sequence's end is a
    // read round the lap (§8.15).
    const wrap = this.wrap
    this.ladder = attachRefine({
      panel: this.panel as MatrixPanel,
      ceiling: { rows: result.rowExtent, cols: result.colExtent },
      binsize: info.binsize ?? 1,
      rungs: rungsOf(info.entries),
      budget: () => this.props.budgetBytes(),
      read: (rows, cols, rung) => {
        const own = this.client.cancellable<'matrix'>({
          kind: 'matrix',
          ...(rung === undefined ? {} : { rung }),
          rows,
          cols,
          ...(wrap === undefined ? {} : { wrap }),
          ...balance,
          ...value,
          budgetBytes: this.props.budgetBytes(),
        })
        return { cancel: own.cancel, promise: own.promise.then((block) => ({ result: block })) }
      },
      // A companion never replaces the page with an error screen, and a refine
      // that will not fit is the mildest thing that can go wrong in one: the map
      // it already has is a complete picture, and the sentence goes in the same
      // line every other refusal here goes in.
      onInstalled: (block) => {
        this.nameEl.title =
          `${this.uri} — ${resolutionLabel(info.binsize ?? 0)} bins, ` +
          `${fmt.int(block.nrows)}×${fmt.int(block.ncols)} cells`
      },
      onError: (err) => this.say(err instanceof Error ? err.message : String(err)),
    })
    this.ladder.adopt(result)
  }

  /** One line under the heading, or none. */
  private say(message: string): void {
    this.note.textContent = message
    this.note.classList.toggle('hidden', message === '')
  }

  /** One line about a resolution this file has not got, or none. */
  private sayResolution(message: string | null): void {
    this.resNoteEl.textContent = message ?? ''
    this.resNoteEl.classList.toggle('hidden', message === null)
  }

  private sayRefusal(): void {
    this.lockNoteEl.textContent = this.refusal ?? ''
    this.lockNoteEl.classList.toggle('hidden', this.refusal === null)
  }

  /**
   * One line naming the sequence this panel actually drew, where that is not
   * the sequence it was asked for by name.
   *
   * A list rather than two axes, because the views that reach here differ in
   * how many names they resolved: an off-diagonal block has two and can have
   * matched on one axis and not the other, and a ticked selection has as many
   * as were ticked. A note that covered only the first would leave the rest
   * silently renamed. Where the lengths disagree the
   * sentence says so and stops short of the word "is": two files that spell one
   * chromosome differently and also size it differently are not obviously
   * describing the same sequence, and the reader is the one who can tell.
   */
  private sayRename(matches: ReadonlyArray<NameMatch | undefined | null>): void {
    const seen = matches.filter((match): match is NameMatch => match !== null && match !== undefined)
    const parts = seen
      // One sentence for a square block, whose two axes are the same match.
      .filter((match, at) => seen.findIndex((other) => other.asked === match.asked) === at)
      .map((match) =>
        match.lengths === 'differ'
          ? `“${match.asked}” read as “${match.name}” by ${describeTier(match.tier)} — but the two are different lengths`
          : `“${match.asked}” read as “${match.name}”, by ${describeTier(match.tier)}`,
      )
    this.renameNoteEl.textContent = parts.join('; ')
    this.renameNoteEl.classList.toggle('hidden', parts.length === 0)
  }
}

/**
 * Why a cell of the deck is empty — see {@link VacantPanel}.
 *
 * `remembered` is the third, and it is the one that names a file: this session
 * knows a local map sat here, because it wrote the name into its own memory
 * (`panels/deck.ts`), and the grant behind it did not answer — the file has
 * moved, or this browser never had one to give (§11). It is a different sentence
 * from `link`'s for the same reason `link` is a different sentence from
 * `drawn`'s: telling a reader "a map was here" about a file that is on their own
 * disk, and naming it, are not the same help.
 */
export type VacancyOrigin = 'drawn' | 'link' | 'remembered'

/**
 * Where a link left an empty cell, or where a reader drew one.
 *
 * Its own small class rather than a state of {@link MapPanel}, because it has
 * no worker, no reader and nothing to read: it is a sentence and a drop target.
 * Keeping the two apart is what stops "a panel with no file" from becoming a
 * branch in every method above.
 */
export class VacantPanel {
  readonly el: HTMLElement

  constructor(props: {
    /**
     * Whether this cell was **drawn** by the reader looking at it, or arrived
     * in a link.
     *
     * Only the words change, and they have to: the two are the same cell to
     * every line of code that touches it — the same `~` in the hash, the same
     * drop target, the same slot in the grid — but they are not the same fact
     * about the deck. One is a space somebody left for a file they are about to
     * choose; the other is a position that *had* a map in it, which no page can
     * re-open by name (§11), and telling a reader that a map "was here" when
     * they drew the empty cell themselves ten seconds ago is a small lie about
     * their own deck. The distinction lives only in this session: a reload
     * cannot tell them apart, which is why the link's wording covers both.
     */
    origin: VacancyOrigin
    /** The file this cell held, when `origin` is `remembered`. */
    name?: string
    onOpen(file: File): void
    /**
     * Fill this cell from a **published** file instead of a local one.
     *
     * The half that was missing. Every other place in this app that asks for a
     * file offers both roads — the picker, the Tracks card, the Compare card —
     * and an empty cell of a deck offered only the one a link cannot carry (§11),
     * so a reader following a shared deck with a `~` in it could fill the gap
     * only from their own disk, and the deck they repaired could not be shared
     * on. The box is folded away because the drop is the commoner gesture, not
     * because the URL is the lesser one.
     */
    onOpenUrl(url: string): void
    /**
     * A **model** dropped here from the Structures card (§25.3): the cell
     * becomes the structure cell and draws it.
     *
     * A file is not the only thing a reader can have ready for an empty cell.
     * With three models loaded the card's own button always means *the* one
     * structure cell, wherever that is; dragging one here says where as well as
     * which, and a cell somebody left empty is a place they already made room
     * in. Optional, because a deck that cannot hold a structure cell should not
     * light up as though it could.
     */
    onStructure?(id: string): void
    /**
     * A **track** dragged here from the Tracks card (§16.9): the cell becomes a
     * tracks cell drawing it. Absent where the session carries no tracks
     * (§8.5), and then the cell neither lights up for one nor promises it.
     */
    onTrack?(id: string): void
    /**
     * A row dragged here from the Files panel, once its file is in hand — the
     * same routing a file dropped from the desktop takes.
     */
    onPicked?(picked: PickedFile): void
    /**
     * A row of the Contact maps card dropped here (§16.9): that map in this
     * cell — a companion moved here, or the first map or its compared file
     * opened here as a picture of its own.
     */
    onMapRow?(row: MapRow): void
    onClose(): void
  }) {
    const drawn = props.origin === 'drawn'
    const remembered = props.origin === 'remembered' && props.name !== undefined
    const tracks = props.onTrack !== undefined
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file !== undefined) props.onOpen(file)
    })

    // **Nothing inside the zone but the zone.** An empty cell used to carry a
    // box to paste a URL into and a button onto the connected places, one above
    // the other in the middle of a rectangle whose whole message is *drop a
    // file here*. Both are gone: dropping is the gesture, clicking opens the
    // chooser, and browsing a connected folder is the Files column's job (§20).
    const zone = el(
      'div',
      { class: 'ann-drop deck-drop deck-vacant', attrs: { tabindex: '0', role: 'button' } },
      el('span', {
        class: 'ann-drop-label',
        // **Any cell, not a map.** A drawn cell used to say *drop a map here*,
        // which was true of the one thing it then took and hid the two other
        // kinds a deck holds: a tracks cell had no road on screen but the
        // bar's row, and a model only the Structures card's grip (§16.9).
        text: drawn
          ? tracks
            ? 'Drop a map, a track or a structure'
            : 'Drop a map or a structure'
          : remembered
            ? (props.name as string)
            : 'A map was here',
      }),
      el('span', {
        class: 'ann-drop-hint',
        text: drawn
          ? (tracks
              ? 'A contact map opens here as a map; a track or a structure — a file, or a row ' +
                'dragged from the Annotations panel — opens the cell that draws it. '
              : 'A contact map opens here as a map; a structure — a file, or a row of the ' +
                'Structures card — opens its model. ') + 'Click to choose a file; left empty, the link keeps the cell.'
          : remembered
            ? 'This cell held that file and it could not be re-opened. Drop it here again and the ' +
              'panel comes back where it was.'
            : 'The link left this cell with no file a page can fetch by name. Drop a map, a track ' +
              'or a structure here, or click to choose.',
      }),
      input,
    )
    zone.addEventListener('click', (event) => {
      if (event.target !== input) input.click()
    })
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') input.click()
    })
    const takesStructure = (event: DragEvent): boolean =>
      props.onStructure !== undefined && dragHasStructure(event)
    const takesTrack = (event: DragEvent): boolean => props.onTrack !== undefined && dragHasTrack(event)
    const takesRow = (event: DragEvent): boolean => props.onPicked !== undefined && dragHasFileRow(event)
    const takesMap = (event: DragEvent): boolean => props.onMapRow !== undefined && dragHasMapRow(event)
    zone.addEventListener('dragover', (event) => {
      if (!dragHasFiles(event) && !takesStructure(event) && !takesTrack(event) && !takesRow(event) && !takesMap(event)) {
        return
      }
      event.preventDefault()
      // A copy where the drag allows one — a file is opened, a row is placed —
      // and whatever it does allow otherwise, since an effect the source did not
      // allow is a drop the browser refuses (`dropEffectFor`).
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer, 'copy')
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
      // A model first: a drag from the Structures card carries no file, and
      // asking for one would drop it on the floor.
      const model = event.dataTransfer?.getData(STRUCTURE_DRAG_TYPE) ?? ''
      if (model !== '' && props.onStructure !== undefined) {
        event.stopPropagation()
        props.onStructure(model)
        return
      }
      // A map off the Contact maps card: this cell is where it goes.
      const map = props.onMapRow === undefined ? null : readMapRow(event)
      if (map !== null && props.onMapRow !== undefined) {
        event.stopPropagation()
        props.onMapRow(map)
        return
      }
      // A track row the same way: it carries an id and no file, and the
      // content area's own importer would otherwise read the drop as nothing.
      const track = event.dataTransfer?.getData(TRACK_DRAG_TYPE) ?? ''
      if (track !== '' && props.onTrack !== undefined) {
        event.stopPropagation()
        props.onTrack(track)
        return
      }
      // A Files-panel row names a file that still has to be fetched, which a
      // drop handler cannot wait for; the payload is read now and the rest
      // follows (`ui/fileDrag.ts`).
      if (props.onPicked !== undefined && dragHasFileRow(event)) {
        event.stopPropagation()
        const onPicked = props.onPicked
        void readFileDrag(event).then((picked) => {
          if (picked !== null) onPicked(picked)
        })
        return
      }
      const file = event.dataTransfer?.files?.[0]
      if (file !== undefined) props.onOpen(file)
    })

    this.el = el(
      'section',
      { class: 'deck-panel is-vacant' },
      el(
        'header',
        { class: 'deck-head' },
        el('span', { class: 'deck-name deck-name-vacant', text: 'empty' }),
        // No grip: an empty cell is a *place*, and dragging a place is not a
        // gesture. It is where the maps are dragged **to**.
        iconButton('x', 'Close this cell — the deck loses a place', () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      zone,
    )
  }

  /** Nothing to release: a vacancy holds no worker and no bytes. */
  destroy(): void {}
}
