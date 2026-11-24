/**
 * Where the keyboard goes after a press on a card of the curation stage's
 * inspector (SPECS §26.4, §33.3).
 *
 * A focused button takes Space and Enter for itself, before the stage
 * (`ui/stageKeys.ts`). Left on a button the pointer pressed — a suggestion's
 * `take`, a history row, an export — it would answer the next Space by
 * pressing that button again: review's Space, held to draw the question as it
 * would be, would take a question twice, go back to a step again, or open the
 * save dialog a second time. So a press of the pointer lets go of the focus
 * it gave; a press by the keys keeps it, and Tab and Enter still walk the
 * card.
 */

/** Let go of the focus a press of the pointer gave a button or a disclosure of `root`. */
export function releaseFocusOnPointerPress(root: HTMLElement): void {
  root.addEventListener(
    'click',
    (event) => {
      // A press by the keys (Enter, Space) is a click of no pointer: detail 0.
      if (event.detail === 0) return
      const pressed = event.target instanceof Element ? event.target.closest('button, summary') : null
      if (!(pressed instanceof HTMLElement) || !root.contains(pressed)) return
      if (document.activeElement === pressed) pressed.blur()
    },
    // Before the press's own handler, which may stop the click there.
    true,
  )
}
