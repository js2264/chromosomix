/**
 * The row of tabs under the header.
 *
 * A tab is a *session*: its own file, its own tracks, its own colour scale, its
 * own worker. That is a stronger claim than a browser tab makes about a page,
 * and the strip is written to keep it visible — the label is the file, the
 * tooltip says what state it is in, and a tab that has been remembered but not
 * yet opened says so rather than pretending to hold a file it has not read.
 *
 * Rendered from a list on every change rather than patched in place. Twelve
 * buttons is not a number worth reconciling, and rebuilding is what guarantees
 * the strip cannot drift from the sessions it describes.
 */

import { button, el } from '../ui/dom'
import { icon } from '../ui/icons'

export interface TabSpec {
  id: string
  label: string
  /** One line for the tooltip: the full URI, or why this tab is still empty. */
  hint: string
  active: boolean
  /**
   * Remembered from a previous visit and not yet opened.
   *
   * Shown differently because it is a genuinely different thing: the file is
   * named but no byte of it has been read, and clicking is what reads it.
   */
  pending: boolean
}

export interface TabStripProps {
  onSelect(index: number): void
  onClose(index: number): void
  onNew(): void
}

export class TabStrip {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'tabs', attrs: { role: 'tablist' } })
  private readonly add: HTMLButtonElement

  constructor(private readonly props: TabStripProps) {
    this.add = button('', () => this.props.onNew(), {
      class: 'btn btn-icon tab-new',
      title: 'New session — another file, with its own tracks and settings',
    })
    this.add.replaceChildren(icon('plus', { size: 15 }))
    this.el = el('div', { class: 'tabstrip' }, this.list, this.add)
  }

  render(tabs: readonly TabSpec[], canAdd: boolean): void {
    this.list.replaceChildren(
      ...tabs.map((tab, index) => this.tabNode(tab, index, tabs.length)),
    )
    // One session is not a tab bar, it is a title — so the strip stays, because
    // the way to a *second* session is the button on it, but it stops drawing a
    // box around the only thing there is.
    this.el.classList.toggle('single', tabs.length === 1)
    this.add.disabled = !canAdd
    this.add.classList.toggle('is-off', !canAdd)
  }

  private tabNode(tab: TabSpec, index: number, total: number): HTMLElement {
    const node = el('div', {
      class: `tab${tab.active ? ' is-active' : ''}${tab.pending ? ' is-pending' : ''}`,
      attrs: { role: 'tab', 'aria-selected': String(tab.active) },
    })

    const label = button(tab.label, () => this.props.onSelect(index), {
      class: 'tab-label',
      title: tab.hint,
    })
    // Middle-click closes, which is what a tab strip does everywhere else and
    // costs nothing to honour. `auxclick` rather than `mousedown`, so a
    // middle-press that drifts off the tab does not close it.
    node.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      this.props.onClose(index)
    })

    const close = button('', () => this.props.onClose(index), {
      class: 'btn btn-icon tab-close',
      title:
        total === 1
          ? 'Empty this session. The last tab is not closed — there would be nothing to drop a file on.'
          : 'Close this session, and put its worker down',
    })
    close.replaceChildren(icon('x', { size: 13 }))

    node.append(label, close)
    return node
  }
}
