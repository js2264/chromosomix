/**
 * A genome's edit of the reference opened inside a curation (SPECS §27.10,
 * §33.4): the curated genome a name means, the genomes its stage names the
 * partners of its contigs by, and the curation steps its changes make.
 *
 * The curation holds every genome's contigs (§33.2). A genome's edit orders,
 * turns, joins and cuts them; where it takes a contig in — a bring, a stretch
 * put back — or lets one go whole — sent to another genome, set aside as
 * debris, a contaminant or a haplotig — the curation is told, as a move, so
 * the two never disagree about whose a contig is (`layouts.ts`).
 */

import { UNBINNED } from '../genome/curation'
import type { CurationStore } from '../state/curation'
import type { EditStore } from '../state/referenceEdit'
import { layoutMembership, mirroredMoves } from './layouts'

/** The curated genome a name means — a name, or an id itself — or `undefined`. */
export function curatedIdOf(curation: CurationStore, name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const binning = curation.binning
  const g = binning.indexOfName(name) ?? binning.indexOfId(name)
  return g === undefined ? undefined : binning.genomes[g].id
}

/**
 * Each of the file's contigs, its genome as the curation holds it now: the
 * curated genomes by name, the pool last as `__unbinned__` — what a genome's
 * stage names the partners of its contigs by.
 */
export function assignmentOf(curation: CurationStore): { genomes: string[]; genomeOf: Int32Array } {
  const binning = curation.binning
  const pool = binning.genomes.length
  return { genomes: [...binning.genomes.map((genome) => genome.name), UNBINNED], genomeOf: Int32Array.from(binning.genomeOf, (g) => (g < 0 ? pool : g)) }
}

/**
 * Make every change of a genome's edit that takes a contig in or lets one go a
 * step of the curation (`layouts.ts`, `mirroredMoves`): one gesture of moves,
 * undone in the curation as one. Undoing the edit's step moves them back, as a
 * change of its own.
 *
 * @returns What stops it.
 */
export function mirrorIntoCuration(edit: EditStore, curation: CurationStore, id: string): () => void {
  const contigIndex = new Map(curation.file.names.map((name, c) => [name, c]))
  let before = layoutMembership(edit.assembly)
  const stop = edit.subscribe(() => {
    const after = layoutMembership(edit.assembly)
    const origin = new Map((edit.edit.original.elsewhere ?? []).map((contig) => [contig.name, contig.genome]))
    const steps = mirroredMoves({ here: id, before, after, origin, binning: curation.binning, contigIndex })
    before = after
    if (steps.length > 0) curation.applyAll(steps.map((step) => ({ step })))
  })
  return () => {
    stop()
  }
}
