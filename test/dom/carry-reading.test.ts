// @vitest-environment jsdom
/**
 * A track still reading goes with the file to another resolution (§8.6).
 *
 * A change of resolution carries the tracks to the new rung, and it carried the
 * loaded ones alone. A row is remembered only once it has loaded, and the old
 * file's worker is put down under it, so a row on its way was in neither list:
 * a workspace seats its tracks reading, and a reader who picked another
 * resolution in the second or two after a store's session opened — which is
 * what the tutorial's fourth step asks for (§30) — lost every one of them, at
 * the new rung and for good.
 *
 * Pinned on the session's own rule, with its store real and everything else it
 * reads reduced to nothing, because the race itself needs a worker reading a
 * remote file and a reader quicker than the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationEntry } from '@/annotations/types'
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

/** The two private members the rule is read through. */
interface Innards {
  file: unknown
  annotations: unknown
  carried: readonly AnnotationEntry[] | null
  carry(next: string): void
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

function track(store: AnnotationStore, name: string): AnnotationEntry {
  return store.begin({
    card: 'linear',
    kind: 'track',
    source: { kind: 'remote', url: `https://bucket.example.org/${name}`, name },
    label: name,
  })
}

describe('a change of resolution', () => {
  it('carries the rows still reading as well as the ones that have loaded', () => {
    const session = new Session(host)
    built.push(session)
    const inside = session as unknown as Innards
    const store = new AnnotationStore('rep1.mcool', { persist: false })
    const loaded = track(store, 'compartments.bw')
    store.update(loaded.id, { status: 'ready' })
    // Begun and not yet read: what a workspace's tracks are for the second or
    // two after its map opens.
    track(store, 'insulation.bw')
    const failed = track(store, 'gone.bw')
    store.update(failed.id, { status: 'error', error: 'HTTP 404' })
    inside.annotations = { store, manual: { marks: [] }, client: { destroy: () => {} } }
    inside.file = { uri: 'rep1.mcool::resolutions/25000', info: { binsize: 25_000 } }

    inside.carry('rep1.mcool::resolutions/250000')

    // The failed row stays behind, as it always has: there is nothing at its
    // address to read again, and carrying it would draw the same refusal twice.
    expect(inside.carried?.map((entry) => entry.label)).toEqual(['compartments.bw', 'insulation.bw'])
    expect(inside.carried?.map((entry) => entry.status)).toEqual(['ready', 'loading'])
  })

  it('carries nothing a detached row could be read from', () => {
    const session = new Session(host)
    built.push(session)
    const inside = session as unknown as Innards
    const store = new AnnotationStore('rep1.mcool', { persist: false })
    const kept = track(store, 'local.bw')
    store.update(kept.id, { status: 'detached' })
    inside.annotations = { store, manual: { marks: [] }, client: { destroy: () => {} } }
    inside.file = { uri: 'rep1.mcool::resolutions/25000', info: { binsize: 25_000 } }

    inside.carry('rep1.mcool::resolutions/250000')

    expect(inside.carried).toBeNull()
  })
})
