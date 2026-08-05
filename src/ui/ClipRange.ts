/**
 * The colour-scale clip: two typed bounds, and a button back to auto.
 *
 * It replaces a `vmax` number box beside an "auto vmax" checkbox, which could
 * express exactly one of the two bounds and only upwards from zero. That was
 * enough for raw counts, whose floor genuinely is zero, and wrong for anything
 * else: `log10` of a balanced matrix lives entirely below zero, so the only
 * reachable range was one that excluded every value in the file.
 *
 * It carried a two-handled slider over the block's value extent for a while.
 * The boxes outlived it: a clip is two numbers a reader arrives at by reading
 * the colourbar, and picking them off a 200-pixel track meant a range of about
 * four significant figures per pixel and no way to type the one you wanted
 * without going through the box anyway.
 *
 * Units are **transformed** units, the same ones `vmax` has always been in and
 * the ones the URL hash carries. A reader thinks in counts, so the caption under
 * the boxes prints the untransformed pair — and the colourbar, which is labelled
 * in counts throughout, remains the authority.
 */

import type { ValueRange } from '../render/scale'
import { el, trimNumber } from './dom'
import { iconButton } from './icons'

export interface ClipRangeProps {
  /** A bound moved. `null` means "back to auto" — both bounds unset. */
  onChange(clip: ValueRange | null): void
  /** Render a transformed value in the units a reader reads, for the caption. */
  format(value: number): string
}

export class ClipRange {
  readonly el: HTMLElement

  private readonly lowInput: HTMLInputElement
  private readonly highInput: HTMLInputElement
  private readonly autoButton: HTMLButtonElement
  private readonly note: HTMLElement

  /** The bounds in force, always resolved — in auto they are what auto chose. */
  private value: ValueRange = { vmin: 0, vmax: 1 }
  private auto = true

  constructor(private readonly props: ClipRangeProps) {
    this.lowInput = this.buildBox('low')
    this.highInput = this.buildBox('high')

    // The same mark autoscale carries everywhere else in this application,
    // because it is the same action: hand the range back to the data.
    this.autoButton = iconButton(
      'chevrons-up-down',
      'Back to the §7.1 default: the 99th percentile of the values in view.',
      () => {
        this.auto = true
        this.paint()
        this.props.onChange(null)
      },
      { class: 'btn btn-icon clip-auto', size: 14 },
    )

    this.note = el('span', { class: 'clip-note' })

    this.el = el(
      'div',
      { class: 'clip' },
      el('div', { class: 'clip-boxes' }, this.lowInput, this.highInput, this.autoButton),
      this.note,
    )
    this.paint()
  }

  /**
   * Adopt the bounds actually in force.
   *
   * @param auto Whether these came from the automatic rule rather than the user.
   * In auto the boxes keep showing them — they are the numbers a reader would
   * otherwise have to guess before nudging one.
   */
  /**
   * Show the bounds the renderer actually resolved.
   *
   * Called once per animation frame while the panel is being dragged, and the
   * numbers move only when the *scale* does — so the early return is what keeps
   * a pan from formatting two floats, building a caption and writing four DOM
   * properties sixty times a second for output that is byte-identical.
   */
  setValues(value: ValueRange, auto: boolean): void {
    if (auto === this.auto && value.vmin === this.value.vmin && value.vmax === this.value.vmax) {
      return
    }
    this.value = value
    this.auto = auto
    this.paint()
  }

  private buildBox(which: 'low' | 'high'): HTMLInputElement {
    const node = el('input', {
      class: 'input input-num clip-box',
      type: 'number',
      // Without a size an `<input>` asks for about twenty characters' worth of
      // room, and asks for it as a *minimum*: in a column of controls that one
      // intrinsic width stretched every row beside it past the card and off the
      // screen. The box is sized by its column here, so it declares one digit.
      attrs: { step: 'any', size: '1', 'aria-label': `${which} clip value` },
      title:
        'In transformed units — the same ones the colourbar is built from. ' +
        'The low bound must stay below the high one.',
    })
    node.addEventListener('change', () => this.fromBox(which, node))
    return node
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
    this.value = next
    this.auto = false
    this.paint()
    this.props.onChange(next)
  }

  /** Redraw every part from `value` and `auto`. */
  private paint(): void {
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
    box.value = trimNumber(value)
  }
}
