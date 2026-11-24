// @dev-feature curate
/**
 * The curation's suggestions (SPECS §33.5) on a small community built so each
 * kind has one right answer: two fragments of one organism, an unbinned contig
 * that belongs to one, a contig binned in the wrong MAG, an element and its
 * host, a link the contacts do not support, and a stranger.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type BaseBinning } from '../../src/genome/curation'
import { background, tally, visibility, type ContigNetwork } from '../../src/curate/method'
import { markerTable, type MarkerSet } from '../../src/curate/quality'
import { curationState, methodBinning, neighbourLists, type CurationEvidence } from '../../src/curate/suggest'

/**
 * Organism X: contigs x0–x5, binned as two MAGs, X1 (x0–x2) and X2 (x3–x5).
 * Organism Y: y0–y4, in MAG Y, and y5 binned by mistake in X1.
 * Organism Z: z0–z3, MAG Z — a stranger to the rest.
 * u0: unbinned, X's. p0, p1: an element, P, hosted by Y; the file links it to Z.
 */
const NAMES = ['x0', 'x1', 'x2', 'y5', 'x3', 'x4', 'x5', 'y0', 'y1', 'y2', 'y3', 'y4', 'z0', 'z1', 'z2', 'z3', 'p0', 'p1', 'u0']
const ORGANISM: Record<string, string> = {}
for (const name of NAMES) ORGANISM[name] = name[0]

function community(): { base: BaseBinning; evidence: CurationEvidence } {
  const index = new Map(NAMES.map((name, i) => [name, i]))
  const pairs = new Map<number, number>()
  const add = (a: string, b: string, n: number): void => {
    const i = index.get(a) ?? -1
    const j = index.get(b) ?? -1
    const key = Math.min(i, j) * NAMES.length + Math.max(i, j)
    pairs.set(key, (pairs.get(key) ?? 0) + n)
  }
  // Within an organism, every two contigs meet 60 times; strangers once now and then.
  for (const organism of ['x', 'y', 'z']) {
    const members = NAMES.filter((name) => ORGANISM[name] === organism || (organism === 'x' && name === 'u0'))
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) add(members[i], members[j], 60)
  }
  // The plasmid's two contigs meet each other, and Y's contigs a fifth as densely as Y's own.
  add('p0', 'p1', 80)
  for (const y of ['y0', 'y1', 'y2', 'y3', 'y4', 'y5']) {
    add('p0', y, 12)
    add('p1', y, 12)
  }
  // Spurious ligation: a contact or two between strangers.
  for (const [a, b] of [
    ['x0', 'z0'],
    ['x3', 'z1'],
    ['y1', 'z2'],
    ['y2', 'x5'],
    ['z3', 'p0'],
  ]) add(a, b, 1)
  const keys = [...pairs.keys()].sort((x, y) => x - y)
  const network: ContigNetwork = {
    contigs: NAMES.length,
    first: Int32Array.from(keys.map((key) => Math.floor(key / NAMES.length))),
    second: Int32Array.from(keys.map((key) => key % NAMES.length)),
    contacts: Float64Array.from(keys.map((key) => pairs.get(key) ?? 0)),
    within: new Float64Array(NAMES.length),
  }
  const genomes = [
    { name: 'X1', kind: 'mag' as const },
    { name: 'X2', kind: 'mag' as const },
    { name: 'Y', kind: 'mag' as const },
    { name: 'Z', kind: 'mag' as const },
    { name: 'P', kind: 'element' as const },
  ]
  const of: Record<string, number> = { x0: 0, x1: 0, x2: 0, y5: 0, x3: 1, x4: 1, x5: 1, y0: 2, y1: 2, y2: 2, y3: 2, y4: 2, z0: 3, z1: 3, z2: 3, z3: 3, p0: 4, p1: 4, u0: -1 }
  const base: BaseBinning = {
    names: NAMES,
    lengths: NAMES.map(() => 50_000),
    genomeOf: Int32Array.from(NAMES.map((name) => of[name])),
    genomes,
    links: [{ element: 'P', mag: 'Z' }],
  }
  // Markers: X's halves complementary (A, B in X1; C, D in X2), Y and Z each a whole set.
  const set: MarkerSet = { name: 'Bact4', markers: ['A', 'B', 'C', 'D'], weights: [0.25, 0.25, 0.25, 0.25] }
  const texts = NAMES.map((name) => ({ x0: 'A', x1: 'B', x3: 'C', x4: 'D', y0: 'A,B', y1: 'C,D', z0: 'A,B,C,D', y5: '' })[name] ?? '')
  const t = visibility(network)
  const binning = CuratedBinning.of(base, null)
  return {
    base,
    evidence: {
      network,
      visibility: t,
      ...neighbourLists(network),
      markers: [markerTable(set, texts)],
      background: background(tally(network, t, methodBinning(binning)), methodBinning(binning).kinds),
      names: NAMES,
      lengths: base.lengths,
    },
  }
}

describe('the suggestions on a small community', () => {
  const { base, evidence } = community()
  const binning = CuratedBinning.of(base, null)
  const state = curationState(evidence, binning)
  const by = (kind: string): string[] => state.suggestions.filter((s) => s.kind === kind && s.confidence >= 0.5).map((s) => s.words)

  it('merge the two fragments of one organism, and nothing else', () => {
    expect(by('merge')).toEqual(['merge X2 into X1'])
    const merge = state.suggestions.find((s) => s.kind === 'merge')
    expect(merge?.evidence).toContain('markers complementary')
  })

  it('recruit the unbinned contig into its organism, and move the misplaced one home', () => {
    expect(by('recruit').length).toBe(1)
    expect(by('recruit')[0]).toMatch(/^recruit u0 into X[12]$/)
    expect(by('move')).toEqual(['move y5 from X1 to Y'])
  })

  it('link the element to its host, and drop the link the contacts do not support', () => {
    expect(by('link')).toEqual(['link P to Y'])
    expect(by('unlink')).toEqual(['unlink P from Z'])
  })

  it('give every MAG miComplete’s numbers from its markers', () => {
    const x1 = state.quality[binning.indexOfId('X1') ?? -1]
    expect(x1?.completeness).toBe(0.5)
    expect(state.quality[binning.indexOfId('Z') ?? -1]?.completeness).toBe(1)
  })

  it('are counted again on the binning a step makes: merged, the fragments are one, and complete', () => {
    const merged = CuratedBinning.of(base, withCurationStep(emptyCuration(fileBinning(base)), { op: 'merge', into: 'X1', genomes: ['X2'] }, 'reader', 0))
    const after = curationState(evidence, merged)
    expect(after.suggestions.some((s) => s.kind === 'merge' && s.confidence >= 0.5)).toBe(false)
    expect(after.quality[merged.indexOfId('X1') ?? -1]?.completeness).toBe(1)
  })
})
