// @dev-feature curate
/**
 * A step's price (SPECS §33.3): each genome it changes, its sources' quality
 * now and its own as it would be, and whether its grade falls or reaches high.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type CurationStep } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { priceLines, priceOf, priceVerdict } from '../../src/curate/price'
import { community } from '../support/curateCommunity'

const { base, evidence } = community()
const now = stateAnswer(evidence, CuratedBinning.of(base, null))
const after = (step: CurationStep): ReturnType<typeof stateAnswer> =>
  stateAnswer(evidence, CuratedBinning.of(base, withCurationStep(emptyCuration(fileBinning(base)), step, 'reader', 0)))

describe('a step’s price', () => {
  it('is the merged genome’s quality, from its parts', () => {
    const rows = priceOf(now, after({ op: 'merge', into: 'X1', genomes: ['X2'] }))
    expect(rows.map((row) => row.name)).toEqual(['X1'])
    expect(rows[0].from.map((f) => f.name)).toEqual(['X1', 'X2'])
    expect(priceLines(rows[0])).toEqual({ completeness: '50% + 50% → 100%', redundancy: '1.00 + 1.00 → 1.00' })
    expect(priceVerdict(rows[0])).toBe('promoted')
  })

  it('names both genomes a move changes', () => {
    const rows = priceOf(now, after({ op: 'move', contigs: ['y5'], to: 'Y' }))
    expect(rows.map((row) => row.name).sort()).toEqual(['X1', 'Y'])
  })

  it('is nothing for a link', () => {
    expect(priceOf(now, after({ op: 'link', element: 'P', mag: 'Y' }))).toEqual([])
  })
})
