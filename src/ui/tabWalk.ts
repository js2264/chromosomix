/**
 * Tab between the fields of one kind (§26.8): a track's name to the next
 * track's, one end of a range to the other and on to the next range, a map's
 * name to the next map's.
 *
 * A field edited in place — a caret laid over a lane's name, a colour key's
 * number, a heading that reads as text until it is clicked — is one of a run
 * of fields of its kind, and the run is what a reader working through a figure
 * is going down: naming four replicates, setting six tracks to one ceiling.
 * The browser's own Tab knows nothing of that run. It takes the next focusable
 * thing in the document, which beside a field laid over a canvas is a button
 * the reader never meant, and in a field the next frame repaints is nothing at
 * all. So Tab here takes what was typed, as Enter does, and puts the caret in
 * the next field of the same kind — Shift+Tab the one before — and past either
 * end of the run lets the caret go, as Enter does: Tab is Enter that goes on.
 *
 * A value a field refuses keeps the caret where it is, as Enter does, so
 * nothing moves on from a number that was not taken.
 */

/** Which way a key walks the fields of a run, or `null` for any other key. */
export function tabStep(event: KeyboardEvent): 1 | -1 | null {
  // Not with a modifier, which is the browser's or the system's — Ctrl+Tab
  // changes the browser's tab — nor mid-composition, where Tab is the IME's.
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return null
  return event.shiftKey ? -1 : 1
}

/**
 * The marker a field carries when it walks Tab itself, read by the dialog's
 * focus trap (`ui/Modal.ts`) so the two do not both answer one key.
 */
export const TAB_WALKS = 'data-tab-walk'

/**
 * Tab in one of a run of fields that are always on the page — the names on a
 * card, the headings over a deck's cells: take what was typed, then put the
 * caret in the field `step` along the run, or let it go past either end.
 *
 * The run is every field of `selector` in the nearest `scope` round the field
 * — one deck's headings, one card's names — found once, before the commit,
 * and asked for its fields again after it, by position: a commit may rebuild
 * the rows the field is in — a rename repaints a card's list — and both the
 * field and the next one taken before it would be fields no longer on the
 * page. The scope itself stays. `true` where the key was a Tab and has been
 * answered.
 */
export function tabAmong(event: KeyboardEvent, field: HTMLInputElement, scope: string, selector: string): boolean {
  const step = tabStep(event)
  if (step === null) return false
  event.preventDefault()
  const root = field.closest(scope)
  const run = (): HTMLInputElement[] => (root === null ? [field] : editableIn(root, selector))
  const at = run().indexOf(field)
  // Through the field's own commit: these take what was typed on `change`,
  // which a blur fires for a value that changed and only then.
  field.blur()
  if (at < 0) return true
  const next = run()[at + step]
  if (next === undefined) return true
  next.focus()
  next.select()
  return true
}

/**
 * The fields of a run as the page holds them now: in document order, and only
 * the ones a reader could type into — on the page, not hidden, enabled and not
 * read-only. Hidden as this app hides things, by a `hidden` class or attribute
 * on the field or round it, which needs no layout to answer.
 */
export function editableIn(scope: ParentNode, selector: string): HTMLInputElement[] {
  return [...scope.querySelectorAll<HTMLInputElement>(selector)].filter(
    (field) => field.isConnected && !field.disabled && !field.readOnly && field.closest('.hidden, [hidden]') === null,
  )
}
