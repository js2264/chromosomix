/**
 * The colour-scale clip: a two-handled slider over the block's own value range,
 * with both bounds also typeable.
 *
 * It replaces a `vmax` number box beside an "auto vmax" checkbox, which could
 * express exactly one of the two bounds and only upwards from zero. That was
 * enough for raw counts, whose floor genuinely is zero, and wrong for anything
 * else: `log10` of a balanced matrix lives entirely below zero, so the only
 * reachable range was one that excluded every value in the file.
 *
 * Units are **transformed** units, the same ones `vmax` has always been in and
 * the ones the URL hash carries. A reader thinks in counts, so the caption under
 * the boxes prints the untransformed pair — and the colourbar, which is labelled
 * in counts throughout, remains the authority.
 */

import type { ValueRange } from '../render/scale'
import { el } from './dom'

/** Slider positions. Fine enough that a drag feels continuous at any width. */
const STEPS = 1000

export interface ClipRangeProps {
  /** A bound moved. `null` means "back to auto" — both bounds unset. */
  onChange(clip: ValueRange | null): void
  /** Render a transformed value in the units a reader reads, for the caption. */
  format(value: number): string
}

export class ClipRange {
  readonly el: HTMLElement

  private readonly lowRange: HTMLInputElement
  private readonly highRange: HTMLInputElement
  private readonly lowInput: HTMLInputElement
  private readonly highInput: HTMLInputElement
  private readonly autoButton: HTMLButtonElement
  private readonly fill: HTMLElement
  private readonly note: HTMLElement

  /** The span the slider covers. Widened, never narrowed, by a typed bound. */
  private extent: ValueRange = { vmin: 0, vmax: 1 }
  /** The bounds in force, always resolved — in auto they are what auto chose. */
  private value: ValueRange = { vmin: 0, vmax: 1 }
  private auto = true

  constructor(private readonly props: ClipRangeProps) {
    this.lowRange = this.buildSlider('lower bound of the colour scale')
    this.highRange = this.buildSlider('upper bound of the colour scale')
    this.fill = el('div', { class: 'clip-fill' })

    this.lowInput = this.buildBox('low')
    this.highInput = this.buildBox('high')

    this.autoButton = el('button', {
      class: 'btn btn-quiet clip-auto',
      type: 'button',
      text: 'auto',
      title: 'Back to the §7.1 default: the 99th percentile of the values in view.',
    })
    this.autoButton.addEventListener('click', () => {
      this.auto = true
      this.paint()
      this.props.onChange(null)
    })

    this.note = el('span', { class: 'clip-note' })

    this.el = el(
      'div',
      { class: 'clip' },
      el(
        'div',
        { class: 'clip-slider' },
        el('div', { class: 'clip-track' }, this.fill),
        this.lowRange,
        this.highRange,
      ),
      el('div', { class: 'clip-boxes' }, this.lowInput, this.highInput, this.autoButton),
      this.note,
    )
    this.paint()
  }

  /**
   * The span the slider covers — normally the block's whole value extent, so
   * both handles can reach every value that is actually on screen.
   *
   * `null` (an all-NaN block) leaves the previous span in place: there is
   * nothing to draw, and collapsing the control to a point would only make the
   * next block's arrival look like a jump.
   */
  setExtent(extent: ValueRange | null): void {
    if (extent === null || !(extent.vmax > extent.vmin)) return
    this.extent = extent
    this.paint()
  }

  /**
   * Adopt the bounds actually in force.
   *
   * @param auto Whether these came from the automatic rule rather than the user.
   * In auto the boxes keep showing them — they are the numbers a reader would
   * otherwise have to guess before nudging one.
   */
  setValues(value: ValueRange, auto: boolean): void {
    this.value = value
    this.auto = auto
    this.paint()
  }

  private buildSlider(label: string): HTMLInputElement {
    const node = el('input', {
      class: 'clip-handle',
      type: 'range',
      attrs: { min: '0', max: String(STEPS), step: '1', 'aria-label': label },
    })
    node.addEventListener('input', () => this.fromSliders(node))
    return node
  }

  private buildBox(which: 'low' | 'high'): HTMLInputElement {
    const node = el('input', {
      class: 'input input-num clip-box',
      type: 'number',
      attrs: { step: 'any', 'aria-label': `${which} clip value` },
      title:
        'In transformed units — the same ones the colourbar is built from. ' +
        'The low bound must stay below the high one.',
    })
    node.addEventListener('change', () => this.fromBox(which, node))
    return node
  }

  /** A handle moved: the other one bounds it, one step apart at the closest. */
  private fromSliders(moved: HTMLInputElement): void {
    const low = Number(this.lowRange.value)
    const high = Number(this.highRange.value)
    if (low >= high) {
      if (moved === this.lowRange) this.lowRange.value = String(Math.max(0, high - 1))
      else this.highRange.value = String(Math.min(STEPS, low + 1))
    }
    this.commit({
      vmin: this.atStep(Number(this.lowRange.value)),
      vmax: this.atStep(Number(this.highRange.value)),
    })
  }

  /**
   * A bound was typed. An unparseable or inverted value is refused — the box
   * snaps back to what it was showing, which is the whole of the feedback a
   * two-number control needs.
   */
  private fromBox(which: 'low' | 'high', box: HTMLInputElement): void {
    const typed = Number(box.value)
    const other = which === 'low' ? this.value.vmax : this.value.vmin
    const valid = Number.isFinite(typed) && (which === 'low' ? typed < other : typed > other)
    if (!valid) {
      this.paint()
      return
    }
    const next =
      which === 'low' ? { vmin: typed, vmax: other } : { vmin: other, vmax: typed }
    // A typed bound outside the block's range is a legitimate ask — clipping
    // below the sparsest cell is how a saturated map is rescued — so the slider
    // grows to include it rather than snapping it back inside.
    this.extent = {
      vmin: Math.min(this.extent.vmin, next.vmin),
      vmax: Math.max(this.extent.vmax, next.vmax),
    }
    this.commit(next)
  }

  private commit(value: ValueRange): void {
    this.value = value
    this.auto = false
    this.paint()
    this.props.onChange(value)
  }

  /** Slider position → value. */
  private atStep(step: number): number {
    const { vmin, vmax } = this.extent
    return vmin + ((vmax - vmin) * step) / STEPS
  }

  /** Value → slider position, clamped to the ends. */
  private toStep(value: number): number {
    const { vmin, vmax } = this.extent
    const span = vmax - vmin
    if (!(span > 0)) return 0
    return Math.round(Math.min(STEPS, Math.max(0, ((value - vmin) / span) * STEPS)))
  }

  /** Redraw every part from `value`, `extent` and `auto`. */
  private paint(): void {
    const lowStep = this.toStep(this.value.vmin)
    const highStep = this.toStep(this.value.vmax)
    this.lowRange.value = String(lowStep)
    this.highRange.value = String(highStep)
    this.fill.style.left = `${(lowStep / STEPS) * 100}%`
    this.fill.style.right = `${100 - (highStep / STEPS) * 100}%`

    // Never while it is being typed in: a redraw lands on every animation frame
    // the heatmap schedules, and rewriting the box under the caret eats digits.
    this.setBox(this.lowInput, this.value.vmin)
    this.setBox(this.highInput, this.value.vmax)

    this.el.classList.toggle('clip-manual', !this.auto)
    this.autoButton.disabled = this.auto
    this.note.textContent = this.auto
      ? `auto · ${this.props.format(this.value.vmin)} – ${this.props.format(this.value.vmax)}`
      : `clipped · ${this.props.format(this.value.vmin)} – ${this.props.format(this.value.vmax)}`
  }

  private setBox(box: HTMLInputElement, value: number): void {
    if (document.activeElement === box) return
    box.value = Number.isFinite(value) ? trimNumber(value) : ''
  }
}

/**
 * Four significant digits, without the exponent a `toPrecision` would print for
 * an ordinary number. The box is a starting point for an edit, not a readout —
 * `-4.678` is something to nudge, `-4.678039550781250` is not.
 */
function trimNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return value.toExponential(3)
  return String(Number(value.toPrecision(4)))
}
