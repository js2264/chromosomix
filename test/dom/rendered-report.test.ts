// @vitest-environment jsdom
/**
 * The page's report of a finished picture (§12, `perf/rendered.ts`).
 *
 * Asserted from both ends: the ledger's own rules — a report comes once the last
 * wait has ended and a frame has passed with nothing new, at the moment that
 * wait ended, once, and never for a repaint alone — and a real map panel saying
 * what it waits for: its veil while a block is read, the paint that block asks
 * for, and a track on it that is still opening. The report then says what is on
 * screen, which for a pooled or cross-rung block is not the bin size the file
 * was opened at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { SampleCache } from '@/annotations/samples'
import { AnnotationStore } from '@/annotations/store'
import { begin, RENDERED, resetRendered, Surface, type RenderedReport } from '@/perf/rendered'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let reports: RenderedReport[]
const onReport = (event: Event): void => {
  reports.push((event as CustomEvent<RenderedReport>).detail)
}
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] })
  resetRendered()
  performance.clearMarks(RENDERED)
  reports = []
  window.addEventListener(RENDERED, onReport)
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  window.removeEventListener(RENDERED, onReport)
  resetRendered()
  vi.useRealTimers()
  vi.restoreAllMocks()
  teardown()
})

/** Let `n` animation frames run. */
function frames(n = 1): void {
  for (let i = 0; i < n; i++) vi.advanceTimersToNextFrame()
}

/** A surface on screen, with what it says it has drawn. */
function onScreen(account = {}): Surface {
  const node = document.createElement('div')
  document.body.append(node)
  return new Surface(node, () => account)
}

describe('the ledger', () => {
  it('reports once, a frame after the last wait ends, at the moment it ended', () => {
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(100)
    const end = begin()
    now.mockReturnValue(250)
    end()
    expect(reports).toHaveLength(0)
    now.mockReturnValue(300)
    frames()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ seq: 1, at: 250, status: 'drawn', maps: [], lanes: 0 })
    // The mark is the same report, placed at the same moment.
    const marks = performance.getEntriesByName(RENDERED) as PerformanceMark[]
    expect(marks).toHaveLength(1)
    expect(marks[0].startTime).toBe(250)
    expect((marks[0].detail as RenderedReport).seq).toBe(1)
    // Nothing more happens, and nothing more is said.
    frames(3)
    expect(reports).toHaveLength(1)
  })

  it('waits while anything waits, and does not count a wait that ended and began again', () => {
    const surface = onScreen()
    surface.wait('veil', true)
    const end = begin()
    end()
    frames(2)
    expect(reports).toHaveLength(0)
    surface.wait('veil', false)
    // A paint asked for in the same task: still not finished.
    surface.wait('paint', true)
    frames()
    expect(reports).toHaveLength(0)
    surface.wait('paint', false)
    frames()
    expect(reports).toHaveLength(1)
  })

  it('does not report a repaint alone', () => {
    const surface = onScreen()
    for (let i = 0; i < 5; i++) {
      surface.wait('paint', true)
      frames()
      surface.wait('paint', false)
      frames()
    }
    expect(reports).toHaveLength(0)
  })

  it('takes the wait that ended last as the moment, when another began before the frame', () => {
    const now = vi.spyOn(performance, 'now')
    const surface = onScreen()
    now.mockReturnValue(10)
    surface.wait('veil', true)
    now.mockReturnValue(20)
    surface.wait('veil', false)
    now.mockReturnValue(30)
    surface.wait('lanes', true)
    now.mockReturnValue(40)
    surface.wait('lanes', false)
    frames()
    expect(reports.map((report) => report.at)).toEqual([40])
  })

  it('does not wait for a surface that has left the page', () => {
    const surface = onScreen()
    surface.wait('veil', true)
    surface.el.remove()
    // Nothing told the ledger: the recheck finds it gone.
    vi.advanceTimersByTime(300)
    frames()
    expect(reports).toHaveLength(1)
  })

  it('waits for a surface that has not reached the page yet only once it has', () => {
    const node = document.createElement('div')
    const surface = new Surface(node, () => ({}))
    surface.wait('veil', true)
    document.body.append(node)
    frames(2)
    expect(reports).toHaveLength(0)
    surface.wait('veil', false)
    frames()
    expect(reports).toHaveLength(1)
  })

  it('says what is on screen in place of a picture, a refusal before a gate', () => {
    const gate = onScreen()
    gate.note('gated', 'the whole genome waits for its button')
    frames()
    expect(reports.at(-1)).toMatchObject({ status: 'gated', note: 'the whole genome waits for its button' })
    const refusal = onScreen()
    refusal.note('error', 'no such sequence')
    frames()
    expect(reports.at(-1)).toMatchObject({ status: 'error', note: 'no such sequence' })
    expect(reports.map((report) => report.seq)).toEqual([1, 2])
  })

  it('adds up what every surface has drawn', () => {
    const map = {
      title: 'IV',
      binsize: 1000,
      binsPerCell: 1,
      resolution: 1000,
      rows: 8,
      cols: 8,
      level: 'bin' as const,
    }
    const one = onScreen({ maps: [map], lanes: 2 })
    onScreen({ lanes: 3 })
    one.wait('veil', true)
    one.wait('veil', false)
    frames()
    expect(reports[0]).toMatchObject({ maps: [map], lanes: 5 })
  })
})

describe('a lane cache', () => {
  /** A client whose every sample request is held until the test answers it. */
  function heldClient() {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (err: unknown) => void }> = []
    const client = {
      cancellable: () => {
        let resolve!: (value: unknown) => void
        let reject!: (err: unknown) => void
        const promise = new Promise((yes, no) => {
          resolve = yes
          reject = no
        })
        pending.push({ resolve, reject })
        return { promise, cancel: () => reject(new Error('cancelled')) }
      },
    }
    return { client: client as never, pending }
  }

  const axis = {
    windows: () => [{ contig: 'IV', start: 0, end: 10_000 }],
  } as never

  it('is busy while a read is on its way, and asks for a frame when one fails', async () => {
    const { client, pending } = heldClient()
    const onChange = vi.fn()
    const cache = new SampleCache(client, onChange)
    cache.samplesFor({ entry: 'atac', scope: 'cols', axis, domain: [0, 10], pixels: 500 })
    expect(cache.busy).toBe(true)
    pending[0].reject(new Error('refused'))
    for (let turn = 0; turn < 4; turn++) await Promise.resolve()
    expect(cache.busy).toBe(false)
    // The failure asked for no frame of its own; without this one, whoever
    // counts the lane's waits would never look again.
    expect(onChange).toHaveBeenCalled()
  })
})

describe('a map panel', () => {
  function block(bins: number, extra: Partial<MatrixResult> = {}): MatrixResult {
    return {
      nrows: bins,
      ncols: bins,
      values: new Float32Array(bins * bins),
      rowExtent: [0, bins],
      colExtent: [0, bins],
      rowGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
      colGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
      level: 'bin',
      binsPerCell: 1,
      ...extra,
    } as unknown as MatrixResult
  }

  function panel(store?: AnnotationStore, client: unknown = { request: () => Promise.resolve(null), drop: () => {} }): MatrixPanel {
    const made = new MatrixPanel({
      binsize: 1000,
      detachedControls: true,
      hideTitle: true,
      ...(store === undefined
        ? {}
        : {
            annotations: {
              store,
              manual: new ManualStore(`rendered-marks-${Math.random()}`),
              client: client as never,
              groups: new GroupSettings(`rendered-groups-${Math.random()}`),
              contigLength: () => undefined,
            },
          }),
    })
    built.push(made)
    document.body.append(made.el)
    return made
  }

  it('reports its block once it is painted, at the resolution it was read at', () => {
    const map = panel()
    map.setBusy(true)
    frames(3)
    expect(reports).toHaveLength(0)
    map.setData(block(8), 'IV:1-8,000')
    // The paint the block asked for has not been made.
    expect(reports).toHaveLength(0)
    frames(2)
    expect(reports).toHaveLength(1)
    expect(reports[0].maps).toEqual([
      { title: 'IV:1-8,000', binsize: 1000, binsPerCell: 1, resolution: 1000, rows: 8, cols: 8, level: 'bin' },
    ])
    expect(reports[0].status).toBe('drawn')
  })

  it('reports the resolution on screen for a block read from a coarser rung and pooled', () => {
    const map = panel()
    map.setBusy(true)
    map.setData(block(8, { binsize: 5000, binsPerCell: 4 }), 'IV')
    frames(2)
    expect(reports[0].maps[0]).toMatchObject({ binsize: 5000, binsPerCell: 4, resolution: 20_000 })
  })

  it('waits for a track on the map that is still opening, and then for its window', async () => {
    const store = new AnnotationStore(`rendered-${Math.random()}.cool`, { persist: false })
    const { id } = store.begin({
      card: 'linear',
      kind: 'track',
      label: 'ATAC',
      source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
    })
    expect(store.byId(id)?.status).toBe('loading')
    const answers: Array<(value: unknown) => void> = []
    const client = {
      request: () => Promise.resolve(null),
      drop: () => {},
      cancellable: () => ({
        promise: new Promise((resolve) => answers.push(resolve)),
        cancel: () => {},
      }),
    }
    const map = panel(store, client)
    map.setBusy(true)
    map.setData(block(8), 'IV')
    frames(4)
    expect(reports).toHaveLength(0)
    // Opened: the lane is planned and asks for its window, which is a wait too.
    store.update(id, { status: 'ready' })
    frames(3)
    expect(answers.length).toBeGreaterThan(0)
    expect(reports).toHaveLength(0)
    for (const answer of answers.splice(0)) answer({ basesPerPixel: 1, regions: [], extent: null })
    for (let turn = 0; turn < 4; turn++) await Promise.resolve()
    frames(2)
    expect(reports).toHaveLength(1)
    expect(reports[0].lanes).toBeGreaterThan(0)
  })

  it('says a refusal on screen is what was drawn', () => {
    const map = panel()
    map.setBusy(true)
    map.noteRendered('error', 'no sequence called XVII')
    map.setBusy(false)
    frames(2)
    expect(reports[0]).toMatchObject({ status: 'error', note: 'no sequence called XVII' })
  })

  it('stops counting once it is destroyed', () => {
    const map = panel()
    map.setBusy(true)
    map.destroy()
    built.splice(built.indexOf(map), 1)
    frames()
    // The veil it left up holds nothing back: the report that follows says the
    // page has nothing on it, rather than never coming.
    expect(reports).toHaveLength(1)
    expect(reports[0].maps).toEqual([])
  })
})
