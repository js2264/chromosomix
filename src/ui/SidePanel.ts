/**
 * One of the columns beside the map: **Files**, **General**, **Annotations**,
 * **Aesthetics**, **Analysis**.
 *
 * They started as three unrelated things — a sidebar with a fold button, a
 * column added later with a fold button copied from it, and a controls column
 * with no button at all — and the difference showed: one was named, one was not,
 * one could be folded and one could not, and none could be resized. They are the
 * same object, so they are now one class, and the differences that remain are a
 * name, a side and a default width.
 *
 * **Named**, because a column with no heading is a column whose contents have to
 * be recognised before they can be used, and because the fold buttons in the
 * header need something to be the name of.
 *
 * **Foldable**, and the fold is a *preference*: it lives in `localStorage`
 * beside the theme, not in the per-session `state/UiMemory`. Two states are
 * conflated on purpose — a panel with nothing to show is hidden and its button
 * goes with it, without touching the stored choice, so someone who folded a
 * panel and opened a second file gets it folded again while someone who never
 * folded it gets it back. A column can also start folded
 * ({@link SidePanelSpec.defaultFolded}): Annotations and Analysis do, so that
 * a first visit on a laptop shows a map rather than five columns.
 *
 * **Resizable**, by dragging its inner edge. A default width is a guess about a
 * window nobody has measured: three columns and a square plot is a lot to fit,
 * and which of them deserves the room depends on whether you are reading
 * taxonomy in General or driving twelve tracks in Annotations. The width is
 * remembered for the same reason the fold is, and double-clicking the handle
 * puts it back.
 *
 * ## Folded is a tab, not nothing
 *
 * A folded column used to leave the layout entirely, which left the header's
 * four buttons as the only sign that it existed — and those are up in the window
 * furniture, spelling out neither which column is folded nor what is in it. So a
 * folded column keeps a **strip** of itself in the flow, with a tab standing on
 * the bottom of it: the panel's mark, its name, the key that opens it, and a
 * chevron pointing the way it will open.
 *
 * Turned a quarter-turn anticlockwise, so the name reads bottom-to-top up the
 * side of the window like the spine of a book on a shelf. That is what buys it
 * the room to be *named*: a strip of the width the word "General" needs standing
 * upright would be a column, and what a folded column has to cost is a strip.
 *
 * Being in the flow is the whole of the nesting the tabs have to get right, and
 * it comes for free. `order` already puts the four columns outermost-first from
 * each edge — General then Annotations on the left, Analysis then Aesthetics
 * from the right — so a folded strip sits exactly where its column would: two
 * folded panels are two tabs side by side at the edge of the screen, and opening
 * the outer one pushes the inner one's tab out to stand against it. Nothing
 * measures anything, and no tab can be left behind an expanded column.
 *
 * A panel with *nothing to show* still leaves altogether ({@link setAvailable}):
 * a tab is an invitation, and one that opens an empty column is worse than the
 * column's absence.
 *
 * An **open** column says the other half of that sentence with one chevron in
 * its own heading ({@link chevron}), beside the key badge and pointing the way
 * it will go. The header's row of marks can fold any of them, but it stands two
 * columns from what it acts on and names neither the column nor the direction —
 * and a reader who wants *this* one out of the way is looking at this one.
 *
 * ## Four of them describe the open file, and one does not
 *
 * §16.5 says these columns are the session's furniture and each describes the
 * one file the session is of. {@link FILES_PANEL} is the exception and is meant
 * to be: what it holds is the *places* this window has been connected to, which
 * are the same in every tab and outlive all of them, exactly as the theme does.
 *
 * It is a column rather than a dialog because of what a reader does with it —
 * they work out of a folder for an afternoon, opening a file, looking, opening
 * the next — and a door you pass through fifty times should not be a door. That
 * also makes it the one panel available with **nothing open at all**: a reader
 * who has connected a folder and not yet opened anything is exactly the reader
 * it is for, so what it follows is the *list of places*, not the file.
 *
 * It is also the one panel whose availability is not the session's to decide
 * (`App.refreshFilesPanel`): a place is connected for as long as the window
 * lives, so the column is there while there is one and gone while there is
 * not. It used to be there unconditionally, because its own *Open a
 * local/remote folder* was the only door to a folder and a door nobody can see
 * is not a door; the landing page now offers the four places itself (§24.2),
 * which is what lets this column obey the same rule as the four beside it.
 */

import { icon, type IconName } from './icons'
import { el } from './dom'
import { resizeHandle } from './resizeHandle'
import { keyLabel, withKey } from './commands'

/**
 * One column's shape, as a workspace file carries it.
 *
 * The fold is a *preference* and lives in `localStorage` (see the file header),
 * which is exactly why it also has to travel: a saved workspace is what somebody
 * was looking at, and a window that comes back with the Analysis column open
 * over a reader who had folded it — or, worse, with Annotations folded away from
 * the twelve tracks the file was saved for — is the one part of the arrangement
 * that did not return. The same argument `SessionConfig.plot` already makes for
 * the overlays, which are a window preference carried in a session file for the
 * same reason.
 *
 * The width travels beside it because the two are one decision. A column folded
 * to a strip and a column dragged to 520 pixels are both answers to *how much
 * room does this deserve*, and restoring one without the other puts a reader's
 * twelve-track column back at the default 320 with their fold honoured, which
 * reads as the restore having half worked.
 */
export interface PanelState {
  folded: boolean
  /** CSS pixels. Absent where the reader has never dragged this column. */
  width?: number
}

/** Every column's state, by {@link SidePanelSpec.key}. */
export type PanelLayout = Record<string, PanelState>

export interface SidePanelSpec {
  /** Stable storage key. Not the title: renaming a panel must not forget it. */
  key: string
  /** The heading, and the noun the fold button's tooltip is built from. */
  title: string
  /** Which end of the body it sits at; decides which edge carries the handle. */
  side: 'left' | 'right'
  /**
   * Order within `.app-body`. Lower is further from the map. The content column
   * is `0`, so a left panel is negative and a right panel positive.
   */
  order: number
  /** Width in CSS pixels before anyone has dragged it. */
  defaultWidth: number
  minWidth: number
  maxWidth: number
  /** Shown while open (clicking folds) and while folded (clicking opens). */
  closeIcon: IconName
  openIcon: IconName
  /**
   * The key that folds this panel, shown beside its heading.
   *
   * A shortcut nobody can find is a shortcut nobody uses, and the dialog that
   * lists them is two gestures away. This one is written where the thing it acts
   * on already is — which is also where a reader is looking when the thought
   * "get this out of the way" arrives.
   */
  keys: string
  /**
   * Folded until the reader opens it, in a window that has never chosen.
   *
   * Five open columns beside a square plot leave the plot a sliver on a laptop,
   * so the two a reader reaches for least often on arrival — the annotation
   * stack and the analysis list — start folded. Absent means open by default.
   * Either way a stored choice wins, and a reader who opens one keeps it open.
   */
  defaultFolded?: boolean
}

/**
 * The folders this window is connected to, and what is in them.
 *
 * **Outermost on the left**, past General: it is the column a reader arrives
 * *through* rather than one they drive the picture with, and the two beside the
 * map should be the two that are about the map. `order: -3` puts it there, and
 * puts its folded tab outside General's, which is the order they are read in.
 *
 * `f`, for files, which cost `ui/plotOptions.ts` a shortcut it explains giving
 * up. The alternative was `q` or `z` — all that the single-letter space had left
 * — and a column nobody can name the key of is a column reached by mouse only.
 *
 * A `folder-tree` rather than a plain folder: what is behind it is not one
 * directory but a set of places, each opening into levels, and the mark that
 * says so is the one with the branches on it.
 */
export const FILES_PANEL: SidePanelSpec = {
  key: 'metacooler-viewer:files-collapsed',
  title: 'Files',
  side: 'left',
  order: -3,
  // Wider than General's 288, and it is the one column where width buys
  // something concrete: every row is a file name off a sequencer run sheet, and
  // the names are long, similar, and distinguished by their ends.
  defaultWidth: 320,
  minWidth: 240,
  maxWidth: 600,
  closeIcon: 'folder-tree',
  openIcon: 'folder-tree',
  keys: 'f',
}

/**
 * The file's attributes, its record card, the QC statistic and the metadata.
 *
 * A `file-cog` rather than the fold arrow it used to carry, which is the same
 * change its three siblings already made: they are marked by *what they hold* —
 * `layers` for the annotation stack, `chart-spline` for the picture's controls,
 * `beaker` for what can be computed — and an arrow said only "this panel folds",
 * which is true of all four. What is behind this one is the file and what can be
 * read off it, so the mark is a document with a cog on it.
 */
export const GENERAL_PANEL: SidePanelSpec = {
  // The key predates the rename from "file info sidebar"; a stored fold is not
  // worth losing to make a string match a heading.
  key: 'metacooler-viewer:sidebar-collapsed',
  title: 'General',
  side: 'left',
  order: -2,
  // Narrower than the 22rem it started at. Its widest row is a URI, which is
  // elided anyway, and it was taking room from two columns that spend theirs on
  // controls rather than on a key/value list.
  defaultWidth: 288,
  // **What the File card needs.** It was 200, and at 200 the key/value grid left
  // the values about forty pixels: `storage mode` read `symme tric- upper` and
  // the file's own URI came down the column four characters at a time. The keys
  // here are the longest in the application — `non-zero pixels` beside a grouped
  // count — so the floor is what those two need side by side. Same correction as
  // Aesthetics' below, and for the same reason: a minimum is a promise.
  minWidth: 240,
  maxWidth: 560,
  closeIcon: 'file-cog',
  openIcon: 'file-cog',
  keys: 'b',
}

/**
 * Linear annotations, map overlays and hand-drawn marks.
 *
 * A `layers` mark rather than a third panel-fold arrow: three arrows in one
 * header is a coin toss every time, and what this one folds away is not "a
 * panel" to the reader but their tracks and overlays.
 */
export const ANNOTATION_PANEL: SidePanelSpec = {
  key: 'metacooler-viewer:annotations-collapsed',
  title: 'Annotations',
  side: 'left',
  order: -1,
  // Folded on arrival: the tracks are drawn on the map whether or not their
  // list is open, and the list is one keypress away.
  defaultFolded: true,
  defaultWidth: 320,
  minWidth: 240,
  maxWidth: 560,
  closeIcon: 'layers',
  openIcon: 'layers',
  keys: 'a',
}

/**
 * What can be *computed* from what is open, as against what is drawn (§18.1).
 *
 * A list and nothing else: one row per task, each with its state, and clicking
 * one opens the drawer. A column that both lists twenty tasks and configures
 * them is a column that does neither, which is why the drawer is a second
 * surface rather than this one growing a form.
 *
 * `j`, because `b`, `a` and `m` are the other three and the single-letter space
 * is otherwise all but spent between `ui/commands.ts` and `ui/plotOptions.ts`.
 *
 * Outermost on the right — `order: 2`, past Aesthetics — because it is the
 * column touched least often per session and the one whose absence costs the
 * least while a reader is driving the picture.
 */
export const ANALYSIS_PANEL: SidePanelSpec = {
  key: 'metacooler-viewer:analysis-collapsed',
  title: 'Analysis',
  side: 'right',
  order: 2,
  // Folded on arrival, for the same reason it is outermost.
  defaultFolded: true,
  defaultWidth: 300,
  minWidth: 240,
  maxWidth: 520,
  closeIcon: 'beaker',
  openIcon: 'beaker',
  keys: 'j',
}

/**
 * Transform, colormap, clip, overlays and export — whatever the view offers.
 *
 * A **plot** rather than a panel chevron, which is what this used to carry. Its
 * two siblings are marked by what they hold — `layers` for the annotation
 * stack, `beaker` for what can be computed — and a left-pointing chevron said
 * only *this thing folds*, which every one of the three does and which the
 * arrow's direction already showed. What is behind it is the picture's own
 * controls, so the mark is the picture.
 */
export const AESTHETICS_PANEL: SidePanelSpec = {
  key: 'metacooler-viewer:aesthetics-collapsed',
  title: 'Aesthetics',
  side: 'right',
  order: 1,
  defaultWidth: 256,
  // **What its own controls need.** It was 200, and at 200 this column crushed
  // the things it exists to hold: the two clip limits read `-4.1` and the
  // `transform` and `colours` selects cut `log10` and `default`. A minimum is a
  // promise that the cards below still work at it, and this one was not keeping
  // it — a drag to the floor was as bad as the window being too narrow, and
  // since the columns now give way before the picture does (`.content`'s
  // `min-width`) the floor is reached by more than a drag.
  minWidth: 240,
  maxWidth: 480,
  closeIcon: 'chart-spline',
  openIcon: 'chart-spline',
  keys: 'm',
}

/**
 * The stored fold, or `fallback` where the reader has never chosen.
 *
 * `'1'` is folded and `'0'` is open. The open state is written rather than
 * the key removed, because a column that starts folded has to tell a reader
 * who opened it from one who never touched it — and an absent key is the
 * second, whatever the default.
 */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
    return fallback
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* a browser that refuses storage still folds correctly for this session */
  }
}

/** Stored width, or `null` — including for a stored value that is now absurd. */
function readWidth(spec: SidePanelSpec): number | null {
  try {
    const raw = window.localStorage.getItem(`${spec.key}:width`)
    if (raw === null) return null
    const value = Number(raw)
    // Untrusted input, exactly like the URL hash: a stored width outlives the
    // build that wrote it, and the bounds may have moved since.
    if (!Number.isFinite(value)) return null
    return Math.max(spec.minWidth, Math.min(spec.maxWidth, value))
  } catch {
    return null
  }
}

function writeWidth(spec: SidePanelSpec, width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(`${spec.key}:width`)
    else window.localStorage.setItem(`${spec.key}:width`, String(Math.round(width)))
  } catch {
    /* as above */
  }
}

export class SidePanel {
  /** The column itself, to be appended to `.app-body`. */
  readonly el: HTMLElement
  /** The fold button, to be appended to the header. */
  readonly toggle: HTMLButtonElement

  private readonly body = el('div', { class: 'panel-column-body' })
  /** What a folded column shows instead of itself; see the file header. */
  private readonly tab: HTMLButtonElement
  private collapsed: boolean
  private width: number
  private available = false

  constructor(
    private readonly spec: SidePanelSpec,
    /**
     * Called after a fold or a resize has changed the column's width.
     *
     * The plot is centred in what is left, and sized by it: the shell uses this
     * to let whatever is mounted re-measure. A `ResizeObserver` on the view
     * cannot stand in for it — the plot is often sized by the window's *height*,
     * so widening its column changes no box the observer is watching while still
     * changing where the plot should sit.
     */
    private readonly onResize: () => void = () => {},
    /**
     * Called when the reader has *settled* on a shape for this column.
     *
     * Distinct from {@link onResize}, which fires on every pixel of a drag
     * because the plot has to follow the hand. This one fires on a fold and at
     * the end of a drag, and it exists because the shape of the columns is now
     * part of a saved workspace (see {@link PanelState}) — so somebody who folds
     * a column and closes the browser should find it folded, rather than finding
     * whatever the last navigation happened to record. Rebuilding a workspace
     * per frame of a drag is what the separation buys.
     */
    private readonly onSettle: () => void = () => {},
    /**
     * Whether this column's fold and width belong to the reader's browser.
     *
     * `true` everywhere a window is the whole page, and the reason the two are
     * in `localStorage` at all: how wide somebody keeps their Annotations column
     * is a preference about *them*, not about a file (§5.6).
     *
     * `false` in an embed, and it has to be, in **both** directions. Reading
     * would open a column inside somebody's figure because the reader once left
     * it open on the app's own site — an arrangement they made for a window this
     * is not. Writing would be worse: a reader who opens a panel to look at one
     * lane in an embedded figure would find the app itself rearranged the next
     * time they went to it, by a page they were only reading. So an embed's
     * columns start folded and leave no trace, which is the same rule
     * `App.remember` states one level up about the window as a whole.
     */
    private readonly remembers = true,
  ) {
    this.collapsed = this.remembers ? readFlag(spec.key, spec.defaultFolded ?? false) : true
    this.width = (this.remembers ? readWidth(spec) : null) ?? spec.defaultWidth

    this.tab = this.spine()
    this.el = el(
      'div',
      // The title is also the identifying class, so a stylesheet can name one
      // column — the narrow layout drops General and keeps the other two — with
      // a selector that says which, rather than with a positional guess.
      { class: `panel-column panel-column-${spec.side} panel-${spec.title.toLowerCase()}` },
      el(
        'div',
        { class: 'panel-column-head' },
        el('h2', { class: 'panel-column-title', text: spec.title }),
        el('kbd', {
          class: 'kbd panel-column-key',
          text: keyLabel(spec.keys),
          title: `Press ${keyLabel(spec.keys)} to fold or open this panel`,
        }),
        this.chevron(),
      ),
      this.body,
      this.handle(),
      this.tab,
    )
    this.el.style.order = String(spec.order)

    this.toggle = el('button', {
      class: 'btn btn-icon',
      type: 'button',
      attrs: { 'aria-label': `${spec.title} panel` },
    })
    this.toggle.addEventListener('click', () => this.fold(!this.collapsed))

    this.paint()
  }

  /**
   * The tab a folded column stands on its edge.
   *
   * Everything a header button cannot say, in the order it is read going up:
   * which panel this is, what it is called, the key that opens it, and the
   * direction it will open in. The chevron points *away from its own edge* — into
   * the window, which is where the column will appear from — and it is the one
   * part of the tab drawn upright rather than with the text, because a chevron
   * turned with the words would point along the spine and mean nothing.
   */
  private spine(): HTMLButtonElement {
    const key = keyLabel(this.spec.keys)
    const node = el(
      'button',
      {
        class: 'panel-tab',
        type: 'button',
        title: withKey(`Show the ${this.spec.title} panel`, this.spec.keys),
        attrs: { 'aria-label': `Show the ${this.spec.title} panel` },
      },
      icon(this.spec.openIcon, { size: 14, class: 'panel-tab-mark' }),
      el('span', { class: 'panel-tab-title', text: this.spec.title }),
      el('kbd', { class: 'kbd panel-tab-key', text: key }),
      icon(this.spec.side === 'left' ? 'chevron-right' : 'chevron-left', {
        size: 13,
        class: 'panel-tab-mark panel-tab-chevron',
      }),
    )
    node.addEventListener('click', () => this.fold(false))
    return node
  }

  /**
   * The fold, written on the column that folds.
   *
   * A *folded* column has carried the way back on itself since the tabs arrived
   * — its mark, its name, its key and a chevron — while an open one carried
   * nothing at all: the only way to put it away was the row of marks up in the
   * window furniture, which are two columns from the thing they act on and say
   * neither which one they belong to nor which way it will go. That asymmetry is
   * what this closes, and it closes it beside the key badge, which is the other
   * half of the same sentence: *this panel folds, and here is the shortcut*.
   *
   * The chevron points **the way this column travels**, which is the opposite of
   * the one {@link spine} draws and is the part a later reader will get
   * backwards. A tab is an offer to *open*, so its chevron points away from its
   * own edge and into the window the column will appear in; this is an offer to
   * *close*, so it points at the edge the column is about to go back against —
   * `chevron-left` for a left-hand column, `chevron-right` for a right-hand one.
   * Both obey the one rule that holds for the pair: press it and the panel moves
   * the way the arrow points.
   *
   * It needs no state and so is absent from {@link paint}: unlike the header's
   * button it means one thing only, and the stylesheet already takes it away
   * with the rest of the heading when the column folds — a second mechanism here
   * would be a second thing to keep in step.
   */
  private chevron(): HTMLButtonElement {
    const node = el(
      'button',
      {
        class: 'panel-column-fold',
        type: 'button',
        title: withKey(`Fold the ${this.spec.title} panel`, this.spec.keys),
        // The key is in the tooltip but not in the name, as on the tab: a label
        // read aloud as "fold the General panel, bracket, B" is a shortcut
        // spelled out to the one reader who cannot press it while looking.
        attrs: { 'aria-label': `Fold the ${this.spec.title} panel` },
      },
      icon(this.spec.side === 'left' ? 'chevron-left' : 'chevron-right', { size: 14 }),
    )
    // Through `fold` like the other three ways in, so the stored preference, the
    // relayout and the workspace write happen once and in one place.
    node.addEventListener('click', () => this.fold(true))
    return node
  }

  /** Fold or open, and tell the shell the plot has room to re-measure in. */
  private fold(collapsed: boolean, persist = true): void {
    if (collapsed === this.collapsed) return
    this.collapsed = collapsed
    if (this.remembers && persist) writeFlag(this.spec.key, collapsed)
    this.paint()
    this.onResize()
    this.onSettle()
  }

  /** Fill the column, or empty it. */
  setContent(nodes: readonly HTMLElement[]): void {
    this.body.replaceChildren(...nodes)
  }

  /**
   * Whether there is anything for this panel to show.
   *
   * The picker has no file, so General and Annotations leave the layout rather
   * than standing as empty columns beside the dropzone; a `.metacool` carries no
   * annotations at all (§8.5); and a table view offers no aesthetics. In every
   * case the column and its button go together.
   */
  setAvailable(available: boolean): void {
    if (available === this.available) return
    this.available = available
    this.paint()
    this.onResize()
  }

  /** `true` when it is folded by choice rather than absent for want of content. */
  get isCollapsed(): boolean {
    return this.collapsed
  }

  /**
   * This column's shape, for a workspace file.
   *
   * {@link available} is deliberately not in it. A column with nothing to show
   * is hidden *without touching the stored choice* — that is the conflation the
   * file header argues for — so reporting it here would write "folded" into a
   * saved workspace for every column the file that was open had no use for, and
   * a reader who opened a `.metacool` and saved would find Annotations folded on
   * the next `.cool` they restored it over.
   */
  get layout(): PanelState {
    return { folded: this.collapsed, ...(this.width === this.spec.defaultWidth ? {} : { width: this.width }) }
  }

  /**
   * Put a shape back, as a restored workspace asks for.
   *
   * Written to `localStorage` on the way through rather than held for this
   * window only, because that is where a fold lives and a restore that did not
   * write it would be undone by the next reload — the reader would watch their
   * arrangement arrive and then leave again, with nothing on screen to blame.
   *
   * An absent `width` is *the default back*, not "leave it alone": a workspace
   * saved from a window nobody had dragged is a workspace whose columns are the
   * default width, and honouring the importing window's old drag instead would
   * make the same file restore to two different layouts.
   */
  applyLayout(state: PanelState | undefined): void {
    if (state === undefined) return
    this.setWidth(state.width ?? this.spec.defaultWidth)
    if (this.remembers) writeWidth(this.spec, state.width ?? null)
    this.fold(state.folded)
    // `fold` returns early when nothing changed, so a state that only moved the
    // width has still to be painted — which `setWidth` did, unless the width
    // did not move either. Cheap, and the alternative is two flags.
    this.paint()
  }

  /**
   * Open this column because something it holds has just been asked for.
   *
   * The one way a panel unfolds without the reader pressing its own button, and
   * it is deliberately narrow: connecting a folder is a gesture whose *answer*
   * is in this column, so leaving it folded would be answering into a drawer.
   * It writes the stored preference like any other unfold, because a reader who
   * has just been shown the column and leaves it open has chosen to.
   */
  reveal(): void {
    this.fold(false)
  }

  /**
   * Fold this column because what it was for has just happened.
   *
   * The mirror of {@link reveal}, and as narrow: a file chosen or dropped on
   * the landing page has opened, and the Files column — the one column that
   * page shows — has done its job. It does *not* write the stored preference,
   * because the reader did not fold it and the landing page they come back to
   * needs it open; the next reload starts from their own choice, as before.
   */
  conceal(): void {
    this.fold(true, false)
  }

  /**
   * The draggable inner edge.
   *
   * The pointer plumbing lives in `ui/resizeHandle.ts`, because the Analysis
   * drawer has the same edge and is not a column — see that module's header for
   * the two details that are easy to get wrong and were, once.
   */
  private handle(): HTMLElement {
    return resizeHandle({
      side: this.spec.side,
      what: `${this.spec.title} panel`,
      width: () => this.width,
      resize: (px) => this.setWidth(px),
      commit: () => {
        if (this.remembers) writeWidth(this.spec, this.width)
        this.onSettle()
      },
      reset: () => {
        this.setWidth(this.spec.defaultWidth)
        if (this.remembers) writeWidth(this.spec, null)
        this.onSettle()
      },
    })
  }

  private setWidth(px: number): void {
    const next = Math.max(this.spec.minWidth, Math.min(this.spec.maxWidth, px))
    if (next === this.width) return
    this.width = next
    this.paint()
    this.onResize()
  }

  private paint(): void {
    // Three states, and the two that look alike to a stylesheet are not alike to
    // a reader: a panel with nothing in it leaves altogether, and a folded one
    // stands a named tab where it was. `collapsed` keeps its name because it is
    // the stylesheet's word for "this column is not showing its cards", and the
    // analysis drawer uses it for the same thing.
    this.el.classList.toggle('collapsed', this.collapsed || !this.available)
    this.el.classList.toggle('is-absent', !this.available)
    // Inline width for an open column, because that is the reader's own drag;
    // folded, the strip is one number in the stylesheet and an inline width here
    // would beat it.
    this.el.style.width = this.collapsed ? '' : `${this.width}px`
    // …and the floor it may be squeezed to when the window cannot hold every
    // column at its width. The drag's own minimum, because that is the width
    // this column's cards are built to survive; the picture takes the rest and
    // keeps a floor of its own (see `.content`'s `min-width`). Four columns at
    // their minima plus that floor come to 1,168 pixels, so nothing overflows on
    // any laptop, and at 1366 the map gets 486 instead of 140.
    this.el.style.minWidth = this.collapsed ? '' : `${this.spec.minWidth}px`
    this.toggle.classList.toggle('hidden', !this.available)
    this.toggle.replaceChildren(icon(this.collapsed ? this.spec.openIcon : this.spec.closeIcon))
    this.toggle.title = withKey(
      this.collapsed ? `Show the ${this.spec.title} panel` : `Fold the ${this.spec.title} panel`,
      this.spec.keys,
    )
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed))
  }
}
