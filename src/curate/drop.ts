/**
 * What a drop makes on the curation stage (SPECS §33.3): one grammar for the
 * list, the maps and the scatter. Dropped on a genome means *into it*, on a
 * section's head *a new one* (or *of that kind*), on the pool *out*:
 *
 * | Dragged  | on a genome                                        | on a section head          | on the pool  |
 * |----------|----------------------------------------------------|----------------------------|--------------|
 * | contigs  | move them into it                                  | a new MAG or element of them | unbin them |
 * | genomes  | merge them into it (one kind); an element on a MAG links them | make them that kind | dissolve them |
 *
 * A MAG dropped on an element is refused, and says why. Pure: the steps and
 * their words, from the answer as it stands.
 */

import type { CurationStep, GenomeKind } from '../genome/curation'
import type { CurationStateResult } from '../worker/curateProtocol'
import type { CurateDragged, CurateDropTarget } from './ui/context'

/** A drop's steps and their words, or why it makes nothing. */
export type DropPlan = { steps: CurationStep[]; words: string; refused?: undefined } | { refused: string; steps?: undefined; words?: undefined }

/** Contigs as words: a name for one, a count for more. */
function contigWords(contigs: readonly number[], names: readonly string[]): string {
  return contigs.length === 1 ? (names[contigs[0]] ?? 'a contig') : `${contigs.length.toLocaleString('en-US')} contigs`
}

/** Genomes as words: up to three names, else a count. */
function genomeWords(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ')
  return `${names.length.toLocaleString('en-US')} genomes`
}

/**
 * What dropping `dragged` on `target` makes.
 *
 * @param mint A fresh id for a genome a drop creates, and its name.
 */
export function dropPlan(
  dragged: CurateDragged,
  target: CurateDropTarget,
  answer: CurationStateResult,
  names: readonly string[],
  mint: (kind: GenomeKind) => { id: string; name: string },
): DropPlan {
  const byId = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
  const genomeOf = (id: string): CurationStateResult['genomes'][number] | undefined => {
    const g = byId.get(id)
    return g === undefined ? undefined : answer.genomes[g]
  }
  if (dragged.kind === 'contigs') {
    const contigs = [...new Set(dragged.contigs)]
    if (contigs.length === 0) return { refused: 'Nothing is dragged.' }
    const contigNames = contigs.map((c) => names[c]).filter((name): name is string => name !== undefined)
    switch (target.kind) {
      case 'genome': {
        const genome = genomeOf(target.id)
        const g = byId.get(target.id)
        if (genome === undefined || g === undefined) return { refused: 'That genome is gone.' }
        const moving = contigs.filter((c) => answer.genomeOf[c] !== g)
        if (moving.length === 0) return { refused: `Already in ${genome.name}.` }
        const fromPool = moving.every((c) => answer.genomeOf[c] < 0)
        return {
          steps: [{ op: 'move', contigs: moving.map((c) => names[c]), to: target.id }],
          words: `${fromPool ? 'recruit' : 'move'} ${contigWords(moving, names)} into ${genome.name}`,
        }
      }
      case 'section': {
        const kind: GenomeKind = target.section === 'mags' ? 'mag' : 'element'
        const { id, name } = mint(kind)
        return {
          steps: [{ op: 'create', id, name, kind, contigs: contigNames }],
          words: `a new ${kind === 'mag' ? 'MAG' : 'element'} of ${contigWords(contigs, names)}`,
        }
      }
      case 'pool': {
        const binned = contigs.filter((c) => answer.genomeOf[c] >= 0)
        if (binned.length === 0) return { refused: 'Already unbinned.' }
        return { steps: [{ op: 'move', contigs: binned.map((c) => names[c]), to: null }], words: `unbin ${contigWords(binned, names)}` }
      }
    }
  }
  // Genomes.
  const ids = [...new Set(dragged.ids)].filter((id) => genomeOf(id) !== undefined)
  if (ids.length === 0) return { refused: 'Nothing is dragged.' }
  const dragGenomes = ids.map((id) => genomeOf(id) as CurationStateResult['genomes'][number])
  const kinds = new Set(dragGenomes.map((genome) => genome.kind))
  switch (target.kind) {
    case 'genome': {
      const into = genomeOf(target.id)
      if (into === undefined) return { refused: 'That genome is gone.' }
      const others = ids.filter((id) => id !== target.id)
      if (others.length === 0) return { refused: `That is ${into.name} itself.` }
      if (kinds.size > 1) return { refused: 'Drag MAGs or elements, one kind at a time.' }
      const kind = dragGenomes[0].kind
      if (kind === 'element' && into.kind === 'mag') {
        const linked = new Set(answer.links.filter((link) => link.mag === target.id).map((link) => link.element))
        const fresh = others.filter((id) => !linked.has(id))
        if (fresh.length === 0) return { refused: `Already linked to ${into.name}.` }
        return {
          steps: fresh.map((element) => ({ op: 'link', element, mag: target.id }) as CurationStep),
          words: `link ${genomeWords(fresh.map((id) => genomeOf(id)?.name ?? id))} to ${into.name}`,
        }
      }
      if (kind === 'mag' && into.kind === 'element') return { refused: 'A MAG and an element are not merged: drop the element on the MAG to link them.' }
      return {
        steps: [{ op: 'merge', into: target.id, genomes: others }],
        words: `merge ${genomeWords(others.map((id) => genomeOf(id)?.name ?? id))} into ${into.name}`,
      }
    }
    case 'section': {
      const kind: GenomeKind = target.section === 'mags' ? 'mag' : 'element'
      const changing = ids.filter((id) => genomeOf(id)?.kind !== kind)
      if (changing.length === 0) return { refused: kind === 'mag' ? 'Already MAGs.' : 'Already elements.' }
      return {
        steps: changing.map((genome) => ({ op: 'retype', genome, kind }) as CurationStep),
        words: `make ${genomeWords(changing.map((id) => genomeOf(id)?.name ?? id))} ${changing.length === 1 ? (kind === 'mag' ? 'a MAG' : 'an element') : kind === 'mag' ? 'MAGs' : 'elements'}`,
      }
    }
    case 'pool':
      return {
        steps: ids.map((genome) => ({ op: 'dissolve', genome }) as CurationStep),
        words: `dissolve ${genomeWords(dragGenomes.map((genome) => genome.name))}: ${dragGenomes.reduce((sum, genome) => sum + genome.contigs, 0).toLocaleString('en-US')} contigs to the pool`,
      }
  }
}
