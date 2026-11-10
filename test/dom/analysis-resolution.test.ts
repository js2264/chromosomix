// @vitest-environment jsdom
/**
 * The resolution an analysis of the lead map is run at (§3.4, §18.4): the one
 * the crumb row names.
 *
 * A pick is read in place — the file stays open at the entry it was opened at,
 * and the views read the picked rung beside it — so the open entry stopped
 * being the resolution a reader is looking at, and a task framed on it measured
 * a map nobody had asked for. What is pinned is the address and the grid a task
 * is handed: the picked rung's own entry and bins with *Refine on zoom* off, a
 * resolution the reader added summed from the rung it is made of, the rung the
 * block on screen was read from while the zoom picks — and the open map, as
 * before, wherever the row names it.
 *
 * The session is real; the file is a stand-in with only what the grid reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import type { ResolutionStore } from '@/state/resolutions'
import { REFINE_DEFAULT, setRefineEnabled } from '@/ui/refine'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

/** A worker that is created, listened to, and never answers. */
class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown
const built: Session[] = []

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const session of built.splice(0, built.length)) session.destroy()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  setRefineEnabled(REFINE_DEFAULT)
  teardown()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

const host: SessionHost = {
  sessionChanged: () => {},
  stateChanged: () => {},
  panelsChanged: () => {},
  openFileDialog: () => {},
  openStore: () => {},
  openConnect: () => {},
  folderConnected: () => {},
  openWorkspaceFile: () => {},
  panelLayout: () => ({}) as never,
  applyPanelLayout: () => {},
  notify: () => {},
  withdrawNotice: () => {},
  activity: () => {},
  landingFileOpened: () => {},
}

interface Innards {
  file: unknown
  current: unknown
  render(state: ViewState | null): Promise<void>
  resolutionStore(): ResolutionStore | null
}

/** Two sequences, 1.25 Mb and 0.8 Mb: 2,050 bins at 1 kb, 82 at 25 kb. */
const LENGTHS = Float64Array.from([1_250_000, 800_000])

/**
 * A session on a `1 / 5 / 10 / 25 kb` `.mcool` opened at `entry`, in a region
 * view, its renders caught; `state` is spread into the view.
 */
function openAt(
  entry: string,
  state: Partial<ViewState> = {},
  options: { pairs?: boolean } = {},
): { session: Session; inside: Innards } {
  const entries = ['1000', '5000', '10000', '25000']
  const session = new Session(host)
  built.push(session)
  const inside = session as unknown as Innards
  const binsize = Number(entry)
  const uri = `sample.mcool::resolutions/${entry}`
  inside.file = {
    uri,
    source: { kind: 'local', file: new File(['x'], 'sample.mcool') },
    info: {
      hasGenomes: false,
      binsize,
      nBins: Math.ceil(1_250_000 / binsize) + Math.ceil(800_000 / binsize),
      hasWeights: true,
      layout: { kind: 'cool' },
      entries,
      entryGroup: 'resolutions',
      ...(options.pairs === true ? { pairs: { binning: { base: binsize, rungs: 4 } } } : {}),
    },
    contigs: { table: { data: { name: ['chrA', 'chrB'], length: LENGTHS } } },
    entries,
    currentEntry: entry,
  }
  inside.render = () => Promise.resolve()
  session.store.adopt({ uri, view: 'region', region: 'chrA', ...state } as ViewState)
  return { session, inside }
}

/** The block the lead's panel holds, as a ladder left it. */
function drawing(inside: Innards, block: { binsize?: number } | null): void {
  inside.current = { panel: { block } }
}

describe('the resolution an analysis is run at', () => {
  describe('with *Refine on zoom* off', () => {
    beforeEach(() => setRefineEnabled(false))

    it('is the rung picked, read from its own entry, the file open where it was', () => {
      const { session } = openAt('1000', { resolution: 25_000 })
      const at = session.analysisAt()
      expect(at?.uri).toBe('sample.mcool::resolutions/25000')
      expect(at?.grid.binsize).toBe(25_000)
      expect(at?.grid.rung).toBe(25_000)
      expect(at?.grid.derived).toBeNull()
      // 50 and 32 bins: each sequence cut at 25 kb from its own start.
      expect(at?.nBins).toBe(82)
      // A block of the open map's bins carried onto the pick's: the last 10 kb
      // of the first sequence and the first 10 kb of the second are the last
      // 25 kb bin of the one and the first of the other.
      expect(at?.grid.carry([1_240, 1_260], 1_000)).toEqual([49, 51])
    })

    it('is a resolution the reader added, summed from the rung it is made of', () => {
      const { session, inside } = openAt('10000')
      // 2 kb is two of the 1 kb rung's bins — not the 10 kb rung the file is open at.
      inside.resolutionStore()?.add(2_000)
      session.store.patch({ coarsen: 2_000 })
      const at = session.analysisAt()
      expect(at?.uri).toBe('sample.mcool::resolutions/1000')
      expect(at?.grid.binsize).toBe(2_000)
      expect(at?.grid.rung).toBe(1_000)
      expect(at?.grid.derived?.rung.factor).toBe(2)
      expect(at?.nBins).toBe(625 + 400)
    })

    it('is the open map, as it always was, where nothing is picked', () => {
      const { session } = openAt('5000')
      expect(session.analysisAt()).toBeNull()
      // …and where the rung picked is the one open.
      session.store.patch({ resolution: 5_000 })
      expect(session.analysisAt()).toBeNull()
    })
  })

  describe('while the zoom picks', () => {
    beforeEach(() => setRefineEnabled(true))

    it('is the rung the block on screen was read from', () => {
      const { session, inside } = openAt('1000', { resolution: 25_000 })
      drawing(inside, { binsize: 10_000 })
      const at = session.analysisAt()
      // The pick is the reader's with the tick off; on, the zoom's rung wins.
      expect(at?.uri).toBe('sample.mcool::resolutions/10000')
      expect(at?.grid.binsize).toBe(10_000)
      expect(at?.nBins).toBe(125 + 80)
    })

    it('is the open map where the block is at its bins, or there is none', () => {
      const { session, inside } = openAt('1000')
      drawing(inside, { binsize: 1_000 })
      expect(session.analysisAt()).toBeNull()
      drawing(inside, {})
      expect(session.analysisAt()).toBeNull()
      drawing(inside, null)
      expect(session.analysisAt()).toBeNull()
    })
  })

  it('stays on the open map of an import, whose rungs are binned rather than stored', () => {
    setRefineEnabled(false)
    const { session } = openAt('1000', { resolution: 25_000 }, { pairs: true })
    expect(session.analysisAt()).toBeNull()
  })
})
