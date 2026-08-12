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
import { describeTier, type NameContext, type NameMatch } from '../genome/naming'
import { DECK_DRAG_TYPE } from './deck'
import { matrixLevel, selectionOf } from '../state/ViewState'
import type { ViewState } from '../types'
import { ReaderClient } from '../worker/client'
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
import type { ManualPoint } from '../annotations/manual'
import {
  MatrixPanel,
  type AnnotationContext,
  type DerivePresentation,
  type TurnPresentation,
} from '../ui/MatrixPanel'
import { COUNT_SCORE, scoreChoices, scoreFor } from '../ui/scores'
import type { ScaleState } from '../ui/GenomeView'
import { el, fmt } from '../ui/dom'
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
        reason: 'this view is of one file — pick a region, a genome or a selection',
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
  /** The × on this panel's heading. */
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
   * The derivation the deck is showing, as a thunk so it is never stale.
   *
   * Shared, like the score and the level and for the same reason: a deck exists
   * to put N files' pictures of one place side by side, and one panel drawing
   * O/E beside four drawing raw counts is four wrong comparisons rather than a
   * choice. No handler on it, so a companion applies it and offers no control
   * over it (`ui/MatrixPanel.ts`'s `DerivePresentation`).
   */
  derive(): DerivePresentation | undefined
  /**
   * This panel's own lanes (`annotations/placement.ts`), or `undefined` where
   * the session carries no annotations at all (§8.5).
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
  private readonly nameEl: HTMLElement
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
    // The *file's* name only. The entry beside it is the picker below, and a
    // heading that printed `rep1.mcool::1000` and then offered `::1000` again
    // would be saying the same thing twice, once as a fact and once as a
    // control.
    this.nameEl = el('span', {
      class: 'deck-name',
      text: fileBaseLabel(props.uri),
      title: props.uri,
    })
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
    this.el = el(
      'section',
      { class: 'deck-panel' },
      el(
        'header',
        { class: 'deck-head' },
        this.grip(),
        this.nameEl,
        this.entryPicker,
        this.starButton,
        this.lockButton,
        iconButton('x', `Close ${fileLabel(props.uri)}`, () => props.onClose(), {
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
   */
  useBinsize(bp: number): boolean {
    if (!Number.isFinite(bp) || bp <= 0) return false
    // Already there, whatever the ladder looks like — including a plain cooler
    // that happens to be at the resolution the deck is moving to.
    if (this.binsize() === bp) {
      this.sayResolution(null)
      return true
    }
    const rungs = rungsOf(this.entries)
    const match = rungs.find((rung) => rung.binsize === bp)
    if (match === undefined) {
      this.sayResolution(
        `staying at ${fmt.bp(this.binsize() ?? 0)}: this file has no ${fmt.bp(bp)} level` +
          (rungs.length === 0
            ? ', and carries one resolution only.'
            : ` — it has ${rungs.map((rung) => fmt.bp(rung.binsize)).join(', ')}.`),
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
    this.starButton.disabled = on
    // `this.uri`, so a companion that descended into an entry names the rung it
    // is actually reading — which is the file a task would run against, and the
    // one thing this button is about.
    this.starButton.title = on
      ? `${fileLabel(this.uri)} is the map an analysis runs against`
      : `Run analyses against ${fileLabel(this.uri)} instead`
  }

  syncLock(): void {
    const wanted = this.props.isLocked()
    const refusal = this.props.lockNote()
    const following = wanted && refusal === null
    this.lockButton.replaceChildren(icon(following ? 'link' : 'unlink', { size: 14 }))
    this.lockButton.title = following
      ? 'Following the other maps. Click to move this one on its own.'
      : wanted
        ? (refusal ?? 'Not following the other maps.')
        : 'Moving on its own. Click to bring it back in step with the others.'
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
    this.panel?.rederive(this.props.derive(), undefined, this.props.turn())
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
  armPicking(
    onPoint: (point: { rows: ManualPoint; cols: ManualPoint }) => void,
    onEnd: () => void = () => {},
  ): () => void {
    return this.panel?.armPicking(onPoint, onEnd) ?? ((): void => {})
  }

  remeasure(): void {
    this.panel?.remeasure()
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
    const plan = planFor(state)
    if (plan.kind === 'none') {
      this.read = null
      this.body.replaceChildren()
      this.panel?.destroy()
      this.panel = null
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
      this.paintEntries(info)
      const key = this.keyFor(state, plan, info)
      if (key === this.read) return
      this.read = key
      this.panel?.setBusy(true)
      this.say('')
      const result = await this.readBlock(state, plan, info)
      if (this.disposed || this.read !== key) return
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
    return JSON.stringify([
      plan,
      matrixLevel(state),
      this.scoreOf(info, state).id,
      this.props.naming?.() ?? null,
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
    const choices = scoreChoices({ hasWeights: info.hasWeights, scoreColumns: info.scoreColumns })
    const shared = this.props.score()
    return scoreFor(choices, shared === undefined ? state : { ...state, score: shared })
  }

  private async readBlock(
    state: ViewState,
    plan: Exclude<BlockPlan, { kind: 'none' }>,
    info: OpenResult,
  ): Promise<MatrixResult> {
    const choice = this.scoreOf(info, state)
    const level = matrixLevel(state)
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
      return result
    }

    // The resolved ranges are kept whole rather than reduced to their extents: a
    // range that had to be matched across conventions says so, and the panel
    // prints it.
    const rowRange =
      plan.kind === 'whole'
        ? null
        : await this.client.request<'range'>({ kind: 'range', range: plan.rows, ...(naming === undefined ? {} : { naming }) })
    const colRange =
      plan.kind === 'names' && plan.cols !== undefined
        ? await this.client.request<'range'>({ kind: 'range', range: plan.cols, ...(naming === undefined ? {} : { naming }) })
        : null
    this.sayRename([rowRange?.matched, colRange?.matched])
    const rows: [number, number] = rowRange === null ? info.displayExtent : rowRange.extent
    const cols = colRange === null ? {} : { cols: colRange.extent }

    if (level === 'contig') {
      return this.client.request<'aggregate'>({
        kind: 'aggregate',
        rows,
        ...cols,
        level: 'contig',
        ...balance,
        ...value,
        budgetBytes,
      })
    }
    return this.client.request<'matrix'>({
      kind: 'matrix',
      rows,
      ...cols,
      ...balance,
      ...value,
      budgetBytes,
    })
  }

  /**
   * Put a block on screen, building the map the first time.
   *
   * The panel is built with **no** annotations, no compare, no level toggle and
   * no score picker. Not an oversight: each of those is a control over
   * something the deck shares, and offering five copies of a shared control is
   * five ways for a reader to put the deck out of step with itself. The one
   * control a companion keeps is its colour scale, because that is the one
   * thing §16.2 makes per panel.
   */
  private show(result: MatrixResult, info: OpenResult, state: ViewState): void {
    // Recorded before `setData` reads it and on every block, because a panel
    // outlives the derivation it was constructed with: the reader may have
    // turned O/E on, or flipped the deck, while this companion was fetching.
    // Recorded rather than applied — `rederive` would rebuild the picture from
    // the block that is about to be replaced.
    this.panel?.setDerive(this.props.derive())
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
    // `?? null` on both sides: a file with a genome layer carries no annotations
    // at all (§8.5), so the context is `undefined` for the life of the panel —
    // and `undefined !== null` would rebuild the map on every block it read.
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
      this.panel = new MatrixPanel({
        binsize: info.binsize ?? 1,
        balance: this.scoreOf(info, state).balance,
        initial: this.look,
        ...(this.props.derive() === undefined ? {} : { derive: this.props.derive() }),
        ...(turn === undefined ? {} : { turn }),
        ...(context === undefined ? {} : { annotations: context }),
        detachedControls: true,
        cornerControls: true,
        hideTitle: true,
        caption: { file: fileLabel(this.uri) },
        // The clip a companion arrives at is its own — see {@link applyLook}.
        onScaleChange: (scale) => {
          this.look = scale
        },
      })
      // Nothing under the picture. A companion's scale controls are on the map
      // itself, in the corner menu a detached panel builds for exactly this
      // case (`ui/MatrixPanel.ts`) — a fold under each panel pushed every other
      // panel of the deck down by the height of whatever was open in it. Not
      // the Tracks card and not Groups either: both are about annotations and a
      // companion carries none.
      // Reported for the deck's benefit, not this panel's: a companion lays
      // nothing out, but the room its stack takes is the deck's business.
      this.panel.setLaneListener(() => this.props.onLanes?.())
      // Whatever the deck reserved while this panel was still reading its file.
      this.panel.setLaneFloor(this.laneFloor)
      this.body.replaceChildren(this.panel.el)
    }
    // After the panel exists, and on every block. `readBlock` runs *before* the
    // first one is built, so a score applied there is applied to nothing — which
    // left a balanced companion labelled `Count` and, worse, scaled as one.
    const score = this.scoreOf(info, state)
    this.panel.setScoreLabel(score.label)
    this.panel.setBalanced(score.balance)
    this.say('')
    this.panel.setResolution((info.binsize ?? 1) * (result.binsPerCell ?? 1))
    // Both on every block, not only at construction: a panel outlives a change
    // of rung, and an exported figure captioned with the entry this map *was*
    // at is wrong in the one place nobody re-checks.
    this.panel.setCaptionFile(fileLabel(this.uri))
    this.panel.setData(result, fileLabel(this.uri))
    this.armRefine(result, info, state)
    this.nameEl.title =
      `${this.uri} — ${fmt.int(info.binsize ?? 0)} bp bins, ` +
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
    this.ladder = attachRefine({
      panel: this.panel as MatrixPanel,
      ceiling: { rows: result.rowExtent, cols: result.colExtent },
      binsize: info.binsize ?? 1,
      rungs: rungsOf(info.entries),
      read: (rows, cols, rung) => {
        const own = this.client.cancellable<'matrix'>({
          kind: 'matrix',
          ...(rung === undefined ? {} : { rung }),
          rows,
          cols,
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
          `${this.uri} — ${fmt.int(info.binsize ?? 0)} bp bins, ` +
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

/** Why a cell of the deck is empty — see {@link VacantPanel}. */
export type VacancyOrigin = 'drawn' | 'link'

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
    onOpen(file: File): void
    onClose(): void
  }) {
    const drawn = props.origin === 'drawn'
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file !== undefined) props.onOpen(file)
    })
    const zone = el(
      'div',
      { class: 'ann-drop deck-drop deck-vacant', attrs: { tabindex: '0', role: 'button' } },
      el('span', {
        class: 'ann-drop-label',
        text: drawn ? 'Drop a map here' : 'A map was here',
      }),
      el('span', {
        class: 'ann-drop-hint',
        text: drawn
          ? 'An empty cell of the deck you drew. Drop a cooler on it, or click to choose one, and ' +
            'it opens in this position under the same navigation as the maps beside it — same ' +
            'region, same level, its own colour scale. Leaving it empty is fine; the link keeps it.'
          : 'The link that opened this deck has a cell here with no file a page can fetch by name ' +
            '(§11) — either a local map the sender had open, or a cell they left empty on ' +
            'purpose. Drop a file here, or click to choose one, and the panel fills in where it ' +
            'was; the maps either side keep their order.',
      }),
      input,
    )
    zone.addEventListener('click', (event) => {
      if (event.target !== input) input.click()
    })
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') input.click()
    })
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
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
