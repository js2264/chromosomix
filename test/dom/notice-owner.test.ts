// @vitest-environment jsdom
/**
 * A tab's note is about the file it has open (§5.6).
 *
 * The bar under the tabs says what a session found out about its file — a
 * sequence that reads as circular, an origin set, an edit not drawn — and the
 * slot is the window's. Nothing took a note down but its own button, so a link
 * that moved a tab from a mouse map to a chicken one left *chrY reads as
 * circular* over a genome with no chrY. A tab's note now goes when the tab
 * moves to another file, or to none, or closes; it waits while another tab is
 * in front; and a change of resolution, being the same file, keeps it. The
 * window's own note is about the window, and stays.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import type { Session } from '@/app/Session'
import { resetMounting } from '@/embed'
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
  // A tab is asked for its file's picture; nothing here is about the answer.
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
})

const MOUSE = 'https://data.example/demo/mouse/progenitors.mcool'
const CHICKEN = 'https://data.example/demo/chicken/G2_4DNFIRKUYKP4.hic'
const CHRY = 'chrY reads as circular — the contacts across the junction are those of neighbours.'

const at = (uri: string, rung?: number): ViewState => ({
  uri: rung === undefined ? uri : `${uri}::/resolutions/${rung}`,
  view: 'contigs',
})

/** The one door a session says anything through. */
interface Says {
  say(message: string, uri?: string): void
}

/** A window whose tabs are on `files`, the first of them in front. */
function windowOn(...files: ViewState[]): App {
  resetMounting()
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = stopsWithTheDom(new App(root))
  app['sessions'][0].prime(files[0])
  for (const state of files.slice(1)) {
    const session = app['newSession']() as Session
    session.prime(state)
  }
  app['activate'](0)
  return app
}

function tab(app: App, index: number): Session {
  return app['sessions'][index] as Session
}

function says(session: Session, message: string, state: ViewState): void {
  ;(session as unknown as Says).say(message, state.uri)
}

/** The note on screen, or `null`. */
const banner = (): string | null => document.querySelector('.notice-banner')?.textContent ?? null

describe('a note a tab put up', () => {
  it('goes when a link moves the tab to another file', () => {
    const app = windowOn(at(MOUSE, 10_000))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    expect(banner()).toContain('chrY reads as circular')

    // The address bar's road (`readHash` → `goTo`): the same tab, a new file.
    app['goTo'](at(CHICKEN))
    expect(banner()).toBeNull()
  })

  it('stays while the tab moves to another resolution of the same file', () => {
    const app = windowOn(at(MOUSE, 10_000))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    app['goTo'](at(MOUSE, 640_000))
    expect(banner()).toContain('chrY reads as circular')
  })

  it('goes when another file is opened in the tab without a link — a drop, a store row', () => {
    const app = windowOn(at(MOUSE, 10_000))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    void tab(app, 0).open(CHICKEN, { kind: 'remote', url: CHICKEN })
    expect(banner()).toBeNull()
  })

  it('goes when the tab goes back to the picker', () => {
    const app = windowOn(at(MOUSE, 10_000))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    tab(app, 0).toPicker()
    expect(banner()).toBeNull()
  })

  it('waits behind its tab while another is in front, and goes when its tab closes', () => {
    const app = windowOn(at(MOUSE, 10_000), at(CHICKEN))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    expect(banner()).toContain('chrY')

    app['activate'](1)
    expect(banner()).toBeNull()
    app['activate'](0)
    expect(banner()).toContain('chrY')

    app['closeSession'](0)
    expect(banner()).toBeNull()
    expect(app['notice']).toBeNull()
  })

  it('stays down once dismissed, whichever tab comes back', () => {
    const app = windowOn(at(MOUSE, 10_000), at(CHICKEN))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    document.querySelector<HTMLButtonElement>('.notice-banner button')?.click()
    expect(banner()).toBeNull()
    app['activate'](1)
    app['activate'](0)
    expect(banner()).toBeNull()
  })

  it('is not taken down by another tab moving', () => {
    const app = windowOn(at(MOUSE, 10_000), at(CHICKEN))
    says(tab(app, 0), CHRY, at(MOUSE, 10_000))
    tab(app, 1).toPicker()
    expect(banner()).toContain('chrY')
  })
})

describe("the window's own note", () => {
  it('stays across tabs and files, since it is about neither', () => {
    const app = windowOn(at(MOUSE, 10_000), at(CHICKEN))
    app.notify('3 more tabs were in that file than this window can hold.')
    app['activate'](1)
    expect(banner()).toContain('than this window can hold')
    app['goTo'](at(MOUSE, 10_000))
    expect(banner()).toContain('than this window can hold')
  })
})
