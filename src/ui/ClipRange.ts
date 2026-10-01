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
 * Units are **transformed** units, the same ones `vmax` has always been in, the
 * ones the URL hash carries, and the ones the key in the map's corner prints
 * and takes typed — its title names the transform, `Balanced (log10)`. A reader
 * thinks in counts, so the caption under the boxes prints the untransformed
 * pair, in the units the readout under the pointer uses.
 *
 * Both of those numbers are on screen at once — `-4.182` in a box, `0.000066`
 * in the caption — so both say what they are: the caller puts the transform in
 * the field's label (`clip (log10)`) and hands the caption's own unit word in
 * through {@link ClipRangeProps.unit}, which is the score the counts are in.
 * Unnamed, the pair reads as a contradiction, and a reader who typed the
 * caption's number into the box clipped the map a thousandfold too high.
 */

import type { ValueRange } from '../render/scale'
import { el, trimNumber } from './dom'
import { iconButton } from './icons'

export interface ClipRangeProps {
  /** A bound moved. `null` means "back to auto" — both bounds unset. */
  onChange(clip: ValueRange | null): void
  /** Render a transformed value in the units a reader reads, for the caption. */
  format(value: number): string
  /**
   * What the caption's numbers are in — `balanced`, `counts`, `O/E`.
   *
   * A function rather than a string, because the score can change under a
   * mounted control. Empty, or absent, prints no unit word: a card whose
   * caption is in the same units as its boxes has nothing to disambiguate.
   */
  unit?(): string
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
  /** Whether a block has been drawn yet, so the caption has something to state. */
  private scaled = false

  constructor(private readonly props: ClipRangeProps) {
    this.lowInput = this.buildBox('low')
    this.highInput = this.buildBox('high')

    // The same mark autoscale carries everywhere else in this application,
    // because it is the same action: hand the range back to the data.
    this.autoButton = iconButton(
      'chevrons-up-down',
      'Back to auto: 0 to the 99th percentile of the values in view.',
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
    if (this.scaled && auto === this.auto && value.vmin === this.value.vmin && value.vmax === this.value.vmax) {
      return
    }
    this.scaled = true
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
    // `''` and not `Number('')`, which is `0`. A `type="number"` box reports an
    // empty string both for a cleared box and for anything the browser could not
    // parse — `1e`, `--`, a pasted word — and reading either as zero is how
    // clearing a bound came to *set* one: on a log10 scale, whose values live
    // below zero, an emptied high box silently clipped the map at 1.
    const raw = box.value.trim()
    const typed = raw === '' ? Number.NaN : Number(raw)
    const other = which === 'low' ? this.value.vmax : this.value.vmin
    const valid = Number.isFinite(typed) && (which === 'low' ? typed < other : typed > other)
    if (!valid) {
      // Written straight into the box rather than through {@link paint}, which
      // leaves a focused box alone. `change` fires on Enter with the caret still
      // in it, so going through the guard meant the refusal was invisible for the
      // one way of committing a value that does not move the focus — the reader
      // was left reading a bound that is not the bound in force.
      box.value = trimNumber(which === 'low' ? this.value.vmin : this.value.vmax)
      this.paint()
      return
    }
    const next =
      which === 'low' ? { vmin: typed, vmax: other } : { vmin: other, vmax: typed }
    this.value = next
    this.auto = false
    // A typed bound is a range whoever typed it can be told about, whether or
    // not a block has been drawn yet — which is the other half of the caption's
    // silence below.
    this.scaled = true
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
    // Nothing until a block has been scaled. The control starts on `{0, 1}`,
    // which is a placeholder rather than a range, and printing `auto · 1 – 10`
    // beside a view that has drawn nothing yet — the whole-genome gate — is the
    // card claiming to describe a picture that is not there (§8.5).
    if (!this.scaled) {
      this.note.textContent = ''
      return
    }
    const unit = this.props.unit?.() ?? ''
    const range = `${this.props.format(this.value.vmin)} – ${this.props.format(this.value.vmax)}`
    this.note.textContent = `${this.auto ? 'auto' : 'clipped'} · ${range}${unit === '' ? '' : ` ${unit}`}`
  }

  private setBox(box: HTMLInputElement, value: number): void {
    if (document.activeElement === box) return
    box.value = trimNumber(value)
  }
}
