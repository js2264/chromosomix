/**
 * A structure drawn through a `CanvasRenderingContext2D`, for the figure (§25).
 *
 * Every representation is paths, and paths are what the vector export is made
 * of (`ui/vector.ts`): five thousand beads are five thousand `arc`s, which is
 * squarely on the side of the line `ui/analysisPlots.ts` draws between *tens of
 * cells are paths* and *twelve thousand bins are pixels*. Beads are discs and
 * sticks are segments. The **tube** is a stretch per bead along the curve the
 * GPU draws it on, filled band by band from its shadowed rim to its highlight.
 * It used to be handed back to the
 * GPU as a raster, on the argument that a lit surface is not a path; so the
 * default representation of every model left as a picture of pixels in the one
 * file that was supposed to be a drawing (§25.7). A contact map's cells are now
 * the only raster any PDF of this application carries.
 *
 * It is **not a second renderer**. The scene, the camera, the colours and what
 * is lit are the same objects the adapter is handed, projected through the
 * same arithmetic (`structure/camera.ts`), and everything the adapter adds to
 * the model — the dashes across a gap, the ruler's ticks, the centre of
 * rotation, the depth slab and the fog — is drawn here from the same numbers,
 * so the page shows the picture the screen showed. The words written on the
 * model are one function, {@link drawStructureLabels}, which the adapter's own
 * snapshot calls too: the PNG and the PDF cannot disagree about a name. It is
 * also the one path a test can exercise without a GPU: `drawingOf` runs this
 * into a `VectorPage`, and a figure that draws nothing is caught by the
 * operator stream being empty.
 *
 * Painter's algorithm: every mark is sorted by depth and drawn far to near, so
 * a bead in front covers a bead behind. Exact for discs of one radius, and the
 * right picture for sticks and a tube at the widths a figure uses.
 *
 * **Lit, as the screen is.** A model drawn in flat colour reads as a tangle of
 * ribbons on paper beside the PNG of the same model, which reads as a solid.
 * So every surface is shaded by the screen's own key light ({@link KEY}, which
 * rides with the eye): a bead is a **radial shading** from its highlight out to
 * its shadowed rim — `createRadialGradient`, which the page writes as a PDF
 * shading, smooth at any zoom — and a tube or a stick, which no gradient can
 * follow round a curve, is a stack of strokes, each narrower, lighter and
 * nudged towards the light, fine enough that the steps are under a third of a
 * pixel. The depth cue is the screen's fog besides, done by mixing every
 * colour — each of a bead's stops — towards the paper, and beads and sticks
 * further from the eye are drawn a little smaller.
 */

import type { StructureStyle } from '../annotations/types'
import { fmt } from '../units'
import { basis, frameAxes, project, type Camera } from './camera'
import type { BeadColours } from './colour'
import { parseColour, UNSET_COLOUR } from './colour'
import { centroidOf, distanceBetween, type Structure } from './scene'

/** Everything the painter draws from — the same object the adapter is handed. */
export interface StructureView {
  structure: Structure
  camera: Camera
  style: StructureStyle
  colours: BeadColours
  /**
   * `1` for a bead inside the deck's window, `0` for one outside it; `null`
   * where nothing is windowed and every bead is lit.
   */
  lit: Uint8Array | null
  /** Beads under the pointer, or lit by an echo from another panel. */
  hovered: readonly number[]
  /** The pinned bead, or `-1`. */
  pinned: number
  /** Two beads joined by a chord — the two ends of a hovered contact. */
  chord: readonly [number, number] | null
  /** Loops drawn as chords (§25.5): each pair's anchors, as beads. */
  chords: ReadonlyArray<readonly [number, number]>
  /** The reader's measurements: pairs of beads joined by a dashed line, with the distance written at the middle. */
  measures: ReadonlyArray<readonly [number, number]>
  /**
   * The reader's marked places (§25.4): a bead drawn in the mark's own colour
   * at {@link MARKED_BEAD} times the radius, so a place stands out of the
   * fibre it is on whether or not anything else is coloured by the marks.
   *
   * Places only. A loop is two places and a chord, and it is the chord that
   * says *these two*; two fat beads at its ends would be a third way of
   * saying what the chord and the colouring already do.
   */
  marks: ReadonlyArray<{ bead: number; colour: string }>
  /** The genomic ruler: beads that carry a tick, and what the tick says. */
  ruler: ReadonlyArray<{ bead: number; label: string }>
  /**
   * The reader's bookmarks (§25.5), as the bead in the middle of each and its
   * name — written on the model with the sequence names, under the same
   * switch. Optional: a view built with no session behind it has none.
   */
  bookmarks?: ReadonlyArray<{ bead: number; label: string }>
  /** Another model in this one's frame (`StructureStyle.compare`), or `null`. */
  overlay: { structure: Structure; colours: BeadColours } | null
  /** The one haplotype shown, as an index, or `-1` for all of them. */
  haplotype: number
}

/** What the figure is drawn in, read off the page it is drawn on. */
export interface PainterPalette {
  background: string
  ink: string
  halo: string
}

/** How much smaller the farthest bead and stick are drawn than the nearest. */
const DEPTH_SHRINK = 0.35

/** The opacity of a bead outside the window, under `others: 'ghost'`, where a style says nothing. */
export const GHOST_OPACITY = 0.15

/** Below this an alpha is *gone*, as the adapter's `GHOST_GONE` has it: nothing is drawn. */
const GHOST_GONE = 0.004

/** How much wider than a bead the halo round a hovered or pinned one is. */
const HALO = 1.8

/** How much wider than a bead a marked place is drawn: twice, which is four times the ink. */
export const MARKED_BEAD = 2

/** Ink drawn along or across the fibre — a gap's dashes, a loop's chord — as a share of a stick's width. */
const INK_SHARE = 0.5

/**
 * The screen's lights, in the camera's frame — x to the right, y up, z towards
 * the reader — where `structure/three.ts` puts them, riding with the eye: a key
 * above and to the right in front, a weaker fill below and to the left behind,
 * and ambient. The weights are the screen's balance read off its PNG rather
 * than its physics: the face towards the reader is the surface's own colour, a
 * highlight up and to the right, the silhouette away from the key in shadow.
 */
const KEY = unit([1, 1.2, 1.5])
const FILL = unit([-1, -0.4, -1])
const AMBIENT = 0.55
const KEY_WEIGHT = 0.6
const FILL_WEIGHT = 0.25
/** The specular highlight: how far towards white at its peak, and how tight it is. */
const SPECULAR = 0.35
const SHININESS = 24
/** Halfway between the key and the eye: where on a sphere the highlight sits. */
const HIGHLIGHT = unit([KEY[0], KEY[1], KEY[2] + 1])

/** How many stops a bead's shading carries, from its highlight to its rim. */
const SPHERE_STOPS = 12

/**
 * Below this many pixels across, a tube, a stick or a bead is flat. Low, since
 * the page is a drawing: a tube a pixel across on the screen's framing is a
 * reader's zoom away from being the width of a finger, and lit when it is.
 */
const TUBE_SHADED_MIN = 0.75

/** The widest a tube's band of shading is, in pixels, and the fewest and most bands one carries. */
const BAND_WIDTH = 0.3
const BANDS_MIN = 8
const BANDS_MAX = 32

/** How many bands further in a tube's band reaches under the ones over it (see {@link tubeMarks}). */
const RING_REACH = 3

/** The longest straight piece a tube's outline is drawn in, in pixels. */
const OUTLINE_STEP = 1.5

/**
 * How far, in CSS pixels, an opaque stretch of tube runs on past the midpoint
 * where it meets the next — see {@link tubeMarks}. Not for a ghosted one,
 * whose overlap would be a band of twice the alpha at every joint.
 */
const JOIN_OVERLAP = 0.5

/** The compared model's tube, as a share of this one's: thinner, so the two read apart where they cross. */
const OVERLAY_TUBE = 0.7

/** The centre of rotation's parts, as the adapter builds them, in units of its size (`structure/three.ts`). */
const CENTRE = {
  /** The whole gizmo, as a share of the camera's distance. */
  size: 0.12,
  ball: 0.075,
  shaft: { from: 0, to: 0.8, radius: 0.022 },
  head: { from: 0.8, to: 1.02, radius: 0.07 },
  stub: { from: 0, to: -0.45, radius: 0.012 },
  /** x red, y green, z blue — the colours every 3D tool uses. */
  colours: ['#d8453c', '#2f9e44', '#3b7ddd'],
  ballOpacity: 0.8,
  armOpacity: 0.95,
} as const

type Rgb = [number, number, number]

/** One thing on the model, at the depth it is sorted by. */
interface Mark {
  depth: number
  /**
   * Which of several marks at one depth goes first: a halo under its bead, the
   * fibre under the bead on it, a ruler's tick over both.
   */
  layer: number
  draw: () => void
}

/** Where a set of beads lands on the page, and which of them are drawn at all. */
interface Placed {
  px: Float64Array
  py: Float64Array
  depth: Float64Array
  /** Pixels per scene unit at the bead's depth. */
  size: Float64Array
  /** `1` for a bead that is drawn: placed, of the haplotype shown, not hidden, inside the slab. */
  drawn: Uint8Array
}

/**
 * Draw the view into a box.
 *
 * The context is asked for nothing outside `VectorTarget`'s subset: `arc`,
 * `moveTo`, `lineTo`, `bezierCurveTo`, `fill`, `stroke`, `setLineDash`,
 * `fillText` and the colour and width properties. That is the whole of the
 * contract with the PDF.
 */
export function drawStructure(
  ctx: CanvasRenderingContext2D,
  box: { width: number; height: number },
  view: StructureView,
  palette: PainterPalette,
): void {
  const { structure, camera, style } = view
  ctx.save()
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, box.width, box.height)

  // The depth slab, as the adapter's two clipping planes: what lies further
  // than `half` either side of the centre of rotation, along the line of
  // sight, is not drawn.
  const half = slabHalf(structure, style)
  const inSlab = slabTest(camera, style, half)
  const placed = placeAll(structure, camera, box, inSlab, (i) => visible(view, i))
  const { px, py, depth, size, drawn } = placed

  let nearest = Infinity
  let farthest = -Infinity
  for (let i = 0; i < drawn.length; i++) {
    if (drawn[i] === 0) continue
    if (depth[i] < nearest) nearest = depth[i]
    if (depth[i] > farthest) farthest = depth[i]
  }
  const span = farthest > nearest ? farthest - nearest : 1
  /** How far back a bead is, 0 at the nearest and 1 at the farthest: the shrink. */
  const back = (i: number): number => (depth[i] - nearest) / span
  const fog = fogAt(camera, style, half)
  const background = parseColour(palette.background)
  const ink = parseColour(palette.ink)
  const alphaOf = (i: number): number => (view.lit !== null && view.lit[i] === 0 ? style.opacity : 1)
  const rgbOf = (colours: BeadColours, i: number): Rgb => [
    colours.rgb[i * 3],
    colours.rgb[i * 3 + 1],
    colours.rgb[i * 3 + 2],
  ]
  /** A colour as it reads at a depth: mixed towards the paper by the fog. */
  const fogged = (rgb: Rgb, at: number): string => css(mix(rgb, background, fog(at)))

  const beadRadius = structure.step * style.beadRadius
  const stickRadius = structure.step * style.tubeRadius

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Every mark with its depth, then one sort. Far to near is what makes near
  // cover far; the layer orders marks at the same depth.
  const marks: Mark[] = []

  // The compared model, in this one's frame: a thinner tube in its own
  // colours, sorted in with this model's marks, since the two are one scene.
  const overlay = view.overlay
  if (overlay !== null) {
    const o = overlay.structure
    const there = placeAll(o, camera, box, inSlab, (i) => o.present[i] === 1)
    for (const chain of o.chains) {
      tubeMarks(ctx, marks, chain, there, {
        radius: stickRadius * OVERLAY_TUBE,
        colour: (i) => rgbOf(overlay.colours, i),
        alpha: () => 1,
        fogged,
        position: (i) => [o.x[i], o.y[i], o.z[i]],
        camera,
        box,
      })
    }
  }

  if (style.tube) {
    for (const chain of structure.chains) {
      if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
      tubeMarks(ctx, marks, chain, placed, {
        radius: stickRadius,
        colour: (i) => rgbOf(view.colours, i),
        alpha: alphaOf,
        fogged,
        position: (i) => [structure.x[i], structure.y[i], structure.z[i]],
        camera,
        box,
      })
    }
  }

  if (style.sticks) {
    for (const chain of structure.chains) {
      if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
      for (let r = 0; r < chain.runs.length; r += 2) {
        for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
          const a = chain.beads[k - 1]
          const b = chain.beads[k]
          if (drawn[a] === 0 || drawn[b] === 0) continue
          marks.push({
            // Under both its beads where they are drawn: a stick runs between
            // their centres, inside both spheres, and sorted at its middle it
            // was laid over the farther one — invisible while both were one
            // flat colour, a dark bar across a lit sphere once they are not.
            depth: style.beads ? Math.max(depth[a], depth[b]) : (depth[a] + depth[b]) / 2,
            layer: 1,
            draw: () => {
              const alpha = (alphaOf(a) + alphaOf(b)) / 2
              if (alpha < GHOST_GONE) return
              const t = (back(a) + back(b)) / 2
              const width = Math.max(0.5, stickRadius * 2 * ((size[a] + size[b]) / 2) * (1 - DEPTH_SHRINK * t))
              ctx.globalAlpha = alpha
              ctx.setLineDash([])
              // Two-tone sticks, each half in its own bead's colour, so a
              // colouring by position or by a track reads along the fibre
              // rather than in steps — and lit, band by band, both halves'
              // band before either's next, so neither half's cap is laid
              // across the other's lighter core.
              const mx = (px[a] + px[b]) / 2
              const my = (py[a] + py[b]) / 2
              for (const band of bandsOf(width, alpha)) {
                const [dx, dy] = nudgeOf(width, band.outer)
                ctx.lineWidth = width * band.outer
                ctx.strokeStyle = fogged(band.shade(rgbOf(view.colours, a)), depth[a])
                ctx.beginPath()
                ctx.moveTo(px[a] + dx, py[a] + dy)
                ctx.lineTo(mx + dx, my + dy)
                ctx.stroke()
                ctx.strokeStyle = fogged(band.shade(rgbOf(view.colours, b)), depth[b])
                ctx.beginPath()
                ctx.moveTo(mx + dx, my + dy)
                ctx.lineTo(px[b] + dx, py[b] + dy)
                ctx.stroke()
              }
            },
          })
        }
      }
    }
  }

  // A dashed run across each gap, **whatever the model is drawn as**: a gap is
  // a fact about the model, and a chain that seems to end where a bead is
  // missing is a model that looks like two. The dashes are the adapter's, in
  // the model's own units and projected one by one, so a gap seen end-on is
  // short dashes rather than the same pattern laid flat.
  for (const chain of structure.chains) {
    if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
    for (let r = 2; r < chain.runs.length; r += 2) {
      const a = chain.beads[chain.runs[r - 1] - 1]
      const b = chain.beads[chain.runs[r]]
      if (drawn[a] === 0 || drawn[b] === 0) continue
      const dashes = dashesBetween(camera, box, structure, a, b, stickRadius * 3, stickRadius * 2)
      const at = (depth[a] + depth[b]) / 2
      marks.push({
        depth: at,
        layer: 1,
        draw: () => {
          const alpha = (alphaOf(a) + alphaOf(b)) / 2
          if (alpha < GHOST_GONE) return
          ctx.globalAlpha = alpha
          ctx.strokeStyle = fogged(ink, at)
          // Ink at half the stick's width: the line says *nothing is here*,
          // and a line about the fibre that outweighs the fibre reads as part
          // of it.
          ctx.lineWidth = Math.max(1, stickRadius * 2 * INK_SHARE * ((size[a] + size[b]) / 2))
          ctx.lineCap = 'butt'
          ctx.setLineDash([])
          ctx.beginPath()
          for (const [x0, y0, x1, y1] of dashes) {
            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
          }
          ctx.stroke()
          ctx.lineCap = 'round'
        },
      })
    }
  }

  // The halo behind a hovered or pinned bead, under whatever is drawn there:
  // round the bead, or round the fibre where there are no beads.
  const haloRadius = HALO * (style.beads ? beadRadius : Math.max(stickRadius, beadRadius * 0.6))
  for (const i of new Set([...view.hovered, ...(view.pinned >= 0 ? [view.pinned] : [])])) {
    if (i < 0 || i >= drawn.length || drawn[i] === 0) continue
    marks.push({
      depth: depth[i],
      layer: 0,
      draw: () => {
        const t = back(i)
        ctx.globalAlpha = 1
        ctx.fillStyle = palette.ink
        ctx.beginPath()
        ctx.arc(px[i], py[i], Math.max(1, haloRadius * size[i] * (1 - DEPTH_SHRINK * t)), 0, Math.PI * 2)
        ctx.fill()
      },
    })
  }

  if (style.beads) {
    for (let i = 0; i < drawn.length; i++) {
      if (drawn[i] === 0) continue
      marks.push({
        depth: depth[i],
        layer: 2,
        draw: () => {
          const alpha = alphaOf(i)
          if (alpha < GHOST_GONE) return
          const t = back(i)
          const radius = Math.max(0.4, beadRadius * size[i] * (1 - DEPTH_SHRINK * t))
          ctx.globalAlpha = alpha
          ctx.fillStyle = sphereFill(ctx, px[i], py[i], radius, rgbOf(view.colours, i), (rgb) => fogged(rgb, depth[i]))
          ctx.beginPath()
          ctx.arc(px[i], py[i], radius, 0, Math.PI * 2)
          ctx.fill()
        },
      })
    }
  }

  // The ruler's ticks: a small bead of ink at each, over the fibre it marks,
  // faded with the bead it sits on as every mark is (§25.5).
  const tickRadius = Math.max(stickRadius * 1.6, beadRadius * 0.8)
  for (const tick of view.ruler) {
    const i = tick.bead
    if (i < 0 || i >= drawn.length || drawn[i] === 0) continue
    marks.push({
      depth: depth[i],
      layer: 3,
      draw: () => {
        const alpha = alphaOf(i)
        if (alpha < GHOST_GONE) return
        ctx.globalAlpha = alpha
        ctx.fillStyle = fogged(ink, depth[i])
        ctx.beginPath()
        ctx.arc(px[i], py[i], Math.max(0.8, tickRadius * size[i]), 0, Math.PI * 2)
        ctx.fill()
      },
    })
  }

  marks.sort((m, o) => o.depth - m.depth || m.layer - o.layer)
  for (const mark of marks) mark.draw()
  ctx.setLineDash([])
  ctx.lineCap = 'round'

  // The reader's marked places: the bead again, twice the size, in the mark's
  // own colour. Over the fibre and under every line, so a marked place reads
  // as a place on the model rather than as another line across it.
  for (const mark of view.marks) {
    const i = mark.bead
    if (i < 0 || i >= drawn.length || drawn[i] === 0) continue
    const alpha = alphaOf(i)
    if (alpha < GHOST_GONE) continue
    const t = back(i)
    const radius = Math.max(0.8, beadRadius * size[i] * MARKED_BEAD * (1 - DEPTH_SHRINK * t))
    ctx.globalAlpha = alpha
    ctx.fillStyle = sphereFill(ctx, px[i], py[i], radius, parseColour(mark.colour), (rgb) => fogged(rgb, depth[i]))
    ctx.beginPath()
    ctx.arc(px[i], py[i], radius, 0, Math.PI * 2)
    ctx.fill()
  }

  // Loops as chords, under the hovered one: thin, so a hundred of them read
  // as a texture of the model rather than a cage round it.
  if (view.chords.length > 0 && style.chords) {
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = palette.ink
    ctx.beginPath()
    let widest = 0
    for (const [a, b] of view.chords) {
      if (drawn[a] !== 1 || drawn[b] !== 1) continue
      widest = Math.max(widest, size[a], size[b])
      ctx.moveTo(px[a], py[a])
      ctx.lineTo(px[b], py[b])
    }
    ctx.lineWidth = Math.max(1, stickRadius * 2 * INK_SHARE * widest)
    ctx.stroke()
  }

  // The reader's measurements: dashed ink, the dashes the adapter's. The
  // distance is written with the other words, below.
  for (const [a, b] of view.measures) {
    if (drawn[a] !== 1 || drawn[b] !== 1) continue
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.ink
    ctx.lineWidth = Math.max(1.2, stickRadius * 1.2 * ((size[a] + size[b]) / 2))
    ctx.lineCap = 'butt'
    ctx.beginPath()
    for (const [x0, y0, x1, y1] of dashesBetween(camera, box, structure, a, b, stickRadius * 2.5, stickRadius * 1.5)) {
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    }
    ctx.stroke()
    ctx.lineCap = 'round'
  }

  // The chord on top of everything: the one line that says *these two*.
  if (view.chord !== null) {
    const [a, b] = view.chord
    if (drawn[a] === 1 && drawn[b] === 1) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = palette.ink
      ctx.lineWidth = Math.max(2, stickRadius * 1.6 * ((size[a] + size[b]) / 2))
      ctx.lineCap = 'butt'
      ctx.beginPath()
      for (const [x0, y0, x1, y1] of dashesBetween(camera, box, structure, a, b, stickRadius * 3, stickRadius * 2)) {
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
      }
      ctx.stroke()
      ctx.lineCap = 'round'
    }
  }

  // The centre of rotation, over the model as the adapter draws it — a centre
  // inside a tube is still the centre.
  if (style.axes) drawCentre(ctx, box, view, palette)

  ctx.globalAlpha = 1
  drawStructureLabels(ctx, box, view, palette)
  ctx.restore()
}

/**
 * Everything written on the model — the ruler's labels, the measurements'
 * distances, and under *names* the bookmarks and each chain's name — in the
 * box's own CSS pixels.
 *
 * One function for both pictures: the vector page calls it above, and the
 * adapter's snapshot calls it over the GL frame (`structure/three.ts`), so the
 * PNG and the PDF of one model carry the same words in the same places. What
 * the cell writes as DOM over its canvas is the source: a tick's label is
 * every *k*-th of at most eighty, a sequence outside the window under *hide*
 * is not named, and one ghosted is named faintly.
 *
 * Not clipped by the depth slab, as the cell's own labels are not.
 */
export function drawStructureLabels(
  ctx: CanvasRenderingContext2D,
  box: { width: number; height: number },
  view: StructureView,
  palette: PainterPalette,
): void {
  const { structure, style } = view
  const named = (bead: number): boolean =>
    bead >= 0 &&
    bead < structure.present.length &&
    structure.present[bead] === 1 &&
    !(view.haplotype >= 0 && structure.model.hap[bead] !== view.haplotype) &&
    !(view.lit !== null && view.lit[bead] === 0 && style.others === 'hide')
  const at = (bead: number): { px: number; py: number } | null =>
    project(view.camera, box, structure.x[bead], structure.y[bead], structure.z[bead])
  /** A run of text with the halo under it, offset as the figure's names always were. */
  const write = (text: string, x: number, y: number): void => {
    ctx.fillStyle = palette.halo
    ctx.fillText(text, x + 1, y + 1)
    ctx.fillStyle = palette.ink
    ctx.fillText(text, x, y)
  }
  ctx.save()
  ctx.setLineDash([])

  // The ruler's labels beside their ticks, every k-th where there are more
  // than eighty, so a whole genome is not a cloud of numbers.
  if (view.ruler.length > 0) {
    const every = Math.max(1, Math.ceil(view.ruler.length / 80))
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = 0.8
    view.ruler.forEach((tick, index) => {
      if (index % every !== 0 || !named(tick.bead)) return
      const point = at(tick.bead)
      if (point !== null) write(tick.label, point.px + 6, point.py)
    })
  }

  // The measurements' distances, at the middle of each line, in the file's
  // own units — the number the card and the cell print.
  if (view.measures.length > 0) {
    ctx.font = '600 10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.globalAlpha = 1
    for (const [a, b] of view.measures) {
      if (!named(a) || !named(b)) continue
      const pa = at(a)
      const pb = at(b)
      if (pa === null || pb === null) continue
      write(fmt.num(distanceBetween(structure, a, b)), (pa.px + pb.px) / 2, (pa.py + pb.py) / 2 - 3)
    }
  }

  if (style.labels) {
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // The reader's bookmarks, at the bead in the middle of each (§25.5).
    for (const bookmark of view.bookmarks ?? []) {
      if (!named(bookmark.bead)) continue
      const point = at(bookmark.bead)
      if (point === null) continue
      ctx.globalAlpha = view.lit !== null && view.lit[bookmark.bead] === 0 ? 0.45 : 1
      write(bookmark.label, point.px, point.py)
    }
    // Chain names at each chain's midpoint bead.
    for (const chain of structure.chains) {
      if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
      const mid = chain.beads[chain.beads.length >> 1]
      if (mid === undefined || !named(mid)) continue
      const point = at(mid)
      if (point === null) continue
      const name = structure.contigs[chain.contig]
      const label =
        structure.haplotypes.length > 1 && view.haplotype < 0
          ? `${name} ${structure.haplotypes[chain.hap]}`
          : name
      ctx.globalAlpha = view.lit !== null && view.lit[mid] === 0 ? 0.45 : 1
      write(label, point.px, point.py)
    }
  }
  ctx.restore()
}

/**
 * One chain's tube, as a mark per bead.
 *
 * **Per bead, not per segment, and that is what makes it read as one tube.**
 * The obvious drawing is a round-capped stroke between each pair of
 * neighbours, sorted by depth — and every one of them then lays its dark rim's
 * cap over the light core of the neighbour drawn before it, so the fibre comes
 * out as a string of sausages with a dark crescent at every bead. Here each
 * bead owns the stretch from half way to its previous neighbour to half way to
 * its next, which is exactly the stretch the adapter colours by that bead, and
 * the stretches meet **butt to butt** at those midpoints, where the two have
 * one tangent: no rim is ever laid across another stretch's core, and a bead
 * in front still covers a bead behind where the fibre crosses itself. Each
 * runs on {@link JOIN_OVERLAP} past its midpoints, straight along the tangent,
 * because two shapes that merely touch leave a hairline of the paper between
 * them in every anti-aliased reader; whichever of the two is drawn second
 * covers the overlap with its own rim *and* core, so the joint shows nothing.
 *
 * **On the curve the adapter draws.** The tube on screen is a Catmull–Rom
 * spline through the beads (`CatmullRomCurve3` at a tension of a half), whose
 * every span is a cubic Bézier — and an orthographic projection of a Bézier is
 * the Bézier of the projected control points, which `bezierCurveTo` draws
 * exactly. A run's two ends are given the curve's own reflected neighbour, and
 * a round end, since the stretch's own cap has to be butt where it meets the
 * next.
 *
 * Each stretch is lit as a cylinder is ({@link bandsOf}): a stack of bands
 * along the one curve, from the full width in shadow to a narrow highlight,
 * each nudged towards the key light. A band is filled, not stroked, as the
 * outline of the curve offset either side ({@link ribbon}), so its width can
 * run from one midpoint's to the other's. A ghosted bead, or a tube too thin
 * to shade, is one flat band at the bead's alpha, as the adapter draws it at
 * one.
 */
function tubeMarks(
  ctx: CanvasRenderingContext2D,
  marks: Mark[],
  chain: { beads: Int32Array; runs: Int32Array },
  placed: Placed,
  options: {
    radius: number
    colour: (i: number) => Rgb
    alpha: (i: number) => number
    fogged: (rgb: Rgb, depth: number) => string
    position: (i: number) => [number, number, number]
    camera: Camera
    box: { width: number; height: number }
  },
): void {
  const { drawn, depth, size, px, py } = placed
  for (let r = 0; r < chain.runs.length; r += 2) {
    // The run split wherever a bead is not drawn — hidden by the window, or
    // cut by the slab — since a tube is never drawn through what is not there.
    let run: number[] = []
    const flush = (): void => {
      if (run.length >= 2) tubeRun(run)
      run = []
    }
    for (let k = chain.runs[r]; k < chain.runs[r + 1]; k++) {
      const bead = chain.beads[k]
      if (drawn[bead] === 1) run.push(bead)
      else flush()
    }
    flush()
  }

  function tubeRun(beads: number[]): void {
    const count = beads.length
    // Each span's Bézier, projected, and split in two at its middle — the two
    // halves belong to the beads at its two ends.
    const firsts: number[][] = []
    const seconds: number[][] = []
    for (let s = 0; s + 1 < count; s++) {
      const a = options.position(beads[s])
      const b = options.position(beads[s + 1])
      const before = s > 0 ? options.position(beads[s - 1]) : reflect(a, b)
      const after = s + 2 < count ? options.position(beads[s + 2]) : reflect(b, a)
      const c1 = a.map((v, axis) => v + (b[axis] - before[axis]) / 6)
      const c2 = b.map((v, axis) => v - (after[axis] - a[axis]) / 6)
      const flat = [a, c1, c2, b].map((point) => {
        const at = project(options.camera, options.box, point[0], point[1], point[2])
        return at === null ? [Number.NaN, Number.NaN] : [at.px, at.py]
      })
      const [first, second] = splitBezier(flat)
      firsts.push(first)
      seconds.push(second)
    }
    for (let j = 0; j < count; j++) {
      const bead = beads[j]
      const into = j > 0 ? seconds[j - 1] : null
      const out = j + 1 < count ? firsts[j] : null
      if ([...(into ?? []), ...(out ?? [])].some((v) => !Number.isFinite(v))) continue
      const end = into === null || out === null
      // The direction the curve leaves each midpoint in, for the overlap.
      const back = into === null ? null : towards(into, 0)
      const on = out === null ? null : towards(out, 6)
      marks.push({
        depth: depth[bead],
        layer: 1,
        draw: () => {
          const alpha = options.alpha(bead)
          if (alpha < GHOST_GONE) return
          const colour = options.colour(bead)
          const widthOf = (b: number): number => Math.max(0.5, options.radius * 2 * size[b])
          const width = widthOf(bead)
          // The width at each midpoint is the two beads' mean, from either
          // side, so two stretches meet at one width rather than a step of
          // the perspective between them.
          const before = j > 0 ? (width + widthOf(beads[j - 1])) / 2 : width
          const after = j + 1 < count ? (width + widthOf(beads[j + 1])) / 2 : width
          const overlap = alpha >= 1 ? JOIN_OVERLAP : 0
          const line = centreline(into, out, back, on, [px[bead], py[bead]], before, width, after, overlap)
          const bands = bandsOf(width, alpha)
          ctx.globalAlpha = alpha
          ctx.setLineDash([])
          for (let k = 0; k < bands.length; k++) {
            const band = bands[k]
            ctx.fillStyle = options.fogged(band.shade(colour), depth[bead])
            // A round end where the run stops: a disc per band.
            if (end) {
              const [dx, dy] = nudgeOf(width, band.outer)
              ctx.beginPath()
              ctx.arc(px[bead] + dx, py[bead] + dy, (width * band.outer) / 2, 0, Math.PI * 2)
              ctx.fill()
            }
            // Each band is the ring of the section that is its own, and
            // reaches only RING_REACH bands in under the next: so where this
            // stretch is laid over its neighbour's end, every part of it lies
            // on the neighbour's same band, and nothing shows the seam. A band
            // laid whole over the lighter ones of the stretch below put the
            // edge of every band at one line, and the reader's anti-aliasing
            // left a dark hairline across the tube at every bead.
            const inner = k + RING_REACH < bands.length ? bands[k + RING_REACH].outer : null
            ctx.beginPath()
            ribbon(ctx, line, band.outer, inner, 1)
            ribbon(ctx, line, band.outer, inner, -1)
            ctx.fill()
          }
          ctx.lineCap = 'round'
        },
      })
    }
  }
}

/**
 * The unit tangent of a projected half-span `[x0, y0, c1x, c1y, c2x, c2y, x1,
 * y1]` at one of its ends — `0` its start, pointing into it, or `6` its end,
 * pointing out of it — falling back along the control points where two of
 * them coincide.
 */
function towards(half: number[], at: 0 | 6): [number, number] {
  const order = at === 0 ? [2, 4, 6] : [4, 2, 0]
  for (const other of order) {
    const dx = at === 0 ? half[other] - half[0] : half[6] - half[other]
    const dy = at === 0 ? half[other + 1] - half[1] : half[7] - half[other + 1]
    const length = Math.hypot(dx, dy)
    if (length > 1e-9) return [dx / length, dy / length]
  }
  return [0, 0]
}

/** The point the far side of `a` from `b`: the curve's own neighbour at a run's end. */
function reflect(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]]
}

/**
 * A cubic Bézier split at its middle (de Casteljau), each half as
 * `[x0, y0, c1x, c1y, c2x, c2y, x1, y1]`.
 */
function splitBezier(points: number[][]): [number[], number[]] {
  const [p0, p1, p2, p3] = points
  const mid = (a: number[], b: number[]): number[] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const m01 = mid(p0, p1)
  const m12 = mid(p1, p2)
  const m23 = mid(p2, p3)
  const m012 = mid(m01, m12)
  const m123 = mid(m12, m23)
  const s = mid(m012, m123)
  return [
    [...p0, ...m01, ...m012, ...s],
    [...s, ...m123, ...m23, ...p3],
  ]
}

/**
 * The dashes between two beads, as the adapter lays them: `dash` on and `gap`
 * off along the line in the model's own units, each dash projected on its
 * own. At most two hundred, so a radius of nothing cannot ask for infinitely
 * many.
 */
function dashesBetween(
  camera: Camera,
  box: { width: number; height: number },
  structure: Structure,
  a: number,
  b: number,
  dash: number,
  gap: number,
): Array<[number, number, number, number]> {
  const from: [number, number, number] = [structure.x[a], structure.y[a], structure.z[a]]
  const to: [number, number, number] = [structure.x[b], structure.y[b], structure.z[b]]
  const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  if (!(length > 0)) return []
  const step = Math.max(dash + gap, length / 200)
  const on = dash * (step / Math.max(dash + gap, 1e-12))
  const out: Array<[number, number, number, number]> = []
  const along = (d: number): [number, number, number] => [
    from[0] + ((to[0] - from[0]) * d) / length,
    from[1] + ((to[1] - from[1]) * d) / length,
    from[2] + ((to[2] - from[2]) * d) / length,
  ]
  for (let at = 0; at < length; at += step) {
    const p = along(at)
    const q = along(Math.min(length, at + on))
    const pp = project(camera, box, p[0], p[1], p[2])
    const qq = project(camera, box, q[0], q[1], q[2])
    if (pp === null || qq === null) continue
    out.push([pp.px, pp.py, qq.px, qq.py])
  }
  return out
}

/**
 * The centre of rotation as the adapter builds it (`structure/three.ts`): a
 * ball of ink at the camera's target and an arm per axis of the model's
 * planted frame — a shaft and a head on the positive side, a thin stub on the
 * negative — in the axis colours. Flat, as the adapter's are, and sorted far to
 * near among themselves, as three sorts its transparent parts.
 *
 * Each part is the outline a cylinder or a cone casts under the projection:
 * the convex hull of its circles' projected points and its tip. Exact for the
 * orthographic projection every model is drawn in, and right at every angle —
 * an arm pointing at the reader is the small disc the screen shows, not a line
 * of no length.
 */
function drawCentre(
  ctx: CanvasRenderingContext2D,
  box: { width: number; height: number },
  view: StructureView,
  palette: PainterPalette,
): void {
  const { camera, style } = view
  const size = camera.distance * CENTRE.size
  const [tx, ty, tz] = camera.target
  const centre = project(camera, box, tx, ty, tz)
  if (centre === null) return
  const axes = frameAxes(style.axesFrame)
  const point = (dir: readonly number[], along: number): [number, number, number] => [
    tx + dir[0] * along * size,
    ty + dir[1] * along * size,
    tz + dir[2] * along * size,
  ]
  const parts: Array<{ depth: number; draw: () => void }> = [
    {
      depth: centre.depth,
      draw: () => {
        ctx.globalAlpha = CENTRE.ballOpacity
        ctx.fillStyle = palette.ink
        ctx.beginPath()
        ctx.arc(centre.px, centre.py, Math.max(1, CENTRE.ball * size * centre.pixelsPerUnit), 0, Math.PI * 2)
        ctx.fill()
      },
    },
  ]
  ;[axes.x, axes.y, axes.z].forEach((dir, index) => {
    const colour = CENTRE.colours[index]
    for (const part of [CENTRE.shaft, CENTRE.head, CENTRE.stub]) {
      const base = point(dir, part.from)
      const tip = point(dir, part.to)
      const middle = point(dir, (part.from + part.to) / 2)
      const ring = (at: [number, number, number]): Array<[number, number]> =>
        circlePoints(at, dir, part.radius * size).flatMap((p) => {
          const projected = project(camera, box, p[0], p[1], p[2])
          return projected === null ? [] : [[projected.px, projected.py] as [number, number]]
        })
      const cone = part === CENTRE.head
      const outline = convexHull([
        ...ring(base),
        ...(cone
          ? (() => {
              const t = project(camera, box, tip[0], tip[1], tip[2])
              return t === null ? [] : [[t.px, t.py] as [number, number]]
            })()
          : ring(tip)),
      ])
      if (outline.length < 3) continue
      const at = project(camera, box, middle[0], middle[1], middle[2])
      parts.push({
        depth: at === null ? centre.depth : at.depth,
        draw: () => {
          ctx.globalAlpha = CENTRE.armOpacity
          ctx.fillStyle = colour
          ctx.beginPath()
          ctx.moveTo(outline[0][0], outline[0][1])
          for (const [x, y] of outline.slice(1)) ctx.lineTo(x, y)
          ctx.closePath()
          ctx.fill()
        },
      })
    }
  })
  parts.sort((m, o) => o.depth - m.depth)
  for (const part of parts) part.draw()
  ctx.globalAlpha = 1
}

/** Sixteen points round a circle in 3D: centre, the axis it is square to, radius. */
function circlePoints(
  centre: [number, number, number],
  axis: readonly number[],
  radius: number,
): Array<[number, number, number]> {
  const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const cross = (p: readonly number[], q: readonly number[]): number[] => [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ]
  const u0 = cross(axis, helper)
  const length = Math.hypot(u0[0], u0[1], u0[2]) || 1
  const u = u0.map((v) => v / length)
  const v = cross(axis, u)
  const out: Array<[number, number, number]> = []
  for (let k = 0; k < 16; k++) {
    const angle = (k / 16) * Math.PI * 2
    const c = Math.cos(angle) * radius
    const s = Math.sin(angle) * radius
    out.push([centre[0] + u[0] * c + v[0] * s, centre[1] + u[1] * c + v[1] * s, centre[2] + u[2] * c + v[2] * s])
  }
  return out
}

/** The convex hull of points on the page, in order round it (Andrew's monotone chain). */
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  if (sorted.length < 3) return sorted
  const turn = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const p of sorted) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Array<[number, number]> = []
  for (let k = sorted.length - 1; k >= 0; k--) {
    const p = sorted[k]
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** Whether a bead of the model is drawn at all, before the slab is asked. */
function visible(view: StructureView, i: number): boolean {
  const { structure, style } = view
  if (structure.present[i] === 0) return false
  if (view.haplotype >= 0 && structure.model.hap[i] !== view.haplotype) return false
  if (view.lit !== null && view.lit[i] === 0 && style.others === 'hide') return false
  return true
}

/** Every bead of a model on the page, and which of them are drawn. */
function placeAll(
  structure: Structure,
  camera: Camera,
  box: { width: number; height: number },
  inSlab: (x: number, y: number, z: number) => boolean,
  keep: (i: number) => boolean,
): Placed {
  const n = structure.set.length
  const placed: Placed = {
    px: new Float64Array(n),
    py: new Float64Array(n),
    depth: new Float64Array(n),
    size: new Float64Array(n),
    drawn: new Uint8Array(n),
  }
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue
    const x = structure.x[i]
    const y = structure.y[i]
    const z = structure.z[i]
    if (!inSlab(x, y, z)) continue
    const at = project(camera, box, x, y, z)
    if (at === null) continue
    placed.px[i] = at.px
    placed.py[i] = at.py
    placed.depth[i] = at.depth
    placed.size[i] = at.pixelsPerUnit
    placed.drawn[i] = 1
  }
  return placed
}

/**
 * Half the slab's thickness, in the scene's units — the adapter's own: the
 * model's reach from its centre, times the slab. Measured on every bead the
 * file placed, so it is a fact about the model and not about the window.
 */
function slabHalf(structure: Structure, style: StructureStyle): number {
  const all = centroidOf(structure, counting(structure.set.length))
  const reach = all === null ? 1 : Math.max(1e-3, all.radius)
  return Math.max(1e-3, reach * style.slab)
}

/** Whether a point lies between the slab's two planes; everything does at a slab of one. */
function slabTest(
  camera: Camera,
  style: StructureStyle,
  half: number,
): (x: number, y: number, z: number) => boolean {
  if (!(style.slab < 1)) return () => true
  const { forward } = basis(camera)
  const [tx, ty, tz] = camera.target
  return (x, y, z) => {
    const along = (x - tx) * forward[0] + (y - ty) * forward[1] + (z - tz) * forward[2]
    return along >= -half && along <= half
  }
}

/**
 * How far into the fog a depth is, from 0 to 1 — the adapter's fog, as
 * arithmetic.
 *
 * Linear fog in three.js is a smoothstep between where it starts and where it
 * reaches the page, and the adapter starts it at the centre of rotation — the
 * plane the slab is centred on — and has it reach the page `half / fog`
 * further back, so what it says is how close a bead is to being cut away. Off
 * is nothing.
 */
export function fogAt(camera: Camera, style: StructureStyle, half: number): (depth: number) => number {
  if (!style.fogOn || !(style.fog > 0)) return () => 0
  const near = camera.distance
  const far = near + half / style.fog
  return (depth) => {
    const t = Math.max(0, Math.min(1, (depth - near) / Math.max(1e-12, far - near)))
    return t * t * (3 - 2 * t)
  }
}

/** `0, 1, … n − 1`, for a helper that wants an iterable of every bead. */
function* counting(n: number): Generator<number, void, void> {
  for (let i = 0; i < n; i++) yield i
}

/** A colour mixed towards another by `t`. */
function unit(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** A colour under the screen's lights, on a surface facing `normal` (camera frame, unit). */
export function shade(colour: Rgb, normal: [number, number, number]): Rgb {
  const dot = (l: readonly number[]): number => Math.max(0, normal[0] * l[0] + normal[1] * l[1] + normal[2] * l[2])
  const light = AMBIENT + KEY_WEIGHT * dot(KEY) + FILL_WEIGHT * dot(FILL)
  const lit: Rgb = [
    Math.min(1, colour[0] * light),
    Math.min(1, colour[1] * light),
    Math.min(1, colour[2] * light),
  ]
  return mix(lit, [1, 1, 1], SPECULAR * dot(HIGHLIGHT) ** SHININESS)
}

/**
 * The colour a lit sphere has `t` of the way from its highlight (`0`) out to
 * the point of its silhouette furthest from the light (`1`).
 *
 * The family of circles a radial shading sweeps — from a point at the
 * highlight to the whole disc, centre and radius growing together — has each
 * circle's far side `t` of the way along that line, and the far side is most
 * of what each band shows; so that is the normal the band is lit by. The same
 * profile across a tube's width is the cylinder's, near enough at the widths a
 * figure reads it at.
 */
function sphereAt(colour: Rgb, t: number): Rgb {
  const [hx, hy] = [HIGHLIGHT[0], HIGHLIGHT[1]]
  const away = Math.hypot(hx, hy) || 1
  const x = (1 - t) * hx - (t * hx) / away
  const y = (1 - t) * hy - (t * hy) / away
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
  return shade(colour, [x, y, z])
}

/**
 * A bead as a lit sphere: a radial gradient from a point at its highlight to
 * the whole disc, its stops fogged as the bead is. One flat colour where the
 * bead is too small to shade, and on a context without gradients.
 */
function sphereFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  colour: Rgb,
  fogged: (rgb: Rgb) => string,
): string | CanvasGradient {
  if (radius < TUBE_SHADED_MIN / 2 || typeof ctx.createRadialGradient !== 'function') {
    return fogged(sphereAt(colour, 0.5))
  }
  // Canvas y runs down the page; the camera's runs up it.
  const gradient = ctx.createRadialGradient(
    x + HIGHLIGHT[0] * radius,
    y - HIGHLIGHT[1] * radius,
    0,
    x,
    y,
    radius,
  )
  for (let k = 0; k <= SPHERE_STOPS; k++) {
    const t = k / SPHERE_STOPS
    gradient.addColorStop(t, fogged(sphereAt(colour, t)))
  }
  return gradient
}

/**
 * A lit line `width` across, as bands to lay one over the next along the
 * same path: from the full width in the shadow of its rim to a narrow
 * highlight, each a share `outer` of the width, nudged towards the light by
 * as much as it is narrower ({@link nudgeOf}).
 *
 * The nudge is one vector for a whole path, and a vector moves a line only
 * across itself, so a tube running towards the light is lit along its middle
 * and one running across it on its lit side — which is what a cylinder does.
 * One flat band, the surface's own colour, for a ghosted line (bands at an
 * alpha would add up) or one too thin to shade.
 */
function bandsOf(width: number, alpha: number): Array<{ outer: number; shade: (colour: Rgb) => Rgb }> {
  if (alpha < 1 || width < TUBE_SHADED_MIN) return [{ outer: 1, shade: (colour) => colour }]
  const count = Math.min(BANDS_MAX, Math.max(BANDS_MIN, Math.ceil(width / 2 / BAND_WIDTH)))
  const bands: Array<{ outer: number; shade: (colour: Rgb) => Rgb }> = []
  for (let k = 0; k < count; k++) {
    const middle = 1 - (k + 0.5) / count
    bands.push({ outer: 1 - k / count, shade: (colour) => sphereAt(colour, middle) })
  }
  return bands
}

/** How far a band a share `outer` of a line `width` across is moved towards the light, in canvas pixels. */
function nudgeOf(width: number, outer: number): [number, number] {
  const nudge = ((1 - outer) * width) / 2
  // Canvas y runs down the page; the camera's runs up it.
  return [HIGHLIGHT[0] * nudge, -HIGHLIGHT[1] * nudge]
}

/** A point on a tube's centreline: where, which way it runs, and how wide the tube is there. */
interface Station {
  x: number
  y: number
  /** The unit tangent. */
  tx: number
  ty: number
  width: number
}

/**
 * A stretch's centreline as stations, from `overlap` before its first
 * midpoint to `overlap` past its last, the width running linearly from each
 * midpoint's to the bead's along each half-span.
 */
function centreline(
  into: number[] | null,
  out: number[] | null,
  back: [number, number] | null,
  on: [number, number] | null,
  centre: [number, number],
  before: number,
  width: number,
  after: number,
  overlap: number,
): Station[] {
  const stations: Station[] = []
  const along = (half: number[], from: number, to: number, skipFirst: boolean, fallback: [number, number]): void => {
    const reach =
      Math.hypot(half[2] - half[0], half[3] - half[1]) +
      Math.hypot(half[4] - half[2], half[5] - half[3]) +
      Math.hypot(half[6] - half[4], half[7] - half[5])
    const steps = Math.min(16, Math.max(2, Math.ceil(reach / OUTLINE_STEP)))
    let tangent = fallback
    for (let i = skipFirst ? 1 : 0; i <= steps; i++) {
      const t = i / steps
      const u = 1 - t
      const x = u * u * u * half[0] + 3 * u * u * t * half[2] + 3 * u * t * t * half[4] + t * t * t * half[6]
      const y = u * u * u * half[1] + 3 * u * u * t * half[3] + 3 * u * t * t * half[5] + t * t * t * half[7]
      const dx = 3 * u * u * (half[2] - half[0]) + 6 * u * t * (half[4] - half[2]) + 3 * t * t * (half[6] - half[4])
      const dy = 3 * u * u * (half[3] - half[1]) + 6 * u * t * (half[5] - half[3]) + 3 * t * t * (half[7] - half[5])
      const length = Math.hypot(dx, dy)
      if (length > 1e-9) tangent = [dx / length, dy / length]
      stations.push({ x, y, tx: tangent[0], ty: tangent[1], width: from + (to - from) * t })
    }
  }
  if (into !== null && back !== null) {
    stations.push({ x: into[0] - back[0] * overlap, y: into[1] - back[1] * overlap, tx: back[0], ty: back[1], width: before })
    along(into, before, width, false, back)
  }
  if (out !== null && on !== null) {
    const start = into === null ? towards(out, 0) : [stations[stations.length - 1].tx, stations[stations.length - 1].ty]
    along(out, width, after, into !== null, start as [number, number])
    stations.push({ x: out[6] + on[0] * overlap, y: out[7] + on[1] * overlap, tx: on[0], ty: on[1], width: after })
  }
  if (stations.length === 0) stations.push({ x: centre[0], y: centre[1], tx: 1, ty: 0, width })
  return stations
}

/**
 * One side of a band of a tube, as a closed subpath: its edge on that side
 * (`side` `1` or `-1`) out and back along the band `inner` of the width in,
 * or along the other side's edge for the band in the middle (`inner` null).
 *
 * A band is a share of the tube's width wherever it is, so it narrows and
 * widens with the tube and meets its neighbour's at the midpoint exactly.
 */
function ribbon(
  ctx: CanvasRenderingContext2D,
  line: Station[],
  outer: number,
  inner: number | null,
  side: 1 | -1,
): void {
  if (inner === null && side === -1) return
  const edge = (station: Station, share: number, which: 1 | -1): [number, number] => {
    const [dx, dy] = nudgeOf(station.width, share)
    const half = (station.width * share) / 2
    return [station.x + dx - station.ty * half * which, station.y + dy + station.tx * half * which]
  }
  line.forEach((station, i) => {
    const [x, y] = edge(station, outer, side)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  for (let i = line.length - 1; i >= 0; i--) {
    const [x, y] = inner === null ? edge(line[i], outer, -1) : edge(line[i], inner, side)
    ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function mix(colour: Rgb, towards: Rgb, t: number): Rgb {
  if (!(t > 0)) return colour
  return [
    colour[0] + (towards[0] - colour[0]) * t,
    colour[1] + (towards[1] - colour[1]) * t,
    colour[2] + (towards[2] - colour[2]) * t,
  ]
}

/** `0..1` channels as the `rgb()` the page writes, rounded to a byte. */
function css(rgb: Rgb): string {
  const byte = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgb(${byte(rgb[0])}, ${byte(rgb[1])}, ${byte(rgb[2])})`
}

/**
 * The weight of the rule round a model's cell in an exported figure, in CSS
 * pixels: the map's plot border's (`render/heatmap.ts`), so the two cells of a
 * deck are framed alike.
 */
export const CELL_FRAME_WIDTH = 0.75

/**
 * The cell's edge, as a thin rule round an exported model (§25.7).
 *
 * A model zoomed past its cell is cut by the cell's edge, and on screen the
 * cell's own border says where the cut is. Exported without one it floats on
 * the page with a straight side sliced off it for no visible reason — so every
 * export draws the edge: the deck's figure, the card's PNG and PDF and the
 * clipboard. Inset by half its width, so the whole of the line is on the page
 * rather than half of it cut by the page's own edge.
 */
export function drawCellFrame(
  ctx: CanvasRenderingContext2D,
  box: { width: number; height: number },
  colour: string,
  width: number,
): void {
  ctx.save()
  ctx.setLineDash([])
  ctx.strokeStyle = colour
  ctx.lineWidth = width
  ctx.strokeRect(width / 2, width / 2, box.width - width, box.height - width)
  ctx.restore()
}

/** A neutral palette for a figure on paper. */
export const PAPER_PALETTE: PainterPalette = {
  background: '#ffffff',
  ink: '#222222',
  halo: '#ffffff',
}

/** What the painter draws a bead it knows nothing about in. */
export const PAINTER_UNSET = UNSET_COLOUR
