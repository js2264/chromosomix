/**
 * A stage's keys (SPECS §26.4, §33.3): one listener on the window, in the
 * capture phase, that answers only while its stage is the dialog on top and
 * leaves a field's keys to the field, an open menu's to the menu, and a focused
 * button's Space to the button.
 *
 * The three guards are the three ways a stage's keys went wrong before it was
 * shared: a rename box whose letters were the stage's, a menu whose ↓ also
 * moved the stage's selection (the menu's own listener is on the same target,
 * where `stopPropagation` stops nothing), and a focused button that panned
 * instead of pressing. A key the stage takes is taken whole — default and
 * propagation — so nothing else on the page hears it.
 */

import { menuIsOpen } from './Menu'
import { isTypingTarget, wantsSpace } from './commands'

/** What a stage does with its keys. */
export interface StageKeyHandler {
  /** Answer a key pressed; `true` when the stage took it. */
  down(event: KeyboardEvent): boolean
  /** A key let go: a held Space, Shift or Alt. */
  up?(event: KeyboardEvent): void
  /** The window lost the keyboard: let go of every key held. */
  blur?(): void
}

/** The dialog on top, the last one opened, or `null` with none open. */
export function topDialog(): Element | null {
  const dialogs = document.querySelectorAll('.modal-backdrop')
  return dialogs.length === 0 ? null : dialogs[dialogs.length - 1]
}

/** Whether `root` is in the dialog on top: a dialog stacked over a stage takes its keys. */
export function onTop(root: Element): boolean {
  return topDialog()?.contains(root) === true
}

/** Whether a key belongs to something on the stage before the stage: a field, a menu, a button's Space. */
export function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  if (isTypingTarget(event.target)) return true
  if (menuIsOpen()) return true
  return event.key === ' ' && wantsSpace(event.target)
}

/**
 * Listen for a stage's keys. Returns the teardown, which the stage calls when
 * it closes.
 */
export function stageKeys(root: HTMLElement, handler: StageKeyHandler): () => void {
  const down = (event: KeyboardEvent): void => {
    if (!root.isConnected || !onTop(root) || keyBelongsElsewhere(event)) return
    if (!handler.down(event)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const up = (event: KeyboardEvent): void => {
    if (!root.isConnected) return
    handler.up?.(event)
  }
  const blur = (): void => handler.blur?.()
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
  window.addEventListener('blur', blur)
  return () => {
    window.removeEventListener('keydown', down, true)
    window.removeEventListener('keyup', up, true)
    window.removeEventListener('blur', blur)
  }
}
