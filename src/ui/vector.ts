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
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  lineJoin: CanvasLineJoin
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
  | 'fill'
  | 'stroke'
  | 'clip'
  | 'fillRect'
  | 'fillText'
  | 'strokeText'
  | 'measureText'
  | 'translate'
  | 'rotate'
  | 'setTransform'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'lineJoin'
>

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
  private path: string[] = []
  /** Where the current subpath started, for `closePath` and for `arc`. */
  private current: { x: number; y: number } | null = null
  private readonly alphas = new Map<number, string>()
  private readonly ruler: CanvasRenderingContext2D | null

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.state = {
      matrix: { ...IDENTITY },
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      globalAlpha: 1,
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      lineJoin: 'miter',
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

  /** Canvas point → page point. PDF's y runs up the page; canvas's runs down. */
  private point(x: number, y: number): [number, number] {
    const m = this.state.matrix
    return [m.a * x + m.c * y + m.e, this.height - (m.b * x + m.d * y + m.f)]
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
  }

  private flushPath(): void {
    for (const segment of this.path) this.emit(segment)
    this.path = []
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
        if (typeof value === 'string') self.state.fillStyle = value
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
      beginPath: () => {
        self.path = []
        self.current = null
      },
      closePath: () => {
        self.path.push('h')
      },
      moveTo: (x: number, y: number) => {
        const [px, py] = self.point(x, y)
        self.path.push(`${round(px)} ${round(py)} m`)
        self.current = { x, y }
      },
      lineTo: (x: number, y: number) => {
        const [px, py] = self.point(x, y)
        self.path.push(`${round(px)} ${round(py)} l`)
        self.current = { x, y }
      },
      rect: (x: number, y: number, w: number, h: number) => {
        // Four corners rather than PDF's `re`, because `re` is axis-aligned in
        // *page* space and the matrix here may be a quarter turn.
        const points = [
          self.point(x, y),
          self.point(x + w, y),
          self.point(x + w, y + h),
          self.point(x, y + h),
        ]
        self.path.push(`${round(points[0][0])} ${round(points[0][1])} m`)
        for (const [px, py] of points.slice(1)) self.path.push(`${round(px)} ${round(py)} l`)
        self.path.push('h')
        self.current = { x, y }
      },
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
        // PDF has only cubics, so the quadratic is raised a degree — exactly,
        // which is what makes an arc in the figure the arc that was on screen.
        const from = self.current ?? { x: cx, y: cy }
        const c1 = { x: from.x + (2 / 3) * (cx - from.x), y: from.y + (2 / 3) * (cy - from.y) }
        const c2 = { x: x + (2 / 3) * (cx - x), y: y + (2 / 3) * (cy - y) }
        const [ax, ay] = self.point(c1.x, c1.y)
        const [bx, by] = self.point(c2.x, c2.y)
        const [ex, ey] = self.point(x, y)
        self.path.push(
          `${round(ax)} ${round(ay)} ${round(bx)} ${round(by)} ${round(ex)} ${round(ey)} c`,
        )
        self.current = { x, y }
      },
      arc: (
        x: number,
        y: number,
        radius: number,
        start: number,
        end: number,
        counter?: boolean,
      ) => {
        // Flattened. A circle drawn as 24 segments is indistinguishable at any
        // size a figure is printed at, and it keeps this module free of the
        // four-Bézier arc approximation for a shape used by one caller.
        const steps = 24
        const sweep = counter === true ? start - end : end - start
        const span = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        let last = { x, y }
        for (let i = 0; i <= steps; i++) {
          const angle = start + (counter === true ? -1 : 1) * span * (i / steps)
          last = { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius }
          const [px, py] = self.point(last.x, last.y)
          self.path.push(`${round(px)} ${round(py)} ${i === 0 ? 'm' : 'l'}`)
        }
        self.current = last
      },
      fill: () => {
        self.alpha()
        self.setFill()
        self.flushPath()
        self.emit('f')
      },
      stroke: () => {
        self.alpha()
        self.setStroke()
        self.flushPath()
        self.emit('S')
      },
      clip: () => {
        self.flushPath()
        self.emit('W n')
      },
      fillRect: (x: number, y: number, w: number, h: number) => {
        target.beginPath()
        target.rect(x, y, w, h)
        target.fill()
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
      setTransform: ((a: number, b: number, c: number, d: number, e: number, f: number) => {
        self.state.matrix = { a, b, c, d, e, f }
      }) as CanvasRenderingContext2D['setTransform'],
    }
    return target
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
        `/ExtGState << ${gs} >> >> /Contents 4 0 R >>\nendobj\n`,
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
    else out += '?'
  }
  return out
}
