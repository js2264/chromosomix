/**
 * The heading's word on the genomes (SPECS §33.4): `genomes · as in the file`,
 * or `genomes · curated · 7 steps` — lit, because the whole session is then
 * drawn through a curated binning and that is a state of the tab, not of one
 * picture.
 *
 * A press opens the curation stage; the arrow beside a curated one puts the
 * file's binning back, which is every step undone and kept to be redone — so
 * the arrow is one more undo, never a loss. One element for the life of the
 * file, which the breadcrumb re-seats on every render, as it does the reference
 * edit's word beside it (`edit/ReferenceChip.ts`).
 */

import { el } from '../ui/dom'
import { icon, iconButton, setPressed } from '../ui/icons'

export interface CurationChipProps {
  /** Steps applied. */
  steps(): number
  /** Open the stage. */
  onOpen(): void
  /** Every step undone. */
  onRevert(): void
}

export class CurationChip {
  readonly el: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly text: HTMLElement
  private readonly revert: HTMLButtonElement

  constructor(private readonly props: CurationChipProps) {
    this.text = el('span')
    this.button = el('button', {
      class: 'btn btn-toggle crumb-reference-button crumb-genomes-button',
      attrs: { type: 'button', 'aria-pressed': 'false' },
      title: 'Curate the genomes on a stage of their own: move contigs, merge, recruit, gather mobile elements and their hosts, with the session drawn through the curated binning',
      on: { click: () => props.onOpen() },
    })
    this.button.append(icon('merge', { size: 13 }), this.text)
    this.revert = iconButton('undo-2', 'Back to the file’s binning: every step undone, and kept to be redone', () => props.onRevert(), {
      class: 'btn btn-icon crumb-reference-revert crumb-genomes-revert',
      size: 13,
    })
    this.el = el(
      'div',
      { class: 'crumb-reference crumb-genomes' },
      el('span', { class: 'res-label', text: 'genomes' }),
      this.button,
      this.revert,
    )
    this.sync()
  }

  sync(): void {
    const steps = this.props.steps()
    this.text.textContent = steps === 0 ? 'as in the file' : `curated · ${steps} ${steps === 1 ? 'step' : 'steps'}`
    setPressed(this.button, steps > 0)
    this.revert.classList.toggle('hidden', steps === 0)
  }
}
