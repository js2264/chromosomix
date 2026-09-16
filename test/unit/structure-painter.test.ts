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
import { PAPER_PALETTE, drawStructure, type StructureView } from '@/structure/painter'
import { buildStructure, centroidOf } from '@/structure/scene'
import { VectorPage } from '@/ui/vector'

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
  const style = { ...defaultStructureStyle(), representation: 'beads+sticks' as const }
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

  it('draws sticks only along runs, never across a gap unless asked', async () => {
    const plain = await streamOf(view({ style: { ...defaultStructureStyle(), representation: 'sticks' } }))
    const dashed = await streamOf(
      view({ style: { ...defaultStructureStyle(), representation: 'sticks', gaps: 'dashed' } }),
    )
    // The gap between 20 kb and 40 kb on chrA is one more stroked segment
    // under `dashed`, drawn with a dash pattern, which the plain figure lacks —
    // and a deflated stream with more operators in it is a longer one.
    expect(dashed.length).toBeGreaterThan(plain.length)
  })

  it('hides beads outside the window under `hide`, and keeps them under `ghost`', async () => {
    const lit = new Uint8Array([1, 1, 0, 0, 0, 0])
    const ghosted = await streamOf(view({ lit }))
    const hidden = await streamOf(
      view({ lit, style: { ...defaultStructureStyle(), representation: 'beads', others: 'hide' } }),
    )
    const beadsOnly = await streamOf(view({ style: { ...defaultStructureStyle(), representation: 'beads' } }))
    expect(hidden.length).toBeLessThan(beadsOnly.length)
    expect(ghosted.length).toBeGreaterThanOrEqual(beadsOnly.length)
  })

  it('draws a haloed bead for the pointer and a chord between two', async () => {
    const bare = await streamOf(view({ style: { ...defaultStructureStyle(), representation: 'beads' } }))
    const marked = await streamOf(
      view({ style: { ...defaultStructureStyle(), representation: 'beads' }, hovered: [0], chord: [0, 3] }),
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
