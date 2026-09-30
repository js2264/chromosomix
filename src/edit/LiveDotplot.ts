/**
 * The stage's corner dot plot (SPECS §27.3): the file's own sequence set against
 * another reference the session holds — the theoretical genome a strain was
 * built to be, the assembly it came from — drawn **through the edit as it
 * stands**, redrawn after every step, so that whether the assembly is coming
 * to read as the other one does is seen as the steps are made.
 *
 * The streaks are found once, in the annotations worker beside the residues,
 * by the dot plot task itself (§28), and after that only moved: an edit moves
 * the lines, it does not make new ones (`liveDotplot.ts`). A small square over
 * the map's upper triangle, which the lower one mirrors; folded to a button
 * when it is in the way, and remembered folded. Hovering names the streak under
 * the pointer in the stage's readout; a press frames it on the map.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import type { AnalysisFraming, DotplotStreaks, MatrixOutput } from '../analysis/types'
import { locusOf, offsetsOf, streakAt, type DotplotView, type PlotRect } from '../dotplot/view'
import type { EditedAssembly } from '../genome/edit'
import { plotTheme } from '../ui/analysisPlots'
import { el } from '../ui/dom'
import { describeStreak, drawDotplot, type DotplotPicture } from '../ui/dotplotFigure'
import { icon } from '../ui/icons'
import { recall, remember } from '../state/UiMemory'
import { foundFrom, pickSets, throughEdit, type EditedLines, type FoundStreaks } from './dotplotLines'

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
  /** What this stage's memory is kept under: its file. */
  memoryKey: string
}

/** The corner plot's side, in CSS pixels, at most. */
const MOST_SIDE = 220

/** Pixels from a line within which the pointer is on it: the corner plot is small, and a hand is not. */
const REACH_PX = 5

/** Whether the corner plot is folded away, and the reference it was last set against, per file. */
const FOLDED_SCOPE = 'edit:dotplot-folded'
const REFERENCE_SCOPE = 'edit:dotplot-reference'

export class LiveDotplot {
  readonly element: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly caption: HTMLElement
  private readonly picker: HTMLSelectElement
  private readonly fold: HTMLButtonElement
  private readonly open: HTMLButtonElement
  private found: FoundStreaks | null = null
  private lines: EditedLines | null = null
  private reference: string | null = null
  private request: { cancel(): void } | null = null
  private laid: { rect: PlotRect; view: DotplotView } | null = null
  private lit = -1
  private side = MOST_SIDE
  private folded: boolean
  private closed = false

  /** A corner plot for a stage, or `null` where the session holds no other reference to set the file against. */
  static of(props: LiveDotplotProps): LiveDotplot | null {
    return LiveDotplot.sets(props.store).others.length === 0 ? null : new LiveDotplot(props)
  }

  private static sets(store: AnnotationStore): ReturnType<typeof pickSets<{ id: string; matched: number; label: string }>> {
    const sequences = store.entries
      .filter((entry) => entry.kind === 'sequence' && entry.status === 'ready')
      .map((entry) => ({ id: entry.id, matched: entry.overlap?.matched ?? 0, label: entry.label }))
    const picked = pickSets(sequences)
    return picked.own === null ? { own: null, others: [] } : picked
  }

  private constructor(private readonly props: LiveDotplotProps) {
    this.folded = recall<boolean>(props.memoryKey, FOLDED_SCOPE) === true
    this.canvas = el('canvas', { class: 'edit-dotplot-canvas' })
    this.caption = el('div', { class: 'edit-dotplot-caption' })
    this.picker = el('select', { class: 'select select-tight edit-dotplot-picker', attrs: { 'aria-label': 'The reference set against the assembly' } }) as HTMLSelectElement
    this.picker.addEventListener('change', () => this.choose(this.picker.value))
    this.fold = el('button', { class: 'btn btn-icon edit-dotplot-fold', title: 'Fold the dot plot away', attrs: { type: 'button', 'aria-label': 'Fold the dot plot away' } })
    this.fold.append(icon('chevron-up', { size: 13 }))
    this.fold.addEventListener('click', () => this.setFolded(true))
    this.open = el('button', { class: 'btn edit-dotplot-open', text: 'dot plot', title: 'The assembly against another reference, through the edit', attrs: { type: 'button' } })
    this.open.addEventListener('click', () => this.setFolded(false))
    this.element = el(
      'div',
      { class: 'edit-dotplot' },
      el('div', { class: 'edit-dotplot-head' }, this.picker, this.fold),
      this.canvas,
      this.caption,
      this.open,
    )
    this.wire()
    this.fillPicker()
    this.setFolded(this.folded)
  }

  /** Where it stands: the map's top-right corner, as large as a third of the map. */
  place(mapX: number, mapY: number, mapSize: number): void {
    this.side = Math.max(120, Math.min(MOST_SIDE, Math.round(mapSize * 0.32)))
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

  destroy(): void {
    this.closed = true
    this.request?.cancel()
    this.request = null
  }

  private fillPicker(): void {
    const { others } = LiveDotplot.sets(this.props.store)
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
    this.draw()
  }

  /** Set the file against `reference`: its streaks found once, in the annotations worker. */
  private choose(reference: string): void {
    const { own } = LiveDotplot.sets(this.props.store)
    if (own === null || reference === this.reference) return
    this.reference = reference
    remember(this.props.memoryKey, REFERENCE_SCOPE, reference)
    this.request?.cancel()
    this.found = null
    this.lines = null
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
    this.laid = drawDotplot(ctx, picture, { width: side, height: side }, plotTheme(this.element), null, this.lit, true)
    const count = picture.lines.x0.length
    if (this.request === null) this.say(`${count.toLocaleString('en-US')} streak${count === 1 ? '' : 's'} · the edit along x, ${picture.y.label} along y`)
  }

  private wire(): void {
    const local = (event: MouseEvent): { x: number; y: number } => {
      const box = this.canvas.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top }
    }
    const under = (event: MouseEvent): number => {
      const picture = this.picture()
      if (picture === null || this.laid === null) return -1
      const { x, y } = local(event)
      return streakAt(picture.lines, this.laid.view, this.laid.rect, x, y, REACH_PX)
    }
    this.canvas.addEventListener('pointermove', (event) => {
      const picture = this.picture()
      if (picture === null || this.laid === null) return
      const next = under(event)
      if (next !== this.lit) {
        this.lit = next
        this.draw()
      }
      this.canvas.classList.toggle('is-on-streak', next >= 0)
      if (next >= 0) {
        this.props.say(`${describeStreak(picture, next, this.lines?.anchors)} · press to frame it`)
        return
      }
      const { x, y } = local(event)
      const scale = (this.laid.view.x1 - this.laid.view.x0) / this.laid.rect.width
      const bx = this.laid.view.x0 + (x - this.laid.rect.x) * scale
      const by = this.laid.view.y0 + (y - this.laid.rect.y) * scale
      const xs = locusOf(picture.x, offsetsOf(picture.x), bx)
      const ys = locusOf(picture.y, offsetsOf(picture.y), by)
      this.props.say(xs === null || ys === null ? null : `${xs.name} × ${ys.name} · the dot plot through the edit`)
    })
    this.canvas.addEventListener('pointerleave', () => {
      if (this.lit !== -1) {
        this.lit = -1
        this.draw()
      }
      this.canvas.classList.remove('is-on-streak')
      this.props.say(null)
    })
    this.canvas.addEventListener('click', (event) => {
      const picture = this.picture()
      const i = under(event)
      if (picture === null || i < 0) return
      const offsets = offsetsOf(picture.x)
      const at = locusOf(picture.x, offsets, picture.lines.x0[i])
      if (at === null) return
      this.props.frame(at.name, at.at, at.at + (picture.lines.x1[i] - picture.lines.x0[i]))
    })
  }
}
