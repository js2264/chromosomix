// @vitest-environment jsdom
/**
 * The rectangle in the middle of a map: *on this map* (§8.1, §16.9).
 *
 * The four strips at a map's edges say which stack a track is drawn in; they
 * say nothing an overlay can use, since a loop set is drawn on the map's face.
 * So a deck of three maps had no way to aim a loop file at the second one — it
 * went where a drop anywhere else goes, onto the first map — and a Tracks card
 * row of loops could only be put on a map by a strip that meant nothing for it.
 * The face is that aim: a file dropped there opens onto that map alone, a row
 * dropped there is drawn on it as well as wherever it was, and while an overlay
 * row is in the air the face is the only target a map lights.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { LEAD_MAP, laneOf, type MapId } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import { placementOn, type LaneEdge } from '@/annotations/types'
import { endCarry, startCarry } from '@/ui/laneCarry'
import { MatrixPanel } from '@/ui/MatrixPanel'
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
const cleanups: Array<() => void> = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  sessionStorage.clear()
})

afterEach(() => {
  for (const clean of cleanups.splice(0, cleanups.length)) clean()
  endCarry()
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
  vi.restoreAllMocks()
})

function store(): AnnotationStore {
  return new AnnotationStore(`face-${Math.random()}.cool`, { persist: false })
}

/** A loop set and a bigWig, both imported onto the session's own map. */
function rows(held: AnnotationStore): { loops: string; atac: string } {
  const loops = held.begin({
    card: 'overlay',
    kind: 'pairs',
    id: 'loops',
    label: 'loops',
    source: { kind: 'remote', url: 'loops.bedpe', name: 'loops.bedpe' },
  })
  const atac = held.begin({
    card: 'linear',
    kind: 'track',
    id: 'atac',
    label: 'ATAC',
    source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
  })
  held.update(loops.id, { status: 'ready' })
  held.update(atac.id, { status: 'ready' })
  return { loops: loops.id, atac: atac.id }
}

interface Loaded {
  files: string[]
  edge: LaneEdge | null
}

/** A map of a deck, over the session's one list of tracks. */
function mapOf(held: AnnotationStore, map: MapId, loaded: Loaded[] = []): MatrixPanel {
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    annotations: {
      store: held,
      map,
      manual: new ManualStore(`face-marks-${Math.random()}`),
      client: { request: () => Promise.resolve(null), drop: () => {} } as never,
      groups: new GroupSettings(`face-groups-${Math.random()}`),
      contigLength: () => undefined,
      loadOnEdge: (files, edge) => loaded.push({ files: files.map((file) => file.name), edge }),
    },
  })
  document.body.append(panel.el)
  cleanups.push(() => panel.destroy())
  return panel
}

const face = (panel: MatrixPanel): HTMLElement => {
  const found = panel.el.querySelector<HTMLElement>('.lane-drop-face')
  if (found === null) throw new Error('no face rectangle')
  return found
}

const strip = (panel: MatrixPanel, edge: LaneEdge): HTMLElement => {
  const found = panel.el.querySelector<HTMLElement>(`.lane-drop-${edge}`)
  if (found === null) throw new Error(`no ${edge} rectangle`)
  return found
}

/** A drag event carrying `data` by type, and `files` — jsdom has no `DataTransfer`. */
function dragged(kind: string, data: Record<string, string>, files: File[] = []): DragEvent {
  const types = [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])]
  const transfer = {
    types,
    files,
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    effectAllowed: 'copyMove',
    dropEffect: 'none',
    getData: (type: string) => data[type] ?? '',
  }
  const event = new window.Event(kind, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  return event
}

const TRACK = 'application/x-chromosomix-track'
const OVERLAY = 'application/x-chromosomix-overlay'

describe('the middle of a map', () => {
  it('is a target of its own, named for what it does', () => {
    const panel = mapOf(store(), LEAD_MAP)
    expect(face(panel).textContent).toBe('on this map')
  })

  it('draws an overlay row dropped on it on that map, and leaves it on the one it was on', () => {
    const held = store()
    const { loops } = rows(held)
    const second = mapOf(held, 'p2')
    face(second).dispatchEvent(dragged('drop', { [TRACK]: loops, [OVERLAY]: loops }))
    expect(held.overlays('p2').map((row) => row.id)).toEqual([loops])
    expect(held.overlays(LEAD_MAP).map((row) => row.id)).toEqual([loops])
  })

  it('puts a track row dropped on it on that map’s usual edge', () => {
    const held = store()
    const { atac } = rows(held)
    const second = mapOf(held, 'p2')
    face(second).dispatchEvent(dragged('drop', { [TRACK]: atac }))
    expect(laneOf(held.placements, atac, 'p2')?.placement).toEqual(placementOn('bottom'))
    // …and nothing moves off the map it was already on.
    expect(laneOf(held.placements, atac, LEAD_MAP)?.placement).toEqual(placementOn('bottom'))
  })

  it('opens files dropped on it onto that map, with no edge named', () => {
    const loaded: Loaded[] = []
    const second = mapOf(store(), 'p2', loaded)
    const loops = new File(['I\t0\t1000\tI\t9000\t10000\n'], 'loops.tsv')
    face(second).dispatchEvent(dragged('drop', {}, [loops]))
    expect(loaded).toEqual([{ files: ['loops.tsv'], edge: null }])
    // The strips still name theirs.
    strip(second, 'left').dispatchEvent(dragged('drop', {}, [loops]))
    expect(loaded[1]).toEqual({ files: ['loops.tsv'], edge: 'left' })
  })

  it('answers a row with a copy, since the row stays on every map it was on', () => {
    const held = store()
    const { loops } = rows(held)
    const over = dragged('dragover', { [TRACK]: loops, [OVERLAY]: loops })
    face(mapOf(held, 'p2')).dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer?.dropEffect).toBe('copy')
  })
})

describe('an overlay row in the air', () => {
  it('lights the face alone: the grid says so, and the stylesheet keeps the strips down', () => {
    const held = store()
    const { loops, atac } = rows(held)
    const panel = mapOf(held, 'p2')
    const grid = panel.el.querySelector('.panel-grid')
    grid?.dispatchEvent(dragged('dragenter', { [TRACK]: loops, [OVERLAY]: loops }))
    expect(grid?.classList.contains('is-dropping')).toBe(true)
    expect(grid?.classList.contains('is-overlay-drag')).toBe(true)
    // A track's row is offered its edges as well as the face.
    grid?.dispatchEvent(dragged('dragenter', { [TRACK]: atac }))
    expect(grid?.classList.contains('is-overlay-drag')).toBe(false)
    grid?.dispatchEvent(dragged('drop', {}))
    expect(grid?.classList.contains('is-dropping')).toBe(false)
  })

  it('dropped on a strip is still drawn on that map, and given no edge of it', () => {
    const held = store()
    const { loops } = rows(held)
    const second = mapOf(held, 'p2')
    strip(second, 'left').dispatchEvent(dragged('drop', { [TRACK]: loops, [OVERLAY]: loops }))
    expect(held.overlays('p2').map((row) => row.id)).toEqual([loops])
    // No turn was recorded for an edge it is not drawn along.
    expect(laneOf(held.placements, loops, 'p2')?.style).toBeUndefined()
  })
})

describe('a lane carried by its grip', () => {
  it('is offered the edges of another map and not its face', () => {
    const held = store()
    const second = mapOf(held, 'p2')
    startCarry({ ids: ['atac'], from: LEAD_MAP, edge: 'bottom' })
    expect(face(second).classList.contains('away')).toBe(true)
    expect(strip(second, 'top').classList.contains('away')).toBe(false)
    endCarry()
    expect(face(second).classList.contains('away')).toBe(false)
  })
})
