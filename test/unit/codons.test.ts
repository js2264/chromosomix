/**
 * The genetic codes and the six reading frames (§8.8).
 *
 * The tables are NCBI's strings copied by hand, so the first thing pinned here
 * is that they are the right shape and say what every biologist knows they say;
 * then that a frame is anchored to the sequence rather than to the window, that
 * the reverse frames are the reverse complement, and what an `N` and a
 * soft-masked base translate as. The lane's ladder is pinned last, from the
 * frame alone, as the residues' is in `sequence-lane.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import {
  CODON,
  GENETIC_CODES,
  codonAt,
  codonIndex,
  codonKindAt,
  codonTable,
  forEachCodon,
  geneticCode,
  isGeneticCode,
  translateFrame,
  aminoAcidAt,
} from '@/annotations/codons'
import { translationStyleOf } from '@/annotations/types'
import { frameAtAcross, framesRungFor, framesThickness } from '@/render/frames'
import type { LaneFrame } from '@/render/lane'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A region of `text` starting at `start` on chrI. */
function region(text: string, start = 0) {
  return { contig: 'chrI', start, end: start + text.length, bases: encode(text) }
}

/** The amino acid of one codon, written as a word, in a code. */
function aa(codon: string, code = 1): string {
  const [b0, b1, b2] = encode(codon)
  return aminoAcidAt(codonTable(code), codonIndex(b0, b1, b2))
}

describe('the NCBI tables', () => {
  it('are 64 characters each, over the twenty amino acids and a stop', () => {
    for (const code of GENETIC_CODES) {
      expect(code.aas, `table ${code.id}`).toMatch(/^[ACDEFGHIKLMNPQRSTVWY*]{64}$/)
      expect(code.starts, `table ${code.id}`).toMatch(/^[-M*]{64}$/)
    }
  })

  it('has every table NCBI publishes, once, and none it retired', () => {
    expect(GENETIC_CODES.map((code) => code.id)).toEqual([
      1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
      32, 33,
    ])
    expect(isGeneticCode(7)).toBe(false)
    expect(geneticCode(7).id).toBe(1)
  })

  it('reads the standard code as every textbook prints it', () => {
    expect(aa('ATG')).toBe('M')
    expect(aa('TGG')).toBe('W')
    expect(aa('TAA')).toBe('*')
    expect(aa('TAG')).toBe('*')
    expect(aa('TGA')).toBe('*')
    expect(aa('TTT')).toBe('F')
    expect(aa('GGG')).toBe('G')
    expect(aa('AAA')).toBe('K')
    expect(aa('CCC')).toBe('P')
    expect(aa('GCT')).toBe('A')
    expect(aa('CGA')).toBe('R')
    expect(aa('AGA')).toBe('R')
    expect(aa('ATA')).toBe('I')
    // Every codon translated against the whole table at once.
    const standard =
      'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'
    const order = 'TCAG'
    let at = 0
    for (const a of order) for (const b of order) for (const c of order) {
      expect(aa(a + b + c)).toBe(standard[at++])
    }
  })

  it('reads TGA as tryptophan in a Mycoplasma (table 4), and nothing else differs', () => {
    expect(aa('TGA', 4)).toBe('W')
    expect(aa('TAA', 4)).toBe('*')
    expect(aa('TAG', 4)).toBe('*')
    const differ = [...geneticCode(4).aas].filter((letter, i) => letter !== geneticCode(1).aas[i])
    expect(differ).toEqual(['W'])
  })

  it('reads the vertebrate mitochondrion’s four departures (table 2)', () => {
    expect(aa('TGA', 2)).toBe('W')
    expect(aa('ATA', 2)).toBe('M')
    expect(aa('AGA', 2)).toBe('*')
    expect(aa('AGG', 2)).toBe('*')
  })

  it('reads the yeast mitochondrion’s CTN as threonine (table 3)', () => {
    for (const codon of ['CTT', 'CTC', 'CTA', 'CTG']) expect(aa(codon, 3)).toBe('T')
  })

  it('reads a ciliate’s TAA and TAG as glutamine (table 6)', () => {
    expect(aa('TAA', 6)).toBe('Q')
    expect(aa('TAG', 6)).toBe('Q')
    expect(aa('TGA', 6)).toBe('*')
  })

  it('has the bacterial code’s alternative starts (table 11)', () => {
    const table = codonTable(11)
    const kind = (codon: string): number => {
      const [b0, b1, b2] = encode(codon)
      return codonKindAt(table, codonIndex(b0, b1, b2))
    }
    expect(kind('ATG')).toBe(CODON.start)
    for (const codon of ['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'GTG']) {
      expect(kind(codon), codon).toBe(CODON.alternative)
    }
    expect(kind('TGA')).toBe(CODON.stop)
    expect(kind('GCT')).toBe(CODON.sense)
    expect(aa('TGA', 11)).toBe('*')
  })
})

describe('a codon', () => {
  it('translates soft-masked bases as the upper-case ones, and U as T', () => {
    expect(aa('atg')).toBe('M')
    expect(aa('tGa')).toBe('*')
    expect(aa('AUG')).toBe('M')
    expect(aa('uaa')).toBe('*')
  })

  it('is X with an N, or any letter that is not a base, in it', () => {
    expect(aa('ANG')).toBe('X')
    expect(aa('NNN')).toBe('X')
    expect(aa('ATR')).toBe('X')
    const [b0, b1, b2] = encode('ANG')
    expect(codonKindAt(codonTable(1), codonIndex(b0, b1, b2))).toBe(CODON.unknown)
  })

  it('reads the other strand as the reverse complement', () => {
    // CAT read backwards on the other strand is ATG.
    const [b0, b1, b2] = encode('CAT')
    expect(aminoAcidAt(codonTable(1), codonIndex(b0, b1, b2, true))).toBe('M')
    // TTA → TAA, a stop; TCA → TGA, a stop in table 1 and W in table 4.
    const tta = encode('TTA')
    expect(aminoAcidAt(codonTable(1), codonIndex(tta[0], tta[1], tta[2], true))).toBe('*')
    const tca = encode('TCA')
    expect(aminoAcidAt(codonTable(4), codonIndex(tca[0], tca[1], tca[2], true))).toBe('W')
  })
})

describe('the six frames', () => {
  //            0         1         2
  //            0123456789012345678901234
  const text = 'ATGGCCTGAAAATAGCATTTACCAT'

  it('reads +1, +2 and +3 from the sequence’s first base', () => {
    expect(translateFrame(region(text), 1, 1)).toBe('MA*K*HLP')
    expect(translateFrame(region(text), 2, 1)).toBe('WPENSIYH')
    expect(translateFrame(region(text), 3, 1)).toBe('GLKIAFT')
  })

  it('reads −1, −2 and −3 as the reverse complement, in the same boxes', () => {
    // −1 is the reverse complement of each +1 codon, read right to left.
    expect(translateFrame(region(text), -1, 1)).toBe('W*MLFSGH')
    // Built independently: reverse-complement the whole string and translate
    // the codons that sit over the same positions.
    const complement: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' }
    const rc = [...text].reverse().map((base) => complement[base]).join('')
    const expected = (phase: number): string => {
      const out: string[] = []
      for (let start = phase; start + 3 <= text.length; start += 3) {
        // The box [start, start + 3) on the forward strand is [L − start − 3, L − start) on rc.
        const from = text.length - start - 3
        out.push(aa(rc.slice(from, from + 3)))
      }
      return out.reverse().join('')
    }
    expect(translateFrame(region(text), -1, 1)).toBe(expected(0))
    expect(translateFrame(region(text), -2, 1)).toBe(expected(1))
    expect(translateFrame(region(text), -3, 1)).toBe(expected(2))
  })

  it('does not move with the window: a frame is a property of the genome', () => {
    // The same bases fetched as a window starting at 1001, which is 2 mod 3,
    // are read in the frames of the genome's coordinates and not the window's.
    const shifted = region(text, 1001)
    const codons: number[] = []
    forEachCodon(shifted, 1, codonTable(1), 1001, 1001 + text.length, (start) => codons.push(start))
    expect(codons[0]).toBe(1002)
    expect(codons.every((start) => start % 3 === 0)).toBe(true)
    // So +1 of the shifted window is +2 of the one at 0, less nothing: the
    // codon at 1002 is the window's bases 1 – 3.
    expect(translateFrame(shifted, 1, 1)).toBe(translateFrame(region(text), 2, 1))
  })

  it('skips a codon that runs off either end of what has arrived', () => {
    const codons: number[] = []
    forEachCodon(region('ATGGC', 10), 2, codonTable(1), 0, 100, (start) => codons.push(start))
    // +2 begins where position mod 3 is 1: 10 → its codon is 10 – 12; 13 would need 13 – 15.
    expect(codons).toEqual([10])
  })

  it('translates TGA by the lane’s code', () => {
    expect(translateFrame(region(text), 1, 1)).toContain('*')
    expect(translateFrame(region(text), 1, 4)).toBe('MAWK*HLP')
  })

  it('names the codon under a position as its strand reads it', () => {
    const regions = [region(text)]
    expect(codonAt(regions, 'chrI', 1.5, 1, 1)).toEqual({ start: 0, codon: 'ATG', aa: 'M' })
    expect(codonAt(regions, 'chrI', 7, 1, 1)).toEqual({ start: 6, codon: 'TGA', aa: '*' })
    expect(codonAt(regions, 'chrI', 7, 1, 4)).toEqual({ start: 6, codon: 'TGA', aa: 'W' })
    // `CAT` at 15 – 17, read from the other strand.
    expect(codonAt(regions, 'chrI', 16, -1, 1)).toEqual({ start: 15, codon: 'ATG', aa: 'M' })
    expect(codonAt(regions, 'chrII', 1, 1, 1)).toBeNull()
    expect(codonAt(regions, 'chrI', 24, 1, 1)).toBeNull()
  })
})

describe('the stored setting', () => {
  it('reads back a code NCBI publishes, and the standard one for anything else', () => {
    expect(translationStyleOf({ frames: true, code: 4 })).toEqual({ frames: true, code: 4 })
    expect(translationStyleOf({ frames: 'yes', code: 7 })).toEqual({ frames: false, code: 1 })
    expect(translationStyleOf({ frames: true, code: '11' })).toEqual({ frames: true, code: 1 })
    expect(translationStyleOf(null)).toEqual({ frames: false, code: 1 })
  })
})

/** A bottom lane over `[from, to)` base pairs, as in `sequence-lane.test.ts`. */
function frameOver(from: number, to: number, pixels = 900): LaneFrame {
  const scale = pixels / (to - from)
  return {
    orientation: 'bottom',
    toPixel: (unit) => (unit - from) * scale,
    toUnit: (pixel) => from + pixel / scale,
    domain: [from, to],
    alongFrom: 0,
    alongTo: pixels,
    acrossFrom: 100,
    thickness: 80,
  }
}

describe('the frames’ ladder', () => {
  it('writes letters where a codon holds one, then bare codons, then ticks, then nothing', () => {
    expect(framesRungFor(frameOver(0, 300), 12)).toBe('letters')
    // Three pixels a base: nine a codon, the narrowest a letter goes in.
    expect(framesRungFor(frameOver(0, 300), 8)).toBe('codons')
    expect(framesRungFor(frameOver(0, 900), 12)).toBe('codons')
    expect(framesRungFor(frameOver(0, 901), 12)).toBe('ticks')
    expect(framesRungFor(frameOver(0, 900 * 24), 12)).toBe('ticks')
    expect(framesRungFor(frameOver(0, 900 * 24 + 1), 12)).toBe('none')
    expect(framesRungFor(frameOver(500, 500), 12)).toBe('none')
  })

  it('finds the row under a point, and nothing between two', () => {
    expect(framesThickness(12)).toBe(3 + 72 + 4)
    expect(frameAtAcross(0, 12)).toBeNull()
    expect(frameAtAcross(3, 12)).toBe(1)
    expect(frameAtAcross(15, 12)).toBe(2)
    expect(frameAtAcross(38, 12)).toBe(3)
    expect(frameAtAcross(40, 12)).toBeNull()
    expect(frameAtAcross(43, 12)).toBe(-1)
    expect(frameAtAcross(78, 12)).toBe(-3)
  })
})
