/**
 * A small, self-dismissing note for work that finishes *after* the thing the
 * reader was waiting for.
 *
 * There is exactly one job like that in the application, and this exists for
 * it: the `.mcool` written from a `.pairs` import. The map is already on
 * screen and already usable — the export is a second job over arrays that are
 * in memory, and blocking the view behind it would be making the reader wait
 * for a file rather than for a picture.
 *
 * So it is not a modal, not a panel, and not a line in the status bar. It is a
 * note in the corner that says what is happening, moves while it happens, and
 * takes itself away when it is done. A failure stays until it is dismissed,
 * because a download that silently did not happen is worse than one that says
 * so.
 *
 * The same corner serves a second, simpler case: something the reader did not
 * ask for has already happened and they need to be told once. The share dialog
 * puts the link on the clipboard the instant it exists, and a clipboard that
 * changed under somebody without a word is how a reader loses whatever they had
 * copied before. {@link messageToast} is that one line — same box, same ×, no
 * bar, gone in four seconds.
 */

import { el } from './dom'

export interface ProgressToast {
  update(done: number, total: number, note?: string): void
  /** Show a final line, then fade out. */
  finish(message: string): void
  /** Show a failure and leave it until the reader closes it. */
  fail(message: string): void
  /** Take it away now. */
  dismiss(): void
}

/** How long a finished note stays before it goes. */
const LINGER_MS = 4_000

/**
 * The corner the notes are drawn in: one column, made on demand, shared by both
 * kinds of note.
 *
 * `.toast` anchors *itself* to the bottom-right, which is right for one note and
 * wrong for two — the second is drawn on exactly the same pixels as the first
 * and hides it. That is not hypothetical. A truncated `.pairs` import raises the
 * "Incomplete file" warning, which is the one note in this application promised
 * to stay until it is dismissed, and then starts the `.mcool` write on the very
 * next statement (`app/Session.ts`); the progress note landed over the warning
 * and left the reader believing a chromosome genuinely has no contacts.
 *
 * So the corner is a column rather than a point. `column-reverse` keeps the
 * newest note nearest the corner and pushes the older ones up, so each keeps its
 * own text and its own ×. Both constructors reach it through
 * {@link toastShell}: one rule about where a note goes rather than one per kind,
 * which is how the two came to disagree in the first place.
 */
function stack(): HTMLElement {
  const found = document.querySelector<HTMLElement>('.toast-stack')
  if (found !== null) return found
  const node = el('div', {
    class: 'toast-stack',
    // The anchoring `.toast` carries in the stylesheet, one level up, so the
    // notes inside are otherwise exactly the boxes it describes. The column is
    // as wide as its widest note, so `pointer-events` is off on it and on again
    // for each note: a strip of nothing beside a short note must not swallow a
    // click meant for the map behind it.
    style: {
      position: 'fixed',
      right: '1rem',
      bottom: '1rem',
      zIndex: '90',
      display: 'flex',
      flexDirection: 'column-reverse',
      alignItems: 'flex-end',
      gap: '0.5rem',
      pointerEvents: 'none',
    },
  })
  document.body.appendChild(node)
  return node
}

/**
 * The box itself: the corner panel, the line of text, and the ×.
 *
 * Both notes are the same object to a reader — same corner, same border, same
 * dismiss — and the only difference is what sits under the first line. Built
 * once here rather than twice, because the halves that must not drift are the
 * ones nobody looks at: `role="status"` with `aria-live="polite"`, which is the
 * whole of what makes a corner note reach somebody using a screen reader, and
 * the class names the stylesheet positions by.
 *
 * The extra rows are appended *after* the label and inside `.toast-text`, which
 * is the order `progressToast` has always built — label, bar, note — so its DOM
 * comes out of here byte for byte what it was.
 */
function toastShell(
  message: string,
  ...rows: HTMLElement[]
): { root: HTMLElement; close: HTMLButtonElement; remove: () => void } {
  const label = el('p', { class: 'toast-label', text: message })
  const close = el('button', { class: 'toast-close', text: '×', title: 'Dismiss' })

  const root = el(
    'div',
    {
      class: 'toast',
      // Placed by the column rather than by itself; see {@link stack}. The
      // stylesheet anchors every `.toast` to the same corner, which is the
      // whole of why two of them used to be drawn on top of each other.
      style: { position: 'static', pointerEvents: 'auto' },
      attrs: { role: 'status', 'aria-live': 'polite' },
    },
    el('div', { class: 'toast-text' }, label, ...rows),
    close,
  )
  stack().appendChild(root)
  /**
   * Take this note away — and the column with it, when it was the last one.
   *
   * A column left standing would be inherited by whatever opens next: `Modal`
   * marks every child of the body inert while a dialog is up, so an empty one
   * kept from an hour ago would take the × off a note raised *during* the
   * dialog. Nothing outlives the notes it holds.
   */
  const remove = (): void => {
    const column = root.parentElement
    root.remove()
    if (column !== null && column.childElementCount === 0) column.remove()
  }
  return { root, close, remove }
}

/**
 * The one standing message note, so a second one replaces it rather than being
 * added under it.
 *
 * Not about overlap any more — {@link stack} is what keeps two notes off each
 * other, and it keeps *every* pair off each other rather than only this one.
 * What is left here is a rule about repetition: the share dialog copies the
 * link when it opens and copies the shortened one a second or two later, well
 * inside the four seconds the first note stays, and "Link copied" twice in a
 * column is a second row saying nothing the first did not. A progress note is
 * never a repeat of the note beside it, which is why it does not take part.
 */
let standing: (() => void) | null = null

/**
 * A single self-dismissing line: something happened, and it is done.
 *
 * Distinct from {@link progressToast} in the one way that matters — there is no
 * bar and no running commentary, because there is nothing to run. A progress
 * bar on a note about a finished one-shot action is a promise of a second event
 * that never arrives, and the × beside it would be offering to cancel work that
 * is already over. So it opens in the settled state, and goes on its own.
 *
 * It returns nothing on purpose: a caller with a handle would be a caller
 * tempted to update a note that has no second state to move to.
 */
export function messageToast(message: string): void {
  standing?.()

  const { root, close, remove } = toastShell(message)
  let timer: ReturnType<typeof setTimeout> | null = null
  const dismiss = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (standing === dismiss) standing = null
    remove()
  }
  close.addEventListener('click', dismiss)
  // Settled from the first frame: this note is never anything but finished, and
  // the class is what says so in the same grey the finished progress note ends
  // in — a reader who has seen one recognises the other.
  root.classList.add('toast-done')
  timer = setTimeout(dismiss, LINGER_MS)
  standing = dismiss
}

export function progressToast(
  message: string,
  /**
   * Called when the reader closes the note before it finishes.
   *
   * Not optional in spirit, even though it is in the type: a note with a bar on
   * it and a × that only removes the bar is a lie about what the × does. The
   * one caller cancels the job.
   */
  onDismiss?: () => void,
): ProgressToast {
  const fill = el('div', { class: 'toast-fill' })
  const bar = el('div', { class: 'toast-bar' }, fill)
  const note = el('p', { class: 'toast-note', text: 'Starting…' })
  const { root, close, remove } = toastShell(message, bar, note)

  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  const dismiss = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    remove()
  }
  close.addEventListener('click', () => {
    // Only while the work is still running: closing a *finished* note is
    // tidying up, and calling off a job that has already handed back its
    // result would be a cancel with nothing to cancel.
    if (!settled) onDismiss?.()
    dismiss()
  })

  return {
    update(done, total, text) {
      const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
      fill.style.width = `${(fraction * 100).toFixed(1)}%`
      note.textContent =
        text === undefined ? `${Math.round(fraction * 100)}%` : `${text} — ${Math.round(fraction * 100)}%`
    },
    finish(text) {
      settled = true
      fill.style.width = '100%'
      note.textContent = text
      root.classList.add('toast-done')
      timer = setTimeout(dismiss, LINGER_MS)
    },
    fail(text) {
      settled = true
      bar.remove()
      note.textContent = text
      root.classList.add('toast-failed')
    },
    dismiss,
  }
}
