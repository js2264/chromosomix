/**
 * A `log2` lane's axis in distances (§18.12): where its floor goes, the round
 * numbers it is ruled at, how its ends are written, and that its words step
 * round the lane's label rather than being written through it.
 *
 * The scalogram's lane is the case: its values are log2 of a reach in base
 * pairs, and its label read `0 – 16.7` — exponents, anchored at one base —
 * where a reader wants `1 kb – 104 kb` and a rule at 10 kb.
 */

import { describe, expect, it } from 'vitest'

import type { LaneFrame } from '@/render/lane'
import {
  drawLogRules,
  drawLogWords,
  formatScaledLimit,
  logAxisTicks,
  resolveLimits,
} from '@/render/tracks'

const AUTO = { auto: true, min: 0, max: 1 }
const kb = (n: number): number => Math.log2(n * 1000)

describe('resolveLimits on a log2 lane', () => {
  it('floors a length at the decade below the data, not at one base', () => {
    const limits = resolveLimits(AUTO, { min: kb(1.5), max: kb(104) }, 'log2', 'bp')
    expect(limits.min).toBeCloseTo(kb(1), 9)
    expect(limits.max).toBeCloseTo(kb(104), 9)
  })

  it('keeps a decade the data starts on', () => {
    const limits = resolveLimits(AUTO, { min: kb(1), max: kb(50) }, 'log2', 'bp')
    expect(limits.min).toBeCloseTo(kb(1), 9)
  })

  it('floors a plain number at the power of two below it', () => {
    expect(resolveLimits(AUTO, { min: 3.4, max: 7.2 }, 'log2')).toEqual({ min: 3, max: 7.2 })
  })

  it('leaves a linear lane anchored at zero, and limits a reader typed alone', () => {
    expect(resolveLimits(AUTO, { min: 3, max: 9 })).toEqual({ min: 0, max: 9 })
    expect(resolveLimits({ auto: false, min: 11, max: 15 }, { min: kb(1.5), max: kb(104) }, 'log2', 'bp')).toEqual({
      min: 11,
      max: 15,
    })
  })

  it('gives a flat lane a span to draw in', () => {
    const limits = resolveLimits(AUTO, { min: kb(10), max: kb(10) }, 'log2', 'bp')
    expect(limits.max).toBeGreaterThan(limits.min)
  })
})

describe('formatScaledLimit', () => {
  it('writes a log2 length as the length', () => {
    expect(formatScaledLimit(kb(1), 'log2', 'bp')).toBe('1 kb')
    expect(formatScaledLimit(kb(104), 'log2', 'bp')).toBe('104 kb')
    expect(formatScaledLimit(Math.log2(2_100_000), 'log2', 'bp')).toBe('2.1 Mb')
    expect(formatScaledLimit(Math.log2(500), 'log2', 'bp')).toBe('500 bp')
  })

  it('writes a log2 number as the number, and a linear one as it was', () => {
    expect(formatScaledLimit(3, 'log2')).toBe('8')
    expect(formatScaledLimit(16.7, 'linear')).toBe('16.7')
  })
})

describe('logAxisTicks', () => {
  it('rules a scalogram lane at each power of ten, named as a bin size is', () => {
    const ticks = logAxisTicks({ min: kb(1), max: kb(104) }, 'bp')
    expect(ticks.map((tick) => tick.label)).toEqual(['1 kb', '10 kb', '100 kb'])
    expect(ticks[1].at).toBeCloseTo(kb(10), 9)
  })

  it('reaches into megabases', () => {
    expect(logAxisTicks({ min: kb(5), max: Math.log2(3_000_000) }, 'bp').map((tick) => tick.label)).toEqual([
      '10 kb',
      '100 kb',
      '1 Mb',
    ])
  })

  it('takes the 1–2–5 steps across less than two decades of a length', () => {
    expect(logAxisTicks({ min: kb(1), max: kb(9) }, 'bp').map((tick) => tick.label)).toEqual(['1 kb', '2 kb', '5 kb'])
    expect(logAxisTicks({ min: kb(2), max: kb(4.9) }, 'bp').map((tick) => tick.label)).toEqual(['2 kb', '3 kb', '4 kb'])
  })

  it('falls back on powers of two for a plain number', () => {
    expect(logAxisTicks({ min: 3, max: 6 }).map((tick) => tick.label)).toEqual(['8', '16', '32', '64'])
  })

  it('has nothing to rule on an empty or broken span', () => {
    expect(logAxisTicks({ min: 5, max: 5 }, 'bp')).toEqual([])
    expect(logAxisTicks({ min: Number.NaN, max: 5 }, 'bp')).toEqual([])
  })
})

/** A context that keeps what was written and the strokes it was asked for. */
function recorder() {
  const words: Array<{ text: string; x: number; y: number }> = []
  let lines = 0
  let at: [number, number] = [0, 0]
  const ctx = {
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    globalAlpha: 1,
    save() {},
    restore() {
      at = [0, 0]
    },
    translate(x: number, y: number) {
      at = [x, y]
    },
    rotate() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      lines++
    },
    strokeText() {},
    fillText(text: string) {
      words.push({ text, x: at[0], y: at[1] })
    },
    measureText(text: string) {
      return { width: text.length * 5 }
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, words, lines: () => lines }
}

const frame = (orientation: LaneFrame['orientation']): LaneFrame => ({
  orientation,
  toPixel: (unit) => unit,
  toUnit: (pixel) => pixel,
  domain: [0, 400],
  alongFrom: 0,
  alongTo: 400,
  acrossFrom: 100,
  thickness: 60,
})

const PAINT = {
  limits: { min: kb(1), max: kb(104) },
  flip: false,
  guideColour: '#555',
  haloColour: '#fff',
  font: '9px system-ui',
}

describe('drawing the axis', () => {
  it('rules the decades inside the lane and none on its edges', () => {
    const wide = { ...PAINT, limits: { min: kb(1), max: kb(300) } }
    const one = recorder()
    drawLogRules(one.ctx, frame('bottom'), logAxisTicks(wide.limits, 'bp'), wide)
    // 1 kb is the lane's own edge; 10 kb and 100 kb are inside it.
    expect(one.lines()).toBe(2)
    // Up to 104 kb, 100 kb is a third of a pixel from the far edge: the edge.
    const two = recorder()
    drawLogRules(two.ctx, frame('bottom'), logAxisTicks(PAINT.limits, 'bp'), PAINT)
    expect(two.lines()).toBe(1)
  })

  it('writes every distance at the lane’s far end, kept inside the lane', () => {
    const { ctx, words } = recorder()
    const lane = frame('bottom')
    drawLogWords(ctx, lane, logAxisTicks(PAINT.limits, 'bp'), PAINT)
    expect(words.map((word) => word.text)).toEqual(['1 kb', '10 kb', '100 kb'])
    for (const word of words) {
      expect(word.x).toBe(lane.alongTo - 3)
      // A bottom lane runs down the page from its edge by the map.
      expect(word.y).toBeGreaterThanOrEqual(lane.acrossFrom + 4.5)
      expect(word.y).toBeLessThanOrEqual(lane.acrossFrom + lane.thickness - 4.5)
    }
  })

  it('leaves out a word that would land on the label', () => {
    const { ctx, words } = recorder()
    const lane = frame('bottom')
    // The label's block over the whole far end of the lane: across 0 to 20 of
    // a bottom lane, which grows inward, is the 100 kb end.
    const plate: [number, number, number, number] = [0, lane.acrossFrom, 400, 20]
    drawLogWords(ctx, lane, logAxisTicks(PAINT.limits, 'bp'), PAINT, [plate])
    expect(words.map((word) => word.text)).toEqual(['1 kb', '10 kb'])
  })

  it('writes nothing on a lane too thin to hold a word clear of its edges', () => {
    const { ctx, words } = recorder()
    drawLogWords(ctx, { ...frame('left'), thickness: 8 }, logAxisTicks(PAINT.limits, 'bp'), PAINT)
    expect(words).toEqual([])
  })
})
