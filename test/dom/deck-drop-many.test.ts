// @vitest-environment jsdom
/**
 * Several coolers dropped at once make a deck of every one of them (§16.6).
 *
 * `openFiles` opens the first and adds the rest one after another, and every add
 * publishes: the view state goes `~`, `~|~`, … — and each of those is a render
 * of its own, which waits for the grants that might re-open a local map before
 * it reconciles the deck. A dropped file has no grant, and all of those renders
 * came back after the last map had been added: the render of `~` shrank a deck
 * of seven companions to one, and the ones after it grew it back from the
 * stored record — as cells reading *this cell held that file and it could not be
 * re-opened*, about files the deck had been holding a moment before. Eight maps
 * dropped on a new tab gave two or three maps and five or six empty cells.
 *
 * The session is real and so is its deck; the render is cut down to the one
 * step under test — the deck's reconciliation — because the rest of it mounts
 * a view, which needs a file the worker has read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PanelDeck } from '@/panels/PanelDeck'
import { Session, type SessionHost } from '@/app/Session'
import type { ViewState } from '@/types'
import { all, setUpDom, type DomTeardown } from '../support/dom'

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

/** The private doors a dropped companion comes in through. */
interface Innards {
  file: unknown
  /** The session's deck (`SessionDeck`), and the panels it has built, if any. */
  deck: { grid: PanelDeck | null }
  addCompanion(file: File): void
  render(state: ViewState | null): Promise<void>
  syncDeck(state: ViewState): Promise<void>
}

/**
 * A session with one cooler open, whose renders do only what reconciles the
 * deck — and keep hold of each one, so the test can wait for all of them.
 */
function opened(): { session: Session; inside: Innards; renders: Array<Promise<void>> } {
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
  const renders: Array<Promise<void>> = []
  inside.render = (state) => {
    if (state === null) return Promise.resolve()
    const pending = inside.syncDeck(state)
    renders.push(pending)
    return pending
  }
  session.store.adopt({ uri: 'rep1.cool', view: 'region', region: 'I' } as ViewState)
  return { session, inside, renders }
}

describe('dropping several coolers', () => {
  it('keeps every one of them live, however late the renders of the adds come back', async () => {
    const { session, inside, renders } = opened()
    // `openFiles`' loop: one companion after another, each publishing.
    for (let n = 2; n <= 8; n++) inside.addCompanion(new File(['x'], `rep${n}.cool`))
    expect(session.store.state?.maps).toBe('~|~|~|~|~|~|~')
    // Every add was a render, and none of them has reached the deck yet.
    expect(renders).toHaveLength(7)
    await Promise.all(renders)
    const deck = inside.deck.grid
    if (deck === null) throw new Error('no deck')
    expect(deck.companionMaps().map((map) => map.label)).toEqual([
      'rep2.cool',
      'rep3.cool',
      'rep4.cool',
      'rep5.cool',
      'rep6.cool',
      'rep7.cool',
      'rep8.cool',
    ])
    expect(deck.el.textContent).not.toContain('could not be re-opened')
    expect(all(deck.el, '.deck-vacant')).toHaveLength(0)
  })

  it('still reconciles against the state in force', async () => {
    // The guard is on a render the store has moved past, not on the deck's
    // reading of the hash: a state that names fewer maps, and is the one in
    // force, still closes the cells it leaves out.
    const { session, inside, renders } = opened()
    for (let n = 2; n <= 4; n++) inside.addCompanion(new File(['x'], `rep${n}.cool`))
    await Promise.all(renders)
    session.store.set({ uri: 'rep1.cool', view: 'region', region: 'I', maps: '~' } as ViewState)
    await Promise.all(renders)
    expect(inside.deck.grid?.companionMaps().map((map) => map.label)).toEqual(['rep2.cool'])
  })
})
