/**
 * The resolution, as a thing you can take hold of.
 *
 * A contact map's resolution used to be a `<select>` in the breadcrumb, and it
 * named the *file's* rungs: `1000`, `2000`, `5000`. That is the right control
 * for what it was — a statement about which stored level you want to look at,
 * which is a choice about the data (§16.2) — and it is the wrong one for what a
 * streaming map has. The resolution of the picture on screen is now a
 * **continuous consequence of the zoom**: the reader magnifies, the window
 * narrows, the reader picks a finer grid for it, and the number under the map
 * changes without anybody choosing it from a list. A dropdown cannot show that,
 * because the thing it would have to show is a position on a scale rather than
 * one of five names — and half the positions on that scale are not rungs of any
 * file.
 *
 * So it is a slider, and it is two instruments in one:
 *
 * - **a readout.** The thumb slides as the map is zoomed, continuously,
 *   because the resolution a window *would* be read at is a smooth function of
 *   its width. The label under it says what is actually drawn, which steps as
 *   blocks land. Thumb where you are asking, label what you have — and the gap
 *   between them, for the moment it lasts, is exactly the read.
 * - **a control.** Dragging it zooms the map to the width that yields that
 *   resolution, about the middle of what is on screen. Which makes it the one
 *   control in this application that navigates by *scale* rather than by place:
 *   the region box says where to look, this says how closely.
 *
 * It does not name rungs and it does not switch files. Where a laddered
 * container has a level that suits the window, `chooseRung` takes it
 * (`ui/refine.ts`) — which is a fact about where the numbers came from, not
 * about what the reader asked for, and belongs in the note under the map with
 * the other provenance.
 *
 * **Logarithmic, because resolution is.** The interesting range runs from a
 * genome in one picture to a kilobase in a cell — three or four orders of
 * magnitude — and a linear slider spends nine tenths of its travel in the
 * coarsest tenth of that. Ticks mark the powers of two, which is the ladder's
 * own staircase (`REFINE_FACTOR`), so the positions a read actually lands on
 * are the positions with a mark under them.
 */

import { el } from './dom'
import { formatBpTick } from '../render/heatmap'

/** Slider positions. Fine enough that a drag is continuous, coarse enough to be integral. */
const STEPS = 1000

/**
 * How wide the thumb is, for placing the ticks under it.
 *
 * A number here rather than a measurement, because the thing being matched is a
 * native control the page does not style and cannot interrogate: there is no
 * way to ask a range input how wide its thumb is. 14 px is what every engine
 * this app targets draws at the default font size, and being a pixel out puts a
 * tick a pixel off a mark nobody is reading to the pixel.
 */
const THUMB = 14

/** What the bar needs to know, and what it does when it is moved. */
export interface ResolutionBarProps {
  /**
   * Zoom the map so that the window on screen is the width this resolution is
   * read at, about the middle of what is showing.
   */
  onPick(bp: number): void
}

/** The range and the reading, in base pairs per drawn cell. */
export interface ResolutionState {
  /** The file's own bins — the finest grid there is, and the end of the ladder. */
  finest: number
  /** The coarsest grid this view has shown: its whole domain in one picture. */
  coarsest: number
  /** What is drawn right now — `MatrixResult.binsize × binsPerCell`. */
  drawn: number
  /**
   * What the window on screen could be drawn at, if it were read now.
   *
   * **Not where the thumb goes**, and the first version of this put it there.
   * The reason it cannot is the ladder's own tolerance: a block is left alone
   * while it is within `REFINE_FACTOR` of ideal, so at rest `drawn` sits
   * somewhere between this and twice it — and a thumb reading one while the
   * label under it reads the other is a control arguing with itself on every
   * frame, for ever, about a difference that is deliberate.
   *
   * So the thumb follows {@link drawn} and this decides one thing: whether the
   * picture is behind what the window is asking for by more than that
   * tolerance, which is what the bar shows as pending.
   */
  wanted: number
}

export class ResolutionBar {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly readout: HTMLElement
  private readonly ticks: HTMLElement
  private state: ResolutionState | null = null
  /** True while the pointer owns the thumb, so a redraw does not fight the drag. */
  private dragging = false

  constructor(props: ResolutionBarProps) {
    this.input = el('input', {
      class: 'res-slider',
      type: 'range',
      title:
        'Resolution. Drag to zoom the map to the width this cell size is read at; it also ' +
        'follows the map when you zoom it yourself. Coarse to the left, the file’s own bins to ' +
        'the right. The number below is what is drawn — while a finer block is on its way the ' +
        'thumb is ahead of it.',
    }) as HTMLInputElement
    this.input.min = '0'
    this.input.max = String(STEPS)
    this.input.step = '1'
    this.input.value = String(STEPS)
    this.ticks = el('div', { class: 'res-ticks', attrs: { 'aria-hidden': 'true' } })
    this.readout = el('span', { class: 'res-readout' })

    const move = (): void => {
      const held = this.state
      if (held === null) return
      props.onPick(this.bpAt(Number(this.input.value), held))
    }
    // `input`, not `change`: the map follows the thumb rather than waiting for
    // it to be let go. That is only affordable because a rung is a replay of
    // pixels already inflated rather than a read (`metacooler/pixelCache.ts`),
    // and it is the whole difference between a control and a form field.
    this.input.addEventListener('input', move)
    // The drag guard: while the pointer owns the thumb, the map is following
    // *it*, and writing the map's answer back into it would fight the hand.
    const grab = (): void => {
      this.dragging = true
    }
    const drop = (): void => {
      this.dragging = false
    }
    this.input.addEventListener('pointerdown', grab)
    this.input.addEventListener('pointerup', drop)
    this.input.addEventListener('pointercancel', drop)
    // A keyboard drag has no pointer to let go of, so it releases on blur.
    this.input.addEventListener('blur', drop)

    this.el = el(
      'div',
      { class: 'res-bar hidden' },
      el('span', { class: 'res-label', text: 'resolution' }),
      el('div', { class: 'res-track' }, this.ticks, this.input),
      this.readout,
    )
  }

  /**
   * Show a new reading.
   *
   * Cheap enough to call once a frame, which is how it is called: everything
   * below is guarded on the value it would write already being there, because
   * the common frame is a pan that changes nothing about the resolution at all.
   */
  update(state: ResolutionState | null): void {
    // Nothing to slide along: a MAG's block already *is* the finest data in the
    // file, so there is no ladder and a control for one would be a control that
    // cannot be used. Same rule as the score picker's single entry.
    const usable = state !== null && state.coarsest > state.finest * 1.01
    this.el.classList.toggle('hidden', !usable)
    if (!usable || state === null) {
      this.state = null
      return
    }
    const changed =
      this.state === null ||
      this.state.finest !== state.finest ||
      this.state.coarsest !== state.coarsest
    this.state = state
    if (changed) this.paintTicks(state)
    if (!this.dragging) {
      const value = String(this.stepAt(state.drawn, state))
      if (this.input.value !== value) this.input.value = value
    }
    const text = cellSize(state.drawn)
    if (this.readout.textContent !== text) this.readout.textContent = text
    // Behind by more than the ladder tolerates: a finer block is on its way, or
    // is about to be. The same fact the spinner in the plot's corner states,
    // said where the number is.
    this.el.classList.toggle('is-pending', state.drawn > state.wanted * 2.05)
  }

  /** Base pairs per cell at a slider position; the inverse of {@link stepAt}. */
  private bpAt(step: number, state: ResolutionState): number {
    const t = Math.min(1, Math.max(0, step / STEPS))
    const span = Math.log(state.coarsest / state.finest)
    return state.finest * Math.exp(span * (1 - t))
  }

  /** Slider position for a resolution; the inverse of {@link bpAt}. */
  private stepAt(bp: number, state: ResolutionState): number {
    const span = Math.log(state.coarsest / state.finest)
    if (!(span > 0)) return STEPS
    const t = 1 - Math.log(Math.max(state.finest, Math.min(state.coarsest, bp)) / state.finest) / span
    return Math.round(Math.min(1, Math.max(0, t)) * STEPS)
  }

  /**
   * A mark at every doubling, because those are the grids a read lands on.
   *
   * The ladder only replaces a block when the grid is off by `REFINE_FACTOR`,
   * so the staircase from the widest view to the file's own bins is
   * `finest × 2ⁿ` — and a slider whose ticks were at round base-pair numbers
   * would put its marks between the stops rather than on them.
   */
  private paintTicks(state: ResolutionState): void {
    const marks: HTMLElement[] = []
    for (let bp = state.finest; bp <= state.coarsest * 1.01; bp *= 2) {
      const t = this.stepAt(bp, state) / STEPS
      // Inset by half a thumb at each end. A native range thumb's *centre*
      // travels between `THUMB/2` and `width − THUMB/2`, so a mark placed at a
      // flat percentage of the box agrees with the thumb in the middle and
      // misses it by half a thumb at the ends — which reads as the scale being
      // wrong rather than as the geometry of a slider.
      const left = `calc(${(THUMB / 2).toFixed(1)}px + ${(t * 100).toFixed(3)}% - ${(t * THUMB).toFixed(2)}px)`
      marks.push(el('span', { class: 'res-tick', style: { left } }))
    }
    this.ticks.replaceChildren(...marks)
  }
}

/** What one square covers, in the words the key under the map uses. */
function cellSize(bp: number): string {
  return bp < 1000 ? `${Math.round(bp)} bp` : formatBpTick(Math.round(bp))
}
