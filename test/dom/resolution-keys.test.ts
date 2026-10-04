// @vitest-environment jsdom
/**
 * `-` and `+` walk the resolution bar (§3.4), one stop at a time.
 *
 * They are the bar's stops asked for from the keyboard, so what is pinned is
 * that they are the *same* stops: counted from the one that is lit, a derived
 * rung among them where the reader added one, stopping at both ends rather than
 * wrapping, and taking the road a press on the stop takes — the file re-opened
 * at a stored rung, the hash patched for one the reader added. And that they
 * say where they go, as `[` and `]` do, and why not where they cannot.
 *
 * The session is real; the file is a stand-in with only what the ladder reads,
 * and `open` is caught rather than sent to a worker, because what a step *asks
 * for* is the whole of what is under test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { KEYS, type Command } from '@/ui/commands'
import type { ResolutionStore } from '@/state/resolutions'
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
  render(state: ViewState | null): Promise<void>
  resolutionStore(): ResolutionStore | null
}

/** What a step asked the session to open. */
interface Opened {
  uri: string
  carry: ViewState | undefined
}

/**
 * A session standing on one rung of a `1 / 2 / 5 / 10 kb` `.mcool` — or on the
 * one rung of a plain `.cool` — in a region view, with its opens caught.
 */
function standingOn(
  entry: string,
  options: { entries?: string[]; view?: ViewState['view']; coarsen?: number } = {},
): { session: Session; inside: Innards; opened: Opened[] } {
  const entries = options.entries ?? ['1000', '2000', '5000', '10000']
  const session = new Session(host)
  built.push(session)
  const inside = session as unknown as Innards
  const uri = entries.length === 0 ? 'sample.cool' : `sample.mcool::resolutions/${entry}`
  inside.file = {
    uri,
    source: { kind: 'local', file: new File(['x'], entries.length === 0 ? 'sample.cool' : 'sample.mcool') },
    info: {
      hasGenomes: false,
      binsize: Number(entry),
      hasWeights: false,
      layout: { kind: 'cool' },
      entries,
      entryGroup: entries.length === 0 ? '' : 'resolutions',
    },
    contigs: null,
    entries,
    ...(entries.length === 0 ? {} : { currentEntry: entry }),
  }
  // Nothing mounts: a render would need a file the worker had read.
  inside.render = () => Promise.resolve()
  const opened: Opened[] = []
  session.open = (to: string, _source: unknown, carry?: ViewState) => {
    opened.push({ uri: to, carry })
    return Promise.resolve()
  }
  session.store.adopt({
    uri,
    view: options.view ?? 'region',
    region: 'I',
    ...(options.coarsen === undefined ? {} : { coarsen: options.coarsen }),
  } as ViewState)
  return { session, inside, opened }
}

const step = (session: Session, id: 'resolution-coarser' | 'resolution-finer'): Command => {
  const found = session.commands().find((command) => command.id === id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}

describe('the two resolution keys', () => {
  it('are bound to − and +, and named for where they go', () => {
    const { session } = standingOn('2000')
    const coarser = step(session, 'resolution-coarser')
    const finer = step(session, 'resolution-finer')
    expect([coarser.keys, finer.keys]).toEqual([KEYS.coarser, KEYS.finer])
    expect([coarser.title, finer.title]).toEqual(['Coarser resolution', 'Finer resolution'])
    expect([coarser.group, finer.group]).toEqual(['View', 'View'])
    // The rung each goes to, as `[` and `]` name the sequence.
    expect([coarser.enabled, coarser.hint]).toEqual([true, '5 kb'])
    expect([finer.enabled, finer.hint]).toEqual([true, '1 kb'])
  })

  it('open the file at the next stored rung, coarser or finer', () => {
    const { session, opened } = standingOn('2000')
    step(session, 'resolution-coarser').run()
    step(session, 'resolution-finer').run()
    expect(opened.map((one) => one.uri)).toEqual([
      'sample.mcool::resolutions/5000',
      'sample.mcool::resolutions/1000',
    ])
    // The place on screen travels; a resolution the reader added does not.
    expect(opened[0]?.carry?.region).toBe('I')
    expect(opened[0]?.carry?.coarsen).toBeUndefined()
  })

  it('stop at both ends, saying why — and where to get a coarser one', () => {
    const finest = standingOn('1000').session
    expect(step(finest, 'resolution-finer').enabled).toBe(false)
    expect(step(finest, 'resolution-finer').hint).toBe('Already the finest resolution this file stores.')
    expect(step(finest, 'resolution-coarser').enabled).toBe(true)

    const { session, opened } = standingOn('10000')
    const coarser = step(session, 'resolution-coarser')
    expect(coarser.enabled).toBe(false)
    expect(coarser.hint).toBe('Already the coarsest — the + beside the resolution adds a coarser one.')
    coarser.run()
    expect(opened).toEqual([])
  })

  it('walk onto a rung the reader added, and off it again, as its stop does', () => {
    const { session, inside, opened } = standingOn('10000')
    // 20 kb is two of the file's own 10 kb bins.
    inside.resolutionStore()?.add(20_000)
    const coarser = step(session, 'resolution-coarser')
    expect([coarser.enabled, coarser.hint]).toEqual([true, '20 kb*'])
    coarser.run()
    // Pooled from the rung that is open: the hash, not a re-open.
    expect(session.store.state?.coarsen).toBe(20_000)
    expect(opened).toEqual([])
    // Standing on it, the key counts from it — the lit stop — and not from the
    // 10 kb entry the file is open at underneath.
    expect(step(session, 'resolution-coarser').enabled).toBe(false)
    expect(step(session, 'resolution-finer').hint).toBe('10 kb')
    step(session, 'resolution-finer').run()
    expect(session.store.state?.coarsen).toBeUndefined()
    expect(opened).toEqual([])
  })

  it('reach a rung the reader added between two of the file’s, from either side', () => {
    const { session, inside } = standingOn('2000')
    inside.resolutionStore()?.add(3_000)
    // 3 kb is three 1 kb bins, which sorts it between 2 kb and 5 kb.
    expect(step(session, 'resolution-coarser').hint).toBe('3 kb*')
  })

  it('say a file of one resolution has only the + to offer', () => {
    const { session } = standingOn('1000', { entries: [] })
    expect(step(session, 'resolution-coarser').enabled).toBe(false)
    expect(step(session, 'resolution-coarser').hint).toBe(
      'This file stores one resolution — the + beside it adds a coarser one.',
    )
    expect(step(session, 'resolution-finer').enabled).toBe(false)
  })

  it('have nothing to step with the map put away for its tracks', () => {
    const { session } = standingOn('2000', { view: 'browser' })
    expect(step(session, 'resolution-coarser').enabled).toBe(false)
    expect(step(session, 'resolution-finer').enabled).toBe(false)
    expect(step(session, 'resolution-coarser').hint).toBeUndefined()
  })
})
