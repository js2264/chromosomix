/**
 * The motif matcher, which is the whole of the sequence search that can be
 * checked without a genome.
 *
 * Everything the search feature does above this module is wiring — a card, a
 * worker request, a `FeatureSet` — and every claim it makes that could be wrong
 * about *biology* is made here: what a degenerate code stands for, what an `N`
 * in the reference means, whether a palindrome is one site or two, and whether
 * `AA` occurs twice in `AAA`. So this file is written against those claims
 * rather than against the functions' signatures.
 */

import { describe, expect, it } from 'vitest'

import {
  compileMotif,
  findMotif,
  isMotifRefusal,
  isPalindromic,
  MOTIF_MAX_LENGTH,
  motifOverlap,
  reverseComplement,
  type Motif,
} from '../../src/annotations/motif'

/** ASCII bytes, which is how the FASTA reader keeps residues. */
function bases(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let at = 0; at < text.length; at++) out[at] = text.charCodeAt(at)
  return out
}

/** Compile, and fail the test rather than the type check if it is refused. */
function motif(pattern: string): Motif {
  const compiled = compileMotif(pattern)
  if (isMotifRefusal(compiled)) throw new Error(`${pattern} was refused: ${compiled.reason}`)
  return compiled
}

/** Just the coordinates, which is what most of these assertions are about. */
function spans(text: string, pattern: string, bothStrands = false): Array<[number, number, number]> {
  return findMotif(bases(text), motif(pattern), { bothStrands }).hits.map((hit) => [
    hit.start,
    hit.end,
    hit.strand,
  ])
}

describe('compiling a pattern', () => {
  it('takes the four bases, U for T, and the eleven ambiguity codes', () => {
    for (const pattern of ['ACGT', 'ACGU', 'RYSWKM', 'BDHVN']) {
      expect(isMotifRefusal(compileMotif(pattern)), pattern).toBe(false)
    }
  })

  it('is indifferent to case, because soft-masking is not a different base', () => {
    expect(spans('aaggttccGAATTCaaa', 'GAATTC')).toEqual([[8, 14, 1]])
    expect(spans('aaggttccgaattcaaa', 'GAATTC')).toEqual([[8, 14, 1]])
  })

  it('drops whitespace, since a motif is quoted with spaces as often as not', () => {
    expect(compileMotif('GGTCA NNN TGACC')).toEqual(compileMotif('GGTCANNNTGACC'))
  })

  it('names the character it could not read', () => {
    const refused = compileMotif('ACGX')
    expect(isMotifRefusal(refused)).toBe(true)
    if (isMotifRefusal(refused)) expect(refused.reason).toContain('X')
  })

  it('refuses an empty pattern rather than matching everywhere', () => {
    expect(isMotifRefusal(compileMotif(''))).toBe(true)
    expect(isMotifRefusal(compileMotif('   '))).toBe(true)
  })

  it('refuses a query long enough to be somebody wanting an aligner', () => {
    expect(isMotifRefusal(compileMotif('A'.repeat(MOTIF_MAX_LENGTH)))).toBe(false)
    expect(isMotifRefusal(compileMotif('A'.repeat(MOTIF_MAX_LENGTH + 1)))).toBe(true)
  })
})

describe('the degenerate alphabet', () => {
  it('matches every base a code stands for, and no others', () => {
    // R is A or G. The window is one base wide, so the hits are the positions.
    expect(spans('ACGT', 'R')).toEqual([
      [0, 1, 1],
      [2, 3, 1],
    ])
    expect(spans('ACGT', 'Y')).toEqual([
      [1, 2, 1],
      [3, 4, 1],
    ])
    expect(spans('ACGT', 'N').length).toBe(4)
  })

  it('reads U in the reference as T, so an RNA sequence searches the same', () => {
    expect(spans('ACGU', 'ACGT')).toEqual([[0, 4, 1]])
  })

  it('spans a run of Ns in the pattern, which is what a spacer is for', () => {
    expect(spans('ttGGTCAtgaTGACCtt', 'GGTCANNNTGACC')).toEqual([[2, 15, 1]])
  })
})

describe('an ambiguous base in the reference', () => {
  /**
   * The decision this module exists to get right. An `N` in an assembly is a
   * base nobody knows, not a base that is any of four, so it must not satisfy a
   * pattern that names one — otherwise every assembly gap becomes a solid bar of
   * hits, which on a draft genome is most of what the reader would see.
   */
  it('does not satisfy a pattern that names a particular base', () => {
    expect(spans('NNNNNN', 'AAA')).toEqual([])
    expect(spans('ACNGT', 'ACGGT')).toEqual([])
  })

  it('satisfies a pattern position that permits everything', () => {
    expect(spans('ACNGT', 'ACNGT')).toEqual([[0, 5, 1]])
  })

  it('matches a narrower reference code against a wider pattern, never the reverse', () => {
    // Reference R is "A or G"; pattern R permits both, pattern A permits one.
    expect(spans('TRT', 'TRT')).toEqual([[0, 3, 1]])
    expect(spans('TRT', 'TNT')).toEqual([[0, 3, 1]])
    expect(spans('TRT', 'TAT')).toEqual([])
  })

  it('never matches a character that is not a nucleotide at all', () => {
    // A `-` has no bits set; without the non-empty guard it would be a subset of
    // every pattern and so match all of them.
    expect(spans('A-A', 'ANA')).toEqual([])
    expect(spans('A*A', 'ANA')).toEqual([])
  })
})

describe('strands', () => {
  it('finds the reverse strand when asked, and marks it', () => {
    // GGATC has reverse complement GATCC.
    expect(spans('aaGGATCaaGATCCaa', 'GGATC', true)).toEqual([
      [2, 7, 1],
      [9, 14, -1],
    ])
  })

  it('leaves the reverse strand alone when not asked', () => {
    expect(spans('aaGGATCaaGATCCaa', 'GGATC', false)).toEqual([[2, 7, 1]])
  })

  /**
   * A palindrome matches its own reverse complement at the same coordinates, so
   * searching both strands would count every site twice. `strand: 0` says
   * "both", which is a different and truer claim than "the forward one".
   */
  it('reports a palindrome once, on neither strand in particular', () => {
    expect(isPalindromic(motif('GAATTC'))).toBe(true)
    expect(spans('ttGAATTCtt', 'GAATTC', true)).toEqual([[2, 8, 0]])
  })

  /**
   * A forward-only search asked a narrower question, and gets the narrower
   * answer: these are forward-strand hits, whatever the motif reads like
   * backwards.
   */
  it('does not call a palindrome “both” when only one strand was asked for', () => {
    expect(spans('ttGAATTCtt', 'GAATTC', false)).toEqual([[2, 8, 1]])
  })

  it('treats a degenerate palindrome as one too', () => {
    // GGNCC: complement CCNGG, reversed GGNCC.
    expect(isPalindromic(motif('GGNCC'))).toBe(true)
    expect(isPalindromic(motif('GGTCA'))).toBe(false)
  })

  it('reverse-complements the codes, not just the four bases', () => {
    // R (A|G) complements to Y (C|T); W (A|T) is its own complement.
    expect(reverseComplement(motif('RW'))).toEqual(motif('WY'))
    expect(reverseComplement(reverseComplement(motif('ACGTRYKM')))).toEqual(motif('ACGTRYKM'))
  })

  it('orders hits by position, forward before reverse at a shared one', () => {
    // `AC` reverse-complements to `GT`, so it is not a palindrome and the two
    // strands are searched separately — which is what makes a shared position
    // possible at all, and so what makes the order worth asserting.
    const hits = spans('AC', 'AC', true)
    expect(hits[0]?.[2]).toBe(1)
  })
})

describe('overlapping occurrences', () => {
  it('finds them, because for a motif they are real', () => {
    expect(spans('AAA', 'AA')).toEqual([
      [0, 2, 1],
      [1, 3, 1],
    ])
    expect(spans('CACACA', 'CACA')).toEqual([
      [0, 4, 1],
      [2, 6, 1],
    ])
  })
})

describe('bounds and budgets', () => {
  it('finds a hit that ends exactly at the end of the sequence', () => {
    expect(spans('ttACGT', 'ACGT')).toEqual([[2, 6, 1]])
  })

  it('finds nothing in a sequence shorter than the motif', () => {
    expect(spans('AC', 'ACGT')).toEqual([])
    expect(findMotif(new Uint8Array(0), motif('A')).hits).toEqual([])
  })

  it('offsets every coordinate, so a windowed read reports chromosome positions', () => {
    const result = findMotif(bases('ttACGTtt'), motif('ACGT'), { offset: 1_000 })
    expect(result.hits).toEqual([{ start: 1_002, end: 1_006, strand: 1, mismatches: 0 }])
  })

  it('stops at the limit and says that it did', () => {
    const capped = findMotif(bases('AAAAAAAAAA'), motif('A'), { limit: 3 })
    expect(capped.hits.length).toBe(3)
    expect(capped.truncated).toBe(true)

    const complete = findMotif(bases('AAA'), motif('A'), { limit: 3 })
    expect(complete.hits.length).toBe(3)
    expect(complete.truncated).toBe(false)
  })

  /**
   * The number a chunked scan has to carry between windows. One base short of
   * the motif's length is exactly enough: a hit needs at least one base either
   * side of the seam, so a window repeating that many residues sees every hit
   * the seam would otherwise hide.
   */
  it('names the overlap a chunked scan needs, and it is enough', () => {
    const pattern = motif('ACGT')
    expect(motifOverlap(pattern)).toBe(3)

    const genome = 'ttttACGTtttt'
    const cut = 6 // straight through the middle of the hit
    const head = findMotif(bases(genome.slice(0, cut)), pattern, { offset: 0 })
    const overlap = motifOverlap(pattern)
    const from = cut - overlap
    const tail = findMotif(bases(genome.slice(from)), pattern, { offset: from })
    expect([...head.hits, ...tail.hits]).toEqual([{ start: 4, end: 8, strand: 1, mismatches: 0 }])
  })
})

describe('a search that allows mismatches', () => {
  /** Coordinates, strand and how many positions disagreed. */
  function loose(
    text: string,
    pattern: string,
    mismatches: number,
    bothStrands = false,
  ): Array<[number, number, number, number]> {
    return findMotif(bases(text), motif(pattern), { bothStrands, mismatches }).hits.map((hit) => [
      hit.start,
      hit.end,
      hit.strand,
      hit.mismatches,
    ])
  }

  it('is an exact match at a budget of zero, which is the default', () => {
    expect(loose('ttACGTttACGAtt', 'ACGT', 0)).toEqual([[2, 6, 1, 0]])
    expect(spans('ttACGTttACGAtt', 'ACGT')).toEqual([[2, 6, 1]])
  })

  it('finds a site one base off the pattern, and says how far off it was', () => {
    expect(loose('ttACGTttACGAtt', 'ACGT', 1)).toEqual([
      [2, 6, 1, 0],
      [8, 12, 1, 1],
    ])
  })

  /**
   * `N` in the pattern permits every base, so it can never be where a mismatch
   * is spent — which is what makes a consensus with a free position mean the
   * same thing at every budget.
   */
  it('never charges a mismatch for an N in the pattern', () => {
    expect(loose('ACGT', 'ANGT', 0)).toEqual([[0, 4, 1, 0]])
    expect(loose('ACGT', 'ANGA', 1)).toEqual([[0, 4, 1, 1]])
  })

  /** An assembly gap is not a base that happens to be any of four (§8.3). */
  it('charges a reference N against a pattern base, as an exact search refuses it', () => {
    expect(loose('ACNT', 'ACGT', 0)).toEqual([])
    expect(loose('ACNT', 'ACGT', 1)).toEqual([[0, 4, 1, 1]])
  })

  it('never lets the budget reach the whole motif, which would match everywhere', () => {
    // A budget of the pattern's length would accept any window; it is held one
    // short, so a two-base motif may be one base wrong and no more.
    expect(loose('TT', 'AA', 5)).toEqual([])
    expect(loose('AT', 'AA', 5)).toEqual([[0, 2, 1, 1]])
  })

  /**
   * The case the budget exists for. `parS`, the bacterial centromere, is a
   * 16-base palindromic consensus; a palindrome is still one site per place, and
   * a variant one base off the consensus is found where an exact search misses
   * it.
   */
  it('finds a degenerate palindrome once per site, exact or one base off', () => {
    const parS = 'TGTTNCACGTGNAACA'
    const exact = 'TGTTCCACGTGGAACA'
    const variant = 'TGTTCCACGTGGATCA' // one base off, at the fourteenth position
    const genome = `aaaa${exact}aaaaaaaa${variant}aaaa`
    expect(loose(genome, parS, 0, true)).toEqual([[4, 20, 0, 0]])
    expect(loose(genome, parS, 1, true)).toEqual([
      [4, 20, 0, 0],
      [28, 44, 0, 1],
    ])
  })
})
