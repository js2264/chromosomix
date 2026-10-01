// @vitest-environment jsdom
/**
 * The palette's *Annotations panel* row follows the column, not the format.
 *
 * It was greyed on every `.metacool`, with the hint "Absent on a metacool,
 * which carries no annotations" — a sentence from the release the cards were
 * gated off a file with a genome layer. The gate went (§8.5): a metacool's
 * Annotations column comes up with its Tracks, Structures, Manual annotations
 * and Bookmarks cards like any map's, and the row stayed dead beside it. The
 * row is now under the gate the column's own button is under — whether the
 * session put any cards in it — so the key never folds a column nobody can
 * see, and never refuses one that is on screen (§26.6).
 */

import { afterEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import type { Command } from '@/ui/commands'

const roots: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.remove()
})

/** An app whose tab in front is a stand-in with only what the palette reads. */
function appOver(session: Record<string, unknown> | undefined): App {
  window.history.replaceState(null, '', '/')
  const root = document.createElement('div')
  document.body.appendChild(root)
  roots.push(root)
  const app = new App(root)
  const stand = session === undefined ? undefined : { commands: () => [], ...session }
  Object.defineProperty(app, 'current', { get: () => stand })
  return app
}

const row = (app: App): Command | undefined =>
  (app as unknown as { commands(): Command[] }).commands().find((command) => command.id === 'fold-annotations')

const PANELS = { general: true, annotations: true, aesthetics: true, analysis: true }

describe('the Annotations panel row', () => {
  it('is live on a metacool, whose column is on screen', () => {
    const fold = row(appOver({ hasFile: true, isMetacool: true, isBrowsing: false, panels: PANELS }))
    expect(fold?.enabled).toBe(true)
    expect(fold?.hint).toBe('The tracks, structures, marks and bookmarks on this file.')
  })

  it('is live on a cooler and on a genome browsed with no map', () => {
    expect(row(appOver({ hasFile: true, isMetacool: false, isBrowsing: false, panels: PANELS }))?.enabled).toBe(true)
    expect(row(appOver({ hasFile: false, isMetacool: false, isBrowsing: true, panels: PANELS }))?.enabled).toBe(true)
  })

  it('is greyed where the column has nothing in it, and says why', () => {
    const empty = { ...PANELS, annotations: false }
    expect(row(appOver({ hasFile: false, isMetacool: false, isBrowsing: false, panels: empty }))?.enabled).toBe(false)
    expect(row(appOver({ hasFile: false, isMetacool: false, isBrowsing: false, panels: empty }))?.hint).toBe('Open a file first.')
    expect(row(appOver(undefined))?.enabled).toBe(false)
  })
})
