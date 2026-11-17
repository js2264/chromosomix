/**
 * The box a map is drawn in, and the four handles on its edges (§7.2, §17.2).
 *
 * A square map's box is a width and a height, a square until the reader shapes
 * it (`ui/mapSize.ts`); a turned band's is its width and its depth
 * (`ui/turnBox.ts`). Both are the session's, so that a deck of maps is one
 * shape, and both are clamped on the way out to the room this panel has —
 * measured against the panel rather than against the grid the box is in, which
 * would follow the box down. This writes the box onto the grid as the custom
 * properties the stylesheet lays the map and its lanes out from, lays the
 * handles along the picture on every frame, and turns a drag or a key on one of
 * them into a new size in the store.
 *
 * Out of `ui/MatrixPanel.ts` because it is layout and not data: it reads which
 * presentation is on screen, and two rectangles off the renderer, and nothing
 * of the block. How deep a band is cut to fill the box stays with the panel —
 * `MatrixPanel.syncTurnDepth` re-cuts the turned block the panel holds and the
 * axes measured from it, and asks this only how tall the box is.
 */

import type { HeatmapView } from '../render/heatmap'
import type { RotatedBlock } from '../render/rotate'
import type { AnnotationLanes } from './AnnotationLanes'
import { shiftKey } from './commands'
import { el } from './dom'
import {
  MIN_MAP_SIZE,
  fitMapSize,
  getMapSize,
  resetMapSize,
  setMapSize,
  subscribeMapSize,
  type MapSize,
} from './mapSize'
import type { MatrixPanel } from './MatrixPanel'
import {
  MIN_TURN_HEIGHT,
  MIN_TURN_WIDTH,
  fitTurnBox,
  getTurnBox,
  setTurnBox as rememberTurnBox,
  subscribeTurnBox,
  type TurnBox,
} from './turnBox'

/**
 * What the box needs of the panel: the renderer and the lane stacks it is laid
 * out with, the two elements its size is written onto and read back from, and
 * which presentation is on screen.
 */
export interface BoxHost {
  /** The renderer: the rectangles the handles lie along, and a canvas to tell when its box changes. */
  readonly heatmap: HeatmapView
  /** The lane stacks, whose columns beside the map come out of the width a box has. */
  readonly lanes: AnnotationLanes
  /** The grid holding the map and its lanes, where the box is written; built after this is. */
  grid(): HTMLElement
  /** The map's own box inside the grid, whose `max-height` is the height a square map claims. */
  wrap(): HTMLElement
  /** The turned band on screen, or `null` for a square map: which picture's box this is. */
  turned(): RotatedBlock | null
  /** The grid's last measured size, which the room falls back on before the panel is laid out. */
  hostSize(): { width: number; height: number }
  /** Ask the panel for a frame. */
  schedule(): void
}

/** The box one map is drawn in, its handles, and the room it has. */
export class MapBox {
  /**
   * The four edges of the picture, as things a hand can take hold of.
   *
   * Bars rather than strips of live canvas, and visible on approach rather than
   * only under the pointer, because how big the picture is drawn is a decision
   * the reader has to be able to *find* — a gesture nobody can see is a gesture
   * nobody uses.
   *
   * Which of them are shown, and what a drag on one means, is the whole of the
   * difference between the two presentations:
   *
   * - **A square map** shows all four. The two ends set its width and the top
   *   and bottom its height (`ui/mapSize.ts`), so the box can be drawn as a
   *   rectangle — one zoom for both axes keeps every cell square inside it, and
   *   the longer side shows more genome. With Shift held, any edge resizes the
   *   box in proportion, which is how a square is made bigger and stays one.
   * - **A band** shows three. Its width and its depth are separate numbers
   *   (`ui/turnBox.ts`), and its fourth edge is the diagonal itself: the band
   *   stands on the axis, so there is nothing to drag there. Which of the
   *   horizontal pair is the far edge follows the direction the band grows in —
   *   up on an ordinary turn, down on the mirrored half of a comparison.
   */
  readonly grips: Record<PlotEdge, HTMLElement> = {
    top: plotGrip('top'),
    bottom: plotGrip('bottom'),
    left: plotGrip('left'),
    right: plotGrip('right'),
  }
  /** Which presentation the grips are labelled for; see {@link placeGrips}. */
  private gripMode: 'square' | 'band' | null = null
  /** The room the box has, measured once per resize. See {@link measureRoom}. */
  private room: { width: number; height: number } | null = null
  private readonly unsubscribeTurnBox: () => void
  private readonly unsubscribeMapSize: () => void
  private readonly heatmap: HeatmapView
  private readonly lanes: AnnotationLanes

  constructor(private readonly host: BoxHost) {
    this.heatmap = host.heatmap
    this.lanes = host.lanes
    // Every panel, not only the one whose handle was dragged: the box is the
    // session's, so a deck of bands is one shape (§17.3).
    this.unsubscribeTurnBox = subscribeTurnBox(() => this.applyTurnBox())
    // The square map's own size, on the same terms and through the same call: one
    // reader, one shape, however many pictures are drawn from it.
    this.unsubscribeMapSize = subscribeMapSize(() => this.applyTurnBox())
    this.watchGrips()
  }

  /** The turned band on screen, as the panel holds it now. */
  private get turned(): RotatedBlock | null {
    return this.host.turned()
  }

  /** The grid the box is written onto. */
  private get grid(): HTMLElement {
    return this.host.grid()
  }

  /** The map's own box, which the room's height is read back off. */
  private get wrap(): HTMLElement {
    return this.host.wrap()
  }

  /**
   * Take the room again, and redraw the box in it.
   *
   * Every road into this panel from a change of *space* ends here, and there are
   * four of them: the shell folding a column ({@link MatrixPanel.remeasure}),
   * the view's own `ResizeObserver` for a window resize or a lane appearing, a
   * turn arriving or leaving, and a deck relaying out. They used to end in
   * different places and only some of them redrew the box, so a turned band
   * kept the width of the window it was first drawn in: folding two columns gave
   * the map three hundred pixels it never took, and adding a track under it left
   * the band as wide as it was before the stack was there.
   *
   * A square map needs none of this — its canvas is sized by the stylesheet, and
   * `HeatmapView.resize` reads that — which is exactly why the turned one was
   * missed: it is the one picture in the app whose size is a number this class
   * computes.
   *
   * The band's *depth* follows on the next frame with nothing to arrange:
   * {@link MatrixPanel.syncTurnDepth} runs before every draw and re-cuts the
   * band whenever the box it has to fill has changed shape.
   *
   * Idempotent, and it has to be: writing the box resizes the grid, which is what
   * the observer is watching. The room is measured against the *panel* and never
   * against the grid the box is in ({@link measureRoom}), so a second pass over
   * the same window computes the same numbers and the loop stops on the first
   * repeat.
   */
  refit(): void {
    this.measureRoom()
    this.writeTurnBox()
  }

  /**
   * Lay the size handles along the edges of the picture.
   *
   * Placed from the measured rectangles on every frame, exactly as the key is, so
   * they follow a pan and a zoom with nothing to keep in step.
   *
   * The **plot** frame for a square map, on all four edges: the plot is what a
   * reader sees as the map — the canvas around it is the gutter its axis labels
   * live in — and the box being dragged is the canvas, so a handle on the frame
   * is the honest place to take hold of it.
   *
   * The band keeps the rectangle each of its own handles was always on. Its far
   * edge follows the **data**, because a band is as wide as its block while the
   * plot is as wide as the panel, and a bar across the plot would run out past
   * the picture at every zoom that does not fill it. Its two ends follow the
   * *plot*'s height for the opposite reason: a band fills its box vertically by
   * construction, so a handle that stopped at the last column would sit in the
   * middle of the picture pointing at nothing.
   */
  placeGrips(): void {
    const turned = this.turned
    const plot = this.heatmap.plotRect
    const data = this.heatmap.dataRect
    // `down` is the mirrored half of a comparison, where separation grows towards
    // the bottom of the picture and the far edge is the bottom one. The other
    // horizontal edge is the diagonal the band stands on, and is not a handle.
    //
    // A **mirrored pair** has no idle edge at all: the diagonal is in the middle
    // of the picture, both horizontal edges are far edges, and each of them sets
    // the same one number — how tall the box is — from its own side.
    const idle: PlotEdge | null =
      turned === null || turned.fold !== undefined
        ? null
        : turned.direction === 'up'
          ? 'bottom'
          : 'top'
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      this.grips[edge].classList.toggle('hidden', edge === idle)
    }
    this.labelGrips(turned === null ? 'square' : 'band')

    for (const edge of ['left', 'right'] as const) {
      const grip = this.grips[edge]
      grip.style.top = `${Math.round(plot.y)}px`
      grip.style.height = `${Math.round(plot.height)}px`
      grip.style.left = `${Math.round(edge === 'left' ? plot.x : plot.x + plot.width)}px`
    }
    for (const edge of ['top', 'bottom'] as const) {
      if (edge === idle) continue
      const grip = this.grips[edge]
      // The band's far edge sits on the data; a square map's edges are the frame.
      const box = turned === null ? plot : data
      grip.style.top = `${Math.round(edge === 'top' ? box.y : box.y + box.height)}px`
      grip.style.left = `${Math.round(box.x)}px`
      grip.style.width = `${Math.round(box.width)}px`
    }
  }

  /**
   * What the handles say they do, which is not the same thing in the two
   * presentations.
   *
   * Written when the presentation changes rather than on every frame: a title is
   * a DOM write, and {@link placeGrips} runs before every draw.
   */
  private labelGrips(mode: 'square' | 'band'): void {
    if (mode === this.gripMode) return
    this.gripMode = mode
    const same = 'Double-click for as much room as there is.'
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      this.grips[edge].title =
        mode === 'square'
          ? edgeAxis(edge) === 'y'
            ? `Drag to set how tall this map is drawn; hold ${shiftKey()} to keep its shape. ` +
              'Double-click for the height of the square it opens as.'
            : 'Drag to set how wide this map is drawn — both ends move, so it stays centred; ' +
              `hold ${shiftKey()} to keep its shape. Double-click for the width of the square ` +
              'it opens as.'
          : edgeAxis(edge) === 'y'
            ? `Drag to set how tall this band is drawn. The distance from the diagonal it ` +
              `reaches follows from the zoom — the box keeps its shape and the picture fills ` +
              `it. ${same}`
            : `Drag to set how wide this band is drawn. Both ends move, so the box stays ` +
              `centred, and the tracks under it follow. ${same}`
    }
  }

  /**
   * A drag on a handle sets how big the picture is drawn.
   *
   * Pixels, straight through: a handle is on the edge of a box measured in them,
   * so the edge goes exactly where the hand puts it. What each of the four edges
   * *means* is read at the moment of the drag rather than wired once, because the
   * same edge belongs to two pictures — the left edge of a band is one end of its
   * width, and the left edge of a square map is one end of *its* width — and a
   * panel changes between them under the reader's hand.
   *
   * Both presentations read the edges the same way now. The two ends are the
   * width, and move it at twice the hand because the box is centred — the edge
   * under the pointer has to stay under it, so the far end goes out by the same
   * amount. A horizontal edge is the height, and moves it at once: on a **band**
   * that is the far edge, its depth (`ui/turnBox.ts`); on a **square map** it is
   * either of the two (`ui/mapSize.ts`), and both move the height the same way.
   * The picture hangs from the stack above it, so its top is where the panel
   * starts and a taller box grows downward; the top handle therefore reads as
   * *out is bigger* rather than as an edge that follows the pointer — which is
   * what an edge handle means anyway, and the alternative is a picture that
   * floats in the middle of a reserved column with its tracks detached from it.
   *
   * A square map's box was one number, every edge setting the side, on the
   * argument that a square block has no shape to choose. That is true of the
   * block and not of the window onto it, and the reader who drew a rectangle by
   * accident — a track grown under the map took the height and left the width,
   * because nothing re-fitted the box (`MatrixPanel.syncLaneMetrics`) — found it
   * the better shape for reading along a diagonal, and found it snapped back to
   * a square by the next touch of a handle. So each side is its own, and **Shift
   * scales both**: any edge, the other side following in proportion, which is
   * the one-handle square resize this used to be and the modifier every image
   * editor keeps a shape with.
   *
   * Keyboard too, because this is the only way to reach the number without a
   * pointer and a `role="separator"` that answers no keys is a control that says
   * it is one.
   */
  private watchGrips(): void {
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) this.dragEdge(edge)
  }

  /**
   * One edge of the box, as something a hand or a keyboard can move.
   *
   * The four handles differ in three numbers and nothing else — which axis they
   * travel on, which way out of the box is, and how much the box grows per pixel
   * travelled — so they are one gesture parameterised rather than four listeners
   * that have to be kept saying the same thing.
   */
  private dragEdge(edge: PlotEdge): void {
    const grip = this.grips[edge]
    const axis = edgeAxis(edge)
    // Out of the box: left and up are negative on screen, right and down are
    // positive, and "out" is whichever of them leaves the picture's middle.
    const away = edge === 'left' || edge === 'top' ? -1 : 1
    // Both ends of a centred box move; one horizontal edge moves alone.
    const gain = axis === 'x' ? 2 : 1
    const along = (box: { width: number; height: number }): number =>
      axis === 'x' ? box.width : box.height

    let from: { at: number; box: { width: number; height: number } } | null = null
    const onDown = (event: PointerEvent): void => {
      // No guard on the presentation any more: both of them have a size for this
      // handle to move, and the one edge that has none — the diagonal a band
      // stands on — is hidden rather than inert ({@link placeGrips}).
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      // Both sides of the box as drawn: a drag with Shift scales the other side
      // by the ratio this one has moved by, measured from where the drag began.
      from = { at: axis === 'x' ? event.clientX : event.clientY, box: this.drawnBox() }
      grip.setPointerCapture(event.pointerId)
      grip.classList.add('is-dragging')
    }
    const onMove = (event: PointerEvent): void => {
      if (from === null) return
      const now = axis === 'x' ? event.clientX : event.clientY
      this.resizeAlong(axis, along(from.box) + (now - from.at) * away * gain, from.box, event.shiftKey)
    }
    const onUp = (event: PointerEvent): void => {
      if (from === null) return
      from = null
      grip.releasePointerCapture(event.pointerId)
      grip.classList.remove('is-dragging')
    }
    const onKey = (event: KeyboardEvent): void => {
      const box = this.drawnBox()
      const size = along(box)
      // A tenth of the box per press, a half with Shift — the step the map's own
      // arrow keys pan by, so one hand learns one rule. One side at a time: Shift
      // is the size of the step here, as it is for the pan, and not the shape.
      const step = Math.max(1, Math.round(size * (event.shiftKey ? 0.5 : 0.1)))
      const grow = axis === 'x' ? 'ArrowRight' : 'ArrowUp'
      const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowDown'
      if (event.key === grow) this.resizeAlong(axis, size + step, box, false)
      else if (event.key === shrink) this.resizeAlong(axis, size - step, box, false)
      else if (event.key === 'Home' || event.key === '0') this.resetAlong(axis)
      else return
      event.preventDefault()
    }

    grip.addEventListener('pointerdown', onDown)
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
    grip.addEventListener('keydown', onKey)
    // A double-click puts the default back on this side, which is the way out of
    // an edge dragged somewhere useless.
    grip.addEventListener('dblclick', () => this.resetAlong(axis))
  }

  /** The box on screen, whichever presentation it is, in CSS pixels. */
  private drawnBox(): { width: number; height: number } {
    return this.turned === null ? this.mapBox() : this.turnBox()
  }

  /**
   * One side of the box to `size`, for a drag or a key that began on `from`.
   *
   * On a square map with `keepShape` — Shift held through the drag — the other
   * side goes with it by the same ratio, and the ratio is held to what both
   * sides' room allows, so the box stops growing as a whole when either side
   * reaches its wall rather than turning into another shape against it.
   */
  private resizeAlong(
    axis: 'x' | 'y',
    size: number,
    from: { width: number; height: number },
    keepShape: boolean,
  ): void {
    if (this.turned !== null) {
      this.setTurnBox(axis === 'x' ? { width: size } : { height: size })
      return
    }
    if (!keepShape) {
      this.setMapBox(axis === 'x' ? { width: size } : { height: size })
      return
    }
    const room = this.turnRoom()
    const most = Math.min(room.width / from.width, room.height / from.height)
    const least = Math.max(MIN_MAP_SIZE / from.width, MIN_MAP_SIZE / from.height)
    const ratio = Math.max(least, Math.min(most, size / (axis === 'x' ? from.width : from.height)))
    this.setMapBox({ width: from.width * ratio, height: from.height * ratio })
  }

  /** One side of the box back to its default: the square's side, or the band's own rule. */
  private resetAlong(axis: 'x' | 'y'): void {
    if (this.turned === null) setMapSize(axis === 'x' ? { width: null } : { height: null })
    else if (axis === 'x') this.setTurnBox({ width: null })
    else this.setTurnBox({ height: null })
  }

  /**
   * The box a turned map is drawn in, in CSS pixels.
   *
   * The reader's, where they have said (`ui/turnBox.ts`), and otherwise a
   * default expressed against the width — a third of it, which is the shape of
   * the figures this is a viewer for. A rule and not a number, which is why what
   * the store holds on an untouched axis is `null`: "as wide as there is room
   * for" cannot be written down as a width, since the room changes with the
   * window and the number would not.
   *
   * Clamped on the way **out** rather than only where the reader drags. What is
   * stored is one box for the session and the panels drawing from it need not
   * have the same room — a deck of four is four narrower panels — so a box the
   * reader shaped beside one map has to be readable as "and as much of that as
   * fits" beside the next. Which is also what makes the size survive a window
   * resize: it is remembered whole and drawn to fit.
   */
  turnBox(): { width: number; height: number } {
    return fitTurnBox(getTurnBox(), this.turnRoom())
  }

  /**
   * How much room there is to draw the box in, in CSS pixels.
   *
   * Measured against the **panel**, and never against the grid the box is in.
   * The grid is sized by its contents, so a box narrowed by a drag narrows the
   * grid with it — and a ceiling read from there is a ceiling that follows the
   * box down. That is what made the ends of the band a one-way control: every
   * drag inwards lowered the limit to wherever the edge had just got to, so the
   * width could be given away and never taken back.
   *
   * Both numbers are the room a *map* has, which is not the room the panel has:
   * a stack of tracks beside or under the picture is drawn out of the same
   * budget, and a box sized to the whole of it would push its own tracks off the
   * edge. What is left after them is the difference between the grid and the
   * map's own box, which is a fact about the tracks and does not move when the
   * box does.
   *
   * The height is the one a square map would have claimed — `--map-budget`, read
   * back off the grid's `min-height`, which §17.2 already reserves so that
   * turning the map does not resize the panel. Growing past it would push the
   * page down, and the panel would grow again on the next drag: a ceiling that
   * rises as you press on it is not a ceiling.
   */
  private turnRoom(): { width: number; height: number } {
    return this.room ?? this.measureRoom()
  }

  /**
   * Measure it, and keep the answer.
   *
   * Cached because {@link turnBox} is read on every frame — the depth the band
   * is cut to is a function of the box and the zoom — and this is four layout
   * reads and a `getComputedStyle`, which is a synchronous relayout of the
   * document per frame of every pan. Refreshed where the room can actually have
   * changed, which is a resize of the panel, and it is the resize observer that
   * says so.
   */
  measureRoom(): { width: number; height: number } {
    const body = this.grid.parentElement
    // The stacks themselves, rather than whatever is left of the grid once the
    // map is taken out of it: the grid is held open at the height a square map
    // would have claimed, so "the grid less the map" is mostly *slack*, and a
    // ceiling computed from it would shrink by exactly as much as the box grew.
    // Nothing to subtract on the vertical, where `--map-budget` has already
    // taken the stacks out of the window for itself — subtracting them again is
    // how a map with ten tracks under it got a ceiling below its own floor, and
    // every drag of the top edge collapsed the band to the minimum.
    const beside =
      this.lanes.canvasFor('left').clientWidth + this.lanes.canvasFor('right').clientWidth
    const width = (body?.clientWidth ?? this.host.hostSize().width) - beside
    // The wrap's `max-height` rather than the custom property it is written
    // from: a custom property comes back as the `clamp()` that was written,
    // unresolved, and the number wanted here is the one the browser worked out
    // from it. It is the height a square map would have claimed, which is the
    // point past which a band has stopped being one.
    const budget = Number.parseFloat(getComputedStyle(this.wrap).maxHeight)
    const height = Number.isFinite(budget) ? budget : this.host.hostSize().height
    this.room = {
      width: Math.max(MIN_TURN_WIDTH, Math.round(width)),
      height: Math.max(MIN_TURN_HEIGHT, Math.round(height)),
    }
    return this.room
  }

  /**
   * Write the box onto the grid, and put the handles where its edges are.
   *
   * The size lives in CSS custom properties rather than in inline widths so that
   * the map, the lane stacks under it and the centring are one layout decided in
   * one place — the stacks take their width from the map's canvas, so a box that
   * narrowed only the map would leave the tracks pointing at the wrong base
   * pairs (`ui/AnnotationLanes.ts`).
   */
  private writeTurnBox(): void {
    const turned = this.turned !== null
    this.grid.classList.toggle('is-turned', turned)
    if (!turned) {
      this.grid.style.removeProperty('--turn-width')
      this.grid.style.removeProperty('--turn-height')
      // A square map's box, on the same terms: written where the stylesheet's
      // own default sits, so that the default is what an unset box falls back
      // to (`--map-width` defaults to `--map-budget` in `styles.css`). Written on
      // every refit rather than only on a drag, because "as much as there is" is
      // a rule and the room moves under it — and a side the reader has not set
      // is the square's, which moves with it.
      const box = this.mapBox()
      const width = Math.round(box.width)
      const height = Math.round(box.height)
      this.grid.style.setProperty('--map-width', `${width}px`)
      // The height only while the box is not a square. A square is left to the
      // aspect ratio, which keeps it one when something narrows it — the
      // column's `max-width`, a deck's cell — where a height written beside the
      // width would leave a narrowed square a rectangle nobody drew.
      const shaped = width !== height
      this.grid.classList.toggle('is-shaped', shaped)
      if (shaped) this.grid.style.setProperty('--map-height', `${height}px`)
      else this.grid.style.removeProperty('--map-height')
      return
    }
    this.grid.classList.remove('is-shaped')
    this.grid.style.removeProperty('--map-width')
    this.grid.style.removeProperty('--map-height')
    const box = this.turnBox()
    this.grid.style.setProperty('--turn-width', `${Math.round(box.width)}px`)
    this.grid.style.setProperty('--turn-height', `${Math.round(box.height)}px`)
  }

  /**
   * The box a square map is drawn in, in CSS pixels.
   *
   * {@link turnBox}'s counterpart, and clamped on the way out for the same
   * reasons: what is stored is two numbers for the session, the panels drawing
   * from them need not have the same room, and "as much as there is" is a rule
   * that has to be re-read whenever the room changes rather than a width
   * remembered from another window. An axis nobody has set is the side of the
   * square the map opens as (`ui/mapSize.ts`).
   */
  private mapBox(): { width: number; height: number } {
    return fitMapSize(getMapSize(), this.turnRoom())
  }

  /**
   * The square the map opens as, back in place of whatever the reader shaped —
   * what *Fit the view* does to a square map's box (§7.2). The store tells every
   * panel, so the one the button is on and the others of a deck all redraw.
   */
  square(): void {
    resetMapSize()
  }

  /**
   * Resize a square map's box, in CSS pixels; `null` on an axis puts the
   * square's side back on it.
   *
   * {@link setTurnBox}'s counterpart, clamped on the way **in** for the same
   * reason: the hand is in this panel, so what this panel can draw is what the
   * hand was shown — a drag that ran on past the wall stores the wall, and comes
   * back as what the reader saw when they let go rather than growing when the
   * window does.
   */
  private setMapBox(next: Partial<MapSize>): void {
    const room = this.turnRoom()
    const fit = (value: number, high: number): number =>
      Math.max(MIN_MAP_SIZE, Math.min(high, Math.round(value)))
    const asked: Partial<MapSize> = {}
    if (next.width !== undefined) asked.width = next.width === null ? null : fit(next.width, room.width)
    if (next.height !== undefined) asked.height = next.height === null ? null : fit(next.height, room.height)
    setMapSize(asked)
  }

  /**
   * Resize the box, in CSS pixels. `null` on either axis puts the default back.
   *
   * Written to the store rather than to a field here, so it outlives this panel:
   * a change of resolution or of chromosome destroys the panel and builds
   * another, and a box held on the instance is one the reader loses the first
   * time they go and look at something in it (`ui/turnBox.ts`).
   *
   * Clamped against the panel rather than against the block — the box is a fact
   * about the figure, so what bounds it is how much room there is to draw in —
   * and against *this* panel's room, which is the one the hand is in. Reading it
   * back clamps again, for the panels the hand is not in.
   */
  private setTurnBox(next: { width?: number | null; height?: number | null }): void {
    const room = this.turnRoom()
    const fit = (value: number, low: number, high: number): number =>
      Math.max(low, Math.min(high, Math.round(value)))
    const asked: Partial<TurnBox> = {}
    if (next.width !== undefined) {
      asked.width = next.width === null ? null : fit(next.width, MIN_TURN_WIDTH, room.width)
    }
    if (next.height !== undefined) {
      asked.height = next.height === null ? null : fit(next.height, MIN_TURN_HEIGHT, room.height)
    }
    rememberTurnBox(asked)
  }

  /**
   * Draw the box at whatever size it now is.
   *
   * The subscription's half of the resize, and every panel runs it — the one the
   * hand is in and the others of a deck, which is what keeps a deck of bands one
   * shape (§17.3). Both presentations arrive here: a square map has a size to be
   * drawn at too, and the panel the hand is *not* in has to follow it.
   */
  private applyTurnBox(): void {
    this.writeTurnBox()
    // The canvas has a new CSS size, and nothing else will tell the view: the
    // resize observer watches the *grid*, whose own size need not have changed.
    this.heatmap.resize()
    this.host.schedule()
  }

  /** Stop following the session's two sizes: the panel is going away. */
  destroy(): void {
    this.unsubscribeTurnBox()
    this.unsubscribeMapSize()
  }
}

/** One edge of the picture; see {@link MapBox.grips}. */
type PlotEdge = 'top' | 'bottom' | 'left' | 'right'

/** Whether an edge is dragged along x or along y. */
function edgeAxis(edge: PlotEdge): 'x' | 'y' {
  return edge === 'left' || edge === 'right' ? 'x' : 'y'
}

/** One end of the turned band's box, as a bar a hand can take hold of. */
function plotGrip(edge: PlotEdge): HTMLElement {
  const axis = edgeAxis(edge)
  return el('div', {
    class: `plot-grip plot-grip-${axis} plot-grip-${edge} hidden`,
    attrs: {
      role: 'separator',
      // Which way the *separator* lies, which is across the axis it travels on.
      'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
      tabindex: '0',
    },
  })
}
