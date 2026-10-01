/**
 * The stage's corner dot plot (SPECS §27.3): the file's own sequence set against
 * another reference the session holds — the theoretical genome a strain was
 * built to be, the assembly it came from — drawn **through the edit as it
 * stands**, redrawn after every step, so that whether the assembly is coming
 * to read as the other one does is seen as the steps are made.
 *
 * The streaks are found once, in the annotations worker beside the residues,
 * by the dot plot task itself (§28), and after that only moved: an edit moves
 * the lines, it does not make new ones (`liveDotplot.ts`). A square over the
 * map's upper triangle, which the lower one mirrors; folded to a button when
 * it is in the way, and remembered folded; zoomed and moved by the dot plot
 * view's own gestures (§28.2), and sized by a grip at its lower-left corner,
 * remembered too. Hovering names the streak under the pointer in the stage's
 * readout and lights its stretch on the map; a press frames it there; and a
 * stretch hovered on the map's bars lights its lines here, the others dimmed.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import type { AnalysisFraming, DotplotStreaks, MatrixOutput } from '../analysis/types'
import { clampView, locusOf, offsetsOf, panView, streakAt, streakEnds, toBases, toPixels, zoomView, type DotplotView, type PlotRect } from '../dotplot/view'
import type { EditedAssembly } from '../genome/edit'
import { plotTheme } from '../ui/analysisPlots'
import { el } from '../ui/dom'
import { describeStreak, drawDotplot, handDotplot, type DotplotFocus, type DotplotPicture } from '../ui/dotplotFigure'
import { icon } from '../ui/icons'
import { recall, remember } from '../state/UiMemory'
import {
  cornerSide,
  foundFrom,
  grippedSide,
  linesOver,
  sequenceSets,
  spanAlong,
  stretchOfLine,
  throughEdit,
  type EditedLines,
  type EditedStretch,
  type FoundStreaks,
} from './dotplotLines'

export interface LiveDotplotProps {
  store: AnnotationStore
  client: AnnotationClient
  /** The edited assembly as it stands. */
  assembly(): EditedAssembly
  /** What a run is framed as: the file, for the record. */
  framing(): AnalysisFraming
  /** Say a line in the stage's readout; `null` gives it back. */
  say(text: string | null): void
  /** Frame a stretch of an edited sequence on the map. */
  frame(sequence: string, from: number, to: number): void
  /** Light on the map the stretch a hovered line lies along; `null` puts it out. */
  light(stretch: EditedStretch | null): void
  /** What this stage's memory is kept under: its file. */
  memoryKey: string
}

/** Pixels from a line within which the pointer is on it: the corner plot is small, and a hand is not. */
const REACH_PX = 5

/** What the picker over the plot and the caption under it take, before they are laid out to be measured. */
const CHROME_PX = 64

/** Whether the corner plot is folded away, the side the reader gave it, and the reference it was last set against, per file. */
const FOLDED_SCOPE = 'edit:dotplot-folded'
const SIDE_SCOPE = 'edit:dotplot-side'
const REFERENCE_SCOPE = 'edit:dotplot-reference'

export class LiveDotplot {
  readonly element: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly caption: HTMLElement
  private readonly picker: HTMLSelectElement
  private readonly fold: HTMLButtonElement
  private readonly whole: HTMLButtonElement
  private readonly grip: HTMLElement
  private readonly open: HTMLButtonElement
  private found: FoundStreaks | null = null
  private lines: EditedLines | null = null
  private reference: string | null = null
  private request: { cancel(): void } | null = null
  private laid: { rect: PlotRect; view: DotplotView } | null = null
  /** The window on screen, in bases along each axis; `null` for the whole. */
  private view: DotplotView | null = null
  private lit = -1
  /** The stretch hovered on the map, its lines lit here. */
  private focused: EditedStretch | null = null
  private side = 0
  /** The side the reader gave it with its grip, or `null` for its own. */
  private chosen: number | null
  private map: { x: number; y: number; size: number } | null = null
  private folded: boolean
  private frameId = 0
  private closed = false

  /** A corner plot for a stage, or `null` where the session holds no other reference to set the file against. */
  static of(props: LiveDotplotProps): LiveDotplot | null {
    return sequenceSets(props.store.entries).others.length === 0 ? null : new LiveDotplot(props)
  }

  private constructor(private readonly props: LiveDotplotProps) {
    this.folded = recall<boolean>(props.memoryKey, FOLDED_SCOPE) === true
    const side = recall<number>(props.memoryKey, SIDE_SCOPE)
    this.chosen = typeof side === 'number' && Number.isFinite(side) ? side : null
    this.canvas = el('canvas', { class: 'edit-dotplot-canvas' })
    this.caption = el('div', { class: 'edit-dotplot-caption' })
    this.picker = el('select', { class: 'select select-tight edit-dotplot-picker', attrs: { 'aria-label': 'The reference set against the assembly' } }) as HTMLSelectElement
    this.picker.addEventListener('change', () => this.choose(this.picker.value))
    this.whole = el('button', { class: 'btn btn-icon edit-dotplot-whole hidden', title: 'Show both whole (a double click)', attrs: { type: 'button', 'aria-label': 'Show both whole' } })
    this.whole.append(icon('maximize', { size: 13 }))
    this.whole.addEventListener('click', () => this.showWhole())
    this.fold = el('button', { class: 'btn btn-icon edit-dotplot-fold', title: 'Fold the dot plot away', attrs: { type: 'button', 'aria-label': 'Fold the dot plot away' } })
    this.fold.append(icon('chevron-up', { size: 13 }))
    this.fold.addEventListener('click', () => this.setFolded(true))
    this.grip = el('div', { class: 'edit-dotplot-grip', title: 'Drag to size the dot plot; a double click gives it its own size', attrs: { role: 'separator', 'aria-label': 'Size the dot plot' } })
    this.open = el('button', { class: 'btn edit-dotplot-open', text: 'dot plot', title: 'The assembly against another reference, through the edit', attrs: { type: 'button' } })
    this.open.addEventListener('click', () => this.setFolded(false))
    this.element = el(
      'div',
      { class: 'edit-dotplot' },
      el('div', { class: 'edit-dotplot-head' }, this.picker, this.whole, this.fold),
      this.canvas,
      this.caption,
      this.grip,
      this.open,
    )
    this.wire()
    this.wireGrip()
    this.fillPicker()
    this.setFolded(this.folded)
  }

  /** Where it stands: the map's top-right corner, as large as the reader made it or a third of the map. */
  place(mapX: number, mapY: number, mapSize: number): void {
    this.map = { x: mapX, y: mapY, size: mapSize }
    // What is not the plot — its picker and its caption — measured where it is laid out.
    const chrome = this.folded || this.canvas.offsetHeight === 0 ? CHROME_PX : Math.max(CHROME_PX, this.element.offsetHeight - this.canvas.offsetHeight)
    this.side = cornerSide(mapSize, this.chosen, chrome)
    // By its right edge, folded or not: the button stands where the plot's corner does.
    this.element.style.left = `${Math.round(mapX + mapSize - 8)}px`
    this.element.style.top = `${Math.round(mapY + 8)}px`
    // As wide as its plot: the caption wraps rather than widening it.
    for (const part of [this.element.firstElementChild as HTMLElement | null, this.caption]) if (part !== null) part.style.width = `${this.side}px`
    this.draw()
  }

  /** The edit changed: the lines are moved through it and drawn again. */
  refresh(): void {
    if (this.found === null) return
    this.lines = throughEdit(this.found, this.props.assembly())
    this.lit = -1
    this.draw()
  }

  /** A stretch of the edit hovered on the map: its lines lit, the others dimmed, its span marked; `null` puts it out. */
  focusOn(stretch: EditedStretch | null): void {
    const same =
      stretch === this.focused ||
      (stretch !== null && this.focused !== null && stretch.sequence === this.focused.sequence && stretch.from === this.focused.from && stretch.to === this.focused.to)
    if (same) return
    this.focused = stretch
    this.schedule()
  }

  destroy(): void {
    this.closed = true
    this.request?.cancel()
    this.request = null
    if (this.frameId !== 0) cancelAnimationFrame(this.frameId)
  }

  private fillPicker(): void {
    const { others } = sequenceSets(this.props.store.entries)
    const remembered = recall<string>(this.props.memoryKey, REFERENCE_SCOPE)
    this.picker.replaceChildren(...others.map((set) => el('option', { value: set.id, text: `against ${set.label}` })))
    const chosen = others.find((set) => set.id === remembered) ?? others[0]
    if (chosen === undefined) return
    this.picker.value = chosen.id
    if (!this.folded) this.choose(chosen.id)
  }

  private setFolded(folded: boolean): void {
    this.folded = folded
    remember(this.props.memoryKey, FOLDED_SCOPE, folded)
    this.element.classList.toggle('is-folded', folded)
    // Found only once it is wanted: a reader who folded it away never pays for it.
    if (!folded && this.reference === null && this.picker.value !== '') this.choose(this.picker.value)
    if (folded) this.props.light(null)
    if (this.map === null) this.draw()
    else this.place(this.map.x, this.map.y, this.map.size)
  }

  /** Set the file against `reference`: its streaks found once, in the annotations worker. */
  private choose(reference: string): void {
    const { own } = sequenceSets(this.props.store.entries)
    if (own === null || reference === this.reference) return
    this.reference = reference
    remember(this.props.memoryKey, REFERENCE_SCOPE, reference)
    this.request?.cancel()
    this.found = null
    this.lines = null
    this.view = null
    this.say(`finding the streaks against ${this.picker.selectedOptions[0]?.textContent?.replace(/^against /, '') ?? 'it'}…`)
    this.draw()
    const labels: Record<string, string> = {}
    for (const entry of this.props.store.entries) if (entry.id === own.id || entry.id === reference) labels[entry.id] = entry.label
    const request = this.props.client.cancellable<'run'>(
      {
        kind: 'run',
        task: 'dotplot',
        // Its streaks are what is drawn; the cells are few, and not drawn.
        params: { x: own.id, y: reference, streaks: 'one to one', cells: 16 },
        framing: this.props.framing(),
        inputs: { labels },
      },
      (done, total, note) => {
        if (this.request === request && total > 0) this.say(`finding the streaks: ${note ?? `${done} of ${total}`}…`)
      },
    )
    this.request = request
    request.promise
      .then((result) => {
        if (this.closed || this.request !== request) return
        this.request = null
        const streaks = result.outputs.find((output): output is MatrixOutput & { streaks: DotplotStreaks } => output.kind === 'matrix' && output.streaks !== undefined)?.streaks
        if (streaks === undefined) {
          this.say(result.notes[0] ?? 'No streaks were found.')
          return
        }
        this.found = foundFrom(streaks)
        this.refresh()
      })
      .catch((error: unknown) => {
        if (this.closed || this.request !== request) return
        this.request = null
        const cancelled = error instanceof Error && error.name === 'AbortError'
        if (!cancelled) this.say(`The streaks could not be found: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  private say(text: string): void {
    this.caption.textContent = text
  }

  private picture(): DotplotPicture | null {
    const found = this.found
    const lines = this.lines
    if (found === null || lines === null) return null
    return { x: { ...lines.x, label: found.xLabel }, y: found.y, lines }
  }

  /** What the map's hover lights here: the lines along its stretch, and its span. */
  private focus(picture: DotplotPicture): DotplotFocus | null {
    const stretch = this.focused
    if (stretch === null) return null
    const span = spanAlong(picture.x, stretch)
    if (span === null) return null
    return { lines: linesOver(picture.lines, span), span, accent: getComputedStyle(this.element).getPropertyValue('--accent').trim() || '#1f5fa9' }
  }

  private schedule(): void {
    if (this.frameId === 0 && !this.closed) {
      this.frameId = requestAnimationFrame(() => {
        this.frameId = 0
        this.draw()
      })
    }
  }

  private draw(): void {
    if (this.folded) return
    const side = this.side
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    this.canvas.style.width = `${side}px`
    this.canvas.style.height = `${side}px`
    const want = Math.max(1, Math.round(side * dpr))
    if (this.canvas.width !== want) this.canvas.width = want
    if (this.canvas.height !== want) this.canvas.height = want
    const ctx = this.canvas.getContext('2d')
    const picture = this.picture()
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, side, side)
    if (picture === null) {
      this.laid = null
      return
    }
    const focus = this.focus(picture)
    this.laid = drawDotplot(ctx, picture, { width: side, height: side }, plotTheme(this.element), this.view, this.lit, true, focus)
    this.view = this.view === null ? null : this.laid.view
    this.whole.classList.toggle('hidden', this.view === null)
    // The window and the lit line, on the element — as the dot plot's view of
    // its own says them — so a script driving the stage can aim at a line.
    this.canvas.dataset.view = [this.laid.view.x0, this.laid.view.x1, this.laid.view.y0, this.laid.view.y1].map((value) => value.toFixed(0)).join(' ')
    this.canvas.dataset.focused = String(focus?.lines.length ?? 0)
    if (this.lit >= 0) {
      const [ax, ay, bx, by] = streakEnds(picture.lines, this.lit)
      const a = toPixels(this.laid.view, this.laid.rect, ax, ay)
      const b = toPixels(this.laid.view, this.laid.rect, bx, by)
      this.canvas.dataset.lit = [a.px, a.py, b.px, b.py].map((value) => value.toFixed(1)).join(' ')
    } else {
      delete this.canvas.dataset.lit
    }
    const count = picture.lines.x0.length
    if (this.request === null) this.say(`${count.toLocaleString('en-US')} streak${count === 1 ? '' : 's'} · the edit along x, ${picture.y.label} along y`)
  }

  /** Both sets whole again. */
  private showWhole(): void {
    this.view = null
    this.schedule()
  }

  /** The window moved to `next`, kept over the data. */
  private setView(next: (view: DotplotView, rect: PlotRect) => DotplotView): void {
    const picture = this.picture()
    if (picture === null || this.laid === null) return
    const xs = offsetsOf(picture.x)
    const ys = offsetsOf(picture.y)
    this.view = clampView(next(this.laid.view, this.laid.rect), xs[xs.length - 1], ys[ys.length - 1], this.laid.rect)
    this.schedule()
  }

  /** The line under `(x, y)`, lit, named in the readout and its stretch lit on the map; else the place on both axes. */
  private pointAt(x: number, y: number): void {
    const picture = this.picture()
    const laid = this.laid
    if (picture === null || laid === null) return
    const inside = x >= laid.rect.x && x <= laid.rect.x + laid.rect.width && y >= laid.rect.y && y <= laid.rect.y + laid.rect.height
    const next = inside ? streakAt(picture.lines, laid.view, laid.rect, x, y, REACH_PX) : -1
    if (next !== this.lit) {
      this.lit = next
      this.props.light(this.lines === null ? null : stretchOfLine(this.lines, next))
      this.schedule()
    }
    this.canvas.classList.toggle('is-on-streak', next >= 0)
    if (next >= 0) {
      this.props.say(`${describeStreak(picture, next, this.lines?.anchors)} · press to frame it`)
      return
    }
    const bases = toBases(laid.view, laid.rect, x, y)
    const xs = locusOf(picture.x, offsetsOf(picture.x), bases.x)
    const ys = locusOf(picture.y, offsetsOf(picture.y), bases.y)
    this.props.say(xs === null || ys === null ? null : `${xs.name} × ${ys.name} · the dot plot through the edit · scroll to zoom, drag to move, double-click for the whole`)
  }

  private wire(): void {
    // The dot plot view's own gestures (§28.2): wheel, drag, double click.
    handDotplot(this.canvas, {
      zoom: (factor, x, y) => this.setView((view, rect) => zoomView(view, rect, x, y, factor)),
      pan: (dx, dy) => this.setView((view, rect) => panView(view, rect, dx, dy)),
      whole: () => this.showWhole(),
      point: (x, y) => this.pointAt(x, y),
      press: (x, y) => {
        const picture = this.picture()
        if (picture === null || this.laid === null) return
        const i = streakAt(picture.lines, this.laid.view, this.laid.rect, x, y, REACH_PX)
        const stretch = this.lines === null ? null : stretchOfLine(this.lines, i)
        if (stretch !== null) this.props.frame(stretch.sequence, stretch.from, stretch.to)
      },
      leave: () => {
        if (this.lit !== -1) {
          this.lit = -1
          this.schedule()
        }
        this.canvas.classList.remove('is-on-streak')
        this.props.light(null)
        this.props.say(null)
      },
    })
  }

  /**
   * The grip at the lower-left corner: a drag sizes the plot — it hangs from
   * its upper-right corner, so left and down grow it — kept on the map and
   * remembered with the file; a double click gives it its own size back.
   */
  private wireGrip(): void {
    let press: { x: number; y: number; side: number } | null = null
    const resize = (chosen: number | null): void => {
      this.chosen = chosen
      if (this.map !== null) this.place(this.map.x, this.map.y, this.map.size)
    }
    this.grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      press = { x: event.clientX, y: event.clientY, side: this.side }
      this.grip.setPointerCapture?.(event.pointerId)
      this.element.classList.add('is-sizing')
    })
    this.grip.addEventListener('pointermove', (event) => {
      if (press === null) return
      resize(grippedSide(press.side, event.clientX - press.x, event.clientY - press.y))
      // What it was kept to, so a hand past the map's edge does not run on unseen.
      this.chosen = this.side
      this.props.say(`the dot plot ${this.side} pixels a side · a double click on the grip gives it its own`)
    })
    const release = (event: PointerEvent): void => {
      if (press === null) return
      press = null
      if (this.grip.hasPointerCapture?.(event.pointerId) === true) this.grip.releasePointerCapture(event.pointerId)
      this.element.classList.remove('is-sizing')
      remember(this.props.memoryKey, SIDE_SCOPE, this.chosen)
      this.props.say(null)
    }
    this.grip.addEventListener('pointerup', release)
    this.grip.addEventListener('pointercancel', release)
    this.grip.addEventListener('dblclick', (event) => {
      event.preventDefault()
      resize(null)
      remember(this.props.memoryKey, SIDE_SCOPE, null)
    })
  }
}
