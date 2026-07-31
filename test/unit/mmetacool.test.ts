/**
 * `.mmetacool` collections and the §3.4 inference.
 *
 * An mmetacool is a container of complete metacools and is **not** itself a
 * cooler, so opening one at its root is an error that lists the entries. What
 * happens next depends on what the entries are *called*, and the app infers it
 * rather than being told:
 *
 * - **every entry name parses as a positive integer** → a `zoomify` resolution
 *   ladder. The names are bin sizes, so they belong on the zoom control and the
 *   entry picker has nothing to add.
 * - **otherwise** → a sample or replicate collection. The names are datasets,
 *   so a picker is the only way to choose between them.
 *
 * The inference is worth testing on its own because it is a *heuristic over
 * user-chosen strings* — the format records nothing that distinguishes the two
 * cases — and because getting it backwards produces a zoom control whose levels
 * are unrelated samples, which is worse than either behaviour on its own.
 *
 * The two fixtures make the distinction concrete, and the numbers below come
 * from `test/golden/{ladder,samples}_mmetacool.json`, i.e. from Python:
 *
 * | fixture | entries | bin sizes | nnz |
 * |---|---|---|---|
 * | `ladder.mmetacool` | 1000, 2000, 4000 | 1000, 2000, 4000 | 21633, 12832, 7159 |
 * | `samples.mmetacool` | rep1, rep2 | 1000, 1000 | 21633, 24836 |
 *
 * That is the whole difference: a ladder's entries differ in *resolution* and
 * agree in content; a collection's entries agree in resolution and differ in
 * content.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ViewerError } from '../../src/errors'
import { openHdf5 } from '../../src/h5/Hdf5File'
import { detectLayout, listEntryNames } from '../../src/metacooler/detect'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { allIntegers } from '../../src/ui/FilePicker'
import { parseUri } from '../../src/uri'

const LADDER = new URL('../fixtures/ladder.mmetacool', import.meta.url).pathname
const SAMPLES = new URL('../fixtures/samples.mmetacool', import.meta.url).pathname
const hasFixtures = existsSync(LADDER) && existsSync(SAMPLES)

/** From the Python goldens; regenerate with `npm run fixtures` if these move. */
const GOLDEN = {
  ladder: {
    entries: ['1000', '2000', '4000'],
    binsizes: [1000, 2000, 4000],
    nnz: [21633, 12832, 7159],
    /** Every level sums to the same total: coarsening moves contacts, not counts. */
    sum: 50000,
  },
  samples: {
    entries: ['rep1', 'rep2'],
    binsizes: [1000, 1000],
    nnz: [21633, 24836],
  },
} as const

const openEntry = async (path: string, entry: string): Promise<MetaCooler> => {
  const uri = `${path}::entries/${entry}`
  return MetaCooler.open(uri, await LocalFileSource.open(path))
}

// ---------------------------------------------------------------------------
// The inference itself
// ---------------------------------------------------------------------------

describe('allIntegers — the §3.4 entry-naming inference', () => {
  it('reads all-integer entry names as a resolution ladder', () => {
    expect(allIntegers(['1000', '2000', '4000'])).toBe(true)
    expect(allIntegers(['1000'])).toBe(true)
    // Leading zeros are still an integer; zoomify would not write them, but a
    // hand-built collection might, and `01000` is unambiguously 1000.
    expect(allIntegers(['01000', '02000'])).toBe(true)
  })

  it('reads anything else as a sample collection', () => {
    expect(allIntegers(['rep1', 'rep2'])).toBe(false)
    expect(allIntegers(['control', 'treated'])).toBe(false)
    // One non-integer name is enough: a half-ladder is a collection, because
    // wiring `patient_a` to a zoom control would be nonsense.
    expect(allIntegers(['1000', '2000', 'merged'])).toBe(false)
  })

  it('rejects the near-misses that a looser numeric test would accept', () => {
    // `Number()` accepts every one of these; the ladder must not.
    expect(allIntegers(['0'])).toBe(false) // not a positive bin size
    expect(allIntegers(['-1000'])).toBe(false)
    expect(allIntegers(['1e3'])).toBe(false)
    expect(allIntegers(['1000.0'])).toBe(false)
    expect(allIntegers([' 1000'])).toBe(false)
    expect(allIntegers(['+1000'])).toBe(false)
    expect(allIntegers(['0x400'])).toBe(false)
    // `[].every(...)` is vacuously true, so the empty case has to be explicit:
    // a collection with no entries is not a ladder, it is a broken file.
    expect(allIntegers([])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The same inference against the real fixtures
// ---------------------------------------------------------------------------

if (!hasFixtures) {
  describe('mmetacool fixtures', () => {
    it.skip(
      'skipped: test/fixtures/{ladder,samples}.mmetacool are absent. They are generated, ' +
        'not committed — run `npm run fixtures`.',
      () => undefined,
    )
  })
}

describe.skipIf(!hasFixtures)('mmetacool fixtures', () => {
  const entriesOf = async (path: string): Promise<string[]> => {
    const handle = await openHdf5(path, await LocalFileSource.open(path), '/')
    try {
      const layout = detectLayout(handle)
      expect(layout.kind).toBe('mmetacool')
      // `Layout.entries` and `listEntryNames` are two routes to the same list;
      // the UI uses the first and the refusal message the second.
      expect(layout.entries).toEqual(listEntryNames(handle))
      return listEntryNames(handle)
    } finally {
      handle.close()
    }
  }

  it('classifies ladder.mmetacool as a resolution ladder', async () => {
    const entries = await entriesOf(LADDER)
    expect(entries).toEqual([...GOLDEN.ladder.entries])
    expect(allIntegers(entries)).toBe(true)
  })

  it('classifies samples.mmetacool as a sample collection', async () => {
    const entries = await entriesOf(SAMPLES)
    expect(entries).toEqual([...GOLDEN.samples.entries])
    expect(allIntegers(entries)).toBe(false)
  })

  it('refuses both at the root, listing the entries and the :: syntax', async () => {
    for (const path of [LADDER, SAMPLES]) {
      const error = await MetaCooler.open(path, await LocalFileSource.open(path)).then(
        (mc) => {
          mc.close()
          return null
        },
        (err: unknown) => err,
      )
      expect(error).toBeInstanceOf(ViewerError)
      const refusal = error as ViewerError
      expect(refusal.code).toBe('mmetacool-root')
      // Mirrors the Python `KeyError`, down to the sentence: "No metacool entry
      // at root of …. Metacool entries found: [...]. Use '::' …".
      expect(refusal.message).toContain('No metacool entry at root')
      expect(refusal.message).toContain("Use '::' to specify a group path")
      for (const entry of refusal.detail['entries'] as string[]) {
        expect(refusal.message).toContain(`/entries/${entry}`)
      }
      // The suggested URI has to parse back to the group it names, or the fix
      // in the message is not a fix.
      const suggested = `${path}::/entries/${(refusal.detail['entries'] as string[])[0]}`
      expect(parseUri(suggested).group).toBe(`/entries/${(refusal.detail['entries'] as string[])[0]}`)
    }
  })

  it("a ladder's entry names are its bin sizes, and the levels nest exactly", async () => {
    const opened: MetaCooler[] = []
    try {
      for (const entry of GOLDEN.ladder.entries) opened.push(await openEntry(LADDER, entry))

      opened.forEach((mc, i) => {
        expect(mc.layout.kind).toBe('metacool')
        // The claim that makes the inference sound: the name *is* the bin size,
        // so the entry list can drive a zoom control without opening anything.
        expect(mc.binsize).toBe(Number(GOLDEN.ladder.entries[i]))
        expect(mc.binsize).toBe(GOLDEN.ladder.binsizes[i])
        expect(mc.nnz).toBe(GOLDEN.ladder.nnz[i])
        expect(mc.info.sum).toBe(GOLDEN.ladder.sum)
      })

      // §3.3: `binnify` requires an exact multiple and `zoomify` requires every
      // level to be a multiple of the base, so `k = resolution / base` is an
      // integer at every rung and zoom arithmetic is integer division with no
      // interpolation. A ladder that failed this would need a resampling path
      // that this app deliberately does not have.
      const base = opened[0].binsize
      for (const mc of opened) {
        const k = mc.binsize / base
        expect(Number.isInteger(k)).toBe(true)
        expect(k).toBeGreaterThanOrEqual(1)
        // Coarsening merges bins, so each level is a strict refinement of the
        // next: nBins shrinks by the same factor, up to the short last bin of
        // every contig.
        expect(mc.nBins).toBeLessThanOrEqual(opened[0].nBins)
      }

      // Same genomes, same contigs, same file — only the grid changes. This is
      // what lets the zoom control switch level without resetting the view.
      const [fine, ...rest] = opened
      for (const mc of rest) {
        expect(mc.genomeNames).toEqual(fine.genomeNames)
        expect(mc.chromnames).toEqual(fine.chromnames)
        expect(mc.displayGenomes()).toEqual(fine.displayGenomes())
      }
    } finally {
      for (const mc of opened) mc.close()
    }
  })

  it("a collection's entries share a bin size and differ in content", async () => {
    const opened: MetaCooler[] = []
    try {
      for (const entry of GOLDEN.samples.entries) opened.push(await openEntry(SAMPLES, entry))

      opened.forEach((mc, i) => {
        expect(mc.layout.kind).toBe('metacool')
        expect(mc.binsize).toBe(GOLDEN.samples.binsizes[i])
        expect(mc.nnz).toBe(GOLDEN.samples.nnz[i])
      })

      // The mirror image of the ladder: identical grids, different data. There
      // is nothing here for a zoom control to do, which is exactly why this
      // case gets a picker instead.
      const [rep1, rep2] = opened
      expect(rep2.binsize).toBe(rep1.binsize)
      expect(rep2.nBins).toBe(rep1.nBins)
      expect(rep2.nnz).not.toBe(rep1.nnz)
    } finally {
      for (const mc of opened) mc.close()
    }
  })

  it('addresses an entry with the same URI syntax the CLI uses', async () => {
    const uri = `${LADDER}::entries/2000`
    expect(parseUri(uri)).toEqual({ path: LADDER, group: '/entries/2000' })
    const mc = await MetaCooler.open(uri, await LocalFileSource.open(LADDER))
    try {
      expect(mc.uri).toBe(uri)
      expect(mc.layout.group).toBe('/entries/2000')
      expect(mc.binsize).toBe(2000)
      // A handle rooted at an entry answers about *that* entry: `/chroms` here
      // is the entry's soft link, never the collection's absent one.
      expect(mc.handle.isSoftLink('chroms')).toBe(true)
    } finally {
      mc.close()
    }
  })
})
