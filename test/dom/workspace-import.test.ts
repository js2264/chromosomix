// @vitest-environment jsdom
/**
 * Dropping a saved workspace on a window that has no room for it.
 *
 * Twelve tabs is the limit, and `seatWorkspace` answers a full window with
 * `take: 0` — nothing is imported, and the reader is told so. That much was
 * right. What ran anyway was everything that follows the seating: the sender's
 * overlays and column layout were applied to the reader's window and the reader
 * was thrown from the tab they were reading back to the first one. Silently,
 * under a notice that correctly said nothing had come in.
 *
 * The milder half of the same mistake is a *partial* import: the preferences
 * were read from the file's own active tab even when that tab was one of the
 * ones that did not fit, so a window took its overlays from a tab it had never
 * seated. Both are here, because the comment in `adoptWorkspace` claims the
 * preferences come "from the tab that ends up in front" and that is now the
 * assertion rather than the intention.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import { buildConfig, type SessionConfig } from '@/state/SessionConfig'
import { buildWorkspaceFile } from '@/state/workspace'
import { DEFAULT_UI_PLOT_OPTIONS, getPlotOptions, setPlotOptions } from '@/ui/plotOptions'
import { ANNOTATION_PANEL } from '@/ui/SidePanel'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown, stopsWithTheDom } from '../support/dom'

/** A worker that is created, listened to, and never answers. */
class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom()
  // A seated tab is activated, and activating one asks its file for a picture.
  // Nothing here is about what comes back, so the reader never answers.
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
  setPlotOptions(DEFAULT_UI_PLOT_OPTIONS)
})

const stateOf = (uri: string): ViewState => ({ uri, view: 'genomes' })

/** A saved tab, with the window preferences its sender had. */
function tabOf(uri: string, crosshair: boolean, labels: boolean, folded: boolean): SessionConfig {
  return buildConfig({
    state: stateOf(uri),
    memoryKey: `k|${uri}`,
    plot: { ...DEFAULT_UI_PLOT_OPTIONS, crosshair, labels },
    panels: { [ANNOTATION_PANEL.key]: { folded } },
    now: new Date('2026-08-13T09:00:00Z'),
  })
}

/** A window holding `count` tabs, each with a file in it. */
function windowOf(count: number): App {
  resetMounting()
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = stopsWithTheDom(new App(root))
  app['sessions'][0].prime(stateOf('https://data.example/t0.mcool'))
  for (let index = 1; index < count; index++) {
    const uri = `https://data.example/t${index}.mcool`
    app['seat'](undefined, tabOf(uri, true, false, false))
  }
  return app
}

/** What the reader would see of their own window. */
function windowState(app: App): {
  tabs: number
  active: number
  crosshair: boolean
  labels: boolean
  annotationsFolded: boolean | undefined
} {
  const plot = getPlotOptions()
  return {
    tabs: app['sessions'].length,
    active: app['active'],
    crosshair: plot.crosshair,
    labels: plot.labels,
    annotationsFolded: app.panelLayout()[ANNOTATION_PANEL.key]?.folded,
  }
}

describe('a window with no room left', () => {
  it('is left exactly as it was, and told so', () => {
    const app = windowOf(12)
    app['active'] = 6
    setPlotOptions({ ...DEFAULT_UI_PLOT_OPTIONS, crosshair: true, labels: false })
    app.applyPanelLayout({ [ANNOTATION_PANEL.key]: { folded: false } })
    const before = windowState(app)

    // One tab, saved by somebody with the opposite of every preference above.
    const file = JSON.stringify(
      buildWorkspaceFile([tabOf('https://sender.example/theirs.mcool', false, true, true)], 0, new Date()),
    )
    app['openWorkspaceFile'](file, 'workspace-2026-09-09.chromosomix.json')

    // Nothing came in — which the reader is told — and nothing else moved. The
    // failure was `{active: 0, crosshair: false, labels: true, folded: true}`:
    // an import of nothing that still rearranged the window it landed on.
    expect(windowState(app)).toEqual(before)
    expect(document.querySelector('.notice-banner')?.textContent ?? '').toContain(
      'than this window can hold',
    )
  })
})

describe('a window with room for some of it', () => {
  it('takes its preferences from the tab that ends up in front', () => {
    const app = windowOf(11)
    setPlotOptions({ ...DEFAULT_UI_PLOT_OPTIONS, crosshair: true, labels: false })
    app.applyPanelLayout({ [ANNOTATION_PANEL.key]: { folded: false } })

    // Two tabs for one seat, and the sender was looking at the second — the one
    // that cannot fit. The window opens on the first, so the first is whose
    // overlays it must wear.
    const file = JSON.stringify(
      buildWorkspaceFile(
        [
          tabOf('https://sender.example/first.mcool', true, false, false),
          tabOf('https://sender.example/second.mcool', false, true, true),
        ],
        1,
        new Date(),
      ),
    )
    app['openWorkspaceFile'](file, 'workspace-2026-09-09.chromosomix.json')

    const after = windowState(app)
    expect(after.tabs).toBe(12)
    expect(app['sessions'][after.active]?.state?.uri).toBe('https://sender.example/first.mcool')
    // `second.mcool`'s — {crosshair: false, labels: true, folded: true} — is
    // what the dropped tab used to impose on a window it never reached.
    expect(after.crosshair).toBe(true)
    expect(after.labels).toBe(false)
    expect(after.annotationsFolded).toBe(false)
  })
})
