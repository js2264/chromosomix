/**
 * The documentation's live views (SPECS §32.4, `documentation/src/lib/live.mjs`):
 * a picture whose title is `live: <link>` becomes the app, embedded, on that
 * link's view when its button is pressed.
 *
 * What a broken one costs is a reader pressing **Try it live** under a picture
 * and getting a different picture, or the file picker. So every link on every
 * page is read here the way the app reads it — `parseViewState`, the reader of
 * every link the app is handed — and every key it carries has to come back out
 * of the state the app would open, with its value: a key misspelt, a view the
 * app does not have, a value it refuses, each falls out of that round trip
 * where on the page it would fail in silence.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseViewState, serialiseViewState } from '@/state/ViewState'

import { embedAddress, liveLink, viewerAddress } from '../../documentation/src/lib/live.mjs'

const DOCS = join(__dirname, '..', '..', 'documentation', 'src', 'content', 'docs')

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  )

/** Every live picture on every page: the page, and the link its title names. */
const LIVE = walk(DOCS)
  .filter((path) => /\.mdx?$/.test(path))
  .flatMap((page) =>
    Array.from(readFileSync(page, 'utf8').matchAll(/!\[[^\]]*\]\([^)\s]+ "(live:[^"]*)"\)/g), (match) => ({
      page: relative(DOCS, page),
      title: match[1],
    })),
  )

/** The keys and values of a fragment, decoded as the app decodes them. */
function keysOf(fragment: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of fragment.replace(/^#/, '').split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    out.set(decodeURIComponent(eq < 0 ? part : part.slice(0, eq)), decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1)))
  }
  return out
}

describe('a live view’s link', () => {
  it('is read from the title that names it, and from no other', () => {
    expect(liveLink('live: #uri=a.cool&view=region')).toBe('#uri=a.cool&view=region')
    expect(liveLink('live:?config=https://x/y.chromosomix.json')).toBe('?config=https://x/y.chromosomix.json')
    expect(liveLink('a tooltip')).toBeNull()
    expect(liveLink('live: uri=a.cool')).toBeNull()
    expect(liveLink(undefined)).toBeNull()
  })

  it('embeds the app with embed first in its query, and opens the full app without it', () => {
    const app = 'https://chromosomix.app/v/v0.20.0/'
    expect(embedAddress(app, '#uri=a.cool')).toBe('https://chromosomix.app/v/v0.20.0/?embed=1#uri=a.cool')
    expect(embedAddress(app, '?config=https://x/y.chromosomix.json')).toBe(
      'https://chromosomix.app/v/v0.20.0/?embed=1&config=https://x/y.chromosomix.json',
    )
    expect(viewerAddress(app, '#uri=a.cool')).toBe('https://chromosomix.app/v/v0.20.0/#uri=a.cool')
  })
})

describe('every live view in the documentation', () => {
  it('exists, a handful of them', () => {
    expect(LIVE.length).toBeGreaterThanOrEqual(5)
  })

  it.each(LIVE)('$page: $title', ({ title }) => {
    const link = liveLink(title)
    expect(link, 'the title names a link').not.toBeNull()
    if (link === null) return
    if (link.startsWith('?')) {
      // A workspace: an address of one, which the app fetches and opens.
      const query = new URLSearchParams(link.slice(1).split('#')[0])
      expect(query.get('config') ?? '').toMatch(/^https:\/\/.+\.chromosomix\.json$/)
      return
    }
    const state = parseViewState(link)
    expect(state, 'the app opens a file from it').not.toBeNull()
    if (state === null) return
    const asked = keysOf(link)
    const opened = keysOf(serialiseViewState(state))
    for (const [key, value] of asked) {
      expect(opened.get(key), `${key} survives the app's reading`).toBe(value)
    }
  })
})
