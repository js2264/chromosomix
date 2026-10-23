// @vitest-environment jsdom
/**
 * The Pairs statistics card's charts (§3.7), drawn from a `PairStats` alone.
 *
 * What is held here is what a picture would hide: that P(s) divides each bin by
 * its own width, as pairtools' plots do, and puts it at the bin's geometric
 * centre; that a line breaks at an empty bin rather than drawing through it;
 * that the convergence is marked exactly when pairtools finds one; that every
 * chart carries a name a screen reader can say; and that a library missing
 * something — strands, a `pair_type` column, cis pairs — loses that chart and
 * keeps the others, with no empty frame left where it would have been.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { convergenceOf, distEdges, type PairStats } from '@/pairs/stats'
import { InfoPanel } from '@/ui/InfoPanel'
import { cisChart, cisColumns, decayChart, decaySeries, typeSegments, typesBar } from '@/ui/pairsCharts'
import type { OpenResult } from '@/worker/protocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const EDGES = distEdges()
const at = (bp: number): number => EDGES.findIndex((edge, i) => edge <= bp && bp < (EDGES[i + 1] ?? Infinity))

/**
 * A library whose four orientations decay as `s^-1` from 10 bp to 1 Mb, with
 * `+-` carrying ten times the others below 1 kb when `inward` — the dangling
 * ends pairtools' convergence is there to find.
 */
function stats(over: Partial<PairStats> = {}, { inward = true } = {}): PairStats {
  const decay = (strands: string): number[] =>
    EDGES.map((lo, i) => {
      const hi = EDGES[i + 1]
      if (hi === undefined || lo < 10 || lo > 1e6) return 0
      const perBp = 1e6 / Math.sqrt(lo * hi)
      const excess = inward && strands === '+-' && hi <= 1000 ? 10 : 1
      return Math.round(perBp * (hi - lo) * excess)
    })
  const distFreq = { '+-': decay('+-'), '-+': decay('-+'), '--': decay('--'), '++': decay('++') }
  return {
    total: 30_300,
    totalUnmapped: 1953,
    totalSingleSidedMapped: 1485,
    totalMapped: 26_862,
    totalDups: 2311,
    totalNodups: 24_551,
    cis: 22_738,
    trans: 1813,
    pairTypes: [
      ['UU', 23_721],
      ['DD', 2311],
      ['UR', 442],
      ['XX', 418],
      ['WW', 413],
      ['UM', 391],
      ['MM', 389],
      ['RU', 388],
      ['UN', 377],
      ['NN', 376],
      ['NU', 363],
      ['NM', 357],
      ['MU', 354],
    ],
    cisAtLeast: [
      [1, 10_670],
      [2, 7300],
      [4, 5593],
      [10, 3804],
      [20, 2395],
      [40, 1288],
    ],
    chromFreq: [['I', 'I', 22_738]],
    distEdges: EDGES,
    distFreq,
    chromsizes: [['I', 230_218]],
    pairTypeColumn: true,
    scoped: false,
    ...over,
  }
}

const zeros = (): number[] => EDGES.map(() => 0)
const NO_STRANDS = { '+-': zeros(), '-+': zeros(), '--': zeros(), '++': zeros() }

/** A path's vertices, as `[x, y]`, and how many runs it is broken into. */
function vertices(d: string): { points: Array<[number, number]>; runs: number } {
  const points: Array<[number, number]> = []
  let runs = 0
  for (const m of d.matchAll(/([ML])(-?[\d.]+) (-?[\d.]+)/g)) {
    if (m[1] === 'M') runs++
    points.push([Number(m[2]), Number(m[3])])
  }
  return { points, runs }
}

function mounted(node: HTMLElement | SVGElement | null): HTMLElement | SVGElement {
  expect(node).not.toBeNull()
  document.body.appendChild(node as Node)
  return node as HTMLElement | SVGElement
}

/** Every chart's accessible name: an `svg` with `role="img"`, an `aria-label`, and a `<title>` first. */
function named(svg: SVGSVGElement): void {
  expect(svg.getAttribute('role')).toBe('img')
  expect(svg.getAttribute('aria-label')?.length).toBeGreaterThan(20)
  expect(svg.firstElementChild?.tagName.toLowerCase()).toBe('title')
  expect(svg.firstElementChild?.textContent?.length).toBeGreaterThan(10)
}

describe('P(s) by orientation', () => {
  it('divides each bin by its width and places it at the geometric centre, as pairtools plots it', () => {
    const counted = stats()
    const series = decaySeries(counted)
    expect(series.map((one) => one.strands)).toEqual(['+-', '-+', '--', '++'])
    const minus = series.find((one) => one.strands === '-+')!
    const i = at(10_000)
    const lo = EDGES[i]
    const hi = EDGES[i + 1]
    // `points` starts at the bin after `[0, 1)`, which a log axis cannot hold.
    const point = minus.points[i - 1]
    expect(point).not.toBeNull()
    expect(point![0]).toBeCloseTo(Math.sqrt(lo * hi), 9)
    expect(point![1]).toBeCloseTo(counted.distFreq['-+'][i] / (hi - lo), 9)
    expect(minus.pairs).toBe(counted.distFreq['-+'].reduce((a, b) => a + b, 0))
  })

  it('breaks a line at an empty bin rather than drawing through it', () => {
    const counted = stats()
    const gap = at(1000)
    counted.distFreq['++'][gap] = 0
    const chart = mounted(decayChart(counted))
    const path = chart.querySelector('path[data-strands="++"]') as SVGPathElement
    const whole = vertices((chart.querySelector('path[data-strands="--"]') as SVGPathElement).getAttribute('d')!)
    const broken = vertices(path.getAttribute('d')!)
    expect(whole.runs).toBe(1)
    expect(broken.runs).toBe(2)
    expect(broken.points.length).toBe(whole.points.length - 1)
  })

  it('draws four named lines, each with points, told apart by dashes as well as colour', () => {
    const chart = mounted(decayChart(stats()))
    const svg = chart.querySelector('svg.pairs-stats-decay') as SVGSVGElement
    named(svg)
    expect(svg.getAttribute('aria-label')).toContain('four strand orientations')
    const paths = [...svg.querySelectorAll('path.pairs-stats-line')]
    expect(paths).toHaveLength(4)
    for (const path of paths) {
      const { points } = vertices(path.getAttribute('d')!)
      expect(points.length).toBeGreaterThan(20)
      // Inside the chart's box.
      const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(width)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(height)
      }
    }
    const dashes = new Set(paths.map((path) => path.getAttribute('stroke-dasharray') ?? 'solid'))
    expect(dashes.size).toBe(4)
    const classes = new Set(paths.map((path) => [...path.classList].find((c) => c.startsWith('is-s'))))
    expect(classes.size).toBe(4)
    // The key names the four, each with a sample dashed as its line is.
    expect(textsOf(chart as HTMLElement, '.pairs-stats-key')).toEqual(['+−', '−+', '−−', '++'])
    const samples = [...chart.querySelectorAll('.pairs-stats-key line')].map((line) => line.getAttribute('stroke-dasharray') ?? 'solid')
    expect(new Set(samples)).toEqual(dashes)
  })

  it('marks where the four meet, with its value, when pairtools finds a point', () => {
    const counted = stats()
    const { distance } = convergenceOf(counted)
    expect(distance).toBe(1000)
    const chart = mounted(decayChart(counted))
    const rule = chart.querySelector('.pairs-stats-meet line.pairs-stats-rule')
    expect(rule).not.toBeNull()
    expect(rule!.getAttribute('x1')).toBe(rule!.getAttribute('x2'))
    expect(chart.querySelector('.pairs-stats-meet-label')?.textContent).toBe('1 kb')
    expect(chart.querySelector('svg.pairs-stats-svg')?.getAttribute('aria-label')).toContain('meet past 1 kb')
    // The rule stands halfway between the 100 bp and 10 kb decades, where 1 kb is on a log axis.
    const x = Number(rule!.getAttribute('x1'))
    const tick = (text: string): number =>
      Number([...chart.querySelectorAll('text')].find((t) => t.textContent === text)!.getAttribute('x'))
    // Within the pixel the rule is snapped to.
    expect(Math.abs(x - (tick('100 bp') + tick('10 kb')) / 2)).toBeLessThanOrEqual(1)
  })

  it('leaves the mark out where the four agree everywhere', () => {
    const chart = mounted(decayChart(stats({}, { inward: false })))
    expect(convergenceOf(stats({}, { inward: false })).distance).toBeNull()
    expect(chart.querySelector('.pairs-stats-meet')).toBeNull()
    expect(chart.querySelector('svg.pairs-stats-svg')?.getAttribute('aria-label')).toContain('agree at every separation')
  })

  it('draws only the orientations that have a line', () => {
    const counted = stats()
    counted.distFreq['++'] = zeros()
    counted.distFreq['--'] = zeros()
    counted.distFreq['--'][at(500)] = 7
    const chart = mounted(decayChart(counted))
    expect(chart.querySelectorAll('path.pairs-stats-line')).toHaveLength(2)
    expect(textsOf(chart as HTMLElement, '.pairs-stats-key')).toEqual(['+−', '−+'])
  })

  it('is not drawn for a file with no strands, or no cis pair', () => {
    expect(decayChart(stats({ distFreq: NO_STRANDS }))).toBeNull()
    expect(decaySeries(stats({ distFreq: NO_STRANDS }))).toEqual([])
  })
})

describe('the pair types', () => {
  it('colours the common types and folds the rest into one segment', () => {
    const segments = typeSegments(stats())
    expect(segments.map((s) => [s.type, s.slot])).toEqual([
      ['UU', 1],
      ['DD', 2],
      [null, 0],
    ])
    expect(segments[2].types).toHaveLength(11)
    expect(segments.reduce((sum, s) => sum + s.count, 0)).toBe(30_300)
  })

  it('names a lone leftover type rather than folding one', () => {
    const segments = typeSegments(stats({ pairTypes: [['UU', 905], ['DD', 80], ['NN', 15]] }))
    expect(segments.map((s) => s.type)).toEqual(['UU', 'DD', 'NN'])
    expect(segments.map((s) => s.slot)).toEqual([1, 2, 0])
  })

  it('draws a segment a type, as wide as its share, with a gap between', () => {
    const svg = mounted(typesBar(stats())) as SVGSVGElement
    named(svg)
    expect(svg.getAttribute('aria-label')).toBe('Pair types, of every record: UU 78.3%, DD 7.6%, 11 other types 14.1%.')
    const rects = [...svg.querySelectorAll('rect.pairs-stats-seg')]
    expect(rects).toHaveLength(3)
    const widths = rects.map((rect) => Number(rect.getAttribute('width')))
    const width = Number(svg.getAttribute('viewBox')!.split(' ')[2])
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(width - 2 * 2, 0)
    expect(widths[0] / widths[1]).toBeCloseTo(23_721 / 2311, 0)
    expect(rects[2].querySelector('title')?.textContent).toContain('UR, XX, WW')
  })

  it('is not drawn for a file with no pair_type column', () => {
    expect(typesBar(stats({ pairTypes: [], pairTypeColumn: false }))).toBeNull()
  })
})

describe('cis past each distance', () => {
  it('draws a column for cis and one for each distance, each filled to its share of the unique pairs', () => {
    const counted = stats()
    const chart = mounted(cisChart(counted))
    const svg = chart.querySelector('svg.pairs-stats-svg') as SVGSVGElement
    named(svg)
    expect(svg.getAttribute('aria-label')).toContain('92.6% in all')
    expect(svg.getAttribute('aria-label')).toContain('5.2% at least 40 kb apart')
    const columns = [...svg.querySelectorAll('.pairs-stats-column')]
    expect(columns.map((g) => g.getAttribute('data-key'))).toEqual([
      'cis',
      'cis ≥ 1 kb',
      'cis ≥ 2 kb',
      'cis ≥ 4 kb',
      'cis ≥ 10 kb',
      'cis ≥ 20 kb',
      'cis ≥ 40 kb',
    ])
    const shares = cisColumns(counted).map((column) => column.share)
    columns.forEach((g, i) => {
      const track = Number(g.querySelector('.pairs-stats-track')!.getAttribute('height'))
      const fill = Number(g.querySelector('.pairs-stats-fill')!.getAttribute('height'))
      expect(fill / track).toBeCloseTo(shares[i], 1)
    })
    const labels = [...svg.querySelectorAll('text')].map((t) => t.textContent)
    expect(labels).toEqual(expect.arrayContaining(['93%', '43%', '5.2%', 'cis', '≥1', '≥40']))
  })

  it('is not drawn with no cis pair, or no unique pair at all', () => {
    expect(cisChart(stats({ cis: 0, trans: 24_551, cisAtLeast: [[1, 0]] }))).toBeNull()
    expect(cisChart(stats({ totalNodups: 0, cis: 0, trans: 0 }))).toBeNull()
  })
})

describe('the charts in the card', () => {
  function card(counted: PairStats): HTMLElement {
    const info: OpenResult = {
      uri: 'https://example.org/sample.pairs.gz',
      layout: { kind: 'cool', group: '/' },
      info: {
        format: 'pairs',
        'format-url': null,
        'format-version': 1,
        'bin-size': 1000,
        'bin-type': 'fixed',
        ordering: 'genome',
        assembly: 'sacCer3',
        'storage-mode': 'symmetric-upper',
        nbins: 230,
        nnz: 400,
        sum: 22_738,
        ngenomes: 0,
        ncontigs: 1,
      },
      metadata: {},
      binsize: 1000,
      shape: [230, 230],
      nGenomes: 0,
      nContigs: 1,
      nBins: 230,
      unassigned: null,
      displayExtent: [0, 230],
      entries: [],
      entryGroup: 'entries',
      cells: [],
      activeCells: [],
      cellNnz: null,
      hasGenomes: false,
      hasWeights: false,
      scoreColumns: ['count'],
      sourceBytes: 1_234_567,
      contacts: null,
      sourceKind: 'local',
      pairs: {
        base: 1000,
        rungs: [1000],
        records: 30_300,
        nnz: 400,
        indexed: false,
        skippedUnknownContig: 0,
        skippedBadPosition: 0,
        clampedPosition: 0,
        requiredMerge: false,
        truncated: false,
        sequencesWithoutCisContacts: [],
        download: false,
        orientation: null,
        stats: counted,
        binning: { base: 1000, rungs: 1 },
      },
    }
    const view = new InfoPanel({ info })
    document.body.appendChild(view.el)
    return view.el.querySelector('.card.pairs-stats') as HTMLElement
  }

  /** What follows each row of the table: the row's key, or the chart's class. */
  function sequence(node: HTMLElement): string[] {
    const table = node.querySelector('.pairs-stats-table') as HTMLElement
    return [...table.children]
      .map((child) =>
        child.classList.contains('k')
          ? child.textContent!
          : child.classList.contains('pairs-stats-chart')
            ? `[${[...child.classList].find((c) => c !== 'pairs-stats-chart')}]`
            : null,
      )
      .filter((entry): entry is string => entry !== null)
  }

  it('sets each chart under the rows it pictures, inside the table', () => {
    expect(sequence(card(stats()))).toEqual([
      'records',
      'mapped',
      'one side',
      'unmapped',
      'duplicates',
      '[pairs-stats-types-block]',
      'cis',
      'trans',
      '[pairs-stats-cis-block]',
      'library size',
      'strands meet',
      '[pairs-stats-decay-block]',
    ])
  })

  it('makes the chips the bar’s key: each wears its segment’s swatch', () => {
    const node = card(stats())
    expect(textsOf(node, '.pairs-stats-type').slice(0, 3)).toEqual(['UU 23,721', 'DD 2,311', 'UR 442'])
    const swatches = [...node.querySelectorAll('.pairs-stats-type .pairs-stats-swatch')].map((s) =>
      [...s.classList].find((c) => c.startsWith('is-')),
    )
    expect(swatches).toEqual(['is-s1', 'is-s2', ...Array(11).fill('is-other')])
    expect(node.querySelectorAll('svg[role="img"]')).toHaveLength(3)
  })

  it('leaves out what a library cannot draw, and no frame where it would be', () => {
    const untyped = card(stats({ pairTypes: [], pairTypeColumn: false }))
    expect(untyped.querySelector('.pairs-stats-types-block')).toBeNull()
    expect(untyped.querySelector('.pairs-stats-cis-block svg')).not.toBeNull()
    expect(untyped.querySelector('.pairs-stats-decay-block svg')).not.toBeNull()
    untyped.remove()

    const unstranded = card(stats({ distFreq: NO_STRANDS }))
    expect(unstranded.querySelector('.pairs-stats-decay-block')).toBeNull()
    expect(unstranded.querySelectorAll('.pairs-stats-chart')).toHaveLength(2)
    // Nothing to compare is not agreement everywhere.
    const keys = textsOf(unstranded, '.pairs-stats-table > .k')
    const values = textsOf(unstranded, '.pairs-stats-table > .v')
    expect(values[keys.indexOf('strands meet')]).toBe('—')
    unstranded.remove()

    const allTrans = card(stats({ cis: 0, trans: 24_551, cisAtLeast: [], distFreq: NO_STRANDS }))
    expect([...allTrans.querySelectorAll('.pairs-stats-chart')].map((c) => c.classList[1])).toEqual(['pairs-stats-types-block'])
    expect(allTrans.querySelectorAll('svg[role="img"]')).toHaveLength(1)
  })
})
