/**
 * Where a view goes when the session is drawn through another binning (SPECS
 * §33.4): the stage closed on a curation, or the heading's arrow put the file's
 * binning back, and the file is opened again through it.
 *
 * A curation moves contigs between genomes and never renames a contig, so a
 * place on a contig keeps its contig; what moves is a view that names a
 * **genome**. A genome is followed by its id — a genome of the file by its
 * stored name, kept through renames; a created one by the id its step minted —
 * so a renamed genome is found under its new name; one merged away, or whose
 * contigs went on the whole to another genome, is found where they went; and
 * one that no longer holds a contig, dissolved or emptied into the pool, is not
 * found at all, and its view falls back to the genomes table, as a place an
 * edit set aside falls back to the table (§27.7).
 */

import type { ViewState } from '../types'
import type { CuratedBinning } from '../genome/curation'

/** What a genome of `before` is called in `after`; `null` where it is nowhere. */
export function followGenome(name: string, before: CuratedBinning, after: CuratedBinning): string | null {
  const from = before.indexOfName(name)
  if (from === undefined) return null
  const genome = before.genomes[from]
  const same = after.indexOfId(genome.id)
  if (same !== undefined) return after.genomes[same].name
  // Merged away, or its contigs gone elsewhere: where most of them are now,
  // and only where that is most of them.
  const counts = new Map<number, number>()
  for (const c of genome.contigs) {
    const to = after.genomeOf[c]
    if (to >= 0) counts.set(to, (counts.get(to) ?? 0) + 1)
  }
  let best = -1
  let most = 0
  for (const [to, count] of counts) {
    if (count > most) {
      best = to
      most = count
    }
  }
  return best >= 0 && most * 2 > genome.contigs.length ? after.genomes[best].name : null
}

/** The genome a contig is in after, by name; `null` in the pool or for a contig the file lacks. */
function genomeOfContig(contig: string, names: ReadonlyMap<string, number>, after: CuratedBinning): string | null {
  const c = names.get(contig)
  if (c === undefined) return null
  const g = after.genomeOf[c]
  return g >= 0 ? after.genomes[g].name : null
}

/** The genomes table, from wherever the view was. */
function genomesTable(state: ViewState): ViewState {
  return {
    ...state,
    view: 'genomes',
    genome: undefined,
    genome2: undefined,
    genomes: undefined,
    region: undefined,
    region2: undefined,
    regions: undefined,
    focus: undefined,
  }
}

/**
 * A view carried from one binning to another.
 *
 * @param contigs The file's contigs, in its order: the binnings' indices.
 */
export function carryGenomeView(state: ViewState, before: CuratedBinning, after: CuratedBinning, contigs: readonly string[]): ViewState {
  const follow = (name: string | undefined): string | null | undefined => (name === undefined ? undefined : followGenome(name, before, after))
  switch (state.view) {
    case 'genome': {
      const genome = follow(state.genome)
      return genome === null || genome === undefined ? genomesTable(state) : { ...state, genome }
    }
    case 'pair': {
      const genome = follow(state.genome)
      const genome2 = follow(state.genome2)
      if (genome === null || genome2 === null || genome === undefined || genome2 === undefined) return genomesTable(state)
      // Two genomes made one: the one they are now.
      return genome === genome2 ? { ...state, view: 'genome', genome, genome2: undefined } : { ...state, genome, genome2 }
    }
    case 'selection': {
      if (state.genomes !== undefined) {
        const kept = [...new Set(state.genomes.split(',').map((name) => followGenome(name.trim(), before, after)).filter((name): name is string => name !== null))]
        if (kept.length === 0) return genomesTable(state)
        return { ...state, genomes: kept.join(',') }
      }
      // Contigs ticked inside one genome hang off it: the genome they are in now.
      const genome = follow(state.genome)
      return genome === null ? { ...state, genome: undefined } : genome === undefined ? state : { ...state, genome }
    }
    case 'region': {
      if (state.genome === undefined || state.region === undefined) return state
      // A contig keeps its name; the genome it was opened from is the one it is in now.
      const names = new Map(contigs.map((name, c) => [name, c]))
      const genome = genomeOfContig(state.region.split(':')[0], names, after)
      return genome === null ? { ...state, genome: undefined } : { ...state, genome }
    }
    default: {
      // A table scoped to one genome, or any other view that names one.
      if (state.genome === undefined) return state
      const genome = follow(state.genome)
      return genome === null || genome === undefined ? { ...state, genome: undefined } : { ...state, genome }
    }
  }
}

/**
 * A view carried to a map whose genomes are laid out otherwise (§27.10): a
 * place named on a sequence the next map does not draw — a contig since made
 * a stretch of a laid-out sequence, a sequence of a layout since changed — is
 * given up for its genome's map, or for the genomes table where it named no
 * genome.
 *
 * @param draws Whether the next map draws a sequence of this name.
 */
export function carryLaidOutView(state: ViewState, draws: (name: string) => boolean): ViewState {
  const named = [state.region, state.region2, state.focus].flatMap((place) => (place === undefined ? [] : [place.split(':')[0]]))
  const ticked = (state.regions ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
  if ([...named, ...ticked].every(draws)) return state
  if (state.genome === undefined) return genomesTable(state)
  return { ...state, view: 'genome', genome2: undefined, genomes: undefined, region: undefined, region2: undefined, regions: undefined, focus: undefined }
}
