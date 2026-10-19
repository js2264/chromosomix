// @vitest-environment jsdom
/**
 * A file let go on a cell of the deck is **that cell's**, wherever on the cell
 * the hand lets go (§16.9).
 *
 * A companion took a file only on its five rectangles — its four edges and *on
 * this map* in the middle — and a tracks cell on none, so a track let go on the
 * lanes under the second map, on its heading or anywhere on a tracks cell fell
 * through to the content area, which loads a drop nothing else took onto the
 * first map. What is pinned here: which road a drop on each kind of cell takes,
 * with which edge and under which id; that the drop is marked as answered —
 * `defaultPrevented`, which is what the content area stands aside for; that a
 * map's rectangles, an empty cell and the lead's own cell keep their own
 * answers; and the outline that says *here* while the file is in the air.
 *
 * A companion's worker never answers — `Worker` is a stub — so the map below is
 * one that is still opening. Its cell takes a file all the same: where a track
 * goes is a fact about the cell, not about whether its picture has arrived.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import { FILE_DRAG_TYPE } from '@/ui/fileDrag'
import type { AnnotationContext } from '@/ui/MatrixPanel'
import type { PickedFile } from '@/browse/folder'
import type { LaneEdge } from '@/annotations/types'
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

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

interface Made {
  deck: PanelDeck
  /** Files handed to a cell's `loadOnEdge`, by the id of the cell they were aimed at. */
  loads: Array<{ map: string; names: string[]; edge: LaneEdge | null }>
  /** Files-column rows handed to a cell's `pickOnEdge`. */
  picks: Array<{ map: string; edge: LaneEdge | null }>
  /** A track the deck opened a tracks cell for, from an empty cell. */
  trackFiles: Array<{ map: string; uri: string }>
}

/** A deck of four: the lead, a companion map, a tracks cell and an empty cell. */
function make(): Made {
  const made: Made = { deck: undefined as unknown as PanelDeck, loads: [], picks: [], trackFiles: [] }
  const store = {
    keepMaps: () => {},
    noteMapFiles: () => {},
    adoptHome: () => {},
    entriesOn: () => [],
    byId: () => undefined,
  }
  made.deck = new PanelDeck({
    onMapsChange: () => {},
    memoryKey: () => 'deck-drops-test',
    leadName: () => 'lead.cool',
    leadLabel: () => 'lead.cool',
    annotations: (map) =>
      ({
        store,
        loadOnEdge: (files: readonly File[], edge: LaneEdge | null) =>
          made.loads.push({ map, names: files.map((file) => file.name), edge }),
        pickOnEdge: (_event: DragEvent, edge: LaneEdge | null) => made.picks.push({ map, edge }),
      }) as unknown as AnnotationContext,
    tracks: { context: () => undefined },
    onTrackFile: (picked: PickedFile, map: string) => made.trackFiles.push({ map, uri: picked.uri }),
  })
  document.body.appendChild(made.deck.el)
  const view = document.createElement('div')
  view.appendChild(document.createElement('div')).className = 'view-head'
  made.deck.frame(view)
  made.deck.add({ kind: 'remote', uri: 'https://x.example.org/b.cool' })
  made.deck.add({ kind: 'tracks' })
  made.deck.grow('below')
  return made
}

/** The cells on screen, by what they hold. */
function cells(made: Made): { lead: HTMLElement; map: HTMLElement; tracks: HTMLElement; vacant: HTMLElement } {
  const grid = [...made.deck.el.querySelectorAll<HTMLElement>('.deck-grid > .deck-panel')]
  const find = (test: (cell: HTMLElement) => boolean): HTMLElement => {
    const cell = grid.find(test)
    if (cell === undefined) throw new Error('no such cell')
    return cell
  }
  return {
    lead: find((cell) => cell.classList.contains('is-lead')),
    map: find((cell) => !/is-lead|is-vacant|deck-tracks|deck-structure/.test(cell.className)),
    tracks: find((cell) => cell.classList.contains('deck-tracks')),
    vacant: find((cell) => cell.classList.contains('is-vacant')),
  }
}

/** A drag event carrying files off the disk, or a row out of the Files column. */
function dragged(type: 'dragover' | 'drop' | 'dragleave', carrying: 'files' | 'row'): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  const file = new File(['chr1\t0\t100\n'], 'peaks.bed')
  Object.defineProperty(event, 'dataTransfer', {
    value:
      carrying === 'files'
        ? { types: ['Files'], files: [file], items: [], getData: () => '' }
        : {
            types: [FILE_DRAG_TYPE, 'text/plain'],
            files: [],
            items: [],
            getData: (type: string) =>
              type === FILE_DRAG_TYPE ? JSON.stringify({ folder: 'f', path: 'peaks.bed', name: 'peaks.bed' }) : '',
          },
  })
  Object.defineProperty(event, 'relatedTarget', { value: null })
  return event
}

/** Somewhere on a cell that is not one of its own targets: its heading. */
function groundOf(cell: HTMLElement): HTMLElement {
  const head = cell.querySelector<HTMLElement>('.deck-head')
  if (head === null) throw new Error('no heading')
  return head
}

describe('a file let go on a cell', () => {
  it('is a companion’s — on this map, as its middle rectangle means — wherever on the cell it lands', () => {
    const made = make()
    const { map } = cells(made)
    const drop = dragged('drop', 'files')
    groundOf(map).dispatchEvent(drop)
    expect(made.loads).toHaveLength(1)
    expect(made.loads[0].names).toEqual(['peaks.bed'])
    // `null` is the face: a track on its usual edge, an overlay on the map.
    expect(made.loads[0].edge).toBeNull()
    // The companion's id, not the lead's: the track is drawn on this map.
    const companion = made.deck.analysable().find((held) => held.panel.el === map)
    expect(companion).toBeDefined()
    expect(made.loads[0].map).toBe(companion?.map)
    // Answered, which is what the content area stands aside for.
    expect(drop.defaultPrevented).toBe(true)
  })

  it('is a tracks cell’s, drawn at its foot', () => {
    const made = make()
    const { tracks } = cells(made)
    const drop = dragged('drop', 'files')
    groundOf(tracks).dispatchEvent(drop)
    expect(made.loads.map((load) => load.edge)).toEqual(['bottom'])
    expect(drop.defaultPrevented).toBe(true)
  })

  it('takes a row out of the Files column by the same aim, read when the cell takes it', () => {
    const made = make()
    const { map, tracks } = cells(made)
    groundOf(map).dispatchEvent(dragged('drop', 'row'))
    groundOf(tracks).dispatchEvent(dragged('drop', 'row'))
    expect(made.picks.map((pick) => pick.edge)).toEqual([null, 'bottom'])
    // Two cells, two ids.
    expect(new Set(made.picks.map((pick) => pick.map)).size).toBe(2)
    expect(made.loads).toHaveLength(0)
  })

  it('leaves the lead’s own cell to the session, as a drop on it always was', () => {
    const made = make()
    const drop = dragged('drop', 'files')
    groundOf(cells(made).lead).dispatchEvent(drop)
    expect(made.loads).toHaveLength(0)
    expect(drop.defaultPrevented).toBe(false)
  })

  it('leaves a map’s rectangles and an empty cell their own answers', () => {
    const made = make()
    const { map, vacant } = cells(made)
    // A rectangle the map draws over itself while a file is in the air
    // (`LaneGestures`): it is aimed more finely than the cell, and answers.
    const edge = map.appendChild(document.createElement('div'))
    edge.className = 'lane-drop lane-drop-bottom'
    edge.dispatchEvent(dragged('drop', 'files'))
    expect(made.loads).toHaveLength(0)
    // An empty cell opens what is dropped on it, as a cell of its own kind:
    // a track there is a tracks cell drawing it.
    const zone = vacant.querySelector<HTMLElement>('.deck-vacant')
    zone?.dispatchEvent(dragged('drop', 'row'))
    expect(made.loads).toHaveLength(0)
    expect(made.picks).toHaveLength(0)
  })
})

describe('a file in the air over a cell', () => {
  it('outlines the cell that will take it, and only while it is over one', () => {
    const made = make()
    const { lead, map, tracks } = cells(made)
    const lit = (): HTMLElement[] =>
      [...made.deck.el.querySelectorAll<HTMLElement>('.deck-grid > .deck-panel.is-file-target')]
    groundOf(map).dispatchEvent(dragged('dragover', 'files'))
    expect(lit()).toEqual([map])
    groundOf(tracks).dispatchEvent(dragged('dragover', 'row'))
    expect(lit()).toEqual([tracks])
    // Over the lead, nothing: the content area's outline is the answer there.
    groundOf(lead).dispatchEvent(dragged('dragover', 'files'))
    expect(lit()).toEqual([])
    // Over a rectangle, which says it more finely, the cell goes dark.
    groundOf(map).dispatchEvent(dragged('dragover', 'files'))
    const edge = map.appendChild(document.createElement('div'))
    edge.className = 'lane-drop lane-drop-face'
    edge.dispatchEvent(dragged('dragover', 'files'))
    expect(lit()).toEqual([])
    // Out of the grid, and let go.
    groundOf(map).dispatchEvent(dragged('dragover', 'files'))
    made.deck.el.querySelector('.deck-grid')?.dispatchEvent(dragged('dragleave', 'files'))
    expect(lit()).toEqual([])
  })

  it('outlines nothing for a drag that is not a file', () => {
    const made = make()
    const event = new window.Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], files: [], items: [] } })
    groundOf(cells(made).map).dispatchEvent(event)
    expect(made.deck.el.querySelectorAll('.is-file-target')).toHaveLength(0)
  })
})
