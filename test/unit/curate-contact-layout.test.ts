// @dev-feature curate
/**
 * The contact map's arithmetic (SPECS §33.3): the genome map's axis and cells —
 * MAGs then elements, a pair at the lower bound of its affinity, a genome's own
 * cell at 1 — the close-up's contigs and its candidates, the view a framed run
 * puts on screen, and the words and ticks the readout and the key print.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { lowerAffinity } from '../../src/curate/method'
import type { Suggestion } from '../../src/curate/suggest'
import {
  affinityText,
  affinityTicks,
  CANDIDATES_MOST,
  candidatesFor,
  cellMapOf,
  clampView,
  closeUpAxis,
  centredView,
  FALLBACK_BACKGROUND,
  genomeAxis,
  genomeMap,
  isIdentity,
  lengthShare,
  pairOf,
  placeLabels,
  ratioText,
  ratioTicks,
  runsOf,
  sameUnits,
  spanAt,
} from '../../src/curate/ui/contactLayout'
import { encode, triangleIndex } from '../../src/metacooler/picture'
import { community } from '../support/curateCommunity'

/** The community's answer as the file bins it: X1, X2, Y, Z (MAGs), P (an element), u0 unbinned. */
function answer() {
  const { base, evidence } = community()
  return { base, evidence, answer: stateAnswer(evidence, CuratedBinning.of(base, null)) }
}

describe('the genome map', () => {
  it('lays the genomes out in the stage’s order, MAGs ahead of the elements, a genome it does not know after its kind', () => {
    const genomes = [
      { id: 'A', kind: 'mag' as const },
      { id: 'E', kind: 'element' as const },
      { id: 'B', kind: 'mag' as const },
      { id: 'new', kind: 'mag' as const },
      { id: 'F', kind: 'element' as const },
    ]
    const axis = genomeAxis(genomes, ['F', 'B', 'E', 'A', 'gone'])
    expect(Array.from(axis.genomes, (g) => genomes[g].id)).toEqual(['B', 'A', 'new', 'F', 'E'])
    expect(axis.mags).toBe(3)
    expect(Array.from(axis.slotOf)).toEqual([1, 4, 0, 2, 3])
  })

  it('holds a pair at the lower bound of its affinity, and every genome’s own cell at 1', () => {
    const { answer: a, evidence } = answer()
    const axis = genomeAxis(a.genomes, a.genomes.map((genome) => genome.id))
    const map = genomeMap(a, axis, evidence.background.rho)
    const level = map.levels[0]
    expect(map.n).toBe(5)
    expect(level.cells[triangleIndex(2, 2, 5)]).toBe(encode(1, map.q))
    // X1 × X2: 540 contacts at affinity 1.5, drawn at what 540 contacts vouch for.
    const k = pairOf(map, a.genomes.length, 1, 0)
    expect(a.pairs.contacts[k]).toBe(540)
    expect(level.cells[triangleIndex(0, 1, 5)]).toBe(encode(lowerAffinity(a.pairs.affinity[k], 540), map.q))
    // A pair resting on one contact is drawn far paler than its ratio.
    const lone = pairOf(map, a.genomes.length, 0, 3)
    expect(a.pairs.contacts[lone]).toBe(1)
    expect(level.cells[triangleIndex(0, 3, 5)]).toBe(encode(lowerAffinity(a.pairs.affinity[lone], 1), map.q))
    expect(level.cells[triangleIndex(0, 3, 5)]).toBeLessThan(encode(a.pairs.affinity[lone], map.q))
    // The scale: a decade under the background at its foot, saturating at 2, its top at 3.
    expect(map.q.low).toBeCloseTo(Math.log10(evidence.background.rho) - 1, 12)
    expect(map.q.high).toBeCloseTo(Math.log10(3), 12)
    expect(map.vmin).toBeCloseTo(Math.log10(evidence.background.rho), 12)
    expect(map.vmax).toBeCloseTo(Math.log10(2), 12)
    expect(pairOf(map, a.genomes.length, 2, 2)).toBe(-1)
  })

  it('draws the cells in the axis’s slots, whatever the answer’s order', () => {
    const { answer: a, evidence } = answer()
    const axis = genomeAxis(a.genomes, ['P', 'Z', 'Y', 'X2', 'X1'])
    expect(Array.from(axis.genomes)).toEqual([3, 2, 1, 0, 4])
    const map = genomeMap(a, axis, evidence.background.rho)
    // X1 × X2 is slots 3 and 2 now.
    const k = pairOf(map, a.genomes.length, 0, 1)
    expect(map.levels[0].cells[triangleIndex(2, 3, 5)]).toBe(encode(lowerAffinity(a.pairs.affinity[k], a.pairs.contacts[k]), map.q))
  })

  it('is empty before the contacts are read, and scaled from a stand-in background', () => {
    const { answer: a } = answer()
    const axis = genomeAxis(a.genomes, [])
    const map = genomeMap({ ...a, counted: false }, axis, null)
    expect(map.levels[0].cells.every((byte) => byte === 0)).toBe(true)
    expect(map.background).toBe(FALLBACK_BACKGROUND)
  })
})

describe('the close-up', () => {
  it('lays each genome’s contigs longest first, then the candidates it does not hold', () => {
    const binning = {
      genomeOf: Int32Array.from([0, 1, 0, 0, -1, 1, -1]),
      genomes: [{ id: 'A' }, { id: 'B' }],
    }
    const lengths = [100, 500, 300, 300, 50, 20, 900]
    const axis = closeUpAxis(binning, ['B', 'A'], lengths, [6, 1, 4, 6, -1])
    // B: 1 (500), 5 (20); A: 2 and 3 tied at 300, in the file's order, then 0; then 6 and 4.
    expect(Array.from(axis.contigs)).toEqual([1, 5, 2, 3, 0, 6, 4])
    expect(axis.spans).toEqual([
      { id: 'B', from: 0, to: 2 },
      { id: 'A', from: 2, to: 5 },
      { id: null, from: 5, to: 7 },
    ])
    expect(spanAt(axis.spans, 0)).toBe(0)
    expect(spanAt(axis.spans, 4)).toBe(1)
    expect(spanAt(axis.spans, 6)).toBe(2)
    expect(spanAt(axis.spans, 7)).toBe(-1)
  })

  it('takes as candidates the contigs an offered recruit or move would bring in, the surest first', () => {
    const { answer: a } = answer()
    const offered = a.suggestions
    // Into X1: u0's recruit; y5's move goes out of X1, to Y.
    expect(candidatesFor(a, offered, new Set(['X1']))).toEqual([18])
    // Into Y: y5, from X1.
    expect(candidatesFor(a, offered, new Set(['Y']))).toEqual([3])
    // A contig already among the genomes shown is no candidate.
    expect(candidatesFor(a, offered, new Set(['X1', 'Y']))).toEqual([18])
    const many: Suggestion[] = Array.from({ length: CANDIDATES_MOST + 5 }, (_, k) => ({
      ...offered.find((s) => s.kind === 'recruit')!,
      key: `r${k}`,
      contigs: [1000 + k],
      confidence: k / 1000,
    }))
    const genomeOf = new Int32Array(2000).fill(-1)
    const out = candidatesFor({ genomeOf, genomes: a.genomes }, many, new Set(['X1']))
    expect(out).toHaveLength(CANDIDATES_MOST)
    expect(out[0]).toBe(1000 + CANDIDATES_MOST + 4)
  })

  it('reads a picture held in another order through a map, and only its own order through its pyramid', () => {
    expect(Array.from(cellMapOf([5, 3, 9, 4], [3, 4, 5]))).toEqual([2, 0, -1, 1])
    expect(isIdentity(cellMapOf([3, 4, 5], [3, 4, 5]), 3)).toBe(true)
    expect(isIdentity(cellMapOf([3, 5, 4], [3, 4, 5]), 3)).toBe(false)
    expect(sameUnits([1, 2], Int32Array.from([1, 2]))).toBe(true)
    expect(sameUnits([1, 2], [2, 1])).toBe(false)
    expect(sameUnits(null, [1])).toBe(false)
    expect(runsOf([7, 3, 4, 5, 9, 4])).toEqual([
      [3, 6],
      [7, 8],
      [9, 10],
    ])
  })

  it('draws a contig’s block as tall as its length on a log scale', () => {
    expect(lengthShare(1000, 1000, 100_000)).toBe(0)
    expect(lengthShare(100_000, 1000, 100_000)).toBe(1)
    expect(lengthShare(10_000, 1000, 100_000)).toBeCloseTo(0.5, 12)
    expect(lengthShare(500, 500, 500)).toBe(1)
  })
})

describe('the view', () => {
  it('stays inside the axis and no narrower than its least', () => {
    expect(clampView(-2, 3, 10, 3)).toEqual([0, 5])
    expect(clampView(8, 12, 10, 3)).toEqual([6, 10])
    expect(clampView(4, 5, 10, 3)).toEqual([4, 7])
    expect(clampView(-5, 50, 10, 3)).toEqual([0, 10])
  })

  it('centres a run, as wide as the view or as the run and some room need, and inside the axis', () => {
    expect(centredView(10, 50, 52, 100, 3)).toEqual([46, 56])
    expect(centredView(10, 40, 60, 100, 3)).toEqual([37, 63])
    expect(centredView(10, 95, 100, 100, 3)).toEqual([90, 100])
    expect(centredView(1, 50, 51, 100, 3)).toEqual([49, 52])
    expect(centredView(10, 0, 100, 100, 3)).toEqual([0, 100])
  })
})

describe('the words', () => {
  it('places a key’s labels on their ticks, nudged clear of the one before, and leaves out one that would stray', () => {
    // Two labels 10 wide on a line 100 long: the second pushed right of the first.
    expect(placeLabels([{ at: 0, width: 10 }, { at: 8, width: 10 }], 100, 4, 20)).toEqual([0, 14])
    // At the end of the line, a label stays on it.
    expect(placeLabels([{ at: 100, width: 10 }], 100, 4, 20)).toEqual([90])
    // One that would have to move further than it may is left out, and the next placed after the last kept.
    expect(placeLabels([{ at: 10, width: 40 }, { at: 12, width: 10 }, { at: 70, width: 10 }], 100, 4, 5)).toEqual([0, null, 65])
  })

  it('prints an affinity to two significant figures below 1, to two decimals from 1', () => {
    expect(affinityText(0.0837)).toBe('0.084')
    expect(affinityText(0.84)).toBe('0.84')
    expect(affinityText(1.158)).toBe('1.16')
    expect(affinityText(1)).toBe('1.00')
    expect(affinityText(0.0062)).toBe('0.0062')
    expect(affinityText(0)).toBe('0')
  })

  it('prints observed over expected as the close-up’s readout does', () => {
    expect(ratioText(0.84)).toBe('0.84×')
    expect(ratioText(3.24)).toBe('3.2×')
    expect(ratioText(41.4)).toBe('41×')
    expect(ratioText(1234.5)).toBe('1,235×')
    expect(ratioText(0)).toBe('0×')
  })

  it('keys the genome map at the background, 0.1 and 1, as its own', () => {
    const vmin = Math.log10(0.024)
    const vmax = Math.log10(2)
    const ticks = affinityTicks(vmin, vmax, 0.024)
    expect(ticks.map((tick) => tick.label)).toEqual(['0.024', '0.1', '1'])
    expect(ticks.map((tick) => tick.note)).toEqual(['background', undefined, 'as its own'])
    expect(ticks[0].at).toBe(0)
    expect(ticks[2].at).toBeCloseTo(-vmin / (vmax - vmin), 12)
  })

  it('keys the close-up at the background, then each decade up its range', () => {
    const ticks = ratioTicks(Math.log10(0.006), 2.3, 0.006)
    expect(ticks.map((tick) => tick.label)).toEqual(['0.0060', '0.1', '1', '10', '100'])
    expect(ticks.find((tick) => tick.label === '1')?.note).toBe('as expected')
    expect(ticks.every((tick) => tick.at >= 0 && tick.at <= 1)).toBe(true)
  })
})
