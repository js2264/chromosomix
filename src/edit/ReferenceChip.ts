/**
 * The heading's word on the reference (SPECS §27.3): *as in the file*, or
 * *edited · 7 steps* — lit, because the whole session is then drawn through an
 * edit (§27.7) and that is a state of the tab, not of one picture.
 *
 * A press opens the stage; the arrow beside an edited one reverts to the file,
 * which is every step undone and kept to be redone — so the arrow is one more
 * undo, never a loss. One element for the life of the file, which the
 * breadcrumb re-seats on every render, as it does the contacts box.
 */

import { el } from '../ui/dom'
import { icon, iconButton, setPressed } from '../ui/icons'

export interface ReferenceChipProps {
  /** Steps applied. */
  steps(): number
  /** Open the stage. */
  onOpen(): void
  /** Every step undone. */
  onRevert(): void
}

export class ReferenceChip {
  readonly el: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly text: HTMLElement
  private readonly revert: HTMLButtonElement

  constructor(private readonly props: ReferenceChipProps) {
    this.text = el('span')
    this.button = el('button', {
      class: 'btn btn-toggle crumb-reference-button',
      attrs: { type: 'button', 'aria-pressed': 'false' },
      title: 'Edit the reference on a stage of its own: cut, turn, move, copy and join, with the map redrawn as you go',
      on: { click: () => props.onOpen() },
    })
    this.button.append(icon('scissors', { size: 13 }), this.text)
    this.revert = iconButton('undo-2', 'Revert to the file: every step undone, and kept to be redone', () => props.onRevert(), {
      class: 'btn btn-icon crumb-reference-revert',
      size: 13,
    })
    this.el = el(
      'div',
      { class: 'crumb-reference' },
      el('span', { class: 'res-label', text: 'reference' }),
      this.button,
      this.revert,
    )
    this.sync()
  }

  sync(): void {
    const steps = this.props.steps()
    this.text.textContent = steps === 0 ? 'as in the file' : `edited · ${steps} ${steps === 1 ? 'step' : 'steps'}`
    setPressed(this.button, steps > 0)
    this.revert.classList.toggle('hidden', steps === 0)
  }
}
