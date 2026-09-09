// @vitest-environment jsdom
/**
 * What `?embed=1` takes away, and the one thing it changes rather than removes.
 *
 * Both halves are invisible until somebody frames this app in a page. The
 * missing chrome is obvious the moment it is wrong and impossible to notice from
 * inside the repository; the history rule is the opposite — an embed that pushes
 * looks completely normal in the frame and quietly takes over the reader's Back
 * button, which is the sort of thing that is reported as "your figure broke my
 * site" a year later.
 *
 * The whole window is built here rather than a piece of it, because the
 * assertion is about what `App` *appends*, and there is no smaller object that
 * makes that decision.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import type { ViewState } from '@/types'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

const AT: ViewState = { uri: 'https://data.example/f.mcool', view: 'genomes' }

/** Mount a window at an address, the way a page's `src=` would. */
function windowAt(search: string): { root: HTMLElement; app: App } {
  window.history.replaceState(null, '', `/${search}`)
  resetMounting()
  const root = document.createElement('div')
  document.body.appendChild(root)
  return { root, app: new App(root) }
}

/** What the history was asked to do, from here until the returned undo. */
function watchHistory(): { pushed: number; replaced: number; stop: () => void } {
  const push = window.history.pushState.bind(window.history)
  const replace = window.history.replaceState.bind(window.history)
  const seen = { pushed: 0, replaced: 0, stop: () => {} }
  window.history.pushState = (...args: Parameters<History['pushState']>): void => {
    seen.pushed++
    push(...args)
  }
  window.history.replaceState = (...args: Parameters<History['replaceState']>): void => {
    seen.replaced++
    replace(...args)
  }
  seen.stop = (): void => {
    window.history.pushState = push
    window.history.replaceState = replace
  }
  return seen
}

/**
 * Navigate the active tab without opening anything.
 *
 * `adopt` sets the state and tells nobody (`state/ViewState.ts`), so the
 * notification can be made by hand — which is what keeps this a test about the
 * shell rather than one that needs a worker and a `.mcool` behind it.
 */
function navigate(app: App, state: ViewState, replace = false): void {
  const session = app['current']
  if (session === undefined) throw new Error('a window always has one tab')
  session.store.adopt(state)
  app.stateChanged(session, { replace })
}

describe('a window mounted as an embed', () => {
  it('leaves out the header, the tab strip and the status bar', () => {
    const { root } = windowAt('?embed=1')
    expect(root.querySelector('.app-head')).toBeNull()
    expect(root.querySelector('.tabstrip')).toBeNull()
    expect(root.querySelector('.app-foot')).toBeNull()
    expect(root.querySelector('.restore-slot')).toBeNull()
  })

  it('keeps the two columns that are about the picture, folded', () => {
    // Annotations and Aesthetics say what is drawn and how it is coloured; the
    // other three are about the window. And they arrive folded whatever a saved
    // session asks for: honouring the layout put a published figure in a
    // 1,200-pixel frame behind five open columns and thirty-two pixels of map,
    // measured in Chromium before this line existed.
    const { root } = windowAt('?embed=1')
    const columns = all(root, '.panel-column')
    expect(columns.map((column) => column.className.includes('panel-annotations'))).toEqual([
      true,
      false,
    ])
    expect(columns).toHaveLength(2)
    expect(columns.every((column) => column.classList.contains('collapsed'))).toBe(true)
    // A folded column is not a dead 30-pixel rail: it stands its own named tab,
    // which is what opens it where there is no header to open it from.
    expect(all(root, '.panel-column .panel-tab')).toHaveLength(2)
  })

  it('keeps the view and the place a remark can land', () => {
    const { root } = windowAt('?embed=1')
    // Everything a session mounts into has to still be here, or an embed is not
    // the same application with less furniture — it is a second one.
    expect(root.querySelector('.app-body')).not.toBeNull()
    expect(root.querySelector('.content')).not.toBeNull()
    expect(root.querySelector('.breadcrumb-slot')).not.toBeNull()
    expect(root.querySelector('.notice-slot')).not.toBeNull()
    expect(root.querySelector('.drawer-slot')).not.toBeNull()
  })

  it('keeps all five in a window of its own, and no bar', () => {
    const { root } = windowAt('')
    expect(root.querySelectorAll('.panel-column')).toHaveLength(5)
    expect(root.querySelector('.embed-bar')).toBeNull()
  })

  it('builds the whole window when nothing was asked for', () => {
    const { root } = windowAt('')
    expect(root.querySelector('.app-head')).not.toBeNull()
    expect(root.querySelector('.tabstrip')).not.toBeNull()
    expect(root.querySelector('.app-foot')).not.toBeNull()
  })

  it('reads a hand-edited "no" as a plain window', () => {
    const { root } = windowAt('?embed=0')
    expect(root.querySelector('.app-head')).not.toBeNull()
  })
})

describe('the bar an embed has instead of a header', () => {
  it('carries the brand, the breadcrumb, the two toggles and About', () => {
    const { root } = windowAt('?embed=1')
    const bar = root.querySelector('.embed-bar')
    expect(bar).not.toBeNull()
    expect(bar?.querySelector('.embed-brand-name')?.textContent).toBe('(meta)cooler')
    // The breadcrumb moved *into* the bar rather than being duplicated: one
    // slot, which the session fills exactly as it does in a window.
    expect(bar?.querySelector('.breadcrumb-slot')).not.toBeNull()
    expect(all(root, '.breadcrumb-slot')).toHaveLength(1)
    // The two toggles are the panels' own buttons, so they say what they do and
    // which key does it without this row knowing anything about either.
    expect(all<HTMLButtonElement>(root, '.embed-tools button').map((button) => button.title)).toEqual(
      ['Show the Annotations panel (A)', 'Show the Aesthetics panel (M)', 'About this viewer'],
    )
  })

  it('points the brand at this same view, in the full application', () => {
    // Not the way home. In a window the brand goes back to the picker, which
    // inside a frame would throw away the figure the page named with no back
    // button to return by — so it drops `embed` and keeps everything else.
    const { root } = windowAt('?embed=1&config=x.json#uri=f.mcool&view=genomes')
    const brand = root.querySelector<HTMLAnchorElement>('.embed-brand')
    const href = new URL(brand?.href ?? '', 'http://localhost/')
    expect(href.searchParams.has('embed')).toBe(false)
    expect(href.searchParams.get('config')).toBe('x.json')
    expect(href.hash).toBe('#uri=f.mcool&view=genomes')
    expect(brand?.target).toBe('_blank')
    expect(brand?.rel).toBe('noopener noreferrer')
  })

  it('follows the reader, so copying the link copies where they are', () => {
    const { root, app } = windowAt('?embed=1')
    navigate(app, AT)
    const brand = root.querySelector<HTMLAnchorElement>('.embed-brand')
    expect(brand?.href).toContain('#uri=https://data.example/f.mcool')
  })

})

describe('the address bar, from inside a frame', () => {
  it('replaces rather than pushes, whatever the navigation asked for', () => {
    const { app } = windowAt('?embed=1')
    const history = watchHistory()
    navigate(app, AT)
    navigate(app, { ...AT, view: 'contigs' })
    history.stop()
    expect(history.pushed).toBe(0)
    expect(history.replaced).toBe(2)
    // Still written, and that is the point of replacing rather than not writing:
    // a reload and a copied link both read this.
    // Read back through `location`, which decodes what the serialiser escaped.
    expect(window.location.hash).toBe('#uri=https://data.example/f.mcool&view=contigs')
  })

  it('keeps the query string, so a reload is still an embed', () => {
    const { app } = windowAt('?embed=1&config=x.json')
    navigate(app, AT)
    expect(window.location.search).toBe('?embed=1&config=x.json')
  })

  it('still pushes in a window of its own', () => {
    const { app } = windowAt('')
    const history = watchHistory()
    navigate(app, AT)
    navigate(app, { ...AT, view: 'contigs' }, true)
    history.stop()
    expect(history.pushed).toBe(1)
    expect(history.replaced).toBe(1)
  })
})

describe('a session named in the address', () => {
  /** Answer every request with this, and record what was asked for. */
  function serving(body: string): { asked: string[]; stop: () => void } {
    const real = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      asked.push(String(input))
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as typeof fetch
    return {
      asked,
      stop: () => {
        globalThis.fetch = real
      },
    }
  }

  /** Long enough for a fetch and the two awaits after it. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('opens the workspace the page named, resolved against the page', async () => {
    const server = serving('{}')
    windowAt('?embed=1&config=figures/one.metacooler.json')
    await settle()
    server.stop()
    expect(server.asked).toHaveLength(1)
    expect(server.asked[0]).toMatch(/\/figures\/one\.metacooler\.json$/)
  })

  it('works in a window of its own, which is what makes a session linkable', async () => {
    const server = serving('{}')
    windowAt('?config=figures/one.metacooler.json')
    await settle()
    server.stop()
    expect(server.asked).toHaveLength(1)
  })

  it('says so when what comes back is not a workspace', async () => {
    // The alternative is the picker, silently — which reads as the embed simply
    // not working, and is the one report nobody can act on.
    const server = serving('{}')
    windowAt('?embed=1&config=figures/one.metacooler.json')
    await settle()
    server.stop()
    expect(document.body.textContent).toContain('not a saved workspace')
  })

  it('is a seed, and loses to a view state the reader navigated to', async () => {
    // The `src=` says where to start; the fragment says where the reader got to.
    // A reload inside the frame has to keep the second, or every reload would
    // undo the last click — and would open a second tab on top of it.
    const server = serving('{}')
    windowAt('?embed=1&config=figures/one.metacooler.json#uri=f.mcool&view=genomes')
    await settle()
    server.stop()
    expect(server.asked).toHaveLength(0)
  })
})

describe('what an embed remembers', () => {
  it('writes no tab strip, so a reload shows what the page asked for', () => {
    const { app } = windowAt('?embed=1')
    navigate(app, AT)
    expect(window.sessionStorage.getItem('metacooler-viewer:sessions')).toBeNull()
  })

  it('writes one in a window of its own', () => {
    const { app } = windowAt('')
    navigate(app, AT)
    expect(window.sessionStorage.getItem('metacooler-viewer:sessions')).not.toBeNull()
  })
})
