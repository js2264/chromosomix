/**
 * An exported model is framed by its cell's edge (§25.7).
 *
 * A model zoomed past its cell is cut by the cell's edge; on screen the cell's
 * border says where, and an export without one left the model floating on the
 * page with a straight side sliced off it. `drawCellFrame` is what every export
 * of a model draws that edge with — the deck's PNG, the card's PNG and the
 * clipboard through `StructurePanel.exportCanvas`, and every PDF, the deck's
 * included, as a path — so the rule is pinned here, once.
 */

import { describe, expect, it } from 'vitest'

import { CELL_FRAME_WIDTH, drawCellFrame } from '@/structure/painter'
import { VectorPage } from '@/ui/vector'

interface Stroke {
  rect: [number, number, number, number]
  colour: string
  width: number
  dash: number[]
}

function recorder(): { ctx: CanvasRenderingContext2D; strokes: Stroke[] } {
  const strokes: Stroke[] = []
  const state = { strokeStyle: '#000', lineWidth: 1, dash: [] as number[] }
  const stack: Array<typeof state> = []
  const ctx = {
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(value: string) {
      state.strokeStyle = value
    },
    get lineWidth() {
      return state.lineWidth
    },
    set lineWidth(value: number) {
      state.lineWidth = value
    },
    save: () => stack.push({ ...state, dash: [...state.dash] }),
    restore: () => Object.assign(state, stack.pop() ?? state),
    setLineDash: (pattern: number[]) => {
      state.dash = [...pattern]
    },
    strokeRect: (x: number, y: number, w: number, h: number) => {
      strokes.push({ rect: [x, y, w, h], colour: state.strokeStyle, width: state.lineWidth, dash: state.dash })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes }
}

describe('the frame round an exported model', () => {
  it('is one rectangle whose outer edge is the edge of the picture', () => {
    const { ctx, strokes } = recorder()
    drawCellFrame(ctx, { width: 600, height: 400 }, '#b9bec5', 2)
    expect(strokes).toHaveLength(1)
    const [{ rect, width }] = strokes
    // Inset by half the line: the stroke runs from 0 to the far edge, all of it
    // on the page rather than half of it cut by the page's own edge.
    expect(rect[0] - width / 2).toBe(0)
    expect(rect[1] - width / 2).toBe(0)
    expect(rect[0] + rect[2] + width / 2).toBe(600)
    expect(rect[1] + rect[3] + width / 2).toBe(400)
  })

  it('is solid, in the colour and at the weight it is given, and leaves the pen as it was', () => {
    const { ctx, strokes } = recorder()
    ctx.setLineDash([4, 2])
    ctx.strokeStyle = '#123456'
    drawCellFrame(ctx, { width: 100, height: 100 }, '#b9bec5', 2.5)
    expect(strokes[0]).toMatchObject({ colour: '#b9bec5', width: 2.5, dash: [] })
    expect(ctx.strokeStyle).toBe('#123456')
  })

  it('weighs what the map’s plot border does, so a deck’s two cells are framed alike', () => {
    expect(CELL_FRAME_WIDTH).toBe(0.75)
  })

  it('reaches a PDF as a stroked path', async () => {
    const page = new VectorPage(300, 200)
    drawCellFrame(page.ctx, { width: 300, height: 200 }, '#b9bec5', CELL_FRAME_WIDTH)
    const content = await contentOf(new Uint8Array(await (await page.toBlob()).arrayBuffer()))
    // A four-cornered path, closed and stroked: the frame is in the figure as a
    // line and not as pixels.
    expect(content.match(/ l$/gm)).toHaveLength(3)
    expect(content).toMatch(/^h$/m)
    expect(content).toMatch(/^S$/m)
  })
})

/**
 * The page's content stream, inflated — the operators a PDF reader draws with.
 * Located by its declared length, as `vector.test.ts` reads it.
 */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const text = new TextDecoder('latin1').decode(bytes)
  const header = /4 0 obj\n<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/.exec(text)
  if (header === null) throw new Error('no content stream')
  const at = (header.index ?? 0) + header[0].length
  const raw = bytes.slice(at, at + Number(header[1]))
  if (header[2] === undefined) return new TextDecoder('latin1').decode(raw)
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new TextDecoder('latin1').decode(new Uint8Array(await new Response(stream).arrayBuffer()))
}
