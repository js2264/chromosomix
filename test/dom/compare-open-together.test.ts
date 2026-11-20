// @vitest-environment jsdom
/**
 * A comparison's two maps open side by side, each with its read plan (§11, §6.1).
 *
 * The second map used to wait for the first: it was opened once the first file
 * had landed, its contigs had been read and the view had rendered, so the
 * landing page's *Comparing data* drew its lower triangle a second and a half
 * after the upper one — two walks of a dozen dependent reads, one after the
 * other. Its open now starts beside the first one's, and both carry the plan
 * the example ships with, so the two walks run at once, each out of its own
 * cache.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionHost } from '@/app/Session'
import { SessionCompare } from '@/app/SessionCompare'
import type { ViewState } from '@/types'
import { CHICKEN_G2, CHICKEN_MITOSIS, COMPARISON_REGION } from '@/ui/exampleSessions'
import { setUpDom, type DomTeardown } from '../support/dom'

/** A worker that keeps what it is sent and never answers. */
class HeldWorker {
  static made: HeldWorker[] = []
  readonly sent: unknown[] = []
  onmessage: unknown = null
  onerror: unknown = null
  terminated = false
  constructor() {
    HeldWorker.made.push(this)
  }
  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  terminate(): void {
    this.terminated = true
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown
const built: Session[] = []

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = HeldWorker
  HeldWorker.made = []
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const session of built.splice(0, built.length)) session.destroy()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
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

interface OpenAsked {
  kind: 'open'
  uri: string
  source: { kind: string; plan?: { size: number; ranges: Array<[number, number]> } }
}

/** Every `open` any worker has been sent, in the order the workers were made. */
function opens(): OpenAsked[] {
  return HeldWorker.made.flatMap((worker) =>
    worker.sent.filter((message): message is OpenAsked => (message as { kind?: string }).kind === 'open'),
  )
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

describe('a comparison opened from its address', () => {
  it('opens its second map beside the first, before the first has answered', async () => {
    const session = new Session(host)
    built.push(session)
    session.navigate({
      uri: `${CHICKEN_G2}::resolutions/100000`,
      uri2: `${CHICKEN_MITOSIS}::resolutions/100000`,
      view: 'region',
      region: COMPARISON_REGION,
    } as ViewState)
    await settle()
    // Nothing has answered — the workers here never do — and both are opening.
    const asked = opens()
    expect(asked.map((open) => open.uri)).toEqual([
      `${CHICKEN_G2}::resolutions/100000`,
      `${CHICKEN_MITOSIS}::resolutions/100000`,
    ])
    // …each with the plan Comparing data ships with, made on its own file.
    expect(asked.map((open) => open.source.plan?.size)).toEqual([687217751, 890233974])
    // The plan is the open's walk and the window's block, merged.
    for (const open of asked) expect(open.source.plan?.ranges.length).toBeGreaterThan(5)
  })

  it('puts the second map’s open down with the session', async () => {
    const session = new Session(host)
    built.push(session)
    session.navigate({
      uri: `${CHICKEN_G2}::resolutions/100000`,
      uri2: `${CHICKEN_MITOSIS}::resolutions/100000`,
      view: 'region',
      region: COMPARISON_REGION,
    } as ViewState)
    await settle()
    const second = HeldWorker.made.find((worker) =>
      worker.sent.some((message) => (message as OpenAsked).uri === `${CHICKEN_MITOSIS}::resolutions/100000`),
    )
    expect(second).toBeDefined()
    session.destroy()
    built.splice(built.indexOf(session), 1)
    expect(second?.terminated).toBe(true)
  })

  it('opens one map alone where the address names one', async () => {
    const session = new Session(host)
    built.push(session)
    session.navigate({ uri: `${CHICKEN_G2}::resolutions/100000`, view: 'region', region: COMPARISON_REGION } as ViewState)
    await settle()
    expect(opens().map((open) => open.uri)).toEqual([`${CHICKEN_G2}::resolutions/100000`])
  })
})

describe('the second map’s early open', () => {
  /** As much of a session as the comparison asks of one before anything is open. */
  function compareOf(): SessionCompare {
    const session = {
      destroyed: false,
      file: null,
      store: { state: { uri: `${CHICKEN_G2}::resolutions/100000` }, patch: () => {} },
      compareCard: null,
      infoPanel: null,
      memoryKey: (uri: string) => uri,
    }
    return new SessionCompare(session as unknown as Session)
  }

  it('outlives the drop of the comparison its file replaces, which runs once that file has opened', () => {
    const compare = compareOf()
    compare.prefetch(`${CHICKEN_MITOSIS}::resolutions/100000`, COMPARISON_REGION)
    const worker = HeldWorker.made.at(-1)
    expect(worker?.sent).toHaveLength(1)
    // `Session.setUpAnnotations` puts the old file's comparison down once the
    // new file is open — after this open began, and before it is taken over.
    compare.drop()
    expect(worker?.terminated).toBe(false)
    // Asked again for the same file, it is the same open, not a second one.
    compare.prefetch(`${CHICKEN_MITOSIS}::resolutions/100000`, COMPARISON_REGION)
    expect(HeldWorker.made.at(-1)).toBe(worker)
  })

  it('goes when the state stops naming the file, or names another', () => {
    const compare = compareOf()
    compare.prefetch(`${CHICKEN_MITOSIS}::resolutions/100000`, COMPARISON_REGION)
    const first = HeldWorker.made.at(-1)
    compare.reconcile({ uri: `${CHICKEN_G2}::resolutions/100000`, view: 'region', region: COMPARISON_REGION } as ViewState)
    expect(first?.terminated).toBe(true)

    compare.prefetch(`${CHICKEN_MITOSIS}::resolutions/100000`, COMPARISON_REGION)
    const second = HeldWorker.made.at(-1)
    compare.prefetch(`${CHICKEN_G2}::resolutions/100000`, COMPARISON_REGION)
    expect(second?.terminated).toBe(true)
    compare.release()
    expect(HeldWorker.made.at(-1)?.terminated).toBe(true)
  })

  it('is not started for a file no page can open again by name', () => {
    const compare = compareOf()
    compare.prefetch('rep2.mcool::/resolutions/100000', COMPARISON_REGION)
    expect(HeldWorker.made).toHaveLength(0)
  })
})
