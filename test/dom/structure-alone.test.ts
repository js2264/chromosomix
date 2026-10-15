// @vitest-environment jsdom
/**
 * A structure file dropped on an empty window opens as its model (§25.3).
 *
 * The file names sequences — its beads are on them — so the session it opens is
 * a browser of that genome, and the browser had nothing to draw: a structure is
 * a row of the Structures card and a cell of the deck, never a lane. What a
 * reader who dropped one bed3d got was an empty axis, with the model nowhere on
 * screen; the watch that opens a cell for every model that arrives had noted
 * this one as already there, since it came in with the store, before any deck
 * could frame it.
 *
 * The session is real, and so are the store, the view and the deck; the one
 * thing lent is what the file's read would have done — a row begun in the store
 * and the view state set — since that needs a worker and decides nothing here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { assemblyOf, type Assembly } from '@/genome/assembly'
import type { PanelDeck } from '@/panels/PanelDeck'
import { Session, type SessionHost } from '@/app/Session'
import type { ViewState } from '@/types'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: Session[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
})

afterEach(() => {
  for (const session of built.splice(0, built.length)) session.destroy()
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

/** The private doors a browser session comes in through. */
interface Innards {
  session: Session
  assembly: Assembly | null
  annotations: { store: AnnotationStore } | null
  /** The session's deck (`SessionDeck`), and the panels it has built, if any. */
  deck: { grid: PanelDeck | null }
  structureAlone: boolean
  setUpBrowserAnnotations(assembly: Assembly): void
  mountBrowser(state: { uri: string; view: string }): void
}

/**
 * The browser `openGenome` builds for a structure file, up to the mount: the
 * genome its beads name, the model's row in the store, and — when `alone` —
 * the note that the file was a structure and nothing else.
 */
function opened(options: { alone: boolean; track?: boolean }) {
  const session = new Session(host)
  built.push(session)
  // On the page, as the shell puts it: a deck frames only a view that is.
  document.body.append(session.contentEl)
  const inside = session as unknown as Innards
  inside.session = session
  const uri = 'yeast.bed3d'
  const assembly = assemblyOf({
    uri,
    name: uri,
    contigs: [
      { name: 'I', length: 230_000 },
      { name: 'II', length: 813_000 },
    ],
    origin: 'features',
  })
  inside.setUpBrowserAnnotations(assembly)
  inside.assembly = assembly
  const store = inside.annotations?.store
  if (store === undefined) throw new Error('no store')
  const model = store.begin({
    card: 'structure',
    kind: 'structure',
    source: { kind: 'detached', name: uri } as never,
    label: 'yeast',
  })
  if (options.track === true) {
    // Something drawn on the tracks already: a row a previous visit left.
    store.begin({ card: 'linear', kind: 'track', source: { kind: 'detached', name: 'atac.bw' } as never })
  }
  inside.structureAlone = options.alone
  session.store.adopt({ uri, view: 'browser' } as ViewState)
  inside.mountBrowser({ uri, view: 'browser' })
  return { session, inside, model: model.id }
}

describe('a structure file opened on its own', () => {
  it('is drawn in its own cell, with the empty tracks it opened hidden', () => {
    const { inside, model } = opened({ alone: true })
    const deck = inside.deck.grid
    expect(deck).not.toBeNull()
    expect(deck?.shownStructures()).toEqual([model])
    expect(deck?.leadShown).toBe(false)
    // The deck frames the browser, parked behind the model, and its bar offers
    // it back under what it is rather than under the model's own file name.
    expect(inside.session.contentEl.querySelector('.deck-panel.is-lead.is-parked .browser-canvas')).not.toBeNull()
    expect(inside.deck.grid?.el.querySelector('.deck-show-lead')?.textContent).toBe('show the 1D browser')
    expect(inside.session.store.state?.maps).toBe('3d')
  })

  it('keeps the tracks on screen where something is drawn on them', () => {
    const { inside, model } = opened({ alone: true, track: true })
    expect(inside.deck.grid?.shownStructures()).toEqual([model])
    expect(inside.deck.grid?.leadShown).toBe(true)
  })

  it('does nothing where the file was not alone, or the session is coming back', () => {
    // A restore names its own deck in the link; a structure among other files
    // is opened by the road every dropped structure takes.
    const { inside } = opened({ alone: false })
    expect(inside.deck.grid).toBeNull()
  })

  it('does it once: a later mount of the same browser leaves the reader’s arrangement alone', () => {
    const { inside } = opened({ alone: true })
    inside.deck.grid?.showLead()
    inside.mountBrowser({ uri: 'yeast.bed3d', view: 'browser' })
    expect(inside.deck.grid?.leadShown).toBe(true)
  })
})

describe('a session coming back with its models', () => {
  it('opens no cell for any of them: a restored session names its own deck (§25.3)', () => {
    // The watch on the store notes what is there when it begins, and it begins
    // at the store's first change — which, in a restore, is the first row back.
    // A track first and two models after it, and the models were taken for new
    // arrivals: each opened a cell, and publishing that deck wrote its models
    // over the maps the link names.
    const session = new Session(host)
    built.push(session)
    document.body.append(session.contentEl)
    const inside = session as unknown as Innards & { memoryKey(uri: string): string }
    const uri = 'yeast.bed3d'
    const assembly = assemblyOf({ uri, name: uri, contigs: [{ name: 'I', length: 230_000 }], origin: 'features' })
    // What the first visit left in this session's memory.
    const earlier = new AnnotationStore(inside.memoryKey(uri))
    const remote = (name: string) => ({ kind: 'remote', url: `https://lab.example.org/${name}`, name }) as never
    // Remembered once read: a row still loading is not written down.
    for (const [card, kind, name] of [
      ['linear', 'track', 'atac.bw'],
      ['structure', 'structure', 'genome.bed3d'],
      ['structure', 'structure', 'locus.bed3d'],
    ] as const) {
      const row = earlier.begin({ card, kind, source: remote(name), label: name })
      earlier.update(row.id, { status: 'ready' })
    }
    session.store.adopt({ uri, view: 'browser', maps: 'tracks' } as ViewState)
    inside.assembly = assembly
    inside.setUpBrowserAnnotations(assembly)
    expect(inside.annotations?.store.entries.filter((entry) => entry.kind === 'structure')).toHaveLength(2)
    expect(inside.deck.grid).toBeNull()
    expect(session.store.state?.maps).toBe('tracks')
  })
})
