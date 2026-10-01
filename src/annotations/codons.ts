/**
 * The genetic codes, and the six frames a sequence is read in (§8.8).
 *
 * Every table here is NCBI's, written the way NCBI writes it (`gc.prt`): two
 * strings of 64 characters over the codons in `TCAG` order — the first base
 * slowest, the third fastest, so `TTT` is 0, `TTC` 1 and `GGG` 63. `aas` is the
 * amino acid each codon reads as, `*` for a stop; `starts` marks with `M` the
 * codons a ribosome can begin at, and with `*` the stops. Copied as strings
 * rather than rebuilt as a table of codons because the string is what every
 * other tool prints and what a reader checking one would compare against: one
 * typo in a dictionary of 64 entries is invisible, one in a string set beside
 * NCBI's is a character out of a column.
 *
 * Pure, and with no idea of a canvas, so the lane, its readout and the tests all
 * read a codon the same way.
 */

import type { BaseRegion } from './types'

/** One of NCBI's translation tables. */
export interface GeneticCode {
  /** NCBI's number, the one `transl_table=` in a GenBank file names. */
  id: number
  name: string
  /** The amino acid of each codon in `TCAG` order, `*` for a stop. */
  aas: string
  /** `M` where the codon can start a protein, `*` where it can stop one. */
  starts: string
}

/**
 * Every table NCBI publishes, by number.
 *
 * 7, 8, 17 – 20 are not missing by accident: NCBI retired them (7 and 8 were
 * merged into 4 and 1), and a number that names nothing would be a choice that
 * draws the standard code under another name. 27, 28 and 31 are the codes whose
 * stops are *contextual* — `TGA` in a karyorelict is a tryptophan inside a gene
 * and a stop at its end — and NCBI's `aas` gives the sense reading, which is
 * what is drawn; the `*` in `starts` keeps the other one on record.
 */
export const GENETIC_CODES: readonly GeneticCode[] = [
  {
    id: 1,
    name: 'Standard',
    aas: 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '---M------**--*----M---------------M----------------------------',
  },
  {
    id: 2,
    name: 'Vertebrate Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSS**VVVVAAAADDEEGGGG',
    starts: '----------**--------------------MMMM----------**---M------------',
  },
  {
    id: 3,
    name: 'Yeast Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWTTTTPPPPHHQQRRRRIIMMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------**----------------------MM---------------M------------',
  },
  {
    id: 4,
    name: 'Mold, Protozoan, Coelenterate Mitochondrial; Mycoplasma, Spiroplasma',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '--MM------**-------M------------MMMM---------------M------------',
  },
  {
    id: 5,
    name: 'Invertebrate Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSSSVVVVAAAADDEEGGGG',
    starts: '---M------**--------------------MMMM---------------M------------',
  },
  {
    id: 6,
    name: 'Ciliate, Dasycladacean and Hexamita Nuclear',
    aas: 'FFLLSSSSYYQQCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '--------------*--------------------M----------------------------',
  },
  {
    id: 9,
    name: 'Echinoderm and Flatworm Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
    starts: '----------**-----------------------M---------------M------------',
  },
  {
    id: 10,
    name: 'Euplotid Nuclear',
    aas: 'FFLLSSSSYY**CCCWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------**-----------------------M----------------------------',
  },
  {
    id: 11,
    name: 'Bacterial, Archaeal and Plant Plastid',
    aas: 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '---M------**--*----M------------MMMM---------------M------------',
  },
  {
    id: 12,
    name: 'Alternative Yeast Nuclear',
    aas: 'FFLLSSSSYY**CC*WLLLSPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------**--*----M---------------M----------------------------',
  },
  {
    id: 13,
    name: 'Ascidian Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSGGVVVVAAAADDEEGGGG',
    starts: '---M------**----------------------MM---------------M------------',
  },
  {
    id: 14,
    name: 'Alternative Flatworm Mitochondrial',
    aas: 'FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
    starts: '-----------*-----------------------M----------------------------',
  },
  {
    id: 15,
    name: 'Blepharisma Macronuclear',
    aas: 'FFLLSSSSYY*QCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------*---*--------------------M----------------------------',
  },
  {
    id: 16,
    name: 'Chlorophycean Mitochondrial',
    aas: 'FFLLSSSSYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------*---*--------------------M----------------------------',
  },
  {
    id: 21,
    name: 'Trematode Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
    starts: '----------**-----------------------M---------------M------------',
  },
  {
    id: 22,
    name: 'Scenedesmus obliquus Mitochondrial',
    aas: 'FFLLSS*SYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '------*---*---*--------------------M----------------------------',
  },
  {
    id: 23,
    name: 'Thraustochytrium Mitochondrial',
    aas: 'FF*LSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '--*-------**--*-----------------M--M---------------M------------',
  },
  {
    id: 24,
    name: 'Rhabdopleuridae Mitochondrial',
    aas: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG',
    starts: '---M------**-------M---------------M---------------M------------',
  },
  {
    id: 25,
    name: 'Candidate Division SR1 and Gracilibacteria',
    aas: 'FFLLSSSSYY**CCGWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '---M------**-----------------------M---------------M------------',
  },
  {
    id: 26,
    name: 'Pachysolen tannophilus Nuclear',
    aas: 'FFLLSSSSYY**CC*WLLLAPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------**--*----M---------------M----------------------------',
  },
  {
    id: 27,
    name: 'Karyorelict Nuclear',
    aas: 'FFLLSSSSYYQQCCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '--------------*--------------------M----------------------------',
  },
  {
    id: 28,
    name: 'Condylostoma Nuclear',
    aas: 'FFLLSSSSYYQQCCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------**--*--------------------M----------------------------',
  },
  {
    id: 29,
    name: 'Mesodinium Nuclear',
    aas: 'FFLLSSSSYYYYCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '--------------*--------------------M----------------------------',
  },
  {
    id: 30,
    name: 'Peritrich Nuclear',
    aas: 'FFLLSSSSYYEECC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '--------------*--------------------M----------------------------',
  },
  {
    id: 31,
    name: 'Blastocrithidia Nuclear',
    aas: 'FFLLSSSSYYEECCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '----------**-----------------------M----------------------------',
  },
  {
    id: 32,
    name: 'Balanophoraceae Plastid',
    aas: 'FFLLSSSSYY*WCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
    starts: '---M------*---*----M------------MMMM---------------M------------',
  },
  {
    id: 33,
    name: 'Cephalodiscidae Mitochondrial',
    aas: 'FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG',
    starts: '---M-------*-------M---------------M---------------M------------',
  },
]

/** The code a new lane reads with: NCBI's table 1. */
export const DEFAULT_GENETIC_CODE = 1

/** A table by number, or the standard one for a number NCBI does not use. */
export function geneticCode(id: number): GeneticCode {
  return GENETIC_CODES.find((code) => code.id === id) ?? GENETIC_CODES[0]
}

/** `true` when NCBI has a table of this number. */
export function isGeneticCode(id: unknown): id is number {
  return typeof id === 'number' && GENETIC_CODES.some((code) => code.id === id)
}

/**
 * What a codon is, for the picture: the four things a frame is drawn as.
 *
 * `start` is a methionine the table lets a protein begin at — `ATG`, and `ATA`
 * where a mitochondrion reads it as M. `alternative` is a start that reads as
 * something else inside a gene (`TTG` as L, `GTG` as V): table 11 has six of
 * them and table 4 seven, and drawing all of them green would turn every frame
 * of a Mycoplasma genome into a start every few codons. They are marked, not
 * filled.
 */
export const CODON = { sense: 0, start: 1, alternative: 2, stop: 3, unknown: 4 } as const
export type CodonKind = (typeof CODON)[keyof typeof CODON]

/** One table, unpacked for the paint loop: 64 kinds and 64 letters. */
export interface CodonTable {
  code: GeneticCode
  kinds: Uint8Array
}

const tables = new Map<number, CodonTable>()

/** The table for a code, built once. */
export function codonTable(id: number): CodonTable {
  const code = geneticCode(id)
  const held = tables.get(code.id)
  if (held !== undefined) return held
  const kinds = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const aa = code.aas[i]
    const start = code.starts[i] === 'M'
    kinds[i] =
      aa === '*' ? CODON.stop : start && aa === 'M' ? CODON.start : start ? CODON.alternative : CODON.sense
  }
  const table = { code, kinds }
  tables.set(code.id, table)
  return table
}

/**
 * A base's place in `TCAG` order, `-1` for anything else.
 *
 * Upper and lower case alike — soft-masking says a stretch is a repeat, not
 * that it codes for something else — and `U` as `T`, so an RNA reads.
 */
const NUCLEOTIDE = ((): Int8Array => {
  const table = new Int8Array(256).fill(-1)
  const set = (letters: string, index: number): void => {
    for (const letter of letters) {
      table[letter.charCodeAt(0)] = index
      table[letter.toLowerCase().charCodeAt(0)] = index
    }
  }
  set('TU', 0)
  set('C', 1)
  set('A', 2)
  set('G', 3)
  return table
})()

/**
 * A codon's index in `TCAG` order, or `-1` where any of its bases is not one.
 *
 * `reverse` reads the three bytes as the other strand does: the complement of
 * the third, then the second, then the first. In `TCAG` order the complement of
 * index `i` is `i ^ 2` (T↔A, C↔G), so that is arithmetic and not a second table.
 */
export function codonIndex(b0: number, b1: number, b2: number, reverse = false): number {
  const n0 = NUCLEOTIDE[b0]
  const n1 = NUCLEOTIDE[b1]
  const n2 = NUCLEOTIDE[b2]
  if (n0 < 0 || n1 < 0 || n2 < 0) return -1
  return reverse ? ((n2 ^ 2) << 4) | ((n1 ^ 2) << 2) | (n0 ^ 2) : (n0 << 4) | (n1 << 2) | n2
}

/** The amino acid at an index, `X` for a codon with a base that is not one. */
export function aminoAcidAt(table: CodonTable, index: number): string {
  return index < 0 ? 'X' : table.code.aas[index]
}

/** What the codon at an index is drawn as. */
export function codonKindAt(table: CodonTable, index: number): CodonKind {
  return index < 0 ? CODON.unknown : (table.kinds[index] as CodonKind)
}

/**
 * The six frames, top to bottom as the lane draws them.
 *
 * `+1` reads the codons that begin at a multiple of three, counted from the
 * sequence's first base (0-based); `+2` and `+3` one and two bases on. `−1`,
 * `−2` and `−3` are the reverse complement read in the **same boxes** as `+1`,
 * `+2` and `+3`. Both are anchored to the start of the sequence rather than to
 * the window or to its far end, so a frame is a property of the genome and does
 * not move when the view does — and a codon in `+2` sits exactly above its
 * complement in `−2`.
 */
export const READING_FRAMES = [1, 2, 3, -1, -2, -3] as const
export type ReadingFrame = (typeof READING_FRAMES)[number]

/** The first base of the frame's codons, as a residue mod 3. */
export function phaseOf(frame: ReadingFrame): number {
  return Math.abs(frame) - 1
}

/** `+1`, `−2` — the frame as a label, with a real minus sign. */
export function frameName(frame: ReadingFrame): string {
  return frame > 0 ? `+${frame}` : `−${-frame}`
}

/**
 * Visit every whole codon of one frame inside `[from, to)` of one region.
 *
 * A callback rather than an array because the lane asks for it on every frame
 * of a drag, and at the coarsest zoom it draws that is fifty thousand codons a
 * row: a visitor allocates nothing. A codon that runs off either end of the
 * region is not visited — its third base has not arrived, and guessing one would
 * be translating a codon that is not there.
 */
export function forEachCodon(
  region: BaseRegion,
  frame: ReadingFrame,
  table: CodonTable,
  from: number,
  to: number,
  visit: (start: number, index: number, kind: CodonKind) => void,
): void {
  const low = Math.max(region.start, Math.floor(from))
  const high = Math.min(region.end, Math.ceil(to))
  const phase = phaseOf(frame)
  // The first codon start at or after `low` that is in this frame.
  let start = low + ((((phase - low) % 3) + 3) % 3)
  const reverse = frame < 0
  const bases = region.bases
  for (; start + 3 <= high; start += 3) {
    const at = start - region.start
    const index = codonIndex(bases[at], bases[at + 1], bases[at + 2], reverse)
    visit(start, index, codonKindAt(table, index))
  }
}

/**
 * A stretch translated in one frame, as a string of one-letter amino acids.
 *
 * The lane draws through {@link forEachCodon}; this is the same reading as a
 * word, for the readout and for a test to hold against a known protein.
 */
export function translateFrame(
  region: BaseRegion,
  frame: ReadingFrame,
  code: number,
  from = region.start,
  to = region.end,
): string {
  const table = codonTable(code)
  const out: string[] = []
  forEachCodon(region, frame, table, from, to, (_start, index) => out.push(aminoAcidAt(table, index)))
  // The reverse frames are read right to left, so their protein is too.
  return frame < 0 ? out.reverse().join('') : out.join('')
}

/**
 * The codon of one frame that a position is inside, for the readout.
 *
 * `null` outside what has arrived. The codon is written as the strand reads it,
 * so a reverse frame's `CAT` box answers `ATG → M`.
 */
export function codonAt(
  regions: readonly BaseRegion[],
  contig: string,
  bp: number,
  frame: ReadingFrame,
  code: number,
): { start: number; codon: string; aa: string } | null {
  const at = Math.floor(bp)
  const phase = phaseOf(frame)
  const start = at - ((((at - phase) % 3) + 3) % 3)
  for (const region of regions) {
    if (region.contig !== contig || start < region.start || start + 3 > region.end) continue
    const i = start - region.start
    const bytes = [region.bases[i], region.bases[i + 1], region.bases[i + 2]]
    const index = codonIndex(bytes[0], bytes[1], bytes[2], frame < 0)
    const letters = bytes.map((byte) => String.fromCharCode(byte).toUpperCase())
    const codon =
      frame < 0
        ? letters
            .reverse()
            .map((letter) => COMPLEMENT[letter] ?? letter)
            .join('')
        : letters.join('')
    return { start, codon, aa: aminoAcidAt(codonTable(code), index) }
  }
  return null
}

const COMPLEMENT: Record<string, string> = { A: 'T', T: 'A', U: 'A', C: 'G', G: 'C' }
