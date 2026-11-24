// @dev-feature curate
/**
 * The curation's suggestions (SPECS §33.5) on a small community built so each
 * kind has one right answer: two fragments of one organism, an unbinned contig
 * that belongs to one, a contig binned in the wrong MAG, an element and its
 * host, a link the contacts do not support, and a stranger.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep } from '../../src/genome/curation'
import { curationState } from '../../src/curate/suggest'
import { community } from '../support/curateCommunity'

describe('the suggestions on a small community', () => {
  const { base, evidence } = community()
  const binning = CuratedBinning.of(base, null)
  const state = curationState(evidence, binning)
  const by = (kind: string): string[] => state.suggestions.filter((s) => s.kind === kind && s.confidence >= 0.5).map((s) => s.words)

  it('merge the two fragments of one organism, and nothing else', () => {
    expect(by('merge')).toEqual(['merge X2 into X1'])
    const merge = state.suggestions.find((s) => s.kind === 'merge')
    expect(merge?.evidence).toContain('markers complementary')
  })

  it('recruit the unbinned contig into its organism, and move the misplaced one home', () => {
    expect(by('recruit').length).toBe(1)
    expect(by('recruit')[0]).toMatch(/^recruit u0 into X[12]$/)
    expect(by('move')).toEqual(['move y5 from X1 to Y'])
  })

  it('link the element to its host, and drop the link the contacts do not support', () => {
    expect(by('link')).toEqual(['link P to Y'])
    expect(by('unlink')).toEqual(['unlink P from Z'])
  })

  it('give every MAG miComplete’s numbers from its markers', () => {
    const x1 = state.quality[binning.indexOfId('X1') ?? -1]
    expect(x1?.completeness).toBe(0.5)
    expect(state.quality[binning.indexOfId('Z') ?? -1]?.completeness).toBe(1)
  })

  it('are counted again on the binning a step makes: merged, the fragments are one, and complete', () => {
    const merged = CuratedBinning.of(base, withCurationStep(emptyCuration(fileBinning(base)), { op: 'merge', into: 'X1', genomes: ['X2'] }, 'reader', 0))
    const after = curationState(evidence, merged)
    expect(after.suggestions.some((s) => s.kind === 'merge' && s.confidence >= 0.5)).toBe(false)
    expect(after.quality[merged.indexOfId('X1') ?? -1]?.completeness).toBe(1)
  })
})

describe('before the contacts are read', () => {
  it('answers the genomes, their quality and the links, and nothing the contacts make', async () => {
    const { bareAnswer } = await import('../../src/curate/answer')
    const { base, evidence } = community()
    const bare = bareAnswer(CuratedBinning.of(base, null), base.lengths, evidence.markers)
    expect(bare.counted).toBe(false)
    expect(bare.genomes.map((genome) => genome.name)).toEqual(['X1', 'X2', 'Y', 'Z', 'P'])
    expect(bare.genomes[3].quality?.completeness).toBe(1)
    expect(bare.genomes[4].quality).toBeNull()
    expect(bare.links).toEqual([{ element: 'P', mag: 'Z', fromFile: true }])
    expect(bare.suggestions).toEqual([])
    expect(bare.contigs.best.length).toBe(base.names.length)
  })
})
