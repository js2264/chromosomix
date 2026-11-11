// @vitest-environment jsdom
/**
 * A FASTA dropped with its `.fai` and nothing else is asked its assembly with
 * the index (§8.8).
 *
 * `openFiles` pairs the two and opens the FASTA as a genome, the index beside
 * it. The index reached the track loaded afterwards and not the assembly
 * question before it, which then read the FASTA whole — and refused one past
 * 300 MB, `mm10.fa` with its `mm10.fa.fai` right there, for want of an index.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
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
  vi.restoreAllMocks()
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

/** The sources the annotations worker is asked an assembly of, the question then left unanswered. */
function asked(): Array<{ name: string; index?: File }> {
  const sources: Array<{ name: string; index?: File }> = []
  vi.spyOn(AnnotationClient.prototype, 'request').mockImplementation((request: unknown) => {
    const { kind, source } = request as { kind: string; source: { name: string; index?: File } }
    if (kind === 'assembly') sources.push(source)
    return Promise.reject(new Error('not answered here'))
  })
  return sources
}

describe('a FASTA dropped with its index', () => {
  it('is asked its assembly with the .fai beside it', async () => {
    const sources = asked()
    const session = new Session(host)
    built.push(session)
    const index = new File(['chr1\t4\t6\t4\t5\n'], 'mm10.fa.fai')
    await session.openFiles([new File(['>chr1\nACGT\n'], 'mm10.fa'), index])
    expect(sources.map((source) => source.name)).toEqual(['mm10.fa'])
    expect(sources[0].index).toBe(index)
  })

  it('is asked without one where none was dropped', async () => {
    const sources = asked()
    const session = new Session(host)
    built.push(session)
    await session.openFiles([new File(['>chr1\nACGT\n'], 'mm10.fa')])
    expect(sources.map((source) => source.name)).toEqual(['mm10.fa'])
    expect(sources[0].index).toBeUndefined()
  })
})
