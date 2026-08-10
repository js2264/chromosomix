/**
 * The Sequences card and the view state are one decision read two ways.
 *
 * Beside a contact map the tick boxes are the picture: none ticked is the whole
 * genome, one is that chromosome's block, several are those chromosomes against
 * each other. The card must therefore never hold an answer of its own — the
 * breadcrumb, the Chromosomes table, the back button and a pasted link all move
 * the picture without touching a box — so the pair of functions below is the
 * whole of the binding and the round trip through them has to be the identity.
 *
 * A failure here is quiet and horrible: a card reading "showing 1 of 16" over a
 * whole-genome map, or a tick that navigates somewhere and then un-ticks itself
 * when the navigation reports back.
 */

import { describe, expect, it } from 'vitest'

import { sequencesShown, viewForSequences } from '@/state/ViewState'
import type { ViewState } from '@/types'

const URI = 'yeast.cool'
const NAMES = ['I', 'II', 'III', 'IV']

describe('which sequences a view draws', () => {
  it('reads a whole-genome map as all of them, which is none ticked', () => {
    expect(sequencesShown({ uri: URI, view: 'whole' }, NAMES)).toEqual([])
    expect(sequencesShown({ uri: URI, view: 'overview' }, NAMES)).toEqual([])
  })

  it('reads a region as its one sequence, coordinates and all', () => {
    expect(sequencesShown({ uri: URI, view: 'region', region: 'II' }, NAMES)).toEqual(['II'])
    expect(sequencesShown({ uri: URI, view: 'region', region: 'II:1000-2000' }, NAMES)).toEqual([
      'II',
    ])
  })

  // A contig may legally be called `NODE_1:2`, so the whole string is tried
  // against the file's own names before anything is read as a suffix.
  it('does not mistake a colon in a name for coordinates', () => {
    expect(sequencesShown({ uri: URI, view: 'region', region: 'NODE_1:2' }, ['NODE_1:2'])).toEqual([
      'NODE_1:2',
    ])
  })

  it('reads a two-axis block as both of its sequences, once each', () => {
    const pair: ViewState = { uri: URI, view: 'region', region: 'I', region2: 'IV' }
    expect(sequencesShown(pair, NAMES)).toEqual(['I', 'IV'])
    const same: ViewState = { uri: URI, view: 'region', region: 'I:0-100', region2: 'I' }
    expect(sequencesShown(same, NAMES)).toEqual(['I'])
  })

  it('reads a selection as the sequences it names', () => {
    expect(sequencesShown({ uri: URI, view: 'selection', regions: 'I,III' }, NAMES)).toEqual([
      'I',
      'III',
    ])
  })

  /**
   * `null` is not "no sequences" — that is `[]` — it is *do not ask*. A table
   * view draws no map, so there is nothing for the ticks to disagree with, and
   * clearing them there would throw away a selection a reader is halfway
   * through making on the way to the map.
   */
  it('declines to answer for a view that is not a picture of sequences', () => {
    expect(sequencesShown({ uri: URI, view: 'contigs' }, NAMES)).toBeNull()
    expect(sequencesShown({ uri: URI, view: 'genomes' }, NAMES)).toBeNull()
    expect(sequencesShown({ uri: URI, view: 'browser' }, NAMES)).toBeNull()
    // A metagenome's selection of *genomes* is not a selection of sequences.
    expect(sequencesShown({ uri: URI, view: 'selection', genomes: 'MAG_1,MAG_2' }, NAMES)).toBeNull()
  })
})

describe('the view a set of ticks asks for', () => {
  it('is the whole-file map when nothing is ticked', () => {
    expect(viewForSequences(URI, [], 'whole')).toEqual({ uri: URI, view: 'whole' })
    // A metagenome's whole-file view is the scan, not the single read (§7.3).
    expect(viewForSequences(URI, [], 'overview')).toEqual({ uri: URI, view: 'overview' })
  })

  it('is that sequence’s block when one is', () => {
    expect(viewForSequences(URI, ['II'], 'whole')).toEqual({
      uri: URI,
      view: 'region',
      region: 'II',
    })
  })

  it('is the selection view when several are', () => {
    expect(viewForSequences(URI, ['I', 'III'], 'whole')).toEqual({
      uri: URI,
      view: 'selection',
      regions: 'I,III',
    })
  })
})

/**
 * The property the binding rests on. Every navigation re-ticks the card from
 * the state it landed on; if that write differed from what was ticked, the card
 * would answer it with another navigation, and the pair would oscillate.
 */
describe('the round trip', () => {
  it('leaves every set of ticks exactly as it found them', () => {
    for (const ticked of [[], ['I'], ['I', 'II'], ['I', 'II', 'III', 'IV']]) {
      expect(sequencesShown(viewForSequences(URI, ticked, 'whole'), NAMES)).toEqual(ticked)
    }
  })
})
