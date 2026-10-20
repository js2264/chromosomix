/**
 * What a hand does to the lane stacks beside a map, and to the rectangles
 * inside it that a lane or a file is dropped on (§8.1, §16.9).
 *
 * Several gestures share each stack and are told apart by where the press
 * lands: the handle moves a track — along its stack, onto another edge of this
 * map, or off it to another map of the deck — the far border resizes it, and
 * the body pans and zooms the map along the axis the two share or, dragged
 * across the lane, moves its ceiling. A held Shift names a stretch, a click
 * opens what is under it, and a right click opens the lane's menu. The
 * rectangles are where a row of the Tracks card, a file from the desktop or a
 * lane carried from another map lands: on one edge, or on the map's face.
 *
 * Its own class rather than a run of methods on `ui/MatrixPanel.ts`, because
 * those gestures carry state of their own — the drag in progress, the border
 * and handle lit under the pointer, the hairline, a ceiling being dragged, the
 * rectangles, a lane being carried — that the panel reads only to draw the
 * lanes' frame. The panel lends it the lanes, the store, the renderer and the
 * readout, and keeps what the gestures report to: the lanes' geometry, the
 * locus a band names, and the frame they ask for.
 */

import type { AnnotationStore } from '../annotations/store'
import { LANE_EDGES, hasAMovableAxis, placementOn, type AnnotationEntry, type AnnotationKind, type FeatureSet } from '../annotations/types'
import type { MapId } from '../annotations/placement'
import { CROSSHAIR_COLOR, type HeatmapView } from '../render/heatmap'
import { laneIsHorizontal } from '../render/lane'
import type { OverlayAxes, OverlayFrame } from '../render/overlays'
import { MARK_REACH } from '../render/overlays'
import { placeRays, type RotatedBlock } from '../render/rotate'
import { ceilingFactor, nudgedLimits } from '../render/tracks'
import type { AnnotationLanes, LaneEdge, LaneGeometry } from './AnnotationLanes'
import { filesFrom } from './chooseFiles'
import { TRACK_DRAG_TYPE, dragHasFiles, dragHasOverlay, dragHasTrack, dropEffectFor, el } from './dom'
import { FIGURE_BACKGROUND } from './canvasPalette'
import { copyPicture } from './export'
import { openFeatureDialog } from './FeatureDialog'
import { dragHasFileRow } from './fileDrag'
import { HOVER_SOURCE_MAP, setHoverPlace } from './hoverLocus'
import {
  endCarry,
  landingAt,
  startCarry,
  within,
  type LaneCarry,
  type LaneLanding,
  type LaneSurface,
} from './laneCarry'
import { CEILING_MODIFIER, CEILING_STEP, DRAG_SLACK } from './LaneControls'
import type { LaneEditor } from './LaneEditor'
import { EDGE_WORDS, laneMenuFeature, openLaneMenu } from './laneMenu'
import { copyStretch } from './sequenceCopy'
import type { MapReadout } from './MapReadout'
import { isArmed } from './mapPick'
import { marksMenu } from './marksMenu'
import type { MatrixPanel, MatrixPanelOptions } from './MatrixPanel'
import type { Modal } from './Modal'
import { getPlotOptions } from './plotOptions'
import { revealTrack } from './revealTrack'
import { laneSize } from './trackControls'

/**
 * What the gestures need of the panel: the views and the store they act on,
 * the elements built after them, and the panel's say on what a pointer means.
 */
export interface LaneGesturesHost {
  /** The lane stacks, which say what is under a point and draw what a gesture changes. */
  readonly lanes: AnnotationLanes
  /** The store the lanes are drawn from, which every move and resize writes to. */
  readonly store: AnnotationStore
  /** Which map of the deck this panel is, for the lanes a gesture moves. */
  readonly mapId: MapId
  /** The renderer, which a lane pans and zooms and on which a band is previewed. */
  readonly heatmap: HeatmapView
  /**
   * The panel's options, held by reference: the annotations a drop is loaded
   * through, and the marks a lane's menu lists.
   */
  readonly options: MatrixPanelOptions
  /** The card beside the pointer, which a lane writes its readout on. */
  readonly readout: MapReadout
  /** The grid holding the map and its lanes, built after the rectangles are. */
  grid(): HTMLElement
  /** The caret over a lane's limit or name, built after the grid is. */
  editor(): LaneEditor | null
  /** Whether a picking mode owns the pointer ({@link MatrixPanel.armPicking}). */
  isPicking(): boolean
  /** The lanes' view of the frame on screen, which reads this one's state. */
  laneGeometry(): LaneGeometry
  /** The turned band on screen, or `null` for a square map. */
  turned(): RotatedBlock | null
  /** The two axes as annotations see them, for a hover reported as a place. */
  locusAxes(): OverlayAxes
  /** Ask the panel for a frame. */
  schedule(): void
  /** A band of one axis was named: onto the clipboard, or into a form that asked. */
  bandDragged(which: 'rows' | 'cols', span: [number, number]): void
}

/**
 * The gestures on one map's lane stacks, and the rectangles inside the map.
 *
 * `laneHover`, `laneBorder`, `laneHandle` and `laneScaling` are public for one
 * reader, the panel's lane geometry, which draws them: only this class writes
 * them.
 */
export class LaneGestures {
  /**
   * Where the pointer is over a lane stack, in that stack's canvas pixels.
   *
   * The hairline this drives runs across the lanes *and* the map, which is why
   * it is held here rather than inside {@link lanes}: the map's half is painted
   * through the overlay hook, and both halves have to come from one number or
   * they would meet at a kink.
   */
  laneHover: { edge: LaneEdge; along: number } | null = null
  /**
   * The lane whose far border the pointer is on, so the rule can be drawn.
   *
   * Drawn rather than shown as a cursor, which is the rule this canvas already
   * follows: the pointer is the arrowhead everywhere here, so an affordance that
   * lived in the cursor would not exist. Same accent rule the 1D browser marks
   * its own lane borders with, because it is the same gesture on the same kind
   * of edge.
   */
  laneBorder: string | null = null
  /**
   * The lane the pointer is on, which is the one that shows its handle.
   *
   * The whole lane and not the handle's own few pixels: a control nobody can see
   * until they are already on it is one nobody finds. It appears the moment the
   * pointer crosses the track it belongs to, which is also the moment the reader
   * could plausibly want to move that track.
   */
  laneHandle: string | null = null
  /**
   * Set while a lane is being dragged by its handle.
   *
   * The tooltip reads from `mousemove`, which keeps arriving through a pointer
   * drag: without this, moving a track out to a rectangle carried a readout of
   * the position it started from across the map with it, naming a value on a
   * lane the reader had stopped looking at.
   */
  private laneGripping = false
  /**
   * The two edge rectangles, by the edge they stand for.
   *
   * Kept because two gestures aim at them and only one of them is a DOM event
   * on the zone itself: a file drop is, and a lane dragged off its own stack is
   * not — that drag holds the pointer captured on a canvas, so the zone under
   * the pointer has to be found by arithmetic. Empty when the panel has no
   * annotations and therefore no lanes.
   */
  private readonly edgeZones = new Map<LaneEdge, HTMLElement>()
  /** The rectangle in the middle of the map, *on this map*; see {@link faceZone}. */
  private faceDrop: HTMLElement | null = null
  /**
   * This map's edge rectangles as places a lane carried from **another** map
   * can land (§16.9, `ui/laneCarry.ts`). A lane of this map's own is answered
   * by its own drag, which knows the edge it came from and puts it out.
   */
  readonly laneSurface: LaneSurface = {
    landingAt: (x, y, carry) => {
      if (carry.from === this.mapId) return null
      for (const [edge, zone] of this.edgeZones) {
        if (!within(zone, x, y)) continue
        return {
          light: (on) => zone.classList.toggle('over', on),
          take: (moved) => this.takeLane(moved, edge),
        }
      }
      return null
    },
    // Every map shows its rectangles while a lane from another is in the air,
    // as the map it came from shows its own: a place that only appears once
    // the hand is on it is a place nobody finds.
    carrying: (carry) => {
      if (carry !== null && carry.from === this.mapId) return
      this.grid.classList.toggle('is-dropping', carry !== null)
      // A lane is carried to an *edge*; the face is where an overlay lands.
      this.faceDrop?.classList.toggle('away', carry !== null)
      if (carry === null) for (const zone of this.edgeZones.values()) zone.classList.remove('over')
    },
  }
  /**
   * The lane whose ceiling is being dragged, and how far it has moved.
   *
   * Held here rather than written to the store on every frame, and that is what
   * makes the gesture readable: the store is what the *faded* copy is drawn
   * from, so it has to stand still while the hand moves. One write, on release.
   */
  laneScaling: { id: string; factor: number } | null = null
  /**
   * Who to tell which place the pointer names on a track, as set through
   * {@link MatrixPanel.setLaneHoverListener}.
   */
  laneHoverListener:
    | ((at: { axis: 'rows' | 'cols'; unit: number } | null) => void)
    | null = null
  /** The open feature card, so a second click replaces it rather than stacking. */
  private featureDialog: Modal | null = null
  /** Teardowns for every listener these gestures put on a canvas or on the window. */
  private readonly laneListeners: Array<() => void> = []
  private readonly lanes: AnnotationLanes
  private readonly laneStore: AnnotationStore
  private readonly mapId: MapId
  private readonly heatmap: HeatmapView
  private readonly options: MatrixPanelOptions
  private readonly readout: MapReadout

  constructor(private readonly host: LaneGesturesHost) {
    this.lanes = host.lanes
    this.laneStore = host.store
    this.mapId = host.mapId
    this.heatmap = host.heatmap
    this.options = host.options
    this.readout = host.readout
  }

  /** The grid the rectangles light up in, as the panel built it. */
  private get grid(): HTMLElement {
    return this.host.grid()
  }

  /** The caret over a lane's limit or name, where there is one. */
  private get laneEditor(): LaneEditor | null {
    return this.host.editor()
  }

  /** The turned band on screen, as the panel holds it now. */
  private get turned(): RotatedBlock | null {
    return this.host.turned()
  }

  /** The two axes as annotations see them, as the panel holds them now. */
  private get locusAxes(): OverlayAxes {
    return this.host.locusAxes()
  }

  /**
   * One of the two rectangles inside the map that a track lands on.
   *
   * Three gestures aim at them: a file dropped from the desktop, a row dragged
   * out of the Tracks card, and a lane dragged by the handle on its own picture.
   * All three mean the same thing — *this track, on that edge* — so they are one
   * target rather than three.
   *
   * Invisible and inert until a drag is under way, which is the whole trick: the
   * map's own gestures — pan, the Option-drag selection, the click that opens a
   * cell — happen in the same pixels, and a target that was always live would eat
   * all three along the bottom edge.
   */
  edgeZone(edge: LaneEdge): HTMLElement {
    const zone = el(
      'div',
      { class: `lane-drop lane-drop-${edge}` },
      el('span', { class: 'lane-drop-label', text: EDGE_WORDS[edge] }),
    )
    this.edgeZones.set(edge, zone)
    zone.addEventListener('dragover', (event) => {
      if (!this.acceptsDrag(event)) return
      // Both, and in this order: the default action for a dropped file is to
      // navigate the window to it, and the panel above is not the one that
      // decides where this file goes.
      event.preventDefault()
      event.stopPropagation()
      // A row dragged out of the Tracks card is being *moved*, and saying so is
      // what stops the pointer showing a copy cursor over the target.
      if (event.dataTransfer !== null && dragHasTrack(event)) {
        event.dataTransfer.dropEffect = 'move'
      }
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      zone.classList.remove('over')
      this.endDropping()

      // A track already loaded, dragged here by its grip to change which edge it
      // is drawn on. A move rather than a copy: the other edge is cleared, which
      // is what dragging a thing from one place to another means. `location` in
      // the row's settings is the same field, for the reader who wants both.
      const moved = event.dataTransfer?.getData(TRACK_DRAG_TYPE) ?? ''
      if (moved !== '') {
        event.preventDefault()
        const entry = this.laneStore.byId(moved)
        // An overlay has no edge: dropped on one, it is on this map, as it
        // would be dropped on the face.
        if (entry?.card === 'overlay') this.placeHere(moved)
        // This panel's own map, as the grip drag is: a track carried onto the
        // third replicate's edge belongs on the third replicate.
        else if (entry !== undefined) this.laneStore.placeAt(moved, this.mapId, placementOn(edge))
        return
      }
      this.dropFiles(event, edge)
    })
    return zone
  }

  /**
   * The rectangle in the middle of the map: *on this map* (§8.1).
   *
   * The four at the edges say which stack a track is drawn in; this says which
   * map, and it is the one target an overlay has — a loop set is drawn on the
   * face of the map and along no edge of it. A file dropped here opens onto this
   * map alone, an overlay on its face and a track on its usual edge; a row of
   * the Tracks card is drawn on this map **as well** as wherever it already
   * was, as the location field's marks put it. Before it the middle of a
   * companion was no target at all, and a file dropped there went where a drop
   * anywhere else goes: onto the first map.
   *
   * Kept down while a lane is carried by its grip (`.away`): that gesture is
   * about an edge.
   */
  faceZone(): HTMLElement {
    const zone = el(
      'div',
      { class: 'lane-drop lane-drop-face' },
      el('span', { class: 'lane-drop-label', text: 'on this map' }),
    )
    this.faceDrop = zone
    zone.addEventListener('dragover', (event) => {
      if (!this.acceptsDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      // *Placed*, a copy: the row stays on every map it was on (§16.9).
      if (event.dataTransfer !== null && dragHasTrack(event)) {
        event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer, 'copy')
      }
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      zone.classList.remove('over')
      this.endDropping()
      const moved = event.dataTransfer?.getData(TRACK_DRAG_TYPE) ?? ''
      if (moved !== '') {
        event.preventDefault()
        this.placeHere(moved)
        return
      }
      this.dropFiles(event, null)
    })
    return zone
  }

  /**
   * A row of the Tracks card, put on this map — an overlay on its face, a track
   * on its usual edge — and left on every other map it is drawn on.
   *
   * Nothing where it is here already: the face says *this map*, not *move it*,
   * and a track already on one of this map's edges is on this map.
   */
  private placeHere(id: string): void {
    const entry = this.laneStore.byId(id)
    if (entry === undefined || this.laneStore.laneFor(id, this.mapId) !== undefined) return
    if (entry.card === 'overlay') {
      this.laneStore.placeOn(id, this.mapId, entry.placement)
      return
    }
    const usual = LANE_EDGES.some((edge) => entry.placement[edge])
      ? entry.placement
      : placementOn('bottom')
    this.laneStore.placeAt(id, this.mapId, usual)
  }

  /**
   * Files, or a row of the Files panel, dropped on one of this map's rectangles:
   * an edge, or the face for `null`.
   */
  private dropFiles(event: DragEvent, edge: LaneEdge | null): void {
    const load = this.options.annotations?.loadOnEdge
    // A row out of the Files panel: the same aim, at a file whose bytes have
    // not been fetched yet. Resolved by the session, because resolving it here
    // would mean this panel knowing how a folder is read.
    if (dragHasFileRow(event)) {
      const pick = this.options.annotations?.pickOnEdge
      if (pick === undefined) return
      event.preventDefault()
      pick(event, edge)
      return
    }
    const files = filesFrom(event.dataTransfer)
    // Untouched where this file cannot carry tracks at all (§8.5). The shell
    // stands aside for a `.lane-drop` target, so claiming a drop we cannot
    // answer would swallow it — and a `.cool` dropped on a metacool's map is
    // still a file the session knows how to open.
    if (files.length === 0 || load === undefined) return
    event.preventDefault()
    // Not stopped: the shell's content-wide handler has to see this drop to
    // put its own highlight away, and it stands aside for a `.lane-drop`
    // target exactly as it does for the picker's zone — so the files are
    // loaded once, here, where the reader aimed them.
    load(files, edge)
  }

  /** Put the rectangles away at the end of a drag, whatever it carried. */
  private endDropping(): void {
    this.grid.classList.remove('is-dropping', 'is-overlay-drag')
  }

  /**
   * Whether one of the rectangles will answer for this drag.
   *
   * A lane being moved always: that gesture is about which edge a lane is drawn
   * on, and every file has lanes. A *file* only where one can be loaded — the
   * rectangles are inside the map and the shell hands a drop on them to this
   * panel, so lighting them up for a drag we would ignore is a target that eats
   * the file.
   */
  private acceptsDrag(event: DragEvent): boolean {
    if (dragHasTrack(event)) return true
    if (dragHasFileRow(event)) return this.options.annotations?.pickOnEdge !== undefined
    return dragHasFiles(event) && this.options.annotations?.loadOnEdge !== undefined
  }

  /**
   * Show the two zones while a file is being dragged over the map, and only
   * then.
   *
   * On the grid rather than on the zones themselves, because a zone that is
   * invisible cannot be dragged *onto* — the reader has to see it appear while
   * the pointer is still over the middle of the map, which is where a drag from
   * the desktop arrives.
   *
   * The grid and not the panel's `el`, for two reasons, and the first one is
   * not a matter of taste: this runs from the panel's constructor, where `el`
   * has not been built yet, and reading it there threw — which took the whole
   * panel down for every file that *has* annotations, so a cooler rendered
   * nothing and a metacool, which has none (§8.5), was fine. The grid is also
   * the honest scope: it is the box holding the map, its lanes and these zones,
   * while `el` reaches the colourbar and the header, where a drag means nothing.
   */
  watchEdgeDrops(): void {
    const show = (event: DragEvent): void => {
      if (!this.acceptsDrag(event)) return
      this.grid.classList.add('is-dropping')
      // An overlay row has one target on a map, its face; the edges are down
      // for it (see the stylesheet).
      this.grid.classList.toggle('is-overlay-drag', dragHasOverlay(event))
    }
    const hide = (event: DragEvent): void => {
      // A drag crossing from the map onto a zone leaves the grid by the letter
      // of the event and not in fact; the related target is what tells the two
      // apart, and `null` (leaving the window) is a real departure.
      const to = event.relatedTarget
      if (to instanceof Node && this.grid.contains(to)) return
      this.endDropping()
    }
    this.grid.addEventListener('dragenter', show)
    this.grid.addEventListener('dragover', show)
    this.grid.addEventListener('dragleave', hide)
    this.grid.addEventListener('drop', () => this.endDropping())
    // A row dragged out of the Tracks card and then abandoned — Escape, or a
    // release over nothing — ends with `dragend` on the row and no event of any
    // kind here, so without this the two rectangles would stay up until the next
    // drag. On the window because the row is not in this panel's tree.
    const done = (): void => this.endDropping()
    window.addEventListener('dragend', done)
    this.laneListeners.push(() => window.removeEventListener('dragend', done))
  }

  /**
   * Open the card for one feature, replacing any card already open.
   *
   * Held in a field rather than fired and forgotten because this panel is torn
   * down under it on every navigation — a click on a contig name is a new view —
   * and a card left behind would be describing a gene from a picture that is no
   * longer on screen.
   */
  private openFeature(hit: {
    set: FeatureSet
    index: number
    source: string
    kind?: AnnotationKind
  }): void {
    this.featureDialog?.close()
    this.featureDialog = openFeatureDialog({
      ...hit,
      onClose: () => {
        this.featureDialog = null
      },
    })
  }

  /**
   * The end of a scaling drag: one store write for the whole gesture.
   *
   * From the range that was resolved when the drag began, which is the one the
   * faded copy has been standing at all along — so the axis a reader let go on
   * is the axis they get. Every track in the lane, because they share it.
   */
  private commitLaneScaling(edge: LaneEdge, members: readonly AnnotationEntry[]): void {
    const held = this.laneScaling
    this.laneScaling = null
    this.host.schedule()
    if (held === null || held.factor === 1) return
    const extent = this.lanes.extentOf(edge, held.id)
    for (const member of members) {
      if (!hasAMovableAxis(member.kind)) continue
      const next = nudgedLimits(member.style.limits, extent, held.factor)
      if (next !== null) this.laneStore.restyle(member.id, { limits: next })
    }
  }

  /**
   * The lane hairline, continued across the map.
   *
   * One line, not a crosshair. A pointer on the bottom stack is naming a
   * *column* and has said nothing about which row, so a horizontal line through
   * it would be an answer to a question nobody asked — and two lines crossing at
   * an arbitrary point read as a cell being pointed at, which is exactly what is
   * not happening.
   *
   * Turned, that one line becomes a **V** standing on the axis under the
   * pointer, and it is the same statement rather than a second one: the reader
   * is naming one place on the genome, and the contacts that place is in are not
   * a column of a turned picture but the two 45° rays leaving it
   * (`render/rotate.ts`). A vertical line there would cross the band through
   * contacts between two *other* places, none of which is the one being pointed
   * at except where the V's own apex is.
   *
   * The coordinate needs no conversion: the lane canvases share the map
   * canvas's grid cell on the axis they run along, so a pixel `x` on the bottom
   * stack is the same `x` here. Clipped to the data rather than the plot, so it
   * stops where the matrix does instead of running out over empty margin.
   */
  paintLaneGuide(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const guide = this.laneHover
    // Under the crosshair preference, as the lane's own hairline is: the two
    // are one line, the hand's place on a track carried across the map, and a
    // reader who turned the crosshair off should not find half of it still on.
    if (guide === null || !getPlotOptions().crosshair) return
    const { data, dpr } = frame
    const at = (Math.round(guide.along * dpr - 0.5) + 0.5) / dpr
    if (guide.edge === 'bottom') {
      if (at < data.x || at > data.x + data.width) return
    } else if (at < data.y || at > data.y + data.height) return

    ctx.save()
    ctx.beginPath()
    ctx.rect(data.x, data.y, data.width, data.height)
    ctx.clip()
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = Math.max(1 / dpr, 0.75)
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    const turned = this.turned
    if (turned !== null && laneIsHorizontal(guide.edge)) {
      // The V on the diagonal under the pointer, one per band of a mirrored
      // pair: the place being pointed at is on the genome rather than in a file,
      // and it anchors contacts in both maps (`placeRays`). The same V a line
      // the reader drew there becomes (`drawManualLines`).
      const col = frame.colScale.toUnit(guide.along - frame.plot.x)
      for (const ray of placeRays(turned, col)) {
        ctx.moveTo(
          frame.plot.x + frame.colScale.toPixel(ray.from.col),
          frame.plot.y + frame.rowScale.toPixel(ray.from.row),
        )
        ctx.lineTo(
          frame.plot.x + frame.colScale.toPixel(ray.to.col),
          frame.plot.y + frame.rowScale.toPixel(ray.to.row),
        )
      }
    } else if (laneIsHorizontal(guide.edge)) {
      ctx.moveTo(at, data.y)
      ctx.lineTo(at, data.y + data.height)
    } else {
      ctx.moveTo(data.x, at)
      ctx.lineTo(data.x + data.width, at)
    }
    ctx.stroke()
    ctx.restore()
  }

  /**
   * The same gesture, made on a lane stack rather than on the map.
   *
   * One conversion for both surfaces ({@link HeatmapView.bandAt}), because §8.4
   * glues their pixels together along the shared axis and two conversions would
   * be two chances to disagree about which stretch was named. Which axis is not
   * read from the hand here — the stack decides it, since a lane along the
   * columns can only ever name columns.
   */
  private bandOnLane(edge: LaneEdge, from: number, to: number): void {
    const axis = laneIsHorizontal(edge) ? 'cols' : 'rows'
    // Before the report, which disarms.
    const zooming = !isArmed()
    const span = this.heatmap.bandAt(axis, from, to)
    if (span !== null) this.host.bandDragged(axis, span)
    if (zooming) this.heatmap.zoomToBand(axis, from, to)
  }

  /**
   * Follow the pointer over one lane stack.
   *
   * The lanes get their own listeners rather than sharing the heatmap's, because
   * they are separate canvases and a pointer over one is not over the other.
   * What they share is the tooltip, which is why the coordinates are converted
   * to the grid's — the tooltip is parented there and knows nothing about which
   * canvas asked for it.
   */
  watchLane(edge: LaneEdge, canvas: HTMLCanvasElement, labels?: HTMLCanvasElement): void {
    const lanes = this.lanes
    const onMove = (event: MouseEvent): void => {
      // A track being carried to an edge is not a position being pointed at.
      if (this.laneGripping) {
        this.readout.hide()
        return
      }
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top

      // The hairline first, and through a repaint rather than a second canvas:
      // it crosses the lane stack and the map, and both are redrawn from this
      // one number on the next frame.
      const along = laneIsHorizontal(edge) ? x : y
      const before = this.laneHover
      if (before === null || before.edge !== edge || before.along !== along) {
        this.laneHover = { edge, along }
        this.host.schedule()
        this.reportLaneHover()
      }

      this.readout.lane(lanes.readout(edge, x, y, this.host.laneGeometry()), canvas, x, y)
    }
    const onLeave = (): void => {
      this.readout.hide()
      canvas.classList.remove('is-grab')
      canvas.classList.remove('is-resize-across')
      canvas.classList.remove('is-resize-along')
      if (this.laneBorder !== null || this.laneHandle !== null) {
        this.laneBorder = null
        this.laneHandle = null
        this.host.schedule()
      }
      if (this.laneHover !== null) {
        this.laneHover = null
        this.host.schedule()
        // The move off the edge is what takes the other panels' marks away with
        // the pointer, exactly as {@link MatrixPanel.describe} reports the move off
        // the map.
        this.reportLaneHover()
      }
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    this.laneListeners.push(() => {
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
    })
    this.driveFromLane(edge, canvas)
    this.dragLane(edge, canvas, labels)
  }

  /**
   * Let a lane stack pan and zoom the map.
   *
   * A lane is a picture of the same window the map shows, drawn through the same
   * scales — so dragging one and dragging the map are the same gesture on the
   * same data, and a track you could read but not move was an odd exception a
   * reader has to discover. Dragging a bottom lane sideways scrolls the columns;
   * dragging a right lane up and down scrolls the rows.
   *
   * Only along the shared axis. A bottom lane says nothing about rows, so a
   * vertical drag on one has no meaning to forward — and forwarding it anyway
   * would move the map in a direction the pointer never travelled over anything
   * that represents it.
   *
   * The **zoom is not** restricted that way, because the map's zoom is one
   * scalar for both axes: a wheel over a lane zooms exactly as a wheel over the
   * map does, holding the position under the pointer fixed on the shared axis
   * and the middle of the data on the other. Anchoring the other axis anywhere
   * else would be inventing a row the reader never pointed at.
   */
  private driveFromLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    /** The perpendicular anchor: the centre of the data actually on screen. */
    const middle = (): { x: number; y: number } => {
      const data = this.heatmap.dataRect
      return { x: data.x + data.width / 2, y: data.y + data.height / 2 }
    }

    const onWheel = (event: WheelEvent): void => {
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      // ⌘-scroll over a lane raises or lowers *that lane's* ceiling — the
      // adjustment a reader of a coverage track makes constantly, and the one
      // gesture the 1D browser had that the map's own lanes did not. Never Ctrl:
      // a trackpad pinch arrives as a wheel with `ctrlKey` set, so taking it here
      // would swallow every pinch and run away with a ceiling instead of zooming.
      const lanes = this.lanes
      const store = this.laneStore
      if (CEILING_MODIFIER(event)) {
        const hit = lanes.laneAt(edge, x, y)
        if (hit === null) return
        event.preventDefault()
        // From the range *resolved on screen*, group included, so the first notch
        // on an autoscaled track starts from the axis the reader is looking at
        // rather than from a stored `[0, 1]` nobody chose.
        const extent = lanes.extentOf(edge, hit.entry.id)
        const factor = event.deltaY < 0 ? 1 / CEILING_STEP : CEILING_STEP
        for (const member of hit.members) {
          if (!hasAMovableAxis(member.kind)) continue
          const next = nudgedLimits(member.style.limits, extent, factor)
          if (next !== null) store.restyle(member.id, { limits: next })
        }
        return
      }
      // The same two rules the map's own wheel handler follows: a sideways
      // scroll slides along the picture, and the zoom factor is exponential in
      // the delta so a trackpad's many small events and a wheel's few large ones
      // compose to the same total zoom. A stack is *on* the map's axis, so a
      // gesture over one has to mean what it means over the other — the map
      // moving under the pointer while the profile above it did not would read
      // as the two coming apart.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault()
        this.heatmap.slideSideways(event.deltaX)
        return
      }
      event.preventDefault()
      const at = middle()
      if (laneIsHorizontal(edge)) at.x = x
      else at.y = y
      this.heatmap.zoomAt(at.x, at.y, Math.exp(-event.deltaY * 0.002))
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    this.laneListeners.push(() => canvas.removeEventListener('wheel', onWheel))
  }

  /**
   * Dragging a lane: its handle moves it, its border resizes it, its body pans.
   *
   * All three already existed in the side panel — a grip, a height box — and all
   * three are being asked for *here* because here is where the tracks are being
   * looked at. A reader comparing two profiles moves them next to each other and
   * makes the interesting one taller, and having to cross the window to a list
   * to do either is the reason the card grew a handle in the first place.
   *
   * Pointer capture, and the same reason the panel columns take it: a drag that
   * leaves a 44-pixel strip — which every resize does — must not be dropped on
   * the map underneath, where it would become a pan.
   */
  private dragLane(edge: LaneEdge, canvas: HTMLCanvasElement, labels?: HTMLCanvasElement): void {
    const lanes = this.lanes
    const store = this.laneStore
    const horizontal = laneIsHorizontal(edge)
    /** Which way a pointer displacement on this canvas moves *outward*. */
    const outward = lanes.outwardOf(edge)

    /**
     * Three gestures on one surface, told apart by *where* the press lands.
     *
     * The **handle** moves the track: up and down its own stack to reorder, out
     * onto a rectangle in the map to change which edge it is drawn on — or off
     * this map altogether, onto another's rectangles, a `+` or a cell of the
     * deck (`ui/laneCarry.ts`), which moves it there. The
     * **border** resizes, because that is the only thing a border can be dragged
     * for. Everything else is a **pan**, which is what dragging a track beside a
     * map has always meant.
     *
     * The body used to reorder as well, by reading the direction of the first
     * movement — along the axis a pan, across it a reorder. It does not any
     * more, and the handle is why. Two meanings for one surface is a rule the
     * reader has to know before their first drag does what they meant, and it
     * was paid for on every pan that wandered a few pixels off the horizontal:
     * the track jumped a slot in the stack, because a gesture that has to be
     * performed *carefully* had been asked for. With a surface of its own for
     * moving, the body can go back to meaning one thing.
     */
    let drag:
      | {
          id: string
          kind: 'size' | 'pan' | 'grip' | 'press' | 'scale' | 'zoom'
          from: number
          along: number
          size: number
          /** Where the press landed, so an undecided drag can catch up. */
          from0: number
          along0: number
          /** For a scaling drag: the across-offset inside the lane it began at. */
          within: number
          /** Every track in the lane, which for an overlay group is all of them. */
          members: AnnotationEntry[]
          /** For a handle drag: the edge under the pointer, if it is on one. */
          to: LaneEdge | null
          /** The slot last dropped into, so a reorder fires once per crossing. */
          over: number
          /** For a handle drag: the lane in the hand, as other surfaces see it. */
          carry: LaneCarry | null
          /** …and the place off this map it would land on, if it is over one. */
          landing: LaneLanding | null
        }
      | null = null

    const start = (
      id: string,
      kind: 'size' | 'grip' | 'press' | 'zoom',
      event: PointerEvent,
      size: number,
      within = 0,
      members: AnnotationEntry[] = [],
    ): void => {
      const across = horizontal ? event.clientY : event.clientX
      const along = horizontal ? event.clientX : event.clientY
      drag = {
        id,
        kind,
        from: across,
        along,
        size,
        from0: across,
        along0: along,
        within,
        members,
        to: null,
        over: -1,
        carry: null,
        landing: null,
      }
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
    }

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || this.host.isPicking()) return
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      // Shift first, before any of the three targets below. The same gesture the
      // map has and the 1D browser has, offered on the strip beside them: a
      // reader who can see the peak they want to zoom to should be able to drag
      // across it where they are looking, rather than move to the map and find
      // the same stretch again. Deliberate enough — a held modifier — that it
      // can outrank a caret and a handle without ever being hit by accident.
      // …and unmodified while a form is waiting to be pointed at, for the reason
      // the map itself gives: *Pick on map* is already a mode, and asking for a
      // modifier on top of one is asking twice. `bandOnLane` reports without
      // zooming while it is armed.
      if (event.shiftKey || isArmed()) {
        start('', 'zoom', event, 0)
        return
      }
      // A limit under a track's name is a text box that happens to be painted.
      // Checked before the pointer is captured, so the press never becomes the
      // start of a pan the reader did not ask for.
      const limit = lanes.limitAt(edge, x, y)
      if (limit !== null && this.laneEditor !== null) {
        event.preventDefault()
        this.laneEditor.openLimit(limit, { left: canvas.offsetLeft, top: canvas.offsetTop }, edge)
        return
      }
      // The handle next: it sits inside the lane's own rectangle, so the lane
      // hit below would otherwise take the press and read a direction out of it.
      const handle = lanes.gripAt(edge, x, y, this.host.laneGeometry())
      if (handle !== null) {
        start(handle.entry.id, 'grip', event, handle.entry.style.size)
        canvas.classList.add('grabbing')
        this.laneGripping = true
        // In the hand, as every other map and the deck see it: they light the
        // places it can go (§16.9, `ui/laneCarry.ts`).
        const carry: LaneCarry = {
          ids: lanes.membersOf(edge, handle.entry.id).map((member) => member.id),
          from: this.mapId,
          edge,
        }
        if (drag !== null) drag.carry = carry
        startCarry(carry)
        this.readout.hide()
        // The rectangle comes up with the gesture, because it is where the
        // gesture can end: a drag whose target only appears once you are on it
        // is a drag nobody makes twice.
        //
        // Every rectangle *but this edge's own*. A track dragged out of the
        // bottom stack cannot be moved to the bottom — it is already there — so
        // offering it that target is offering a gesture with no outcome, and a
        // lit rectangle that does nothing when you let go reads as the drag
        // having failed.
        this.edgeZones.get(edge)?.classList.add('away')
        this.faceDrop?.classList.add('away')
        this.grid.classList.add('is-dropping')
        return
      }
      // …and the name last of the three, for the reason the limit is first: it
      // is text on a canvas that a reader changes. After the handle, because the
      // two touch at the near end of a lane and the handle is the smaller target
      // — a caret opening where a reorder was meant is the worse miss.
      const named = lanes.nameAt(edge, x, y)
      if (named !== null && this.laneEditor !== null) {
        event.preventDefault()
        this.laneEditor.openName(named, { left: canvas.offsetLeft, top: canvas.offsetTop }, edge)
        return
      }
      const hit = lanes.laneAt(edge, x, y)
      if (hit === null) return
      // A press in the body is not yet a gesture: which way it first travels
      // says whether it is the pan a lane has always been or a drag on that
      // lane's ceiling. The border needs no such reading — a border can be
      // dragged for exactly one thing.
      const within = lanes.withinLane(edge, hit.entry.id, x, y)
      start(
        hit.entry.id,
        hit.onBorder ? 'size' : 'press',
        event,
        hit.entry.style.size,
        within,
        hit.members.filter((member) => hasAMovableAxis(member.kind)),
      )
      if (!hit.onBorder) canvas.classList.add('grabbing')
    }

    const onMove = (event: PointerEvent): void => {
      const box = canvas.getBoundingClientRect()
      if (drag === null) {
        // Not dragging, and the cursor stays the pointer everywhere it is still
        // pointing *at* a base pair: it is the same shape over the map, over the
        // lanes and over the 1D browser, and a hand appearing on the way from
        // one to the other would say they are different surfaces, which is the
        // one thing they are not. It changes only where the thing under it is
        // not a coordinate — a handle to take hold of, a number to type into, a
        // border to drag — and each of those says which by its own shape,
        // alongside the accent rule drawn for it.
        const x = event.clientX - box.left
        const y = event.clientY - box.top
        const hit = lanes.laneAt(edge, x, y)
        canvas.style.cursor = ''
        const border = hit?.onBorder === true ? hit.entry.id : null
        // Over a limit the pointer *is* the affordance, because "this text is a
        // text box" is a claim only a caret makes. Tested before the handle, in
        // the order the press tests them: the two can come within a couple of
        // pixels of each other on a short lane, and a cursor promising one while
        // the press does the other is worse than either.
        const onRange = lanes.limitAt(edge, x, y) !== null
        // The handle is the one thing on these canvases the arrowhead cannot
        // speak for: it is not pointing at a base pair, it is something to take
        // hold of, and the open hand is what says so.
        const onHandle = !onRange && lanes.gripAt(edge, x, y, this.host.laneGeometry()) !== null
        canvas.classList.toggle('is-grab', onHandle)
        // The far border, where a drag resizes the lane. The same double arrow
        // the map's own box handles carry, on the axis this border moves on:
        // there is a rule drawn under the pointer already, and a rule with no
        // cursor to go with it is a mark the reader has to guess is a control.
        canvas.classList.toggle('is-resize-across', border !== null && horizontal)
        canvas.classList.toggle('is-resize-along', border !== null && !horizontal)
        // The name is a caret too, and last in the same order the press reads.
        const onLabel = !onRange && !onHandle && lanes.nameAt(edge, x, y) !== null
        canvas.classList.toggle('is-text', onRange || onLabel)
        const handle = hit === null ? null : hit.entry.id
        if (border !== this.laneBorder || handle !== this.laneHandle) {
          this.laneBorder = border
          this.laneHandle = handle
          this.host.schedule()
        }
        return
      }
      const now = horizontal ? event.clientY : event.clientX
      const alongNow = horizontal ? event.clientX : event.clientY

      if (drag.kind === 'zoom') {
        // Drawn on the *map*, because that is what the band is about: the stack
        // has no marquee, and one drawn only inside the lane would say the band
        // stops where the track does.
        const origin = horizontal ? box.left : box.top
        this.heatmap.showBandPreview(
          horizontal ? 'cols' : 'rows',
          drag.along0 - origin,
          alongNow - origin,
        )
        return
      }

      if (drag.kind === 'press') {
        const across = now - drag.from0
        const along = alongNow - drag.along0
        if (Math.abs(across) + Math.abs(along) < DRAG_SLACK) return
        // Across the lane rather than along it, which is the one direction a
        // drag on a track beside the map had no meaning in: a pan only ever
        // forwards the shared axis, so a perpendicular drag moved nothing at
        // all. Read once, at the slack, so a pan that wanders a few pixels off
        // its axis stays the pan it started as.
        drag.kind =
          Math.abs(across) > Math.abs(along) && drag.members.length > 0 ? 'scale' : 'pan'
        // `drag.along` is still where the press landed, so the pan below applies
        // the whole travel in this one event: the gesture catches up rather than
        // starting three pixels late, which on a canvas glued to the map is the
        // difference a reader would feel.
        if (drag.kind === 'scale') {
          this.laneScaling = { id: drag.id, factor: 1 }
          canvas.classList.remove('grabbing')
        }
      }

      if (drag.kind === 'scale') {
        const frame = lanes.frameFor(edge, drag.id, this.host.laneGeometry())
        if (frame === null) return
        this.laneScaling = {
          id: drag.id,
          factor: ceilingFactor(
            frame,
            drag.within,
            // In the lane's own across coordinates, which run outward from the
            // map — so on a stack above or to the left of it the pointer's
            // displacement is the *negative* of the travel. `ceilingFactor` asks
            // the frame which way a larger value is drawn, and it can only be
            // asked in the units it answers in.
            drag.within + outward * (now - drag.from0),
            drag.members[0]?.style.flip === true,
          ),
        }
        this.host.schedule()
        return
      }

      if (drag.kind === 'grip') {
        // Over one of the rectangles, the drag is about which edge this track is
        // drawn on and the release decides it. The rectangles are inside the
        // map, so this can never be true while the pointer is over a stack —
        // which is what makes the two halves of the gesture tell themselves
        // apart without a rule about direction.
        const over = this.edgeUnder(event.clientX, event.clientY)
        drag.to = over
        for (const [name, zone] of this.edgeZones) zone.classList.toggle('over', name === over)
        // Off this map: another map's edge, a cell of the deck, a `+` — the
        // places the others offer (§16.9). Asked only where this map's own
        // rectangles did not answer.
        const away =
          over === null && drag.carry !== null
            ? landingAt(event.clientX, event.clientY, drag.carry, this.laneSurface)
            : null
        if (away !== drag.landing) {
          drag.landing?.light(false)
          away?.light(true)
          drag.landing = away
        }
        if (over !== null || away !== null) return
        // Otherwise it is a reorder, and only while the pointer is actually
        // beside the stack: past either end there is no slot being pointed at,
        // and answering anyway would fling the track to the top of the order on
        // the way out to a rectangle.
        const x = event.clientX - box.left
        const y = event.clientY - box.top
        const across = horizontal ? y : x
        const span = horizontal ? canvas.clientHeight : canvas.clientWidth
        if (across < 0 || across > span) return
        const to = lanes.slotIndexAt(edge, x, y)
        // Once per slot *crossed*, not once per pointer move. Without it an
        // overlay group thrashes: moving its host past its own members only
        // re-elects a host, the two orders draw identically, and the move fires
        // again on every event — each one a `sessionStorage` write.
        if (to === drag.over) return
        drag.over = to
        lanes.moveToSlot(edge, drag.id, to)
        return
      }

      if (drag.kind === 'pan') {
        const delta = alongNow - drag.along
        drag.along = alongNow
        if (delta === 0) return
        // `panBy` takes a *canvas* displacement, which is what this is: the lane
        // and the map share their pixels on this axis by construction (§8.4).
        if (horizontal) this.heatmap.panBy(delta, 0)
        else this.heatmap.panBy(0, delta)
        return
      }

      // Thickness grows *away* from the map on every edge, so the delta is the
      // pointer's displacement in the outward direction — which above the map
      // and to its left is the canvas direction reversed.
      // Every track in the lane, because an overlay group shares one strip:
      // resizing the host alone would leave its members claiming a height the
      // stack no longer gives them.
      const next = laneSize(drag.size + outward * (now - drag.from))
      for (const member of lanes.membersOf(edge, drag.id)) {
        store.restyle(member.id, { size: next })
      }
    }

    const onUp = (event: PointerEvent): void => {
      if (drag === null) return
      if (drag.kind === 'zoom') {
        this.heatmap.clearBandPreview()
        const rect = canvas.getBoundingClientRect()
        const origin = horizontal ? rect.left : rect.top
        const alongNow = horizontal ? event.clientX : event.clientY
        this.bandOnLane(edge, drag.along0 - origin, alongNow - origin)
        drag = null
        canvas.style.cursor = ''
        canvas.classList.remove('grabbing')
        canvas.releasePointerCapture(event.pointerId)
        return
      }
      // A press that never became a gesture is a click, and a click on a lane
      // means one of two things depending on what is under it. On a *feature* it
      // means "what is this" — answered by the card, the same card the 1D
      // browser opens for the same gesture on the same gene. On the lane itself
      // it means "this track", the most direct way a reader has of saying so:
      // it opens that track's settings in the card that holds them, rather than
      // leaving them to match a name against a list in a column scrolled
      // somewhere else.
      if (drag.kind === 'press') {
        const box = canvas.getBoundingClientRect()
        const hit = lanes.featureAt(edge, event.clientX - box.left, event.clientY - box.top)
        // No `onGoTo` here, and that is deliberate: the 1D browser's zoom sets a
        // locus on one axis, and this view's navigation is a region on two. A
        // button that framed the gene on one of them would leave the other
        // wherever it was, which is not what "zoom to it" would promise.
        if (hit !== null) this.openFeature(hit)
        else revealTrack(drag.id)
      }
      if (drag.kind === 'scale') this.commitLaneScaling(edge, drag.members)
      // A handle let go over a rectangle draws the track on that edge instead.
      // A *move* and not a copy — the other edge is cleared — because that is
      // what dragging a thing from one place to another means; `location` in the
      // row's settings is the same field, for the reader who wants both.
      if (drag.kind === 'grip' && drag.to !== null) {
        const target = drag.to
        // Every member, because an overlay group is one lane on screen and would
        // otherwise be split across two edges by a single drag.
        for (const member of lanes.membersOf(edge, drag.id)) {
          // **On this panel's own map.** The gesture was made on one picture and
          // it is about that picture: `place` writes the *track's* default and
          // the lead's lane with it, so a drag on a companion moved the track
          // out from under the first map and left the one the hand was over
          // exactly as it was (`annotations/store.ts`'s `placeAt`). And **this
          // edge** to that one: a track also drawn on a third side keeps it.
          store.moveEdge(member.id, this.mapId, edge, target)
        }
      }
      // Let go off this map, on a place another offered: the lane goes there
      // and leaves this map (§16.9).
      if (drag.kind === 'grip' && drag.to === null && drag.landing !== null && drag.carry !== null) {
        drag.landing.light(false)
        drag.landing.take(drag.carry)
      }
      if (drag.kind === 'grip') {
        drag.landing?.light(false)
        this.grid.classList.remove('is-dropping')
        for (const zone of this.edgeZones.values()) zone.classList.remove('over', 'away')
        this.faceDrop?.classList.remove('away')
        this.laneGripping = false
        if (drag.carry !== null) endCarry()
      }
      drag = null
      canvas.style.cursor = ''
      canvas.classList.remove('grabbing')
      canvas.releasePointerCapture(event.pointerId)
    }

    const client = this.options.annotations?.client
    const onMenu = (event: MouseEvent): void => {
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      const hit = lanes.laneAt(edge, x, y)
      if (hit === null) return
      event.preventDefault()
      // The feature under the pointer, which a map can open and not frame: its
      // view is a region on two axes (see the press above).
      const found = lanes.featureAt(edge, x, y)
      const feature =
        found === null
          ? null
          : laneMenuFeature(found.set, found.index, { open: () => this.openFeature(found) })
      // The lane under the pointer, alone, as this stack draws it (§7.2).
      const copy = (): void =>
        copyPicture('track', lanes.laneImage(edge, hit.entry.id, this.host.laneGeometry(), FIGURE_BACKGROUND))
      openLaneMenu(
        event.clientX,
        event.clientY,
        hit.entry,
        store,
        edge,
        this.mapId,
        feature,
        copy,
        marksMenu(this.options.annotations?.manual, lanes.marksAt(edge, x, y, this.host.laneGeometry(), MARK_REACH)),
        // The bases the lane shows (§8.8): beside a map the lane is its GC
        // trace, which stands for them all the same.
        hit.entry.kind === 'sequence' && client !== undefined
          ? {
              stretch: lanes.stretchOn(edge, hit.entry.id, this.host.laneGeometry()),
              run: (stretch) => void copyStretch(client, hit.entry.id, stretch),
            }
          : null,
      )
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    // A cancel means the gesture was taken *away*, not that it finished. Treated
    // as a release it commits the one decision a drag holds back until then —
    // which edge the track is drawn on — so a drag the system interrupts over a
    // lit rectangle would move the track there anyway.
    const onCancel = (event: PointerEvent): void => {
      if (drag === null) return
      drag.to = null
      drag.landing?.light(false)
      drag.landing = null
      onUp(event)
    }
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('contextmenu', onMenu)
    this.laneListeners.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('contextmenu', onMenu)
    })
    if (labels !== undefined) this.watchLabels(edge, canvas, labels, onMenu)
  }

  /**
   * The corner a stack's names run out onto (§8.8), as the stack's own names:
   * a press on a name or an end of its range opens the same caret there, and a
   * right click the same lane's menu.
   *
   * Read in the **stack's** coordinates — the corner's pixels are past the
   * stack canvas's edge, so a point there is a negative or an overlong one in
   * the stack's own terms, which is what the names were measured in — and only
   * for what a name is: no pan, no handle, no zoom starts in a corner, which
   * has no genome under it.
   */
  private watchLabels(
    edge: LaneEdge,
    canvas: HTMLCanvasElement,
    labels: HTMLCanvasElement,
    onMenu: (event: MouseEvent) => void,
  ): void {
    const lanes = this.lanes
    const inStack = (event: MouseEvent): { x: number; y: number } => {
      const box = canvas.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top }
    }
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || this.host.isPicking() || this.laneEditor === null) return
      const { x, y } = inStack(event)
      const offset = { left: canvas.offsetLeft, top: canvas.offsetTop }
      const limit = lanes.limitAt(edge, x, y)
      if (limit !== null) {
        event.preventDefault()
        this.laneEditor.openLimit(limit, offset, edge)
        return
      }
      const named = lanes.nameAt(edge, x, y)
      if (named !== null) {
        event.preventDefault()
        this.laneEditor.openName(named, offset, edge)
      }
    }
    const onMove = (event: PointerEvent): void => {
      const { x, y } = inStack(event)
      labels.classList.toggle('is-text', lanes.limitAt(edge, x, y) !== null || lanes.nameAt(edge, x, y) !== null)
    }
    const onLeave = (): void => labels.classList.remove('is-text')
    labels.addEventListener('pointerdown', onDown)
    labels.addEventListener('pointermove', onMove)
    labels.addEventListener('pointerleave', onLeave)
    labels.addEventListener('contextmenu', onMenu)
    this.laneListeners.push(() => {
      labels.removeEventListener('pointerdown', onDown)
      labels.removeEventListener('pointermove', onMove)
      labels.removeEventListener('pointerleave', onLeave)
      labels.removeEventListener('contextmenu', onMenu)
    })
  }

  /**
   * A lane carried from another map, let go on this map's `edge` (§16.9): drawn
   * here on that edge, and taken off the map it came from — a move, as a drag
   * between two places is. Every track of an overlay group, which travels as
   * the one lane it is on screen.
   */
  private takeLane(carry: LaneCarry, edge: LaneEdge): void {
    for (const id of carry.ids) {
      // Off the edge it left **first**. Where that map keeps the track on
      // another side, what is left there may turn to grow away from it, and a
      // lane here that had not yet been given a turn of its own would turn
      // with it — a lane put under this map, drawn upside down.
      if (carry.from !== this.mapId) this.laneStore.unplaceEdge(id, carry.from, carry.edge)
      // Beside whatever edges it already has here: a track already under this
      // map, carried onto its left, is on both.
      const held = this.laneStore.laneFor(id, this.mapId)?.placement
      this.laneStore.placeAt(id, this.mapId, { ...(held ?? {}), [edge]: true })
    }
  }

  /**
   * Which edge rectangle a point on the page is inside, if either.
   *
   * By arithmetic rather than by `dragover`, because the gesture that asks is a
   * pointer drag with the pointer captured on a lane canvas: every event goes to
   * that canvas, whatever it is over, which is exactly what stops the map
   * underneath reading the drag as a pan.
   */
  private edgeUnder(x: number, y: number): LaneEdge | null {
    for (const [edge, zone] of this.edgeZones) {
      // A rectangle the gesture is not being offered is not a target either;
      // one place decides that, so what lights up and what lands cannot differ.
      if (zone.classList.contains('away')) continue
      const box = zone.getBoundingClientRect()
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return edge
    }
    return null
  }

  /** Hand the current lane hover to whoever is listening, in matrix units. */
  private reportLaneHover(): void {
    const guide = this.laneHover
    if (guide === null) {
      this.laneHoverListener?.(null)
      setHoverPlace(null)
      return
    }
    // The same conversion {@link paintLaneGuide} makes, and for the same reason
    // it needs none of its own: §8.4 glues the lane canvases to the map's along
    // the axis they share, so a pixel on the stack is a pixel on the plot.
    const plot = this.heatmap.plotRect
    const horizontal = laneIsHorizontal(guide.edge)
    const unit = horizontal
      ? this.heatmap.scaleX.toUnit(guide.along - plot.x)
      : this.heatmap.scaleY.toUnit(guide.along - plot.y)
    this.laneHoverListener?.({ axis: horizontal ? 'cols' : 'rows', unit })
    // One place, for a structure cell (§25): a pointer on a track names a
    // locus and not a contact, so one locus is what goes out.
    const axis = horizontal ? this.locusAxes.cols : this.locusAxes.rows
    const locus = axis?.unitToLocus(unit) ?? null
    setHoverPlace(locus === null ? null : { loci: [locus], source: HOVER_SOURCE_MAP })
  }

  /**
   * Release every listener these gestures hold, and close a feature card a
   * click on a lane opened: the panel is going away ({@link MatrixPanel.destroy}).
   */
  destroy(): void {
    this.featureDialog?.close()
    this.featureDialog = null
    for (const off of this.laneListeners) off()
    this.laneListeners.length = 0
  }
}
