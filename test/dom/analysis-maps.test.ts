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
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import { combineResults } from '@/analysis/combine'
import { interactiveCurve } from '@/ui/interactivePlot'
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

describe('an interactive curve', () => {
  it('offers the axis toggles, and a picker once there are two series', () => {
    const single = interactiveCurve(curve('ps', 'P(s)', 'cis'))
    document.body.appendChild(single.el)
    const labels = [...single.el.querySelectorAll('.plot-controls button')].map(
      (node) => node.textContent,
    )
    expect(labels).toEqual(['log x', 'log y'])

    const many = interactiveCurve({
      ...curve('ps', 'P(s)', 'cis'),
      series: [
        { name: 'cis', x: Float64Array.from([1, 2]), y: Float64Array.from([2, 1]) },
        { name: 'trans', x: Float64Array.from([1, 2]), y: Float64Array.from([1, 1]) },
      ],
    })
    document.body.appendChild(many.el)
    const withPicker = [...many.el.querySelectorAll('.plot-controls button')].map(
      (node) => node.textContent,
    )
    expect(withPicker).toEqual(['log x', 'log y', 'cis', 'trans'])
  })

  it('starts with the scales the task chose', () => {
    const figure = interactiveCurve(curve('ps', 'P(s)', 'cis'))
    document.body.appendChild(figure.el)
    const on = [...figure.el.querySelectorAll('.plot-controls .btn.is-on')].map(
      (node) => node.textContent,
    )
    expect(on).toEqual(['log x', 'log y'])
  })

  it('hides a series when its chip is clicked, and never hides them all', () => {
    const figure = interactiveCurve({
      ...curve('ps', 'P(s)', 'cis'),
      series: [
        { name: 'cis', x: Float64Array.from([1, 2]), y: Float64Array.from([2, 1]) },
        { name: 'trans', x: Float64Array.from([1, 2]), y: Float64Array.from([1, 1]) },
      ],
    })
    document.body.appendChild(figure.el)
    const chip = (name: string): Element | undefined =>
      [...figure.el.querySelectorAll('.plot-series')].find((node) => node.textContent === name)
    click(chip('cis'))
    expect(chip('cis')?.classList.contains('is-off')).toBe(true)
    // Turning off the last one would leave an empty box; a reader who clicked it
    // meant to isolate, which is what alt-click does.
    click(chip('trans'))
    expect(chip('cis')?.classList.contains('is-off')).toBe(false)
    expect(chip('trans')?.classList.contains('is-off')).toBe(false)
  })

  it('exports what is on screen: draw follows the derived output', async () => {
    // The property the whole approach rests on. `curveFigure` is mocked so the
    // output it is handed can be inspected — toggling an axis must produce a
    // *new figure of a new output*, and the wrapper's `draw` must delegate to
    // that one rather than to the figure it was built with. Get the second half
    // wrong and the screen updates while the PDF keeps exporting the original.
    const seen: CurveOutput[] = []
    const drawnBy: number[] = []
    // The static import at the top of this file has already resolved the real
    // module, so the mock only takes effect for a *fresh* module graph.
    vi.resetModules()
    vi.doMock('@/ui/analysisPlots', async () => {
      const actual = await vi.importActual<typeof import('@/ui/analysisPlots')>(
        '@/ui/analysisPlots',
      )
      return {
        ...actual,
        curveFigure: (output: CurveOutput) => {
          const at = seen.length
          seen.push(output)
          return {
            el: document.createElement('div'),
            draw: () => drawnBy.push(at),
            destroy: () => {},
          }
        },
      }
    })
    const { interactiveCurve: mocked } = await import('@/ui/interactivePlot')
    const figure = mocked(curve('ps', 'P(s)', 'cis'))
    document.body.appendChild(figure.el)

    expect(seen).toHaveLength(1)
    expect(seen[0].yScale).toBe('log')
    figure.draw({} as CanvasRenderingContext2D, { width: 10, height: 10 })
    expect(drawnBy).toEqual([0])

    const logY = [...figure.el.querySelectorAll('.plot-controls button')].find(
      (node) => node.textContent === 'log y',
    )
    click(logY)
    expect(seen).toHaveLength(2)
    expect(seen[1].yScale).toBe('linear')
    figure.draw({} as CanvasRenderingContext2D, { width: 10, height: 10 })
    expect(drawnBy).toEqual([0, 1])
    vi.doUnmock('@/ui/analysisPlots')
    vi.resetModules()
  })
})
