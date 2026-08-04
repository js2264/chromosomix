/**
 * The menu a right click opens, wherever one is offered.
 *
 * Two of them exist — on the map, where it places a mark at the cell under the
 * pointer, and on a lane, where it restyles that track — and they are the same
 * object for the same reason the three side panels are: a second menu written
 * beside the first is a second set of answers to "how does this close", and the
 * one that gets it wrong is the one left open behind a dialog.
 *
 * It closes on the next click anywhere, on Escape, and on a scroll, because a
 * menu positioned against the viewport is wrong the moment the page moves under
 * it. Positioned there rather than against a container for the reason the
 * breadcrumb's own menu is: the plot sits in a scroll port, and a scroller clips
 * what hangs out of it.
 */

import { el } from './dom'

export interface MenuItem {
  label: string
  /** Shown in the row, quietly, where the label alone is not the whole answer. */
  hint?: string
  /** Absent for a heading — a row that names the group under it and does not act. */
  run?: () => void
  disabled?: boolean
}

let open: (() => void) | null = null

/** Close whatever menu is up. Safe to call when none is. */
export function closeMenu(): void {
  open?.()
}

/**
 * Open a menu at a point in viewport coordinates.
 *
 * The point is where the pointer was, and the menu is nudged back inside the
 * window rather than allowed to hang off it — a context menu that opens with
 * half its items unreachable is worse than one that opens a few pixels away
 * from the click.
 */
export function openMenu(x: number, y: number, items: readonly MenuItem[]): void {
  closeMenu()
  if (items.length === 0) return

  const menu = el('div', { class: 'crumb-menu context-menu' })
  for (const item of items) {
    if (item.run === undefined) {
      menu.appendChild(el('div', { class: 'context-menu-head', text: item.label }))
      continue
    }
    const node = el('button', {
      class: `crumb-menu-item${item.disabled === true ? ' disabled' : ''}`,
      type: 'button',
      ...(item.hint === undefined ? {} : { title: item.hint }),
    })
    node.appendChild(el('span', { text: item.label }))
    if (item.hint !== undefined) {
      node.appendChild(el('span', { class: 'context-menu-hint', text: item.hint }))
    }
    if (item.disabled === true) node.disabled = true
    else
      node.addEventListener('click', () => {
        closeMenu()
        item.run?.()
      })
    menu.appendChild(node)
  }

  document.body.appendChild(menu)
  // Measured after mounting, because the width is the widest label's and no
  // arithmetic here knows what that is.
  const box = menu.getBoundingClientRect()
  const left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4))
  const top = Math.max(4, Math.min(y, window.innerHeight - box.height - 4))
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`

  const close = (): void => {
    if (open !== close) return
    open = null
    menu.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', close, true)
    window.removeEventListener('resize', close)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  open = close
  // `once` on a listener added in this tick would fire on the very click that
  // opened the menu; a frame's delay is what lets the pointer go up first.
  requestAnimationFrame(() => {
    if (open === close) window.addEventListener('click', close, { once: true })
  })
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', close, true)
  window.addEventListener('resize', close)
}
