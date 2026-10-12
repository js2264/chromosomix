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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  builtinStores,
  customStore,
  encodeShards,
  frontById,
  hubStoreFront,
  initialsOf,
  storeFronts,
} from '@/ui/stores/registry'
import { addStoreRow } from '@/state/stores'
import { resetDevFeatures } from '@/state/devFeatures'

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

// Every shipped store, the DNA Bacterial Zoo's included, which is a dev feature
// (§29): the last case here is the shelf with the switch off.
beforeEach(() => resetDevFeatures(true))
afterEach(() => resetDevFeatures())

describe('the shipped stores, on a page', () => {
  it('are seven, in the order the tiles offer them', () => {
    expect(builtinStores().map((front) => front.id)).toEqual([
      'rsg',
      // The lab's other shelf, beside its first.
      'dbz',
      'igv',
      '4dn',
      'encode',
      'dnazoo',
      // Last, and the only one that is not a file this project generates: a
      // `hub.txt` on somebody else's host, read by the same `fetchStore`
      // (§24.10).
      'roadmap',
    ])
    expect(builtinStores().map((front) => front.kind)).toEqual([
      'gallery',
      // IGV's cards, from one file of its own.
      'genomes',
      'genomes',
      'portal',
      'portal',
      'portal',
      // A hub's page *is* the portal front: grouped, faceted, two verbs a row.
      // Nothing downstream of `hubStore` knows what a hub is, which is what
      // let a hub be shipped as a store with no front of its own (§24.10).
      'portal',
    ])
  })

  it('gives every tile a line short enough for the two it is drawn on', () => {
    // A large tile is 10.5rem wide and its subtitle is two lines of
    // `--step--2`, which is about fifty characters. Longer than that and the
    // tile either clipped a word or grew a third line and pushed the row under
    // it off the screen, and it did both before these existed.
    //
    // A character budget rather than a measurement, for the reason every CSS
    // test in this suite gives: jsdom has no layout. Fifty is the count that
    // fits at the narrowest the tile is ever drawn — the budget is the whole
    // point, so it is stated here rather than discovered in a screenshot.
    const long = [...storeFronts(), hubStoreFront(), customStore()]
      .map((front) => ({ id: front.id, line: front.tagline ?? front.blurb }))
      .filter((front) => front.line.length > 50)
    expect(long).toEqual([])
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
    // Roadmap is the exception, and reads from WashU: it is somebody else's
    // hub rather than a file this project generates, so there is no `stores/`
    // entry and no workflow behind it — only the URL, read on the gesture that
    // opens it like every other store's rows.
    expect(frontById('roadmap')?.rows?.url).toBe(
      'https://vizhub.wustl.edu/VizHub/RoadmapIntegrative.txt',
    )
    expect(frontById('roadmap')?.sessions).toBeUndefined()
    // …and so it says whose it is when it is not there, rather than sending a
    // maintainer to a workflow that has never written it.
    expect(frontById('roadmap')?.rows?.publishedBy).toContain('vizhub.wustl.edu')
    // The DNA Bacterial Zoo is the lab's own analyses, not a file the workflow
    // writes: it lives beside its data on the lab's bucket, one file with its
    // sessions among its rows — and says what publishes it, since it is not the
    // workflow the default sentence names.
    expect(frontById('dbz')?.rows?.url).toBe('https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.chromosomix.json')
    expect(frontById('dbz')?.sessions).toBeUndefined()
    expect(frontById('dbz')?.rows?.publishedBy).toContain('s3://rsglab-data/dbz/')
  })

  it('points every shipped store and the hub door at the people who made it', () => {
    // A store is somebody else's data and the rows are a translation of their
    // catalogue, carrying none of the licence, citation or caveats they wrote
    // down. The link in the drawer's head is the whole of what this viewer
    // does about that, so a shipped store without one is a bug.
    for (const front of builtinStores()) {
      expect(front.home, front.id).toMatch(/^https:\/\//)
    }
    expect(frontById('rsg')?.home).toContain('research.pasteur.fr')
    expect(frontById('dbz')?.home).toBe(frontById('rsg')?.home)
    expect(frontById('roadmap')?.home).toBe('https://egg2.wustl.edu/roadmap/web_portal/')
    // …and the hub door points at where hubs are, rather than at a hub.
    expect(frontById('hub')?.home).toBe('https://genome-euro.ucsc.edu/cgi-bin/hgHubConnect')
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
    // A card a species, with its sample and its replicon count on it.
    expect(frontById('dbz')?.group).toBe('species')
    expect(frontById('dbz')?.headline).toEqual(['id', 'sequences'])
  })
})

describe('stores the reader connected', () => {
  it('follow the shipped ones as tiles of their own, and come back by id', () => {
    window.localStorage.clear()
    const row = addStoreRow({ label: 'Lab shelf', url: 'https://lab.example/store.json' })
    const fronts = storeFronts()
    expect(fronts.map((front) => front.id)).toEqual([
      'rsg',
      'dbz',
      'igv',
      '4dn',
      'encode',
      'dnazoo',
      'roadmap',
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

describe('the DNA Bacterial Zoo, a dev feature (§29)', () => {
  it('has no tile while the switch is off, and its own beside the lab’s first shelf while it is on', () => {
    // Published with the multi-genome format, when the metacooler project is:
    // until then a reader with the switch off has no tile, tooltip or drawer.
    resetDevFeatures(false)
    expect(builtinStores().map((front) => front.id)).toEqual(['rsg', 'igv', '4dn', 'encode', 'dnazoo', 'roadmap'])
    expect(frontById('dbz')).toBeNull()
    expect(storeFronts().some((front) => front.id === 'dbz')).toBe(false)
    resetDevFeatures(true)
    expect(builtinStores().map((front) => front.id).slice(0, 2)).toEqual(['rsg', 'dbz'])
  })
})
