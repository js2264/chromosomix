/**
 * What the worker answers a `curationState` request with (SPECS §33): the
 * method's state of a curated binning, in the shape the stage reads — every
 * genome's numbers, the contigs' places, the pairs, the host links and the
 * suggestions. Pure, so the stage's controller is tested on the very answer
 * the worker would post.
 */

import type { CuratedBinning } from '../genome/curation'
import type { CurationStateResult } from '../worker/curateProtocol'
import { curationState, type CurationEvidence, type KindWeights } from './suggest'

/** The method's state of `binning`, as the stage reads it. */
export function stateAnswer(evidence: CurationEvidence, binning: CuratedBinning, weights: KindWeights = {}): CurationStateResult {
  const state = curationState(evidence, binning, weights)
  return {
    fingerprint: binning.fingerprint(),
    genomes: binning.genomes.map((genome, g) => ({
      id: genome.id,
      name: genome.name,
      kind: genome.kind,
      asInFile: genome.asInFile,
      contigs: genome.contigs.length,
      length: genome.contigs.reduce((sum, c) => sum + evidence.lengths[c], 0),
      within: state.tally.within[g],
      visibility: state.tally.visibility[g],
      quality: state.quality[g] ?? null,
    })),
    genomeOf: binning.genomeOf.slice(),
    links: binning.links.map((link) => ({ ...link })),
    pairs: state.pairs,
    hosts: state.hosts,
    contigs: state.contigs,
    suggestions: state.suggestions,
  }
}
