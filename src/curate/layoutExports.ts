/**
 * Every curated genome as the session draws it, written (SPECS §33.8): the
 * sequences of each — a genome its edit of the reference lays out (§27.10) as
 * the edit has them, kept to the contigs the curation gives it; any other as
 * its contigs, whole, longest first — as one AGP 2.1, one FASTA and the table
 * of which genome each sequence is of.
 *
 * In the curated map's order of genomes, by name as metacooler orders text
 * (`metacooler/curationLens.ts`); the pool is no genome's and is left out. A
 * stretch of a genome's contig set aside as debris, a contaminant or a
 * haplotig is written as the editor's AGP writes it, a comment naming it, and
 * one set aside unplaced is a sequence of its own (`edit/exports.ts`).
 *
 * Pure: text in, text out.
 */

import type { BaseBinning, CuratedBinning, GenomeKind } from '../genome/curation'
import { isGap, type Aside, type Part } from '../genome/edit'
import { agpObjectLines } from '../edit/exports'
import type { FastaObject } from '../edit/lifted'
import { codePointCompare } from '../metacooler/curationLens'
import { membersInOrder, type DrawnLayout } from './layouts'

/** A sequence of a curated genome, as it is written. */
export interface CuratedSequence {
  name: string
  parts: Part[]
  length: number
  /** The genome it is of, by its name now. */
  genome: string
  kind: GenomeKind
  /** Of a genome its edit lays out. */
  laidOut: boolean
  /** A stretch set aside as unplaced, written as a sequence of its own. */
  unplaced: boolean
}

/** Every genome's sequences, and what the AGP says of each genome. */
export interface CuratedSequences {
  sequences: CuratedSequence[]
  genomes: Array<{ name: string; kind: GenomeKind; laidOut: boolean; sequences: number; aside: readonly Aside[] }>
}

/** Every curated genome's sequences as the session draws them. */
export function curatedSequences(binning: CuratedBinning, base: BaseBinning, layouts: readonly DrawnLayout[]): CuratedSequences {
  const laid = new Map(layouts.map((layout) => [layout.genome, layout]))
  const order = binning.genomes.map((_, g) => g).sort((a, b) => codePointCompare(binning.genomes[a].name, binning.genomes[b].name))
  const sequences: CuratedSequence[] = []
  const genomes: CuratedSequences['genomes'] = []
  for (const g of order) {
    const genome = binning.genomes[g]
    const layout = laid.get(g)
    const before = sequences.length
    if (layout !== undefined) {
      for (const sequence of layout.sequences) {
        sequences.push({
          name: sequence.name,
          parts: sequence.parts,
          length: sequence.length,
          genome: genome.name,
          kind: genome.kind,
          laidOut: true,
          unplaced: sequence.unplaced === true,
        })
      }
    } else {
      const members = membersInOrder(binning, g, base.names, base.lengths)
      members.names.forEach((name, i) => {
        const length = members.lengths[i]
        sequences.push({ name, parts: [{ id: name, sequence: name, start: 0, end: length, strand: 1 }], length, genome: genome.name, kind: genome.kind, laidOut: false, unplaced: false })
      })
    }
    genomes.push({ name: genome.name, kind: genome.kind, laidOut: layout !== undefined, sequences: sequences.length - before, aside: layout?.aside ?? [] })
  }
  return { sequences, genomes }
}

/** Where the files came from, for the comment lines that carry it. */
export interface CuratedContext {
  /** The map the curation was made on. */
  file: string
  /** The app that wrote it, with its version. */
  by: string
  /** When, as an ISO date. */
  created: string
  /** The curation's steps applied. */
  steps: number
}

const KIND_WORD: Record<GenomeKind, string> = { mag: 'MAG', element: 'element' }

/**
 * The AGP 2.1 of every curated genome: each genome's sequences as objects,
 * after a `# genome` comment naming it, its kind and whether its edit lays it
 * out, and the stretches of its contigs set aside, as the editor's AGP names
 * them (`# aside`).
 */
export function curatedAgp(written: CuratedSequences, context: CuratedContext): string {
  const laidOut = written.genomes.filter((genome) => genome.laidOut).length
  const lines = [
    '##agp-version\t2.1',
    `# AGP of the curated genomes of ${context.file}`,
    `# written by ${context.by} on ${context.created}`,
    `# ${written.genomes.length} genomes after ${context.steps} curation step${context.steps === 1 ? '' : 's'}; ${laidOut} laid out by ${laidOut === 1 ? 'its edit' : 'their edits'} of the reference, every other as its contigs; the pool left out`,
  ]
  let at = 0
  for (const genome of written.genomes) {
    lines.push(`# genome\t${genome.name}\t${KIND_WORD[genome.kind]}\t${genome.laidOut ? 'laid out' : 'as its contigs'}`)
    for (const item of genome.aside) {
      const { sequence, start, end } = item.piece
      lines.push(`# aside\t${item.why}\t${sequence}:${start + 1}-${end}${item.genome === undefined ? '' : `\t${item.genome}`}`)
    }
    for (const sequence of written.sequences.slice(at, at + genome.sequences)) {
      if (sequence.unplaced) lines.push(`# aside\tunplaced\t${sequence.name}`)
    }
    for (const sequence of written.sequences.slice(at, at + genome.sequences)) lines.push(...agpObjectLines(sequence.name, sequence.parts))
    at += genome.sequences
  }
  return `${lines.join('\n')}\n`
}

/** A sequence's parts as the table writes them: `c1+,N100,c2:1001-4000-`, 1-based and inclusive. */
function partsText(sequence: CuratedSequence, lengthOf: (name: string) => number | undefined): string {
  return sequence.parts
    .map((part) => {
      if (isGap(part)) return `N${part.gap}`
      const whole = part.start === 0 && part.end === lengthOf(part.sequence)
      return `${part.sequence}${whole ? '' : `:${part.start + 1}-${part.end}`}${part.strand === 1 ? '+' : '-'}`
    })
    .join(',')
}

/**
 * Which genome every sequence is of: `sequence`, `genome`, `kind` (`MAG`,
 * `element`), `length`, `laid_out` (`yes` for a sequence of a genome its edit
 * lays out) and `parts`, what it is made of — the table a sequence of the
 * FASTA is looked up in.
 */
export function sequenceGenomeTable(written: CuratedSequences, base: BaseBinning): { text: string; rows: number } {
  const index = new Map(base.names.map((name, c) => [name, c]))
  const lengthOf = (name: string): number | undefined => {
    const c = index.get(name)
    return c === undefined ? undefined : base.lengths[c]
  }
  const lines = ['sequence\tgenome\tkind\tlength\tlaid_out\tparts']
  for (const sequence of written.sequences) {
    lines.push([sequence.name, sequence.genome, KIND_WORD[sequence.kind], sequence.length, sequence.laidOut ? 'yes' : 'no', partsText(sequence, lengthOf)].join('\t'))
  }
  return { text: `${lines.join('\n')}\n`, rows: written.sequences.length }
}

/** The FASTA's records: each sequence, its genome said after its name (`>c1 genome=MAG_3`), which every reader of a FASTA name skips. */
export function fastaObjects(written: CuratedSequences): FastaObject[] {
  return written.sequences.map((sequence) => ({ name: sequence.name, parts: sequence.parts, length: sequence.length, description: `genome=${sequence.genome}` }))
}
