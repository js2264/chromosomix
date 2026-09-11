// @vitest-environment jsdom
/**
 * The search form, as a reader meets it under the hub table.
 *
 * `portal.test.ts` owns the query and the parsing; what can go wrong *here* is
 * smaller and less visible:
 *
 * - **Something running before anybody asked.** A form that searches on
 *   construction, or on a keystroke, tells a third party that this page was
 *   opened and what was half-typed into it. §11 and SPECS §23.2 say a portal is
 *   reached on a gesture, and a constructor is not one.
 * - **The hub not reaching the table.** This component draws no rows on
 *   purpose; if `onResults` does not fire with an absolute-rowed hub, the
 *   search silently does nothing at all.
 * - **A refusal arriving as a blank line.** The CORS message is the only thing
 *   a reader gets when 4DN will not answer a browser, and it has to reach both
 *   the status line and the host.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PortalSearch } from '@/ui/PortalSearch'
import { PORTALS } from '@/state/portal'
import type { Hub } from '@/state/hub'
import { buttonNamed, setUpDom, textsOf, type DomTeardown } from '../support/dom'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
})

// From the working directory rather than from `import.meta.url`: under jsdom
// the module's own URL is not a `file:` one and resolving against it throws,
// which is the road `test/dom/side-panel.test.ts` takes for the same reason.
const ENCODE_BODY = readFileSync(
  resolve(process.cwd(), 'test/fixtures-portals/encode-search.json'),
  'utf8',
)

/** What a search produced, in the order it produced it. */
interface Caught {
  hubs: Hub[]
  errors: string[]
}

function mount(
  fetchImpl: typeof fetch,
): { view: PortalSearch; caught: Caught } {
  const caught: Caught = { hubs: [], errors: [] }
  const view = new PortalSearch({
    onResults: (hub) => caught.hubs.push(hub),
    onError: (message) => caught.errors.push(message),
    fetchImpl,
  })
  document.body.appendChild(view.el)
  return { view, caught }
}

/** A `fetch` that answers the ENCODE fixture and counts what it was asked. */
function serving(body = ENCODE_BODY, status = 200): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = []
  const fetchImpl = (async (url: string) => {
    asked.push(url)
    return new Response(body, { status, statusText: status === 200 ? 'OK' : 'Not Found' })
  }) as unknown as typeof fetch
  return { fetchImpl, asked }
}

const queryBox = (view: PortalSearch): HTMLInputElement =>
  view.el.querySelector<HTMLInputElement>('.portal-query')!
const portalSelect = (view: PortalSearch): HTMLSelectElement =>
  view.el.querySelector<HTMLSelectElement>('.portal-select')!
const status = (view: PortalSearch): string =>
  (view.el.querySelector('.portal-status')?.textContent ?? '').trim()

describe('the form', () => {
  it('offers every portal, ENCODE first', () => {
    const { view } = mount(serving().fetchImpl)
    expect(textsOf(view.el, 'option')).toEqual(PORTALS.map((portal) => portal.label))
    expect(portalSelect(view).value).toBe('encode')
  })

  it('fetches nothing on construction, and nothing on typing', () => {
    const { fetchImpl, asked } = serving()
    const { view } = mount(fetchImpl)
    queryBox(view).value = 'GM12878'
    queryBox(view).dispatchEvent(new Event('input'))
    portalSelect(view).value = '4dn'
    portalSelect(view).dispatchEvent(new Event('change'))
    expect(asked).toEqual([])
  })

  it('says nothing until a search has been run', () => {
    const { view } = mount(serving().fetchImpl)
    expect(status(view)).toBe('')
  })
})

describe('a search', () => {
  it('hands the picker a hub whose rows are absolute', async () => {
    const { fetchImpl, asked } = serving()
    const { view, caught } = mount(fetchImpl)
    queryBox(view).value = 'GM12878'
    buttonNamed(view.el, 'search')?.click()

    await vi.waitFor(() => expect(caught.hubs).toHaveLength(1))
    expect(asked[0]).toContain('searchTerm=GM12878')
    const hub = caught.hubs[0]
    expect(hub.kind).toBe('metacooler.hub')
    expect(hub.name).toBe('ENCODE: "GM12878"')
    expect(hub.entries).toHaveLength(7)
    expect(hub.entries.every((entry) => /^https:\/\//.test(entry.uri))).toBe(true)
    expect(caught.errors).toEqual([])
  })

  it('searches on Enter, which is what a box beside a button means', async () => {
    const { fetchImpl, asked } = serving()
    const { view, caught } = mount(fetchImpl)
    queryBox(view).value = 'K562'
    queryBox(view).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await vi.waitFor(() => expect(caught.hubs).toHaveLength(1))
    expect(asked[0]).toContain('searchTerm=K562')
  })

  it('asks the portal the select is on', async () => {
    const { fetchImpl, asked } = serving('{"@graph": [], "total": 0}')
    const { view, caught } = mount(fetchImpl)
    portalSelect(view).value = '4dn'
    portalSelect(view).dispatchEvent(new Event('change'))
    await view.run()

    expect(asked[0]).toContain('data.4dnucleome.org')
    expect(caught.hubs[0].name).toBe('4DN: all released Hi-C')
  })

  it('counts what came back, and says how many matched when there are more', async () => {
    const { view } = mount(serving().fetchImpl)
    await view.run()
    expect(status(view)).toContain('Showing 7 of 176 matches')
  })

  it('counts plainly when the page is the whole answer', async () => {
    const one = JSON.stringify({
      total: 1,
      '@graph': [
        { accession: 'ENCFF014VMM', href: '/files/ENCFF014VMM/@@download/ENCFF014VMM.hic' },
      ],
    })
    const { view } = mount(serving(one).fetchImpl)
    await view.run()
    expect(status(view)).toBe('1 result')
  })

  /**
   * "0 results" is true and useless. What a reader who typed a gene name into a
   * file search needs is what this box is for and that an empty one is allowed.
   */
  it('says what a query looks like when nothing matched', async () => {
    const { view, caught } = mount(serving('{"@graph": [], "total": 0}').fetchImpl)
    await view.run()
    expect(status(view)).toContain('matched nothing')
    expect(status(view)).toContain('empty box')
    // Still a hub: the table clears rather than keeping the last search's rows.
    expect(caught.hubs[0].entries).toEqual([])
  })

  it('shows that it is working, and puts the button back afterwards', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = (async () => {
      await held
      return new Response(ENCODE_BODY, { status: 200 })
    }) as unknown as typeof fetch
    const { view } = mount(fetchImpl)
    const running = view.run()

    expect(status(view)).toBe('searching…')
    expect(buttonNamed(view.el, 'search')?.disabled).toBe(true)
    release()
    await running
    expect(buttonNamed(view.el, 'search')?.disabled).toBe(false)
  })
})

describe('when the portal will not answer', () => {
  /**
   * The refusal a browser gives for a response it was not allowed to read is a
   * bare `TypeError`. The sentence built around it is the only thing the reader
   * gets, so it has to reach both the line under the box and the host — which
   * is the thing that can put it somewhere a reader will not miss.
   */
  it('shows the refusal and hands the same words to the host', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const { view, caught } = mount(fetchImpl)
    portalSelect(view).value = '4dn'
    await view.run()

    expect(caught.hubs).toEqual([])
    expect(caught.errors).toHaveLength(1)
    expect(caught.errors[0]).toContain('did not let this page read its search results')
    expect(caught.errors[0]).toContain('"4DN open data"')
    expect(status(view)).toBe(caught.errors[0])
    expect(view.el.querySelector('.portal-status')?.classList.contains('bucket-error')).toBe(true)
  })

  it('lets the next search clear the refusal', async () => {
    let fail = true
    const fetchImpl = (async () => {
      if (fail) throw new TypeError('Failed to fetch')
      return new Response(ENCODE_BODY, { status: 200 })
    }) as unknown as typeof fetch
    const { view } = mount(fetchImpl)
    await view.run()
    expect(view.el.querySelector('.portal-status')?.classList.contains('bucket-error')).toBe(true)

    fail = false
    await view.run()
    expect(view.el.querySelector('.portal-status')?.classList.contains('bucket-error')).toBe(false)
    expect(status(view)).toContain('Showing 7 of 176')
  })

  it('reads a 404 as nothing matched, which is what snovault means by it', async () => {
    const { view, caught } = mount(serving('{"code": 404}', 404).fetchImpl)
    await view.run()
    expect(caught.errors).toEqual([])
    expect(caught.hubs[0].entries).toEqual([])
  })
})
