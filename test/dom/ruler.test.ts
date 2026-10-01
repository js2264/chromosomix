// @vitest-environment jsdom
/**
 * The ruler's own box, and the coordinates that have to fit in it.
 *
 * `drawRuler` clips to the ruler before it draws anything, which is right — the
 * bands are laid out across the whole assembly and a name near the edge would
 * otherwise be written over the tracks below. What it clipped *to* was the
 * module constant `RULER_HEIGHT`, which is the height at a text scale of one.
 *
 * Nothing runs at a text scale of one. The default is 1.35 (`ui/textScale.ts`
 * explains why: the sizes here were picked against the geometry, and geometry
 * does not know how far away the screen is), both callers size their canvas with
 * `rulerHeightFor(scale)`, and the scale row is a line of text that grows with
 * it. So the ruler was drawn into a box six pixels shorter than the one it had
 * been given, and the bottom of every coordinate label was shaved off — for
 * every reader who had never touched the control, and worse for every one who
 * had turned it up.
 *
 * The one thing a test can see about a clip is the rectangle it was taken
 * against, so that is what this asserts, through a recording context rather than
 * a mock of one: jsdom has no 2D context, and the app's own `VectorPage` does
 * not record a clip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assemblyOf, assemblyAxis } from '@/genome/assembly'
import {
  BAND_HEIGHT,
  RULER_HEIGHT,
  drawRuler,
  placeTickLabels,
  rulerHeightFor,
  type RulerFrame,
} from '@/render/browser'
import { Scale } from '@/render/scale'
import { SequenceBar } from '@/ui/SequenceBar'
import { TEXT_SCALE_STEPS, getTextScale, setTextScale } from '@/ui/textScale'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
  window.localStorage.clear()
})

const GENOME = assemblyOf({
  uri: 'test.cool',
  name: 'test',
  origin: 'cooler',
  contigs: [
    { name: 'I', length: 1000 },
    { name: 'II', length: 2000 },
    { name: 'III', length: 3000 },
  ],
})

const WIDTH = 400

/** Every rectangle a path was built from, and every string that was written. */
interface Recording {
  rects: Array<{ x: number; y: number; width: number; height: number }>
  /** `[text, x, y]` for each `fillText`, in the order they were drawn. */
  texts: Array<[string, number, number]>
  /** The clip taken, which is the last `rect` before the `clip()` call. */
  clip: { x: number; y: number; width: number; height: number } | null
}

/**
 * A `CanvasRenderingContext2D` that keeps what it was told, for the handful of
 * calls this module makes. Not a mock of the drawing: what comes back is the
 * geometry the real `drawRuler` computed.
 */
function recorder(): { ctx: CanvasRenderingContext2D; log: Recording } {
  const log: Recording = { rects: [], texts: [], clip: null }
  let pending: Recording['clip'] = null
  const ctx = {
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: (x: number, y: number, width: number, height: number) => {
      pending = { x, y, width, height }
      log.rects.push({ x, y, width, height })
    },
    clip: () => {
      log.clip = pending
    },
    fillRect: () => {},
    clearRect: () => {},
    setTransform: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    quadraticCurveTo: () => {},
    // 7 px a character is close enough to a real 13 px system font for the
    // "does the name fit its band" decision, which is all it is used for.
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillText: (text: string, x: number, y: number) => {
      log.texts.push([text, x, y])
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log }
}

function frameOf(extra: Partial<RulerFrame> = {}): RulerFrame {
  const axis = assemblyAxis(GENOME)
  const scale = new Scale([0, axis.unitEnd], WIDTH)
  return {
    x: 0,
    y: 0,
    width: WIDTH,
    toPixel: (unit: number) => scale.toPixel(unit),
    axis,
    domain: scale.domain,
    palette: {
      text: '#000',
      faint: '#666',
      line: '#999',
      divider: '#999',
      band: '#eee',
      halo: '#fff',
    },
    dpr: 1,
    ...extra,
  }
}

describe('the box the ruler is drawn into', () => {
  it('is the height it was given', () => {
    const { ctx, log } = recorder()
    drawRuler(ctx, frameOf({ height: 90 }))
    expect(log.clip).toEqual({ x: 0, y: 0, width: WIDTH, height: 90 })
  })

  it('is the unscaled height when it was given none', () => {
    const { ctx, log } = recorder()
    drawRuler(ctx, frameOf())
    expect(log.clip?.height).toBe(RULER_HEIGHT)
  })

  it('starts where the ruler starts, not where the canvas does', () => {
    const { ctx, log } = recorder()
    drawRuler(ctx, frameOf({ x: 40, y: 12, width: 200, height: 72 }))
    expect(log.clip).toEqual({ x: 40, y: 12, width: 200, height: 72 })
  })

  it('holds the coordinate row it is asked to hold, at every rung', () => {
    for (const scale of TEXT_SCALE_STEPS) {
      const height = rulerHeightFor(scale)
      const { ctx, log } = recorder()
      drawRuler(ctx, frameOf({ height, fonts: { ruler: '600 13px x', tick: `${10 * scale}px x` } }))
      // The scale row's labels are written under the band with `textBaseline`
      // `top`, so the ink runs from there down by about the font size.
      const lowest = Math.max(...log.texts.map(([, , y]) => y))
      expect(lowest, `scale ${scale}`).toBeGreaterThanOrEqual(BAND_HEIGHT)
      expect(lowest + 10 * scale, `scale ${scale}`).toBeLessThanOrEqual(height)
    }
  })

  it('is taller than the constant at every rung above one — which is the bug', () => {
    for (const scale of TEXT_SCALE_STEPS.filter((step) => step > 1)) {
      expect(rulerHeightFor(scale)).toBeGreaterThan(RULER_HEIGHT)
    }
  })
})

describe('the bar over the Chromosomes table', () => {
  /** Mount a bar with a recording context behind its canvas, and paint once. */
  async function paint(): Promise<Recording> {
    const { ctx, log } = recorder()
    const prototype = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
    prototype.getContext = () => ctx
    const bar = new SequenceBar({
      assembly: GENOME,
      onOpenContig: () => {},
      onOpenRegion: () => {},
    })
    document.body.appendChild(bar.el)
    const stage = bar.el.querySelector('.seqbar-stage') as HTMLElement
    Object.defineProperty(stage, 'clientWidth', { value: WIDTH, configurable: true })
    bar.remeasure()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    bar.destroy()
    return log
  }

  it('clips to the strip it reserved, at the scale a reader has never touched', async () => {
    expect(getTextScale()).toBeGreaterThan(1)
    const log = await paint()
    const stage = document.querySelector<HTMLElement>('.seqbar-stage')
    expect(log.clip?.height).toBe(rulerHeightFor(getTextScale()))
    // And the strip's own CSS height is the same number, so the clip and the
    // space the table was pushed down by cannot disagree.
    expect(stage?.style.height).toBe(`${rulerHeightFor(getTextScale())}px`)
  })

  it('follows the reader up the rungs', async () => {
    setTextScale(TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1])
    const log = await paint()
    expect(log.clip?.height).toBe(rulerHeightFor(TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1]))
    expect(log.clip?.height).toBeGreaterThan(RULER_HEIGHT)
  })

  it('follows them back down again', async () => {
    setTextScale(TEXT_SCALE_STEPS[0])
    const log = await paint()
    expect(log.clip?.height).toBe(rulerHeightFor(TEXT_SCALE_STEPS[0]))
    expect(log.clip?.height).toBeLessThan(RULER_HEIGHT)
  })
})

/**
 * The coordinate row's labels stay inside the ruler.
 *
 * A tick on a window's first or last base sits on the ruler's edge, and its
 * label was centred on it — half outside the clip, so a deck's tracks cell read
 * `Mb` and `1.4` for `1.0 Mb` and `1.4 Mb`, and the browser `bp` for `0 bp`.
 * The mark stays where it is; the label is nudged in, as the heatmap's axis
 * nudges its own, and where that brings it against its neighbour the inner of
 * the two is left out.
 */
describe('a tick label at the end of the ruler', () => {
  it('stays on its tick where it fits', () => {
    expect(placeTickLabels([{ at: 100, width: 30 }, { at: 200, width: 30 }], 0, 400)).toEqual([100, 200])
  })

  it('is nudged inside the ruler at either end, two pixels clear of it', () => {
    const [first, last] = placeTickLabels([{ at: 0, width: 40 }, { at: 400, width: 40 }], 0, 400)
    expect(first).toBe(22)
    expect(last).toBe(378)
  })

  it('leaves out the inner of two labels that the nudge brings together, and keeps both ends', () => {
    // Ticks 60 apart and labels 56 wide: the first, nudged right, reaches the
    // second; the last, nudged left, reaches the one before it.
    const labels = [0, 60, 120, 180].map((at) => ({ at, width: 56 }))
    const places = placeTickLabels(labels, 0, 180)
    expect(places[0]).toBe(30)
    expect(places[1]).toBeNull()
    expect(places[2]).toBeNull()
    expect(places[3]).toBe(150)
  })

  it('keeps the first of two that meet, where there are only the two', () => {
    expect(placeTickLabels([{ at: 0, width: 50 }, { at: 40, width: 50 }], 0, 200)).toEqual([27, null])
  })

  it('leaves out a label too wide for the ruler at all', () => {
    expect(placeTickLabels([{ at: 20, width: 50 }], 0, 40)).toEqual([null])
  })

  it('never writes one label over another, or past either end', () => {
    // Every spacing and width this ruler meets, and more.
    for (const gap of [40, 60, 78, 100]) {
      for (const width of [20, 40, 56, 70]) {
        for (const offset of [0, 13, 37]) {
          const labels = Array.from({ length: 7 }, (_, k) => ({ at: offset + k * gap, width }))
          const to = offset + 6 * gap
          const places = placeTickLabels(labels, 0, to)
          const drawn = labels
            .map((label, k) => ({ ...label, place: places[k] }))
            .filter((label): label is { at: number; width: number; place: number } => label.place !== null)
          for (const label of drawn) {
            expect(label.place - label.width / 2).toBeGreaterThanOrEqual(0)
            expect(label.place + label.width / 2).toBeLessThanOrEqual(to)
          }
          for (let k = 1; k < drawn.length; k++) {
            expect(drawn[k].place - drawn[k].width / 2, `${gap} ${width} ${offset}`).toBeGreaterThan(
              drawn[k - 1].place + drawn[k - 1].width / 2,
            )
          }
        }
      }
    }
  })

  it('is drawn whole across a sequence ruled from its first base to its last', () => {
    // Sequence II alone, 2,000 bp across 400 pixels: ticks fall on both ends.
    const { ctx, log } = recorder()
    const axis = assemblyAxis(GENOME)
    const second = axis.segments[1]
    const scale = new Scale([second.unitStart, second.unitEnd], WIDTH)
    drawRuler(ctx, frameOf({ toPixel: (unit: number) => scale.toPixel(unit), domain: scale.domain }))
    const ticks = log.texts.filter(([, , y]) => y > BAND_HEIGHT)
    expect(ticks.length).toBeGreaterThan(2)
    expect(ticks[0][0]).toBe('0 bp')
    for (const [text, x] of ticks) {
      const half = (text.length * 7) / 2
      expect(x - half, text).toBeGreaterThanOrEqual(0)
      expect(x + half, text).toBeLessThanOrEqual(WIDTH)
    }
  })
})
