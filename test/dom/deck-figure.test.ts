// @vitest-environment jsdom
/**
 * The deck's figure (§16.5): one arrangement, written as a PNG or as one
 * vector page.
 *
 * What is pinned is the PDF's promise — that it is a *drawing*: each map's
 * cells the one image on it, at the size of that map's plot, and every axis,
 * label, track, model and caption round them paths and text, placed where the
 * PNG places them. It used to be the PNG on a page, one image the size of the
 * page, which is exactly what the operator stream is read for here: an image
 * as large as the page is the old figure, and any image on a deck of a model
 * and no map is a raster that should not be there.
 *
 * The streams are read the way `vector.test.ts` reads them — inflated, and
 * asserted on coarsely: which images, where, and that paths and text are
 * there at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import type { AnnotationEntry, AnnotationStyle } from '@/annotations/types'
import { defaultStyle } from '@/annotations/types'
import { DECK_FIGURE_GAP, deckLayout, rasterDeck, vectorDeck, type CellFigure } from '@/panels/deckFigure'
import { PanelDeck } from '@/panels/PanelDeck'
import type { MatrixPanel } from '@/ui/MatrixPanel'
import { MatrixPanel as RealMatrixPanel } from '@/ui/MatrixPanel'
import { ManualStore } from '@/annotations/manual'
import type { VectorPage } from '@/ui/vector'
import type { MatrixResult } from '@/worker/protocol'
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
let shimmedBlob: typeof Blob
let hadWorker: unknown

beforeEach(async () => {
  teardown = setUpDom({ canvas: 'stub' })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  sessionStorage.clear()
  // jsdom's `Blob` has no `stream()`, which the page's deflate and the inflate
  // below both need; the platform's has, as every browser's does.
  const { Blob: PlatformBlob } = await import('node:buffer')
  shimmedBlob = globalThis.Blob
  Object.defineProperty(globalThis, 'Blob', { value: PlatformBlob, configurable: true })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'Blob', { value: shimmedBlob, configurable: true })
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  vi.restoreAllMocks()
  teardown()
})

// ---------------------------------------------------------------------------
// Reading a page back
// ---------------------------------------------------------------------------

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

/** Object 4's stream, inflated, located by its declared length. */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const text = latin1(bytes)
  const header = /4 0 obj\n<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/.exec(text)
  if (header === null) throw new Error('no content stream')
  const at = (header.index ?? 0) + header[0].length
  const raw = bytes.slice(at, at + Number(header[1]))
  if (header[2] === undefined) return latin1(raw)
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return latin1(new Uint8Array(await new Response(stream).arrayBuffer()))
}

async function bytesOf(page: VectorPage): Promise<Uint8Array> {
  return new Uint8Array(await (await page.toBlob({ title: 'deck', created: new Date(0) })).arrayBuffer())
}

/**
 * Every image the page places: the box its `cm` puts it in, in the page's own
 * CSS pixels (the stream opens with the one `cm` that turns those into points,
 * and every placement is inside it).
 */
function placements(content: string): Array<{ width: number; height: number; x: number; y: number }> {
  return [...content.matchAll(/^([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\n\/Im\d+ Do$/gm)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
  }))
}

/** The page's size in CSS pixels, from its `MediaBox` in points. */
function pageSize(bytes: Uint8Array): { width: number; height: number } {
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(latin1(bytes))
  if (box === null) throw new Error('no MediaBox')
  return { width: (Number(box[1]) * 96) / 72, height: (Number(box[2]) * 96) / 72 }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A cell that draws a path and a word, at its own origin. */
function pathCell(width: number, height: number, word: string): CellFigure {
  return {
    width,
    height,
    raster: () => null,
    vector: (ctx) => {
      ctx.fillStyle = '#336699'
      ctx.fillRect(5, 5, 20, 10)
      ctx.font = '11px sans-serif'
      ctx.fillStyle = '#000000'
      ctx.fillText(word, 5, 30)
    },
  }
}

/** A block of 40 × 40 bins for a map to draw. */
function block(): MatrixResult {
  const n = 40
  const values = new Float32Array(n * n)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) values[r * n + c] = 40 / (1 + Math.abs(r - c))
  return {
    nrows: n,
    ncols: n,
    values,
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: [{ label: 'chr1', start: 0, end: n, unitStart: 0 }],
    colGroups: [{ label: 'chr1', start: 0, end: n, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

const built: RealMatrixPanel[] = []

afterEach(() => {
  for (const panel of built.splice(0)) panel.destroy()
})

function map(): RealMatrixPanel {
  const panel = new RealMatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
  built.push(panel)
  document.body.append(panel.el, panel.controlsEl)
  panel.setData(block(), 'chr1')
  return panel
}

const G3D = Array.from({ length: 12 }, (_, i) => `chr1\t${i * 5000}\t${i * 0.9}\t${i * 0.4 - 1}\t${0.3 * i}`).join(
  '\n',
)

function structureEntry(): AnnotationEntry {
  return {
    id: 'a1',
    card: 'linear',
    kind: 'structure',
    label: 'model.g3d',
    source: { kind: 'detached', name: 'model.g3d' },
    status: 'ready',
    visible: true,
    placement: 'bottom',
    style: defaultStyle('structure', '#1f5fa9'),
    payload: { kind: 'features', data: parseG3d(G3D, 'model.g3d') },
  } as unknown as AnnotationEntry
}

function fakeStore(entries: AnnotationEntry[]) {
  return {
    entries,
    subscribe: () => () => {},
    restyle: (_id: string, _patch: Partial<AnnotationStyle>) => {},
    update: () => {},
  }
}

/** A lead the deck can drive and nothing more: no figure of its own. */
function leadPanel() {
  const state = { exporter: null as { save(format: string, dpi: number): Promise<boolean> } | null }
  const panel = {
    setViewportListener: () => {},
    setDeckExport: (exporter: typeof state.exporter) => {
      state.exporter = exporter
    },
    setCardFor: () => {},
    setLaneListener: () => {},
    setHoverListener: () => {},
    setLaneHoverListener: () => {},
    showLaneEcho: () => {},
    showLocusEcho: () => {},
    framedRanges: () => null,
    showLocusOnColumns: () => true,
    turnReach: () => null,
    setLaneFloor: () => {},
    remeasure: () => {},
    bpPerCell: () => 1000,
    cellCount: () => ({ rows: 400, cols: 400 }),
    blockLevel: () => 'bin',
    blockSpan: () => ({ rows: 400000, cols: 400000, sequences: { rows: 1, cols: 1 } }),
    viewport: () => ({ rows: [0, 400], cols: [0, 400] }),
    get hasBlock(): boolean {
      return true
    },
    isTurned: () => false,
    showViewport: () => true,
    scale: () => ({ vmin: Number.NaN, vmax: Number.NaN, transform: 'log10', colormap: 'fall' }),
    shownScale: () => ({ vmin: -3, vmax: -1, transform: 'log10', colormap: 'fall' }),
    baseScale: () => undefined,
  }
  return { panel: panel as unknown as MatrixPanel, state }
}

/** The save dialog, answered: what it was asked to call the file, and what was written. */
function savePicker(): { names: string[]; blobs: Blob[] } {
  const seen = { names: [] as string[], blobs: [] as Blob[] }
  ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options: {
    suggestedName: string
  }) => {
    seen.names.push(options.suggestedName)
    return {
      name: options.suggestedName,
      createWritable: async () => ({
        write: async (blob: Blob) => {
          seen.blobs.push(blob)
        },
        close: async () => {},
      }),
    }
  }
  return seen
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

describe('the deck’s layout', () => {
  it('makes every cell the size of the largest, an empty one included, with air between', () => {
    const layout = deckLayout([{ width: 100, height: 50 }, { width: 80, height: 60 }, null], 2)
    expect(layout.cellWidth).toBe(100)
    expect(layout.cellHeight).toBe(60)
    expect(layout.gap).toBeCloseTo(100 * DECK_FIGURE_GAP, 9)
    expect(layout.rows).toBe(2)
    expect(layout.width).toBeCloseTo(2 * 100 + layout.gap, 9)
    expect(layout.height).toBeCloseTo(2 * 60 + layout.gap, 9)
    expect(layout.at(1)).toEqual({ x: 100 + layout.gap, y: 0 })
    expect(layout.at(2)).toEqual({ x: 0, y: 60 + layout.gap })
  })

  it('places the PNG’s cells where the PDF’s go, at the resolution asked for', () => {
    // A context that writes down where each cell's picture was put.
    const drawn: Array<{ source: unknown; x: number; y: number }> = []
    const recorder = {
      setTransform: () => {},
      save: () => {},
      restore: () => {},
      fillRect: () => {},
      set fillStyle(_value: string) {},
      drawImage: (source: unknown, x: number, y: number) => drawn.push({ source, x, y }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      recorder as unknown as CanvasRenderingContext2D,
    )
    const first = { width: 10, height: 10 } as HTMLCanvasElement
    const second = { width: 10, height: 10 } as HTMLCanvasElement
    const cells: Array<CellFigure | null> = [
      { width: 100, height: 50, raster: () => first, vector: () => {} },
      null,
      { width: 80, height: 60, raster: () => second, vector: () => {} },
    ]
    const out = rasterDeck(cells, 2, '#ffffff', 192)
    const layout = deckLayout(cells, 2)
    expect(out?.width).toBe(Math.round(layout.width * 2))
    expect(out?.height).toBe(Math.round(layout.height * 2))
    expect(drawn).toEqual([
      { source: first, x: 0, y: 0 },
      { source: second, x: 0, y: Math.round(layout.at(2).y * 2) },
    ])
  })
})

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

describe('the deck’s PDF', () => {
  it('draws each cell at its place on the page, as paths and text', async () => {
    const page = vectorDeck([pathCell(100, 50, 'first'), pathCell(100, 50, 'second')], 2, '#ffffff')
    const bytes = await bytesOf(page)
    const content = await contentOf(bytes)
    expect(latin1(bytes)).not.toContain('/Subtype /Image')
    expect(content).toContain('(first) Tj')
    expect(content).toContain('(second) Tj')
    // The second cell's rectangle is the first's, one cell and the air across;
    // the page's y runs up, so a corner 5 px down is `height - 5`.
    const gap = 100 * DECK_FIGURE_GAP
    expect(content).toContain(`5 45 m`)
    expect(content).toContain(`${Number((105 + gap).toFixed(3))} 45 m`)
  })

  it('holds a map’s cells as one image the size of its plot, and the rest as paths and text', async () => {
    const panel = map()
    const now = new Date(2026, 9, 1, 12, 0, 0)
    const figure = panel.deckFigure(now)
    const page = vectorDeck([figure, pathCell(120, 80, 'beside')], 2, '#ffffff')
    const bytes = await bytesOf(page)
    const content = await contentOf(bytes)
    const size = pageSize(bytes)

    // One image, the map's cells — and not the page: the old figure was one
    // image exactly as large as the page.
    expect((latin1(bytes).match(/\/Subtype \/Image/g) ?? []).length).toBe(1)
    const [image] = placements(content)
    expect(image).toBeDefined()
    expect(image.width).toBeLessThan(figure.width)
    expect(image.height).toBeLessThan(figure.height)
    expect(image.width).toBeLessThan(size.width / 2)

    // Everything else is drawing: the caption and the cell beside it as text,
    // the frame and the cell's mark as paths.
    expect(content).toContain('(beside) Tj')
    expect((content.match(/ Tj$/gm) ?? []).length).toBeGreaterThan(1)
    expect(content).toMatch(/^S$/m)
    expect(content).toMatch(/^f$/m)
  })
})

describe('saving the deck', () => {
  it('writes its PDF as a drawing, a model and all, under a name with no resolution in it', async () => {
    const lead = leadPanel()
    const deck = new PanelDeck({
      onMapsChange: () => {},
      memoryKey: () => 'deck-figure-test',
      leadName: () => 'lead.cool',
      leadLabel: () => 'lead.cool',
      structure: {
        store: () => fakeStore([structureEntry()]) as never,
        manual: () => new ManualStore(`deck-figure-marks-${Math.random()}`),
        contacts: () => null,
        onGoTo: () => {},
        onDrop: () => {},
        onDropUrl: () => {},
      },
    })
    document.body.appendChild(deck.el)
    const view = document.createElement('div')
    view.appendChild(document.createElement('div')).className = 'view-head'
    deck.frame(view)
    deck.setLead(lead.panel)
    deck.add({ kind: 'structure' })

    const saved = savePicker()
    expect(await lead.state.exporter?.save('pdf', 600)).toBe(true)
    expect(saved.names).toHaveLength(1)
    expect(saved.names[0]).toMatch(/^deck-\d{8}-\d{6}\.pdf$/)
    const bytes = new Uint8Array(await saved.blobs[0].arrayBuffer())
    const content = await contentOf(bytes)
    // The model is the painter's paths — its tube, by default, as closed
    // outlines, a band of its shading each — and its name is text: no raster
    // anywhere on a deck with no map's cells on it.
    expect(latin1(bytes)).not.toContain('/Subtype /Image')
    expect(content).toMatch(/^h$/m)
    expect(content).toContain('(chr1) Tj')
    deck.destroy()
  })
})
