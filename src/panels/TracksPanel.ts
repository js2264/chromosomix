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
}

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

  constructor(private readonly props: TracksPanelProps) {
    this.nameEl = el('input', {
      class: 'input deck-name',
      type: 'text',
      value: 'tracks',
      title: 'The session’s tracks, those placed on this cell',
    })
    this.nameEl.readOnly = true
    this.nameEl.addEventListener('pointerdown', (event) => event.stopPropagation())
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
      el('div', { class: 'deck-body tracks-body' }, this.wrap),
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

  syncName(): void {
    // Named for what it is rather than for a file: the cell holds the
    // session's tracks, and the session has one name for those already.
  }

  exportCanvas(dpi: number, _now: Date): HTMLCanvasElement | null {
    return this.browser?.exportCanvas(dpi) ?? null
  }

  /** Another surface's pointer, as a guide on this axis (§25.4). */
  showLocusEcho(locus: { contig: string; bp: number } | null): void {
    this.browser?.showLocusEcho(locus)
  }

  destroy(): void {
    this.destroyed = true
    this.browser?.destroy()
    this.browser = null
  }

  // -------------------------------------------------------------------------
  // The browser inside
  // -------------------------------------------------------------------------

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
    })
    this.browser = view
    this.builtFrom = context
    this.wrap.append(view.el)
    this.say('')
    this.follow()
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
