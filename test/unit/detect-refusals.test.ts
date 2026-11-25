// @dev-feature metacool
/**
 * What the acceptance gates tell a reader to do, by what the map is (§3.2, §10).
 *
 * Driven from root attributes alone, as the gates are: no fixture is opened, so
 * every kind of map a refusal has to tell apart is written out here — among
 * them the one `npm run fixtures` cannot build from metacooler's test data, a
 * metacool of one bin per contig, which is the map metaTOR writes from pairs or
 * BAM files. `metacooler binnify` only sums bins: told to make that map finer,
 * it puts every contact of a contig in one bin of it and leaves the rest empty,
 * a map this viewer would open and that misleads. The refusal said to run it.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError } from '@/errors'
import type { AttrValue, Hdf5Handle } from '@/h5/api'
import { assertAcceptable } from '@/metacooler/detect'
import type { Layout, LayoutKind } from '@/types'

/** What the gates threw for a map of `kind` whose root carries `attrs`. */
function refusal(
  kind: LayoutKind,
  attrs: Record<string, AttrValue>,
  options: { metacool?: boolean } = {},
): ViewerError {
  const layout = { kind, group: '/' } as Layout
  try {
    // The root attributes are handed in, so the handle is never asked anything.
    assertAcceptable({} as Hdf5Handle, layout, attrs, options)
  } catch (error) {
    if (error instanceof ViewerError) return error
    throw error
  }
  throw new Error('the gates accepted the map')
}

/** A metacool's root, as metacooler writes it, with what each case changes. */
const metacool = (changes: Record<string, AttrValue>): Record<string, AttrValue> => ({
  format: 'HDF5::Cooler',
  'metacooler-format': 'HDF5::MetaCooler',
  'metacooler-format-version': 1,
  'contig-ordering': 'genome-then-length',
  'storage-mode': 'symmetric-upper',
  'bin-type': 'fixed',
  'bin-size': 1000,
  nbins: 184984,
  nchroms: 20566,
  ...changes,
})

describe('a variable-bin map', () => {
  it('of one bin per contig is told to bin its pairs again, never to binnify', () => {
    const error = refusal('metacool', metacool({ 'bin-type': 'variable', 'bin-size': 'null', nbins: 2527, nchroms: 2527 }))
    expect(error.code).toBe('variable-bins')
    expect(error.message).toContain('one bin per contig (2,527 contigs, 2,527 bins)')
    expect(error.message).toContain('`metacooler binnify` cannot put them back along it')
    expect(error.message).toContain('`metacooler create pairs --bins <bp>`')
    expect(error.message).not.toContain('binnify --binsize')
    // The counts it was told by are what the reader is shown it said.
    expect(error.detail).toEqual({ 'bin-type': 'variable', 'bin-size': null, nbins: 2527, nchroms: 2527 })
  })

  it('of fragments is still told to binnify, which sums its fragments into bins', () => {
    const error = refusal('metacool', metacool({ 'bin-type': 'variable', 'bin-size': 'null', nbins: 48211, nchroms: 2527 }))
    expect(error.message).toContain('Fragment-level metacools are variable-bin by construction')
    expect(error.message).toContain('`metacooler binnify --binsize <bp>`')
    expect(error.detail).toEqual({ 'bin-type': 'variable', 'bin-size': null, nbins: 48211, nchroms: 2527 })
  })

  it.each([
    ['with the multi-genome format read', {}],
    ['with it switched off (§29)', { metacool: false }],
  ])('that is a cooler is told to bin its pairs with cooler, %s', (_how, options) => {
    // One bin per sequence, too: a cooler's fix is cooler's whatever its bins.
    const error = refusal('cool', { format: 'HDF5::Cooler', 'bin-type': 'variable', nbins: 16, nchroms: 16 }, options)
    expect(error.message).toContain('`cooler cload pairs`')
    expect(error.message).not.toMatch(/metacool|metaTOR|contig/i)
    expect(error.detail).toEqual({ 'bin-type': 'variable', 'bin-size': null })
  })
})

describe('a map whose contigs are not grouped by genome', () => {
  it.each(['custom', 'fasta', 'cool'])('%s is told to group them with reassign, from its own assignment', (ordering) => {
    const error = refusal('metacool', metacool({ 'contig-ordering': ordering }))
    expect(error.code).toBe('bad-ordering')
    expect(error.message).toContain(`contig-ordering is '${ordering}'`)
    expect(error.message).toContain(
      '`metacooler reassign --contigs <table> --contigs-format contig,genome --layout genome-then-length`',
    )
    expect(error.message).toContain('`metacooler dump <file> -t contigs -H`')
    // Re-creating it from its pairs is still the other way.
    expect(error.message).toContain('`metacooler create pairs --contig-order genome-then-length`')
  })
})
