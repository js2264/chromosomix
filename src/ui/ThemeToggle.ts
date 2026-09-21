/**
 * Light / dark / system theme toggle.
 *
 * The stylesheet already answers `prefers-color-scheme`, so "system" is the
 * absence of an override rather than a third palette: the toggle writes
 * `data-theme` on `<html>` for the two explicit choices and removes it for
 * system. That keeps one source of truth for the colours, and a user who never
 * touches this control still gets the right one.
 *
 * The choice is a preference, not a train of thought, so it lives in
 * `localStorage` — unlike the table filters in `state/UiMemory`, which are
 * deliberately per-session.
 *
 * **An embed is fixed to light**, in `read()` rather than only in the button
 * that is absent from its bar (`embed.ts`, `app/App.ts`): a figure inside
 * somebody else's page has to render the same way for every reader, not go
 * dark because the reader's OS does, or because a stray keyboard shortcut
 * reaches a control that was never mounted. Guarding `read()` covers the
 * startup paint; the click handler below is the second half, for the one
 * remaining path to a change — the command palette's "theme" entry, which
 * still runs in an embed like every other bound command.
 */

import { el } from './dom'
import { KEYS, withKey } from './commands'
import { embedded } from '../embed'
import { icon, type IconName } from './icons'

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'metacooler-viewer:theme'

const ICON: Record<ThemeChoice, IconName> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
}

/**
 * What the machine is doing, where it can be asked.
 *
 * `false` where there is no `matchMedia` — a test environment, an old engine —
 * which makes the cycle `system → dark → light`, the order for the light
 * default the stylesheet itself falls back to.
 */
function osPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function read(): ThemeChoice {
  if (embedded()) return 'light'
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  } catch {
    return 'system'
  }
}

function write(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, choice)
  } catch {
    /* a browser that refuses storage still themes correctly for this session */
  }
}

/**
 * Apply a choice to the document.
 *
 * Called once at startup *before* the app mounts, so a user who chose dark does
 * not get a flash of light while the module graph loads.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

/** Restore the stored choice. Safe to call before the app mounts. */
export function initTheme(): ThemeChoice {
  const choice = read()
  applyTheme(choice)
  return choice
}

export class ThemeToggle {
  readonly el: HTMLButtonElement
  private choice: ThemeChoice

  constructor() {
    this.choice = read()
    this.el = el('button', {
      class: 'btn btn-icon',
      type: 'button',
      attrs: { 'aria-label': 'colour theme' },
    })
    this.el.addEventListener('click', () => {
      // Never mounted in an embed's own bar, but still reachable through the
      // "theme" command — which, like every other bound command, still runs
      // there. Without this the palette or its shortcut could flip a figure
      // dark despite `read()` seeding it light.
      if (embedded()) return
      this.choice = this.next()
      write(this.choice)
      applyTheme(this.choice)
      this.paint()
    })
    this.paint()
  }

  /**
   * The next choice in the cycle, ordered against the *machine's* scheme.
   *
   * A fixed `system → light → dark` order spends its first press on a choice
   * that changes nothing: on a light OS — which is most of them, and every
   * screenshot this app's gallery was taken on — pressing once selects `light`,
   * the page does not move, and the icon changes to a sun that now reads as a
   * claim that the page is *already* light. A reader presses the button, sees
   * nothing happen, and concludes it is broken or that there is no dark theme.
   *
   * So the first press goes to the *opposite* of what the machine is doing, the
   * second to the same as the machine (explicitly, which is what pins a figure
   * light on a dark laptop), and the third back to following it. Every
   * three-state cycle on a fixed OS has one visually silent step; this puts it
   * last, where the monitor icon coming back reads as "follow the OS again"
   * rather than as a control that did not work.
   */
  private next(): ThemeChoice {
    const dark = osPrefersDark()
    const opposite: ThemeChoice = dark ? 'light' : 'dark'
    if (this.choice === 'system') return opposite
    return this.choice === opposite ? (dark ? 'dark' : 'light') : 'system'
  }

  private paint(): void {
    this.el.replaceChildren(icon(ICON[this.choice]))
    this.el.title = withKey(`Theme: ${this.choice}. Click for ${this.next()}`, KEYS.theme)
    // The name a screen reader announces, not only the description: it was the
    // constant "colour theme", so three presses said the same four syllables
    // and the state was never spoken. `MapPanel`'s lock button mirrors its
    // title for the same reason.
    this.el.setAttribute('aria-label', this.el.title)
  }
}
