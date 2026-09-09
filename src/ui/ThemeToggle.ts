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
const ORDER: ThemeChoice[] = ['system', 'light', 'dark']

const ICON: Record<ThemeChoice, IconName> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
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

  private next(): ThemeChoice {
    return ORDER[(ORDER.indexOf(this.choice) + 1) % ORDER.length]
  }

  private paint(): void {
    this.el.replaceChildren(icon(ICON[this.choice]))
    this.el.title = withKey(`Theme: ${this.choice}. Click for ${this.next()}`, KEYS.theme)
  }
}
