/**
 * A PDF page that accepts canvas drawing calls.
 *
 * The export already produced a PDF, and what was in it was one enormous
 * picture of pixels. For a contact map that is honest — a matrix *is* a raster,
 * and 12,000 chromosome bins are not paths. For a genome browser it is not:
 * every mark in that view is a rectangle, a polyline or a word, and handing a
 * journal a 300 dpi photograph of them means a figure nobody can restyle,
 * recolour or scale, in a file fifty times the size of the drawing it contains.
 *
 * So this is the same drawing, written down as drawing. It implements the slice
 * of `CanvasRenderingContext2D` the track renderers use — the list is short and
 * fixed, and `render/tracks.ts`, `render/features.ts`, `render/lane.ts` and
 * `render/browser.ts` are the only callers — and emits PDF content-stream
 * operators instead of pixels. Nothing in those modules knows: they are handed a
 * context and draw into it, which is the whole reason this is possible at all.
 *
 * Two deliberate limits, both stated rather than hidden:
 *
 * - **Text is Helvetica**, one of the fourteen fonts every PDF reader has, so
 *   nothing is embedded and the file stays small. Positions are computed from
 *   the *screen* font's metrics, because that is what the layout decisions above
 *   were made with, so a word may sit a shade narrower than its measured box.
 * - **Transforms are baked into the coordinates** rather than emitted as `cm`.
 *   Every transform this app uses is a translate, a uniform scale or a quarter
 *   turn, so a point can be transformed in JavaScript and written down in page
 *   space — which keeps the clip stack and the line widths simple enough to be
 *   obviously right.
 */

import { deflateBytes, pointsForCssPixels } from './export'
import { PRODUCER } from '../version'

/** The 2×3 affine every canvas context carries, in canvas convention. */
interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  }
}

/** The uniform scale a matrix applies, for line widths and font sizes. */
function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
}

interface State {
  matrix: Matrix
  fillStyle: string
  /** The gradient a `fill` paints with, or `null` for the flat `fillStyle`. */
  fillGradient: PageGradient | null
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
  /** The dash pattern, in CSS pixels; empty is a solid line. */
  lineDash: number[]
  /**
   * Whether a raster is smoothed where it is drawn larger than it is, and how
   * well: drawing state on a canvas, so saved and restored with the rest.
   * `true` and `'high'` together are what an image placed after them asks a
   * viewer to interpolate (see `image`).
   */
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: ImageSmoothingQuality
}

/**
 * A CSS colour as PDF's `r g b` in `[0, 1]`.
 *
 * Hex and `rgb()`/`rgba()` only, which is everything this app produces: the
 * palettes are hex literals and `getComputedStyle` normalises custom properties
 * to one of the two. Anything else comes out black, which is a visible wrong
 * answer rather than a silent one.
 */
export function pdfColour(css: string): [number, number, number] {
  const value = css.trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (hex !== null) {
    const digits = hex[1]
    const short = digits.length === 3 || digits.length === 4
    const part = (index: number): number => {
      const text = short
        ? digits[index].repeat(2)
        : digits.slice(index * 2, index * 2 + 2)
      return parseInt(text, 16) / 255
    }
    return [part(0), part(1), part(2)]
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (rgb !== null) {
    const parts = rgb[1].split(/[,/\s]+/).filter((piece) => piece !== '')
    const channel = (index: number): number => {
      const raw = parts[index] ?? '0'
      const number = Number.parseFloat(raw)
      if (!Number.isFinite(number)) return 0
      return raw.endsWith('%') ? number / 100 : number / 255
    }
    return [channel(0), channel(1), channel(2)]
  }
  return [0, 0, 0]
}

/** Size in CSS pixels and whether it is bold, out of a CSS `font` shorthand. */
export function parseFont(font: string): { size: number; bold: boolean } {
  const size = /(\d*\.?\d+)px/.exec(font)
  const weight = /(^|\s)(bold|[6-9]00)(\s|$)/i.test(font)
  return { size: size === null ? 10 : Number(size[1]), bold: weight }
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/\.?0+$/, '') : '0'
}

/**
 * The subset of a 2D context the track renderers touch.
 *
 * Enumerated by reading every `ctx.` in `render/features.ts`, `render/tracks.ts`,
 * `render/lane.ts` and `render/browser.ts`. It is deliberately not a full
 * implementation and never will be: the day a renderer reaches for something
 * outside this list, the export should fail loudly at the type level rather than
 * silently drop a mark from the figure.
 */
export type VectorTarget = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'rect'
  | 'arc'
  | 'quadraticCurveTo'
  | 'bezierCurveTo'
  | 'fill'
  | 'stroke'
  | 'clip'
  | 'fillRect'
  | 'fillText'
  | 'strokeText'
  | 'measureText'
  | 'translate'
  | 'rotate'
  | 'transform'
  | 'setTransform'
  | 'clearRect'
  | 'strokeRect'
  | 'drawImage'
  | 'imageSmoothingEnabled'
  | 'imageSmoothingQuality'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'lineJoin'
  | 'lineCap'
  | 'setLineDash'
  | 'getLineDash'
  | 'createRadialGradient'
>

/**
 * A radial gradient on the page: two circles and the colours between them,
 * in the canvas's own coordinates as they were when it was made.
 *
 * Written as a PDF **radial shading** (type 3), painted with `sh` inside the
 * path it fills, so a lit bead is a smooth sphere at any zoom rather than a
 * raster of one (`structure/painter.ts`). Colours only; a stop's alpha is
 * ignored, as a shading has none — the fill's `globalAlpha` still applies.
 */
class PageGradient {
  readonly stops: Array<{ offset: number; rgb: [number, number, number] }> = []

  constructor(readonly coords: [number, number, number, number, number, number]) {}

  addColorStop(offset: number, colour: string): void {
    if (!Number.isFinite(offset)) return
    this.stops.push({ offset: Math.max(0, Math.min(1, offset)), rgb: pdfColour(colour) })
    this.stops.sort((a, b) => a.offset - b.offset)
  }
}

/** A gradient's stops as a PDF function of one variable on `[0, 1]`. */
function shadingFunction(stops: PageGradient['stops']): string {
  const colour = (rgb: [number, number, number]): string => rgb.map(round).join(' ')
  const pieces = stops.length === 0 ? [{ offset: 0, rgb: [0, 0, 0] as [number, number, number] }] : stops
  const ramp = (from: [number, number, number], to: [number, number, number]): string =>
    `<< /FunctionType 2 /Domain [0 1] /C0 [${colour(from)}] /C1 [${colour(to)}] /N 1 >>`
  if (pieces.length === 1) return ramp(pieces[0].rgb, pieces[0].rgb)
  // A stitching function: one linear ramp between each pair of stops, the
  // stops themselves the bounds. Stops before the first offset and after the
  // last take the end colours, as a canvas does.
  const ends = [
    ...(pieces[0].offset > 0 ? [{ offset: 0, rgb: pieces[0].rgb }] : []),
    ...pieces,
    ...(pieces[pieces.length - 1].offset < 1 ? [{ offset: 1, rgb: pieces[pieces.length - 1].rgb }] : []),
  ]
  // Two stops at one offset would be a ramp of no width, which not every
  // reader takes: the later is kept, so a hard step softens to a ramp.
  for (let k = ends.length - 2; k >= 0; k--) if (ends[k].offset === ends[k + 1].offset) ends.splice(k, 1)
  if (ends.length === 1) return ramp(ends[0].rgb, ends[0].rgb)
  const functions: string[] = []
  const bounds: number[] = []
  for (let k = 0; k + 1 < ends.length; k++) {
    if (k > 0) bounds.push(ends[k].offset)
    functions.push(ramp(ends[k].rgb, ends[k + 1].rgb))
  }
  return (
    `<< /FunctionType 3 /Domain [0 1] /Functions [${functions.join(' ')}] ` +
    `/Bounds [${bounds.map(round).join(' ')}] /Encode [${functions.map(() => '0 1').join(' ')}] >>`
  )
}

/**
 * A page, and a context that draws onto it.
 *
 * Sized in CSS pixels, exactly as the canvas is; the conversion to points
 * happens once, at the end, so every number the renderers produce means the same
 * thing here as it does on screen.
 */
export class VectorPage {
  /** Hand this to a renderer. It is the context, in every sense that matters. */
  readonly ctx: CanvasRenderingContext2D

  private readonly ops: string[] = []
  private readonly stack: State[] = []
  private state: State
  /**
   * The current path, as construction operators in page space.
   *
   * Kept until `beginPath` (or `setOrigin`, which starts a sub-drawing as a
   * new canvas would), and written out again in front of every operator
   * that paints it, because this is where the two models part: a canvas's
   * `fill`, `stroke` and `clip` each *read* the current path and leave it as it
   * was, while in PDF every painting operator — `f`, `S`, the `n` after a
   * `W` — *ends* the path it paints. The path used to be written once and
   * dropped, so a shape filled and then stroked printed its fill and a bare
   * `S`: every exported box plot lost its outline, whiskers and median, the
   * reader's arrowheads printed as white halos with nothing inside, and a bar
   * track's outline and the 1D browser's chips lost their borders.
   *
   * Held in page space, because a canvas fixes a path's geometry as it is
   * built: a point is placed by the transform current when it is *added*,
   * while a stroke's width and dashes are scaled by the one current when it is
   * *stroked*. So the strings are written out again unchanged, and `setStroke`
   * works out the width at the paint. Nor is the path drawing state — a
   * canvas's `restore` does not put one back, and nor does this page's.
   */
  private path: string[] = []
  /** The current point, in page space; `null` while the path has no subpath. */
  private current: [number, number] | null = null
  /** Where the current subpath began, which is where `closePath` leaves the point. */
  private subpathStart: [number, number] | null = null
  private readonly alphas = new Map<number, string>()
  /** The radial shadings painted on this page, as `/Shn` resources, in order. */
  private readonly shadings: string[] = []
  /**
   * The rasters placed on this page, in the order they were drawn.
   *
   * A contact matrix is the one thing in this app that is honestly a raster —
   * twelve thousand bins are pixels, and writing them as a million rectangles
   * would be a larger, slower file of the same picture. So a page can hold
   * both: the matrix as an image, and every axis, label, tick, divider, lane and
   * legend around it as paths and text. That hybrid is what a journal wants and
   * what neither a pure raster nor a pure vector page can be.
   */
  private readonly images: Array<{ width: number; height: number; rgb: Uint8Array; interpolate: boolean }> = []
  private readonly ruler: CanvasRenderingContext2D | null

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.state = {
      matrix: { ...IDENTITY },
      fillStyle: '#000000',
      fillGradient: null,
      strokeStyle: '#000000',
      lineWidth: 1,
      globalAlpha: 1,
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      lineJoin: 'miter',
      lineCap: 'butt',
      lineDash: [],
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
    }
    // Measured against a real canvas, because the *layout* above this — which
    // name fits, where a label is centred — was decided with the screen's font.
    // Measuring with Helvetica instead would produce a figure laid out for a
    // font the screen never used.
    const canvas =
      typeof document === 'undefined' ? null : document.createElement('canvas')
    this.ruler = canvas?.getContext('2d') ?? null
    this.ctx = this.surface() as unknown as CanvasRenderingContext2D
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * Where a sub-drawing is being placed, in page pixels.
   *
   * Canvas has no such thing, and it is the one concept this page needs that it
   * does not borrow. The heatmap and its legend each draw *from the origin* and
   * each call `setTransform` to do it, so composing them on one canvas means
   * rendering to intermediate canvases and `drawImage`-ing those into place —
   * which is exactly right for a raster and exactly wrong here, since it would
   * turn every tick and label in the legend back into pixels. An offset the
   * absolute transform is applied *inside* lets each of them be drawn where it
   * belongs, as itself.
   */
  private originX = 0
  private originY = 0

  /**
   * Place everything drawn from now on at this offset, in CSS pixels.
   *
   * On an empty path, too, because a sub-drawing placed here is one that has
   * a canvas of its own on screen, and a canvas starts with no path. The page
   * keeps a path past a paint, as a canvas does, and `save` and `restore` do
   * not hold it — so without this the path one deck cell left behind would be
   * the next cell's, and painted there by a renderer that trusted its canvas
   * to start empty.
   */
  setOrigin(x: number, y: number): void {
    this.originX = x
    this.originY = y
    this.emptyPath()
  }

  /** Canvas point → page point. PDF's y runs up the page; canvas's runs down. */
  private point(x: number, y: number): [number, number] {
    const m = this.state.matrix
    const px = m.a * x + m.c * y + m.e + this.originX
    const py = m.b * x + m.d * y + m.f + this.originY
    return [px, this.height - py]
  }

  private emit(op: string): void {
    this.ops.push(op)
  }

  /**
   * `/GSn gs`, allocating an ExtGState the first time an alpha is seen.
   *
   * Opaque gets a state of its own rather than being skipped, because PDF's
   * alpha is graphics state and survives until something replaces it: a lane
   * drawn at 0.65 would otherwise tint every mark after it.
   */
  private alpha(): void {
    const value = Math.max(0, Math.min(1, this.state.globalAlpha))
    let name = this.alphas.get(value)
    if (name === undefined) {
      name = `GS${this.alphas.size}`
      this.alphas.set(value, name)
    }
    this.emit(`/${name} gs`)
  }

  private setFill(): void {
    const [r, g, b] = pdfColour(this.state.fillStyle)
    this.emit(`${round(r)} ${round(g)} ${round(b)} rg`)
  }

  private setStroke(): void {
    const [r, g, b] = pdfColour(this.state.strokeStyle)
    this.emit(`${round(r)} ${round(g)} ${round(b)} RG`)
    this.emit(`${round(Math.max(0.05, this.state.lineWidth * scaleOf(this.state.matrix)))} w`)
    this.emit(`${this.state.lineJoin === 'round' ? 1 : this.state.lineJoin === 'bevel' ? 2 : 0} j`)
    // Caps matter once a chart library is drawing the lines: `zrender` ends a
    // tick with a round cap and a dashed grid line with a butt one, and a page
    // that ignored the attribute would print every short segment a half-width
    // longer or shorter than the screen drew it.
    this.emit(`${this.state.lineCap === 'round' ? 1 : this.state.lineCap === 'square' ? 2 : 0} J`)
    // PDF's dash operator takes the same array the canvas does, scaled by the
    // same matrix the width is: `[] 0 d` is solid, which is what an empty
    // pattern means on a canvas too. Without this an exported figure drew the
    // alignment lane's mate threads solid, and a pair became indistinguishable
    // from a fragment in the one artefact that leaves the application.
    const dash = this.state.lineDash
    const scale = scaleOf(this.state.matrix)
    this.emit(
      dash.length === 0
        ? '[] 0 d'
        : `[${dash.map((on) => round(Math.max(0.05, on * scale))).join(' ')}] 0 d`,
    )
  }

  /** No subpath and no current point: what `beginPath` leaves, and a new canvas has. */
  private emptyPath(): void {
    this.path = []
    this.current = null
    this.subpathStart = null
  }

  /** Begin a subpath at a page-space point. */
  private startSubpath(at: [number, number]): void {
    this.path.push(`${round(at[0])} ${round(at[1])} m`)
    this.current = at
    this.subpathStart = at
  }

  /**
   * The current point, after starting a subpath at `at` if there is none.
   *
   * What a canvas does for a line or a curve drawn on an empty path, and what
   * PDF cannot: its `l` and `c` are errors with no current point to start from.
   */
  private ensureSubpath(at: [number, number]): [number, number] {
    if (this.current === null) this.startSubpath(at)
    return this.current ?? at
  }

  /**
   * A rectangle as a closed subpath of its own, in page space.
   *
   * Four corners rather than PDF's `re`, because `re` is axis-aligned in
   * *page* space and the matrix here may be a quarter turn.
   */
  private rectangle(
    x: number,
    y: number,
    w: number,
    h: number,
  ): { segments: string[]; first: [number, number] } {
    const corners = [
      this.point(x, y),
      this.point(x + w, y),
      this.point(x + w, y + h),
      this.point(x, y + h),
    ]
    const segments = corners.map(
      ([px, py], index) => `${round(px)} ${round(py)} ${index === 0 ? 'm' : 'l'}`,
    )
    segments.push('h')
    return { segments, first: corners[0] }
  }

  /**
   * A path's construction operators, in front of the operator that paints it.
   *
   * Written out at every paint and never consumed: the segments stay the
   * current path until `beginPath` (see `path`). This is also why a `q`
   * from `save` can never land inside a path object, where PDF forbids it —
   * nothing of a path reaches the stream until the operator that ends it.
   */
  private trace(segments: readonly string[]): void {
    for (const segment of segments) this.emit(segment)
  }

  /**
   * Fill a path — the current one, or the rectangle of a `fillRect` — with the
   * fill style, flat or radial.
   *
   * An empty path paints nothing, as on a canvas. Written out regardless, it
   * was a bare `f`, an operator out of place in a PDF, or a shading behind a
   * clip with no path, which a reader that drops the clip spreads over the
   * whole page.
   */
  private fillPath(segments: readonly string[], evenOdd: boolean): void {
    if (segments.length === 0) return
    this.alpha()
    const gradient = this.state.fillGradient
    if (gradient !== null) {
      // The path as a clip, the shading painted through it, and the clip gone
      // again with the `Q`. The shading is placed by the transform current
      // now, as a canvas places a gradient when it fills rather than when the
      // path was built.
      const [x0, y0, r0, x1, y1, r1] = gradient.coords
      const scale = scaleOf(this.state.matrix)
      const [ax, ay] = this.point(x0, y0)
      const [bx, by] = this.point(x1, y1)
      const name = `Sh${this.shadings.length}`
      this.shadings.push(
        `/${name} << /ShadingType 3 /ColorSpace /DeviceRGB ` +
          `/Coords [${[ax, ay, r0 * scale, bx, by, r1 * scale].map(round).join(' ')}] ` +
          `/Function ${shadingFunction(gradient.stops)} /Extend [true true] >>`,
      )
      this.emit('q')
      this.trace(segments)
      this.emit(evenOdd ? 'W* n' : 'W n')
      this.emit(`/${name} sh`)
      this.emit('Q')
      return
    }
    this.setFill()
    this.trace(segments)
    this.emit(evenOdd ? 'f*' : 'f')
  }

  /** Stroke a path — the current one, or the rectangle of a `strokeRect`. */
  private strokePath(segments: readonly string[]): void {
    if (segments.length === 0) return
    this.alpha()
    this.setStroke()
    this.trace(segments)
    this.emit('S')
  }

  // -------------------------------------------------------------------------
  // The context
  // -------------------------------------------------------------------------

  private surface(): VectorTarget {
    const self = this
    const target: VectorTarget = {
      get fillStyle(): string {
        return self.state.fillStyle
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        if (typeof value === 'string') {
          self.state.fillStyle = value
          self.state.fillGradient = null
        } else if (value instanceof PageGradient) {
          self.state.fillGradient = value
        }
      },
      get strokeStyle(): string {
        return self.state.strokeStyle
      },
      set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
        if (typeof value === 'string') self.state.strokeStyle = value
      },
      get lineWidth(): number {
        return self.state.lineWidth
      },
      set lineWidth(value: number) {
        self.state.lineWidth = value
      },
      get globalAlpha(): number {
        return self.state.globalAlpha
      },
      set globalAlpha(value: number) {
        self.state.globalAlpha = value
      },
      get font(): string {
        return self.state.font
      },
      set font(value: string) {
        self.state.font = value
      },
      get textAlign(): CanvasTextAlign {
        return self.state.textAlign
      },
      set textAlign(value: CanvasTextAlign) {
        self.state.textAlign = value
      },
      get textBaseline(): CanvasTextBaseline {
        return self.state.textBaseline
      },
      set textBaseline(value: CanvasTextBaseline) {
        self.state.textBaseline = value
      },
      get lineJoin(): CanvasLineJoin {
        return self.state.lineJoin
      },
      set lineJoin(value: CanvasLineJoin) {
        self.state.lineJoin = value
      },
      get lineCap(): CanvasLineCap {
        return self.state.lineCap
      },
      set lineCap(value: CanvasLineCap) {
        self.state.lineCap = value
      },

      // The path is not saved with the state, on a canvas or here: a path
      // built inside a `save` is still the current path after the `restore`.
      save: () => {
        self.stack.push({ ...self.state, matrix: { ...self.state.matrix } })
        self.emit('q')
      },
      restore: () => {
        // An unmatched `restore` is a no-op on a canvas and a corrupt stream in
        // a PDF, so the `Q` is emitted only when there was a `q` to match it.
        const previous = self.stack.pop()
        if (previous === undefined) return
        self.state = previous
        self.emit('Q')
      },
      // What empties the path, with `setOrigin`. A paint never does (see `path`).
      beginPath: () => {
        self.emptyPath()
      },
      closePath: () => {
        // A canvas ignores it on an empty path; PDF's `h` has no point to
        // close from and is an error.
        if (self.current === null) return
        self.path.push('h')
        // What comes next starts where this subpath did, on a canvas and after
        // PDF's `h` alike — so a curve's handles are worked out from there.
        self.current = self.subpathStart
      },
      moveTo: (x: number, y: number) => {
        self.startSubpath(self.point(x, y))
      },
      lineTo: (x: number, y: number) => {
        const to = self.point(x, y)
        // On an empty path a line is a move, as a canvas has it.
        if (self.current === null) {
          self.startSubpath(to)
          return
        }
        self.path.push(`${round(to[0])} ${round(to[1])} l`)
        self.current = to
      },
      rect: (x: number, y: number, w: number, h: number) => {
        const { segments, first } = self.rectangle(x, y, w, h)
        self.path.push(...segments)
        // Closed, and the canvas begins the next subpath at its first corner,
        // which is where PDF's `h` leaves the point too.
        self.current = first
        self.subpathStart = first
      },
      /**
       * A cubic, which PDF has natively — one operator, no conversion.
       *
       * Wanted because a chart library's SVG is cubics: every smoothed line,
       * every rounded corner and every arc `zrender` emits arrives as `C`, and
       * a page that could only take quadratics would have to approximate them
       * (`figures/svgPaint.ts`).
       */
      bezierCurveTo: (
        c1x: number,
        c1y: number,
        c2x: number,
        c2y: number,
        x: number,
        y: number,
      ) => {
        const [ax, ay] = self.point(c1x, c1y)
        // On an empty path a canvas starts the subpath at the first handle.
        self.ensureSubpath([ax, ay])
        const [bx, by] = self.point(c2x, c2y)
        const end = self.point(x, y)
        self.path.push(
          `${round(ax)} ${round(ay)} ${round(bx)} ${round(by)} ${round(end[0])} ${round(end[1])} c`,
        )
        self.current = end
      },
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
        // PDF has only cubics, so the quadratic is raised a degree — exactly,
        // which is what makes an arc in the figure the arc that was on screen.
        // Worked in page space, from the point the path is actually at: each
        // handle is two thirds of the way from its end to the control point,
        // which an affine map preserves, so a start placed under an earlier
        // transform is taken where it was put rather than re-placed.
        const control = self.point(cx, cy)
        const from = self.ensureSubpath(control)
        const end = self.point(x, y)
        const toward = (point: [number, number]): string =>
          [0, 1].map((axis) => round(point[axis] + (2 / 3) * (control[axis] - point[axis]))).join(' ')
        self.path.push(`${toward(from)} ${toward(end)} ${round(end[0])} ${round(end[1])} c`)
        self.current = end
      },
      arc: (
        x: number,
        y: number,
        radius: number,
        start: number,
        end: number,
        counter?: boolean,
      ) => {
        // As cubics, a quarter turn at most each — the standard approximation,
        // within three parts in ten thousand of the radius. It used to be 24
        // straight segments, which no one saw on a dot; a lit bead zoomed to
        // the size of a coin is a polygon at that, and a page of paths is
        // there to be zoomed.
        const sweep = counter === true ? start - end : end - start
        // A sweep of a whole turn or more is the whole circle, as the canvas
        // defines it — and the modulo below reads exactly one turn as none, which
        // drew every full circle in a figure as a path of zero length: a points
        // lane's dots and a loop's ring were on screen and not in the PDF.
        const span =
          sweep >= Math.PI * 2
            ? Math.PI * 2
            : ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const direction = counter === true ? -1 : 1
        const steps = Math.max(1, Math.ceil(span / (Math.PI / 2) - 1e-9))
        const piece = (span / steps) * direction
        // Each control point lies along the tangent at its end, this far.
        const reach = (4 / 3) * Math.tan(piece / 4) * radius
        const at = (angle: number): { x: number; y: number } => ({
          x: x + Math.cos(angle) * radius,
          y: y + Math.sin(angle) * radius,
        })
        let last = at(start)
        // A subpath of its own from the arc's start. A canvas would join it to
        // a current point with a line instead; every caller here begins an arc
        // on an empty path or at that very point, where the two are one drawing.
        self.startSubpath(self.point(last.x, last.y))
        for (let i = 0; i < steps; i++) {
          const from = start + piece * i
          const to = from + piece
          const end = at(to)
          const c1 = self.point(last.x - Math.sin(from) * reach, last.y + Math.cos(from) * reach)
          const c2 = self.point(end.x + Math.sin(to) * reach, end.y - Math.cos(to) * reach)
          const [ex, ey] = self.point(end.x, end.y)
          self.path.push(`${c1.map(round).join(' ')} ${c2.map(round).join(' ')} ${round(ex)} ${round(ey)} c`)
          last = end
        }
        self.current = self.point(last.x, last.y)
      },
      // The fill rule, when one is passed. The page has no `Path2D`, so one
      // passed in its place is not read, and the current path is filled.
      fill: (rule?: unknown) => {
        self.fillPath(self.path, rule === 'evenodd')
      },
      createRadialGradient: (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) =>
        new PageGradient([x0, y0, r0, x1, y1, r1]) as unknown as CanvasGradient,
      stroke: () => {
        self.strokePath(self.path)
      },
      setLineDash: (pattern: Iterable<number>) => {
        // Copied, and non-finite entries dropped: the canvas ignores a pattern
        // containing one, and a `NaN` reaching the operator stream is a PDF no
        // reader will open.
        self.state.lineDash = [...pattern].filter((on) => Number.isFinite(on) && on >= 0)
      },
      getLineDash: () => [...self.state.lineDash],
      clip: (rule?: unknown) => {
        // The path stays the current path, as after a paint: a clip and then a
        // fill fill the shape clipped to. An empty path clips everything away
        // on a canvas, and PDF's `W` must have a path to read, so that is a
        // rectangle of no size.
        if (self.path.length === 0) self.emit('0 0 0 0 re')
        else self.trace(self.path)
        self.emit(rule === 'evenodd' ? 'W* n' : 'W n')
      },
      // A rectangle of its own, painted without touching the current path: a
      // canvas's `fillRect` and `strokeRect` leave the path as they found it.
      // Going through `beginPath` and `rect` threw away a path the caller had
      // built and not yet painted, and left the rectangle in its place.
      fillRect: (x: number, y: number, w: number, h: number) => {
        self.fillPath(self.rectangle(x, y, w, h).segments, false)
      },
      fillText: (text: string, x: number, y: number) => self.text(text, x, y, false),
      strokeText: (text: string, x: number, y: number) => self.text(text, x, y, true),
      measureText: (text: string): TextMetrics => {
        if (self.ruler === null) {
          return { width: text.length * parseFont(self.state.font).size * 0.55 } as TextMetrics
        }
        self.ruler.font = self.state.font
        return self.ruler.measureText(text)
      },
      translate: (x: number, y: number) => {
        self.state.matrix = multiply(self.state.matrix, { a: 1, b: 0, c: 0, d: 1, e: x, f: y })
      },
      rotate: (angle: number) => {
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        self.state.matrix = multiply(self.state.matrix, {
          a: cos,
          b: sin,
          c: -sin,
          d: cos,
          e: 0,
          f: 0,
        })
      },
      /**
       * Multiply, rather than replace.
       *
       * The one canvas transform the painters above never needed, and the only
       * one an SVG replay can use: a `<g transform>` composes with whatever the
       * caller already put on the context, and `setTransform` — which throws
       * the caller's own placement away — would strand the whole figure at the
       * page origin (`figures/svgPaint.ts`).
       */
      transform: ((a: number, b: number, c: number, d: number, e: number, f: number) => {
        self.state.matrix = multiply(self.state.matrix, { a, b, c, d, e, f })
      }) as CanvasRenderingContext2D['transform'],
      setTransform: ((a: number, b: number, c: number, d: number, e: number, f: number) => {
        self.state.matrix = { a, b, c, d, e, f }
      }) as CanvasRenderingContext2D['setTransform'],
      // A page starts empty and is drawn in order, so there is nothing to clear:
      // whatever a caller is erasing has not been written yet. Accepted rather
      // than omitted because the heatmap clears before it draws, and a missing
      // member is a `TypeError` in the middle of an export.
      clearRect: () => {},
      strokeRect: (x: number, y: number, w: number, h: number) => {
        self.strokePath(self.rectangle(x, y, w, h).segments)
      },
      // Nearest-neighbour or bilinear is a question about *pixels*, and the
      // answer on paper is whatever the reader's viewer does with the image —
      // except where a figure asks for smoothing at high quality, which is the
      // one painter that wants its image read as a continuous picture (a
      // list's heatmap, `analysisPlots.drawListImage`): that image carries
      // `/Interpolate true`, and every other is left to the viewer as before.
      set imageSmoothingEnabled(value: boolean) {
        self.state.imageSmoothingEnabled = value
      },
      get imageSmoothingEnabled(): boolean {
        return self.state.imageSmoothingEnabled
      },
      set imageSmoothingQuality(value: ImageSmoothingQuality) {
        self.state.imageSmoothingQuality = value
      },
      get imageSmoothingQuality(): ImageSmoothingQuality {
        return self.state.imageSmoothingQuality
      },
      drawImage: ((
        source: CanvasImageSource,
        a?: number,
        b?: number,
        c?: number,
        d?: number,
        e?: number,
        f?: number,
        g?: number,
        h?: number,
      ) => {
        self.image(source, [a, b, c, d, e, f, g, h])
      }) as CanvasRenderingContext2D['drawImage'],
    }
    return target
  }

  /**
   * Place a raster.
   *
   * The three call shapes canvas has, resolved to one: a source rectangle and a
   * destination rectangle in the caller's own coordinates. The destination is
   * then transformed like any other geometry, which is what lets a matrix drawn
   * through a `setTransform` land in exactly the place the screen put it.
   *
   * Only axis-aligned placement is expressed, because that is the only kind this
   * app performs on an image — a rotated matrix is not a thing the heatmap draws
   * — and a `cm` for the general case would be a second coordinate story to keep
   * true.
   */
  private image(source: CanvasImageSource, args: Array<number | undefined>): void {
    const natural = sizeOf(source)
    if (natural === null) return
    const [a, b, c, d, e, f, g, h] = args
    let crop = { x: 0, y: 0, width: natural.width, height: natural.height }
    let dest: { x: number; y: number; width: number; height: number }
    if (typeof e === 'number' && typeof f === 'number') {
      crop = { x: a ?? 0, y: b ?? 0, width: c ?? natural.width, height: d ?? natural.height }
      dest = { x: e, y: f, width: g ?? crop.width, height: h ?? crop.height }
    } else {
      dest = { x: a ?? 0, y: b ?? 0, width: c ?? natural.width, height: d ?? natural.height }
    }
    const rgb = pixelsOf(source, crop)
    if (rgb === null) return

    // The corners through the matrix, then the axis-aligned box they span.
    const first = this.point(dest.x, dest.y)
    const last = this.point(dest.x + dest.width, dest.y + dest.height)
    const x0 = Math.min(first[0], last[0])
    const y0 = Math.min(first[1], last[1])
    const width = Math.abs(last[0] - first[0])
    const height = Math.abs(last[1] - first[1])
    if (!(width > 0) || !(height > 0)) return

    this.images.push({
      width: crop.width,
      height: crop.height,
      rgb,
      interpolate: this.state.imageSmoothingEnabled && this.state.imageSmoothingQuality === 'high',
    })
    const name = `Im${this.images.length - 1}`
    this.alpha()
    this.emit('q')
    this.emit(`${round(width)} 0 0 ${round(height)} ${round(x0)} ${round(y0)} cm`)
    this.emit(`/${name} Do`)
    this.emit('Q')
  }

  /**
   * One run of text.
   *
   * `textAlign` and `textBaseline` have no PDF equivalent, so they are resolved
   * here into an offset — measured with the screen font, which is what the
   * caller centred against.
   *
   * A stroked run is the *halo* `laneText` puts behind its labels so a name
   * survives over the track's own ink, and it is kept rather than dropped: PDF's
   * text render mode 1 strokes the glyph outlines exactly as the canvas does, so
   * the figure reads the way the screen did. Rendering mode is text state and
   * persists, hence the explicit `Tr` on both paths.
   */
  private text(text: string, x: number, y: number, halo: boolean): void {
    if (text === '') return
    const { size, bold } = parseFont(this.state.font)
    const width = this.ctx.measureText(text).width
    const dx =
      this.state.textAlign === 'center'
        ? -width / 2
        : this.state.textAlign === 'right' || this.state.textAlign === 'end'
          ? -width
          : 0
    // Canvas baselines, as a shift of the alphabetic baseline. The numbers are
    // the usual approximations of a font's metrics and are within a pixel for
    // every size this app draws at.
    const dy =
      this.state.textBaseline === 'middle'
        ? size * 0.35
        : this.state.textBaseline === 'top' || this.state.textBaseline === 'hanging'
          ? size * 0.8
          : this.state.textBaseline === 'bottom'
            ? -size * 0.2
            : 0

    // `dx`/`dy` are in the *caller's* units, which is what `measureText` and the
    // font size are both in: a canvas measures text before the transform and
    // scales the result with everything else. `point` then applies the matrix to
    // the whole thing, exactly as the canvas would.
    const m = this.state.matrix
    const factor = scaleOf(m)
    const [px, py] = this.point(x + dx, y + dy)
    this.alpha()
    if (halo) this.setStroke()
    else this.setFill()
    this.emit('BT')
    this.emit(`${halo ? 1 : 0} Tr`)
    this.emit(`/${bold ? 'F2' : 'F1'} ${round(size * factor)} Tf`)
    // The text matrix carries the rotation; the translation is already baked
    // into the point above. `d` is negated because the page's y runs the other
    // way from the canvas's.
    this.emit(
      `${round(m.a / factor)} ${round(-m.b / factor)} ${round(-m.c / factor)} ` +
        `${round(m.d / factor)} ${round(px)} ${round(py)} Tm`,
    )
    this.emit(`(${escapeText(text)}) Tj`)
    this.emit('ET')
  }

  /** The page as a one-page PDF. */
  async toBlob(meta: { title?: string; created?: Date } = {}): Promise<Blob> {
    const pageWidth = pointsForCssPixels(this.width)
    const pageHeight = pointsForCssPixels(this.height)
    const scale = pageWidth / this.width
    // One `cm` for the whole stream: everything above is in CSS pixels measured
    // from the top-left, and this is the single place that becomes points.
    const body = `q ${round(scale)} 0 0 ${round(scale)} 0 ${round(pageHeight - this.height * scale)} cm\n${this.ops.join('\n')}\nQ\n`
    // Compressed, because a whole-genome view of a GTF is a few hundred thousand
    // path operators and they are almost entirely repeated digits — this is the
    // difference between a 12 MB figure and a 700 kB one.
    const { data: stream, filter } = await deflateBytes(new TextEncoder().encode(body))

    const gs = [...this.alphas.entries()]
      .map(([value, name]) => `/${name} << /Type /ExtGState /ca ${round(value)} /CA ${round(value)} >>`)
      .join(' ')

    // The rasters, deflated. Numbered from 8, after the seven fixed objects, so
    // the page's `/XObject` dictionary can be written before any of them exists.
    const packed = await Promise.all(this.images.map((image) => deflateBytes(image.rgb)))
    const xobjects = this.images
      .map((_image, index) => `/Im${index} ${8 + index} 0 R`)
      .join(' ')

    const chunks: Uint8Array[] = []
    const offsets: number[] = []
    let length = 0
    const encoder = new TextEncoder()
    const push = (part: Uint8Array | string): void => {
      const bytes = typeof part === 'string' ? encoder.encode(part) : part
      chunks.push(bytes)
      length += bytes.length
    }
    const startObject = (): void => {
      offsets.push(length)
    }

    push('%PDF-1.4\n%âãÏÓ\n')
    startObject()
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
    startObject()
    push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
    startObject()
    push(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(pageWidth)} ${round(pageHeight)}] ` +
        '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> ' +
        `/ExtGState << ${gs} >>` +
        `${this.shadings.length === 0 ? '' : ` /Shading << ${this.shadings.join(' ')} >>`}` +
        `${xobjects === '' ? '' : ` /XObject << ${xobjects} >>`} >> /Contents 4 0 R >>\nendobj\n`,
    )
    startObject()
    push(
      `4 0 obj\n<< /Length ${stream.length}` +
        `${filter === null ? '' : ` /Filter ${filter}`} >>\nstream\n`,
    )
    push(stream)
    push('\nendstream\nendobj\n')
    startObject()
    push(
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    )
    startObject()
    push(
      '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
    )
    startObject()
    const created = meta.created ?? new Date()
    push(
      `7 0 obj\n<< /Producer (${escapeText(PRODUCER)}) ` +
        (meta.title === undefined ? '' : `/Title (${escapeText(meta.title)}) `) +
        `/CreationDate (D:${pdfDate(created)}) >>\nendobj\n`,
    )

    for (const [index, image] of this.images.entries()) {
      const { data, filter: imageFilter } = packed[index]
      startObject()
      push(
        `${8 + index} 0 obj\n<< /Type /XObject /Subtype /Image ` +
          `/Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `${image.interpolate ? '/Interpolate true ' : ''}` +
          `${imageFilter === null ? '' : `/Filter ${imageFilter} `}` +
          `/Length ${data.length} >>\nstream\n`,
      )
      push(data)
      push('\nendstream\nendobj\n')
    }

    const xref = length
    let table = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) table += `${String(offset).padStart(10, '0')} 00000 n \n`
    push(table)
    push(
      `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    )

    return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
  }
}

/** The natural pixel size of anything canvas will draw, or `null`. */
function sizeOf(source: CanvasImageSource): { width: number; height: number } | null {
  const value = source as { width?: unknown; height?: unknown }
  const width = typeof value.width === 'number' ? value.width : 0
  const height = typeof value.height === 'number' ? value.height : 0
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * A source's pixels as packed RGB, alpha composited onto white.
 *
 * PDF has no alpha channel on an image without a soft mask, and the page under
 * this one is white, so compositing here is the same picture in one object
 * instead of two. Read through a scratch canvas rather than from the source
 * directly, because `drawImage` is the only thing that takes every shape of
 * `CanvasImageSource` and turns it into pixels.
 */
function pixelsOf(
  source: CanvasImageSource,
  crop: { x: number; y: number; width: number; height: number },
): Uint8Array | null {
  if (typeof document === 'undefined') return null
  const scratch = document.createElement('canvas')
  scratch.width = Math.max(1, Math.round(crop.width))
  scratch.height = Math.max(1, Math.round(crop.height))
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, scratch.width, scratch.height)
  ctx.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    scratch.width,
    scratch.height,
  )
  const rgba = ctx.getImageData(0, 0, scratch.width, scratch.height).data
  const rgb = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i]
    rgb[o + 1] = rgba[i + 1]
    rgb[o + 2] = rgba[i + 2]
  }
  return rgb
}

/** `D:YYYYMMDDHHmmSS`, which is the only date format PDF has. */
function pdfDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  )
}

/**
 * The punctuation WinAnsi has and Latin-1 does not.
 *
 * `0x80`–`0x9f` is where CP1252 puts the typographic marks, and one of them is
 * the en dash this app writes every range with — `0 – 130` under every track.
 * Without the map that dash is the one character in the figure that comes out as
 * a question mark.
 */
const WIN_ANSI = new Map<string, number>([
  ['€', 0x80],
  ['‚', 0x82],
  ['ƒ', 0x83],
  ['„', 0x84],
  ['…', 0x85],
  ['†', 0x86],
  ['‡', 0x87],
  ['ˆ', 0x88],
  ['‰', 0x89],
  ['Š', 0x8a],
  ['‹', 0x8b],
  ['Œ', 0x8c],
  ['Ž', 0x8e],
  ['‘', 0x91],
  ['’', 0x92],
  ['“', 0x93],
  ['”', 0x94],
  ['•', 0x95],
  ['–', 0x96],
  ['—', 0x97],
  ['˜', 0x98],
  ['™', 0x99],
  ['š', 0x9a],
  ['›', 0x9b],
  ['œ', 0x9c],
  ['ž', 0x9e],
  ['Ÿ', 0x9f],
])

/**
 * A PDF literal string.
 *
 * Backslash, both parens, and anything outside WinAnsi — a contig called
 * `chrI‑α` is legal and would otherwise close the string early or write a byte
 * the reader maps to something else.
 */
export function escapeText(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    const mapped = WIN_ANSI.get(character)
    if (character === '\\' || character === '(' || character === ')') out += `\\${character}`
    else if (code >= 32 && code <= 126) out += character
    else if (mapped !== undefined) out += `\\${mapped.toString(8).padStart(3, '0')}`
    // 0x80–0x9f are control characters in Latin-1 and typography in WinAnsi, so
    // a raw one of those would be written as a glyph it is not.
    else if (code >= 0xa0 && code <= 0xff) out += `\\${code.toString(8).padStart(3, '0')}`
    else if (SPACE_LIKE.has(code)) out += '\\240'
    else if (SPELLED.has(code)) out += escapeText(SPELLED.get(code) as string)
    else out += '?'
  }
  return out
}

/**
 * The spaces WinAnsi has no byte for, folded onto its non-breaking one.
 *
 * Not a nicety. `fmt.int` formats through `Intl.NumberFormat` in the *viewer's*
 * locale, and half of Europe groups digits with a space rather than a comma —
 * `fr-FR` picks U+202F NARROW NO-BREAK SPACE, others U+00A0. The first has no
 * WinAnsi byte, so a figure exported in French came out reading `7?071 in view`:
 * every grouped number in the figure corrupted, by the app's own formatter, in
 * the one place a reader would never think to look for a locale bug.
 */
/**
 * The symbols WinAnsi has no byte for, spelled out rather than dropped.
 *
 * `≤` is the one that matters: every colour bar this app draws ends with
 * `≤ 0.000061` under its lowest stop, and in the exported figure that read
 * `? 0.000061`. Two characters that say the same thing beat one that says
 * nothing, and neither is a reason to embed a font.
 */
const SPELLED = new Map<number, string>([
  [0x2264, '<='],
  [0x2265, '>='],
  [0x2260, '!='],
  [0x2248, '~'],
  [0x2212, '-'],
  [0x2032, "'"],
  [0x2033, '"'],
])

const SPACE_LIKE = new Set([
  0x2007, // figure space
  0x2008, // punctuation space
  0x2009, // thin space
  0x200a, // hair space
  0x202f, // narrow no-break space
])
