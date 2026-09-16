/**
 * The head of a provider's pane, and the one button under it.
 *
 * A pane that signs a reader in to somebody else's service (Google Drive,
 * Dropbox) has one thing to offer — the sign-in — and a page of things worth
 * knowing before pressing it: what the grant is, where the token goes, what is
 * kept. Both used to be on the pane, the knowledge as three paragraphs above
 * the button, and a reader who came to press *sign in* read a consent notice
 * first. The pane is now a **title**, a **`?`** at the far right of the same
 * line, and the **button**; the paragraphs are behind the `?`, shown on hover
 * or on focus, so they are one gesture away for the reader who wants them and
 * out of the way of the one who does not.
 *
 * ## What goes behind the `?`, and what does not
 *
 * Everything §24.7 requires the dialog to *say* goes behind it: it requires
 * the sentences because a consent screen says neither, and a tooltip on the
 * page that hands over the credential is still the page saying them. What
 * stays visible is what a reader has to *act on*: the button, the reason a
 * button is disabled, the code box a sign-in flow opens, an error. A sentence
 * that tells a reader what to do next is not information about the service; it
 * is the pane's own next step.
 *
 * ## Why a real button and a real tooltip
 *
 * The `?` is a `<button>` with `aria-describedby` on the tip and the tip has
 * `role="tooltip"`, so a keyboard reaches it (`:focus-visible` shows the tip)
 * and a screen reader reads it as the description of the control it is on.
 * Hover shows it for a mouse; a click pins it, for a touch screen that has no
 * hover to give.
 *
 * ## Why the tip is placed by hand
 *
 * The dialog's body scrolls and its panel clips (`overflow: hidden`, for the
 * rounded corners), and a tip that hangs below a one-button pane is always
 * taller than what is left of the panel under it: positioned inside the pane
 * it was cut off at the panel's edge. So it is `position: fixed` — which no
 * ancestor's overflow clips, the modal having no transform to re-parent it —
 * and set under the `?`'s right edge from the button's own rectangle each time
 * it is about to show. Sized to the room under it, and scrolling inside itself
 * when there is less than it needs.
 */

import { el } from './dom'
import { icon, markButton, type IconName } from './icons'

/**
 * A block of configuration inside a tip, for the reader to copy.
 *
 * `white-space: pre` in the stylesheet and nothing else: what goes in here is
 * JSON somebody has to paste into a console exactly as it is, so it is never
 * re-wrapped to the tip's width.
 */
export function tipCode(text: string): HTMLElement {
  return el('pre', { class: 'connect-tip-code' }, el('code', { text }))
}

let tipSerial = 0

/** The space between the ? and the tip's top edge, in CSS pixels — the outer box's padding in `styles.css`. */
const TIP_GAP = 6
/** What the tip keeps clear of the viewport's edges. */
const TIP_MARGIN = 12
/** Below this the tip is a slot rather than a reader, so it may run past the bottom. */
const TIP_MIN_HEIGHT = 140

/**
 * The head: the title on the left, the `?` on the right, the tip behind it.
 *
 * `lines` are the paragraphs of the tip, in the order they are read. A string
 * becomes a paragraph; an element is placed as it is, which is how a pane whose
 * subject is a *configuration* rather than a consent gets a code block into its
 * tip — a CORS policy described in prose is a policy nobody can paste. They are
 * built once; what a state change alters on these panes is the button, never
 * the facts about the service.
 */
export function connectHead(
  title: string,
  mark: IconName,
  lines: Array<string | HTMLElement>,
): HTMLElement {
  const id = `connect-tip-${++tipSerial}`
  // Two boxes: the outer is the tip's place and carries the gap under the ?
  // as padding, so a pointer on its way down into it never leaves the hover;
  // the inner is what is drawn, and what scrolls when there is less room than
  // it needs.
  const box = el(
    'div',
    { class: 'connect-tip-box' },
    ...lines.map((line) => (typeof line === 'string' ? el('p', { text: line }) : line)),
  )
  const tip = el('div', { class: 'connect-tip', id, attrs: { role: 'tooltip' } }, box)
  const help = el('button', {
    class: 'connect-help',
    type: 'button',
    text: '?',
    attrs: { 'aria-label': `About ${title}`, 'aria-describedby': id, 'aria-expanded': 'false' },
  })
  const wrap = el('span', { class: 'connect-help-wrap' }, help, tip)
  // Under the ?'s right edge, in viewport terms, with the room below it: read
  // afresh on every show, since the dialog's body may have scrolled since.
  const place = (): void => {
    const at = help.getBoundingClientRect()
    const width = document.documentElement.clientWidth
    tip.style.top = `${at.bottom}px`
    tip.style.right = `${Math.max(TIP_MARGIN, width - at.right)}px`
    box.style.maxHeight = `${Math.max(TIP_MIN_HEIGHT, window.innerHeight - at.bottom - TIP_GAP - TIP_MARGIN)}px`
  }
  help.addEventListener('pointerenter', place)
  help.addEventListener('focus', place)
  // Pinned on a click, for a finger: hover shows the tip for a mouse and
  // focus shows it for a keyboard, and a touch screen has neither.
  help.addEventListener('click', () => {
    place()
    const open = wrap.classList.toggle('is-open')
    help.setAttribute('aria-expanded', String(open))
  })
  help.addEventListener('blur', () => {
    wrap.classList.remove('is-open')
    help.setAttribute('aria-expanded', 'false')
  })
  return el(
    'div',
    { class: 'connect-head' },
    el('h3', {}, icon(mark, { size: 15 }), el('span', { text: title })),
    wrap,
  )
}

/**
 * The sign-in: one large button with the provider's mark on it.
 *
 * {@link markButton}'s shape, which the landing page's own row of places now
 * draws too (`ui/FilePicker.ts`): a door to Drive is the same gesture wherever
 * a reader meets it, so it is the same button. The extra class is what this
 * pane's sign-in is still called, and the tests that name it are naming the
 * one control in the app that hands over a credential.
 *
 * Disabled with its reason as the title where the site has no registration —
 * the exception to §8.5 these panes make, because the sentence beside it names
 * the one thing a reader can do — and pressable everywhere else.
 */
export function signInButton(
  label: string,
  mark: IconName,
  onClick: () => void,
  options: { disabled: boolean; reason?: string },
): HTMLButtonElement {
  return markButton(label, mark, onClick, {
    class: 'btn btn-mark btn-signin',
    disabled: options.disabled,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
}
