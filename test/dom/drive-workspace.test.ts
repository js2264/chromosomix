// @vitest-environment jsdom
/**
 * A workspace in a Drive folder or a Dropbox opens as one, by the name the
 * folder listed it under (§24.9).
 *
 * Both backends hand back an address that does not end in the file's name — a
 * Drive file is `…/files/<id>?alt=media`, a Dropbox one a temporary link — and
 * the session's add road decided *workspace* by the address alone, so a
 * `session.json` picked from either was taken for a track. What is asserted is
 * where the bytes go: to the shell as a workspace, under its name and with the
 * address it was found at, and not to the tracks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { setUpDom, type DomTeardown } from '../support/dom'

class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const DRIVE = 'https://www.googleapis.com/drive/v3/files/1pq7NDWoDdEJNTTOZEnhoKYYrr66zzD7?alt=media&supportsAllDrives=true'
const DROPBOX = 'https://uc0f2a.dl.dropboxusercontent.com/apitl/1/AbCdEf'
const WORKSPACE = '{"kind":"chromosomix.workspace","version":1,"active":0,"tabs":[]}'

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
  vi.unstubAllGlobals()
  teardown()
  window.sessionStorage.clear()
})

/** A session whose shell records the workspaces it is handed, and whose loads are only recorded. */
function session(): { session: Session; workspaces: Array<[string, string, string | undefined]>; opened: string[] } {
  const workspaces: Array<[string, string, string | undefined]> = []
  const host: SessionHost = {
    sessionChanged: () => {},
    stateChanged: () => {},
    panelsChanged: () => {},
    openFileDialog: () => {},
    openStore: () => {},
    openConnect: () => {},
    folderConnected: () => {},
    openWorkspaceFile: (text, label, base) => {
      workspaces.push([text, label, base])
    },
    panelLayout: () => ({}) as never,
    applyPanelLayout: () => {},
    notify: () => {},
    withdrawNotice: () => {},
    activity: () => {},
    landingFileOpened: () => {},
  }
  const made = new Session(host)
  built.push(made)
  const opened: string[] = []
  // Every other road a file takes ends here, and none of them should be taken.
  ;(made as unknown as { open(uri: string): Promise<void> }).open = (uri) => {
    opened.push(uri)
    return Promise.resolve()
  }
  return { session: made, workspaces, opened }
}

describe('a workspace whose address is not its name', () => {
  it('opens from a Drive folder as a workspace, under the name the folder gave it', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url)
      return Promise.resolve(new Response(WORKSPACE, { status: 200 }))
    })
    const { session: tab, workspaces, opened } = session()
    await tab.addRemote(DRIVE, { kind: 'remote', url: DRIVE }, undefined, undefined, 'Yeast_microC.chromosomix.json')
    expect(fetched).toEqual([DRIVE])
    expect(workspaces).toEqual([[WORKSPACE, 'Yeast_microC.chromosomix.json', DRIVE]])
    expect(opened).toEqual([])
  })

  it('and from a Dropbox, whose temporary link says nothing either', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(WORKSPACE, { status: 200 })))
    const { session: tab, workspaces } = session()
    await tab.addRemote(DROPBOX, { kind: 'remote', url: DROPBOX }, undefined, undefined, 'workspace.json')
    expect(workspaces.map(([, label]) => label)).toEqual(['workspace.json'])
  })

  it('leaves a file the name does not call a workspace to the file roads', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { session: tab, workspaces, opened } = session()
    // An empty tab: the file fills it, through `open`, which is recorded.
    await tab.addRemote(DRIVE, { kind: 'remote', url: DRIVE }, undefined, undefined, 'HFF_1kb.mcool')
    expect(workspaces).toEqual([])
    expect(opened).toEqual([DRIVE])
    expect(fetch).not.toHaveBeenCalled()
  })
})
