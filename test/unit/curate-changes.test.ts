// @dev-feature curate
/**
 * What a curation changed, genome by genome (SPECS §33.3): the chips the stage
 * wears and their sentences.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type CurationStep } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { changeChip, changeWords, curationChanges } from '../../src/curate/changes'
import { community } from '../support/curateCommunity'

const { base, evidence } = community()

function after(...steps: CurationStep[]): ReturnType<typeof curationChanges> & { names: string[] } {
  let curation = emptyCuration(fileBinning(base))
  for (const step of steps) curation = withCurationStep(curation, step, 'reader', 0)
  const answer = stateAnswer(evidence, CuratedBinning.of(base, curation))
  return { ...curationChanges(answer, base), names: answer.genomes.map((genome) => genome.name) }
}

describe('what a curation changed', () => {
  it('is nothing for the file as it is', () => {
    const changes = after()
    expect(changes.moved).toBe(0)
    expect(changes.genomes.map(changeChip)).toEqual([null, null, null, null, null])
    expect(changeWords(changes.genomes[0])).toBe('As in the file.')
  })

  it('counts a merge’s contigs in, names the genome merged, and the move of one contig both ways', () => {
    const changes = after({ op: 'merge', into: 'X1', genomes: ['X2'] }, { op: 'move', contigs: ['y5'], to: 'Y' })
    const x1 = changes.names.indexOf('X1')
    const y = changes.names.indexOf('Y')
    expect(changeChip(changes.genomes[x1])).toBe('+3 −1')
    expect(changeWords(changes.genomes[x1])).toBe('Merged with X2; 3 contigs in, 1 out.')
    expect(changeChip(changes.genomes[y])).toBe('+1')
    expect(changes.moved).toBe(4)
    expect(changes.fileGenomeOf[3]).toBe('X1')
  })

  it('says new, renamed and retyped', () => {
    const changes = after(
      { op: 'create', id: 'curated:1', name: 'fresh', kind: 'mag', contigs: ['u0'] },
      { op: 'rename', genome: 'Z', name: 'Zeta' },
      { op: 'retype', genome: 'P', kind: 'mag' },
    )
    expect(changeChip(changes.genomes[changes.names.indexOf('fresh')])).toBe('new')
    expect(changeChip(changes.genomes[changes.names.indexOf('Zeta')])).toBe('renamed')
    expect(changeWords(changes.genomes[changes.names.indexOf('Zeta')])).toBe('Z in the file.')
    expect(changeChip(changes.genomes[changes.names.indexOf('P')])).toBe('was an element')
  })
})
