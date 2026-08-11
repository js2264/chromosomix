/**
 * One of the three columns beside the map: **General**, **Annotations**,
 * **Aesthetics**.
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
 * folded it gets it back.
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
 */

import { icon, type IconName } from './icons'
import { el } from './dom'
import { resizeHandle } from './resizeHandle'
import { keyLabel, withKey } from './commands'

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
  minWidth: 200,
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
  minWidth: 200,
  maxWidth: 480,
  closeIcon: 'chart-spline',
  openIcon: 'chart-spline',
  keys: 'm',
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
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
  ) {
    this.collapsed = readFlag(spec.key)
    this.width = readWidth(spec) ?? spec.defaultWidth

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

  /** Fold or open, and tell the shell the plot has room to re-measure in. */
  private fold(collapsed: boolean): void {
    if (collapsed === this.collapsed) return
    this.collapsed = collapsed
    writeFlag(this.spec.key, collapsed)
    this.paint()
    this.onResize()
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
      commit: () => writeWidth(this.spec, this.width),
      reset: () => {
        this.setWidth(this.spec.defaultWidth)
        writeWidth(this.spec, null)
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
    this.toggle.classList.toggle('hidden', !this.available)
    this.toggle.classList.toggle('is-off', this.collapsed)
    this.toggle.replaceChildren(icon(this.collapsed ? this.spec.openIcon : this.spec.closeIcon))
    this.toggle.title = withKey(
      this.collapsed ? `Show the ${this.spec.title} panel` : `Fold the ${this.spec.title} panel`,
      this.spec.keys,
    )
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed))
  }
}
