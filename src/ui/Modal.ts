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
 *
 * What `showModal()` also brings, and what therefore has to be brought by hand,
 * is **containment**: while a dialog is up, the rest of the document is neither
 * tabbable nor operable. Both halves are here — the page behind the backdrop is
 * marked `inert`, and Tab is cycled within the panel — because without them
 * `aria-modal="true"` below is a claim and not a fact. A reader who pressed Tab
 * once left the panel, landed on a control the dimmed backdrop was covering, and
 * closed a session or folded a column with Enter under a dialog they were still
 * looking at; a screen reader, meanwhile, was told to ignore a page that was
 * fully exposed and fully operable.
 */

import { el } from './dom'
import { iconButton } from './icons'

export interface ModalProps {
  title: string
  /** Extra class on the panel, for width and layout. */
  variant?: string
  /**
   * The title is a **name out of a file**, so the heading leaves its case alone.
   *
   * `.modal-title` uppercases, which is right for the category a dialog is —
   * *SHARE THIS TAB*, *ADD A RESOLUTION* — and wrong for a thing the file named:
   * the enlarged 3D cell was headed `YEAST_STRUCTURE` over a card, a tab and a
   * Structures row all calling it `Yeast_structure`, and in genomics a name whose
   * case has been changed is a different name.
   */
  titleIsName?: boolean
  /**
   * What Escape does instead of closing, for a dialog that holds work.
   *
   * The edit stage (§27.3) answers Escape by cancelling whatever is innermost —
   * a drag, a selection — and never by closing: a key that means *stop what I
   * am doing* must not also throw away an hour of it. Such a dialog is closed
   * by its ✕ alone, and a press on the backdrop does nothing either.
   */
  onEscape?(): void
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
  /** What this dialog took out of the page, and must put back. */
  private readonly inerted: readonly HTMLElement[]

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
        el('h2', {
          class: `modal-title${props.titleIsName === true ? ' is-name' : ''}`,
          text: props.title,
        }),
        iconButton('x', props.onEscape === undefined ? 'Close (Esc)' : 'Close', close, { class: 'btn-close', size: 16 }),
      ),
      body,
    )
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')

    this.root = el('div', { class: 'modal-backdrop' }, panel)
    // A click on the backdrop closes; a click inside the panel must not, or
    // selecting text in the dialog would dismiss it.
    this.root.addEventListener('mousedown', (event) => {
      if (event.target === this.root && props.onEscape === undefined) close()
    })

    this.onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (props.onEscape !== undefined) props.onEscape()
        else close()
        return
      }
      if (event.key !== 'Tab') return
      // Only the dialog on top answers for the caret. Two can be up at once — a
      // load gate raised over the palette, a bucket browser over Connect — and
      // every one of them is listening on the window, so without this each
      // would pull the caret into its own panel on the same keystroke and none
      // of them would move. The last backdrop in the body is the one on top.
      const dialogs = document.querySelectorAll('.modal-backdrop')
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== this.root) return
      // The caret cycles inside the panel: off the last stop it wraps to the
      // first, off the first it wraps back to the last, and anything focused
      // outside — a background control the reader reached before this dialog
      // opened, or nothing at all — is pulled in. `inert` does this for us in
      // every browser that has it; this is the half that does not depend on
      // that, and the only half a jsdom test can see.
      //
      // `FOCUSABLE` ends in a bare `[tabindex]`, which matches `-1` as well, so
      // the stops are filtered down to the ones a Tab could actually reach.
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.tabIndex >= 0,
      )
      // A dialog with nothing to land on keeps the caret rather than handing it
      // to the page behind: there is no stop to move to, and the next Tab out
      // would be the escape this whole branch exists to close.
      if (stops.length === 0) {
        event.preventDefault()
        return
      }
      const first = stops[0]
      const last = stops[stops.length - 1]
      const at = document.activeElement
      if (at === null || !panel.contains(at)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && at === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && at === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', this.onKeyDown, true)

    // Everything the backdrop covers is taken out of the page for as long as
    // the dialog is up, which is what `aria-modal` above has always said and
    // never enforced.
    //
    // Read **before** the root is appended, so the dialog is never in its own
    // list, and skipping what is already inert is what makes a dialog opened
    // over another safe: the inner one puts back only what it took, leaving the
    // outer one's page still inert when it goes.
    this.inerted = [...document.body.children].filter(
      (node): node is HTMLElement => node instanceof HTMLElement && !node.hasAttribute('inert'),
    )
    for (const node of this.inerted) node.setAttribute('inert', '')

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
    // Before the caret is handed back, and the order is not cosmetic: an inert
    // subtree refuses focus, so restoring first would leave the keyboard on
    // nothing — which is the failure this dialog exists to avoid.
    for (const node of this.inerted) node.removeAttribute('inert')
    this.previouslyFocused?.focus?.()
    this.props.onClose?.()
  }
}
