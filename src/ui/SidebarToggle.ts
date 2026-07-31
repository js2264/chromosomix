/**
 * Fold the file-info sidebar away.
 *
 * The control sits next to the app title rather than with the right-hand
 * actions because it acts on the panel directly below it: a fold button on the
 * far side of the header points away from the thing it folds. It replaces the
 * (i) button, which did the same job from the wrong end of the header.
 *
 * Two states are conflated on purpose. The sidebar describes *the open file*,
 * so with no file open there is nothing to describe and nothing to fold: the
 * panel is hidden and the button goes with it, without touching the stored
 * preference. Someone who folded the sidebar and then opened a second file gets
 * it folded again; someone who never folded it gets it back on open.
 *
 * The choice is a preference rather than a train of thought, so it lives in
 * `localStorage` alongside the theme, not in the per-session `state/UiMemory`.
 */

import { el } from './dom'

const KEY = 'metacooler-viewer:sidebar-collapsed'

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function write(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(KEY, '1')
    else window.localStorage.removeItem(KEY)
  } catch {
    /* a browser that refuses storage still folds correctly for this session */
  }
}

export class SidebarToggle {
  readonly el: HTMLButtonElement
  private collapsed: boolean
  private available = false

  constructor(private readonly host: HTMLElement) {
    this.collapsed = read()
    this.el = el('button', {
      class: 'btn btn-icon',
      type: 'button',
      attrs: { 'aria-label': 'file info sidebar' },
    })
    this.el.addEventListener('click', () => {
      this.collapsed = !this.collapsed
      write(this.collapsed)
      this.paint()
    })
    this.paint()
  }

  /**
   * Whether there is a file to describe. The picker has none, so both the
   * sidebar and this button leave the layout entirely rather than standing as
   * an empty column beside the dropzone.
   */
  setAvailable(available: boolean): void {
    this.available = available
    this.paint()
  }

  private paint(): void {
    this.host.classList.toggle('collapsed', this.collapsed || !this.available)
    this.el.classList.toggle('hidden', !this.available)
    this.el.textContent = this.collapsed ? '⇥' : '⇤'
    this.el.title = this.collapsed ? 'Show the file info sidebar' : 'Fold the file info sidebar'
    this.el.setAttribute('aria-expanded', String(!this.collapsed))
  }
}
