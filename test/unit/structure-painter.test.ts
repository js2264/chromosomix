/**
 * The vector painter draws the beads and sticks as paths, through the app's
 * own PDF context (§25).
 *
 * `drawingOf` runs the same `draw` the export runs into a `VectorPage`, so a
 * figure that drew nothing is caught by an empty operator stream — and a
 * painter that reached for something outside `VectorTarget` is caught at the
 * type level, which is the whole reason the subset exists.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import { defaultStructureStyle } from '@/annotations/types'
import { defaultCamera, fitCamera } from '@/structure/camera'
import { resolveColours } from '@/structure/colour'
import { PAPER_PALETTE, drawStructure, drawStructureLabels, fogAt, type StructureView } from '@/structure/painter'
import { buildStructure, centroidOf, distanceBetween } from '@/structure/scene'
import { fmt } from '@/units'
import { VectorPage, pdfColour } from '@/ui/vector'

function rows(lines: string[]): string {
  return lines.map((line) => line.replace(/ +/g, '\t')).join('\n')
}

const MODEL = rows([
  'chrA 0 0 0 0',
  'chrA 10000 1 0 0',
  'chrA 20000 2 0.5 0',
  'chrA 40000 4 1 0',
  'chrB 0 0 2 1',
  'chrB 10000 1 2 1',
])

function view(overrides: Partial<StructureView> = {}): StructureView {
  const structure = buildStructure(parseG3d(MODEL))
  if (structure === null) throw new Error('no model')
  const all = centroidOf(structure, Array.from({ length: structure.set.length }, (_, i) => i))
  const camera = all === null ? defaultCamera() : fitCamera(defaultCamera(), all)
  const style = { ...defaultStructureStyle(), beads: true, sticks: true, tube: false }
  return {
    structure,
    camera,
    style,
    colours: resolveColours(structure, style),
    lit: null,
    hovered: [],
    pinned: -1,
    chord: null,
    chords: [],
    measures: [],
  marks: [],
    ruler: [],
    overlay: null,
    haplotype: -1,
    ...overrides,
  }
}

async function streamOf(v: StructureView): Promise<string> {
  const page = new VectorPage(400, 300)
  drawStructure(page.ctx, { width: 400, height: 300 }, v, PAPER_PALETTE)
  const blob = await page.toBlob({ title: 'test', created: new Date(0) })
  return blob.text()
}

describe('the painter', () => {
  it('puts marks on the page', async () => {
    // The content stream is deflated, so what can be asserted is that it is
    // there and that it is larger than a page with nothing drawn on it.
    const drawn = await streamOf(view())
    const empty = new VectorPage(400, 300)
    const blank = await (await empty.toBlob({ title: 'test', created: new Date(0) })).text()
    expect(drawn).toContain('/Length')
    expect(drawn.length).toBeGreaterThan(blank.length + 200)
  })

  it('draws a dashed run across a gap, always', async () => {
    const sticks = { ...defaultStructureStyle(), beads: false, sticks: true, tube: false }
    const dashed = await streamOf(view({ style: sticks }))
    // The gap between 20 kb and 40 kb on chrA is a dashed segment of ink. With
    // the far side of the gap hidden there is no gap to dash and one stick
    // fewer — and a deflated stream with fewer operators in it is a shorter one.
    const lit = new Uint8Array([1, 1, 1, 0, 1, 1])
    const cut = await streamOf(view({ lit, style: { ...sticks, others: 'hide' } }))
    expect(dashed.length).toBeGreaterThan(cut.length)
  })

  it('hides beads outside the window under `hide`, and keeps them under `ghost`', async () => {
    const lit = new Uint8Array([1, 1, 0, 0, 0, 0])
    const ghosted = await streamOf(view({ lit }))
    const hidden = await streamOf(
      view({ lit, style: { ...defaultStructureStyle(), beads: true, sticks: false, tube: false, others: 'hide' } }),
    )
    const beadsOnly = await streamOf(view({ style: { ...defaultStructureStyle(), beads: true, sticks: false, tube: false } }))
    expect(hidden.length).toBeLessThan(beadsOnly.length)
    expect(ghosted.length).toBeGreaterThanOrEqual(beadsOnly.length)
  })

  it('draws a haloed bead for the pointer and a chord between two', async () => {
    const bare = await streamOf(view({ style: { ...defaultStructureStyle(), beads: true, sticks: false, tube: false } }))
    const marked = await streamOf(
      view({ style: { ...defaultStructureStyle(), beads: true, sticks: false, tube: false }, hovered: [0], chord: [0, 3] }),
    )
    expect(marked.length).toBeGreaterThan(bare.length)
  })

  it('draws one haplotype alone when asked', async () => {
    const both = await streamOf(view())
    const one = await streamOf(view({ haplotype: 0 }))
    // An unphased file has one haplotype, so asking for it draws everything.
    expect(one.length).toBe(both.length)
  })
})

/**
 * The page's content stream, inflated — the operators a PDF reader draws with.
 * Located by its declared length, as `vector.test.ts` reads it. And never an
 * image: whatever the model is drawn as, its page is paths and text.
 */
async function contentOf(v: StructureView, box = { width: 400, height: 300 }): Promise<string> {
  const page = new VectorPage(box.width, box.height)
  drawStructure(page.ctx, box, v, PAPER_PALETTE)
  const bytes = new Uint8Array(await (await page.toBlob({ title: 'test', created: new Date(0) })).arrayBuffer())
  const text = new TextDecoder('latin1').decode(bytes)
  expect(text).not.toContain('/Subtype /Image')
  const header = /4 0 obj\n<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/.exec(text)
  if (header === null) throw new Error('no content stream')
  const at = (header.index ?? 0) + header[0].length
  const raw = bytes.slice(at, at + Number(header[1]))
  if (header[2] === undefined) return new TextDecoder('latin1').decode(raw)
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new TextDecoder('latin1').decode(new Uint8Array(await new Response(stream).arrayBuffer()))
}

/** A colour as the page writes it: `r g b` to three decimals, trailing zeros dropped. */
function rgbOf(hex: string): string {
  const [r, g, b] = pdfColour(hex)
  const trim = (value: number): string => value.toFixed(3).replace(/\.?0+$/, '')
  return `${trim(r)} ${trim(g)} ${trim(b)}`
}

describe('the tube', () => {
  const tube = { ...defaultStructureStyle(), beads: false, sticks: false, tube: true, axes: false, labels: false }

  it('is paths: the curve the screen draws, a rim under a core, and no image', async () => {
    // Wide enough to be shaded: two tones, so two stroke colours per bead.
    const content = await contentOf(view({ style: { ...tube, tubeRadius: 0.5 } }))
    // The spline's spans are cubics, written as cubics.
    expect(content).toMatch(/ c$/m)
    const strokes = new Set(content.match(/^[\d.]+ [\d.]+ [\d.]+ RG$/gm) ?? [])
    expect(strokes.size).toBeGreaterThanOrEqual(4)
    // A run's two ends are round, which a butt-ended stroke cannot be: a disc.
    expect(content).toMatch(/^f$/m)
  })

  it('is one flat stroke per bead where it is too thin for two tones', async () => {
    // A small page, so the thinner tube is a pixel or less across.
    const small = { width: 40, height: 30 }
    const wide = await contentOf(view({ style: { ...tube, tubeRadius: 0.5 } }), small)
    const thin = await contentOf(view({ style: { ...tube, tubeRadius: 0.05 } }), small)
    const count = (content: string): number => (content.match(/^S$/gm) ?? []).length
    expect(count(thin)).toBeLessThan(count(wide))
  })

  it('dashes the gap where the file left a bead out, whatever the model is drawn as', async () => {
    // chrA's beads at 20 kb and 40 kb are a gap; the dashes are butt-capped ink.
    for (const style of [tube, { ...tube, tube: false, beads: true }]) {
      const content = await contentOf(view({ style }))
      expect(content).toMatch(/^0 J$/m)
      expect(content).toContain(`${rgbOf(PAPER_PALETTE.ink)} RG`)
    }
  })

  it('leaves out what the depth slab cuts away', async () => {
    const whole = await contentOf(view({ style: tube }))
    const sliced = await contentOf(view({ style: { ...tube, slab: 0.05 } }))
    expect(sliced.length).toBeLessThan(whole.length)
  })
})

describe('what else the PNG carries, on the page too', () => {
  const plain = { ...defaultStructureStyle(), beads: true, sticks: false, tube: false, labels: false }

  it('draws the centre of rotation in the axis colours, when the style shows it', async () => {
    const shown = await contentOf(view({ style: { ...plain, axes: true } }))
    const hidden = await contentOf(view({ style: { ...plain, axes: false } }))
    for (const colour of ['#d8453c', '#2f9e44', '#3b7ddd']) {
      expect(shown).toContain(`${rgbOf(colour)} rg`)
      expect(hidden).not.toContain(`${rgbOf(colour)} rg`)
    }
  })

  it('draws the ruler’s ticks and writes their labels', async () => {
    const content = await contentOf(view({ style: { ...plain, axes: false }, ruler: [{ bead: 2, label: '20 kb' }] }))
    expect(content).toContain('(20 kb) Tj')
  })

  it('writes a measurement in the file’s own units, as the card and the cell print it', async () => {
    const v = view({ style: { ...plain, axes: false }, measures: [[0, 3]] })
    const content = await contentOf(v)
    expect(content).toContain(`(${fmt.num(distanceBetween(v.structure, 0, 3))}) Tj`)
  })

  it('names the bookmarks with the sequences, under the same switch', async () => {
    const named = await contentOf(
      view({ style: { ...plain, axes: false, labels: true }, bookmarks: [{ bead: 1, label: 'my locus' }] }),
    )
    expect(named).toContain('(my locus) Tj')
    expect(named).toContain('(chrA) Tj')
    const unnamed = await contentOf(
      view({ style: { ...plain, axes: false, labels: false }, bookmarks: [{ bead: 1, label: 'my locus' }] }),
    )
    expect(unnamed).not.toContain('(my locus) Tj')
  })
})

describe('the words on the model', () => {
  it('are the cell’s: a sequence hidden from the window is not named, and one ghosted is named faintly', () => {
    const written: Array<{ text: string; alpha: number }> = []
    let alpha = 1
    const ctx = {
      save: () => {},
      restore: () => {},
      setLineDash: () => {},
      fillText: (text: string) => written.push({ text, alpha }),
      set globalAlpha(value: number) {
        alpha = value
      },
      get globalAlpha() {
        return alpha
      },
      set font(_value: string) {},
      set textAlign(_value: string) {},
      set textBaseline(_value: string) {},
      set fillStyle(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    const labels = { ...defaultStructureStyle(), labels: true }
    // chrB's beads outside the window: ghosted, then hidden.
    const lit = new Uint8Array([1, 1, 1, 1, 0, 0])
    drawStructureLabels(ctx, { width: 400, height: 300 }, view({ style: labels, lit }), PAPER_PALETTE)
    expect(written.filter((run) => run.text === 'chrB').every((run) => run.alpha < 1)).toBe(true)
    expect(written.some((run) => run.text === 'chrB')).toBe(true)
    expect(written.filter((run) => run.text === 'chrA').every((run) => run.alpha === 1)).toBe(true)
    written.length = 0
    drawStructureLabels(
      ctx,
      { width: 400, height: 300 },
      view({ style: { ...labels, others: 'hide' }, lit }),
      PAPER_PALETTE,
    )
    expect(written.some((run) => run.text === 'chrB')).toBe(false)
    expect(written.some((run) => run.text === 'chrA')).toBe(true)
  })
})

describe('the fog', () => {
  it('is the screen’s: nothing in front of the centre of rotation, the page half a slab / fog behind it', () => {
    const camera = { ...defaultCamera(), distance: 10 }
    const style = { ...defaultStructureStyle(), fog: 0.5, fogOn: true }
    const fog = fogAt(camera, style, 2)
    expect(fog(8)).toBe(0)
    expect(fog(10)).toBe(0)
    expect(fog(12)).toBeCloseTo(0.5, 9)
    expect(fog(14)).toBe(1)
    expect(fogAt(camera, { ...style, fogOn: false }, 2)(14)).toBe(0)
  })
})
