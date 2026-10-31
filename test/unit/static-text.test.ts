/**
 * The text around the app that no switch can reach (§29.5), and what it has to
 * carry for a search engine (§11).
 *
 * The page's title and description and the install prompt's name are written
 * once, in `index.html` and the web manifest, and are read before a line of the
 * app has run — so they cannot follow the dev features switch, and they name
 * nothing that is a dev feature. The title and the manifest's name said
 * *(multi-genome) cool files* while the multi-genome format was off by default,
 * which is the one feature a reader of the static text could not then find.
 * The name is chromosomix.
 *
 * `public/llms.txt`, the summary the site serves to language models, is static
 * text in the same sense and under the same rule, and so are the pages it links
 * under `public/llms/`, as are the description a
 * pasted link unfurls with (`og:description`), what the page says to a reader
 * or a crawler that runs no JavaScript (`<noscript>`), and the package's
 * description and keywords on npm.
 *
 * The title and the description are also what a results page prints for the
 * site, whole only under about sixty and a hundred and sixty characters, and
 * the page is found by the words in them: Hi-C, a genome browser, the formats.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const manifest = JSON.parse(
  readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'),
) as { name: string; short_name: string; description: string }
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  description: string
  keywords: string[]
}

/** The multi-genome format's words: its containers, the name for what they hold, and the field it is for. */
const DEV = /multi-genome|\bm?metacool\b|metagenom/i

const llms = readFileSync(new URL('../../public/llms.txt', import.meta.url), 'utf8')
/** The pages `llms.txt` links, which the app writes about itself (`src/llms/pages.ts`). */
const pages = readdirSync(new URL('../../public/llms/', import.meta.url))
  .filter((name) => name.endsWith('.md'))
  .map((name) => readFileSync(new URL(`../../public/llms/${name}`, import.meta.url), 'utf8'))

const title = /<title>([^<]*)<\/title>/.exec(page)?.[1] ?? ''
const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(page)?.[1] ?? ''
const unfurled = /<meta\s+property="og:description"\s+content="([^"]*)"/.exec(page)?.[1] ?? ''
const canonical = /<link\s+rel="canonical"\s+href="([^"]*)"/.exec(page)?.[1] ?? ''
const shared = /<meta\s+property="og:url"\s+content="([^"]*)"/.exec(page)?.[1] ?? ''
/** The words of the `<noscript>`, as a crawler that runs no script reads them. */
const noscript = (/<noscript>([\s\S]*?)<\/noscript>/.exec(page)?.[1] ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

describe('the static text', () => {
  it('reads what it is checking, or it is checking nothing', () => {
    for (const text of [title, description, unfurled, canonical, noscript, pkg.description]) expect(text).not.toBe('')
    expect(pkg.keywords.length).toBeGreaterThan(5)
  })

  it('names nothing that is a dev feature, in the page, the install prompt, the summary for models or on npm', () => {
    const texts = [title, description, unfurled, noscript, manifest.name, manifest.short_name, manifest.description]
    expect(pages.length).toBeGreaterThan(0)
    for (const text of [...texts, llms, ...pages, pkg.description, ...pkg.keywords]) {
      expect(text).not.toMatch(DEV)
    }
  })

  it('names the app chromosomix', () => {
    expect(title.startsWith('chromosomix')).toBe(true)
    expect(manifest.name.startsWith('chromosomix')).toBe(true)
    expect(manifest.short_name).toBe('chromosomix')
  })
})

describe('what a search reads', () => {
  it('fits a results page whole: a title of sixty characters at most, a description of a hundred and sixty', () => {
    expect(title.length).toBeLessThanOrEqual(60)
    expect(description.length).toBeLessThanOrEqual(160)
    // One description, wherever it is shown.
    expect(unfurled).toBe(description)
  })

  it('says what the app is searched by', () => {
    for (const text of [title, description, noscript]) {
      expect(text).toContain('Hi-C')
      expect(text).toMatch(/genome browser/i)
    }
    for (const format of ['.cool', '.mcool', '.hic']) {
      expect(description).toContain(format)
      expect(noscript).toContain(format)
    }
    expect(pkg.keywords).toEqual(expect.arrayContaining(['hi-c', 'cooler', 'genome-browser']))
  })

  it('lists the site under its root, whatever address reached it', () => {
    expect(canonical).toBe('https://chromosomix.app/')
    expect(shared).toBe(canonical)
  })
})
