// @vitest-environment jsdom
/**
 * *About*'s three tabs (§18.10, §22.4): what the viewer is, the notebooks GitHub
 * Actions publishes, and the licences — with the build stamp under all three.
 *
 * A tab is built when it is first chosen, so the Notebooks tab reads the
 * network when the reader asks for it and not when *About* opens; the row of
 * tabs is one stop for the caret, walked with the arrows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LICENSED } from '@/licences'
import { NOTEBOOKS } from '@/notebooks'
import { openAbout, type AboutNotebooks } from '@/ui/dialogs'
import { setUpDom } from '../support/dom'

beforeEach(() => {
  setUpDom()
})

afterEach(() => {
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
})

const SITE = 'https://chromosomix.app/'

function stamp(path: string): object {
  return {
    page: path,
    finished: '2026-10-21T16:53:29+00:00',
    seconds: 2695,
    chromosomix: { version: '0.16.0', commit: '8621d9070b3fadf1195f91a2ac7ba8c26017c1b5' },
    run: { url: 'https://github.com/js2264/chromosomix/actions/runs/39629629016', number: '8' },
    machine: { cores: 2, memory_gb: 7.7 },
    summary: `What ${path} found.`,
  }
}

/** A stand-in for `fetch`: each page's stamp, a 404 for the pages in `missing`. */
function site(missing: string[] = []): AboutNotebooks & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.split('/')[1] ?? ''
    return missing.includes(path)
      ? new Response('Not Found', { status: 404 })
      : new Response(JSON.stringify(stamp(path)), { status: 200 })
  })
  return { site: SITE, read }
}

const tabs = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.about-tab')]
const tab = (id: string): HTMLButtonElement => document.querySelector(`.about-tab[data-tab="${id}"]`) as HTMLButtonElement
const shown = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((panel) => !panel.hidden).map((panel) => panel.id)
/** Let every stamp's promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the tabs', () => {
  it('opens on the overview, with the notebooks and the licences beside it and the caret on the row', () => {
    openAbout('https://example.org/repo', null, undefined, null, site())
    expect(tabs().map((button) => button.textContent)).toEqual(['Overview', 'Notebooks', 'Licences'])
    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tab('overview').getAttribute('aria-selected')).toBe('true')
    expect(shown()).toEqual(['about-panel-overview'])
    expect(document.activeElement).toBe(tab('overview'))
    // One stop in the caret's walk for the whole row.
    expect(tabs().map((button) => button.tabIndex)).toEqual([0, -1, -1])
  })

  it('keeps the build stamp under every tab', () => {
    openAbout('https://example.org/repo', null, undefined, null, site())
    for (const id of ['overview', 'notebooks', 'licences']) {
      tab(id).click()
      expect(document.querySelector('.about-foot .about-build')?.textContent).toMatch(/^version /)
    }
  })

  it('moves the licences to a tab of their own, built when it is chosen', () => {
    openAbout('https://example.org/repo', null, undefined, null, null)
    expect(tabs().map((button) => button.textContent)).toEqual(['Overview', 'Licences'])
    expect(document.querySelector('.about-licence-row')).toBeNull()
    tab('licences').click()
    expect(shown()).toEqual(['about-panel-licences'])
    expect(document.querySelectorAll('.about-licence-row')).toHaveLength(LICENSED.length)
    expect(document.querySelector('#about-panel-licences')?.getAttribute('aria-labelledby')).toBe('about-tab-licences')
    // And back: the overview is the one panel shown, the licences kept.
    tab('overview').click()
    expect(shown()).toEqual(['about-panel-overview'])
    expect(document.querySelectorAll('.about-licence-row')).toHaveLength(LICENSED.length)
  })

  it('walks the row with the arrows, Home and End, choosing as it goes', () => {
    openAbout('https://example.org/repo', null, undefined, null, site())
    const key = (key: string): void => {
      ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    key('ArrowRight')
    expect(document.activeElement).toBe(tab('notebooks'))
    expect(shown()).toEqual(['about-panel-notebooks'])
    key('End')
    expect(document.activeElement).toBe(tab('licences'))
    key('ArrowRight')
    expect(document.activeElement).toBe(tab('overview'))
    key('ArrowLeft')
    expect(document.activeElement).toBe(tab('licences'))
    key('Home')
    expect(document.activeElement).toBe(tab('overview'))
    expect(tabs().map((button) => button.tabIndex)).toEqual([0, -1, -1])
  })
})

describe('the notebooks', () => {
  it('reads nothing until the tab is chosen, then every page’s stamp once', async () => {
    const notebooks = site()
    openAbout('https://example.org/repo', null, undefined, null, notebooks)
    expect(notebooks.read).not.toHaveBeenCalled()
    tab('notebooks').click()
    expect(notebooks.read.mock.calls.map(([url]) => url)).toEqual(
      NOTEBOOKS.map((notebook) => `${SITE}${notebook.path}/rendered.json`),
    )
    tab('overview').click()
    tab('notebooks').click()
    expect(notebooks.read).toHaveBeenCalledTimes(NOTEBOOKS.length)
  })

  it('links each page, and says what it found, when and from what', async () => {
    openAbout('https://example.org/repo', null, undefined, null, site())
    tab('notebooks').click()
    const rows = [...document.querySelectorAll<HTMLElement>('.about-notebook')]
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual(
      NOTEBOOKS.map((notebook) => `${SITE}${notebook.path}/`),
    )
    expect(rows[0]?.querySelector('a')?.getAttribute('target')).toBe('_blank')
    expect(rows[0]?.querySelector('.about-notebook-stamp')?.textContent).toBe('Reading when it was rendered…')
    await settle()
    const validation = rows[0] as HTMLElement
    expect(validation.querySelector('.about-notebook-found')?.textContent).toBe('What validation found.')
    expect(validation.querySelector('.about-notebook-found')?.classList.contains('hidden')).toBe(false)
    const line = validation.querySelector('.about-notebook-stamp')?.textContent ?? ''
    expect(line).toMatch(/^Rendered .*2026 from chromosomix 0\.16\.0 at 8621d90, in 45 min on 2 cores and 7\.7 GB · run 8$/)
    expect(validation.querySelector('.about-notebook-stamp a')?.getAttribute('href')).toBe(
      'https://github.com/js2264/chromosomix/actions/runs/39629629016',
    )
  })

  it('leaves the link alone where a stamp cannot be read', async () => {
    openAbout('https://example.org/repo', null, undefined, null, site(['timings']))
    tab('notebooks').click()
    await settle()
    const timings = document.querySelector('.about-notebook[data-notebook="timings"]') as HTMLElement
    expect(timings.querySelector('a')?.getAttribute('href')).toBe(`${SITE}timings/`)
    expect(timings.querySelector('.about-notebook-stamp')).toBeNull()
    expect(timings.querySelector('.about-notebook-found')).toBeNull()
    expect(document.querySelector('.about-notebook[data-notebook="parity"] .about-notebook-found')?.textContent).toBe(
      'What parity found.',
    )
  })

  it('links the pages alone where nothing may be fetched', () => {
    openAbout('https://example.org/repo', null, undefined, null, { site: SITE, read: null })
    tab('notebooks').click()
    expect(document.querySelectorAll('.about-notebook')).toHaveLength(NOTEBOOKS.length)
    expect(document.querySelector('.about-notebook-stamp')).toBeNull()
    expect(document.querySelector('.about-notebooks')?.textContent).toMatch(/^Four notebooks hold chromosomix/)
  })
})
