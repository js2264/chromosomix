// @vitest-environment jsdom
/**
 * A file dropped on the page that is waiting for it opens the map the waiting
 * view named inside it.
 *
 * A link or a workspace naming a local file — `map.mcool::/resolutions/25000`,
 * a `.hic` at 4 kb — lands on a page asking for that file to be dropped, and
 * promising the rest of its view back when it is (`pickerWithNote`). A dropped
 * file is named by its path alone, so it was opened at its root: an `.mcool`
 * landed on a rung of its own choosing and the view was traded for its
 * Chromosomes table. What is asserted is the address the open is given, from
 * both doors a drop on that page comes through — one file, and the map with a
 * track beside it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import type { ViewState } from '@/types'
import type { SourceSpec } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

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

/** A session waiting for `waiting`'s file, whose opens and track drops are only recorded. */
function waitingFor(waiting: ViewState): { session: Session; opened: string[]; tracks: string[] } {
  const session = new Session(host)
  built.push(session)
  const opened: string[] = []
  const tracks: string[] = []
  const inside = session as unknown as {
    render(state: ViewState | null): Promise<void>
    dropped(file: File): void
  }
  inside.render = () => Promise.resolve()
  inside.dropped = (file) => {
    tracks.push(file.name)
  }
  session.open = async (uri: string, _source: SourceSpec) => {
    opened.push(uri)
  }
  session.store.adopt(waiting)
  return { session, opened, tracks }
}

const region = { view: 'region', region: 'IV:1000000-1400000' } as const

describe('a file dropped on the page waiting for it', () => {
  it('opens the rung the waiting view named, the map dropped with a track', async () => {
    const { session, opened, tracks } = waitingFor({ uri: 'map.hic::/resolutions/4000', ...region } as ViewState)
    await session.openFiles([new File(['x'], 'map.hic'), new File(['y'], 'atac.bw')])
    expect(opened).toEqual(['map.hic::/resolutions/4000'])
    expect(tracks).toEqual(['atac.bw'])
  })

  it('opens it the same way when the map is dropped alone', async () => {
    const { session, opened } = waitingFor({ uri: 'map.mcool::/resolutions/25000', ...region } as ViewState)
    await session.openFiles([new File(['x'], 'map.mcool')])
    expect(opened).toEqual(['map.mcool::/resolutions/25000'])
  })

  it('opens another file by its own name', async () => {
    const { session, opened } = waitingFor({ uri: 'map.mcool::/resolutions/25000', ...region } as ViewState)
    await session.openFiles([new File(['x'], 'other.mcool')])
    expect(opened).toEqual(['other.mcool'])
  })
})
