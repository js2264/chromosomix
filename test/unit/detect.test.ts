/**
 * Layout detection and the acceptance gates (spec §3.1, §3.2, §10).
 *
 * Driven off `test/golden/_manifest.json`: every fixture the golden exporter
 * produced is classified here, and every fixture it marked `refuse:<code>` must
 * be refused with *that* code and with the file's own value in `detail` — the
 * §10 rule that a refusal names the actual state rather than a generic "bad
 * file". Adding a fixture to the manifest therefore adds a case here for free.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError } from '../../src/errors'
import {
  assertAcceptable,
  detectLayout,
  listEntryNames,
  resolveStorageMode,
} from '../../src/metacooler/detect'
import { loadGolden, manifest, openHandle, refusalCode, withHandle } from './_golden'

/** Run `body` and return whatever it threw, asserting that it threw at all. */
function capture(body: () => unknown): ViewerError {
  let thrown: unknown
  try {
    body()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a refusal, got none').toBeInstanceOf(ViewerError)
  return thrown as ViewerError
}

describe('detectLayout classifies every fixture as the manifest says', () => {
  it.each(manifest.fixtures.map((f) => [f.name, f.kind] as const))(
    '%s → %s',
    async (name, kind) => {
      await withHandle(name, (h) => {
        expect(detectLayout(h).kind).toBe(kind)
      })
    },
  )
})

describe('detection order: a metacool is never a plain cool (§3.1)', () => {
  // The metacool format writes `format = "HDF5::Cooler"` and soft-links
  // /chroms → /contigs *on purpose*, so that `cooler.Cooler()` can open it.
  // That means it satisfies the cooler test too, and the only thing keeping it
  // out of the cool branch is the order the branches are written in.
  it.each(['basic.metacool', 'metadata.metacool', 'dropped.metacool', 'int64.metacool'])(
    '%s satisfies the cooler signature and is still detected as a metacool',
    async (name) => {
      await withHandle(name, (h) => {
        const attrs = h.attrs()
        // The premise: this file *would* match the `format === COOLER_FORMAT`
        // branch if it were reached.
        expect(attrs['format']).toBe('HDF5::Cooler')
        expect(h.has('chroms')).toBe(true)
        expect(h.isSoftLink('chroms')).toBe(true)
        expect(attrs['metacooler-format']).toBe('HDF5::MetaCooler')

        const layout = detectLayout(h)
        expect(layout.kind).toBe('metacool')
        expect(layout.kind).not.toBe('cool')
        // No entries: a metacool is a single map, not a collection.
        expect(layout.entries).toBeUndefined()
      })
    },
  )

  it('a plain cooler has no metacooler-format and is detected as cool', async () => {
    await withHandle('plain.cool', (h) => {
      const attrs = h.attrs()
      expect(attrs['format']).toBe('HDF5::Cooler')
      expect(attrs['metacooler-format']).toBeUndefined()
      expect(h.has('genomes')).toBe(false)
      expect(detectLayout(h).kind).toBe('cool')
    })
  })

  it('an mcool root lists its resolutions', async () => {
    const golden = loadGolden('plain_mcool.json')
    await withHandle('plain.mcool', (h) => {
      const layout = detectLayout(h)
      expect(layout.kind).toBe('mcool')
      expect(layout.entries).toEqual(golden.entries)
    })
  })
})

describe('accepted fixtures pass every §3.2 gate', () => {
  const accepted = manifest.fixtures.filter(
    (f) => refusalCode(f) === null && f.kind === 'metacool',
  )
  it.each(accepted.map((f) => f.name))('%s', async (name) => {
    await withHandle(name, (h) => {
      const layout = detectLayout(h)
      expect(() => assertAcceptable(h, layout)).not.toThrow()
      expect(resolveStorageMode(h.attrs())).toBe('symmetric-upper')
    })
  })

  it.each(loadGolden('ladder_mmetacool.json').entry_uris as string[])(
    '%s (an mmetacool entry is an ordinary metacool)',
    async (uri) => {
      await withHandle('ladder.mmetacool', (h) => {
        const layout = detectLayout(h)
        expect(layout.kind).toBe('metacool')
        expect(() => assertAcceptable(h, layout)).not.toThrow()
      }, uri)
    },
  )

  it.each(loadGolden('plain_mcool.json').entry_uris as string[])(
    '%s (an mcool resolution is an ordinary cooler)',
    async (uri) => {
      await withHandle('plain.mcool', (h) => {
        const layout = detectLayout(h)
        expect(layout.kind).toBe('cool')
        // A cool carries neither contig-ordering nor a metacooler version, so
        // it is gated on bin geometry alone (§9).
        expect(() => assertAcceptable(h, layout)).not.toThrow()
      }, uri)
    },
  )
})

describe('refused fixtures name their own value (§10)', () => {
  it('fasta_order.metacool → bad-ordering, carrying the file’s ordering', async () => {
    const golden = loadGolden('fasta_order_metacool.json')
    const found = golden.trigger['contig-ordering'].value as string
    expect(found).toBe('fasta')
    await withHandle('fasta_order.metacool', (h) => {
      const error = capture(() => assertAcceptable(h, detectLayout(h)))
      expect(error.code).toBe('bad-ordering')
      expect(error.detail).toEqual({ found, expected: 'genome-then-length' })
      // The message states what the file is, then the fix.
      expect(error.message).toContain("contig-ordering is 'fasta'")
      expect(error.message).toContain("requires 'genome-then-length'")
    })
  })

  it("variable.metacool → variable-bins, with bin-size 'null' read as absent", async () => {
    const golden = loadGolden('variable_metacool.json')
    expect(golden.trigger['bin-type'].value).toBe('variable')
    // The golden records the raw attribute: the *string* "null", not a
    // missing key. That string is the whole reason `intAttr` exists.
    expect(golden.trigger['bin-size'].value).toBe('null')
    expect(golden.trigger['bin-size'].python_type).toBe('str')

    await withHandle('variable.metacool', (h) => {
      expect(h.attrs()['bin-size']).toBe('null')
      const error = capture(() => assertAcceptable(h, detectLayout(h)))
      expect(error.code).toBe('variable-bins')
      expect(error.detail).toEqual({ 'bin-type': 'variable', 'bin-size': null })
      expect(error.message).toContain("bin-type is 'variable'")
      expect(error.message).toContain('bin-size is None')
    })
  })

  it.each(['ladder.mmetacool', 'samples.mmetacool'])(
    '%s → mmetacool-root, listing the entries as working URIs',
    async (name) => {
      const golden = loadGolden(
        manifest.fixtures.find((f) => f.name === name)!.golden,
      )
      await withHandle(name, (h) => {
        const layout = detectLayout(h)
        expect(layout.kind).toBe('mmetacool')
        expect(layout.entries).toEqual(golden.entries)
        expect(listEntryNames(h)).toEqual(golden.entries)

        const error = capture(() => assertAcceptable(h, layout))
        expect(error.code).toBe('mmetacool-root')
        expect(error.detail.entries).toEqual(golden.entries)
        // Byte-for-byte the Python KeyError, which the golden stored with the
        // repr quotes KeyError adds. The handle was opened with the bare file
        // name as its URI precisely so this can be compared literally.
        const pythonMessage = JSON.parse(golden.root_open.error_message as string) as string
        expect(golden.root_open.error_type).toBe('KeyError')
        expect(error.message).toBe(pythonMessage)
      })
    },
  )

  it('every manifest refusal code is actually produced', async () => {
    // A manifest-driven sweep, so a fixture added with a new `refuse:` code
    // fails here rather than being silently untested.
    for (const fixture of manifest.fixtures) {
      const code = refusalCode(fixture)
      if (code === null) continue
      const h = await openHandle(fixture.name)
      try {
        const error = capture(() => assertAcceptable(h, detectLayout(h)))
        expect(error.code, `${fixture.name} should refuse with ${code}`).toBe(code)
      } finally {
        h.close()
      }
    }
  })
})

describe('a group that is not there', () => {
  it('refuses a bogus entry and lists the real ones', async () => {
    const error = await (async () => {
      try {
        const h = await openHandle('ladder.mmetacool', 'ladder.mmetacool::entries/9999')
        h.close()
        throw new Error('expected a refusal')
      } catch (thrown) {
        return thrown as ViewerError
      }
    })()
    expect(error).toBeInstanceOf(ViewerError)
    expect(error.code).toBe('entry-not-found')
    expect(error.message).toContain('/entries/9999')
  })
})

describe('storage-mode is read, never assumed (§3.2)', () => {
  it('accepts the two known modes and refuses anything else', () => {
    expect(resolveStorageMode({ 'storage-mode': 'symmetric-upper' })).toBe('symmetric-upper')
    expect(resolveStorageMode({ 'storage-mode': 'square' })).toBe('square')
    // Absent means a writer that predates the attribute, and every such writer
    // stored the upper triangle.
    expect(resolveStorageMode({})).toBe('symmetric-upper')
    const error = capture(() => resolveStorageMode({ 'storage-mode': 'lower' }))
    expect(error.message).toBe(
      "attrs['storage-mode'] must be one of ['square', 'symmetric-upper'], got 'lower'",
    )
  })
})
