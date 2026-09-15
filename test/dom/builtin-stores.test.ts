// @vitest-environment jsdom
/**
 * The stores this build ships: read from the site the page is on, under
 * `stores/`, and from nowhere else — same origin, so no CORS enters into it,
 * and a private repository changes nothing (SPECS §24.3).
 *
 * And ENCODE's shard facets are checked against the generator's, which is the
 * other thing this file is for. ENCODE is published as twelve shards because
 * the whole of it is 1.2 million rows, and the shard ids live in two places
 * that cannot import each other: `scripts/make_store.py` writes them and
 * `src/ui/stores/registry.ts` chooses among them. A name that drifted would be
 * a shelf that answers 404 for a file that exists under another name — and the
 * front would report it as *not generated yet*, which is the one failure mode
 * that looks like a normal state.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { builtinStores, customStore, encodeShards, frontById, initialsOf, storeFronts } from '@/ui/stores/registry'
import { addStoreRow } from '@/state/stores'

// `process.cwd()` rather than `import.meta.url`: this suite runs in jsdom,
// where a module's own URL is an `http://localhost/` one and `readFileSync`
// refuses it. Vitest runs from the repository root, which is the one path both
// environments agree on.
const GENERATOR = readFileSync(join(process.cwd(), 'scripts', 'make_store.py'), 'utf8')

/**
 * The shard ids `make_store.py` writes, read out of its source.
 *
 * Reading the Python rather than running it, because what is being checked is
 * the *list* and not the generator: a test that ran the script would need a
 * network, a portal and a gigabyte of manifest to answer a question about two
 * tuples.
 */
function generatorShards(): string[] {
  const assemblies = /ENCODE_SHARDS = tuple\([\s\S]*?for assembly in \(([^)]*)\)/.exec(GENERATOR)
  const categories = /ENCODE_SHARDS = tuple\([\s\S]*?for category in \(([^)]*)\)/.exec(GENERATOR)
  expect(assemblies, 'ENCODE_SHARDS moved in make_store.py').not.toBeNull()
  expect(categories, 'ENCODE_SHARDS moved in make_store.py').not.toBeNull()
  const names = (match: RegExpExecArray | null): string[] =>
    [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((one) => one[1])
  return names(assemblies).flatMap((assembly) =>
    names(categories).map((category) => `${assembly}-${category}`),
  )
}

describe('the shipped stores, on a page', () => {
  it('are five, in the order the tiles offer them', () => {
    expect(builtinStores().map((front) => front.id)).toEqual([
      'rsg',
      'igv',
      '4dn',
      'encode',
      'dnazoo',
    ])
    expect(builtinStores().map((front) => front.kind)).toEqual([
      'gallery',
      'genomes',
      'portal',
      'portal',
      'portal',
    ])
  })

  it('read the generated files from this site, under stores/', () => {
    const site = new URL(window.location.href).origin
    expect(frontById('igv')?.rows?.url).toBe(`${site}/stores/igv.json`)
    expect(frontById('igv')?.sessions?.url).toBe(`${site}/stores/igv-sessions.json`)
    expect(frontById('4dn')?.rows?.url).toBe(`${site}/stores/4dn.json`)
    expect(frontById('4dn')?.sessions?.url).toBe(`${site}/stores/4dn-sessions.json`)
    expect(frontById('encode')?.shards?.url('GRCh38', 'signal')).toBe(
      `${site}/stores/encode-GRCh38-signal.json`,
    )
    expect(frontById('encode')?.sessions?.url).toBe(`${site}/stores/encode-sessions.json`)
    // DNA Zoo is a bucket walk rather than a portal query, and publishes no
    // sessions — one file, written by the `bucket` front end.
    expect(frontById('dnazoo')?.rows?.url).toBe(`${site}/stores/dnazoo.json`)
    expect(frontById('dnazoo')?.sessions).toBeUndefined()
  })

  it('offers one ENCODE shard per pair the generator writes, and no others', () => {
    expect(encodeShards()).toEqual(generatorShards())
  })

  it('costs no request: one inline store, and a URL for every other', () => {
    for (const front of builtinStores()) {
      expect(front.builtin).toBe(true)
      if (front.id === 'rsg') {
        expect(front.rows?.inline).toBeDefined()
        expect(front.rows?.url).toBeUndefined()
        continue
      }
      expect(front.rows?.inline).toBeUndefined()
      expect(front.rows?.url !== undefined || front.shards !== undefined).toBe(true)
    }
  })

  it('names the column each portal groups its rows under, and the axes its matrix opens on', () => {
    // The group is what pairs a row with its pre-configured session (§24.3):
    // 4DN's experiment set, ENCODE's experiment, IGV's assembly.
    expect(frontById('4dn')?.group).toBe('set')
    expect(frontById('encode')?.group).toBe('dataset')
    expect(frontById('igv')?.group).toBe('assembly')
    expect(frontById('4dn')?.axes).toEqual(['assay', 'biosource'])
    // DNA Zoo folds under the species a directory on its bucket is, and the
    // heading carries the common name beside it.
    expect(frontById('dnazoo')?.group).toBe('species')
    expect(frontById('dnazoo')?.headline).toEqual(['common'])
    expect(frontById('dnazoo')?.axes).toEqual(['assembly', 'format'])
    expect(frontById('encode')?.axes).toEqual(['assay', 'biosample'])
  })
})

describe('stores the reader connected', () => {
  it('follow the shipped ones as tiles of their own, and come back by id', () => {
    window.localStorage.clear()
    const row = addStoreRow({ label: 'Lab shelf', url: 'https://lab.example/store.json' })
    const fronts = storeFronts()
    expect(fronts.map((front) => front.id)).toEqual([
      'rsg',
      'igv',
      '4dn',
      'encode',
      'dnazoo',
      row.id,
    ])
    const mine = frontById(row.id)
    expect(mine?.kind).toBe('custom')
    expect(mine?.builtin).toBe(false)
    expect(mine?.rows?.url).toBe('https://lab.example/store.json')
    expect(mine?.mark.text).toBe('LS')
    window.localStorage.clear()
  })

  it('has an add tile with no rows, which the drawer draws as a URL box', () => {
    expect(customStore().rows).toBeUndefined()
    expect(frontById('custom')?.kind).toBe('custom')
    expect(frontById('nothing-like-it')).toBeNull()
  })

  it('makes two or three letters out of a label for the tile', () => {
    expect(initialsOf('Lab shelf')).toBe('LS')
    expect(initialsOf('4dn')).toBe('4DN')
    expect(initialsOf('my lab hi-c data')).toBe('MLH')
    expect(initialsOf('')).toBe('?')
  })
})
