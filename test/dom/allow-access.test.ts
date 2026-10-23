// @vitest-environment jsdom
/**
 * *allow access*: the button a tab waiting for a remembered local file offers
 * once its grant has lapsed to "ask first" (§5.6).
 *
 * After a restart Chromium keeps the grant and asks again before handing the
 * file over, and asking needs a click. The button is that click: present only
 * where this browser holds a grant for the file, and when the reader allows it
 * the tab is rendered again and finds the file without being asked to find it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { forgetAllHandles, rememberHandle, resetHandlesForTests } from '@/state/handles'
import { useMemoryStores } from '@/state/idb'
import type { ViewState } from '@/types'
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

beforeEach(async () => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  window.sessionStorage.clear()
  useMemoryStores()
  resetHandlesForTests()
  ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () => undefined
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
  await forgetAllHandles()
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

/** A handle as Chromium hands one back after a restart: known, and waiting for a click. */
function lapsedHandle(name: string, answer: PermissionState = 'granted'): FileSystemFileHandle {
  let state: PermissionState = 'prompt'
  return {
    kind: 'file',
    name,
    queryPermission: async () => state,
    requestPermission: vi.fn(async () => {
      state = answer
      return state
    }),
    getFile: async () => new File(['bytes'], name),
  } as unknown as FileSystemFileHandle
}

const waiting: ViewState = { uri: 'rep1.cool', view: 'region', region: 'IV:1000000-1400000' } as ViewState

/** A tab on screen, waiting for `rep1.cool`, whose renders are only counted. */
function waitingTab(): { session: Session; renders: ViewState[] } {
  const session = new Session(host)
  built.push(session)
  const renders: ViewState[] = []
  ;(session as unknown as { render(state: ViewState | null): Promise<void> }).render = async (state) => {
    if (state !== null) renders.push(state)
  }
  session.store.adopt(waiting)
  return { session, renders }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const allowButton = (root: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((node) =>
    (node.textContent ?? '').startsWith('allow access'),
  )

describe('the picker asking for a remembered file', () => {
  it('offers allow access where this browser holds a grant for the file', async () => {
    await rememberHandle('rep1.cool', lapsedHandle('rep1.cool'), new File(['b'], 'rep1.cool'))
    const { session } = waitingTab()
    const page = session.pickerWithNote('rep1.cool')
    const button = allowButton(page)
    expect(button?.textContent).toBe('allow access to rep1.cool')
    expect(page.textContent).toContain('only needs your permission to read it again')
    // In place of the red note, which said no page could re-open the file.
    expect(page.querySelector('.inline-error')).toBeNull()
  })

  it('counts every remembered file on the button, which asks for all of them', async () => {
    const map = lapsedHandle('rep1.cool')
    const track = lapsedHandle('ATAC.bw')
    await rememberHandle('rep1.cool', map, new File(['b'], 'rep1.cool'))
    await rememberHandle('ATAC.bw', track, new File(['b'], 'ATAC.bw'))
    const { session, renders } = waitingTab()
    const page = session.pickerWithNote('rep1.cool')
    const button = allowButton(page)
    expect(button?.textContent).toBe('allow access to all 2 files')
    expect(page.textContent).toContain('rep1.cool and 1 other file, and only needs your permission to read them again')
    expect(button?.title).toContain('rep1.cool, ATAC.bw')
    button?.click()
    await settle()
    await settle()
    expect(map.requestPermission).toHaveBeenCalledTimes(1)
    expect(track.requestPermission).toHaveBeenCalledTimes(1)
    expect(renders.map((state) => state.uri)).toEqual(['rep1.cool'])
  })

  it('offers nothing where there is no grant — every file in Firefox and Safari', () => {
    const { session } = waitingTab()
    const page = session.pickerWithNote('rep1.cool')
    expect(allowButton(page)).toBeUndefined()
    expect(page.querySelector('.inline-error')?.textContent).toContain('it names a local file')
  })

  it('renders the tab again once the reader allows it, which finds the file', async () => {
    const handle = lapsedHandle('rep1.cool')
    await rememberHandle('rep1.cool', handle, new File(['b'], 'rep1.cool'))
    const { session, renders } = waitingTab()
    allowButton(session.pickerWithNote('rep1.cool'))?.click()
    await settle()
    expect(handle.requestPermission).toHaveBeenCalledTimes(1)
    expect(renders.map((state) => state.uri)).toEqual(['rep1.cool'])
  })

  it('leaves a tab restored and never looked at alone, so allowing one does not open them all', async () => {
    await rememberHandle('rep1.cool', lapsedHandle('rep1.cool'), new File(['b'], 'rep1.cool'))
    const { session } = waitingTab()
    const background = new Session(host)
    built.push(background)
    const renders: ViewState[] = []
    ;(background as unknown as { render(state: ViewState | null): Promise<void> }).render = async (state) => {
      if (state !== null) renders.push(state)
    }
    background.prime(waiting)
    allowButton(session.pickerWithNote('rep1.cool'))?.click()
    await settle()
    expect(renders).toEqual([])
  })

  it('keeps the button, and says so, when the reader dismisses the prompt', async () => {
    await rememberHandle('rep1.cool', lapsedHandle('rep1.cool', 'prompt'), new File(['b'], 'rep1.cool'))
    const { session, renders } = waitingTab()
    const page = session.pickerWithNote('rep1.cool')
    const button = allowButton(page)
    button?.click()
    await settle()
    expect(renders).toEqual([])
    expect(button !== undefined && page.contains(button)).toBe(true)
    expect(button?.disabled).toBe(false)
    expect(page.textContent).toContain('The browser did not allow it.')
  })
})
