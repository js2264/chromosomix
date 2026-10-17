/**
 * What a metagenome's own tables say about the sections of a circle (§7.6).
 *
 * A genome × genome block names its genomes and nothing else, and a pooled slot
 * of the contig × contig level names the contig it starts at. The arcs are
 * sized by base pairs and the rings are drawn along contigs, so both come from
 * `/genomes` and `/contigs`, which the session has already read: the lengths at
 * open, the contigs as the annotations were set up.
 *
 * `__unbinned__` is not a genome (§7.4): only the genomes the file displays are
 * indexed, and its contigs are in no genome's list and no slot.
 */

import type { CircleResolver, CircleSequence } from '../render/circle'
import { arrange, type ReaderOrder } from '../state/readerOrder'
import type { TablePayload } from '../worker/protocol'

/**
 * Index the two tables for a circle.
 *
 * `display` is the genome rows the file displays (`GenomesResult.display`). The
 * contigs table may not have been read yet: a resolver built without it answers
 * lengths from `/genomes` and `null` for sequences, which is what tells the
 * circle to ask again.
 */
export function circleResolverFrom(
  genomes: TablePayload | null,
  display: ArrayLike<number> | null,
  contigs: TablePayload | null,
  /** The reader's order now (§7.6), which a genome's contigs are laid out in. */
  readerOrder: () => ReaderOrder | null = () => null,
): CircleResolver {
  const genomeNames = genomes?.data['name']
  const genomeLengthColumn = genomes?.data['length']
  const lengthOf = new Map<string, number>()
  const shown = new Set<number>()
  if (Array.isArray(genomeNames)) {
    const rows = display === null ? genomeNames.map((_, row) => row) : Array.from(display)
    for (const row of rows) {
      shown.add(row)
      const name = (genomeNames as string[])[row]
      const length =
        genomeLengthColumn !== undefined && !Array.isArray(genomeLengthColumn)
          ? Number(genomeLengthColumn[row])
          : Number.NaN
      if (name !== undefined && Number.isFinite(length)) lengthOf.set(name, length)
    }
  }

  const contigNames = contigs?.data['name']
  const contigLengths = contigs?.data['length']
  const contigGenome = contigs?.data['genome_id']
  const haveContigs =
    Array.isArray(contigNames) &&
    contigLengths !== undefined &&
    !Array.isArray(contigLengths) &&
    contigGenome !== undefined &&
    !Array.isArray(contigGenome) &&
    Array.isArray(genomeNames)

  // Every displayable contig in file order — which is grouped by genome (C4) —
  // and each genome's run of them.
  const order: CircleSequence[] = []
  const at = new Map<string, number>()
  const byGenome = new Map<string, CircleSequence[]>()
  const contigLength = new Map<string, number>()
  if (haveContigs) {
    const names = contigNames as string[]
    for (let row = 0; row < names.length; row++) {
      const length = Number((contigLengths as Float64Array)[row])
      const name = names[row]
      if (!contigLength.has(name)) contigLength.set(name, length)
      const genomeRow = Number((contigGenome as Float64Array)[row])
      if (shown.size > 0 && !shown.has(genomeRow)) continue
      const genome = (genomeNames as string[])[genomeRow]
      if (genome === undefined) continue
      const sequence = { name, length }
      if (!at.has(name)) at.set(name, order.length)
      order.push(sequence)
      const list = byGenome.get(genome)
      if (list === undefined) byGenome.set(genome, [sequence])
      else list.push(sequence)
    }
  }

  // A genome's contigs in the reader's order, laid out once per order.
  const arranged = new Map<string, CircleSequence[]>()
  let arrangedFor: ReaderOrder | null = null
  const sequencesOf = (genome: string): CircleSequence[] => {
    const file = byGenome.get(genome) ?? []
    const now = readerOrder()
    const placed = now?.contigs[genome]
    if (placed === undefined) return file
    if (now !== arrangedFor) {
      arranged.clear()
      arrangedFor = now
    }
    let list = arranged.get(genome)
    if (list === undefined) {
      const byName = new Map(file.map((sequence) => [sequence.name, sequence]))
      list = arrange(
        file.map((sequence) => sequence.name),
        placed,
      ).map((name) => byName.get(name) as CircleSequence)
      arranged.set(genome, list)
    }
    return list
  }

  return {
    genomeLength: (genome) => lengthOf.get(genome),
    genomeSequences: (genome) => (haveContigs ? sequencesOf(genome) : null),
    slotSequences: (first, count) => {
      if (!haveContigs) return null
      const from = at.get(first)
      if (from === undefined) return null
      return order.slice(from, from + Math.max(1, count))
    },
    contigLength: (name) => contigLength.get(name),
  }
}
