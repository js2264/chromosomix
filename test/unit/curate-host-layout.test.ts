// @dev-feature curate
/**
 * The host map's arithmetic (SPECS §33.3): each element placed beside the MAG
 * it meets most, and kept there across steps; the two columns' rows — a band a
 * MAG, the elements in it, the foot folded or open; the links drawn, held and
 * offered, and what each rests on; what is shown around the selection; a
 * link's curve; names pushed apart; and the readout's words.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { questions, type Question } from '../../src/curate/questions'
import type { Suggestion } from '../../src/curate/suggest'
import {
  aroundSet,
  barHeight,
  barWidth,
  bestHosts,
  clampScroll,
  curvePoint,
  fitPitch,
  hostAnchors,
  hostLayout,
  hostLinks,
  linkDistance,
  linkKey,
  linkWidth,
  linkWords,
  magRank,
  questionNumber,
  relatedTo,
  roomy,
  spreadLabels,
  suggestedPairs,
  type HostGenome,
  type HostLink,
} from '../../src/curate/ui/hostLayout'
import { community } from '../support/curateCommunity'

/** The community's answer as the file bins it: X1, X2, Y, Z (MAGs), P (an element) linked by the file to Z. */
function answer() {
  const { base, evidence } = community()
  return stateAnswer(evidence, CuratedBinning.of(base, null))
}

/** The link and unlink suggestions of an answer, by the genomes' ids, as the pane hands them to `hostLinks`. */
function offersOf(a: ReturnType<typeof answer>): Array<{ element: string; mag: string; suggestion: Suggestion }> {
  return a.suggestions
    .filter((s) => s.kind === 'link' || s.kind === 'unlink')
    .map((s) => ({ element: a.genomes[s.genomes[0]].id, mag: a.genomes[s.genomes[1]].id, suggestion: s }))
}

const mags = (...ids: string[]): HostGenome[] => ids.map((id) => ({ id, kind: 'mag' }))
const elements = (...ids: string[]): HostGenome[] => ids.map((id) => ({ id, kind: 'element' }))

describe('where each element goes', () => {
  it('places an element beside the MAG it meets most densely', () => {
    const a = answer()
    // P meets Y (its host) densely, X1 through y5, Z by a read pair.
    const rank = magRank(a.genomes, ['Y', 'X1', 'X2', 'Z', 'P'])
    expect([...rank]).toEqual([
      ['Y', 0],
      ['X1', 1],
      ['X2', 2],
      ['Z', 3],
    ])
    expect(hostAnchors(a.genomes, a.pairs, a.links, rank).get('P')).toBe('Y')
    const best = bestHosts(a.genomes, a.pairs, rank).get('P')
    expect(best?.mag).toBe('Y')
    expect(best?.affinity).toBeCloseTo(0.2739, 3)
  })

  it('keeps an element’s place while its MAG lasts, and finds it another when it is gone', () => {
    const genomes = [...mags('A', 'B', 'C'), ...elements('E')]
    // E meets C most, then B.
    const pairs = { a: [1, 2], b: [3, 3], affinity: [0.2, 0.5] }
    const rank = magRank(genomes, ['A', 'B', 'C'])
    expect(hostAnchors(genomes, pairs, [], rank).get('E')).toBe('C')
    expect(hostAnchors(genomes, pairs, [], rank, { kept: new Map([['E', 'A']]) }).get('E')).toBe('A')
    const gone = magRank([...mags('B', 'C'), ...elements('E')], ['B', 'C'])
    expect(hostAnchors(genomes, pairs, [], gone, { kept: new Map([['E', 'A']]) }).get('E')).toBe('C')
    // Around the selection, only a MAG shown is a place.
    expect(hostAnchors(genomes, pairs, [], rank, { allowed: new Set(['B']) }).get('E')).toBe('B')
  })

  it('places an element linked to a MAG it does not meet beside it, so its link is drawn; one with neither, nowhere', () => {
    const genomes = [...mags('A', 'B'), ...elements('E', 'F')]
    const pairs = { a: [], b: [], affinity: [] }
    const anchors = hostAnchors(genomes, pairs, [{ element: 'E', mag: 'B' }], magRank(genomes, ['A', 'B']))
    expect(anchors.get('E')).toBe('B')
    expect(anchors.get('F')).toBeNull()
  })

  it('breaks a tie by the order', () => {
    const genomes = [...mags('A', 'B'), ...elements('E')]
    const pairs = { a: [0, 1], b: [2, 2], affinity: [0.3, 0.3] }
    expect(hostAnchors(genomes, pairs, [], magRank(genomes, ['B', 'A'])).get('E')).toBe('B')
    expect(hostAnchors(genomes, pairs, [], magRank(genomes, ['A', 'B'])).get('E')).toBe('A')
  })
})

describe('the rows', () => {
  it('gives each MAG a band of the elements beside it, one row at least, its node at the middle', () => {
    const genomes = [...mags('A', 'B', 'C'), ...elements('E1', 'E2', 'E3', 'F')]
    const anchors = new Map<string, string | null>([
      ['E1', 'B'],
      ['E2', 'B'],
      ['E3', 'B'],
      ['F', null],
    ])
    const layout = hostLayout(genomes, ['A', 'B', 'C', 'E2', 'E1', 'E3', 'F'], anchors)
    expect(layout.mags).toEqual([
      { id: 'A', from: 0, to: 1, at: 0.5 },
      { id: 'B', from: 1, to: 4, at: 2.5 },
      { id: 'C', from: 4, to: 5, at: 4.5 },
    ])
    // In the order's order inside the band.
    expect(layout.elements).toEqual([
      { id: 'E2', row: 1, anchor: 'B' },
      { id: 'E1', row: 2, anchor: 'B' },
      { id: 'E3', row: 3, anchor: 'B' },
    ])
    expect(layout.rows).toBe(5)
    expect(layout.foot).toEqual(['F'])
    expect(layout.total).toBe(5)
  })

  it('gives the foot rows after the bands only when it is open', () => {
    const genomes = [...mags('A'), ...elements('F', 'G')]
    const anchors = new Map<string, string | null>([
      ['F', null],
      ['G', null],
    ])
    const open = hostLayout(genomes, ['A', 'G', 'F'], anchors, { footOpen: true })
    expect(open.elements).toEqual([
      { id: 'G', row: 1, anchor: null },
      { id: 'F', row: 2, anchor: null },
    ])
    expect(open.total).toBe(3)
  })

  it('places a genome the order does not know after its kind, and leaves out what is not shown', () => {
    const genomes = [...mags('A', 'new', 'B'), ...elements('E')]
    const anchors = new Map<string, string | null>([['E', 'new']])
    const layout = hostLayout(genomes, ['B', 'A', 'E', 'gone'], anchors)
    expect(layout.mags.map((b) => b.id)).toEqual(['B', 'A', 'new'])
    expect(layout.elements).toEqual([{ id: 'E', row: 2, anchor: 'new' }])
    const around = hostLayout(genomes, ['B', 'A', 'E'], anchors, { visible: new Set(['A', 'E']) })
    expect(around.mags.map((b) => b.id)).toEqual(['A'])
    // Its MAG not shown: at the foot.
    expect(around.foot).toEqual(['E'])
  })

  it('lays the community out: Y’s band holds P, the others one row each', () => {
    const a = answer()
    const order = ['Y', 'X1', 'X2', 'Z', 'P']
    const layout = hostLayout(a.genomes, order, hostAnchors(a.genomes, a.pairs, a.links, magRank(a.genomes, order)))
    expect(layout.mags.map((b) => [b.id, b.from, b.to])).toEqual([
      ['Y', 0, 1],
      ['X1', 1, 2],
      ['X2', 2, 3],
      ['Z', 3, 4],
    ])
    expect(layout.elements).toEqual([{ id: 'P', row: 0, anchor: 'Y' }])
  })
})

describe('the links', () => {
  it('draws the links held and the links offered, one a pair, with the pair’s numbers', () => {
    const a = answer()
    const links = hostLinks(a, offersOf(a))
    const byKey = new Map(links.map((link) => [link.key, link]))
    // The file links P to Z, which the contacts no longer support: held, an unlink on offer.
    const z = byKey.get(linkKey('P', 'Z')) as HostLink
    expect(z.held).toBe(true)
    expect(z.fromFile).toBe(true)
    expect(z.offer?.kind).toBe('unlink')
    expect(z.pair?.contacts).toBe(1)
    // Y hosts P: offered.
    const y = byKey.get(linkKey('P', 'Y')) as HostLink
    expect(y.held).toBe(false)
    expect(y.offer?.kind).toBe('link')
    expect(y.pair?.share).toBeCloseTo(120 / 121, 6)
    expect(links).toHaveLength(2)
    expect(linkWidth(y)).toBeCloseTo(1 + (3 * 120) / 121, 6)
    expect(linkWidth({ pair: null })).toBe(1)
  })

  it('draws no pair neither held nor offered, nor an offer the binning has moved past', () => {
    const a = answer()
    const link = offersOf(a).find((o) => o.suggestion.kind === 'link')!
    const unlink = offersOf(a).find((o) => o.suggestion.kind === 'unlink')!
    // A link offered for a pair now held, and an unlink for one not held.
    const moved = hostLinks(
      { genomes: a.genomes, hosts: a.hosts, links: [{ element: 'P', mag: 'Y', fromFile: false }] },
      [link, unlink],
    )
    expect(moved.map((l) => [l.key, l.held, l.offer])).toEqual([[linkKey('P', 'Y'), true, null]])
  })

  it('shows around a MAG its elements and their other hosts, one step out only', () => {
    const kinds = new Map<string, 'mag' | 'element'>([
      ['A', 'mag'],
      ['B', 'mag'],
      ['C', 'mag'],
      ['E', 'element'],
      ['F', 'element'],
    ])
    const links = [
      { element: 'E', mag: 'A' },
      { element: 'E', mag: 'B' },
      { element: 'F', mag: 'B' },
      { element: 'F', mag: 'C' },
    ]
    expect([...aroundSet(['A'], links, (id) => kinds.get(id))].sort()).toEqual(['A', 'B', 'E'])
    expect([...aroundSet(['F'], links, (id) => kinds.get(id))].sort()).toEqual(['B', 'C', 'F'])
    expect([...aroundSet(['gone'], links, (id) => kinds.get(id))]).toEqual([])
  })

  it('lights with a genome the genomes linked to it, and those links', () => {
    const links = [
      { key: 'E\tA', element: 'E', mag: 'A' },
      { key: 'F\tB', element: 'F', mag: 'B' },
    ] as HostLink[]
    const lit = relatedTo(new Set(['A']), links)
    expect([...lit.genomes].sort()).toEqual(['A', 'E'])
    expect([...lit.links]).toEqual(['E\tA'])
  })

  it('reads a question’s pairs from its members, and numbers it as the review’s band does', () => {
    const a = answer()
    const list = questions(a.suggestions, a, community().base.names)
    const host = list.find((q) => q.key === 'host:P') as Question
    expect(suggestedPairs(host, (g) => a.genomes[g]?.id)).toEqual([
      { element: 'P', mag: 'Z', kind: 'unlink' },
      { element: 'P', mag: 'Y', kind: 'link' },
    ])
    expect(suggestedPairs(a.suggestions.find((s) => s.kind === 'merge')!, (g) => a.genomes[g]?.id)).toEqual([])
    const q = (key: string, confidence: number, members: string[] = []): Question =>
      ({ key, confidence, members: members.map((m) => ({ key: m })) }) as unknown as Question
    const queue = [q('a', 0.9), q('b', 0.6, ['b1', 'b2']), q('c', 0.3), q('d', 0.2)]
    expect(questionNumber(queue, 'b', 0.5)).toBe(2)
    expect(questionNumber(queue, 'b2', 0.5)).toBe(2)
    // The less sure, from 1 again.
    expect(questionNumber(queue, 'd', 0.5)).toBe(2)
    expect(questionNumber(queue, 'nowhere', 0.5)).toBeNull()
  })
})

describe('geometry', () => {
  it('sizes a node on a log scale of its length', () => {
    expect(barWidth(1_000, 1_000, 100_000, 16, 56)).toBe(16)
    expect(barWidth(100_000, 1_000, 100_000, 16, 56)).toBe(56)
    expect(barWidth(10_000, 1_000, 100_000, 16, 56)).toBeCloseTo(36, 9)
    expect(barWidth(5, 5, 5, 16, 56)).toBe(36)
    expect(barHeight(14)).toBe(6)
    expect(barHeight(6)).toBe(3)
    expect(barHeight(3)).toBe(2)
  })

  it('fits the rows to the view, never taller than the most, and keeps a scroll inside its content', () => {
    expect(fitPitch(100, 800, 24)).toBe(8)
    expect(fitPitch(4, 800, 24)).toBe(24)
    expect(fitPitch(0, 800, 24)).toBe(24)
    expect(clampScroll(-5, 1000, 400)).toBe(0)
    expect(clampScroll(900, 1000, 400)).toBe(600)
    expect(clampScroll(50, 300, 400)).toBe(0)
  })

  it('runs a link level from both ends, through the middle of its ends, and measures how near a point is', () => {
    expect(curvePoint(0, 0, 100, 60, 0)).toEqual([0, 0])
    expect(curvePoint(0, 0, 100, 60, 1)).toEqual([100, 60])
    expect(curvePoint(0, 0, 100, 60, 0.5)).toEqual([50, 30])
    expect(linkDistance(50, 30, 0, 0, 100, 60)).toBeLessThan(0.5)
    expect(linkDistance(50, 0, 0, 0, 100, 60)).toBeGreaterThan(20)
    // Level near its ends: a point beside the MAG's end, a pixel off the curve.
    expect(linkDistance(5, 1, 0, 0, 100, 60)).toBeLessThan(1.5)
  })

  it('pushes crowded names apart inside the view, in their order', () => {
    expect(spreadLabels([10, 12, 14], 0, 100, 12)).toEqual([10, 22, 34])
    expect(spreadLabels([95, 96], 0, 100, 12)).toEqual([82, 94])
    expect(spreadLabels([1], 0, 100, 12)).toEqual([6])
    expect(roomy([0, 5, 30, 60], 11)).toEqual([false, false, true, true])
  })
})

describe('words', () => {
  it('says a link: held and from where, what is offered, its affinity, share, contacts and host confidence', () => {
    const a = answer()
    const links = hostLinks(a, offersOf(a))
    const y = links.find((l) => l.key === linkKey('P', 'Y')) as HostLink
    expect(linkWords(y, 'P', 'Y')).toMatch(/^P ↔ Y · link offered · affinity 0\.53 \(at least 0\.4\d\) · 99% of its MAG contacts · 120 contacts · host 99%$/)
    const z = links.find((l) => l.key === linkKey('P', 'Z')) as HostLink
    expect(linkWords(z, 'P', 'Z')).toMatch(/^P ↔ Z · linked, from the file · unlink offered · affinity 0\.0033 \(at least 0\.000\d+\) · 1% of its MAG contacts · 1 contact · host 0%$/)
    expect(linkWords({ ...z, pair: null, offer: null, fromFile: false }, 'P', 'Z')).toBe('P ↔ Z · linked · no contacts')
  })
})

