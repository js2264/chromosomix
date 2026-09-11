/**
 * The draggable edge that two different things now have.
 *
 * It was a private method on {@link SidePanel} for as long as columns were the
 * only resizable thing in the window. The Analysis drawer (§18.1) is the second,
 * and it is not a column — it floats over the body rather than sitting in the
 * flex row — so it could not inherit the behaviour by being one. Copying thirty
 * lines of pointer plumbing into it is how the two would come to disagree about
 * which button arms a drag, or about whether a double-click resets, and the
 * disagreement would not be visible in either file.
 *
 * Two details here are load-bearing and neither is obvious:
 *
 * **Pointer events with capture on the handle.** A resize drag routinely leaves
 * the four-pixel strip it started on, and without capture the first fast
 * movement drops it over the map — which would then take the rest of the gesture
 * as a pan.
 *
 * **The primary button only.** A right-press would arm a drag that the browser's
 * context menu then sits on top of, and the edge would follow the pointer
 * afterwards, with no press left to end it.
 *
 * The third owner is the **console** (§23), and it is the first that is not
 * beside the map but under it — so what {@link ResizeHandleOptions.side} names
 * is now an edge rather than a left or a right, and the axis follows from it.
 * The plumbing does not change: a drag is a distance from where the press
 * landed, and which coordinate that distance is measured along is the only
 * thing an edge decides.
 */

import { el } from './dom'

export interface ResizeHandleOptions {
  /**
   * Which side of the *owner* the handle sits on.
   *
   * It decides the axis and the sign, and nothing else: a left panel's handle is
   * on its right edge, so rightward is wider; a right panel's is on its left, so
   * the sign flips. The drawer is a right-sider by this reckoning even though it
   * is not a panel, because the question the sign answers is the same one — and
   * the console is a `top`, being a panel along the bottom of the window whose
   * handle is on the edge that faces the map, where upward is taller.
   */
  side: 'left' | 'right' | 'top'
  /** Named in the handle's tooltip: "Drag to resize the Analysis drawer". */
  what: string
  /** The width — or, for a `top`, the height — at the moment a drag starts. */
  width(): number
  /** Called on every movement, with the size the pointer is asking for. */
  resize(px: number): void
  /** Called once, when the drag ends, so the owner can persist what it chose. */
  commit(): void
  /** Double-click. Absent means a double-click does nothing. */
  reset?(): void
  /** Extra class, so each owner can style its own edge. */
  class?: string
}

/** Build the handle element. The caller decides where it goes. */
export function resizeHandle(options: ResizeHandleOptions): HTMLElement {
  const reset = options.reset
  // A separator's orientation is the line it *is*, not the axis it moves along,
  // which is why a column's edge — dragged left and right — is the vertical one.
  const vertical = options.side !== 'top'
  const node = el('div', {
    class: `panel-column-handle${options.class === undefined ? '' : ` ${options.class}`}`,
    title:
      `Drag to resize the ${options.what}` +
      (reset === undefined ? '' : '; double-click to reset it'),
    attrs: {
      role: 'separator',
      'aria-orientation': vertical ? 'vertical' : 'horizontal',
    },
  })

  let start = 0
  let startWidth = 0
  let dragging = false

  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = true
    start = vertical ? event.clientX : event.clientY
    startWidth = options.width()
    node.setPointerCapture(event.pointerId)
    node.classList.add('is-dragging')
    event.preventDefault()
  })
  node.addEventListener('pointermove', (event) => {
    if (!dragging) return
    // Away from the owner is bigger, whichever edge the handle is on: a left
    // panel grows rightward, a right panel and the console grow back towards
    // the pointer's origin.
    const delta =
      options.side === 'left' ? event.clientX - start : start - (vertical ? event.clientX : event.clientY)
    options.resize(startWidth + delta)
  })
  const end = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    node.releasePointerCapture(event.pointerId)
    node.classList.remove('is-dragging')
    options.commit()
  }
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
  if (reset !== undefined) node.addEventListener('dblclick', () => reset())
  return node
}
