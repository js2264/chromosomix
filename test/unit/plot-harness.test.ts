// @vitest-environment jsdom
/**
 * The object `metacooler-plot` drives a window through (§27.6), against a fake
 * window.
 *
 * The one question here a reader answers by looking is *is the picture
 * finished?*, and the harness answers it by counting: every worker request not
 * yet answered (`perf/inflight.ts`) and whatever the tab says it is doing, both
 * at nothing for a while together. Asserted both ways — it waits while either is
 * busy, and it gives up at its deadline naming what it was waiting on, because a
 * run that hangs for ten minutes and then says only *timed out* has told nobody
 * anything.
 *
 * The rest is the plumbing a figure crosses: bytes held under a reference and
 * read out in pieces, the date a request carries reaching the surface that
 * draws, and a tab with nothing to show saying so rather than throwing.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { beginWork, inflight, inflightKinds, track } from '@/perf/inflight'
import { installPlotHarness } from '@/plot/harness'
import { plotAnswers } from '@/plot/answers'
import { PLOT_PROTOCOL, type PlotApi } from '@/plot/protocol'
import type { AnalysisPlot, PlotHost, PlotRequest, RunFigure, SessionPlot } from '@/plot/types'
import { getExportPrefs } from '@/ui/exportPrefs'

/** A tab whose answers the test sets. */
type FakeTab = SessionPlot & { busyWith: string[]; asked: PlotRequest[] }

function fakeTab(patch: Partial<SessionPlot> = {}): FakeTab {
  const asked: PlotRequest[] = []
  const tab: FakeTab = {
    busyWith: [],
    asked,
    label: () => 'a tab',
    state: () => ({ view: 'region', uri: 'http://srv/a.cool' }) as unknown as ReturnType<SessionPlot['state']>,
    busy: (): string[] => tab.busyWith,
    failure: () => null,
    figureKind: () => ({ kind: 'map' as const }),
    figure: async (request: PlotRequest) => {
      asked.push(request)
      return new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], { type: 'image/png' })
    },
    bookmarks: () => [{ label: 'a loop', locus: 'IV:1-2' }],
    goToBookmark: () => undefined,
    goToLocus: (locus: string) => (locus === 'bad' ? 'bad is not a locus' : null),
    structures: () => [],
    analysis: () => null,
    ...patch,
  }
  return tab
}

function install(tabs: SessionPlot[], notices: string[] = []): PlotApi {
  const host: PlotHost = {
    openWorkspace: (text) => (text === 'refuse' ? 'This is not a workspace.' : null),
    tabs: () => tabs,
    active: () => 0,
    activate: () => undefined,
    takeNotices: () => notices.splice(0),
  }
  installPlotHarness(host)
  const api = window.metacoolerPlot
  if (api === undefined) throw new Error('no harness')
  return api
}

beforeAll(() => {
  // jsdom paints nothing, so a frame is a timer here.
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0)
  }
})

afterEach(() => {
  delete window.metacoolerPlot
})

describe('inflight', () => {
  it('counts work from its start to its end, once however often it is ended', () => {
    const before = inflight()
    const done = beginWork('reader:block')
    beginWork('reader:block')()
    expect(inflightKinds()['reader:block']).toBe(1)
    done()
    done()
    expect(inflightKinds()['reader:block']).toBeUndefined()
    expect(inflight()).toBe(before)
  })

  it('counts a promise in while it is pending, failed or not', async () => {
    let fail: (error: Error) => void = () => undefined
    const pending = track('import:three', new Promise((_, reject) => (fail = reject)))
    expect(inflightKinds()['import:three']).toBe(1)
    fail(new Error('no chunk'))
    await expect(pending).rejects.toThrow('no chunk')
    expect(inflightKinds()['import:three']).toBeUndefined()
  })
})

describe('the harness', () => {
  it('says which protocol it speaks and which build it is', () => {
    const api = install([fakeTab()])
    expect(api.protocol).toBe(PLOT_PROTOCOL)
    expect(typeof api.build.version).toBe('string')
  })

  it('sets the window up as the command asks', () => {
    const api = install([fakeTab()])
    api.configure({ theme: 'dark', caption: false, scool: 'whole', pairs: { base: 5000, rungs: 2 } })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(getExportPrefs().caption).toBe(false)
    api.configure({ caption: true })
    expect(getExportPrefs().caption).toBe(true)
    // The answers are the plot mount's alone: this window was not mounted with it.
    expect(plotAnswers()).toBeNull()
  })

  it('passes a refusal of the workspace back as the window’s own sentence', () => {
    const api = install([fakeTab()])
    expect(api.open('refuse', 'w.json')).toBe('This is not a workspace.')
    expect(api.open('{}', 'w.json')).toBeNull()
  })

  it('describes the tab in front, and takes the window’s notices once', () => {
    const api = install([fakeTab()], ['A track was left out.'])
    const report = api.describe()
    expect(report).toMatchObject({
      index: 0,
      count: 1,
      label: 'a tab',
      view: 'region',
      failure: null,
      figure: { kind: 'map' },
      bookmarks: [{ label: 'a loop', locus: 'IV:1-2' }],
      structures: [],
      notices: ['A track was left out.'],
    })
    expect(api.describe().notices).toEqual([])
  })

  // A window with no tab is a report, not an exception.
  it('says there is no tab rather than throwing', async () => {
    const api = install([])
    expect(api.describe()).toMatchObject({ failure: 'no tab is open', figure: { kind: null, why: 'no tab is open' } })
    expect(api.goToLocus('IV:1-2')).toBe('no tab is open')
    expect(await api.figure({ format: 'png', dpi: 300 })).toBeNull()
    expect(api.analyses()).toBeNull()
  })

  it('passes a locus through, and the tab’s refusal back', () => {
    const api = install([fakeTab()])
    expect(api.goToLocus('IV:1-2')).toBeNull()
    expect(api.goToLocus('bad')).toBe('bad is not a locus')
  })

  it('holds a figure’s bytes under a reference, hands them out in pieces, and lets go', async () => {
    const tab = fakeTab()
    const api = install([tab])
    const ref = await api.figure({ format: 'pdf', dpi: 600, now: '2026-01-01T00:00:00.000Z' })
    expect(ref).toMatchObject({ size: 10, type: 'image/png' })
    if (ref === null) return
    // The request reaches the surface as it was sent: the date is the caption's.
    expect(tab.asked[0]).toEqual({ format: 'pdf', dpi: 600, now: new Date('2026-01-01T00:00:00.000Z') })
    const first = Buffer.from(await api.read(ref.ref, 0, 4), 'base64')
    const rest = Buffer.from(await api.read(ref.ref, 4, 100), 'base64')
    expect([...first, ...rest]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    api.drop(ref.ref)
    await expect(api.read(ref.ref, 0, 4)).rejects.toThrow(`no bytes are held under ${ref.ref}`)
  })

  it('reads a request it cannot use as the Export card’s defaults', async () => {
    const tab = fakeTab()
    const api = install([tab])
    await api.figure({ format: 'svg' as 'png', dpi: Number.NaN, now: 'not a date' })
    expect(tab.asked[0].format).toBe('png')
    expect(tab.asked[0].dpi).toBe(300)
    expect(Number.isNaN(tab.asked[0].now.getTime())).toBe(false)
  })
})

describe('settle', () => {
  it('waits while a worker has work out, and for a quiet stretch after', async () => {
    const api = install([fakeTab()])
    const done = beginWork('reader:block')
    const started = performance.now()
    setTimeout(done, 150)
    await api.settle(10_000)
    // The work, then the quiet it has to be followed by.
    expect(performance.now() - started).toBeGreaterThanOrEqual(150 + 550)
  })

  it('waits while the tab says it is busy', async () => {
    const tab = fakeTab()
    tab.busyWith = ['opening']
    const api = install([tab])
    const started = performance.now()
    setTimeout(() => (tab.busyWith = []), 100)
    await api.settle(10_000)
    expect(performance.now() - started).toBeGreaterThanOrEqual(100 + 550)
  })

  it('gives up at its deadline, naming what it was waiting on', async () => {
    const tab = fakeTab()
    tab.busyWith = ['a track still loading']
    const api = install([tab])
    const done = beginWork('annotations:sample')
    const second = beginWork('annotations:sample')
    try {
      await expect(api.settle(300)).rejects.toThrow(
        /^still drawing after 0 s — waiting on 2 × annotations:sample, a track still loading$/,
      )
    } finally {
      done()
      second()
    }
  })
})

describe('analyses', () => {
  function analysisOf(run: AnalysisPlot['run']): { plot: AnalysisPlot; closed: () => boolean } {
    let closed = false
    return {
      closed: () => closed,
      plot: {
        recorded: () => [{ id: 'expected', title: 'P(s)', state: 'ready' }],
        run,
        close: () => {
          closed = true
        },
      },
    }
  }

  it('runs a task, lists what it drew, and hands each figure out by number', async () => {
    const figure: RunFigure = {
      output: 'ps',
      label: 'P(s)',
      drawable: true,
      figure: async () => new Blob(['chart'], { type: 'image/png' }),
    }
    const table: RunFigure = { output: 'table', label: 'a table', drawable: false, figure: async () => null }
    const { plot, closed } = analysisOf(async () => ({ status: 'done', figures: [figure, table], notes: ['sampled'] }))
    const api = install([fakeTab({ analysis: () => plot })])
    expect(api.analyses()).toEqual([{ id: 'expected', title: 'P(s)', state: 'ready' }])
    expect(await api.analysisFigure('expected', 0, { format: 'png', dpi: 300 })).toBeNull()
    const report = await api.runAnalysis('expected', 10_000)
    expect(report).toEqual({
      status: 'done',
      notes: ['sampled'],
      figures: [
        { index: 0, output: 'ps', label: 'P(s)', drawable: true },
        { index: 1, output: 'table', label: 'a table', drawable: false },
      ],
    })
    expect(await api.analysisFigure('expected', 0, { format: 'png', dpi: 300 })).toMatchObject({ size: 5 })
    api.closeAnalysis()
    expect(closed()).toBe(true)
  })

  it('passes a refusal or a failure back as the panel said it', async () => {
    const { plot } = analysisOf(async () => ({ status: 'refused', message: 'needs a balanced map' }))
    const api = install([fakeTab({ analysis: () => plot })])
    expect(await api.runAnalysis('expected', 10_000)).toEqual({ status: 'refused', message: 'needs a balanced map' })
  })

  it('stops waiting on a task at its deadline', async () => {
    const { plot } = analysisOf(() => new Promise(() => undefined))
    const api = install([fakeTab({ analysis: () => plot })])
    await expect(api.runAnalysis('expected', 100)).rejects.toThrow('expected was still running after 0 s')
  })

  it('says so when the tab has no Analysis panel', async () => {
    const api = install([fakeTab()])
    expect(await api.runAnalysis('expected', 1000)).toEqual({
      status: 'unavailable',
      message: 'this tab has no Analysis panel',
    })
  })
})
