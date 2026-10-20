// @vitest-environment jsdom
/**
 * A page asking for a map's file starts the reader while the file is found.
 *
 * The picker starts its reader once the page is idle (`Session.warmReader`,
 * §6.1), so the first file dropped on it does not wait for the worker and
 * h5wasm. The picker asking for the map a workspace or a restored tab names —
 * a file on this machine, which no page can re-open by name — is the same
 * picker and was passed over: the file was dropped on a page with no reader,
 * and waited for one. A genome never needs it, and does not start it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { isRefusal, readTab } from '@/state/SessionConfig'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

/** A worker that is created, counted, and never answers. */
class CountedWorker {
  static made = 0
  onmessage: unknown = null
  onerror: unknown = null
  constructor() {
    CountedWorker.made += 1
  }
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
  ;(globalThis as Record<string, unknown>).Worker = CountedWorker
  CountedWorker.made = 0
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

function session(): Session {
  const made = new Session(host)
  built.push(made)
  return made
}

/** Past the idle the warm-up waits for: half a second where a page has no idle callback. */
function idle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600))
}

const MAP: ViewState = {
  uri: 'rep1.mcool::/resolutions/25000',
  view: 'region',
  region: 'chr1:1-1000000',
} as ViewState

describe('a page asking for a map’s file', () => {
  it('starts its reader while a workspace’s map is found', async () => {
    const tab = session()
    const config = readTab({ version: 1, state: MAP, tracks: [] })
    if (isRefusal(config)) throw new Error(`not a tab: ${JSON.stringify(config)}`)
    await tab.openConfig(config)
    expect(tab.contentEl.textContent).toContain('which is a local file')
    await idle()
    expect(CountedWorker.made).toBe(1)
  })

  it('starts its reader while a restored tab’s map is found', async () => {
    const tab = session()
    tab.navigate(MAP)
    await idle()
    expect(tab.contentEl.textContent).toContain('rep1.mcool')
    expect(CountedWorker.made).toBe(1)
  })

  it('starts none for a genome, which never reads through one', async () => {
    const tab = session()
    tab.navigate({ uri: 'genome.fa', view: 'browser', locus: 'chr1:1-1000' } as ViewState)
    await idle()
    expect(CountedWorker.made).toBe(0)
  })
})
