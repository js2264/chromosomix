/**
 * What the worker answers a `curationState` request with (SPECS §33): the
 * method's state of a curated binning, in the shape the stage reads — every
 * genome's numbers, the contigs' places, the pairs, the host links and the
 * suggestions. Pure, so the stage's controller is tested on the very answer
 * the worker would post.
 */

import type { CuratedBinning } from '../genome/curation'
import type { CurationStateResult } from '../worker/curateProtocol'
import { bestQuality, type ContigMarkers } from './quality'
import { curationState, type CurationEvidence, type KindWeights } from './suggest'

/** The method's state of `binning`, as the stage reads it. */
export function stateAnswer(evidence: CurationEvidence, binning: CuratedBinning, weights: KindWeights = {}): CurationStateResult {
  const state = curationState(evidence, binning, weights)
  return {
    fingerprint: binning.fingerprint(),
    counted: true,
    genomes: binning.genomes.map((genome, g) => ({
      id: genome.id,
      name: genome.name,
      kind: genome.kind,
      asInFile: genome.asInFile,
      contigs: genome.contigs.length,
      length: genome.contigs.reduce((sum, c) => sum + evidence.lengths[c], 0),
      within: state.tally.within[g],
      visibility: state.tally.visibility[g],
      // A MAG's alone: an element is never graded, before the read or after.
      quality: genome.kind === 'mag' ? (state.quality[g] ?? null) : null,
    })),
    genomeOf: binning.genomeOf.slice(),
    links: binning.links.map((link) => ({ ...link })),
    pairs: state.pairs,
    hosts: state.hosts,
    contigs: state.contigs,
    suggestions: state.suggestions,
  }
}

/**
 * The answer before the contacts are read: the genomes, their quality from the
 * markers and the links — what the list, the cards and the scatter's colours
 * need — and nothing the contacts make: no pairs, hosts or suggestions, and no
 * contig placed.
 */
export function bareAnswer(binning: CuratedBinning, lengths: readonly number[], markers: readonly ContigMarkers[]): CurationStateResult {
  const n = binning.genomeOf.length
  return {
    fingerprint: binning.fingerprint(),
    counted: false,
    genomes: binning.genomes.map((genome) => ({
      id: genome.id,
      name: genome.name,
      kind: genome.kind,
      asInFile: genome.asInFile,
      contigs: genome.contigs.length,
      length: genome.contigs.reduce((sum, c) => sum + (lengths[c] ?? 0), 0),
      within: 0,
      visibility: 0,
      quality: genome.kind === 'mag' && markers.length > 0 ? bestQuality(markers, genome.contigs) : null,
    })),
    genomeOf: binning.genomeOf.slice(),
    links: binning.links.map((link) => ({ ...link })),
    pairs: { a: new Int32Array(0), b: new Int32Array(0), contacts: new Float64Array(0), affinity: new Float32Array(0) },
    hosts: [],
    contigs: { best: new Int32Array(n).fill(-1), bestAffinity: new Float32Array(n).fill(Number.NaN), ownAffinity: new Float32Array(n).fill(Number.NaN), hits: new Float64Array(n) },
    suggestions: [],
  }
}

