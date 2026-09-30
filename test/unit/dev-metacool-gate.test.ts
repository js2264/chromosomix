/**
 * The multi-genome containers behind the dev features switch (§29.3).
 *
 * Switched off, a `.metacool` and an `.mmetacool` are refused as files this
 * viewer does not read — in the sentence any unknown HDF5 file gets, naming
 * neither — and a plain cooler opens exactly as it always has. Absent, which is
 * the command line, everything is read. Run over the demo files the landing
 * page itself offers, so no generated fixture is needed.
 */

import { describe, expect, it } from 'vitest'
import { ViewerError } from '../../src/errors'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const DEMO = (path: string): string => new URL(`../../demo/${path}`, import.meta.url).pathname
const METACOOL = DEMO('metagenomics/mock-community/Mock_microbial_community.metacool')
const MMETACOOL = DEMO('metagenomics/mock-community/Mock_microbial_community.mmetacool')
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

describe('switched off', () => {
  it('refuses a .metacool as an unknown file, naming no container it cannot open', async () => {
    const error = await refusal(METACOOL, false)
    expect(error.code).toBe('not-a-cooler')
    expect(ownWords(error, METACOOL)).not.toMatch(/metacool|genome|MAG/i)
    // A .metacool also passes the cooler test (§3.1): refused, not opened as
    // a cooler of its contigs.
    expect(error.message).toMatch(/not a contact map this viewer reads/)
  })

  it('refuses an .mmetacool the same way, rather than asking for an entry', async () => {
    const error = await refusal(MMETACOOL, false)
    expect(error.code).toBe('not-a-cooler')
    expect(ownWords(error, MMETACOOL)).not.toMatch(/metacool|entry|genome/i)
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
