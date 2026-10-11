// @vitest-environment jsdom
/**
 * A render overtaken by a newer one stops, and a mount nobody finished is never
 * repainted in place (§5.5).
 *
 * Every change to the store starts a `render` that nobody awaits, and a render
 * awaits, so two interleave whenever the reader is quicker than the file. Two
 * ways that went wrong, each pinned here:
 *
 * - a colour change arriving while a region still waited on its contigs table
 *   took the repaint shortcut — `mounted` already named the region — and
 *   repainted the *outgoing* view; the region's own mount, overtaken, then bailed
 *   and nothing drew it;
 * - a second render of the *same* state object, which four callers start, was
 *   invisible to the store comparison and ran to the end beside the first.
 *
 * And the view a state names that this build does not have — which only a
 * stored workspace, a share link or a `?config=` file can bring — lands on the
 * file's first table rather than leaving the tab on "Opening…".
 *
 * The session is real; its mounts are stand-ins that record what they were
 * asked to draw, because a real one needs a file the worker has read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
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
})

afterEach(() => {
  for (const session of built.splice(0, built.length)) session.destroy()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
  window.sessionStorage.clear()
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

/** The private steps a render goes through, reached as the tests in this folder reach them. */
interface Innards {
  file: unknown
  current: { applyScale?: (scale: unknown) => void } | null
  mounted: ViewState | null
  rendering: AbortController
  stale(state: ViewState, signal: AbortSignal): boolean
  render(state: ViewState | null): Promise<void>
  syncDeck(state: ViewState): Promise<void>
  syncCells(state: ViewState): Promise<void>
  syncContacts(state: ViewState): void
  syncSequenceTicks(state: ViewState): void
  paintLevel(state: ViewState): void
  syncMinimap(state: ViewState): void
  rederive(): void
  mountRegion(state: ViewState): Promise<void>
  mountContigs(state: ViewState): Promise<void>
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * A session with one cooler open, every step around the mount reduced to
 * nothing, and the mounts recording what they were asked for.
 */
function opened(): { session: Session; inside: Innards; drawn: ViewState[]; tables: ViewState[] } {
  const session = new Session(host)
  built.push(session)
  document.body.append(session.contentEl)
  const inside = session as unknown as Innards
  inside.file = {
    uri: 'rep1.cool',
    source: { kind: 'local', file: new File(['x'], 'rep1.cool') },
    info: { hasGenomes: false, binsize: 1000, hasWeights: false, layout: { kind: 'cool' } },
    contigs: null,
  }
  inside.syncDeck = async () => {}
  inside.syncCells = async () => {}
  inside.syncContacts = () => {}
  inside.syncSequenceTicks = () => {}
  inside.paintLevel = () => {}
  inside.syncMinimap = () => {}
  inside.rederive = () => {}
  const drawn: ViewState[] = []
  const tables: ViewState[] = []
  inside.mountContigs = async (state) => {
    tables.push(state)
  }
  return { session, inside, drawn, tables }
}

/** Let every queued continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('a render overtaken by a newer one', () => {
  it('mounts the region a colour change arrived in the middle of, instead of repainting the old view', async () => {
    const { session, inside, drawn } = opened()
    const contigs = deferred()
    // The first region mount waits on its contigs table, as a real first visit
    // does; by the second the table is in hand. The stand-in keeps the real
    // mount's own checkpoint — the render's signal taken on the way in, `stale`
    // asked after the wait — because that is the half of the contract a mount
    // holds; this test is about the half `render` holds.
    let calls = 0
    inside.mountRegion = async (state) => {
      const signal = inside.rendering.signal
      calls += 1
      if (calls === 1) await contigs.promise
      if (inside.stale(state, signal)) return
      drawn.push(state)
    }
    // A view already on screen, which the repaint shortcut would paint.
    const repainted: unknown[] = []
    inside.current = { applyScale: (scale) => repainted.push(scale) }

    const region = { uri: 'rep1.cool', view: 'region', region: 'I' } as ViewState
    session.store.set(region)
    await settle()
    expect(drawn).toHaveLength(0)

    // A colour change: presentation only, which would be a repaint if the
    // region had finished mounting.
    session.store.patch({ vmax: 12 })
    await settle()
    expect(repainted).toHaveLength(0)
    expect(drawn.map((s) => s.vmax)).toEqual([12])

    // The overtaken mount then finishes its wait, and draws nothing.
    contigs.resolve()
    await settle()
    expect(drawn.map((s) => s.vmax)).toEqual([12])
    expect(inside.mounted?.vmax).toBe(12)
  })

  it('stops a render of the same state when another render of it starts', async () => {
    const { session, inside, drawn } = opened()
    const first = deferred()
    let calls = 0
    inside.mountRegion = async (state) => {
      const signal = inside.rendering.signal
      calls += 1
      if (calls === 1) await first.promise
      if (inside.stale(state, signal)) return
      drawn.push(state)
    }
    const region = { uri: 'rep1.cool', view: 'region', region: 'I' } as ViewState
    session.store.set(region)
    await settle()
    // The same object again, as `remount`, a tab coming back and a closed
    // compare card all ask: the store comparison cannot tell the two apart.
    void inside.render(region)
    await settle()
    first.resolve()
    await settle()
    // The second render drew; the first, overtaken while it waited, did not —
    // the store comparison alone would have let it draw the same state twice.
    expect(calls).toBe(2)
    expect(drawn).toHaveLength(1)
    expect(inside.mounted).toBe(region)
  })

  it('still repaints in place once the mount has finished', async () => {
    const { session, inside, drawn } = opened()
    inside.mountRegion = async (state) => {
      drawn.push(state)
    }
    session.store.set({ uri: 'rep1.cool', view: 'region', region: 'I' } as ViewState)
    await settle()
    const repainted: unknown[] = []
    inside.current = { applyScale: (scale) => repainted.push(scale) }
    session.store.patch({ vmax: 12 })
    await settle()
    expect(drawn).toHaveLength(1)
    expect(repainted).toHaveLength(1)
  })
})

describe('a view this build does not have', () => {
  it('lands on the file’s own table instead of leaving the tab opening', async () => {
    const { session, tables } = opened()
    session.store.set({ uri: 'rep1.cool', view: 'banana' } as unknown as ViewState)
    await settle()
    expect(session.store.state?.view).toBe('contigs')
    expect(tables.map((s) => s.view)).toEqual(['contigs'])
  })
})
