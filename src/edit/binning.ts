/**
 * The contig → MAG table of a metagenome with every genome's edit applied
 * (SPECS §27.10): the binning the edits make, in the two columns DAS_Tool,
 * anvi'o and `metacooler create` take — a contig and its genome, one a line,
 * no header, a contig of no genome left out.
 *
 * By the file's own contigs, so it applies to the assembly the reads were
 * mapped to: a contig a genome's edit sent to another is that genome's, one a
 * genome brought in is its, one set aside as a contaminant with nowhere to go,
 * as debris or as a haplotig is no genome's. How a genome's contigs are
 * ordered, turned and joined is its AGP's to say, not this table's.
 */

import { EditedAssembly, isGap, type ReferenceEdit } from '../genome/edit'

/** The name the format gives no genome, which the table leaves out. */
export const UNBINNED = '__unbinned__'

/** The table, and what it says about how it was made. */
export interface BinningTable {
  text: string
  /** Contigs listed, and genomes they are in. */
  contigs: number
  genomes: number
  /** Contigs whose genome an edit changed. */
  moved: number
  /** What a reader should know: a contig two genomes claim, one only part of which was moved. */
  notes: string[]
}

/**
 * The binning every genome's edit makes of the file's contigs.
 *
 * @param contigs Every contig of the file, in its order, with the genome the
 *   file puts it in.
 * @param edits Each genome's edit, where it has one.
 */
export function binningTable(contigs: ReadonlyArray<{ name: string; genome: string }>, edits: ReadonlyMap<string, ReferenceEdit>): BinningTable {
  const genomeOf = new Map(contigs.map((contig) => [contig.name, contig.genome]))
  const file = new Map(genomeOf)
  // Who claims each contig, genome by genome in the file's order of them.
  const claimed = new Map<string, string>()
  const notes: string[] = []
  const order = [...new Set(contigs.map((contig) => contig.genome))].filter((genome) => edits.has(genome))
  for (const genome of order) {
    const edit = edits.get(genome)
    if (edit === undefined || edit.cursor === 0) continue
    const assembly = EditedAssembly.of(edit)
    const placed = new Set<string>()
    for (const sequence of assembly.sequences) for (const part of sequence.parts) if (!isGap(part)) placed.add(part.sequence)
    const leaving = new Map<string, string>()
    for (const item of assembly.aside) {
      const name = item.piece.sequence
      if (item.why === 'unplaced') {
        placed.add(name)
        continue
      }
      leaving.set(name, item.genome ?? UNBINNED)
    }
    // What the edit keeps is the genome's; what it sent away, the other's —
    // unless some of it stays, which keeps it here and is said.
    for (const name of placed) {
      const before = claimed.get(name)
      if (before !== undefined && before !== genome && file.get(name) !== genome) {
        notes.push(`${name} is brought in by both ${before} and ${genome}; the table has it in ${genome}`)
      }
      claimed.set(name, genome)
    }
    for (const [name, to] of leaving) {
      if (placed.has(name)) {
        notes.push(`part of ${name} was sent from ${genome} to ${to === UNBINNED ? 'no genome' : to}, and part kept: the table keeps it in ${genome}`)
        continue
      }
      if (claimed.get(name) === undefined || claimed.get(name) === genome) claimed.set(name, to)
    }
    // A contig of the genome the edit neither places nor sets aside — a layout
    // that left it out, which sets it aside unplaced, is the one way — stays.
  }
  let moved = 0
  const lines: string[] = []
  const genomes = new Set<string>()
  for (const { name } of contigs) {
    const genome = claimed.get(name) ?? genomeOf.get(name) ?? UNBINNED
    if (genome !== (file.get(name) ?? UNBINNED)) moved++
    if (genome === UNBINNED) continue
    lines.push(`${name}\t${genome}`)
    genomes.add(genome)
  }
  return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, contigs: lines.length, genomes: genomes.size, moved, notes }
}
