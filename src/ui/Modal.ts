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

import { button, el } from './dom'

export interface ModalProps {
  title: string
  /** Extra class on the panel, for width and layout. */
  variant?: string
  /** Built once, when the modal opens. */
  body(close: () => void): HTMLElement
  /** Called however the modal was dismissed, so the opener can forget it. */
  onClose?(): void
}

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

    const panel = el(
      'div',
      { class: `modal-panel${props.variant === undefined ? '' : ` ${props.variant}`}` },
      el(
        'header',
        { class: 'modal-head' },
        el('h2', { class: 'modal-title', text: props.title }),
        button('×', close, { class: 'btn-close', title: 'Close (Esc)' }),
      ),
      props.body(close),
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

    const focusable = panel.querySelector<HTMLElement>('input, select, button, [tabindex]')
    focusable?.focus()
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
