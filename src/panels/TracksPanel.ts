/**
 * The tracks cell (§25.3): the session's tracks alone, in a cell of the deck.
 *
 * A `BrowserView` over the lead file's own sequences — the same store, client,
 * groups and marks the map's lanes draw from — restricted to the tracks the
 * reader has **placed on this cell**, by the deck's id for it. Which is what
 * "send a track to any cell" means: the location control lists this cell
 * beside the maps, with one edge, and a track put on it is drawn here and
 * nowhere the reader did not put it.
 *
 * It follows the maps and the maps follow it, and it is not a member of the
 * deck's lock. The lock's currency is cells of a block, and a stack of tracks
 * has no block; what it has is base pairs, so the deck hands it the lead's
 * window as loci ({@link applyWindow}, one way, never reported back) and it
 * hands the lead a stretch when the reader pans it ({@link TracksPanelProps.onFollow}),
 * which the lead reports through the lock to every other map. Two roads and no
 * loop: the window this cell asked for comes back as the window it is already
 * showing, and `BrowserView.applyWindows` recognises it to the pixel.
 *
 * The chain in its heading is the same choice a map's is — *this one is not
 * like the others* — and unhooking it stops both roads at once.
 */

import type { AnnotationStore } from '../annotations/store'
import type { GroupSettings } from '../annotations/groups'
import type { ManualStore } from '../annotations/manual'
import type { AnnotationClient } from '../annotations/worker/client'
import type { Assembly, LocusRange } from '../genome/assembly'
import { SequenceSelection } from '../genome/selection'
import type { LocusWindow } from '../render/locus'
import type { ViewState } from '../types'
import { BrowserView } from '../ui/BrowserView'
import { el } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { clampCellHeight, heightBar } from './cellHeight'
import { DECK_DRAG_TYPE } from './deck'
import type { DeckCell } from './cell'

/** What the session lends a tracks cell: the machinery its own browser has. */
export interface TracksContext {
  /** The lead file's sequences, which are the axis. */
  assembly: Assembly
  store: AnnotationStore
  client: AnnotationClient
  groups: GroupSettings
  manual?: ManualStore
}

export interface TracksPanelProps {
  /** The deck's id for this cell — the map id its lanes are placed under. */
  id: string
  /**
   * The session's annotation machinery, asked each time: a browser session
   * replaces its store when its lengths are, and a cell holding the old one
   * would draw a list nobody can see.
   */
  context(): TracksContext | undefined
  /** The × on the heading. */
  onClose(): void
  /** The reader panned this cell: take the maps to this stretch. */
  onFollow(range: LocusRange): void
  /** The grip before the name was taken hold of, or let go. */
  onDragChange(dragging: boolean): void
  /**
   * How wide the lead's lanes are, so this cell's lanes read the same data.
   *
   * Forwarded straight to `BrowserViewProps.sampleWidth`, which explains what it
   * buys: a summary level chosen from a cell's own 265 pixels is a different
   * level from the one chosen from the lead's, and the same track over the same
   * window then autoscales to two ceilings — a difference in the layout wearing
   * the clothes of a difference in the data. `0` for a deck with no lead map, in
   * which case there is nothing to agree with and the floor decides.
   */
  leadSampleWidth?(): number
  /**
   * What the cell is called while nobody has named it: {@link TRACKS_CELL_NAME},
   * or `tracks 2` for the second of several — the words the location control
   * lists it under, so the heading and the list agree. Asked, because it is
   * the deck that knows which tracks cell this is, and a cell closed before it
   * renumbers it.
   */
  defaultName?(): string
  /**
   * The reader typed a name into the heading, or emptied the box — `null`,
   * which hands the cell back to its {@link defaultName} and is what makes a
   * rename undoable, the rule a map's heading follows. The **cell** is
   * renamed and nothing else: the tracks on it are the session's, named on the
   * Tracks card, and a cell's name is where they are drawn rather than what
   * they are (§25.3).
   */
  onRename?(name: string | null): void
  /**
   * The reader set the cell's height with the bar under it, or gave it back
   * to the row (`null`), which the deck remembers by seat (§25.3).
   */
  onResize?(height: number | null): void
}

/** What a tracks cell is called until the reader calls it something else. */
export const TRACKS_CELL_NAME = 'tracks'

/** How long a cell's name may be — `ui/mapNames.ts`'s limit, for its reason. */
const NAME_LIMIT = 200

/** The part of the props the session supplies; the deck adds the rest. */
export type TracksCellProps = Pick<TracksPanelProps, 'context'>

export class TracksPanel implements DeckCell {
  readonly kind = 'tracks' as const
  readonly el: HTMLElement
  private readonly nameEl: HTMLInputElement
  private readonly note = el('p', { class: 'deck-note tracks-note hidden' })
  private readonly wrap = el('div', { class: 'tracks-wrap' })
  private readonly chain: HTMLButtonElement
  private browser: BrowserView | null = null
  private builtFrom: TracksContext | null = null
  /** Whether this cell follows the maps and the maps follow it. */
  private linked = true
  /** The lead's last window, so an unhooked cell hooked again lands there. */
  private windows: { rows: LocusWindow[]; cols: LocusWindow[] } | null = null
  /** Set while this cell is being *told* where to look, so it does not tell back. */
  private adopting = false
  private destroyed = false
  /**
   * What the reader called this cell, or `null` for its default. Restored by
   * the deck after the cell is built ({@link setName}), since it is the deck
   * that knows which of its tracks cells this is.
   */
  private named: string | null = null
  /** The height the reader set, in pixels, or `null` for the row's. */
  private held: number | null = null

  constructor(private readonly props: TracksPanelProps) {
    this.nameEl = this.nameBox()
    this.chain = iconButton('link', '', () => this.toggleLink(), { class: 'btn btn-icon deck-lock', size: 14 })
    this.el = el(
      'section',
      { class: 'deck-panel deck-tracks' },
      el(
        'header',
        { class: 'deck-head' },
        this.grip(),
        this.nameEl,
        this.chain,
        iconButton('x', 'Close the tracks cell (the tracks stay loaded)', () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      this.note,
      el(
        'div',
        { class: 'deck-body tracks-body' },
        this.wrap,
        heightBar({
          className: 'tracks-resize',
          picture: () => this.wrap,
          preview: (height) => this.hold(height),
          commit: (height) => {
            this.hold(height)
            this.props.onResize?.(height)
          },
        }),
      ),
    )
    this.syncChain()
    this.sync()
  }

  /** What this cell's own hover is published as, and what its lanes are placed under. */
  private get source(): string {
    return `tracks:${this.props.id}`
  }

  // -------------------------------------------------------------------------
  // The deck's calls
  // -------------------------------------------------------------------------

  apply(_state: ViewState): void {
    // What is being looked at reaches this cell as a window; the state names
    // a place on the maps' own terms. A rebuild is worth a look at the
    // context, though: the store may have been replaced under it.
    this.sync()
  }

  applyWindow(windows: { rows: LocusWindow[]; cols: LocusWindow[] } | null): void {
    this.windows = windows
    if (!this.linked) return
    this.follow()
  }

  remeasure(): void {
    this.browser?.remeasure()
  }

  repaint(): void {
    this.browser?.remeasure()
  }

  /** The name on the heading — the reader's, or the one the deck numbers it by. */
  get label(): string {
    return this.named ?? this.fallback
  }

  /** `tracks`, or `tracks 2` for the second of several: the name of a cell nobody named. */
  private get fallback(): string {
    return this.props.defaultName?.() ?? TRACKS_CELL_NAME
  }

  /** The reader's name for this cell, or `null` for none. */
  customName(): string | null {
    return this.named
  }

  /**
   * Name this cell from the deck's memory — a reload, a link — which is not a
   * rename: nobody typed it, so nobody is told.
   */
  setName(name: string | null): void {
    this.named = tracksCellName(name)
    this.syncName()
  }

  /** The height the reader set with the bar under the stack, or `null` for the row's. */
  customHeight(): number | null {
    return this.held
  }

  /** Hold the cell at a height from the deck's memory, which nobody is told of: see {@link setName}. */
  setHeight(height: number | null): void {
    this.hold(height === null ? null : clampCellHeight(height))
  }

  /**
   * Put the name back in the box. Skipped while the caret is in it, for the
   * reason a map's heading skips it: a box rewritten under a reader mid-word
   * is the one way an editable heading is worse than a printed one.
   */
  syncName(): void {
    if (document.activeElement === this.nameEl) return
    if (this.nameEl.value !== this.label) this.nameEl.value = this.label
  }

  exportCanvas(dpi: number, _now: Date): HTMLCanvasElement | null {
    return this.browser?.exportCanvas(dpi) ?? null
  }

  /** Another surface's pointer, as a guide on this axis at each place it names (§25.4). */
  showLocusEcho(loci: ReadonlyArray<{ contig: string; bp: number }> | null): void {
    this.browser?.showLocusEcho(loci)
  }

  destroy(): void {
    this.destroyed = true
    this.browser?.destroy()
    this.browser = null
  }

  // -------------------------------------------------------------------------
  // The browser inside
  // -------------------------------------------------------------------------

  /**
   * Hold the stack at `height` pixels, or give it back to the row (§25.3).
   *
   * On the cell, as the structure cell's is, where the stylesheet reads it:
   * the scroll box takes the height and the browser inside measures the box.
   */
  private hold(height: number | null): void {
    this.held = height
    if (height === null) {
      this.el.classList.remove('has-height')
      this.el.style.removeProperty('--tracks-h')
    } else {
      this.el.classList.add('has-height')
      this.el.style.setProperty('--tracks-h', `${height}px`)
    }
    this.browser?.remeasure()
  }

  /** Build the browser over the session's machinery, or rebuild it when that changed. */
  private sync(): void {
    if (this.destroyed) return
    const context = this.props.context()
    if (context === undefined) {
      this.browser?.destroy()
      this.browser = null
      this.builtFrom = null
      this.wrap.replaceChildren()
      this.say('No tracks here: this session has no track list to draw from.')
      return
    }
    if (this.builtFrom !== null && this.builtFrom.store === context.store && this.builtFrom.assembly === context.assembly) {
      return
    }
    this.browser?.destroy()
    this.wrap.replaceChildren()
    // Every sequence of the file, untied from the session's own ticks: the
    // cell shows where the maps are, and a sequence the reader unticked in
    // the browser is still one the maps can be looking at.
    const view = new BrowserView({
      assembly: context.assembly,
      store: context.store,
      client: context.client,
      selection: new SequenceSelection(),
      groups: context.groups,
      ...(context.manual === undefined ? {} : { manual: context.manual }),
      map: this.props.id,
      hoverSource: this.source,
      onLocusChange: () => this.report(),
      ...(this.props.leadSampleWidth === undefined
        ? {}
        : { sampleWidth: () => this.props.leadSampleWidth?.() ?? 0 }),
    })
    this.browser = view
    this.builtFrom = context
    this.wrap.append(view.el)
    this.say('')
    this.follow()
  }

  /**
   * The heading's name, editable in place (§25.3): two stacks of tracks side
   * by side are two cells a reader wants to tell apart — *G1* and *G2M*, the
   * forward strand and the reverse — and `tracks` twice tells them nothing.
   *
   * The pointer events are stopped because the heading is a *deck* heading: the
   * grip beside this makes the cell draggable, and a browser reads a drag that
   * begins in a text box as a drag of the cell rather than as a selection.
   */
  private nameBox(): HTMLInputElement {
    const input = el('input', {
      class: 'input deck-name',
      type: 'text',
      value: this.label,
      title: 'The session’s tracks placed on this cell. Click to rename the cell — its tracks keep their names',
    })
    const revert = (): void => {
      input.value = this.label
    }
    input.addEventListener('change', () => {
      const next = tracksCellName(input.value, this.fallback)
      if (next === this.named) {
        revert()
        return
      }
      this.named = next
      revert()
      this.props.onRename?.(next)
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

  private say(message: string): void {
    this.note.textContent = message
    this.note.classList.toggle('hidden', message === '')
  }

  /** Show the lead's window here, without telling anybody. */
  private follow(): void {
    const browser = this.browser
    const windows = this.windows
    if (browser === null || windows === null || windows.cols.length === 0) return
    this.adopting = true
    try {
      browser.applyWindows(windows.cols)
    } finally {
      this.adopting = false
    }
  }

  /** The reader moved this cell: the maps go where it went. */
  private report(): void {
    if (this.adopting || !this.linked || this.browser === null) return
    const range = this.browser.framedRange()
    if (range !== null) this.props.onFollow(range)
  }

  private toggleLink(): void {
    this.linked = !this.linked
    this.syncChain()
    if (this.linked) this.follow()
  }

  private syncChain(): void {
    this.el.classList.toggle('is-unlocked', !this.linked)
    this.chain.replaceChildren(icon(this.linked ? 'link' : 'unlink', { size: 14 }))
    // The same second sentence a map's chain says and the lead's: one glyph,
    // one pair of verbs (§25.3). The first is this cell's own, because it is the
    // one surface the maps follow back.
    this.chain.title = this.linked
      ? 'Following the maps, and they follow it. Click to move this cell on its own.'
      : 'Moving on its own. Click to put it back in step with the maps.'
    this.chain.setAttribute('aria-pressed', String(this.linked))
  }

  private grip(): HTMLElement {
    const node = el('span', {
      class: 'deck-grip',
      title: 'Drag to move this cell to another cell of the deck',
      attrs: { draggable: 'true', 'aria-label': 'Move this cell' },
    })
    node.append(icon('grip-vertical', { size: 12 }))
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DECK_DRAG_TYPE, this.source)
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
}

/**
 * A cell's name from something that claims to be one: trimmed, bounded, and
 * `null` for an empty box or the words the cell has anyway — a name that is
 * {@link TRACKS_CELL_NAME}, or the cell's own numbered default, is no name, so
 * emptying the box and typing the default land in the same place.
 */
export function tracksCellName(value: unknown, fallback: string = TRACKS_CELL_NAME): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, NAME_LIMIT)
  return trimmed === '' || trimmed === TRACKS_CELL_NAME || trimmed === fallback ? null : trimmed
}
