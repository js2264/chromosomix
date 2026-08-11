/**
 * A modal dialog: overlay, one focused panel, Escape to leave.
 *
 * `<dialog>` is deliberately not used. Its `showModal()` puts the element in
 * the top layer, which is exactly right, but it also brings a backdrop this app
 * cannot style consistently across the two themes and a close behaviour that
 * differs between browsers. The dialogs here are three small panels; owning the
 * behaviour outright costs less than working around the built-in one.
 *
 * Focus is returned to whatever had it when the dialog opened. That is not
 * politeness: the palette is opened from the keyboard, and a keyboard user who
 * closes it should still be where they were.
 */

import { el } from './dom'
import { iconButton } from './icons'

export interface ModalProps {
  title: string
  /** Extra class on the panel, for width and layout. */
  variant?: string
  /** Built once, when the modal opens. */
  body(close: () => void): HTMLElement
  /** Called however the modal was dismissed, so the opener can forget it. */
  onClose?(): void
}

/**
 * What counts as a control the caret may land on, in document order.
 *
 * `:not([disabled])` because a dialog whose first button is greyed out is a
 * dialog that opens with the caret nowhere a key can reach.
 */
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]'

export class Modal {
  private readonly props: ModalProps
  private closed = false
  private readonly root: HTMLElement
  private readonly previouslyFocused: HTMLElement | null
  private readonly onKeyDown: (event: KeyboardEvent) => void

  constructor(props: ModalProps) {
    this.props = props
    this.previouslyFocused = document.activeElement as HTMLElement | null
    const close = (): void => this.close()

    const body = props.body(close)
    const panel = el(
      'div',
      { class: `modal-panel${props.variant === undefined ? '' : ` ${props.variant}`}` },
      el(
        'header',
        { class: 'modal-head' },
        el('h2', { class: 'modal-title', text: props.title }),
        iconButton('x', 'Close (Esc)', close, { class: 'btn-close', size: 16 }),
      ),
      body,
    )
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')

    this.root = el('div', { class: 'modal-backdrop' }, panel)
    // A click on the backdrop closes; a click inside the panel must not, or
    // selecting text in the dialog would dismiss it.
    this.root.addEventListener('mousedown', (event) => {
      if (event.target === this.root) close()
    })

    this.onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', this.onKeyDown, true)
    document.body.appendChild(this.root)

    // The **body's** first control, and the panel's only if the body has none.
    //
    // A selector list answers in document order, and the close button is in the
    // header — so "the first focusable in the panel" was always the ✕, on every
    // dialog in the application. The caret landed on Close, Enter dismissed
    // instead of submitting, and a keyboard user opening the file dialog had to
    // Tab past the one control that throws their work away to reach the box they
    // came for.
    const first =
      body.querySelector<HTMLElement>(FOCUSABLE) ?? panel.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.root.remove()
    this.previouslyFocused?.focus?.()
    this.props.onClose?.()
  }
}
