// @vitest-environment jsdom
/**
 * The drawer's map tabs, the combined figure, and the plot controls.
 *
 * Three claims, and the first is the one that was quietly false. A deck's batch
 * computes one result per panel; keyed by task alone, the fourth overwrote the
 * third, so what four libraries left behind was four synthetic tracks and *one*
 * plot. The tracks were filed per map and the figures were not.
 *
 * The second is that the overlay is a comparison rather than a result: it has no
 * single provenance, so it offers no TSV and no recompute, and it says which
 * outputs it could not fold rather than showing three of a task's five and
 * letting the reader assume that is all there are.
 *
 * The third is that an interactive figure is a *plain figure of a derived
 * output* — the property that makes the PDF export show what is on screen rather
 * than what the task returned.
 *
 * The fourth is that what the reader hides changes *which* lines are drawn and
 * nothing else. Colours used to be taken from a series' position in whatever
 * array the renderer was handed, so hiding one recoloured every line after it —
 * curve, band and legend swatch alike, all the way into the PNG and the PDF —
 * and isolating a series always drew it in the first palette entry whichever one
 * had been picked.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import { combineResults } from '@/analysis/combine'
import { resolveSeriesColours } from '@/ui/analysisPlots'
import { figureBlock } from '@/figures/FigureBlock'
import type { AnalysisRunner, RunTarget } from '@/analysis/runner'
import type {
  AnalysisContext,
  AnalysisFraming,
  CurveOutput,
  MatrixOutput,
  TaskResult,
} from '@/analysis/types'

const FRAMING: AnalysisFraming = {
  uri: 'a.mcool',
  rows: [0, 100],
  cols: [0, 100],
  binsize: 1000,
  binsPerCell: 1,
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
  label: 'chrI at 1 kb',
}

const CONTEXT = {
  uri: 'a.mcool',
  layout: 'mcool',
  binsize: 1000,
  nBins: 100,
  hasGenomes: false,
  hasWeights: false,
  scoreColumns: ['count'],
  contigs: [{ name: 'chrI', length: 100_000, startBin: 0, bins: 100, id: 0 }],
  genomes: [],
  entries: [],
  framing: FRAMING,
  blockLoaded: false,
  blockBytes: 0,
} as unknown as AnalysisContext

function curve(id: string, label: string, name: string, scale = 1): CurveOutput {
  return {
    kind: 'curve',
    id,
    label,
    series: [
      {
        name,
        x: Float64Array.from([1, 2, 3, 4, 5]),
        y: Float64Array.from([10, 8, 6, 4, 2]).map((v) => v * scale) as Float64Array,
      },
    ],
    xLabel: 'separation',
    yLabel: 'contacts',
    xScale: 'log',
    yScale: 'log',
  }
}

function matrix(id: string): MatrixOutput {
  return {
    kind: 'matrix',
    id,
    label: 'pileup',
    nrows: 2,
    ncols: 2,
    values: Float32Array.from([1, 2, 3, 4]),
    xLabel: 'x',
    yLabel: 'y',
    xTicks: [],
    yTicks: [],
    colormap: 'fall',
  }
}

function resultOf(taskId: string, outputs: TaskResult['outputs']): TaskResult {
  return {
    provenance: {
      task: taskId,
      title: 'Contact probability',
      params: {},
      framing: FRAMING,
      createdAt: '2026-08-12T10:00:00Z',
      app: 'test',
    },
    outputs,
    notes: [],
    ms: 12,
  } as unknown as TaskResult
}

const TASK_ID = 'expected'

function targetOf(map: string, label: string): RunTarget {
  return { map, uri: `${map}.mcool`, label } as RunTarget
}

/** A runner holding one result per map, as a finished batch leaves it. */
function runnerWith(entries: Array<{ target: RunTarget; result: TaskResult }>): AnalysisRunner {
  return {
    subscribe: () => () => {},
    resultOf: (taskId: string) =>
      taskId === TASK_ID ? (entries[0]?.result ?? null) : null,
    resultsFor: (taskId: string) => (taskId === TASK_ID ? entries : []),
    // One run per map, which is what a finished batch leaves: the history the
    // stepper walks is per map and this fixture has no second run of any of them.
    runsOf: (taskId: string, map?: string) => {
      if (taskId !== TASK_ID) return []
      const found = map === undefined ? entries[0] : entries.find((entry) => entry.target.map === map)
      return found === undefined ? [] : [found.result]
    },
    stateOf: () => ({ status: 'idle' }),
    run: () => {},
    runAll: () => {},
    targets: () => entries.map((entry) => entry.target),
    // The two the batch button reads: how many maps it will end up covering,
    // and the list once the ones still opening have answered.
    targetCount: () => entries.length,
    readyTargets: async () => entries.map((entry) => entry.target),
    target: () => entries[0]?.target ?? null,
    cancel: () => {},
  } as unknown as AnalysisRunner
}

function open(entries: Array<{ target: RunTarget; result: TaskResult }>): AnalysisDrawer {
  const drawer = new AnalysisDrawer({
    runner: runnerWith(entries),
    context: () => CONTEXT,
    framing: () => FRAMING,
    onClose: () => {},
    hasLanes: () => false,
    writeProfile: () => Promise.resolve(),
  })
  document.body.appendChild(drawer.el)
  drawer.show({
    id: TASK_ID,
    title: 'Contact probability',
    group: 'map',
    venue: 'reader',
    params: [],
    availability: () => ({ state: 'ready' }),
    estimate: () => null,
  } as never)
  return drawer
}

const tabs = (drawer: AnalysisDrawer): string[] =>
  [...drawer.el.querySelectorAll('.analysis-map')].map((node) => node.textContent ?? '')

const titles = (drawer: AnalysisDrawer): string[] =>
  [...drawer.el.querySelectorAll('.analysis-figure-title')].map((node) => node.textContent ?? '')

const click = (node: Element | null | undefined): void => {
  ;(node as HTMLElement | undefined)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('the map tabs', () => {
  it('are absent for a session with one map', () => {
    const drawer = open([
      { target: targetOf('lead', 'rep1'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis')]) },
    ])
    expect(drawer.el.querySelector('.analysis-maps')?.classList.contains('hidden')).toBe(true)
    expect(tabs(drawer)).toEqual([])
  })

  it('name every map that has a result, and offer all of them', () => {
    const drawer = open([
      { target: targetOf('lead', 'rep1'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis')]) },
      { target: targetOf('m2', 'rep2'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis', 2)]) },
      { target: targetOf('m3', 'rep3'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis', 3)]) },
    ])
    expect(tabs(drawer)).toEqual(['rep1', 'rep2', 'rep3', 'all maps'])
    expect(drawer.el.querySelector('.analysis-maps')?.classList.contains('hidden')).toBe(false)
  })

  it('draws the map whose tab is chosen, and only that one', () => {
    const drawer = open([
      { target: targetOf('lead', 'rep1'), result: resultOf(TASK_ID, [curve('ps', 'P(s) one', 'cis')]) },
      { target: targetOf('m2', 'rep2'), result: resultOf(TASK_ID, [curve('ps', 'P(s) two', 'cis')]) },
    ])
    expect(titles(drawer)).toEqual(['P(s) one'])
    click(drawer.el.querySelectorAll('.analysis-map')[1])
    expect(titles(drawer)).toEqual(['P(s) two'])
  })

  it('steps through the maps with the arrows, and wraps', () => {
    const drawer = open([
      { target: targetOf('lead', 'rep1'), result: resultOf(TASK_ID, [curve('ps', 'one', 'cis')]) },
      { target: targetOf('m2', 'rep2'), result: resultOf(TASK_ID, [curve('ps', 'two', 'cis')]) },
    ])
    const next = drawer.el.querySelector('.analysis-maps button:last-child')
    click(next)
    expect(titles(drawer)).toEqual(['two'])
    click(drawer.el.querySelector('.analysis-maps button:last-child'))
    // Third stop is `all maps`, whose figure is the overlay.
    expect(titles(drawer)[0]).toMatch(/all maps/)
    click(drawer.el.querySelector('.analysis-maps button:last-child'))
    expect(titles(drawer)).toEqual(['one'])
  })
})

describe('the combined figure', () => {
  const threeMaps = (): Array<{ target: RunTarget; result: TaskResult }> => [
    { target: targetOf('lead', 'rep1'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis')]) },
    { target: targetOf('m2', 'rep2'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis', 2)]) },
    { target: targetOf('m3', 'rep3'), result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis', 3)]) },
  ]

  it('overlays one series per map, named by the map', () => {
    const combined = combineResults(
      threeMaps().map((entry) => ({ label: entry.target.label, result: entry.result })),
      (output) => (output.kind === 'curve' ? output : null),
    )
    expect(combined.curves).toHaveLength(1)
    expect(combined.curves[0].series.map((series) => series.name)).toEqual(['rep1', 'rep2', 'rep3'])
    // The axes are the task's, taken from the first: every map ran the same
    // task, so there is only one answer to take.
    expect(combined.curves[0].xScale).toBe('log')
    expect(combined.curves[0].xLabel).toBe('separation')
  })

  it('keeps both names when a map contributes several lines', () => {
    const two: CurveOutput = {
      ...curve('ps', 'P(s)', 'cis'),
      series: [
        { name: 'cis', x: Float64Array.from([1, 2]), y: Float64Array.from([2, 1]) },
        { name: 'trans', x: Float64Array.from([1, 2]), y: Float64Array.from([1, 1]) },
      ],
    }
    const combined = combineResults(
      [
        { label: 'rep1', result: resultOf(TASK_ID, [two]) },
        { label: 'rep2', result: resultOf(TASK_ID, [two]) },
      ],
      (output) => (output.kind === 'curve' ? output : null),
    )
    expect(combined.curves[0].series.map((series) => series.name)).toEqual([
      'rep1 · cis',
      'rep1 · trans',
      'rep2 · cis',
      'rep2 · trans',
    ])
  })

  it('gives each map its own stack, so a bar is one map tall', () => {
    // Two maps sharing one stack would be a single bar two libraries tall, the
    // second one's cis fraction standing on the first one's total.
    const stacked: CurveOutput = {
      ...curve('cistrans-fractions', 'Cis and trans', 'cis'),
      xTicks: ['I', 'II'],
      series: [
        {
          name: 'cis',
          x: Float64Array.from([0, 1]),
          y: Float64Array.from([0.9, 0.8]),
          mark: 'bars',
          stack: 'contacts',
        },
        {
          name: 'trans',
          x: Float64Array.from([0, 1]),
          y: Float64Array.from([0.1, 0.2]),
          mark: 'bars',
          stack: 'contacts',
        },
      ],
    }
    const combined = combineResults(
      [
        { label: 'rep1', result: resultOf(TASK_ID, [stacked]) },
        { label: 'rep2', result: resultOf(TASK_ID, [stacked]) },
      ],
      (output) => (output.kind === 'curve' ? output : null),
    )
    expect(combined.curves[0].series.map((series) => series.stack)).toEqual([
      'rep1 · contacts',
      'rep1 · contacts',
      'rep2 · contacts',
      'rep2 · contacts',
    ])
    // Two libraries of one genome name their sequences the same way, so the
    // abscissa keeps its names.
    expect(combined.curves[0].xTicks).toEqual(['I', 'II'])
  })

  it('drops the names of an abscissa the maps do not agree about', () => {
    // The names are positional, so the first map's list over the second map's
    // bars is a mislabelling rather than a default — and two assemblies in one
    // deck is a deck this app allows.
    const named = (names: string[]): CurveOutput => ({
      ...curve('cistrans-fractions', 'Cis fraction', 'cis'),
      xTicks: names,
    })
    const combined = combineResults(
      [
        { label: 'rep1', result: resultOf(TASK_ID, [named(['I', 'II'])]) },
        { label: 'rep2', result: resultOf(TASK_ID, [named(['chr1', 'chr2'])]) },
      ],
      (output) => (output.kind === 'curve' ? output : null),
    )
    expect(combined.curves[0].xTicks).toBeUndefined()
  })

  it('names what it could not fold rather than quietly dropping it', () => {
    const combined = combineResults(
      [
        { label: 'rep1', result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis'), matrix('pile')]) },
        { label: 'rep2', result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis'), matrix('pile')]) },
      ],
      (output) => (output.kind === 'curve' ? output : null),
    )
    expect(combined.curves).toHaveLength(1)
    // A pileup averaged over two libraries would be a third thing nobody asked
    // for, so it stays per map — and the tab says so.
    expect(combined.perMapOnly).toEqual(['pileup'])
  })

  it('matches outputs by id, not by position', () => {
    // A task may emit an output conditionally, so the second output of one run
    // is not necessarily the second of another. Matching by position lines the
    // wrong two up and produces a figure that is confidently wrong.
    const combined = combineResults(
      [
        { label: 'rep1', result: resultOf(TASK_ID, [matrix('pile'), curve('ps', 'P(s)', 'cis')]) },
        { label: 'rep2', result: resultOf(TASK_ID, [curve('ps', 'P(s)', 'cis', 2)]) },
      ],
      (output) => (output.kind === 'curve' ? output : null),
    )
    expect(combined.curves).toHaveLength(1)
    expect(combined.curves[0].series.map((series) => series.name)).toEqual(['rep1', 'rep2'])
  })

  it('is shown on the all-maps tab, with the exports a comparison can have', () => {
    const drawer = open(threeMaps())
    click([...drawer.el.querySelectorAll('.analysis-map')].at(-1))
    expect(titles(drawer)[0]).toBe('P(s) — all maps')
    const buttons = [...drawer.el.querySelectorAll('.analysis-figure-head button')].map(
      (node) => node.textContent,
    )
    expect(buttons).toContain('PNG')
    expect(buttons).toContain('PDF')
    // No TSV: an overlay has no single provenance, so there is no one framing
    // for a column of numbers to be labelled with. The per-map tabs export.
    expect(buttons).not.toContain('TSV')
  })
})

describe('a figure block', () => {
  // A file of its own per test: the style is *remembered* per file and per
  // task, so two tests sharing a URI would be two tests sharing a style.
  const block = (uri = 'file://maps.mcool', task = 'ps'): { el: HTMLElement; destroy(): void } =>
    figureBlock({ output: threeSeries(), task, uri })

  /** Three series with no colours of their own — the palette decides. */
  function threeSeries(): CurveOutput {
    return {
      ...curve('ps', 'P(s)', 'a'),
      series: ['a', 'b', 'c'].map((name) => ({
        name,
        x: Float64Array.from([1, 2]),
        y: Float64Array.from([2, 1]),
      })),
    }
  }

  /** The strip's *worded* controls; the legend is an icon toggle beside them. */
  const strip = (figure: { el: HTMLElement }): string[] =>
    [...figure.el.querySelectorAll('.figure-strip button')]
      .map((node) => node.textContent ?? '')
      .filter((text) => text !== '')

  it('puts the controls a reader reaches for constantly inline', () => {
    const figure = block()
    document.body.appendChild(figure.el)
    // Lowercase button labels (§26.4).
    expect(strip(figure)).toEqual(['log x', 'log y', 'fit'])
    // …and the mark, which is the one that decides what the picture *is*.
    const marks = figure.el.querySelector<HTMLSelectElement>('.figure-strip select')
    expect(marks?.value).toBe('line')
    figure.destroy()
  })

  it('opens on the scales the task chose, and flips one on a press', () => {
    const figure = block('file://flip.mcool')
    document.body.appendChild(figure.el)
    const pressed = (): string[] => pressedIn(figure)
    expect(pressed()).toEqual(['log x', 'log y'])
    click([...figure.el.querySelectorAll('.figure-strip button')].find((node) => node.textContent === 'log y'))
    expect(pressed()).toEqual(['log x'])
    figure.destroy()
  })

  const pressedIn = (figure: { el: HTMLElement }): string[] =>
    [...figure.el.querySelectorAll('.figure-strip button[aria-pressed="true"]')]
      .map((node) => node.textContent ?? '')
      .filter((text) => text !== '')

  it('remembers what was set, per file and per task', () => {
    const first = block('file://memory.mcool')
    document.body.appendChild(first.el)
    click([...first.el.querySelectorAll('.figure-strip button')].find((node) => node.textContent === 'log x'))
    first.destroy()

    // The same file and task comes back as it was left…
    const again = block('file://memory.mcool')
    document.body.appendChild(again.el)
    expect(pressedIn(again)).toEqual(['log y'])
    again.destroy()

    // …and another task on the same file is untouched.
    const other = block('file://memory.mcool', 'saddle')
    document.body.appendChild(other.el)
    expect(pressedIn(other)).toEqual(['log x', 'log y'])
    other.destroy()
  })

  it('opens the whole settings column in a dialog, and puts the figure back', () => {
    const figure = block('file://dialog.mcool')
    document.body.appendChild(figure.el)
    const chart = figure.el.querySelector('.figure-chart')
    expect(chart).not.toBeNull()

    click(figure.el.querySelector('.figure-enlarge'))
    const dialog = document.querySelector('.modal-stage')
    expect(dialog).not.toBeNull()
    // The figure itself is moved in, not copied: there is one of it.
    expect(dialog?.querySelector('.stage-body > .figure-chart')).toBe(chart)
    expect(dialog?.querySelector('.stage-side .figure-settings')).not.toBeNull()
    expect(document.querySelectorAll('.figure-chart')).toHaveLength(1)

    click(dialog?.querySelector('.btn-close'))
    expect(document.querySelector('.modal-stage')).toBeNull()
    expect(figure.el.querySelector('.figure-body > .figure-chart')).toBe(chart)
    figure.destroy()
  })

  it('leaves a colour a series already carries, sentinel included', () => {
    // Two things `resolveSeriesColours` must not touch: a task that coloured its
    // own lines meant something by it, and the legend's "+N more" entry carries
    // `colour: 'none'` precisely so no swatch is drawn beside a name that stands
    // for several series at once.
    const resolved = resolveSeriesColours([
      { name: 'own', x: Float64Array.from([1]), y: Float64Array.from([1]), colour: '#123456' },
      { name: 'palette', x: Float64Array.from([1]), y: Float64Array.from([1]) },
      { name: '+2 more', x: Float64Array.from([]), y: Float64Array.from([]), colour: 'none' },
    ])
    expect(resolved[0].colour).toBe('#123456')
    expect(resolved[2].colour).toBe('none')
    // The one with none of its own is given the *second* palette entry, because
    // it is second in the list — which is what `analysis/combine.ts` leans on to
    // give one map per colour on the all-maps overlay.
    expect(resolved[1].colour).toBeDefined()
    expect(resolved[1].colour).not.toBe(resolved[0].colour)
    expect(
      resolveSeriesColours([
        { name: 'first', x: Float64Array.from([1]), y: Float64Array.from([1]) },
      ])[0].colour,
    ).not.toBe(resolved[1].colour)
  })
})
