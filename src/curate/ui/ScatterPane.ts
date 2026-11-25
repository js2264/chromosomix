/**
 * The curation stage's GC × coverage scatter (SPECS §33.3): every contig a
 * dot — its GC content across, its coverage up on a log scale, its area its
 * length, its colour its genome's — so an organism is one cloud, and a contig
 * binned into the wrong genome, or left in the pool, stands out of the cloud it
 * belongs to. Its colours and its GC need no contact read; its height is the
 * stage's coverage, the contigs' Hi-C contacts per kb, once the contacts are
 * read — GC alone, in a band, until then. A contig without coverage sits in a
 * `none` strip at the foot, never lost; one without a GC content cannot be
 * placed, and is counted in the head. The frame leaves out the 0.5 % of the
 * contigs at each end of each axis (`FRAME_TAIL`), so a few strays do not
 * shrink every cloud: a contig beyond it is pinned to its edge, a wedge
 * pointing the way it lies, counted in the head and said `off the scale`. The
 * coverage axis reads in one notation from its foot to its top — `10,000`
 * over `1,000`, or every tick an exponent where one needs it.
 *
 * Three canvases, one over another:
 *
 * - the **dots**: the grid, every dot in batches of one colour — the pool
 *   first and faint, then each genome's, the small before the large so no long
 *   contig hides under short ones — the selected genomes full and the rest
 *   faded, the selected contigs over them ringed in the accent, and the axes;
 *   painted again when the binning, the selection or the view changes;
 * - the **marks**: the genome lit in every pane, the contigs an offered
 *   suggestion would bring into a selected genome, and the question shown —
 *   its contigs ringed, its genomes outlined, a line to where it would take
 *   them, its number; painted again when one of those changes;
 * - the **hand**, on top: the dot under the pointer and its place on both
 *   axes, and the lasso while it is drawn.
 *
 * The hand: a drag lassoes the dots inside it (⇧ adds, ⌥ takes away — a
 * selected genome is given up for its contigs, less the ones lassoed); a press
 * selects a dot's contig, a second press its genome; a drag from a selected
 * contig carries the selection, which the stage's one drop grammar lands; the
 * wheel zooms at the pointer, Space held (or the middle button) pans, `0` or a
 * double click on nothing fits. Nothing drops here: clouds overlap, and a drop
 * is never a guess.
 *
 * Every number the readout prints is the answer's or the file's, never a
 * pixel's.
 */

import type { StageInk } from '../../edit/draw'
import { Scale } from '../../render/scale'
import { optionKey, shiftKey, wantsSpace, withKey } from '../../ui/commands'
import { el } from '../../ui/dom'
import { iconButton } from '../../ui/icons'
import { scaleFont, subscribeTextScale } from '../../ui/textScale'
import { fmt } from '../../units'
import type { CurationStateResult } from '../../worker/curateProtocol'
import { displayPercent, type CurateChange } from '../model'
import {
  coverageTicks,
  coverageTickTexts,
  DotGrid,
  dotRadius,
  drawOrder,
  FRAME_TAIL,
  lassoContigs,
  pinToFrame,
  pinVector,
  scatterFrame,
  scatterPlaces,
  type ScatterFrame,
  type ScatterPlaces,
} from '../scatter'
import type { Suggestion } from '../suggest'
import { affinityText } from './contactLayout'
import type { CurateContext, CurateDropTarget, CurateFrame, CuratePane } from './context'

const TAU = 2 * Math.PI
/** How far a press travels before it is a drag, in CSS pixels. */
const DRAG_PX = 4
/** The strip of contigs without coverage at the foot, and the gap above it: large, then small. */
const STRIP = 22
const STRIP_GAP = 8
const STRIP_SMALL = 6
const STRIP_GAP_SMALL = 3
/** GC alone, before the coverage: the band's height, at most and at least. */
const BAND_MOST = 136
const BAND_LEAST = 36
/** Room round the plot: above it, right of it, left of a band without a coverage axis; a thumbnail's all round. */
const PAD_TOP = 14
const PAD_RIGHT = 18
const PAD_LEFT_BAND = 18
const PAD_SMALL = 5
/** An axis's ticks, outward from the plot, and the gap before their labels. */
const TICK = 4
const TICK_GAP = 3
/** A thumbnail's dots, as a share of the large picture's. */
const SMALL_SCALE = 0.55
/** A contig pinned to the frame's edge: a wedge as large as its dot grown by this, and no smaller than the least. */
const WEDGE_GROW = 1.4
const WEDGE_LEAST = 3.5
/** How opaque a dot is: at rest, faded by a selection elsewhere, in a selected genome; the pool's at rest and faded. */
const ALPHA_REST = 0.8
const ALPHA_FADED = 0.15
const ALPHA_CHOSEN = 0.95
const POOL_REST = 0.35
const POOL_FADED = 0.1
/** A view spans at least this much: a fifth of a GC percent, a fiftieth of a decade. */
const LEAST_GC = 0.2
const LEAST_LOG = 0.02
/** A lasso keeps its points at least this far apart. */
const LASSO_STEP = 2
/** The contigs a lasso holds are counted while it is drawn, up to this many dots in view; lifted, up to this many held. */
const LIVE_MOST = 150_000
const LIVE_LIFTED = 4_000
/** A question's lines to where its contigs would go, drawn for this many contigs at most. */
const LINES_MOST = 24
/** Past this many dots in view the smallest are squares, as large as their disc and cheaper. */
const SQUARES_FROM = 60_000
/** A GC tick's label needs this much width, a coverage tick's this much height. */
const GC_TICK_PX = 56
const COVERAGE_TICK_PX = 22
/** A decade this tall on the coverage axis gets its minor ticks, 2 to 9. */
const MINOR_PX = 44
/** The sizes the head's key shows, in bases: a dot grows no more past 60 kb (`dotRadius`). */
const KEY_SIZES: ReadonlyArray<[number, string]> = [
  [1_000, '1 kb'],
  [10_000, '10 kb'],
  [60_000, '≥ 60 kb'],
]

/** What the pane shows: the plot, GC alone before the coverage, nothing for want of GC, nothing yet. */
export type ScatterView = 'gc-coverage' | 'gc' | 'no-gc' | 'waiting'

/** Where the contigs go, counted once per GC and coverage. */
interface Placing {
  gc: Float64Array
  coverage: Float64Array | null
  mode: 'gc-coverage' | 'gc'
  /** The contigs with a GC content: the ones placed, in the file's order. */
  contigs: Int32Array
  /** By contig: 1 where it has no coverage — drawn in the strip at the foot (every one, GC alone). */
  bare: Uint8Array
  bareCount: number
  /** Contigs of the file without a GC content. */
  unplaced: number
  /** The frame: the contigs but the 0.5 % at each end of each axis. */
  frame: ScatterFrame
  /** Each contig's GC and coverage held inside the frame: where it is drawn. */
  held: { gc: Float64Array; coverage: Float64Array | null }
  /** By contig: the frame's edges it is pinned to, `0` for none (`PIN_LEFT` …). */
  pin: Uint8Array
  /** The contigs pinned. */
  pinned: number
}

/** What the dots layer paints for a binning and a selection: runs of one colour each, and the selected contigs over them. */
interface Plan {
  shown: CurationStateResult
  order: Int32Array
  runs: Array<{ from: number; to: number; colour: string; alpha: number; faded: boolean }>
  /** By contig: its place in the painting — the selected contigs last, so the dot on top answers a press. */
  rank: Int32Array
  /** The selected contigs placed, the smallest first, drawn over the rest and ringed. */
  chosen: Int32Array
  /** By contig: 1 where it is selected. */
  chosenMask: Uint8Array
  /** The contigs an offered recruit or move would bring into a selected genome. */
  candidates: Int32Array
  /** Each contig's surest offered recruit or move, for the readout. */
  offered: Map<number, Suggestion>
}

interface Modifiers {
  meta: boolean
  shift: boolean
  alt: boolean
}

/** A press of the hand, until it is let go. */
type Press =
  | { kind: 'pan'; pointer: number; x: number; y: number }
  | { kind: 'carry'; pointer: number; x: number; y: number; dot: number; mod: Modifiers }
  | { kind: 'lasso'; pointer: number; x: number; y: number; dot: number; mod: Modifiers; moved: boolean; points: number[] }

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A contig's place across a strip, from 0 to 1: the same at every paint, scattered by its index. */
function jitter(c: number): number {
  let h = (c + 0x9e3779b9) | 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Keep an axis's view inside its frame, and no narrower than `least`. */
function clampAxis(scale: Scale, lo: number, hi: number, least: number): void {
  let [d0, d1] = scale.domain
  const full = hi - lo
  if (!(full > 0)) return
  if (d1 - d0 >= full - 1e-12) {
    scale.setDomain([lo, hi])
    return
  }
  if (d1 - d0 < least) {
    const centre = (d0 + d1) / 2
    const span = Math.min(least, full)
    d0 = centre - span / 2
    d1 = centre + span / 2
  }
  if (d0 < lo) {
    d1 += lo - d0
    d0 = lo
  }
  if (d1 > hi) {
    d0 -= d1 - hi
    d1 = hi
  }
  scale.setDomain([Math.max(lo, d0), Math.min(hi, d1)])
}

/** A coverage as the readout prints it: `13`, `1.5`, `0.15`. */
export function coverageText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 10) return fmt.int(Math.round(value))
  if (value >= 1) return value.toFixed(1)
  if (value < 1e-3) return value.toExponential(1)
  return String(Number(value.toPrecision(2)))
}

/** A contig's coverage in words, with what it is: `13 Hi-C contacts per kb`. */
function coverageWords(value: number, label: string): string {
  if (Number.isNaN(value)) return `${label} unknown`
  return `${coverageText(value)} ${label}`
}

/** A GC tick as printed: `40`, `42.5`. */
function gcText(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** Every `k`th tick, so no more than `most` are left. */
function thin(ticks: number[], most: number): number[] {
  if (ticks.length <= most) return ticks
  const every = Math.ceil(ticks.length / most)
  return ticks.filter((_, k) => k % every === 0)
}

/** The GC axis's steps, finest first. */
const GC_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]

/**
 * The GC axis's ticks across a view: the finest step of the 1–2–5 ladder that
 * puts no more ticks than `room` pixels hold, nor more than a dozen — every
 * 10 % over a whole metagenome, every 2 % or every 1 % on one cloud.
 */
function gcTicksIn(view: ScatterFrame, room: number): number[] {
  const span = view.gc1 - view.gc0
  const most = Math.max(2, Math.min(12, Math.floor(room / GC_TICK_PX)))
  const step = GC_STEPS.find((s) => span / s <= most) ?? GC_STEPS[GC_STEPS.length - 1]
  const ticks: number[] = []
  for (let k = Math.ceil(view.gc0 / step - 1e-9); k * step <= view.gc1 + 1e-9; k++) ticks.push(Number((k * step).toFixed(2)))
  return ticks
}

/** The coverage values on a ladder (`1, 2, 5` a decade, say) that fall in a view. */
function ladder(view: ScatterFrame, steps: readonly number[]): number[] {
  const out: number[] = []
  for (let p = Math.floor(view.log0) - 1; p <= Math.ceil(view.log1); p++) {
    for (const m of steps) {
      const value = Number((m * 10 ** p).toPrecision(6))
      const log = Math.log10(value)
      if (log >= view.log0 - 1e-9 && log <= view.log1 + 1e-9) out.push(value)
    }
  }
  return out
}

/** The coverage axis's ticks: the decades (and their halves), then the 1–2–5 ladder, then every unit of a decade. */
function coverageTicksIn(view: ScatterFrame, room: number): number[] {
  let ticks = coverageTicks(view)
  if (ticks.length < 2) ticks = ladder(view, [1, 2, 5])
  if (ticks.length < 2) ticks = ladder(view, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  return thin(ticks, Math.max(2, Math.floor(room / COVERAGE_TICK_PX)))
}

/** Each genome's contigs, CSR: `contigs[offsets[g]] … contigs[offsets[g + 1] - 1]`. */
function membersOf(genomeOf: Int32Array, genomes: number): { offsets: Int32Array; contigs: Int32Array } {
  const offsets = new Int32Array(genomes + 1)
  for (let c = 0; c < genomeOf.length; c++) if (genomeOf[c] >= 0 && genomeOf[c] < genomes) offsets[genomeOf[c] + 1]++
  for (let g = 0; g < genomes; g++) offsets[g + 1] += offsets[g]
  const fill = offsets.slice(0, genomes)
  const contigs = new Int32Array(offsets[genomes])
  for (let c = 0; c < genomeOf.length; c++) {
    const g = genomeOf[c]
    if (g >= 0 && g < genomes) contigs[fill[g]++] = c
  }
  return { offsets, contigs }
}

export class ScatterPane implements CuratePane {
  readonly element: HTMLElement
  readonly title = 'scatter'
  private readonly head: HTMLElement
  private readonly countsNode: HTMLElement
  private readonly countNode: HTMLElement
  private readonly bareNode: HTMLElement
  /** The head's pieces that give way, whole, when it is short of room: in this order. */
  private readonly yielding: readonly HTMLElement[]
  private readonly tools: HTMLElement
  private readonly plot: HTMLElement
  private readonly dots: HTMLCanvasElement
  private readonly marks: HTMLCanvasElement
  private readonly hand: HTMLCanvasElement
  private readonly note: HTMLElement
  private large = true
  // What is placed and painted.
  private placing: Placing | null = null
  private plan: Plan | null = null
  private members: { offsets: Int32Array; contigs: Int32Array } | null = null
  private indexOf = new Map<string, number>()
  private centroids = new Map<number, { gc: number; log: number | null } | null>()
  /** By contig: its dot's radius at full size, from its length; the file's, so counted once. */
  private readonly radius: Float32Array
  // The view: GC across, log10 of the coverage up.
  private readonly sx = new Scale([0, 1], 1)
  private readonly sy = new Scale([0, 1], 1)
  private fitted = true
  // The layout, in CSS pixels of the plot.
  private box = { width: 0, height: 0 }
  private main: Box = { x: 0, y: 0, w: 0, h: 0 }
  private strip: { y: number; h: number } | null = null
  private dpr = 1
  private ticks: { gc: number[]; coverage: number[] } = { gc: [], coverage: [] }
  // Placed through the view.
  private places: ScatterPlaces | null = null
  private inView = new Uint8Array(0)
  private visible = new Int32Array(0)
  private grid: DotGrid | null = null
  // What needs painting again.
  private layoutDirty = true
  private placesDirty = true
  private dotsDirty = true
  private marksDirty = true
  private handDirty = true
  private headDirty = true
  private frameId = 0
  // The hand.
  private press: Press | null = null
  private pointer: { x: number; y: number } | null = null
  private underPointer = -1
  private space = false
  private live: number[] = []
  private liveDirty = false
  private said: string | null = null
  private litDrawn: string | null = null
  // The question shown.
  private featured: Suggestion | null = null
  private disposed = false
  private readonly offs: Array<() => void> = []

  constructor(private readonly ctx: CurateContext) {
    this.radius = Float32Array.from(ctx.data.file.lengths, (length) => dotRadius(length))
    const shift = el('kbd', { class: 'kbd kbd-inline', text: shiftKey() })
    const option = el('kbd', { class: 'kbd kbd-inline', text: optionKey() })
    // `drag to` gives way before the keys do: the readout says it over the plot, and nothing else names the keys.
    const verb = el('span', { class: 'curate-scatter-hint-verb', text: 'drag to ' })
    const hint = el(
      'span',
      { class: 'curate-scatter-hint', title: 'Drag round dots to select their contigs; press a dot for its contig, again for its genome; drag a selected contig to carry the selection' },
      el('span', {}, verb, 'lasso'),
      shift,
      el('span', { text: 'adds' }),
      option,
      el('span', { text: 'takes away' }),
    )
    const legend = el('span', { class: 'curate-scatter-legend', title: 'A dot’s area is its contig’s length' }, el('span', { class: 'curate-scatter-legend-word', text: 'length' }))
    for (const [length, label] of KEY_SIZES) {
      const r = dotRadius(length)
      const disc = el('span', { class: 'curate-scatter-disc', attrs: { 'aria-hidden': 'true' } })
      disc.style.width = `${2 * r}px`
      disc.style.height = `${2 * r}px`
      legend.appendChild(el('span', { class: 'curate-scatter-size' }, disc, el('span', { text: label })))
    }
    this.countNode = el('span', { class: 'curate-scatter-count' })
    this.bareNode = el('span', { class: 'curate-scatter-bare' })
    this.countsNode = el('span', { class: 'curate-scatter-counts' }, this.countNode, this.bareNode)
    this.tools = el(
      'div',
      { class: 'curate-scatter-tools' },
      iconButton('maximize', withKey('Show every contig', '0'), () => this.fit(), { class: 'btn btn-icon', size: 14 }),
      iconButton('zoom-out', withKey('Zoom out', '-'), () => this.zoomBy(1.25), { class: 'btn btn-icon', size: 14 }),
      iconButton('zoom-in', withKey('Zoom in', '+'), () => this.zoomBy(0.8), { class: 'btn btn-icon', size: 14 }),
    )
    // Short of room, the sizes give way first, then the strip's count, then the hint, `drag to` before its keys (`fitHead`).
    this.yielding = [legend, this.bareNode, verb, hint]
    this.head = el('div', { class: 'curate-scatter-head' }, this.countsNode, hint, legend, this.tools)
    this.dots = el('canvas', { class: 'curate-scatter-dots', attrs: { 'aria-hidden': 'true' } })
    this.marks = el('canvas', { class: 'curate-scatter-marks', attrs: { 'aria-hidden': 'true' } })
    this.hand = el('canvas', {
      class: 'curate-scatter-hand',
      attrs: {
        tabindex: '0',
        'aria-label': 'Every contig by its GC content and its coverage: drag round dots to select their contigs, press a dot for its contig and again for its genome',
      },
    })
    this.note = el('div', { class: 'curate-scatter-note hidden', attrs: { role: 'status' } })
    this.plot = el('div', { class: 'curate-scatter-plot' }, this.dots, this.marks, this.hand, this.note)
    this.element = el(
      'section',
      { class: 'curate-scatter', attrs: { 'data-pane': 'scatter', 'data-view': 'waiting', 'data-zoom': 'fit', 'data-ready': 'false', 'data-large': 'true' } },
      this.head,
      this.plot,
    )
    this.wire()
    this.offs.push(ctx.onFrame((target) => this.frameOn(target)))
    this.offs.push(
      subscribeTextScale(() => {
        this.layoutDirty = true
        this.schedule()
      }),
    )
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.resize())
      observer.observe(this.plot)
      this.offs.push(() => observer.disconnect())
    }
    this.rebuild()
  }

  // -------------------------------------------------------------------------
  // The pane's contract.
  // -------------------------------------------------------------------------

  update(change: CurateChange): void {
    if (this.disposed) return
    switch (change) {
      case 'state':
      case 'preview':
        this.rebuild()
        return
      case 'selection':
        this.replan()
        return
      case 'hover': {
        const lit = this.ctx.model.hovered.genome
        if (lit !== this.litDrawn) this.marksDirty = true
        this.handDirty = true
        this.schedule()
        return
      }
      case 'mode':
      case 'current':
        this.marksDirty = true
        this.schedule()
        return
      default:
        return
    }
  }

  resize(): void {
    this.layoutDirty = true
    this.schedule()
  }

  setLarge(large: boolean): void {
    if (large === this.large) return
    this.large = large
    if (!large) this.letGo()
    this.element.classList.toggle('is-small', !large)
    this.element.dataset.large = String(large)
    this.hand.tabIndex = large ? 0 : -1
    this.layoutDirty = true
    this.paintNote()
    this.schedule()
  }

  showSuggestion(suggestion: Suggestion | null): void {
    this.featured = suggestion
    this.hand.dataset.current = suggestion?.key ?? ''
    this.marksDirty = true
    this.schedule()
  }

  key(event: KeyboardEvent): boolean {
    if (!this.large || event.metaKey || event.ctrlKey || event.altKey) return false
    switch (event.key) {
      case '0':
        this.fit()
        return true
      case '+':
      case '=':
        this.zoomBy(0.8)
        return true
      case '-':
      case '_':
        this.zoomBy(1.25)
        return true
      case 'Escape':
        if (this.press === null) return false
        // The lasso let go of, and nothing more: the dialog's own Escape, which
        // lets go of the selection, listens on the window beside the stage's
        // keys and would hear this one too.
        event.stopImmediatePropagation()
        this.cancelPress()
        return true
      default:
        return false
    }
  }

  /** Nothing drops on the scatter: its clouds overlap, and a drop is never a guess. */
  dropTargetAt(): CurateDropTarget | null {
    return null
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameId)
    this.frameId = 0
    for (const off of this.offs) off()
    this.offs.length = 0
  }

  // -------------------------------------------------------------------------
  // The view, as a script or the stage asks it.
  // -------------------------------------------------------------------------

  /** What is drawn: the plot, GC alone before the coverage, nothing for want of GC, nothing yet. */
  get view(): ScatterView {
    if (this.ctx.model.shown === null) return 'waiting'
    if (this.placing === null) return 'no-gc'
    return this.placing.mode
  }

  /** Show every contig. */
  fit(): void {
    const placing = this.placing
    if (placing === null) return
    this.sx.setDomain([placing.frame.gc0, placing.frame.gc1])
    this.sy.setDomain([placing.frame.log0, placing.frame.log1])
    this.viewChanged()
  }

  /** Zoom by `factor` about the plot's middle: below 1 in, above 1 out. */
  zoomBy(factor: number): void {
    if (!this.large || this.placing === null || !(factor > 0)) return
    this.zoomAt(this.main.x + this.main.w / 2, this.main.y + this.main.h / 2, 1 / factor)
  }

  // -------------------------------------------------------------------------
  // What is drawn, again: after a count, a preview, a selection.
  // -------------------------------------------------------------------------

  private rebuild(): void {
    const shown = this.ctx.model.shown
    const placing = this.placingFor(this.ctx.data.gc, this.ctx.data.coverage)
    if (placing !== this.placing) {
      const was = this.placing
      this.placing = placing
      this.layoutDirty = true
      if (placing !== null && (was === null || was.mode !== placing.mode || was.frame !== placing.frame)) {
        // A new frame — the coverage arrived — is shown whole.
        this.sx.setDomain([placing.frame.gc0, placing.frame.gc1])
        this.sy.setDomain([placing.frame.log0, placing.frame.log1])
        this.fitted = true
      }
    }
    this.indexOf = new Map((shown?.genomes ?? []).map((genome, g) => [genome.id, g]))
    this.members = shown === null ? null : membersOf(shown.genomeOf, shown.genomes.length)
    this.centroids = new Map()
    this.replan(false)
    const view = this.view
    this.element.dataset.view = view
    this.element.dataset.ready = String(view === 'gc-coverage' || view === 'no-gc')
    this.paintHead()
    this.paintNote()
    this.marksDirty = true
    this.refreshHover()
    this.schedule()
  }

  /** Where the contigs go for this GC and coverage: the one held while they are the same. */
  private placingFor(gc: Float64Array | null, coverage: Float64Array | null): Placing | null {
    const held = this.placing
    if (held !== null && held.gc === gc && held.coverage === coverage) return held
    if (gc === null) return null
    const contigs: number[] = []
    const bare = new Uint8Array(gc.length)
    let bareCount = 0
    for (let c = 0; c < gc.length; c++) {
      if (!Number.isFinite(gc[c])) continue
      contigs.push(c)
      if (coverage === null || !(coverage[c] > 0)) {
        bare[c] = 1
        bareCount++
      }
    }
    if (contigs.length === 0) return null
    const frame = scatterFrame(gc, coverage ?? [], contigs, FRAME_TAIL)
    const pinned = pinToFrame(frame, gc, coverage ?? [], contigs)
    return {
      gc,
      coverage,
      mode: coverage === null ? 'gc' : 'gc-coverage',
      contigs: Int32Array.from(contigs),
      bare,
      bareCount,
      unplaced: gc.length - contigs.length,
      frame,
      held: { gc: pinned.gc, coverage: coverage === null ? null : pinned.coverage },
      pin: pinned.pin,
      pinned: pinned.count,
    }
  }

  /** The dots' painting for the binning drawn and the selection: then the dots and the marks again. */
  private replan(paint = true): void {
    this.plan = this.planFor(this.ctx.model.shown)
    this.grid = null
    this.dotsDirty = true
    this.marksDirty = true
    this.handDirty = true
    if (paint) {
      this.refreshHover()
      this.schedule()
    }
  }

  /**
   * The base layer's order: the pool first, faint; then every genome's dots
   * by size, the smallest first, a genome's dots of one size one batch — the
   * selected genomes' after the rest, full, the rest faded while anything is
   * selected; the selected contigs last, over everything, ringed.
   */
  private planFor(shown: CurationStateResult | null): Plan | null {
    const placing = this.placing
    if (shown === null || placing === null) return null
    const model = this.ctx.model
    const selection = model.selection
    const any = selection.genomes.length > 0 || selection.contigs.length > 0
    const G = shown.genomes.length
    // The genomes in the stage's order: a batch keeps its place whatever a step makes.
    const at = new Map(model.order.map((id, k) => [id, k]))
    const byOrder = Array.from({ length: G }, (_, g) => g).sort((a, b) => (at.get(shown.genomes[a].id) ?? Number.MAX_SAFE_INTEGER) - (at.get(shown.genomes[b].id) ?? Number.MAX_SAFE_INTEGER) || a - b)
    const slot = new Int32Array(G)
    byOrder.forEach((g, k) => (slot[g] = k))
    const chosenIds = new Set(selection.genomes)
    const emphasised = new Uint8Array(G)
    shown.genomes.forEach((genome, g) => {
      if (chosenIds.has(genome.id)) emphasised[g] = 1
    })
    // A counting sort on (layer, size, genome): the pool, the rest, the selected genomes.
    const classes = 7
    const keys = 1 + 2 * classes * G
    const keyOf = (c: number): number => {
      const g = shown.genomeOf[c] ?? -1
      if (g < 0 || g >= G) return 0
      const size = Math.min(classes, Math.max(1, Math.round(this.radius[c] ?? 1))) - 1
      return 1 + emphasised[g] * classes * G + size * G + slot[g]
    }
    const counts = new Int32Array(keys + 1)
    const contigs = placing.contigs
    for (let k = 0; k < contigs.length; k++) counts[keyOf(contigs[k]) + 1]++
    for (let k = 0; k < keys; k++) counts[k + 1] += counts[k]
    const order = new Int32Array(contigs.length)
    const fill = counts.slice(0, keys)
    for (let k = 0; k < contigs.length; k++) {
      const c = contigs[k]
      order[fill[keyOf(c)]++] = c
    }
    const runs: Plan['runs'] = []
    const colours = shown.genomes.map((genome) => this.ctx.colourOf(genome.id).css)
    for (let key = 0; key < keys; key++) {
      const from = counts[key]
      const to = counts[key + 1]
      if (to <= from) continue
      if (key === 0) {
        runs.push({ from, to, colour: this.ctx.poolColour.css, alpha: any ? POOL_FADED : POOL_REST, faded: any })
        continue
      }
      const g = shown.genomeOf[order[from]]
      const chosen = emphasised[g] === 1
      runs.push({ from, to, colour: colours[g], alpha: chosen ? ALPHA_CHOSEN : any ? ALPHA_FADED : ALPHA_REST, faded: any && !chosen })
    }
    const n = placing.gc.length
    const rank = new Int32Array(n).fill(-1)
    order.forEach((c, k) => (rank[c] = k))
    const chosenMask = new Uint8Array(n)
    const placedChosen = selection.contigs.filter((c) => c >= 0 && c < n && Number.isFinite(placing.gc[c]))
    const chosen = drawOrder(this.ctx.data.file.lengths, placedChosen)
    chosen.forEach((c, k) => {
      rank[c] = order.length + k
      chosenMask[c] = 1
    })
    // What the offered suggestions would bring into the selected genomes, and each contig's surest.
    const answer = model.answer
    const offered = new Map<number, Suggestion>()
    const candidates = new Set<number>()
    if (answer !== null) {
      for (const s of model.offered()) {
        if (s.kind !== 'recruit' && s.kind !== 'move') continue
        const target = answer.genomes[s.genomes[0] ?? -1]?.id
        for (const c of s.contigs) {
          const held = offered.get(c)
          if (held === undefined || s.confidence > held.confidence) offered.set(c, s)
          if (target !== undefined && chosenIds.has(target) && Number.isFinite(placing.gc[c] ?? Number.NaN)) candidates.add(c)
        }
      }
    }
    return { shown, order, runs, rank, chosen, chosenMask, candidates: Int32Array.from(candidates), offered }
  }

  /** The readout and the hand again for a pointer at rest: what is under it may have changed. */
  private refreshHover(): void {
    if (this.pointer === null || this.press !== null || this.ctx.dragging !== null || !this.large) return
    this.hoverAt(this.pointer.x, this.pointer.y)
  }

  // -------------------------------------------------------------------------
  // The view.
  // -------------------------------------------------------------------------

  /** The frame drawn: the view, large; every contig, small. */
  private viewFrame(): ScatterFrame | null {
    const placing = this.placing
    if (placing === null) return null
    if (!this.large) return placing.frame
    const [gc0, gc1] = this.sx.domain
    const [log0, log1] = this.sy.domain
    return { gc0, gc1, log0, log1, floor: placing.frame.floor }
  }

  /** Zoom about a point of the plot: `factor` above 1 in, below 1 out. */
  private zoomAt(x: number, y: number, factor: number): void {
    const placing = this.placing
    if (placing === null || !this.large) return
    const { x: mx, y: my, w, h } = this.main
    this.sx.zoomAt(Math.max(0, Math.min(w, x - mx)), factor)
    if (placing.mode === 'gc-coverage' && h > 0) this.sy.zoomAt(Math.max(0, Math.min(h, my + h - y)), factor)
    this.clampView()
    this.viewChanged()
  }

  private panBy(dx: number, dy: number): void {
    const placing = this.placing
    if (placing === null || !this.large) return
    this.sx.panByPixels(dx)
    if (placing.mode === 'gc-coverage') this.sy.panByPixels(-dy)
    this.clampView()
    this.viewChanged()
  }

  private clampView(): void {
    const frame = this.placing?.frame
    if (frame === undefined) return
    clampAxis(this.sx, frame.gc0, frame.gc1, LEAST_GC)
    clampAxis(this.sy, frame.log0, frame.log1, LEAST_LOG)
  }

  private viewChanged(): void {
    const frame = this.placing?.frame
    const whole = (scale: Scale, lo: number, hi: number): boolean => scale.domain[0] <= lo + 1e-9 && scale.domain[1] >= hi - 1e-9
    this.fitted = frame === undefined || (whole(this.sx, frame.gc0, frame.gc1) && (this.placing?.mode === 'gc' || whole(this.sy, frame.log0, frame.log1)))
    this.element.dataset.zoom = this.fitted ? 'fit' : 'zoomed'
    this.placesDirty = true
    this.dotsDirty = true
    this.marksDirty = true
    this.handDirty = true
    this.grid = null
    this.schedule()
  }

  /** What a pane asked every pane to show: brought into the view where it is out of it, at the same zoom if it fits. */
  private frameOn(target: CurateFrame): void {
    const placing = this.placing
    if (this.disposed || placing === null || !this.large || this.fitted) return
    const wanted = new Set<number>()
    for (const c of target.contigs ?? []) wanted.add(c)
    const members = this.members
    if (members !== null) {
      for (const id of target.genomes ?? []) {
        const g = this.indexOf.get(id)
        if (g === undefined) continue
        for (let k = members.offsets[g]; k < members.offsets[g + 1]; k++) wanted.add(members.contigs[k])
      }
    }
    let gc0 = Number.POSITIVE_INFINITY
    let gc1 = Number.NEGATIVE_INFINITY
    let log0 = Number.POSITIVE_INFINITY
    let log1 = Number.NEGATIVE_INFINITY
    // Where they are drawn: a contig pinned to the frame's edge, at the edge.
    const held = placing.held
    for (const c of wanted) {
      const gc = held.gc[c]
      if (!Number.isFinite(gc)) continue
      gc0 = Math.min(gc0, gc)
      gc1 = Math.max(gc1, gc)
      if (placing.bare[c] === 0 && held.coverage !== null) {
        const log = Math.log10(held.coverage[c])
        log0 = Math.min(log0, log)
        log1 = Math.max(log1, log)
      }
    }
    if (!Number.isFinite(gc0)) return
    const [x0, x1] = this.sx.domain
    const [y0, y1] = this.sy.domain
    const insideX = gc0 >= x0 && gc1 <= x1
    const insideY = !Number.isFinite(log0) || (log0 >= y0 && log1 <= y1)
    if (insideX && insideY) return
    const centre = (lo: number, hi: number, span: number, least: number): [number, number] => {
      const wide = Math.max(span, (hi - lo) * 1.3, least)
      const middle = (lo + hi) / 2
      return [middle - wide / 2, middle + wide / 2]
    }
    if (!insideX) this.sx.setDomain(centre(gc0, gc1, x1 - x0, LEAST_GC))
    if (!insideY) this.sy.setDomain(centre(log0, log1, y1 - y0, LEAST_LOG))
    this.clampView()
    this.viewChanged()
  }

  // -------------------------------------------------------------------------
  // Layout, and the dots placed through the view.
  // -------------------------------------------------------------------------

  private font(weight = ''): string {
    const base = scaleFont(this.ctx.ink().font)
    return weight === '' ? base : `${weight} ${base}`
  }

  /** A line of the axes' text, in CSS pixels. */
  private lineHeight(): number {
    const match = /(\d+(?:\.\d+)?)px/.exec(this.font())
    return Math.ceil((match === null ? 10 : Number(match[1])) * 1.3)
  }

  /** The room the coverage axis's labels take: the widest it can print at any zoom inside the frame, in either notation. */
  private labelRoom(): number {
    const g = this.dots.getContext('2d')
    if (g === null) return 34
    g.font = this.font()
    const placing = this.placing
    const texts = ['none']
    if (placing?.mode === 'gc-coverage') {
      // Every value a tick can take, as the whole axis spells it and as one alone would.
      const values = ladder(placing.frame, [1, 2, 3, 4, 5, 6, 7, 8, 9])
      texts.push(...coverageTickTexts(values))
      for (const value of values) texts.push(...coverageTickTexts([value]))
    }
    let widest = 0
    for (const text of texts) widest = Math.max(widest, g.measureText(text).width)
    return Math.ceil(widest)
  }

  private layout(): void {
    this.layoutDirty = false
    const rect = this.plot.getBoundingClientRect()
    const width = Math.max(0, Math.floor(rect.width))
    const height = Math.max(0, Math.floor(rect.height))
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    this.box = { width, height }
    for (const canvas of [this.dots, this.marks, this.hand]) {
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.width = Math.round(width * this.dpr)
      canvas.height = Math.round(height * this.dpr)
    }
    const placing = this.placing
    const band = placing?.mode === 'gc'
    const bare = placing?.bareCount ?? 0
    if (this.large) {
      const line = this.lineHeight()
      const below = TICK + TICK_GAP + line + 4 + line + 6
      const left = band ? PAD_LEFT_BAND : 8 + line + 6 + this.labelRoom() + TICK_GAP + TICK
      const w = Math.max(0, width - left - PAD_RIGHT)
      const room = Math.max(0, height - PAD_TOP - below)
      if (band) {
        const h = Math.min(room, Math.min(BAND_MOST, Math.max(BAND_LEAST, Math.round(room * 0.45))))
        const y = PAD_TOP + Math.max(0, Math.round((room - h) / 2))
        this.main = { x: left, y, w, h: 0 }
        this.strip = { y, h }
      } else {
        const strip = bare > 0 ? STRIP : 0
        const gap = bare > 0 ? STRIP_GAP : 0
        const h = Math.max(0, room - strip - gap)
        this.main = { x: left, y: PAD_TOP, w, h }
        this.strip = bare > 0 ? { y: PAD_TOP + h + gap, h: strip } : null
      }
    } else {
      const w = Math.max(0, width - 2 * PAD_SMALL)
      const room = Math.max(0, height - 2 * PAD_SMALL)
      if (band) {
        const h = Math.min(room, Math.max(12, Math.round(room * 0.5)))
        const y = PAD_SMALL + Math.round((room - h) / 2)
        this.main = { x: PAD_SMALL, y, w, h: 0 }
        this.strip = { y, h }
      } else {
        const strip = bare > 0 ? STRIP_SMALL : 0
        const gap = bare > 0 ? STRIP_GAP_SMALL : 0
        const h = Math.max(0, room - strip - gap)
        this.main = { x: PAD_SMALL, y: PAD_SMALL, w, h }
        this.strip = bare > 0 ? { y: PAD_SMALL + h + gap, h: strip } : null
      }
    }
    this.sx.setPixels(Math.max(1, this.main.w))
    this.sy.setPixels(Math.max(1, this.main.h))
    this.placesDirty = true
    this.dotsDirty = true
    this.marksDirty = true
    this.handDirty = true
    // The head is as wide as the plot, and its words as large as the text scale.
    this.headDirty = true
    this.paintNote()
  }

  /**
   * Short of room, whole pieces of the head give way — the sizes, then the
   * strip's count, then the hint's `drag to`, then the hint — and no word is
   * cut: measured, not set by thresholds, since the reader's text scale grows
   * the words and not the buttons, and a count's length moves what fits.
   */
  private fitHead(): void {
    this.headDirty = false
    for (const piece of this.yielding) piece.classList.remove('hidden')
    const head = this.head
    if (!this.large || head.clientWidth === 0) return
    const cut = (node: HTMLElement): boolean => node.scrollWidth > node.clientWidth
    for (const piece of this.yielding) {
      if (!cut(head) && !cut(this.countsNode) && !cut(this.bareNode)) return
      piece.classList.add('hidden')
    }
  }

  /** The foot of the plot: the strip's, or the main plot's. */
  private foot(): number {
    return this.strip === null ? this.main.y + this.main.h : this.strip.y + this.strip.h
  }

  /** Every contig's dot through the view, the ones in it, and the ticks. */
  private place(): void {
    this.placesDirty = false
    this.grid = null
    const placing = this.placing
    const view = this.viewFrame()
    const { x: mx, y: my, w, h } = this.main
    if (placing === null || view === null || w <= 0) {
      this.places = null
      this.inView = new Uint8Array(0)
      this.visible = new Int32Array(0)
      this.ticks = { gc: [], coverage: [] }
      return
    }
    const places = scatterPlaces(view, placing.held.gc, placing.held.coverage ?? [], w, Math.max(h, 1))
    const inView = new Uint8Array(placing.gc.length)
    const visible: number[] = []
    const strip = this.strip
    for (let k = 0; k < placing.contigs.length; k++) {
      const c = placing.contigs[k]
      const r = this.sizeOf(c)
      const pin = placing.pin[c]
      // A contig pinned to the frame's edge: its wedge inside it, its tip on it.
      const [ux, uy] = pin === 0 ? [0, 0] : pinVector(pin)
      const x = places.x[c] + mx - ux * r
      let y: number
      let inY: boolean
      if (placing.bare[c] === 1 && strip !== null) {
        const pad = Math.min(strip.h / 2, r + 1)
        y = strip.y + pad + jitter(c) * Math.max(0, strip.h - 2 * pad)
        inY = true
      } else {
        y = places.y[c] + my - uy * r
        inY = y + r >= my && y - r <= my + h
      }
      places.x[c] = x
      places.y[c] = y
      if (inY && x + r >= mx && x - r <= mx + w) {
        inView[c] = 1
        visible.push(c)
      }
    }
    this.places = places
    this.inView = inView
    this.visible = Int32Array.from(visible)
    this.ticks = this.large ? { gc: gcTicksIn(view, w), coverage: placing.mode === 'gc-coverage' ? coverageTicksIn(view, h) : [] } : { gc: [], coverage: [] }
  }

  /** The dot under a point, the one on top; `-1` for none. */
  private dotAt(x: number, y: number): number {
    if (this.layoutDirty) this.layout()
    if (this.placesDirty) this.place()
    const places = this.places
    const plan = this.plan
    if (places === null || plan === null) return -1
    const { x: mx, y: my, w } = this.main
    if (x < mx - 4 || x > mx + w + 4 || y < my - 4 || y > this.foot() + 4) return -1
    this.grid ??= new DotGrid(places, this.visible, 16, this.box.width + 64)
    return this.grid.at(
      x,
      y,
      (c) => this.sizeOf(c),
      (c) => plan.rank[c],
      2,
    )
  }

  /** A point of the plot in the data: its GC, and the log of its coverage (`null` in the strip). */
  private dataAt(x: number, y: number): { gc: number; log: number | null; where: 'main' | 'strip' } | null {
    const view = this.viewFrame()
    const placing = this.placing
    if (view === null || placing === null) return null
    const { x: mx, y: my, w, h } = this.main
    if (x < mx || x > mx + w) return null
    const gc = view.gc0 + ((x - mx) / w) * (view.gc1 - view.gc0)
    const strip = this.strip
    if (strip !== null && y >= strip.y - STRIP_GAP / 2 && y <= strip.y + strip.h) return { gc, log: null, where: 'strip' }
    if (placing.mode !== 'gc-coverage' || y < my || y > my + h) return null
    return { gc, log: view.log0 + ((my + h - y) / h) * (view.log1 - view.log0), where: 'main' }
  }

  /** A GC in the data to a pixel across the plot, at the view drawn. */
  private X(gc: number, view: ScatterFrame): number {
    return this.main.x + ((gc - view.gc0) / (view.gc1 - view.gc0)) * this.main.w
  }

  /** A log of the coverage to a pixel up the plot, at the view drawn. */
  private Y(log: number, view: ScatterFrame): number {
    return this.main.y + this.main.h - ((log - view.log0) / (view.log1 - view.log0)) * this.main.h
  }

  /** A crisp hairline's place: the middle of a device pixel. */
  private hair(v: number): number {
    return (Math.floor(v * this.dpr) + 0.5) / this.dpr
  }

  // -------------------------------------------------------------------------
  // Drawing.
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.disposed || this.frameId !== 0) return
    this.frameId = requestAnimationFrame(() => {
      this.frameId = 0
      this.draw()
    })
  }

  private draw(): void {
    if (this.disposed) return
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    if (dpr !== this.dpr) this.layoutDirty = true
    if (this.layoutDirty) this.layout()
    if (this.headDirty) this.fitHead()
    if (this.placesDirty) this.place()
    if (this.liveDirty) this.relive()
    if (this.dotsDirty) this.paintDots()
    if (this.marksDirty) this.paintMarks()
    if (this.handDirty) this.paintHand()
  }

  /** Clip to the plot: the main area and the strip, a little past them for a big dot's edge. */
  private clip(g: CanvasRenderingContext2D): void {
    const { x, y, w, h } = this.main
    g.beginPath()
    if (h > 0) g.rect(x - 1, y - 1, w + 2, h + 2)
    if (this.strip !== null) g.rect(x - 1, this.strip.y - 3, w + 2, this.strip.h + 6)
    g.clip()
  }

  /** A dot's disc on the path: a square, as large, where it is too small to be round. */
  private dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, squares: boolean): void {
    if (r * this.dpr < (squares ? 3 : 1.6)) {
      const half = r * 0.886
      g.rect(x - half, y - half, 2 * half, 2 * half)
      return
    }
    g.moveTo(x + r, y)
    g.arc(x, y, r, 0, TAU)
  }

  /** A ring round a dot, on the path. */
  private ring(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    g.moveTo(x + r, y)
    g.arc(x, y, r, 0, TAU)
  }

  /**
   * A pinned contig's wedge on the path: a triangle about its place, `r` from
   * its middle to each corner, its tip out past the edges it is pinned to.
   */
  private wedge(g: CanvasRenderingContext2D, x: number, y: number, r: number, pin: number): void {
    const [ux, uy] = pinVector(pin)
    const cos = -0.5
    const sin = Math.sqrt(3) / 2
    g.moveTo(x + ux * r, y + uy * r)
    g.lineTo(x + (ux * cos - uy * sin) * r, y + (ux * sin + uy * cos) * r)
    g.lineTo(x + (ux * cos + uy * sin) * r, y + (-ux * sin + uy * cos) * r)
    g.closePath()
  }

  /** A contig's dot's radius, or its wedge's where it is pinned, at the size drawn. */
  private sizeOf(c: number): number {
    const scale = this.large ? 1 : SMALL_SCALE
    const r = this.radius[c] ?? 1
    return (this.placing?.pin[c] ?? 0) === 0 ? r * scale : Math.max(WEDGE_LEAST, r * WEDGE_GROW) * scale
  }

  /** A contig's mark on the path, `out` pixels past its edge: its disc, or its wedge where it is pinned — a wedge's sides as far out as a disc's rim. */
  private shape(g: CanvasRenderingContext2D, c: number, x: number, y: number, out = 0): void {
    const pin = this.placing?.pin[c] ?? 0
    if (pin === 0) this.ring(g, x, y, this.sizeOf(c) + out)
    else this.wedge(g, x, y, this.sizeOf(c) + 2 * out, pin)
  }

  /** Stroke the path held over a halo of the background, so it reads over the densest cloud. */
  private haloStroke(g: CanvasRenderingContext2D, ink: StageInk, colour: string, width: number, halo = 2.5, dash: number[] = []): void {
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.setLineDash([])
    g.globalAlpha = 0.8
    g.strokeStyle = ink.background
    g.lineWidth = width + halo
    g.stroke()
    g.globalAlpha = 1
    g.strokeStyle = colour
    g.lineWidth = width
    g.setLineDash(dash)
    g.stroke()
    g.setLineDash([])
  }

  private colourOf(shown: CurationStateResult, c: number): string {
    const g = shown.genomeOf[c] ?? -1
    return g < 0 ? this.ctx.poolColour.css : this.ctx.colourOf(shown.genomes[g].id).css
  }

  /**
   * Contigs lifted over the rest, each on a rim of the accent over a halo of
   * the background, then in its own colour: one dot is ringed, a thousand
   * together are a shape edged in the accent whose genomes still show.
   */
  private rimmed(g: CanvasRenderingContext2D, ink: StageInk, shown: CurationStateResult, contigs: readonly number[], rim: number, halo: number, rimAlpha = 1): void {
    const places = this.places
    if (places === null || contigs.length === 0) return
    if (halo > 0) {
      g.globalAlpha = 0.9
      g.fillStyle = ink.background
      g.beginPath()
      for (const c of contigs) this.shape(g, c, places.x[c], places.y[c], rim + halo)
      g.fill()
    }
    g.globalAlpha = rimAlpha
    g.fillStyle = ink.accent
    g.beginPath()
    for (const c of contigs) this.shape(g, c, places.x[c], places.y[c], rim)
    g.fill()
    const byColour = new Map<string, number[]>()
    for (const c of contigs) {
      const colour = this.colourOf(shown, c)
      const list = byColour.get(colour)
      if (list === undefined) byColour.set(colour, [c])
      else list.push(c)
    }
    g.globalAlpha = 1
    for (const [colour, list] of byColour) {
      g.fillStyle = colour
      g.beginPath()
      for (const c of list) this.shape(g, c, places.x[c], places.y[c])
      g.fill()
    }
  }

  /** A genome's dots lifted over the rest: a halo, its colour full, an outline — the ink's for the genome lit, the accent's for a question's. */
  private lifted(g: CanvasRenderingContext2D, ink: StageInk, contigs: readonly number[], colour: string, outline: string, outlineAlpha: number, width: number): void {
    const places = this.places
    if (places === null || contigs.length === 0) return
    g.beginPath()
    for (const c of contigs) this.shape(g, c, places.x[c], places.y[c])
    g.globalAlpha = 0.9
    g.strokeStyle = ink.background
    g.lineWidth = 2.5
    g.setLineDash([])
    g.stroke()
    g.globalAlpha = 1
    g.fillStyle = colour
    g.fill()
    g.globalAlpha = outlineAlpha
    g.strokeStyle = outline
    g.lineWidth = width
    g.stroke()
    g.globalAlpha = 1
  }

  // --- The dots ---------------------------------------------------------------

  private paintDots(): void {
    this.dotsDirty = false
    // Written again by the axes, where they are painted.
    this.dots.dataset.coverageTicks = ''
    const g = this.dots.getContext('2d')
    if (g !== null) {
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalAlpha = 1
      g.clearRect(0, 0, this.dots.width, this.dots.height)
    }
    let full = 0
    let faded = 0
    let ringed = 0
    let wedges = 0
    const places = this.places
    const plan = this.plan
    const view = this.viewFrame()
    if (places !== null && plan !== null && view !== null) {
      const ink = this.ctx.ink()
      const scale = this.large ? 1 : SMALL_SCALE
      const squares = this.visible.length > SQUARES_FROM
      if (g !== null) {
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        this.paintGrid(g, ink, view)
        g.save()
        this.clip(g)
      }
      const inView = this.inView
      const pin = this.placing?.pin
      for (const run of plan.runs) {
        if (g !== null) {
          g.globalAlpha = run.alpha
          g.fillStyle = run.colour
          g.beginPath()
        }
        let drawn = 0
        for (let k = run.from; k < run.to; k++) {
          const c = plan.order[k]
          if (inView[c] !== 1) continue
          drawn++
          const pinned = pin?.[c] ?? 0
          if (pinned !== 0) wedges++
          if (g === null) continue
          if (pinned === 0) this.dot(g, places.x[c], places.y[c], this.radius[c] * scale, squares)
          else this.wedge(g, places.x[c], places.y[c], this.sizeOf(c), pinned)
        }
        if (run.faded) faded += drawn
        else full += drawn
        if (g !== null && drawn > 0) g.fill()
      }
      // The selected contigs over everything, in their colour, on the accent's rim.
      const chosen = Array.from(plan.chosen).filter((c) => inView[c] === 1)
      ringed = chosen.length
      if (g !== null) this.rimmed(g, ink, plan.shown, chosen, this.large ? 1.5 : 1, this.large ? 1.5 : 1)
      if (g !== null) {
        g.restore()
        g.globalAlpha = 1
        if (this.large) this.paintAxes(g, ink, view)
      }
    }
    this.dots.dataset.full = String(full)
    this.dots.dataset.faded = String(faded)
    this.dots.dataset.ringed = String(ringed)
    this.dots.dataset.wedges = String(wedges)
  }

  /** The grid at the ticks, and the strip's band: under the dots. */
  private paintGrid(g: CanvasRenderingContext2D, ink: StageInk, view: ScatterFrame): void {
    const { x, y, w, h } = this.main
    const strip = this.strip
    g.save()
    if (strip !== null) {
      g.globalAlpha = 0.055
      g.fillStyle = ink.text
      g.fillRect(x, strip.y, w, strip.h)
    }
    if (!this.large) {
      g.restore()
      return
    }
    const top = h > 0 ? y : (strip?.y ?? y)
    const bottom = this.foot()
    g.globalAlpha = 0.24
    g.strokeStyle = ink.faint
    g.lineWidth = 1 / this.dpr
    g.beginPath()
    for (const tick of this.ticks.gc) {
      const px = this.X(tick, view)
      if (px < x - 0.5 || px > x + w + 0.5) continue
      const at = this.hair(px)
      g.moveTo(at, top)
      g.lineTo(at, bottom)
    }
    if (h > 0) {
      for (const tick of this.ticks.coverage) {
        const py = this.Y(Math.log10(tick), view)
        if (py < y - 0.5 || py > y + h + 0.5) continue
        const at = this.hair(py)
        g.moveTo(x, at)
        g.lineTo(x + w, at)
      }
    }
    g.stroke()
    g.restore()
  }

  /** The axes: their rules, ticks and labels, the strip's word, and each axis's title. */
  private paintAxes(g: CanvasRenderingContext2D, ink: StageInk, view: ScatterFrame): void {
    const placing = this.placing
    if (placing === null) return
    const { x, y, w, h } = this.main
    const strip = this.strip
    const foot = this.hair(this.foot())
    const line = this.lineHeight()
    const font = this.font()
    g.save()
    g.lineWidth = 1 / this.dpr
    g.strokeStyle = ink.faint
    g.globalAlpha = 0.9
    g.beginPath()
    // The rules: along the foot, and up the coverage axis.
    g.moveTo(x, foot)
    g.lineTo(x + w, foot)
    const left = this.hair(x)
    if (h > 0) {
      g.moveTo(left, y)
      g.lineTo(left, y + h)
    }
    if (strip !== null && h > 0) {
      g.moveTo(left, strip.y)
      g.lineTo(left, strip.y + strip.h)
    }
    // The ticks.
    const gcAt: Array<[number, number]> = []
    for (const tick of this.ticks.gc) {
      const px = this.X(tick, view)
      if (px < x - 0.5 || px > x + w + 0.5) continue
      const at = this.hair(px)
      g.moveTo(at, foot)
      g.lineTo(at, foot + TICK)
      gcAt.push([tick, px])
    }
    const coverageAt: Array<[number, number]> = []
    if (h > 0) {
      for (const tick of this.ticks.coverage) {
        const py = this.Y(Math.log10(tick), view)
        if (py < y - 0.5 || py > y + h + 0.5) continue
        const at = this.hair(py)
        g.moveTo(x - TICK, at)
        g.lineTo(x, at)
        coverageAt.push([tick, py])
      }
    }
    g.stroke()
    // The minor ticks of a decade tall enough: a log axis says so.
    const decade = h / Math.max(1e-9, view.log1 - view.log0)
    if (h > 0 && decade >= MINOR_PX) {
      g.globalAlpha = 0.55
      g.beginPath()
      for (let p = Math.floor(view.log0); p <= Math.ceil(view.log1); p++) {
        for (let m = 2; m <= 9; m++) {
          const log = p + Math.log10(m)
          if (log < view.log0 || log > view.log1) continue
          const at = this.hair(this.Y(log, view))
          g.moveTo(x - TICK / 2, at)
          g.lineTo(x, at)
        }
      }
      g.stroke()
    }
    // The labels.
    g.globalAlpha = 1
    g.font = font
    g.fillStyle = ink.dim
    g.textBaseline = 'top'
    g.textAlign = 'center'
    for (const [tick, px] of gcAt) g.fillText(gcText(tick), Math.max(x - 6, Math.min(x + w + 6, px)), foot + TICK + TICK_GAP)
    g.textBaseline = 'middle'
    g.textAlign = 'right'
    // One notation up the whole axis: `10,000` over `1,000`, never `1e4`.
    const texts = coverageTickTexts(coverageAt.map(([tick]) => tick))
    coverageAt.forEach(([, py], k) => g.fillText(texts[k], x - TICK - TICK_GAP, Math.max(y + 5, Math.min(y + h - 5, py)) + 0.5))
    // For scripts: the labels as printed, bottom to top.
    this.dots.dataset.coverageTicks = texts.join(' ')
    if (strip !== null && placing.mode === 'gc-coverage') g.fillText('none', x - TICK - TICK_GAP, strip.y + strip.h / 2 + 0.5)
    // The titles.
    g.font = this.font('600')
    g.textAlign = 'center'
    g.textBaseline = 'top'
    g.fillText('GC (%)', x + w / 2, foot + TICK + TICK_GAP + line + 3)
    if (h > 0) {
      const label = this.fitText(g, this.ctx.data.coverageLabel, h)
      if (label !== '') {
        g.translate(8 + line / 2, y + h / 2)
        g.rotate(-Math.PI / 2)
        g.textBaseline = 'middle'
        g.fillText(label, 0, 0)
      }
    }
    g.restore()
  }

  /** A label cut to a width, with an ellipsis where it was cut; `''` where not even that fits. */
  private fitText(g: CanvasRenderingContext2D, text: string, width: number): string {
    if (g.measureText(text).width <= width) return text
    let cut = text
    while (cut.length > 1 && g.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1)
    const out = `${cut}…`
    return g.measureText(out).width <= width ? out : ''
  }

  // --- The marks ----------------------------------------------------------------

  /** The question shown: the one the stage shows, else the review's current one, while it is still asked. */
  private featuredNow(): Suggestion | null {
    const model = this.ctx.model
    const s = this.featured ?? (model.mode === 'review' ? model.current : null)
    if (s === null || model.answer === null) return null
    if (model.mode === 'review' && model.current?.key === s.key) return s
    const asked = model.answer.suggestions.some((x) => x.key === s.key) || model.queue().some((q) => q.key === s.key)
    return asked ? s : null
  }

  /** A genome's middle in the data: its contigs' GC and log coverage, weighted by their length. */
  private centroidOf(g: number): { gc: number; log: number | null } | null {
    if (this.centroids.has(g)) return this.centroids.get(g) ?? null
    const placing = this.placing
    const members = this.members
    let found: { gc: number; log: number | null } | null = null
    if (placing !== null && members !== null && g >= 0 && g + 1 < members.offsets.length) {
      const lengths = this.ctx.data.file.lengths
      // Where its dots are drawn: one pinned to the frame's edge counts at the edge.
      const held = placing.held
      let weight = 0
      let gcSum = 0
      let logWeight = 0
      let logSum = 0
      for (let k = members.offsets[g]; k < members.offsets[g + 1]; k++) {
        const c = members.contigs[k]
        const gc = held.gc[c]
        if (!Number.isFinite(gc)) continue
        const length = Math.max(1, lengths[c] ?? 1)
        weight += length
        gcSum += length * gc
        if (placing.bare[c] === 0 && held.coverage !== null) {
          logWeight += length
          logSum += length * Math.log10(held.coverage[c])
        }
      }
      if (weight > 0) found = { gc: gcSum / weight, log: logWeight > 0 ? logSum / logWeight : null }
    }
    this.centroids.set(g, found)
    return found
  }

  /** A genome's middle on the plot, at the view drawn. */
  private centrePoint(g: number, view: ScatterFrame): { x: number; y: number } | null {
    const centre = this.centroidOf(g)
    if (centre === null) return null
    const strip = this.strip
    const y = centre.log === null || this.placing?.mode !== 'gc-coverage' ? (strip === null ? null : strip.y + strip.h / 2) : this.Y(centre.log, view)
    return y === null ? null : { x: this.X(centre.gc, view), y }
  }

  /** The genomes of the binning drawn that a suggestion names, by its genomes' ids. */
  private shownGenomesOf(s: Suggestion): number[] {
    const answer = this.ctx.model.answer
    const out: number[] = []
    for (const g of s.genomes) {
      const id = answer?.genomes[g]?.id
      const shown = id === undefined ? undefined : this.indexOf.get(id)
      if (shown !== undefined && !out.includes(shown)) out.push(shown)
    }
    return out
  }

  private paintMarks(): void {
    this.marksDirty = false
    const g = this.marks.getContext('2d')
    if (g !== null) {
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalAlpha = 1
      g.clearRect(0, 0, this.marks.width, this.marks.height)
    }
    const model = this.ctx.model
    this.litDrawn = model.hovered.genome
    let lit = 0
    let candidates = 0
    let featuredCount = 0
    let number = 0
    const places = this.places
    const plan = this.plan
    const view = this.viewFrame()
    const members = this.members
    if (places !== null && plan !== null && view !== null && members !== null) {
      const ink = this.ctx.ink()
      const inView = this.inView
      if (g !== null) {
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        g.save()
        this.clip(g)
      }
      const shownOf = (k: number): number[] => {
        const out: number[] = []
        for (let m = members.offsets[k]; m < members.offsets[k + 1]; m++) if (inView[members.contigs[m]] === 1) out.push(members.contigs[m])
        return out
      }
      // The question shown: its genomes lifted and edged in the accent.
      const featured = this.featuredNow()
      const genomes = featured === null ? [] : this.shownGenomesOf(featured)
      if (featured !== null) number = this.numberOf(featured)
      if (g !== null) for (const k of genomes) this.lifted(g, ink, shownOf(k), this.ctx.colourOf(plan.shown.genomes[k].id).css, ink.accent, 0.9, 0.85)
      // The genome lit in every pane: its dots lifted, full, outlined in the ink.
      const litIndex = this.litDrawn === null ? undefined : this.indexOf.get(this.litDrawn)
      if (litIndex !== undefined) {
        const litDots = shownOf(litIndex)
        lit = litDots.length
        if (g !== null) this.lifted(g, ink, litDots, this.ctx.colourOf(plan.shown.genomes[litIndex].id).css, ink.text, 0.6, 0.75)
      }
      // What an offered suggestion would bring into a selected genome: dashed rings.
      if (this.large) {
        if (g !== null) g.beginPath()
        for (const c of plan.candidates) {
          if (inView[c] !== 1 || plan.chosenMask[c] === 1) continue
          candidates++
          if (g !== null) this.shape(g, c, places.x[c], places.y[c], 2.5)
        }
        if (g !== null && candidates > 0) this.haloStroke(g, ink, ink.accent, 1, 2, [2.5, 2])
      }
      // The question's contigs, on a rim thicker than the selection's.
      if (featured !== null) {
        const contigs = featured.contigs.filter((c) => inView[c] === 1)
        featuredCount = contigs.length
        if (g !== null) this.rimmed(g, ink, plan.shown, contigs, this.large ? 2.5 : 1.5, this.large ? 2 : 1)
      }
      if (g !== null) {
        g.restore()
        if (featured !== null) this.paintQuestion(g, ink, view, featured, genomes)
      }
    }
    this.marks.dataset.lit = String(lit)
    this.marks.dataset.candidates = String(candidates)
    this.marks.dataset.featured = String(featuredCount)
    this.marks.dataset.number = String(number || '')
  }

  /**
   * Where the question shown would take what it names: a cross at the
   * target's middle, a dashed line to it from each of its contigs (from each
   * other genome's middle, for a merge or a link), and its number in the
   * review's queue.
   */
  private paintQuestion(g: CanvasRenderingContext2D, ink: StageInk, view: ScatterFrame, s: Suggestion, genomes: readonly number[]): void {
    const places = this.places
    if (places === null) return
    const target = genomes.length > 0 ? this.centrePoint(genomes[0], view) : null
    const { x: mx, y: my, w } = this.main
    const inside = (p: { x: number; y: number }): boolean => p.x >= mx - 1 && p.x <= mx + w + 1 && p.y >= my - 1 && p.y <= this.foot() + 3
    g.save()
    this.clip(g)
    const from: Array<{ x: number; y: number }> = []
    if (s.kind === 'recruit' || s.kind === 'move') {
      const shown = s.contigs.filter((c) => this.inView[c] === 1)
      if (shown.length <= LINES_MOST) for (const c of shown) from.push({ x: places.x[c], y: places.y[c] })
    } else {
      for (const k of genomes.slice(1)) {
        const point = this.centrePoint(k, view)
        if (point !== null) from.push(point)
      }
      // A middle on the target's is one organism's: the target's cross says it.
      const apart = (p: { x: number; y: number }): boolean => target === null || Math.hypot(p.x - target.x, p.y - target.y) > 9
      for (const point of from) if (inside(point) && apart(point)) this.cross(g, ink, point.x, point.y, this.large ? 5 : 3.5)
    }
    if (target !== null && this.large && from.length > 0) {
      g.beginPath()
      for (const point of from) {
        g.moveTo(point.x, point.y)
        g.lineTo(target.x, target.y)
      }
      this.haloStroke(g, ink, ink.accent, 1.25, 2, [4, 3])
    }
    if (target !== null && inside(target)) this.cross(g, ink, target.x, target.y, this.large ? 6 : 4)
    g.restore()
    if (!this.large) return
    const number = this.numberOf(s)
    if (number === 0) return
    let anchor: { x: number; y: number } | null = null
    if (s.kind === 'recruit' || s.kind === 'move') {
      const shown = s.contigs.filter((c) => this.inView[c] === 1)
      if (shown.length > 0) {
        let x = 0
        let y = 0
        for (const c of shown) {
          x += places.x[c]
          y += places.y[c]
        }
        anchor = { x: x / shown.length, y: y / shown.length }
      } else anchor = target
    } else if (target !== null) {
      const other = genomes.length > 1 ? this.centrePoint(genomes[1], view) : null
      anchor = other === null ? target : { x: (target.x + other.x) / 2, y: (target.y + other.y) / 2 }
    }
    if (anchor === null || !inside(anchor)) return
    this.disc(g, ink, anchor.x + 14, anchor.y - 14, number)
  }

  /** A question's number, as the suggestions card and the review's band count it: its place in the queue, from 1; `0` for none. */
  private numberOf(s: Suggestion): number {
    return this.ctx.model.queue().findIndex((q) => q.key === s.key || q.members.some((m) => m.key === s.key)) + 1
  }

  /** A cross at a genome's middle, in the accent over a halo. */
  private cross(g: CanvasRenderingContext2D, ink: StageInk, x: number, y: number, arm: number): void {
    g.beginPath()
    g.moveTo(x - arm, y)
    g.lineTo(x + arm, y)
    g.moveTo(x, y - arm)
    g.lineTo(x, y + arm)
    this.haloStroke(g, ink, ink.accent, this.large ? 2 : 1.5, 2.5)
  }

  /** A numbered disc: the question's place in the review. */
  private disc(g: CanvasRenderingContext2D, ink: StageInk, cx: number, cy: number, number: number): void {
    g.save()
    g.font = this.font('600')
    const r = Math.max(9, g.measureText(String(number)).width / 2 + 4)
    const x = Math.max(r + 1, Math.min(this.box.width - r - 1, cx))
    const y = Math.max(r + 1, Math.min(this.box.height - r - 1, cy))
    g.globalAlpha = 1
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fillStyle = ink.accent
    g.fill()
    g.lineWidth = 1.5
    g.strokeStyle = ink.background
    g.stroke()
    g.fillStyle = ink.background
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(number), x, y + 0.5)
    g.restore()
  }

  // --- The hand -------------------------------------------------------------------

  /** The contigs the lasso drawn holds, lit and said as it is drawn: once a frame, however fast the hand. */
  private relive(): void {
    this.liveDirty = false
    const press = this.press
    if (press?.kind !== 'lasso' || !press.moved || this.places === null || this.visible.length > LIVE_MOST) {
      this.live = []
      return
    }
    this.live = this.lassoed(press)
    this.sayLasso(press, this.live)
  }

  /**
   * The contigs a lasso holds: the dots whose centre it encloses, and the dot
   * it was started on — on its edge, so a gesture that began on a dot takes it.
   */
  private lassoed(press: Extract<Press, { kind: 'lasso' }>): number[] {
    const places = this.places
    if (places === null) return []
    const inside = lassoContigs(places, press.points, this.visible)
    if (press.dot >= 0 && this.inView[press.dot] === 1 && !inside.includes(press.dot)) {
      inside.push(press.dot)
      inside.sort((a, b) => a - b)
    }
    return inside
  }

  private paintHand(): void {
    this.handDirty = false
    const hand = this.hand
    const { x, y, w, h } = this.main
    hand.dataset.plot = `${x} ${y} ${w} ${h}`
    hand.dataset.strip = this.strip === null ? '' : `${this.strip.y} ${this.strip.h}`
    const view = this.viewFrame()
    hand.dataset.domain = view === null ? '' : [view.gc0, view.gc1, view.log0, view.log1].map((v) => v.toFixed(4)).join(' ')
    hand.dataset.dots = String(this.visible.length)
    const g = hand.getContext('2d')
    if (g === null) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = 1
    g.clearRect(0, 0, hand.width, hand.height)
    const places = this.places
    if (!this.large || places === null || view === null) return
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const ink = this.ctx.ink()
    const press = this.press
    // The lasso, and what it holds.
    if (press?.kind === 'lasso' && press.moved && press.points.length >= 4) {
      const points = press.points
      g.save()
      g.beginPath()
      g.moveTo(points[0], points[1])
      for (let k = 2; k < points.length; k += 2) g.lineTo(points[k], points[k + 1])
      g.closePath()
      g.globalAlpha = 0.22
      g.fillStyle = ink.accentSoft
      g.fill()
      // What it holds, lifted on a light rim — fainter for what ⌥ would take away; past a few thousand, its count says it.
      const shown = this.plan?.shown
      if (shown !== undefined && this.live.length <= LIVE_LIFTED) this.rimmed(g, ink, shown, this.live, 1.25, 0, press.mod.alt ? 0.4 : 0.85)
      g.beginPath()
      g.moveTo(points[0], points[1])
      for (let k = 2; k < points.length; k += 2) g.lineTo(points[k], points[k + 1])
      g.closePath()
      this.haloStroke(g, ink, ink.accent, 1.5, 2.5, [5, 4])
      g.restore()
      return
    }
    // The dot under the pointer, or the contig another pane lights: ringed, and its place on both axes.
    const c = this.underPointer >= 0 ? this.underPointer : this.ctx.model.hovered.contig
    if (c < 0 || this.inView[c] !== 1) return
    const px = places.x[c]
    const py = places.y[c]
    g.save()
    g.beginPath()
    this.shape(g, c, px, py, 3)
    this.haloStroke(g, ink, ink.text, 1.5, 2.5)
    // Its place on the axes: a short rule across each, in the accent.
    const foot = this.foot()
    g.beginPath()
    g.moveTo(px, foot - 3)
    g.lineTo(px, foot + TICK + 1)
    if (this.placing?.bare[c] === 0 && h > 0) {
      g.moveTo(x - TICK - 1, py)
      g.lineTo(x + 3, py)
    }
    g.lineCap = 'round'
    g.globalAlpha = 1
    g.strokeStyle = ink.accent
    g.lineWidth = 2
    g.stroke()
    g.restore()
  }

  // --- The head and the note -------------------------------------------------------

  /** What the strip at the foot holds, in the head's words and the readout's: `without contacts`. */
  private withoutWords(): string {
    return /contact/i.test(this.ctx.data.coverageLabel) ? 'without contacts' : 'without coverage'
  }

  private paintHead(): void {
    const placing = this.placing
    const more: string[] = []
    const details: string[] = []
    if (placing !== null) {
      if (placing.mode === 'gc-coverage' && placing.bareCount > 0) {
        more.push(`${fmt.int(placing.bareCount)} ${this.withoutWords()}`)
        details.push(`${fmt.int(placing.bareCount)} ${this.withoutWords()}, drawn in the strip at the foot`)
      }
      if (placing.pinned > 0) {
        more.push(`${fmt.int(placing.pinned)} off the scale`)
        details.push(
          `${fmt.int(placing.pinned)} off the scale — the frame leaves out the ${fmt.pct(FRAME_TAIL, 1)} at either end of each axis, so a few strays do not shrink every cloud — each drawn at its edge, a wedge pointing the way it lies`,
        )
      }
      if (placing.unplaced > 0) {
        more.push(`${fmt.int(placing.unplaced)} without GC`)
        details.push(`${fmt.int(placing.unplaced)} without a GC content, which cannot be placed`)
      }
    }
    const n = placing?.contigs.length ?? 0
    const count = placing === null ? '' : `${fmt.int(n)} contig${n === 1 ? '' : 's'}`
    // A no-break space before the separator: a flex item's leading space is trimmed.
    const bare = more.map((part) => `\u00a0· ${part}`).join('')
    // Measured again only when its words change: not after every step.
    if (this.countNode.textContent !== count || this.bareNode.textContent !== bare) this.headDirty = true
    this.countNode.textContent = count
    this.bareNode.textContent = bare
    this.countsNode.setAttribute('title', details.length === 0 ? '' : `Of the map’s contigs, ${details.join('; ')}.`)
    // Nothing placed: nothing to lasso, size or zoom.
    this.element.classList.toggle('is-empty', placing === null)
  }

  private paintNote(): void {
    const view = this.view
    let text: string | null = null
    if (view === 'waiting') text = this.large ? 'weighing the binning…' : null
    else if (view === 'no-gc') {
      if (!this.large) text = 'no GC content'
      else text = this.ctx.data.gc === null ? 'This map stores no GC content for its contigs.' : 'None of this map’s contigs has a GC content.'
    } else if (view === 'gc' && this.large) text = `GC alone for now: the height, ${this.ctx.data.coverageLabel}, comes once every contact between contigs is read.`
    const note = this.note
    if (text === null) {
      note.classList.add('hidden')
      return
    }
    note.textContent = text
    note.classList.remove('hidden')
    note.classList.toggle('is-above', view === 'gc')
    if (view === 'gc' && this.strip !== null) {
      note.style.left = `${this.main.x + this.main.w / 2}px`
      note.style.top = `${Math.max(8, this.strip.y - 10)}px`
    } else {
      note.style.left = '50%'
      note.style.top = '50%'
    }
  }

  // -------------------------------------------------------------------------
  // The hand.
  // -------------------------------------------------------------------------

  private wire(): void {
    const hand = this.hand
    hand.addEventListener('pointerdown', (event) => this.pointerDown(event))
    hand.addEventListener('pointermove', (event) => this.pointerMove(event))
    hand.addEventListener('pointerup', (event) => this.pointerUp(event))
    hand.addEventListener('pointercancel', (event) => {
      this.release(event.pointerId)
      this.cancelPress()
    })
    hand.addEventListener('pointerleave', () => this.pointerLeave())
    hand.addEventListener('dblclick', (event) => this.doubleClick(event))
    hand.addEventListener('wheel', (event) => this.wheel(event), { passive: false })
    hand.addEventListener('contextmenu', (event) => {
      if (this.large) event.preventDefault()
    })
    // Space held pans: heard on the window, never taken from the stage, which
    // previews the review's step with it; left, as the stage leaves it, to a
    // field and to a focused button.
    const down = (event: KeyboardEvent): void => {
      if (event.key === ' ' && !wantsSpace(event.target)) this.setSpace(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === ' ') this.setSpace(false)
    }
    const blur = (): void => this.setSpace(false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    this.offs.push(() => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    })
  }

  private setSpace(on: boolean): void {
    if (on === this.space) return
    this.space = on
    if (this.pointer !== null) this.paintCursor(this.pointer.x, this.pointer.y, this.underPointer)
  }

  private local(event: MouseEvent): { x: number; y: number } {
    const rect = this.plot.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private capture(pointer: number): void {
    try {
      this.hand.setPointerCapture?.(pointer)
    } catch {
      // A pointer that is gone: nothing to hold.
    }
  }

  private release(pointer: number): void {
    try {
      if (this.hand.hasPointerCapture?.(pointer) === true) this.hand.releasePointerCapture(pointer)
    } catch {
      // Already let go.
    }
  }

  /** A lasso's point, kept on the plot: a lasso never takes a dot the view hides. */
  private onPlot(x: number, y: number): [number, number] {
    const { x: mx, y: my, w } = this.main
    return [Math.max(mx, Math.min(mx + w, x)), Math.max(my, Math.min(this.foot(), y))]
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.large || this.placing === null || this.ctx.model.shown === null) return
    if (event.button !== 0 && event.button !== 1) return
    if (this.ctx.dragging !== null) return
    const { x, y } = this.local(event)
    // The keys for the hand that pressed, with no keyboard's ring: `focusVisible`, which the DOM's types do not know yet.
    this.hand.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    const mod: Modifiers = { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey, alt: event.altKey }
    if (event.button === 1 || this.space) this.press = { kind: 'pan', pointer: event.pointerId, x, y }
    else {
      const dot = this.dotAt(x, y)
      const plain = !mod.meta && !mod.shift && !mod.alt
      if (dot >= 0 && plain && this.plan?.chosenMask[dot] === 1) this.press = { kind: 'carry', pointer: event.pointerId, x, y, dot, mod }
      else this.press = { kind: 'lasso', pointer: event.pointerId, x, y, dot, mod, moved: false, points: this.onPlot(x, y) }
    }
    this.capture(event.pointerId)
    event.preventDefault()
    this.paintCursor(x, y, this.underPointer)
    this.handDirty = true
    this.schedule()
  }

  private pointerMove(event: PointerEvent): void {
    const { x, y } = this.local(event)
    this.pointer = { x, y }
    if (!this.large) return
    const press = this.press
    if (press === null) {
      if (this.ctx.dragging === null) this.hoverAt(x, y)
      return
    }
    if (event.pointerId !== press.pointer) return
    switch (press.kind) {
      case 'pan':
        this.panBy(x - press.x, y - press.y)
        press.x = x
        press.y = y
        return
      case 'carry':
        if (Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        this.press = null
        this.release(press.pointer)
        this.carry(event)
        return
      case 'lasso': {
        if (!press.moved && Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        if (!press.moved) {
          press.moved = true
          this.underPointer = -1
          this.ctx.model.hover(null)
        }
        const [px, py] = this.onPlot(x, y)
        const points = press.points
        const lx = points[points.length - 2]
        const ly = points[points.length - 1]
        if (Math.hypot(px - lx, py - ly) >= LASSO_STEP) points.push(px, py)
        this.liveDirty = true
        this.handDirty = true
        this.paintCursor(x, y, -1)
        this.schedule()
        return
      }
    }
  }

  private pointerUp(event: PointerEvent): void {
    const press = this.press
    if (press === null || event.pointerId !== press.pointer) return
    this.press = null
    this.release(press.pointer)
    switch (press.kind) {
      case 'carry':
        this.click(press.dot, press.mod)
        break
      case 'lasso':
        if (press.moved) {
          // Where it was let go closes the loop.
          const { x, y } = this.local(event)
          press.points.push(...this.onPlot(x, y))
          this.applyLasso(press)
        } else this.click(press.dot, press.mod)
        break
      case 'pan':
        // The dots moved under the pointer: what is under it now, said (a
        // lasso's words stay until the hand moves on).
        this.pointer = this.local(event)
        this.refreshHover()
        break
    }
    this.live = []
    const { x, y } = this.local(event)
    this.paintCursor(x, y, this.underPointer)
    this.handDirty = true
    this.schedule()
  }

  private pointerLeave(): void {
    this.pointer = null
    this.underPointer = -1
    if (this.press === null && this.ctx.dragging === null) {
      this.ctx.model.hover(null)
      if (this.said !== null) {
        this.said = null
        this.ctx.say(null)
      }
    }
    this.handDirty = true
    this.schedule()
  }

  /** Let go of whatever the hand holds: Escape, a cancelled pointer. */
  private cancelPress(): void {
    const press = this.press
    this.press = null
    if (press !== null) this.release(press.pointer)
    this.live = []
    if (press?.kind === 'lasso' && this.said !== null) {
      this.said = null
      this.ctx.say(null)
    }
    this.handDirty = true
    this.schedule()
  }

  /** The pane made small: nothing held, nothing said, nothing lit from here. */
  private letGo(): void {
    if (this.press !== null) this.release(this.press.pointer)
    this.press = null
    this.pointer = null
    // A dot under the pointer lit its genome in every pane; a thumbnail is under no pointer.
    if (this.underPointer >= 0 && this.ctx.dragging === null) this.ctx.model.hover(null)
    this.underPointer = -1
    this.live = []
    if (this.said !== null) {
      this.said = null
      this.ctx.say(null)
    }
  }

  private doubleClick(event: MouseEvent): void {
    if (!this.large) return
    const { x, y } = this.local(event)
    if (this.dotAt(x, y) < 0) this.fit()
  }

  private wheel(event: WheelEvent): void {
    if (!this.large || this.placing === null) return
    event.preventDefault()
    const { x, y } = this.local(event)
    this.pointer = { x, y }
    if (!event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) this.panBy(-(event.shiftKey ? event.deltaY : event.deltaX), 0)
    else this.zoomAt(x, y, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002)))
    // The view moved under a still pointer: what is under it, and the readout, again.
    this.refreshHover()
  }

  private paintCursor(x: number, y: number, dot: number): void {
    let cursor = ''
    if (this.press?.kind === 'pan') cursor = 'grabbing'
    else if (this.space) cursor = 'grab'
    else if (this.press?.kind === 'lasso' && this.press.moved) cursor = 'crosshair'
    else if (dot >= 0) cursor = this.plan?.chosenMask[dot] === 1 ? 'grab' : 'pointer'
    else if (this.dataAt(x, y) !== null) cursor = 'crosshair'
    if (this.hand.dataset.cursor !== cursor) this.hand.dataset.cursor = cursor
  }

  // --- Selecting ------------------------------------------------------------------------

  /** A contig's genome in the binning as it stands, by id; `null` in the pool. */
  private genomeIdOf(c: number): string | null {
    const answer = this.ctx.model.answer
    const g = answer?.genomeOf[c] ?? -1
    return g < 0 || answer === null ? null : answer.genomes[g].id
  }

  /** A press let go where it was: on a dot its contig — a second time its genome —, on nothing nothing. */
  private click(dot: number, mod: Modifiers): void {
    const model = this.ctx.model
    if (dot < 0) {
      if (!mod.meta && !mod.shift && !mod.alt) model.clearSelection()
      return
    }
    if (mod.meta) this.changeContigs([dot], 'toggle')
    else if (mod.shift) this.changeContigs([dot], 'add')
    else if (mod.alt) this.changeContigs([dot], 'remove')
    else {
      const selection = model.selection
      const genome = this.genomeIdOf(dot)
      const alone = selection.genomes.length === 0 && selection.contigs.length === 1 && selection.contigs[0] === dot
      if (alone && genome !== null) model.selectGenomes([genome])
      else model.selectContigs([dot])
    }
  }

  /**
   * Add contigs to the selection, take them from it, or toggle them: a
   * selected genome is given up for its contigs first, so one kind is selected
   * at a time — a genome less a few of its contigs is those contigs.
   */
  private changeContigs(contigs: readonly number[], how: 'add' | 'remove' | 'toggle'): void {
    const model = this.ctx.model
    const selection = model.selection
    const answer = model.answer
    const held = new Set(selection.contigs)
    if (selection.genomes.length > 0 && answer !== null) {
      const ids = new Set(selection.genomes)
      answer.genomeOf.forEach((g, c) => {
        if (g >= 0 && ids.has(answer.genomes[g].id)) held.add(c)
      })
    }
    for (const c of contigs) {
      if (how === 'add') held.add(c)
      else if (how === 'remove') held.delete(c)
      else if (held.has(c)) held.delete(c)
      else held.add(c)
    }
    model.select({ genomes: [], contigs: [...held] })
  }

  /** A lasso let go: its contigs selected, added (⇧, ⌘) or taken away (⌥). */
  private applyLasso(press: Extract<Press, { kind: 'lasso' }>): void {
    if (this.places === null) return
    const inside = this.lassoed(press)
    if (press.mod.alt) this.changeContigs(inside, 'remove')
    else if (press.mod.shift || press.mod.meta) this.changeContigs(inside, 'add')
    else this.ctx.model.selectContigs(inside)
    this.sayLasso(press, inside, true)
  }

  /**
   * Carry the selected contigs: the stage draws them held and makes the drop's
   * step, and its readout says the drop's words — never the dot this drag left.
   */
  private carry(event: PointerEvent): void {
    const selection = this.ctx.model.selection
    if (selection.contigs.length === 0) return
    this.underPointer = -1
    this.ctx.model.hover(null)
    this.ctx.startDrag({ kind: 'contigs', contigs: [...selection.contigs] }, event)
    if (this.said !== null) {
      this.said = null
      this.ctx.say(null)
    }
    this.handDirty = true
    this.schedule()
  }

  // --- Hover and the readout ---------------------------------------------------------------

  private hoverAt(x: number, y: number): void {
    const dot = this.dotAt(x, y)
    if (dot !== this.underPointer) this.handDirty = true
    this.underPointer = dot
    this.paintCursor(x, y, dot)
    const model = this.ctx.model
    let words: string | null
    if (dot >= 0) {
      const shown = model.shown
      const g = shown?.genomeOf[dot] ?? -1
      model.hover(g < 0 || shown === null ? null : shown.genomes[g].id, dot)
      words = this.dotWords(dot)
    } else {
      model.hover(null)
      words = this.pointWords(x, y)
    }
    if (words !== this.said) {
      this.said = words
      this.ctx.say(words)
    }
    this.schedule()
  }

  /** A contig: its name, length, GC, coverage, genome, how densely it meets its own and the MAG it meets most, and what is offered. */
  private dotWords(c: number): string {
    const { file, gc, coverage, coverageLabel } = this.ctx.data
    const parts = [file.names[c] ?? `#${c}`, fmt.bp(file.lengths[c] ?? 0)]
    if (gc !== null && Number.isFinite(gc[c])) parts.push(`GC ${fmt.pct(gc[c] / 100, 1)}`)
    if (coverage !== null) parts.push(coverageWords(coverage[c], coverageLabel))
    // Its own numbers above, where it is drawn here: at the frame's edge.
    if ((this.placing?.pin[c] ?? 0) !== 0) parts.push('off the scale')
    const shown = this.ctx.model.shown
    if (shown !== null) {
      const g = shown.genomeOf[c] ?? -1
      parts.push(g < 0 || shown.genomes[g] === undefined ? 'unbinned' : `in ${this.ctx.shortName(shown.genomes[g].id)}`)
      const places = shown.contigs
      const own = places.ownAffinity[c]
      if (own !== undefined && Number.isFinite(own)) parts.push(`own affinity ${affinityText(own)}`)
      const best = places.best[c] ?? -1
      if (best >= 0 && shown.genomes[best] !== undefined) parts.push(`best ${this.ctx.shortName(shown.genomes[best].id)}, affinity ${affinityText(places.bestAffinity[c])}`)
    }
    const s = this.plan?.offered.get(c)
    if (s !== undefined) parts.push(`${s.kind} ${displayPercent(s.confidence)}%`)
    return parts.join(' · ')
  }

  /** A point of the plot with no dot: where it is, in the data, and what a drag from it does. */
  private pointWords(x: number, y: number): string | null {
    const at = this.dataAt(x, y)
    if (at === null) return null
    const parts = [`GC ${fmt.pct(at.gc / 100, 1)}`]
    if (this.placing?.mode === 'gc-coverage') parts.push(at.log === null ? this.withoutWords() : coverageWords(10 ** at.log, this.ctx.data.coverageLabel))
    parts.push('drag to lasso')
    return parts.join(' · ')
  }

  /** What a lasso holds, in words: drawn, or let go. */
  private sayLasso(press: Extract<Press, { kind: 'lasso' }>, inside: readonly number[], done = false): void {
    const { file } = this.ctx.data
    const answer = this.ctx.model.answer
    let length = 0
    let pooled = 0
    const byGenome = new Map<string, number>()
    for (const c of inside) {
      length += file.lengths[c] ?? 0
      const g = answer?.genomeOf[c] ?? -1
      if (g < 0 || answer === null) pooled++
      else byGenome.set(answer.genomes[g].id, (byGenome.get(answer.genomes[g].id) ?? 0) + 1)
    }
    const verb = press.mod.alt ? 'take away ' : press.mod.shift || press.mod.meta ? 'add ' : ''
    const n = inside.length
    const parts = [`${done ? (press.mod.alt ? 'took away ' : press.mod.shift || press.mod.meta ? 'added ' : 'selected ') : verb}${fmt.int(n)} contig${n === 1 ? '' : 's'}`]
    if (n > 0) {
      parts.push(fmt.bp(length))
      const where: string[] = []
      if (pooled > 0) where.push(`${fmt.int(pooled)} unbinned`)
      const top = [...byGenome].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      for (const [id, count] of top.slice(0, 2)) where.push(`${fmt.int(count)} in ${this.ctx.shortName(id)}`)
      if (top.length > 2) where.push(`${fmt.int(top.length - 2)} more genome${top.length - 2 === 1 ? '' : 's'}`)
      parts.push(where.join(', '))
    }
    const words = parts.join(' · ')
    if (words !== this.said) {
      this.said = words
      this.ctx.say(words)
    }
  }
}
