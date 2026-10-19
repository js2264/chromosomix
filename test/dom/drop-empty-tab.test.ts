// @vitest-environment jsdom
/**
 * A file handed to an empty tab fills it, whatever it is (§20.5).
 *
 * `dropFiles` is where a row pressed in the Files column lands for a folder on
 * this machine, and where a file dropped on the window outside the landing
 * page's zone lands. Its empty seat was a map's alone, so anything else went on
 * to `dropped`, found no tracks to join and did nothing — a bigWig whose `+`
 * said *Open Yeast_ATAC.bw in this tab, which is empty* opened nothing, and
 * said nothing either. An empty tab now takes the landing page's road.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

/** A session whose two outcomes are recorded: opened as a session, or dropped as a track. */
function recorded(): { session: Session; opened: string[][]; dropped: string[]; inside: Record<string, unknown> } {
  const session = new Session(host)
  built.push(session)
  const opened: string[][] = []
  const dropped: string[] = []
  const inside = session as unknown as Record<string, unknown>
  inside.openFiles = (files: File[]) => {
    opened.push(files.map((file) => file.name))
    return Promise.resolve()
  }
  inside.dropped = (file: File) => {
    dropped.push(file.name)
  }
  return { session, opened, dropped, inside }
}

describe('a file handed to an empty tab', () => {
  it('opens there, a bigWig as well as a map', async () => {
    const { session, opened, dropped } = recorded()
    await session.dropFiles([new File(['x'], 'Yeast_ATAC.bw')])
    expect(opened).toEqual([['Yeast_ATAC.bw']])
    expect(dropped).toEqual([])
  })

  it('opens a BAM with the index found beside it, as one gesture', async () => {
    const { session, opened } = recorded()
    await session.dropFiles([new File(['x'], 'reads.bam'), new File(['x'], 'reads.bam.bai')])
    expect(opened).toEqual([['reads.bam', 'reads.bam.bai']])
  })

  it('joins what is open where something is, rather than replacing it', async () => {
    const { session, opened, dropped, inside } = recorded()
    // A browser on a genome: something to draw a track on.
    inside.assembly = { uri: 'yeast.chrom.sizes', contigs: [] }
    await session.dropFiles([new File(['x'], 'Yeast_ATAC.bw')])
    expect(opened).toEqual([])
    expect(dropped).toEqual(['Yeast_ATAC.bw'])
  })

  it('is not taken for empty while a file is still opening in it', async () => {
    const { session, opened, inside } = recorded()
    inside.opening = 'Yeast_microC_G2M_1kb.cool'
    await session.dropFiles([new File(['x'], 'Yeast_ATAC.bw')])
    expect(opened).toEqual([])
  })
})
