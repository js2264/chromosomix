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
 *
 * **It is driven by the keyboard once it is up**, which it was not: a menu of
 * plain buttons appended to `<body>`, with no role and nothing focused, left a
 * reader who had opened it with the mouse — the only way in, since the heatmap
 * canvas takes no focus — to reach *Copy coordinates* by tabbing through every
 * panel of the window, because the menu is the last thing in the document. So
 * the first row takes focus when it opens, the arrows walk the rows, and
 * closing hands focus back to whatever had it, which is how every other menu on
 * the reader's machine behaves.
 */

import { el } from './dom'

export interface MenuItem {
  label: string
  /** Shown in the row, quietly, where the label alone is not the whole answer. */
  hint?: string
  /**
   * What the row does, in a sentence, for the pointer that rests on it — too
   * long for the hint column, which is for a value the row acts on (a
   * coordinate, a colour) and cuts anything longer at the menu's edge.
   */
  title?: string
  /** Absent for a heading — a row that names the group under it and does not act. */
  run?: () => void
  disabled?: boolean
  /**
   * A choice or a switch, and whether it is the one in force: the row carries
   * a tick when `true` and the room for one when `false`, so a group of choices
   * lines up, and it is announced as checked or not. Absent for an action.
   */
  checked?: boolean
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

  const menu = el('div', {
    class: 'crumb-menu context-menu',
    attrs: { role: 'menu', tabindex: '-1' },
  })
  // The rows a key can move between: the headings are not among them, and
  // neither is a row that cannot act.
  const rows: HTMLButtonElement[] = []
  for (const item of items) {
    if (item.run === undefined) {
      menu.appendChild(
        el('div', { class: 'context-menu-head', text: item.label, attrs: { role: 'presentation' } }),
      )
      continue
    }
    const choice = item.checked !== undefined
    const node = el('button', {
      class: `crumb-menu-item${item.disabled === true ? ' disabled' : ''}`,
      type: 'button',
      attrs: choice
        ? { role: 'menuitemcheckbox', 'aria-checked': String(item.checked) }
        : { role: 'menuitem' },
      ...(item.title !== undefined
        ? { title: item.title }
        : item.hint === undefined
          ? {}
          : { title: item.hint }),
    })
    if (item.disabled !== true) rows.push(node)
    if (choice) {
      node.appendChild(
        el('span', {
          class: 'context-menu-check',
          text: item.checked === true ? '✓' : '',
          attrs: { 'aria-hidden': 'true' },
        }),
      )
    }
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

  // Captured before anything is focused, so closing can put the caret back
  // where the reader left it — on the lane, the canvas or the row they had.
  const opener = document.activeElement
  const close = (): void => {
    if (open !== close) return
    open = null
    menu.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', close, true)
    window.removeEventListener('resize', close)
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }
  const step = (delta: number): void => {
    if (rows.length === 0) return
    const at = rows.findIndex((row) => row === document.activeElement)
    // From nowhere, a step down is the first row and a step up the last, which
    // is what a reader pressing ↑ at a freshly opened menu is asking for.
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length
    rows[next]?.focus()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      close()
      return
    }
    if (event.key === 'ArrowDown') step(1)
    else if (event.key === 'ArrowUp') step(-1)
    else if (event.key === 'Home') rows[0]?.focus()
    else if (event.key === 'End') rows[rows.length - 1]?.focus()
    else return
    // Only for the keys this menu answers: the page below must go on receiving
    // everything else, and an arrow key that also scrolled the view behind the
    // menu would move the thing the menu is about.
    event.preventDefault()
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
  // The first row that can act, so the arrows have somewhere to start and a
  // reader who opened this from the keyboard is standing in it. The menu itself
  // where every row is dead, which is a menu that is only a heading and a
  // reason — still Escapable, and announced as a menu.
  ;(rows[0] ?? menu).focus()
}
