/**
 * The restriction library on cases small enough to check by hand
 * (`src/genome/restriction.ts`).
 *
 * `restriction-golden.test.ts` holds the same functions to bioframe and to
 * `pairtools restrict` over a yeast genome and a fixture of thirty thousand
 * pairs; what is here is every rule of the shared definitions on a sequence a
 * reader can count along — so a failure says which rule broke, where the golden
 * would say only that a number moved.
 *
 * The part most worth reading is the bottom strand. A `-` read's 5′ end is the
 * bottom strand's, which DpnII cuts four bases after the top, and placed by the
 * top-strand cut the `-` read of every DpnII dangling end fell in the next
 * fragment and the pair read as a re-ligation. Each of DpnII, HinfI and NlaIII
 * — a 5′ overhang of four, one of three, and a 3′ overhang — has its dangling
 * end here, placed where the reads of one actually start.
 */

import { describe, expect, it } from 'vitest'

import { cutFeatures } from '@/analysis/run/restriction'
import { compileMotif, isMotifRefusal, isPalindromic } from '@/annotations/motif'
import type { TaskResult } from '@/analysis/types'
import {
  ENZYMES,
  KITS,
  PAIR_CLASSES,
  RestrictionCounter,
  boundaries,
  bottomShift,
  classify,
  contigCuts,
  cutsIn,
  cutsOfResult,
  enzymeByName,
  enzymeLabel,
  enzymeNamed,
  enzymesFor,
  fragmentOf,
  siteOverlap,
  siteText,
  type CutSites,
  type Enzyme,
  type RestrictionStats,
} from '@/genome/restriction'
import { distEdges } from '@/pairs/stats'

const bytes = (text: string): Uint8Array => Uint8Array.from(text, (letter) => letter.charCodeAt(0))

/** A run of `A` of `length` with each site written in at its position. */
function sequence(length: number, sites: ReadonlyArray<[number, string]>): Uint8Array {
  const out = new Uint8Array(length).fill('A'.charCodeAt(0))
  for (const [at, site] of sites) out.set(bytes(site), at)
  return out
}

function preset(name: string): Enzyme {
  const enzyme = enzymeByName(name)
  if (enzyme === undefined) throw new Error(`no preset ${name}`)
  return enzyme
}

function enzymes(choice: string, sites = ''): Enzyme[] {
  const out = enzymesFor(choice, sites)
  if (!Array.isArray(out)) throw new Error(out.refusal)
  return out
}

/** One sequence's cuts, as the runner makes them: one piece, merged and trimmed to the sequence. */
function cutsOf(bases: Uint8Array, list: readonly Enzyme[]): CutSites {
  return contigCuts([cutsIn(bases, list)], bases.length)
}

const plain = (sites: CutSites): { top: number[]; bottom: number[] } => ({
  top: Array.from(sites.top),
  bottom: Array.from(sites.bottom),
})

describe('the enzyme table', () => {
  it('writes every site in IUPAC letters, as a palindrome, with the cut inside it', () => {
    for (const enzyme of ENZYMES) {
      const motif = compileMotif(enzyme.site)
      expect(isMotifRefusal(motif), enzyme.name).toBe(false)
      if (!isMotifRefusal(motif)) expect(isPalindromic(motif), enzyme.name).toBe(true)
      expect(enzyme.cut, enzyme.name).toBeGreaterThanOrEqual(0)
      expect(enzyme.cut, enzyme.name).toBeLessThanOrEqual(enzyme.site.length)
      expect(enzyme.site, enzyme.name).toBe(enzyme.site.toUpperCase())
    }
  })

  it('writes a site with its ^ where the top strand is cut', () => {
    expect(siteText(preset('DpnII'))).toBe('^GATC')
    expect(siteText(preset('HinfI'))).toBe('G^ANTC')
    expect(siteText(preset('NlaIII'))).toBe('CATG^')
    expect(siteText(preset('AluI'))).toBe('AG^CT')
  })

  it('cuts the bottom strand L - 2k past the top', () => {
    expect(bottomShift(preset('DpnII'))).toBe(4)
    expect(bottomShift(preset('HinfI'))).toBe(3)
    expect(bottomShift(preset('NlaIII'))).toBe(-4)
    expect(bottomShift(preset('AluI'))).toBe(0)
    expect(bottomShift(preset('HindIII'))).toBe(4)
  })

  it('answers to its aliases, in any case', () => {
    expect(enzymeByName('MboI')).toBe(preset('DpnII'))
    expect(enzymeByName('sau3ai')).toBe(preset('DpnII'))
    expect(enzymeByName('CSP6I')).toBe(preset('CviQI'))
    expect(enzymeByName('dpnii')).toBe(preset('DpnII'))
    expect(enzymeByName('EcoRV')).toBeUndefined()
  })

  it('names the Arima kit’s two enzymes, both in the table', () => {
    expect(KITS.Arima).toEqual(['DpnII', 'HinfI'])
    for (const name of KITS.Arima) expect(enzymeByName(name)?.name).toBe(name)
  })
})

describe('enzymesFor', () => {
  it('reads none as no restriction step, without a refusal', () => {
    expect(enzymesFor('none', '')).toEqual([])
    expect(enzymesFor('', 'DpnII')).toEqual([])
  })

  it('reads a preset, an alias and a kit', () => {
    expect(enzymes('DpnII')).toEqual([preset('DpnII')])
    expect(enzymes('MboI')).toEqual([preset('DpnII')])
    expect(enzymes('Arima')).toEqual([preset('DpnII'), preset('HinfI')])
    expect(enzymes('arima')).toEqual([preset('DpnII'), preset('HinfI')])
  })

  it('reads typed sites and names, by commas or spaces, an enzyme named twice cut once', () => {
    expect(enzymes('custom', 'mboi, HinfI')).toEqual([preset('DpnII'), preset('HinfI')])
    expect(enzymes('custom', 'DpnII MboI  Sau3AI')).toEqual([preset('DpnII')])
    expect(enzymes('custom', 'g^antc')).toEqual([{ name: 'G^ANTC', site: 'GANTC', cut: 1 }])
    expect(enzymes('custom', '^GATC, CATG^')).toEqual([
      { name: '^GATC', site: 'GATC', cut: 0 },
      { name: 'CATG^', site: 'CATG', cut: 4 },
    ])
    expect(enzymes('custom', 'Arima, MseI')).toEqual([preset('DpnII'), preset('HinfI'), preset('MseI')])
  })

  it('refuses a site with no ^, saying where the cut is needed', () => {
    const out = enzymesFor('custom', 'GATC')
    expect(Array.isArray(out)).toBe(false)
    if (!Array.isArray(out)) {
      expect(out.refusal).toContain('“GATC”')
      expect(out.refusal).toMatch(/needs a \^ where the enzyme cuts the top strand/)
    }
  })

  it('refuses a name it does not know, two cuts in one site, a letter that is not IUPAC', () => {
    const refusal = (sites: string): string => {
      const out = enzymesFor('custom', sites)
      return Array.isArray(out) ? '' : out.refusal
    }
    expect(refusal('EcoRV')).toMatch(/neither an enzyme this knows nor a site/)
    expect(refusal('G^A^TC')).toMatch(/more than one \^/)
    expect(refusal('G^AXTC')).toMatch(/IUPAC/)
    expect(refusal('')).toMatch(/Type an enzyme or a site/)
    // A site that cuts every sixteen bases is not a restriction map.
    expect(refusal('^GA')).toMatch(/four-base cutter/)
    // And the first bad item is what is said, whatever comes before it.
    expect(refusal('DpnII, GATC')).toContain('“GATC”')
  })

  it('refuses a choice that is no preset and no kit', () => {
    const out = enzymesFor('EcoRV', '')
    expect(Array.isArray(out) ? '' : out.refusal).toMatch(/not an enzyme or a kit/)
  })

  it('labels a set by its names', () => {
    expect(enzymeLabel(enzymes('DpnII'))).toBe('DpnII')
    expect(enzymeLabel(enzymes('Arima'))).toBe('DpnII+HinfI')
    expect(enzymeLabel(enzymes('custom', 'G^ANTC'))).toBe('G^ANTC')
    expect(enzymeLabel([])).toBe('')
  })

  it('reads a name back, a typed site included', () => {
    expect(enzymeNamed('DpnII')).toBe(preset('DpnII'))
    expect(enzymeNamed('G^ANTC')).toEqual({ name: 'G^ANTC', site: 'GANTC', cut: 1 })
    expect(enzymeNamed('nothing')).toBeUndefined()
  })
})

describe('cutsIn', () => {
  it('cuts the top strand k bases into the site, and the bottom strand L - k', () => {
    // GATC at 5 and 24; GAATC at 5 and 24; CATG at 5 and 24.
    expect(plain(cutsOf(sequence(40, [[5, 'GATC'], [24, 'GATC']]), [preset('DpnII')]))).toEqual({
      top: [5, 24],
      bottom: [9, 28],
    })
    expect(plain(cutsOf(sequence(40, [[5, 'GAATC'], [24, 'GACTC']]), [preset('HinfI')]))).toEqual({
      top: [6, 25],
      bottom: [9, 28],
    })
    expect(plain(cutsOf(sequence(40, [[5, 'CATG'], [24, 'CATG']]), [preset('NlaIII')]))).toEqual({
      top: [9, 28],
      bottom: [5, 24],
    })
    expect(plain(cutsOf(sequence(40, [[5, 'AGCT']]), [preset('AluI')]))).toEqual({ top: [7], bottom: [7] })
  })

  it('adds the offset, so a piece’s cuts are its sequence’s', () => {
    const piece = cutsIn(sequence(20, [[3, 'GATC']]), [preset('DpnII')], 1000)
    expect(Array.from(piece.top)).toEqual([1003])
    expect(Array.from(piece.bottom)).toEqual([1007])
  })

  it('finds overlapping sites, lower case, and an N in the reference only against an N', () => {
    // GATCGATC: two DpnII sites sharing nothing but a seam.
    expect(Array.from(cutsOf(bytes('AAGATCGATCAA'), [preset('DpnII')]).top)).toEqual([2, 6])
    expect(Array.from(cutsOf(bytes('aagatcaa'), [preset('DpnII')]).top)).toEqual([2])
    // GNTC is not GATC: a base nobody knows does not satisfy a pattern naming one.
    expect(cutsOf(bytes('AAGNTCAA'), [preset('DpnII')]).top.length).toBe(0)
    // GANTC's N matches the reference's N, as Biopython's GA.TC does.
    expect(Array.from(cutsOf(bytes('AAGANTCAA'), [preset('HinfI')]).top)).toEqual([3])
  })

  it('merges several enzymes into one set of boundaries, in the order of the top cut', () => {
    const bases = sequence(40, [[5, 'GATC'], [15, 'GAATC'], [30, 'GATC']])
    const both = cutsOf(bases, enzymes('Arima'))
    expect(plain(both)).toEqual({ top: [5, 16, 30], bottom: [9, 19, 34] })
    // Which enzyme made each cut, by its place in the list.
    expect(Array.from(both.enzyme)).toEqual([0, 1, 0])
  })

  it('cuts a typed site that is not a palindrome at s + k on either strand', () => {
    // CACGAG forwards at 4, its reverse complement CTCGTG at 20: BssSI cuts the
    // top strand after the first base of the site on both, which is where
    // Biopython reports it, and the bottom symmetrically.
    const site = enzymes('custom', 'C^ACGAG')
    const cut = cutsOf(sequence(40, [[4, 'CACGAG'], [20, 'CTCGTG']]), site)
    expect(plain(cut)).toEqual({ top: [5, 21], bottom: [9, 25] })
  })

  it('drops a cut at the first base or at the end, and keeps one a base inside', () => {
    // ^GATC at 0 cuts at 0, which is no fragment; CATG^ at the end cuts at the end.
    expect(cutsOf(bytes('GATCAAAA'), [preset('DpnII')]).top.length).toBe(0)
    expect(cutsOf(bytes('AAAACATG'), [preset('NlaIII')]).top.length).toBe(0)
    expect(Array.from(cutsOf(bytes('AGATCAAA'), [preset('DpnII')]).top)).toEqual([1])
    // CATG at 0 cuts the top strand at 4, inside, and the bottom at 0: kept.
    expect(plain(cutsOf(bytes('CATGAAAA'), [preset('NlaIII')]))).toEqual({ top: [4], bottom: [0] })
  })

  it('finds every site once across pieces that overlap by the longest site less one', () => {
    const bases = sequence(64, [[2, 'GATC'], [11, 'GAATC'], [29, 'GATC'], [30, 'ATCC'], [58, 'GAGTC']])
    const list = enzymes('Arima')
    const whole = cutsOf(bases, list)
    expect(siteOverlap(list)).toBe(4)
    for (let step = 1; step <= bases.length; step++) {
      const pieces: CutSites[] = []
      for (let from = 0; from < bases.length; from += step) {
        const end = Math.min(bases.length, from + step + siteOverlap(list))
        pieces.push(cutsIn(bases.subarray(from, end), list, from))
      }
      const merged = contigCuts(pieces, bases.length)
      expect(plain(merged), `pieces of ${step}`).toEqual(plain(whole))
      expect(Array.from(merged.enzyme), `pieces of ${step}`).toEqual(Array.from(whole.enzyme))
    }
  })
})

describe('boundaries and fragmentOf', () => {
  const cuts = Int32Array.from([5, 24])

  it('frames the cuts with the sequence’s two ends', () => {
    expect(Array.from(boundaries(cuts, 40))).toEqual([0, 5, 24, 40])
    expect(Array.from(boundaries(new Int32Array(0), 40))).toEqual([0, 40])
  })

  it('keeps one strand’s boundaries in order when two overhangs run opposite ways', () => {
    // DpnII's GATC at 2 cuts the bottom at 6; NlaIII's CATG at 5 cuts the top
    // at 9 and the bottom at 5. In the order of the top cut, the bottom goes back.
    const both = cutsOf(bytes('AAGATCATGAA'), enzymes('custom', 'DpnII NlaIII'))
    expect(plain(both)).toEqual({ top: [2, 9], bottom: [6, 5] })
    expect(Array.from(boundaries(both.bottom, 11))).toEqual([0, 6, 6, 11])
  })

  it('puts a position at a cut in the fragment to its right', () => {
    const bounds = boundaries(cuts, 40)
    expect(fragmentOf(bounds, 0)).toBe(0)
    expect(fragmentOf(bounds, 4)).toBe(0)
    expect(fragmentOf(bounds, 5)).toBe(1)
    expect(fragmentOf(bounds, 23)).toBe(1)
    expect(fragmentOf(bounds, 24)).toBe(2)
    expect(fragmentOf(bounds, 39)).toBe(2)
  })

  it('clamps outside the sequence, as pairtools restrict does', () => {
    const bounds = boundaries(cuts, 40)
    // A pos of 0 is x = -1, and pairtools puts it in the first fragment.
    expect(fragmentOf(bounds, -1)).toBe(0)
    expect(fragmentOf(bounds, 40)).toBe(2)
    expect(fragmentOf(bounds, 1000)).toBe(2)
    expect(fragmentOf(boundaries(new Int32Array(0), 40), 17)).toBe(0)
  })
})

describe('classify', () => {
  it('names each class by the rules', () => {
    expect(classify(false, 3, '+', 3, '-')).toBe('trans')
    expect(classify(true, 3, '+', 3, '-')).toBe('dangling')
    expect(classify(true, 3, '-', 3, '+')).toBe('self-circle')
    expect(classify(true, 3, '+', 3, '+')).toBe('same-strand')
    expect(classify(true, 3, '-', 3, '-')).toBe('same-strand')
    expect(classify(true, 3, '+', 4, '-')).toBe('re-ligation')
    expect(classify(true, 3, '-', 4, '+')).toBe('valid')
    expect(classify(true, 3, '+', 4, '+')).toBe('valid')
    expect(classify(true, 3, '+', 5, '-')).toBe('valid')
  })
})

// ---------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------

type Record7 = [string, number, string, string, number, string, boolean]

/** A counter over one or two sequences cut by `list`, fed `records` with 1-based positions. */
function count(
  reference: ReadonlyArray<[string, Uint8Array]>,
  list: readonly Enzyme[],
  records: readonly Record7[],
): RestrictionStats {
  const cuts = new Map(reference.map(([name, bases]) => [name, cutsOf(bases, list)]))
  const lengths = new Map(reference.map(([name, bases]) => [name, bases.length]))
  const counter = new RestrictionCounter(cuts, lengths, enzymeLabel(list))
  for (const record of records) counter.add(...record)
  return counter.result()
}

/** The only class with a count, and the orientation it was counted under. */
function only(stats: RestrictionStats): string {
  const named = PAIR_CLASSES.filter((name) => stats.classes[name] > 0)
  return named
    .map((name) => {
      const orientation = Object.entries(stats.byOrientation[name]).find(([, n]) => n > 0)?.[0]
      return `${name} ${orientation}`
    })
    .join(', ')
}

/** The distance bin `d` falls in. */
function binOf(d: number): number {
  const edges = distEdges()
  let at = 0
  while (at + 1 < edges.length && edges[at + 1] <= d) at++
  return at
}

describe('a dangling end, placed by the strand each read starts on', () => {
  // Two sites, at 5 and 24, on a sequence of 40: fragment 1 is between them.
  it('is dangling for DpnII: + at the top cut, - three bases past the next', () => {
    const bases = sequence(40, [[5, 'GATC'], [24, 'GATC']])
    // The + read starts at the first base after the top cut (x = 5); the -
    // read's 5′ end is the last base before the bottom cut, s1 + 3 = 27.
    const stats = count([['chrT', bases]], [preset('DpnII')], [['chrT', 6, '+', 'chrT', 28, '-', false]])
    expect(only(stats)).toBe('dangling +-')
    // Both reads give the fragment's length, 24 - 5.
    expect(stats.distance['+'][binOf(19)]).toBe(1)
    expect(stats.distance['-'][binOf(19)]).toBe(1)
  })

  it('would have read as a re-ligation by the top-strand cut alone', () => {
    // The same two reads, against boundaries that place both by the top cut:
    // the - read at 27 is past 24, in the next fragment.
    const top = boundaries(Int32Array.from([5, 24]), 40)
    expect(classify(true, fragmentOf(top, 5), '+', fragmentOf(top, 27), '-')).toBe('re-ligation')
  })

  it('is dangling for HinfI: + at s0 + 1, - at s1 + 3', () => {
    const bases = sequence(40, [[5, 'GAATC'], [24, 'GATTC']])
    const stats = count([['chrT', bases]], [preset('HinfI')], [['chrT', 7, '+', 'chrT', 28, '-', false]])
    expect(only(stats)).toBe('dangling +-')
    expect(stats.distance['+'][binOf(19)]).toBe(1)
    expect(stats.distance['-'][binOf(19)]).toBe(1)
  })

  it('is dangling for NlaIII: + at s0 + 4, - at s1 - 1', () => {
    const bases = sequence(40, [[5, 'CATG'], [24, 'CATG']])
    const stats = count([['chrT', bases]], [preset('NlaIII')], [['chrT', 10, '+', 'chrT', 24, '-', false]])
    expect(only(stats)).toBe('dangling +-')
    expect(stats.distance['+'][binOf(19)]).toBe(1)
    expect(stats.distance['-'][binOf(19)]).toBe(1)
  })
})

describe('the other classes', () => {
  // DpnII at 5 and 24: top boundaries [0, 5, 24, 40], bottom [0, 9, 28, 40].
  const bases = sequence(40, [[5, 'GATC'], [24, 'GATC']])
  const one = (record: Record7): string => only(count([['chrT', bases]], [preset('DpnII')], [record]))

  it('reads neighbouring fragments read towards each other as a re-ligation', () => {
    expect(one(['chrT', 3, '+', 'chrT', 16, '-', false])).toBe('re-ligation +-')
  })

  it('reads one fragment read away from itself as a self-circle', () => {
    expect(one(['chrT', 21, '+', 'chrT', 13, '-', false])).toBe('self-circle -+')
  })

  it('reads one fragment on one strand as same-strand', () => {
    expect(one(['chrT', 11, '+', 'chrT', 21, '+', false])).toBe('same-strand ++')
    expect(one(['chrT', 21, '-', 'chrT', 11, '-', false])).toBe('same-strand --')
  })

  it('reads anything further apart as valid, by the strands in position order', () => {
    expect(one(['chrT', 3, '+', 'chrT', 36, '-', false])).toBe('valid +-')
    expect(one(['chrT', 36, '+', 'chrT', 3, '-', false])).toBe('valid -+')
  })

  it('keeps the file’s order on a tie', () => {
    expect(one(['chrT', 11, '-', 'chrT', 11, '+', false])).toBe('self-circle -+')
    expect(one(['chrT', 11, '+', 'chrT', 11, '-', false])).toBe('dangling +-')
  })

  it('reads two sequences as trans, by the strands in the file’s order', () => {
    const stats = count(
      [
        ['chrT', bases],
        ['chrU', bases],
      ],
      [preset('DpnII')],
      [['chrU', 36, '-', 'chrT', 3, '+', false]],
    )
    expect(only(stats)).toBe('trans -+')
  })
})

describe('which pairs count', () => {
  const bases = sequence(40, [[5, 'GATC'], [24, 'GATC']])

  it('leaves out duplicates and unmapped ends, and counts the rest', () => {
    const stats = count(
      [['chrT', bases]],
      [preset('DpnII')],
      [
        ['chrT', 3, '+', 'chrT', 36, '-', false],
        ['chrT', 3, '+', 'chrT', 36, '-', true],
        ['!', 0, '-', 'chrT', 36, '-', false],
        ['chrT', 3, '+', '!', 0, '-', false],
        ['chrT', 3, '.', 'chrT', 36, '-', false],
      ],
    )
    expect(stats.counted).toBe(1)
    expect(stats.unassigned).toBe(0)
  })

  it('counts a pair with an end the reference has not got as unassigned, a duplicate not at all', () => {
    const stats = count(
      [['chrT', bases]],
      [preset('DpnII')],
      [
        ['chrT', 3, '+', 'mito', 36, '-', false],
        ['mito', 3, '+', 'mito', 36, '-', false],
        ['mito', 3, '+', 'chrT', 36, '-', true],
      ],
    )
    expect(stats.counted).toBe(0)
    expect(stats.unassigned).toBe(2)
    expect(PAIR_CLASSES.every((name) => stats.classes[name] === 0)).toBe(true)
  })

  it('finds a sequence by the reference’s spelling of it', () => {
    const cuts = new Map([['chr1', cutsOf(bases, [preset('DpnII')])]])
    const counter = new RestrictionCounter(cuts, new Map([['1', 40]]), 'DpnII')
    counter.add('1', 3, '+', '1', 36, '-', false)
    counter.add('chr1', 3, '+', 'chr1', 36, '-', false)
    expect(counter.result().counted).toBe(2)
    expect(counter.result().fragments.total).toBe(3)
  })

  it('leaves a sequence with no length out of the reference', () => {
    const cuts = new Map([['chrT', cutsOf(bases, [preset('DpnII')])]])
    const counter = new RestrictionCounter(cuts, new Map(), 'DpnII')
    counter.add('chrT', 3, '+', 'chrT', 36, '-', false)
    expect(counter.result()).toMatchObject({ counted: 0, unassigned: 1, fragments: { total: 0 } })
  })
})

describe('the distances and the fragments seen', () => {
  const bases = sequence(40, [[5, 'GATC'], [24, 'GATC']])

  it('measures each end to the next cut in its direction, inclusive of its 5′ base', () => {
    // + at x = 2 in [0, 5): 3. - at x = 30 in [28, 40) on the bottom: 3.
    const stats = count([['chrT', bases]], [preset('DpnII')], [['chrT', 3, '+', 'chrT', 31, '-', false]])
    expect(stats.distance['+'][binOf(3)]).toBe(1)
    expect(stats.distance['-'][binOf(3)]).toBe(1)
    // - at x = 9, the bottom cut itself: one base, its own.
    const edge = count([['chrT', bases]], [preset('DpnII')], [['chrT', 3, '+', 'chrT', 10, '-', false]])
    expect(edge.distance['-'][binOf(1)]).toBe(1)
    expect(stats.distanceEdges).toEqual(distEdges())
  })

  it('counts both ends of every counted pair, trans included, by their own strand', () => {
    const stats = count(
      [
        ['chrT', bases],
        ['chrU', bases],
      ],
      [preset('DpnII')],
      [
        ['chrT', 6, '+', 'chrT', 28, '-', false],
        ['chrT', 6, '+', 'chrT', 28, '-', false],
        ['chrT', 3, '+', 'chrU', 36, '-', false],
        ['chrT', 3, '+', 'chrT', 36, '-', true],
      ],
    )
    const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)
    expect(sum(stats.distance['+']) + sum(stats.distance['-'])).toBe(2 * stats.counted)
    // chrT: fragment 0 holds one end, fragment 1 four (two dangling pairs),
    // fragment 2 none; chrU: fragment 2 one.
    expect(stats.fragments).toEqual({
      total: 6,
      seen: 3,
      binLabels: ['0', '1', '2', '3–4'],
      counts: [3, 2, 0, 1],
    })
  })

  it('labels the bins of ends per fragment by powers of two', () => {
    const records: Record7[] = []
    // Nine pairs dangling in fragment 1: eighteen ends, the bin 17–32.
    for (let i = 0; i < 9; i++) records.push(['chrT', 6, '+', 'chrT', 28, '-', false])
    const stats = count([['chrT', bases]], [preset('DpnII')], records)
    expect(stats.fragments.binLabels).toEqual(['0', '1', '2', '3–4', '5–8', '9–16', '17–32'])
    expect(stats.fragments.counts).toEqual([2, 0, 0, 0, 0, 0, 1])
    expect(stats.enzymes).toBe('DpnII')
  })
})

// ---------------------------------------------------------------------------
// A run, read back
// ---------------------------------------------------------------------------

describe('cutsOfResult', () => {
  it('gives back both strands of a kit’s cuts, and a sequence with none', () => {
    const list = enzymes('Arima')
    const bases = sequence(40, [[5, 'GATC'], [15, 'GAATC'], [30, 'GATC']])
    const cut = [
      { contig: 'chrT', length: 40, cuts: cutsOf(bases, list) },
      { contig: 'chrEmpty', length: 12, cuts: cutsOf(sequence(12, []), list) },
    ]
    const result: TaskResult = {
      outputs: [
        {
          kind: 'intervals',
          id: 'restriction-Arima',
          label: 'Arima (DpnII+HinfI) sites',
          payload: { kind: 'features', data: cutFeatures(cut, list) },
        },
      ],
      provenance: {
        task: 'restriction',
        taskVersion: 1,
        params: { enzyme: 'Arima' },
        framing: {
          uri: 'x',
          label: 'x',
          binsize: 0,
          binsPerCell: 1,
          rows: [0, 0],
          cols: [0, 0],
          balance: false,
          value: '',
          normalise: null,
          level: 'bin',
        },
        app: 'test',
        createdAt: '',
      },
      notes: [],
      ms: 0,
    }
    const back = cutsOfResult(result)
    expect(back === null ? [] : [...back.keys()]).toEqual(['chrT', 'chrEmpty'])
    expect(plain(back?.get('chrT') as CutSites)).toEqual({ top: [5, 16, 30], bottom: [9, 19, 34] })
    expect(back?.get('chrEmpty')?.top.length).toBe(0)
    expect(cutsOfResult({ ...result, outputs: [] })).toBeNull()
  })
})
