/**
 * The text around the app that no switch can reach (§29.5).
 *
 * The page's title and description and the install prompt's name are written
 * once, in `index.html` and the web manifest, and are read before a line of the
 * app has run — so they cannot follow the dev features switch, and they name
 * nothing that is a dev feature. The title and the manifest's name said
 * *(multi-genome) cool files* while the multi-genome format was off by default,
 * which is the one feature a reader of the static text could not then find.
 * The name stays (meta)cooler.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const manifest = JSON.parse(
  readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'),
) as { name: string; short_name: string; description: string }

/** The multi-genome format's words: its containers, and the name for what they hold. */
const DEV = /multi-genome|\bm?metacool\b/i

const title = /<title>([^<]*)<\/title>/.exec(page)?.[1] ?? ''
const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(page)?.[1] ?? ''

describe('the static text', () => {
  it('reads what it is checking, or it is checking nothing', () => {
    expect(title).not.toBe('')
    expect(description).not.toBe('')
  })

  it('names nothing that is a dev feature, in the page or in the install prompt', () => {
    for (const text of [title, description, manifest.name, manifest.short_name, manifest.description]) {
      expect(text).not.toMatch(DEV)
    }
  })

  it('keeps the name (meta)cooler', () => {
    expect(title.startsWith('(meta)cooler')).toBe(true)
    expect(manifest.name.startsWith('(meta)cooler')).toBe(true)
    expect(manifest.short_name).toBe('(meta)cooler')
  })
})
