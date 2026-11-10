// @vitest-environment jsdom
/**
 * The map's Export card (§7.2): what its formats are called, and what the row
 * offers for each.
 *
 * The map's PDF is a vector page with the cells the one image on it, so the
 * format reads `PDF (vector)`, as the 1D browser's does; and a vector page has
 * no resolution, so the resolution goes while PDF is chosen — and the copy,
 * which takes a PNG whatever the format says, names the one it will use. The
 * PDF's file name carries no resolution either; the PNG's does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let shimmedBlob: typeof Blob
const built: MatrixPanel[] = []

beforeEach(async () => {
  teardown = setUpDom({ canvas: 'stub' })
  // jsdom's `Blob` has no `stream()`, which the PDF's deflate needs.
  const { Blob: PlatformBlob } = await import('node:buffer')
  shimmedBlob = globalThis.Blob
  Object.defineProperty(globalThis, 'Blob', { value: PlatformBlob, configurable: true })
})

afterEach(() => {
  for (const panel of built.splice(0)) panel.destroy()
  Object.defineProperty(globalThis, 'Blob', { value: shimmedBlob, configurable: true })
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  vi.restoreAllMocks()
  teardown()
})

function map(): MatrixPanel {
  const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
  built.push(panel)
  document.body.append(panel.el, panel.exportEl)
  return panel
}

function parts(panel: MatrixPanel): { dpi: HTMLSelectElement; format: HTMLSelectElement; copy: HTMLButtonElement } {
  const dpi = panel.exportEl.querySelector<HTMLSelectElement>('.select-dpi')
  const format = panel.exportEl.querySelector<HTMLSelectElement>('.select-format')
  const copy = panel.exportEl.querySelectorAll<HTMLButtonElement>('.export-acts button')[1]
  if (dpi === null || format === null || copy === undefined) throw new Error('no export row')
  return { dpi, format, copy }
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change'))
}

/** The save dialog, answered with what it was asked to call the file. */
function savePicker(): string[] {
  const names: string[] = []
  ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options: {
    suggestedName: string
  }) => {
    names.push(options.suggestedName)
    return {
      name: options.suggestedName,
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    }
  }
  return names
}

describe('the map’s Export card', () => {
  it('calls its PDF what it is: a vector page', () => {
    const { format } = parts(map())
    expect([...format.options].map((option) => option.textContent)).toEqual(['PDF (vector)', 'PNG'])
    expect(format.title).toMatch(/one lossless image/)
    expect(format.title).toMatch(/paths and text/)
  })

  it('puts the resolution away while PDF is chosen, and says on the copy which one the PNG takes', () => {
    const panel = map()
    const { dpi, format, copy } = parts(panel)
    // PDF is the default.
    expect(format.value).toBe('pdf')
    expect(dpi.hidden).toBe(true)
    expect(copy.title).toMatch(/at 300 dpi/)
    choose(dpi, '600')
    expect(copy.title).toMatch(/at 600 dpi/)
    choose(format, 'png')
    expect(dpi.hidden).toBe(false)
    expect(copy.title).not.toMatch(/dpi/)
  })

  it('names a PDF with no resolution, and a PNG with its own', async () => {
    const panel = map()
    const names = savePicker()
    const status = (): string => panel.exportEl.querySelector('.export-note')?.textContent ?? ''
    panel.savePlot()
    await vi.waitFor(() => expect(status()).toMatch(/·/))
    choose(parts(panel).format, 'png')
    // jsdom cannot encode a canvas; the encode is the browser's, and not what
    // is being asked here.
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (done) {
      done(new Blob([]) as unknown as globalThis.Blob)
    })
    panel.savePlot()
    await vi.waitFor(() => expect(names).toHaveLength(2))
    expect(names[0]).toMatch(/-\d{8}-\d{6}\.pdf$/)
    expect(names[0]).not.toMatch(/dpi/)
    expect(names[1]).toMatch(/-\d{8}-\d{6}-300dpi\.png$/)
  })
})

/** Chromosome IV's first 64 kb, a bin to a cell. */
function block(): MatrixResult {
  return {
    nrows: 64,
    ncols: 64,
    values: new Float32Array(64 * 64).fill(1),
    rowExtent: [0, 64],
    colExtent: [0, 64],
    rowGroups: [{ label: 'IV', start: 0, end: 64, unitStart: 0 }],
    colGroups: [{ label: 'IV', start: 0, end: 64, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

describe('a figure is the picture on screen (§19.2)', () => {
  it('is drawn from the block on screen at once, reading nothing', async () => {
    // A figure used to read the framed window at the resolution picked before
    // it drew. It is what the reader sees: the block on screen, its grid and its
    // colours, whatever the picker says.
    const panel = map()
    panel.setData(block(), 'IV')
    const said: string[] = []
    const note = panel.exportEl.querySelector('.export-note')
    if (note === null) throw new Error('no note')
    new MutationObserver(() => said.push(note.textContent ?? '')).observe(note, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    savePicker()
    panel.savePlot()
    await vi.waitFor(() => expect(note.textContent).toMatch(/\.pdf · /))
    expect(said.some((line) => /reading/.test(line))).toBe(false)
  })
})
