// @vitest-environment jsdom
/**
 * The title a tab has with nothing open (§11).
 *
 * A search engine indexes the page as it stands once the app has run, and the
 * app writes `document.title` as soon as it mounts. It wrote its bare name, so
 * the title `index.html` gives the page — the words it is searched by — never
 * reached an index. On the web the landing page now keeps the page's own title,
 * and a tab with a file open is still that file's name, then the app's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import type { Session } from '@/app/Session'
import { resetMounting } from '@/embed'
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

const PAGE_TITLE = 'chromosomix – genome browser for Hi-C, tracks and 3D models'
const MOUSE = 'https://data.example/demo/mouse/progenitors.mcool'

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom()
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
  document.title = ''
})

/** The app, mounted on a page whose `<title>` is `title`. */
function mountedUnder(title: string): App {
  resetMounting()
  document.title = title
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = stopsWithTheDom(new App(root))
  app['activate'](0)
  return app
}

describe('the title with nothing open', () => {
  it('is the page’s own, so that what is indexed carries the words in it', () => {
    mountedUnder(PAGE_TITLE)
    expect(document.title).toBe(PAGE_TITLE)
  })

  it('gives way to the file’s name while one is open, and comes back with the picker', () => {
    const app = mountedUnder(PAGE_TITLE)
    const tab = app['sessions'][0] as Session
    app['goTo']({ uri: `${MOUSE}::/resolutions/10000`, view: 'contigs' })
    expect(document.title).toBe(`${tab.label} — chromosomix`)
    expect(document.title).not.toContain('Hi-C')

    tab.toPicker()
    expect(document.title).toBe(PAGE_TITLE)
  })

  it('is the app’s name on a page that gives none', () => {
    mountedUnder('')
    expect(document.title).toBe('chromosomix')
  })
})
