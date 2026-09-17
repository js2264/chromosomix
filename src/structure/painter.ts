/**
 * A structure drawn through a `CanvasRenderingContext2D`, for the figure (§25).
 *
 * Beads and sticks are paths — discs and segments — and paths are what the
 * vector export is made of (`ui/vector.ts`): five thousand beads are five
 * thousand `arc`s, which is squarely on the side of the line
 * `ui/analysisPlots.ts` draws between *tens of cells are paths* and *twelve
 * thousand bins are pixels*. So the representations that are paths export as
 * vector PDF through this painter, and the tube — a lit surface no `arc` can
 * be — exports as the raster the three.js adapter renders.
 *
 * It is **not a second renderer**. The scene, the camera, the colours and what
 * is lit are the same objects the adapter is handed, projected through the
 * same arithmetic (`structure/camera.ts`), so the page shows the picture the
 * screen showed in the representation that is paths. It is also the one path
 * a test can exercise without a GPU: `drawingOf` runs this into a
 * `VectorPage`, and a figure that draws nothing is caught by the operator
 * stream being empty.
 *
 * Painter's algorithm: every mark is sorted by depth and drawn far to near, so
 * a bead in front covers a bead behind. Exact for discs of one radius, and the
 * right picture for sticks at the widths a figure uses. No gradients, because
 * `createLinearGradient` is not in `VectorTarget` and the point of drawing this
 * way is to stay inside it; shading is the depth cue instead — beads further
 * from the eye are drawn a little smaller and a little paler.
 */

import type { StructureStyle } from '../annotations/types'
import { project, type Camera } from './camera'
import type { BeadColours } from './colour'
import { parseColour, UNSET_COLOUR } from './colour'
import type { Structure } from './scene'

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
  /**
   * A size per bead, as a factor of the bead radius, or `null` for every
   * bead the same (`StructureStyle.sizeBy`).
   */
  sizes: Float32Array | null
  /**
   * The map's contacts from the pinned bead as chords: the bead at the far
   * end, the contact's weight (0–1 of the strongest) and its colour on the
   * map's scale.
   */
  contactChords: ReadonlyArray<{ bead: number; weight: number; colour: string }>
  /** The reader's measurements: pairs of beads joined by a dashed line, with the distance written at the middle. */
  measures: ReadonlyArray<readonly [number, number]>
  /** The genomic ruler: beads that carry a tick, and what the tick says. */
  ruler: ReadonlyArray<{ bead: number; label: string }>
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

/** How much paler and smaller the farthest bead is drawn than the nearest. */
const DEPTH_FADE = 0.45
const DEPTH_SHRINK = 0.35

/** The opacity of a bead outside the window, under `others: 'ghost'`, where a style says nothing. */
export const GHOST_OPACITY = 0.15

/** How much wider than a bead the halo round a hovered or pinned one is. */
const HALO = 1.8

/**
 * Draw the view into a box.
 *
 * The context is asked for nothing outside `VectorTarget`'s subset: `arc`,
 * `moveTo`, `lineTo`, `fill`, `stroke`, `setLineDash`, `fillText` and the
 * colour and width properties. That is the whole of the contract with the PDF.
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

  const n = structure.set.length
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const depth = new Float64Array(n)
  const size = new Float64Array(n)
  const shown = new Uint8Array(n)
  let nearest = Infinity
  let farthest = -Infinity
  for (let i = 0; i < n; i++) {
    if (structure.present[i] === 0) continue
    if (view.haplotype >= 0 && structure.model.hap[i] !== view.haplotype) continue
    if (view.lit !== null && view.lit[i] === 0 && style.others === 'hide') continue
    const at = project(camera, box, structure.x[i], structure.y[i], structure.z[i])
    if (at === null) continue
    px[i] = at.px
    py[i] = at.py
    depth[i] = at.depth
    size[i] = at.pixelsPerUnit
    shown[i] = 1
    if (at.depth < nearest) nearest = at.depth
    if (at.depth > farthest) farthest = at.depth
  }
  const span = farthest > nearest ? farthest - nearest : 1
  const fade = (i: number): number => (depth[i] - nearest) / span

  const drawBeads = style.beads
  // A tube is paths here: the run as a thick line, which is what a tube is
  // seen from far enough away.
  const drawSticks = style.sticks || style.tube
  const beadRadius = structure.step * style.beadRadius
  const stickRadius = structure.step * style.tubeRadius

  // Every mark with its depth, then one sort: sticks at the midpoint of their
  // two beads, beads at their own. Far to near is what makes near cover far.
  const marks: Array<{ depth: number; kind: 0 | 1; a: number; b: number }> = []
  if (drawSticks) {
    for (const chain of structure.chains) {
      if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
      for (let r = 0; r < chain.runs.length; r += 2) {
        for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
          const a = chain.beads[k - 1]
          const b = chain.beads[k]
          if (shown[a] === 0 || shown[b] === 0) continue
          marks.push({ depth: (depth[a] + depth[b]) / 2, kind: 0, a, b })
        }
      }
      // A dashed run across each gap, always: a gap is a fact about the
      // model, and a chain that seems to end where a bead is missing is a
      // model that looks like two.
      {
        for (let r = 2; r < chain.runs.length; r += 2) {
          const a = chain.beads[chain.runs[r - 1] - 1]
          const b = chain.beads[chain.runs[r]]
          if (shown[a] === 0 || shown[b] === 0) continue
          marks.push({ depth: (depth[a] + depth[b]) / 2, kind: 1, a, b })
        }
      }
    }
  }
  if (drawBeads) {
    for (let i = 0; i < n; i++) if (shown[i] === 1) marks.push({ depth: depth[i], kind: 0, a: i, b: -1 })
  }
  const sizeOf = (i: number): number => (view.sizes === null ? 1 : view.sizes[i])
  marks.sort((m, o) => o.depth - m.depth)

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const background = parseColour(palette.background)

  // The compared model under this one: its runs as thin lines in its own
  // colours, projected through the same camera, so the two read as one
  // picture and this model is the one on top.
  const overlay = view.overlay
  if (overlay !== null) {
    ctx.globalAlpha = 0.7
    ctx.lineWidth = Math.max(0.6, stickRadius * 0.9)
    const o = overlay.structure
    for (const chain of o.chains) {
      for (let r = 0; r < chain.runs.length; r += 2) {
        for (let k = chain.runs[r] + 1; k < chain.runs[r + 1]; k++) {
          const a = chain.beads[k - 1]
          const b = chain.beads[k]
          if (o.present[a] === 0 || o.present[b] === 0) continue
          const pa = project(view.camera, box, o.x[a], o.y[a], o.z[a])
          const pb = project(view.camera, box, o.x[b], o.y[b], o.z[b])
          if (pa === null || pb === null) continue
          ctx.strokeStyle = overlay.colours.css[a]
          ctx.beginPath()
          ctx.moveTo(pa.px, pa.py)
          ctx.lineTo(pb.px, pb.py)
          ctx.stroke()
        }
      }
    }
  }
  for (const mark of marks) {
    const i = mark.a
    const ghost = view.lit !== null && view.lit[i] === 0
    const alpha = ghost ? style.opacity : 1
    if (mark.b >= 0) {
      const j = mark.b
      const t = (fade(i) + fade(j)) / 2
      const width = Math.max(0.5, stickRadius * 2 * ((size[i] + size[j]) / 2) * (1 - DEPTH_SHRINK * t))
      // A gap's dashes are ink, not the bead's colour, and a little wider
      // than the sticks: a line that says *nothing is here* has to be read
      // as such from across the room.
      ctx.strokeStyle = mark.kind === 1 ? palette.ink : paled(view.colours.css[i], background, DEPTH_FADE * t)
      ctx.globalAlpha = alpha
      ctx.lineWidth = mark.kind === 1 ? Math.max(1.5, width * 0.8) : width
      ctx.setLineDash(mark.kind === 1 ? [width * 2, width * 2] : [])
      ctx.beginPath()
      ctx.moveTo(px[i], py[i])
      // Two-tone sticks, each half in its own bead's colour, so a colouring by
      // position or by a track reads along the fibre rather than in steps.
      const mx = (px[i] + px[j]) / 2
      const my = (py[i] + py[j]) / 2
      ctx.lineTo(mx, my)
      ctx.stroke()
      ctx.strokeStyle = paled(view.colours.css[j], background, DEPTH_FADE * t)
      ctx.beginPath()
      ctx.moveTo(mx, my)
      ctx.lineTo(px[j], py[j])
      ctx.stroke()
      ctx.setLineDash([])
      continue
    }
    const t = fade(i)
    const radius = Math.max(0.4, beadRadius * sizeOf(i) * size[i] * (1 - DEPTH_SHRINK * t))
    const marked = view.hovered.includes(i) || view.pinned === i
    if (marked) {
      ctx.globalAlpha = 1
      ctx.fillStyle = palette.ink
      ctx.beginPath()
      ctx.arc(px[i], py[i], radius * HALO, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = alpha
    ctx.fillStyle = paled(view.colours.css[i], background, DEPTH_FADE * t)
    ctx.beginPath()
    ctx.arc(px[i], py[i], radius, 0, Math.PI * 2)
    ctx.fill()
  }

  // Loops as chords, under the hovered one: thin, so a hundred of them read
  // as a texture of the model rather than a cage round it.
  if (view.chords.length > 0 && style.chords) {
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = palette.ink
    ctx.lineWidth = Math.max(1.2, stickRadius * 1.2)
    ctx.beginPath()
    for (const [a, b] of view.chords) {
      if (shown[a] !== 1 || shown[b] !== 1) continue
      ctx.moveTo(px[a], py[a])
      ctx.lineTo(px[b], py[b])
    }
    ctx.stroke()
  }

  // The map's contacts from the pinned bead: a line per contact, as wide as
  // the contact is strong, in the map's colour for it.
  if (view.pinned >= 0 && view.contactChords.length > 0 && shown[view.pinned] === 1) {
    const p = view.pinned
    ctx.globalAlpha = 0.85
    for (const contact of view.contactChords) {
      if (shown[contact.bead] !== 1) continue
      ctx.strokeStyle = contact.colour
      ctx.lineWidth = Math.max(0.8, stickRadius * (0.5 + 2 * contact.weight))
      ctx.beginPath()
      ctx.moveTo(px[p], py[p])
      ctx.lineTo(px[contact.bead], py[contact.bead])
      ctx.stroke()
    }
  }

  // The reader's measurements: dashed ink, the distance written at the middle.
  if (view.measures.length > 0) {
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.ink
    ctx.fillStyle = palette.ink
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.lineWidth = Math.max(1.2, stickRadius * 1.2)
    ctx.setLineDash([5, 4])
    for (const [a, b] of view.measures) {
      if (shown[a] !== 1 || shown[b] !== 1) continue
      ctx.beginPath()
      ctx.moveTo(px[a], py[a])
      ctx.lineTo(px[b], py[b])
      ctx.stroke()
      const d = Math.hypot(structure.x[a] - structure.x[b], structure.y[a] - structure.y[b], structure.z[a] - structure.z[b])
      ctx.fillText(d.toFixed(2), (px[a] + px[b]) / 2, (py[a] + py[b]) / 2 - 3)
    }
    ctx.setLineDash([])
  }

  // The chord on top of everything: the one line that says *these two*.
  if (view.chord !== null) {
    const [a, b] = view.chord
    if (shown[a] === 1 && shown[b] === 1) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = palette.ink
      ctx.lineWidth = Math.max(2, stickRadius * size[a] * 1.4)
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(px[a], py[a])
      ctx.lineTo(px[b], py[b])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // Chain names at each chain's midpoint bead, haloed so they read over ink.
  if (style.labels) {
    ctx.globalAlpha = 1
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const chain of structure.chains) {
      if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
      const mid = chain.beads[chain.beads.length >> 1]
      if (shown[mid] === 0) continue
      const name = structure.contigs[chain.contig]
      const label =
        structure.haplotypes.length > 1 && view.haplotype < 0
          ? `${name} ${structure.haplotypes[chain.hap]}`
          : name
      ctx.fillStyle = palette.halo
      ctx.fillText(label, px[mid] + 1, py[mid] + 1)
      ctx.fillStyle = palette.ink
      ctx.fillText(label, px[mid], py[mid])
    }
  }
  ctx.restore()
}

/**
 * A colour mixed towards the background by `t`, as a CSS string.
 *
 * The depth cue, computed rather than drawn with a gradient: the far end of a
 * model fades towards the paper, which is what the eye reads as distance.
 */
function paled(colour: string, background: [number, number, number], t: number): string {
  if (!(t > 0)) return colour
  const [r, g, b] = parseColour(colour)
  const mix = (a: number, c: number): number => Math.round((a + (c - a) * t) * 255)
  return `rgb(${mix(r, background[0])}, ${mix(g, background[1])}, ${mix(b, background[2])})`
}

/** A neutral palette for a figure on paper. */
export const PAPER_PALETTE: PainterPalette = {
  background: '#ffffff',
  ink: '#222222',
  halo: '#ffffff',
}

/** What the painter draws a bead it knows nothing about in. */
export const PAINTER_UNSET = UNSET_COLOUR
