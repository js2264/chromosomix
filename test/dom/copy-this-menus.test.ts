// @vitest-environment jsdom
/**
 * *Copy this* on the right-click menus (§7.2): where the row is, what it runs,
 * and what the reader is told.
 *
 * The map's menu opens with it — over the data, on any file, the marks after
 * it only where the file can carry them (§8.5) — and a lane's menu carries it
 * under the track's name wherever the surface can draw that lane alone. The
 * copy itself is one call, `copyPicture`, and the menu closes on the press, so
 * what happened is said in the corner: the size of what was copied, or why the
 * browser would not take it. What each picture *holds* is the renderers' test
 * (`test/unit/copy-this.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import type { AnnotationEntry } from '@/annotations/types'
import { closeMenu } from '@/ui/Menu'
import { openLaneMenu } from '@/ui/laneMenu'
import { MatrixPanel } from '@/ui/MatrixPanel'
import { copyPicture } from '@/ui/export'
import type { MatrixResult } from '@/worker/protocol'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  closeMenu()
  for (const panel of built.splice(0, built.length)) panel.destroy()
  for (const note of all(document.body, '.toast-stack')) note.remove()
  teardown()
  vi.restoreAllMocks()
})

/** The rows of the menu that is up, as a reader reads them: headings and actions. */
function rows(): string[] {
  const menu = document.querySelector('.context-menu')
  if (menu === null) return []
  return Array.from(menu.children).map((node) =>
    node.classList.contains('context-menu-head')
      ? `# ${node.textContent}`
      : (node.querySelector('span')?.textContent ?? node.textContent ?? ''),
  )
}

function press(label: string): void {
  const row = all<HTMLButtonElement>(document.body, '.crumb-menu-item').find(
    (node) => node.querySelector('span')?.textContent === label,
  )
  if (row === undefined) throw new Error(`no menu row "${label}"`)
  row.click()
}

function track(): { store: AnnotationStore; entry: AnnotationEntry } {
  const store = new AnnotationStore(`copy-${Math.random()}.cool`, { persist: false })
  const { id } = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'ATAC',
    source: { kind: 'remote', url: 'atac.bw', name: 'atac.bw' },
  })
  store.update(id, { status: 'ready' })
  return { store, entry: store.byId(id)! }
}

describe('a lane’s menu', () => {
  it('carries Copy this under the track’s name, and runs what the surface hands it', () => {
    const { store, entry } = track()
    const copy = vi.fn()
    openLaneMenu(10, 10, entry, store, 'bottom', undefined, null, copy)
    const seen = rows()
    expect(seen.slice(0, 2)).toEqual(['# ATAC', 'Copy this'])
    press('Copy this')
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('does not offer it where the surface cannot draw the lane alone', () => {
    const { store, entry } = track()
    openLaneMenu(10, 10, entry, store, 'bottom')
    expect(rows()).not.toContain('Copy this')
  })
})

describe('the map’s menu', () => {
  /** A map drawn in a box of `size` pixels, since jsdom lays nothing out. */
  function mapOnScreen(size = 400): MatrixPanel {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(size)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(size)
    const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
    built.push(panel)
    document.body.append(panel.el)
    const bins = 40
    panel.setData(
      {
        nrows: bins,
        ncols: bins,
        values: new Float32Array(bins * bins).fill(1),
        rowExtent: [0, bins],
        colExtent: [0, bins],
        rowGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
        colGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
        level: 'bin',
        binsPerCell: 1,
      } as unknown as MatrixResult,
      'IV',
    )
    panel.remeasure()
    return panel
  }

  it('opens over the data with Copy this first, on a file that carries no marks', () => {
    const panel = mapOnScreen()
    const canvas = panel.el.querySelector<HTMLCanvasElement>('canvas.heatmap-canvas')
    expect(canvas).not.toBeNull()
    canvas?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 200, bubbles: true, cancelable: true }))
    // No annotation machinery was handed to this panel — a metacool's case
    // (§8.5) — so the picture is all the menu can offer, and it offers it.
    expect(rows()).toEqual(['# This map', 'Copy this'])
  })
})

describe('copyPicture', () => {
  /** A canvas that encodes to a PNG of its own size, as a browser's does. */
  function picture(width: number, height: number): HTMLCanvasElement {
    return {
      width,
      height,
      toBlob: (done: (blob: Blob | null) => void) => done(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement
  }

  function clipboard(write: (items: unknown[]) => Promise<void>): void {
    const g = globalThis as Record<string, unknown>
    g['ClipboardItem'] = class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
  }

  const corner = (): string => document.querySelector('.toast-stack')?.textContent ?? ''

  it('puts a PNG on the clipboard and says how big it is', async () => {
    const written: unknown[] = []
    clipboard(async (items) => {
      written.push(...items)
    })
    copyPicture('track', picture(612, 46))
    await vi.waitFor(() => expect(corner()).toContain('Copied the track · 612 × 46 px'))
    expect(written).toHaveLength(1)
    expect(Object.keys((written[0] as { items: Record<string, unknown> }).items)).toEqual(['image/png'])
  })

  it('says why, where the browser will not take it', async () => {
    clipboard(async () => {
      throw new Error('Write permission denied.')
    })
    copyPicture('map', picture(300, 300))
    await vi.waitFor(() => expect(corner()).toContain('The map could not be copied: Write permission denied.'))
  })

  it('says so where there is nothing drawn to copy', () => {
    copyPicture('model', null)
    expect(corner()).toContain('There is no model drawn here to copy.')
  })
})
