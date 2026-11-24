/**
 * What a curation changed, genome by genome and contig by contig (SPECS §33.3):
 * the chips the list, the maps and the cards wear — `+30`, `−2`, `new`,
 * `renamed`, `was an element` — and where a moved contig came from. Pure:
 * the answer as it stands against the file's binning.
 */

import type { BaseBinning, GenomeKind } from '../genome/curation'
import type { CurationStateResult } from '../worker/curateProtocol'

/** One genome's change since the file. */
export interface GenomeChange {
  /** A genome a step created: in no file. */
  created: boolean
  /** Contigs it holds now that its file genome did not, and its file genome's it no longer holds. */
  gained: number
  lost: number
  /** Its name in the file, where a step renamed it. */
  renamedFrom: string | null
  /** Its kind in the file, where a step retyped it. */
  retypedFrom: GenomeKind | null
  /** File genomes merged into it, by name. */
  absorbed: string[]
}

/** Every genome's change, by index of the answer's genomes, and each contig's file genome. */
export interface CurationChanges {
  genomes: GenomeChange[]
  /** Each contig's genome in the file, by name; `null` for the pool. */
  fileGenomeOf: Array<string | null>
  /** Contigs whose genome is not the file's. */
  moved: number
}

/** What the curation changed, against the file. */
export function curationChanges(answer: CurationStateResult, file: BaseBinning): CurationChanges {
  const fileIndex = new Map(file.genomes.map((genome, g) => [genome.name, g]))
  const fileGenomeOf = Array.from(file.genomeOf, (g) => (g < 0 ? null : file.genomes[g].name))
  const genomes: GenomeChange[] = answer.genomes.map((genome) => {
    const f = fileIndex.get(genome.id)
    return {
      created: f === undefined,
      gained: 0,
      lost: 0,
      renamedFrom: f !== undefined && file.genomes[f].name !== genome.name ? file.genomes[f].name : null,
      retypedFrom: f !== undefined && file.genomes[f].kind !== genome.kind ? file.genomes[f].kind : null,
      absorbed: [],
    }
  })
  const byId = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
  // Of each file genome that is gone, how many of its contigs each genome holds now.
  const goneHeld = genomes.map(() => new Map<string, number>())
  const fileSize = new Map<string, number>()
  for (const name of fileGenomeOf) if (name !== null) fileSize.set(name, (fileSize.get(name) ?? 0) + 1)
  let moved = 0
  answer.genomeOf.forEach((g, c) => {
    const was = fileGenomeOf[c]
    const now = g < 0 ? null : answer.genomes[g].id
    if (was === now) return
    moved++
    if (g >= 0) {
      genomes[g].gained++
      if (was !== null && !byId.has(was)) goneHeld[g].set(was, (goneHeld[g].get(was) ?? 0) + 1)
    }
    if (was !== null) {
      const from = byId.get(was)
      if (from !== undefined) genomes[from].lost++
    }
  })
  // A genome that is gone was merged into the one holding most of it — more
  // than half its contigs: one contig of a dissolved genome recruited, or
  // moved out before a merge, says nothing of a merge.
  goneHeld.forEach((held, g) => {
    genomes[g].absorbed = [...held].filter(([name, n]) => 2 * n > (fileSize.get(name) ?? 0)).map(([name]) => name).sort()
  })
  return { genomes, fileGenomeOf, moved }
}

/** A genome's change as the chip it wears, or `null` for one as in the file. */
export function changeChip(change: GenomeChange): string | null {
  if (change.created) return 'new'
  const parts: string[] = []
  if (change.gained > 0) parts.push(`+${change.gained.toLocaleString('en-US')}`)
  if (change.lost > 0) parts.push(`−${change.lost.toLocaleString('en-US')}`)
  if (change.retypedFrom !== null) parts.push(change.retypedFrom === 'element' ? 'was an element' : 'was a MAG')
  if (change.renamedFrom !== null) parts.push('renamed')
  return parts.length === 0 ? null : parts.join(' ')
}

/** A count and its noun, one or many: `1 contig`, `30 contigs`. */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** A genome's change in a sentence, for the chip's title. */
export function changeWords(change: GenomeChange): string {
  if (change.created) return `Made by the curation: ${counted(change.gained, 'contig')}.`
  const parts: string[] = []
  if (change.absorbed.length > 0) parts.push(`merged with ${change.absorbed.join(', ')}`)
  if (change.gained > 0 || change.lost > 0) parts.push(`${counted(change.gained, 'contig')} in, ${change.lost.toLocaleString('en-US')} out`)
  if (change.renamedFrom !== null) parts.push(`${change.renamedFrom} in the file`)
  if (change.retypedFrom !== null) parts.push(`${change.retypedFrom === 'element' ? 'an element' : 'a MAG'} in the file`)
  if (parts.length === 0) return 'As in the file.'
  const sentence = parts.join('; ')
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`
}
