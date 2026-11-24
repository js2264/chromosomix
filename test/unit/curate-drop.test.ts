// @dev-feature curate
/**
 * What a drop makes on the curation stage (SPECS §33.3): on a genome *into
 * it*, on a section's head *a new one* or *of that kind*, on the pool *out* —
 * and a MAG on an element refused, with the reason.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { dropPlan } from '../../src/curate/drop'
import { community, NAMES } from '../support/curateCommunity'

const { base, evidence } = community()
const answer = stateAnswer(evidence, CuratedBinning.of(base, null))
const mint = (kind: 'mag' | 'element'): { id: string; name: string } => ({ id: 'curated:1', name: `curated_${kind}_1` })
const c = (name: string): number => NAMES.indexOf(name)
const plan = (dragged: Parameters<typeof dropPlan>[0], target: Parameters<typeof dropPlan>[1]): ReturnType<typeof dropPlan> => dropPlan(dragged, target, answer, NAMES, mint)

describe('a drop', () => {
  it('moves contigs into a genome, recruiting from the pool, and leaves those already there', () => {
    expect(plan({ kind: 'contigs', contigs: [c('y5')] }, { kind: 'genome', id: 'Y' })).toEqual({ steps: [{ op: 'move', contigs: ['y5'], to: 'Y' }], words: 'move y5 into Y' })
    expect(plan({ kind: 'contigs', contigs: [c('u0')] }, { kind: 'genome', id: 'X1' }).words).toBe('recruit u0 into X1')
    expect(plan({ kind: 'contigs', contigs: [c('x0'), c('y5')] }, { kind: 'genome', id: 'Y' })).toEqual({ steps: [{ op: 'move', contigs: ['x0', 'y5'], to: 'Y' }], words: 'move 2 contigs into Y' })
    expect(plan({ kind: 'contigs', contigs: [c('y0')] }, { kind: 'genome', id: 'Y' })).toEqual({ refused: 'Already in Y.' })
  })

  it('makes a new MAG or element of contigs dropped on a section, and unbins them on the pool', () => {
    expect(plan({ kind: 'contigs', contigs: [c('x0'), c('x1')] }, { kind: 'section', section: 'elements' })).toEqual({
      steps: [{ op: 'create', id: 'curated:1', name: 'curated_element_1', kind: 'element', contigs: ['x0', 'x1'] }],
      words: 'a new element of 2 contigs',
    })
    expect(plan({ kind: 'contigs', contigs: [c('x0'), c('u0')] }, { kind: 'pool' }).words).toBe('unbin x0')
    expect(plan({ kind: 'contigs', contigs: [c('u0')] }, { kind: 'pool' })).toEqual({ refused: 'Already unbinned.' })
  })

  it('merges genomes of one kind into the one dropped on, which keeps its name', () => {
    expect(plan({ kind: 'genomes', ids: ['X2'] }, { kind: 'genome', id: 'X1' })).toEqual({ steps: [{ op: 'merge', into: 'X1', genomes: ['X2'] }], words: 'merge X2 into X1' })
    expect(plan({ kind: 'genomes', ids: ['X1'] }, { kind: 'genome', id: 'X1' })).toEqual({ refused: 'That is X1 itself.' })
    expect(plan({ kind: 'genomes', ids: ['X1', 'P'] }, { kind: 'genome', id: 'Y' }).refused).toMatch(/one kind at a time/)
  })

  it('links an element dropped on a MAG, and refuses a MAG dropped on an element', () => {
    expect(plan({ kind: 'genomes', ids: ['P'] }, { kind: 'genome', id: 'Y' })).toEqual({ steps: [{ op: 'link', element: 'P', mag: 'Y' }], words: 'link P to Y' })
    expect(plan({ kind: 'genomes', ids: ['P'] }, { kind: 'genome', id: 'Z' })).toEqual({ refused: 'Already linked to Z.' })
    expect(plan({ kind: 'genomes', ids: ['Y'] }, { kind: 'genome', id: 'P' }).refused).toMatch(/drop the element on the MAG/)
  })

  it('makes genomes of a section’s kind, and dissolves them on the pool', () => {
    expect(plan({ kind: 'genomes', ids: ['Z'] }, { kind: 'section', section: 'elements' })).toEqual({ steps: [{ op: 'retype', genome: 'Z', kind: 'element' }], words: 'make Z an element' })
    expect(plan({ kind: 'genomes', ids: ['P'] }, { kind: 'section', section: 'elements' })).toEqual({ refused: 'Already elements.' })
    expect(plan({ kind: 'genomes', ids: ['Z', 'X2'] }, { kind: 'pool' })).toEqual({
      steps: [
        { op: 'dissolve', genome: 'Z' },
        { op: 'dissolve', genome: 'X2' },
      ],
      words: 'dissolve Z, X2: 7 contigs to the pool',
    })
  })
})
