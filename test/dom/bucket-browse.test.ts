// @vitest-environment jsdom
/**
 * The folder view over a private prefix, as a reader meets it at a URL box.
 *
 * What is worth pinning here is not that a listing parses — `s3-buckets.test.ts`
 * owns that — but the three things this view can get wrong while looking
 * completely correct:
 *
 * - **A pick has to carry the scope it was listed under.** The URL alone is
 *   enough for a public file and enough for a private one *by luck*, because a
 *   second lookup resolves the same key; the moment two scopes overlap, the
 *   luckier one wins and the file opens signed by a key the reader did not
 *   choose.
 * - **A filter must not be able to lie about the bucket.** It reads one level
 *   of one prefix, so "nothing matches" means nothing here — and the line under
 *   the list is the only thing standing between that and "nothing in the
 *   bucket". Truncation outranks it: a folder past a thousand keys is the one
 *   case where the list on screen is not the folder.
 * - **Navigation must ask S3 for the folder that was clicked.** Getting the
 *   prefix arithmetic wrong lists the parent again, which looks like a folder
 *   that will not open rather than like a bug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BucketBrowseView, note, openBucketBrowser } from '@/ui/bucketBrowse'
import { writeScopes, type BucketScope } from '@/s3/credentials'
import type { BucketObject } from '@/s3/list'
import { all, buttonNamed, mounted, textsOf, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  vi.unstubAllGlobals()
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove())
})

const BASE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/'

function scope(overrides: Partial<BucketScope> = {}): BucketScope {
  return {
    id: 'b0',
    label: 'lab collections',
    base: BASE,
    region: 'eu-west-3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    ...overrides,
  }
}

/** A `ListObjectsV2` body: sub-prefixes, keys, and whether S3 stopped early. */
function listing(
  folders: readonly string[],
  keys: ReadonlyArray<[string, number]>,
  truncated = false,
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
    `<IsTruncated>${truncated}</IsTruncated>` +
    folders.map((prefix) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`).join('') +
    keys
      .map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`)
      .join('') +
    `</ListBucketResult>`
  )
}

/** Every URL a listing was asked for, in order, with `fetch` answering `bodies`. */
function serve(bodies: readonly string[]): string[] {
  const asked: string[] = []
  let at = 0
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url)
    const body = bodies[Math.min(at++, bodies.length - 1)]
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(body) })
  })
  return asked
}

/** The prefix a listing request carried. */
function prefixOf(url: string): string {
  return new URL(url).searchParams.get('prefix') ?? ''
}

describe('the browse view', () => {
  it('draws the folders, then the files, with their sizes', async () => {
    serve([listing(['collections/hum53/'], [['collections/notes.txt', 2048]])])
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/')

    expect(textsOf(view.el, '.folder-entry-name')).toEqual(['hum53/', 'notes.txt'])
    expect(textsOf(view.el, '.folder-entry-size')).toEqual(['2.0 kB'])
  })

  it('hands a picked file back with the scope that listed it', async () => {
    serve([listing([], [['collections/hum53.mcool', 10]])])
    const picked: Array<{ object: BucketObject; scope: BucketScope }> = []
    const view = new BucketBrowseView({
      onPick: (object, from) => picked.push({ object, scope: from }),
    })
    await view.browse(scope(), 'collections/')

    mounted(view.el, () => {
      all<HTMLButtonElement>(view.el, '.folder-entry-file')[0].click()
    })
    expect(picked).toHaveLength(1)
    expect(picked[0].object.url).toBe(
      'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/hum53.mcool',
    )
    // The key, not just the URL: a second resolution could pick another scope
    // whose prefix also covers this file.
    expect(picked[0].scope.id).toBe('b0')
  })

  it('lists the folder that was clicked, not the one above it', async () => {
    const asked = serve([
      listing(['collections/hum53/'], []),
      listing([], [['collections/hum53/map.mcool', 4]]),
    ])
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/')

    const folder = all<HTMLButtonElement>(view.el, '.folder-entry')[0]
    folder.click()
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    expect(prefixOf(asked[1])).toBe('collections/hum53/')
    await vi.waitFor(() => expect(textsOf(view.el, '.folder-entry-name')).toEqual(['map.mcool']))
  })

  it('climbs back up by the breadcrumb, and roots it at the scope’s own prefix', async () => {
    const asked = serve([listing([], [])])
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/hum53/2026-03/')

    // No crumb above `collections/`: the key may not be allowed to list there,
    // so offering one would be offering a click that 403s.
    expect(textsOf(view.el, '.folder-crumbs button')).toEqual([
      'lab collections',
      'hum53',
      '2026-03',
    ])
    buttonNamed(view.el, 'hum53')?.click()
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    expect(prefixOf(asked[1])).toBe('collections/hum53/')
  })

  it('filters the level on screen, and says how much it is hiding', async () => {
    const keys: Array<[string, number]> = Array.from({ length: 12 }, (_, at) => [
      `collections/${at < 3 ? 'ATAC' : 'RNA'}_${at}.bw`,
      100,
    ])
    serve([listing([], keys)])
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/')

    const filter = view.el.querySelector<HTMLInputElement>('.folder-filter')
    expect(filter).not.toBeNull()
    expect(view.el.querySelector('.folder-filter-row')?.classList.contains('hidden')).toBe(false)

    filter!.value = 'atac'
    filter!.dispatchEvent(new window.Event('input'))
    expect(all(view.el, '.folder-entry')).toHaveLength(3)
    // The count is the honest part: without it, three rows out of twelve reads
    // as a folder holding three files.
    expect(view.el.querySelector('.folder-note')?.textContent).toContain('3 of 12')
  })

  it('offers no filter for a folder short enough to read', async () => {
    serve([listing([], [['collections/one.bw', 1], ['collections/two.bw', 2]])])
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/')

    expect(view.el.querySelector('.folder-filter-row')?.classList.contains('hidden')).toBe(true)
  })

  it('reports a refused listing where the list would have been', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/')

    const line = view.el.querySelector('.folder-note')
    expect(line?.classList.contains('folder-error')).toBe(true)
    expect(line?.textContent).toContain('AllowedHeaders')
  })

  it('forgets the filter on the way into a folder', async () => {
    const keys: Array<[string, number]> = Array.from({ length: 10 }, (_, at) => [
      `collections/f${at}.bw`,
      1,
    ])
    serve([listing(['collections/hum53/'], keys), listing([], [['collections/hum53/x.bw', 1]])])
    const view = new BucketBrowseView({ onPick: () => {} })
    await view.browse(scope(), 'collections/')

    const filter = view.el.querySelector<HTMLInputElement>('.folder-filter')!
    // Matches the folder and none of the ten files, so the row clicked below is
    // the folder and the file in it matches nothing the filter says.
    filter.value = 'hum'
    filter.dispatchEvent(new window.Event('input'))
    all<HTMLButtonElement>(view.el, '.folder-entry')[0].click()

    // A filter carried down would hide the one file in the folder just opened.
    await vi.waitFor(() => expect(textsOf(view.el, '.folder-entry-name')).toEqual(['x.bw']))
    expect(filter.value).toBe('')
  })
})

describe('the line under the list', () => {
  it('says nothing when everything is showing', () => {
    expect(note(4, 4, false, false, 'collections/')).toBe('')
  })

  it('counts what a filter is hiding, and says what it read', () => {
    expect(note(12, 3, true, false, 'collections/')).toContain('3 of 12')
    expect(note(12, 3, true, false, 'collections/')).toContain('not the whole tree')
  })

  it('answers an empty prefix as empty rather than as filtered', () => {
    expect(note(0, 0, false, false, 'collections/')).toBe('Nothing in this folder.')
  })

  it('lets truncation outrank the count', () => {
    // The one case where the rows on screen are not the folder: a count of
    // "3 of 12" here would be a true sentence about a false list.
    const said = note(1000, 3, true, true, 'collections/')
    expect(said).toContain('first 1,000')
    expect(said).not.toContain('3 of')
  })
})

describe('the dialog behind the browse button', () => {
  it('asks for a bucket instead of a listing when none is set up', () => {
    const asked = serve([listing([], [])])
    openBucketBrowser({ onPick: () => {} })

    const panel = document.querySelector('.modal-backdrop')!
    expect(buttonNamed(panel, 'add a bucket…')).not.toBeNull()
    // Nothing to list, so nothing was listed: a signed request against no
    // credential is a 403 nobody asked for.
    expect(asked).toHaveLength(0)
  })

  it('opens on the first bucket, and offers the others', async () => {
    const asked = serve([listing([], [['collections/a.bw', 1]])])
    writeScopes([scope(), scope({ id: 'b1', label: 'archive', base: `${BASE}old/` })])
    openBucketBrowser({ onPick: () => {} })

    const panel = document.querySelector('.modal-backdrop')!
    expect(textsOf(panel, '.bucket-pick')).toEqual(['lab collections', 'archive'])
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(prefixOf(asked[0])).toBe('collections/')

    buttonNamed(panel, 'archive')?.click()
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    expect(prefixOf(asked[1])).toBe('collections/old/')
  })

  it('closes on a pick, and reports the URL with its scope', async () => {
    serve([listing([], [['collections/a.bw', 1]])])
    writeScopes([scope()])
    const picked: Array<[string, string | null]> = []
    openBucketBrowser({ onPick: (url, from) => picked.push([url, from?.id ?? null]) })

    const panel = document.querySelector('.modal-backdrop')!
    await vi.waitFor(() => expect(all(panel, '.folder-entry-file')).toHaveLength(1))
    all<HTMLButtonElement>(panel, '.folder-entry-file')[0].click()

    expect(picked).toEqual([[`${BASE}a.bw`, 'b0']])
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })
})
