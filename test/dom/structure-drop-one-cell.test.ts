// @vitest-environment jsdom
/**
 * A model dropped beside what is open opens one cell, not two (§25.3).
 *
 * Two roads answered the same arrival. The session's drop opened a cell by the
 * file's name, and the watch on the store opened another for the row the
 * loader had just begun — and the spare cell, with no model of its own, fell
 * back to the first model there was. So every model dropped on a map, named by
 * a URL or picked from a folder was drawn twice, or drew a model it was not.
 * The watch is the one road now.
 *
 * The session, the store, the loader and the deck are real; the worker that
 * would read the file is a dead one, since the row is begun before any byte is
 * read and that is the moment both roads answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { assemblyOf, type Assembly } from '@/genome/assembly'
import type { PanelDeck } from '@/panels/PanelDeck'
import { Session, type SessionHost } from '@/app/Session'
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

interface Innards {
  assembly: Assembly | null
  annotations: { store: AnnotationStore } | null
  deck: { grid: PanelDeck | null }
  setUpBrowserAnnotations(assembly: Assembly): void
  mountBrowser(state: { uri: string; view: string }): void
  dropped(file: File): void
}

/** A browser on yeast with a track drawn on it — the store has changed once, so its watch has begun. */
function browsing(): { session: Session; inside: Innards } {
  const session = new Session(host)
  built.push(session)
  document.body.append(session.contentEl)
  const inside = session as unknown as Innards
  const uri = 'yeast.chrom.sizes'
  const assembly = assemblyOf({
    uri,
    name: uri,
    contigs: [
      { name: 'I', length: 230_000 },
      { name: 'II', length: 813_000 },
    ],
    origin: 'sizes',
  })
  inside.setUpBrowserAnnotations(assembly)
  inside.assembly = assembly
  inside.annotations?.store.begin({ card: 'linear', kind: 'track', source: { kind: 'detached', name: 'atac.bw' } as never })
  session.store.adopt({ uri, view: 'browser' } as ViewState)
  inside.mountBrowser({ uri, view: 'browser' })
  return { session, inside }
}

const cells = (session: Session): number => session.contentEl.querySelectorAll('.deck-structure').length
const models = (inside: Innards): string[] =>
  (inside.annotations?.store.entries ?? []).filter((entry) => entry.kind === 'structure').map((entry) => entry.id)

describe('a model dropped beside what is open', () => {
  it('opens one cell, drawing it', () => {
    const { session, inside } = browsing()
    inside.dropped(new File(['I\t0\t5000\t0\t0\t0\n'], 'yeast.bed3d'))
    expect(models(inside)).toHaveLength(1)
    expect(cells(session)).toBe(1)
    expect(inside.deck.grid?.shownStructures()).toEqual(models(inside))
  })

  it('opens one more for a second, beside the first, each drawing its own', () => {
    const { session, inside } = browsing()
    inside.dropped(new File(['I\t0\t5000\t0\t0\t0\n'], 'genome.bed3d'))
    inside.dropped(new File(['HETATM'], 'locus.pdb'))
    expect(models(inside)).toHaveLength(2)
    expect(cells(session)).toBe(2)
    expect(inside.deck.grid?.shownStructures()).toEqual(models(inside))
  })

  it('opens one on a browser with nothing drawn on it yet', () => {
    // The store's first change: the watch is armed from what storage held when
    // the store was made, so a first row is an arrival like any other.
    const session = new Session(host)
    built.push(session)
    document.body.append(session.contentEl)
    const inside = session as unknown as Innards
    const uri = 'yeast.chrom.sizes'
    const assembly = assemblyOf({ uri, name: uri, contigs: [{ name: 'I', length: 230_000 }], origin: 'sizes' })
    inside.setUpBrowserAnnotations(assembly)
    inside.assembly = assembly
    session.store.adopt({ uri, view: 'browser' } as ViewState)
    inside.mountBrowser({ uri, view: 'browser' })
    inside.dropped(new File(['I\t0\t5000\t0\t0\t0\n'], 'yeast.bed3d'))
    expect(cells(session)).toBe(1)
    expect(inside.deck.grid?.shownStructures()).toEqual(models(inside))
  })
})
