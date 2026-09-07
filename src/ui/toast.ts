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

export function progressToast(message: string): ProgressToast {
  const label = el('p', { class: 'toast-label', text: message })
  const fill = el('div', { class: 'toast-fill' })
  const bar = el('div', { class: 'toast-bar' }, fill)
  const note = el('p', { class: 'toast-note', text: 'Starting…' })
  const close = el('button', { class: 'toast-close', text: '×', title: 'Dismiss' })

  const root = el(
    'div',
    { class: 'toast', attrs: { role: 'status', 'aria-live': 'polite' } },
    el('div', { class: 'toast-text' }, label, bar, note),
    close,
  )
  document.body.appendChild(root)

  let timer: ReturnType<typeof setTimeout> | null = null
  const dismiss = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    root.remove()
  }
  close.addEventListener('click', dismiss)

  return {
    update(done, total, text) {
      const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
      fill.style.width = `${(fraction * 100).toFixed(1)}%`
      note.textContent =
        text === undefined ? `${Math.round(fraction * 100)}%` : `${text} — ${Math.round(fraction * 100)}%`
    },
    finish(text) {
      fill.style.width = '100%'
      note.textContent = text
      root.classList.add('toast-done')
      timer = setTimeout(dismiss, LINGER_MS)
    },
    fail(text) {
      bar.remove()
      note.textContent = text
      root.classList.add('toast-failed')
    },
    dismiss,
  }
}
