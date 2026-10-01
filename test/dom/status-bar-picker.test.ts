// @vitest-environment jsdom
/**
 * The status bar over a tab with no file open (§6.3, §12).
 *
 * *read* and *validation* are about a file, and are absent while none is open.
 * The bar decides that by whether the tab hands it a reader — and the picker
 * starts its reader before anything is chosen, so the first file opens without
 * waiting for h5wasm (§6.1). A tab switched back to while it showed the picker
 * therefore handed the bar a worker with no file in it: both items came back,
 * a byte counter of nothing and a check that failed on the press, there being
 * nothing to scan. The tab hands the bar a reader only while a file is open.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { StatusBar } from '@/ui/StatusBar'
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
const bars: StatusBar[] = []

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  window.sessionStorage.clear()
})

afterEach(() => {
  for (const bar of bars.splice(0)) bar.destroy()
  for (const session of built.splice(0)) session.destroy()
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
  activity: () => {},
  landingFileOpened: () => {},
}

/** The private doors: the warm-up's own call, and the open file it is waiting for. */
interface Innards {
  file: unknown
  clientOf(): unknown
}

/** Whether the item the bar labels `word` is on it. */
function shown(bar: StatusBar, word: string): boolean {
  const key = all<HTMLElement>(bar.el, '.status-key').find((node) => node.textContent === word)
  const item = key?.closest('.status-item')
  if (item === null || item === undefined) throw new Error(`no ${word} item`)
  return !item.classList.contains('hidden')
}

describe('a tab on the picker', () => {
  it('hands the bar no reader, however warm its worker, and one once a file is open', () => {
    const session = new Session(host)
    built.push(session)
    const inside = session as unknown as Innards
    // What `warmReader` does once the page is idle: the worker, and no file.
    const warmed = inside.clientOf()
    expect(warmed).not.toBeNull()
    expect(session.client).toBeNull()

    const bar = new StatusBar({ client: () => session.client })
    bars.push(bar)
    bar.refresh()
    expect(shown(bar, 'read')).toBe(false)
    expect(shown(bar, 'validation')).toBe(false)

    // A file arrives; the same reader is now the file's, and the bar counts it.
    inside.file = { uri: 'rep1.cool', info: { layout: { kind: 'cool' } } }
    expect(session.client).toBe(warmed)
    bar.refresh()
    expect(shown(bar, 'read')).toBe(true)
    expect(shown(bar, 'validation')).toBe(true)
  })

  it('cannot run a check from the bar with nothing open', () => {
    const session = new Session(host)
    built.push(session)
    ;(session as unknown as Innards).clientOf()
    const bar = new StatusBar({ client: () => session.client })
    bars.push(bar)
    bar.refresh()
    const validation = bar.el.querySelector<HTMLButtonElement>('.status-action')
    validation?.click()
    // Nothing started: no *running*, and no *failed* from a worker with no file.
    expect(validation?.textContent).toContain('never run')
  })
})
