/**
 * The multi-genome containers behind the dev features switch (§29.3).
 *
 * Switched off, a `.metacool` and an `.mmetacool` are refused as files this
 * viewer does not read — under the code any unknown HDF5 file gets, in words
 * true of each: a metagenome's contact map, a collection of them, and never
 * *not a cooler*, which a `.metacool` is; never the switch either — and a plain
 * cooler opens exactly as it always has, while any other HDF5 file keeps the
 * words that name neither container. Absent, which is the command line,
 * everything is read. Run over the repository's own demo files
 * (`demo/metagenomics/`, `demo/yeast/`), so no generated fixture is needed.
 */

import { describe, expect, it } from 'vitest'
import { ViewerError } from '../../src/errors'
import type { AttrValue, Hdf5Handle } from '../../src/h5/api'
import { detectLayout } from '../../src/metacooler/detect'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const DEMO = (path: string): string => new URL(`../../demo/${path}`, import.meta.url).pathname
const METACOOL = DEMO('metagenomics/mock-community/MM133.metacool')
const MMETACOOL = DEMO('metagenomics/mock-community/MM133.mmetacool')
const COOLER = DEMO('yeast/Yeast_microC_G2M_1kb.cool')

/**
 * A refusal's own words: without the file it names and the keys it lists,
 * which are the reader's file's facts (§10) rather than the viewer's claims.
 */
function ownWords(error: ViewerError, path: string): string {
  return error.message.replace(path, '<file>').replace(/Top-level keys: .*$/, '')
}

async function refusal(path: string, metacool: boolean | undefined): Promise<ViewerError> {
  const source = await LocalFileSource.open(path)
  let thrown: unknown = null
  try {
    const mc = await MetaCooler.open(path, source, metacool === undefined ? {} : { metacool })
    mc.close()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a refusal').toBeInstanceOf(ViewerError)
  return thrown as ViewerError
}

/** Nothing that says the page could read the file, or how (§29.1, §29.2). */
const SWITCH = /\bdev\b|switch|feature|turn (it )?on|enable/i

/**
 * An HDF5 file by its root alone — attributes and top-level names — which is
 * all {@link detectLayout} asks of one before it refuses it.
 */
function handle(attrs: Record<string, AttrValue>, keys: string[]): Hdf5Handle {
  return {
    uri: 'file.h5',
    group: '/',
    attrs: () => attrs,
    attrsAt: () => ({}),
    has: (path: string) => keys.includes(path),
    keys: (path: string) => (path === '' ? keys : []),
  } as unknown as Hdf5Handle
}

function refused(body: () => unknown): ViewerError {
  let thrown: unknown = null
  try {
    body()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a refusal').toBeInstanceOf(ViewerError)
  return thrown as ViewerError
}

describe('switched off', () => {
  it('refuses a .metacool as what it is, a metagenome’s contact map, and never as not a cooler', async () => {
    const error = await refusal(METACOOL, false)
    expect(error.code).toBe('not-a-cooler')
    // Told apart by the attribute it declares itself one with, which the view
    // heads it by (`ui/ErrorView.ts`) and the reader is shown as what it says.
    expect(error.detail).toMatchObject({ container: 'metacool', format: 'HDF5::Cooler', 'metacooler-format': 'HDF5::MetaCooler' })
    const words = ownWords(error, METACOOL)
    expect(words).toBe('<file> is a metagenome’s contact map — a cooler with a genome layer over its contigs — and this viewer does not open one.')
    // A .metacool is a cooler (§3.1): `cooler.Cooler()` opens it. The words any
    // unknown HDF5 file gets said otherwise, over a list of a cooler's keys —
    // and it is still refused, not opened as a cooler of its contigs.
    expect(error.message).not.toMatch(/not a cooler|not a contact map|Top-level keys/)
    expect(words).not.toMatch(SWITCH)
  })

  it('refuses an .mmetacool as a collection of them, rather than asking for an entry', async () => {
    const error = await refusal(MMETACOOL, false)
    expect(error.code).toBe('not-a-cooler')
    expect(error.detail).toMatchObject({ container: 'mmetacool', format: 'HDF5::MMetaCooler' })
    // No entries in the detail: the view would offer each as a button, and each
    // is a map this page does not open.
    expect(error.detail['entries']).toBeUndefined()
    const words = ownWords(error, MMETACOOL)
    expect(words).toMatch(/^<file> is a collection of metagenome contact maps/)
    expect(words).not.toMatch(/entry|entries|::/i)
    expect(words).not.toMatch(SWITCH)
  })

  it('keeps the words that name no container for any other HDF5 file', () => {
    const error = refused(() => detectLayout(handle({}, ['X', 'obs', 'var']), undefined, { metacool: false }))
    expect(error.code).toBe('not-a-cooler')
    expect(error.detail['container']).toBeUndefined()
    expect(error.message).toMatch(/is an HDF5 file, but not a contact map this viewer reads: it is not a cooler/)
    expect(ownWords(error, 'file.h5')).not.toMatch(/metacool|metagenome|genome|MAG/i)
  })

  it('tells a .metacool apart by its attribute, not its name or its groups', () => {
    // A metacool's root, under a name that says nothing — the attribute decides.
    const metacool = { format: 'HDF5::Cooler', 'metacooler-format': 'HDF5::MetaCooler' }
    const error = refused(() =>
      detectLayout(handle(metacool, ['bins', 'chroms', 'contigs', 'genomes', 'indexes', 'pixels']), undefined, { metacool: false }),
    )
    expect(error.detail['container']).toBe('metacool')
    // A plain cooler's root, under the same groups but no such attribute, is a cooler.
    expect(detectLayout(handle({ format: 'HDF5::Cooler' }, ['bins', 'chroms', 'indexes', 'pixels']), undefined, { metacool: false }).kind).toBe('cool')
  })

  it('opens a plain cooler exactly as before', async () => {
    const source = await LocalFileSource.open(COOLER)
    const mc = await MetaCooler.open(COOLER, source, { metacool: false })
    try {
      expect(mc.layout.kind).toBe('cool')
      expect(mc.genomes).toBeNull()
    } finally {
      mc.close()
    }
  })
})

describe('switched on, or on the command line', () => {
  it.each([true, undefined])('opens a .metacool with its genomes (metacool: %s)', async (metacool) => {
    const source = await LocalFileSource.open(METACOOL)
    const mc = await MetaCooler.open(METACOOL, source, metacool === undefined ? {} : { metacool })
    try {
      expect(mc.layout.kind).toBe('metacool')
      expect(mc.genomes).not.toBeNull()
    } finally {
      mc.close()
    }
  })

  it('asks for an entry of an .mmetacool, as it always has', async () => {
    const error = await refusal(MMETACOOL, true)
    expect(error.code).toBe('mmetacool-root')
  })
})
