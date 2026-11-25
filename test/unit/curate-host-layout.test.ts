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
import type { HostPair } from '../../src/curate/suggest'
import {
  AROUND_ELEMENTS,
  AROUND_RIVALS,
  aroundSet,
  barHeight,
  barWidth,
  bestHosts,
  clampScroll,
  countParts,
  curvePoint,
  drawnCounts,
  fitPitch,
  footWords,
  hostAnchors,
  hostLayout,
  hostLinks,
  linkDistance,
  linkKey,
  linkWidth,
  linkWords,
  magRank,
  neighbourhood,
  offerCounts,
  questionNumber,
  relatedTo,
  roomy,
  shareText,
  sourcesOf,
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

  it('places an element a step made beside the genome its contigs came from, before the MAG it meets most', () => {
    const genomes = [...mags('A', 'B', 'C'), ...elements('E', 'N')]
    // N meets C most; its contigs came from B.
    const pairs = { a: [0, 2], b: [4, 4], affinity: [0.1, 0.9] }
    const rank = magRank(genomes, ['A', 'B', 'C'])
    const kept = new Map<string, string | null>([['E', 'A']])
    expect(hostAnchors(genomes, pairs, [], rank, { kept, from: new Map([['N', ['B']]]) }).get('N')).toBe('B')
    // Split from an element: that element's place.
    expect(hostAnchors(genomes, pairs, [], rank, { kept, from: new Map([['N', ['E']]]) }).get('N')).toBe('A')
    // From several: the earliest in the order, as the stage's order puts it.
    expect(hostAnchors(genomes, pairs, [], rank, { kept, from: new Map([['N', ['C', 'B']]]) }).get('N')).toBe('B')
    // A source that is no place — gone, or not shown around the selection — gives way to what it meets.
    expect(hostAnchors(genomes, pairs, [], rank, { kept, from: new Map([['N', ['gone']]]) }).get('N')).toBe('C')
    expect(hostAnchors(genomes, pairs, [], rank, { kept, allowed: new Set(['A', 'C']), from: new Map([['N', ['B']]]) }).get('N')).toBe('C')
    // A place kept is kept, whatever its contigs' history.
    expect(hostAnchors(genomes, pairs, [], rank, { kept: new Map([['N', 'A']]), from: new Map([['N', ['B']]]) }).get('N')).toBe('A')
  })

  it('finds where a new element came from: the genomes its contigs were in, never itself nor the pool', () => {
    const before = { genomes: [...mags('A', 'B'), ...elements('E')], genomeOf: [0, 0, 1, 2, -1, 1] }
    // N took contig 1 of A, 3 of E and 4 of the pool; B became the element B, keeping its id.
    const after = { genomes: [...mags('A'), ...elements('E', 'N', 'B')], genomeOf: [0, 2, 3, 2, 2, 3] }
    const known = new Set(['E'])
    expect([...sourcesOf(before, after, known)]).toEqual([['N', ['A', 'E']]])
    // Nothing new: nothing to look for.
    expect(sourcesOf(before, after, new Set(['E', 'N', 'B'])).size).toBe(0)
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

  it('counts every offer, drawn or not: links for pairs not held, unlinks for pairs held', () => {
    const held = [{ element: 'E', mag: 'A' }]
    const offer = (element: string, mag: string, kind: 'link' | 'unlink') => ({ element, mag, suggestion: { kind } })
    expect(offerCounts(held, [offer('E', 'B', 'link'), offer('F', 'A', 'link'), offer('E', 'A', 'unlink'), offer('E', 'A', 'link'), offer('F', 'B', 'unlink')])).toEqual({
      offered: 2,
      unlink: 1,
    })
    const a = answer()
    expect(offerCounts(a.links, offersOf(a))).toEqual({ offered: 1, unlink: 1 })
  })

  it('shows around a MAG its elements and their other hosts, around an element its hosts and their other elements, one step out only', () => {
    const kinds = new Map<string, 'mag' | 'element'>([
      ['A', 'mag'],
      ['B', 'mag'],
      ['C', 'mag'],
      ['D', 'mag'],
      ['E', 'element'],
      ['F', 'element'],
      ['G', 'element'],
    ])
    const links = [
      { element: 'E', mag: 'A' },
      { element: 'E', mag: 'B' },
      { element: 'F', mag: 'B' },
      { element: 'F', mag: 'C' },
      { element: 'G', mag: 'C' },
      { element: 'G', mag: 'D' },
    ]
    // A's element E, and E's other host B — not B's other element F.
    expect([...aroundSet(['A'], links, (id) => kinds.get(id))].sort()).toEqual(['A', 'B', 'E'])
    // F's hosts B and C, and their other elements E and G — not G's other host D.
    expect([...aroundSet(['F'], links, (id) => kinds.get(id))].sort()).toEqual(['B', 'C', 'E', 'F', 'G'])
    expect([...aroundSet(['gone'], links, (id) => kinds.get(id))]).toEqual([])
  })

  it('shows around an element the MAGs it meets most that no link joins it to, and the elements it meets most, as the card lists them', () => {
    // MAGs A, B, C, D, R, S, T; elements E … K. E is linked to A, a link to B is offered, and B holds F.
    const genomes = [...mags('A', 'B', 'C', 'D', 'R', 'S', 'T'), ...elements('E', 'F', 'G', 'H', 'I', 'J', 'K')]
    const at = new Map(genomes.map((genome, g) => [genome.id, g]))
    const g = (id: string): number => at.get(id) as number
    const host = (mag: string, contacts: number, affinity: number, share: number): HostPair => ({
      element: g('E'),
      mag: g(mag),
      contacts,
      affinity,
      share,
      confidence: 0,
      linked: mag === 'A',
    })
    // The rivals by affinity, then contacts: S, then D and C at one affinity, D with more contacts; T least; R never met.
    const hosts = [host('A', 400, 0.8, 0.9), host('B', 60, 0.3, 0.07), host('C', 10, 0.05, 0.01), host('D', 30, 0.05, 0.02), host('R', 0, 0, 0), host('S', 5, 0.2, 0.004), host('T', 100, 0.01, 0.006)]
    // The elements E meets, as the card ranks them: by affinity, a tie to the one earlier; and a MAG pair, which is no element.
    const meet: Array<[string, string, number]> = [
      ['E', 'K', 0.1],
      ['J', 'E', 0.5],
      ['E', 'I', 1],
      ['E', 'H', 2],
      ['G', 'E', 2],
      ['E', 'F', 3],
      ['E', 'A', 0.8],
      ['F', 'G', 9],
    ]
    const pairs = { a: meet.map(([a]) => g(a)), b: meet.map(([, b]) => g(b)), affinity: meet.map(([, , affinity]) => affinity) }
    const answer = { genomes, pairs, hosts }
    const link = (element: string, mag: string, held: boolean): HostLink => ({
      key: linkKey(element, mag),
      element,
      mag,
      held,
      fromFile: false,
      pair: null,
      offer: held ? null : ({ kind: 'link' } as Suggestion),
      met: false,
    })
    const links = [link('E', 'A', true), link('E', 'B', false), link('F', 'B', true)]
    expect([AROUND_ELEMENTS, AROUND_RIVALS]).toEqual([5, 3])
    const around = neighbourhood(['E'], answer, links)
    // Its hosts, held and offered, their other element F; the five elements it meets most; the three rivals.
    expect([...around.genomes].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'S'])
    expect([...around.meets]).toEqual(['F', 'G', 'H', 'I', 'J'])
    expect(around.met.map((m) => [m.key, m.held, m.offer, m.met, m.pair?.contacts])).toEqual([
      [linkKey('E', 'S'), false, null, true, 5],
      [linkKey('E', 'D'), false, null, true, 30],
      [linkKey('E', 'C'), false, null, true, 10],
    ])
    // As many as asked.
    const fewer = neighbourhood(['E'], answer, links, { elements: 2, rivals: 1 })
    expect([...fewer.meets]).toEqual(['F', 'G'])
    expect(fewer.met.map((m) => m.mag)).toEqual(['S'])
    // Around a MAG, what is linked alone: no rival, no element met.
    const mag = neighbourhood(['B'], answer, links)
    expect([...mag.genomes].sort()).toEqual(['A', 'B', 'E', 'F'])
    expect([mag.met, [...mag.meets]]).toEqual([[], []])
    expect([...neighbourhood(['gone'], answer, links).genomes]).toEqual([])
  })

  it('counts no rival a misplaced contig explains, nor one a link is offered to: the community’s element and X1, which it meets through y5', () => {
    const a = answer()
    const around = neighbourhood(['P'], a, hostLinks(a, offersOf(a)))
    // Its two hosts, Z held and Y offered: y5 is Y's, and carries its contacts with P.
    expect([...around.genomes].sort()).toEqual(['P', 'Y', 'Z'])
    expect(around.met).toEqual([])
    // y5's move turned down, y5 is where it is, and its contacts with P count for X1: a link is offered.
    const { base, evidence } = community()
    const declined = stateAnswer(evidence, CuratedBinning.of(base, null), {}, ['move:y5>Y'])
    const offered = neighbourhood(['P'], declined, hostLinks(declined, offersOf(declined)))
    expect([...offered.genomes].sort()).toEqual(['P', 'X1', 'Y', 'Z'])
    expect(offered.met).toEqual([])
    // That link turned down too, as the stage's offers leave it out: X1 a rival, met and not linked.
    const rival = neighbourhood(['P'], declined, hostLinks(declined, offersOf(declined).filter((o) => o.suggestion.key !== 'link:P>X1')))
    expect([...rival.genomes].sort()).toEqual(['P', 'X1', 'Y', 'Z'])
    expect(rival.met.map((m) => m.key)).toEqual([linkKey('P', 'X1')])
    const x1 = rival.met[0]
    expect(x1.pair?.contacts).toBe(24)
    expect(linkWords(x1, 'P', 'X1')).toMatch(/^P ↔ X1 · not linked · affinity [\d.]+ \(at least [\d.]+\) · [\d.]+% of its MAG contacts · 24 contacts · host \d+%$/)
  })

  it('counts the links drawn — held, offered, to unlink —, never what an element only meets', () => {
    const offer = (kind: 'link' | 'unlink') => ({ kind }) as Suggestion
    expect(
      drawnCounts([
        { held: true, offer: null, met: false },
        { held: true, offer: offer('unlink'), met: false },
        { held: false, offer: offer('link'), met: false },
        { held: false, offer: null, met: true },
      ]),
    ).toEqual({ held: 2, offered: 1, unlink: 1 })
  })

  it('says in the head links, not questions: the map’s, or around the selection what is drawn of the map’s', () => {
    expect(countParts({ held: 96, offered: 17, unlink: 1 }, null)).toEqual(['96 links', '17 links offered', '1 to unlink'])
    expect(countParts({ held: 1, offered: 1, unlink: 0 }, null)).toEqual(['1 link', '1 link offered'])
    expect(countParts({ held: 1_204, offered: 0, unlink: 0 }, null)).toEqual(['1,204 links'])
    const whole = { held: 96, offered: 17, unlink: 1 }
    expect(countParts({ held: 13, offered: 3, unlink: 0 }, whole)).toEqual(['13 of 96 links', '3 of 17 links offered'])
    expect(countParts({ held: 0, offered: 0, unlink: 0 }, whole)).toEqual(['0 of 96 links'])
    expect(countParts({ held: 1, offered: 1, unlink: 1 }, { held: 1, offered: 1, unlink: 1 })).toEqual(['1 of 1 link', '1 of 1 link offered', '1 of 1 to unlink'])
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
    // One contact in 121: a share under a percent, said to a tenth of one, as the map labels it.
    const z = links.find((l) => l.key === linkKey('P', 'Z')) as HostLink
    expect(linkWords(z, 'P', 'Z')).toMatch(/^P ↔ Z · linked, from the file · unlink offered · affinity 0\.0033 \(at least 0\.000\d+\) · 0\.8% of its MAG contacts · 1 contact · host 0%$/)
    expect(linkWords({ ...z, pair: null, offer: null, fromFile: false }, 'P', 'Z')).toBe('P ↔ Z · linked · no contacts')
    // Before the contacts are read: its numbers to come, not none.
    expect(linkWords({ ...z, pair: null, offer: null }, 'P', 'Z', false)).toBe('P ↔ Z · linked, from the file · its numbers once the contacts are read')
  })

  it('labels a share of an element’s contacts with MAGs whole from a tenth, to a tenth of a percent below, never a rival’s few as none', () => {
    expect([0.97, 1, 0.0995, 0.12].map(shareText)).toEqual(['97%', '100%', '10%', '12%'])
    expect([0.0994, 0.042, 0.003, 0.00095].map(shareText)).toEqual(['9.9%', '4.2%', '0.3%', '0.1%'])
    expect([0.0004, 0, Number.NaN].map(shareText)).toEqual(['<0.1%', '0%', '0%'])
  })

  it('says the elements it folds, one or many, before the contacts are read and after', () => {
    expect(footWords(1, true)).toBe('1 meets no MAG')
    expect(footWords(1_046, true)).toBe('1,046 meet no MAG')
    expect(footWords(3, false)).toBe('3 not linked')
  })
})

