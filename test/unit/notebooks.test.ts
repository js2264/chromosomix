/**
 * The notebooks *About* names (`src/notebooks.ts`, SPECS §18.10): the list held
 * to the one the workflow publishes, where each build finds the site holding
 * them, and a `rendered.json` read without being believed.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { NOTEBOOKS, fetchStamp, notebookUrl, notebooksSite, parseStamp, stampUrl } from '@/notebooks'
import { NOTEBOOK_SEGMENTS } from '@/versions'

const ROOT = join(__dirname, '..', '..')

/** The validation's stamp as the site published it, by run 8 of the workflow. */
const VALIDATION = {
  page: 'validation',
  published_at: 'https://chromosomix.app/validation/',
  started: '2026-10-21T16:08:34+00:00',
  finished: '2026-10-21T16:53:29+00:00',
  seconds: 2695,
  chromosomix: {
    version: '0.16.0',
    commit: '8621d9070b3fadf1195f91a2ac7ba8c26017c1b5',
    tag: null,
    source: 'https://github.com/js2264/chromosomix',
  },
  run: {
    url: 'https://github.com/js2264/chromosomix/actions/runs/39629629016',
    number: '8',
    attempt: '1',
    workflow: 'Notebooks',
    event: 'workflow_dispatch',
    actor: 'js2264',
  },
  machine: {
    system: 'Linux 7.0.0-1017-azure',
    architecture: 'x86_64',
    processor: 'AMD EPYC 9V74 80-Core Processor',
    cores: 2,
    memory_gb: 7.7,
    python: '3.13.16',
    quarto: '1.10.19',
  },
  summary: '20 of 23 analyses reproduce their reference to the float32 the app computes in, or to every digit written.',
}

describe('the list', () => {
  it('is the pages the workflow publishes, in its order, under their titles', () => {
    // `notebooks/scripts/pages.py` is the one table of where each page is
    // published: `Page('<path>', '<title>', …)`, one per notebook.
    const pages = [...readFileSync(join(ROOT, 'notebooks/scripts/pages.py'), 'utf8').matchAll(/Page\('([^']+)', '([^']+)'/g)]
    expect(pages.map(([, path, title]) => ({ path, title }))).toEqual(
      NOTEBOOKS.map(({ path, title }) => ({ path, title })),
    )
  })

  it('is the segments the service worker leaves to the network', () => {
    expect(NOTEBOOKS.map((notebook) => notebook.path)).toEqual([...NOTEBOOK_SEGMENTS])
  })

  it('says what each holds chromosomix to, in a sentence', () => {
    for (const notebook of NOTEBOOKS) expect(notebook.what).toMatch(/^[A-Z0-9].{40,}\.$/)
  })
})

describe('where the notebooks are', () => {
  const site = {
    target: 'web' as const,
    portable: false,
    dev: false,
    href: 'https://chromosomix.app/?x=1#y',
    siteBase: '/',
    homepage: 'https://chromosomix.app/',
  }

  it('is this site, from the site and from any build pinned on it', () => {
    expect(notebooksSite(site)).toBe('https://chromosomix.app/')
    // An archived build, or a preview, reaches up to the site's root.
    expect(notebooksSite({ ...site, href: 'https://example.github.io/chromosomix/v/abc1234/' , siteBase: '/chromosomix/' })).toBe(
      'https://example.github.io/chromosomix/',
    )
  })

  it('is the deployed site wherever this page is not on it', () => {
    for (const where of [
      { ...site, target: 'desktop' as const, href: 'app://viewer/index.html' },
      { ...site, target: 'standalone' as const, href: 'file:///home/me/chromosomix.html' },
      { ...site, portable: true, href: 'https://lab.example.org/viewer/' },
      { ...site, dev: true, href: 'http://127.0.0.1:5173/' },
    ]) {
      expect(notebooksSite(where)).toBe('https://chromosomix.app/')
    }
    expect(notebooksSite({ ...site, dev: true, homepage: 'https://chromosomix.app' })).toBe('https://chromosomix.app/')
  })

  it('is nowhere for a build with neither', () => {
    expect(notebooksSite({ ...site, dev: true, homepage: '' })).toBeNull()
    expect(notebooksSite({ ...site, target: 'desktop', homepage: 'not a url' })).toBeNull()
  })

  it('puts each page and its stamp under the site', () => {
    const validation = NOTEBOOKS[0]
    expect(notebookUrl('https://chromosomix.app/', validation)).toBe('https://chromosomix.app/validation/')
    expect(stampUrl('https://example.github.io/chromosomix/', validation)).toBe(
      'https://example.github.io/chromosomix/validation/rendered.json',
    )
  })
})

describe('a stamp', () => {
  it('reads what the workflow wrote', () => {
    expect(parseStamp(VALIDATION)).toEqual({
      finished: '2026-10-21T16:53:29+00:00',
      seconds: 2695,
      version: '0.16.0',
      commit: '8621d90',
      run: { url: 'https://github.com/js2264/chromosomix/actions/runs/39629629016', number: '8' },
      machine: { cores: 2, memoryGb: 7.7 },
      summary: VALIDATION.summary,
    })
  })

  it('reads a render by hand, which names no run', () => {
    expect(parseStamp({ ...VALIDATION, run: null })?.run).toBeNull()
  })

  it('is no stamp without when it finished and from which version', () => {
    expect(parseStamp({ ...VALIDATION, finished: 'yesterday' })).toBeNull()
    expect(parseStamp({ ...VALIDATION, chromosomix: { version: '<b>0.16</b>' } })).toBeNull()
    expect(parseStamp(null)).toBeNull()
    expect(parseStamp([VALIDATION])).toBeNull()
    expect(parseStamp('{}')).toBeNull()
  })

  it('drops a field that fails its check rather than repairing it', () => {
    const odd = parseStamp({
      ...VALIDATION,
      seconds: -4,
      chromosomix: { version: '0.16.0', commit: 'not-a-commit' },
      run: { url: 'javascript:alert(1)', number: '8' },
      machine: { cores: 2.5, memory_gb: 7.7 },
      summary: 'x'.repeat(601),
    })
    expect(odd).toMatchObject({ seconds: null, commit: '', run: null, machine: null, summary: '' })
    // A run on another host is not a link this dialog will draw.
    expect(parseStamp({ ...VALIDATION, run: { url: 'https://example.org/actions/runs/1', number: '1' } })?.run).toBeNull()
  })

  it('folds the summary onto one line', () => {
    expect(parseStamp({ ...VALIDATION, summary: '  20 of 23\n  analyses  ' })?.summary).toBe('20 of 23 analyses')
  })

  it('is read, or null for any failure, never an error', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(VALIDATION), { status: 200 }))
    expect((await fetchStamp('https://chromosomix.app/validation/rendered.json', ok))?.version).toBe('0.16.0')
    expect(ok).toHaveBeenCalledWith('https://chromosomix.app/validation/rendered.json')
    expect(await fetchStamp('u', async () => new Response('Not Found', { status: 404 }))).toBeNull()
    expect(await fetchStamp('u', async () => new Response('<html>', { status: 200 }))).toBeNull()
    expect(await fetchStamp('u', async () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull()
  })
})
