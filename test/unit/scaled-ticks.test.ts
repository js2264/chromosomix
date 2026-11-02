/**
 * A scaled-region abscissa's ticks and their words (§18.8).
 *
 * A scaled metaplot's x is a column index, which nobody reads; what a reader
 * reads off the axis is where each feature *starts* and *ends*, how far through
 * it a column is, and how far out along a flank. `scaledLabel` is the spelling
 * and `scaledTicks` the choice of where, at the width the plot is drawn — so
 * every case here is a width and a window, and the answer the picture should
 * give at it.
 *
 * Labels are measured at six pixels a character and the type is 11 px, so the
 * least distance between two ticks is 66 px (`PITCH`, six ems).
 */

import { describe, expect, it } from 'vitest'

import { scaledLabel } from '@/analysis/run/labels'
import type { ScaledAxis } from '@/analysis/types'
import { scaledTicks } from '@/figures/scaledTicks'

/** 5 kb flanks of 50 bp columns about a 200-column body: the run in the reader's screenshot. */
const AXIS: ScaledAxis = { from: -0.5, start: 99.5, end: 299.5, to: 399.5, flankStep: 50 }
const WHOLE: [number, number] = [AXIS.from, AXIS.to]
const measure = (label: string): number => label.length * 6
const EM = 11

const words = (axis: ScaledAxis, ticks: number[]): string[] => ticks.map((x) => scaledLabel(axis, x))

describe('scaledLabel', () => {
  it('names the body’s edges, a share of the body, and a distance from the nearer edge', () => {
    expect(scaledLabel(AXIS, 99.5)).toBe('Start')
    expect(scaledLabel(AXIS, 299.5)).toBe('End')
    expect(scaledLabel(AXIS, 199.5)).toBe('50%')
    expect(scaledLabel(AXIS, 149.5)).toBe('25%')
    // The far ends of the flanks, signed on both sides: *which side* is the point.
    expect(scaledLabel(AXIS, -0.5)).toBe('-5 kb')
    expect(scaledLabel(AXIS, 399.5)).toBe('+5 kb')
    expect(scaledLabel(AXIS, 49.5)).toBe('-2.5 kb')
    expect(scaledLabel(AXIS, 319.5)).toBe('+1 kb')
  })

  it('spells a position between ticks too, as the pointer needs it', () => {
    // The crosshair's label and the tooltip's head are spelled by the same
    // function, wherever the pointer stands.
    expect(scaledLabel(AXIS, 99.5 + 200 * 0.374)).toBe('37.4%')
    expect(scaledLabel(AXIS, 99.2)).toBe('-15 bp')
    expect(scaledLabel(AXIS, Number.NaN)).toBe('')
  })
})

describe('scaledTicks', () => {
  it('takes every kilobase and every tenth where the plot is wide enough', () => {
    // 4.5 px a column: a kilobase is twenty columns, 90 px; 500 bp would be 45.
    const ticks = scaledTicks(AXIS, WHOLE, 1800, measure, EM)
    expect(words(AXIS, ticks)).toEqual([
      '-5 kb', '-4 kb', '-3 kb', '-2 kb', '-1 kb',
      'Start', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%', 'End',
      '+1 kb', '+2 kb', '+3 kb', '+4 kb', '+5 kb',
    ])
  })

  it('takes coarser steps in a narrower plot, and one that names the flank’s end', () => {
    // 2 px a column. Two kilobases and two and a half both fit, twice each;
    // 2.5 kb is the one whose last tick is the flank's end, so the axis still
    // says how far it reaches.
    const ticks = scaledTicks(AXIS, WHOLE, 800, measure, EM)
    expect(words(AXIS, ticks)).toEqual(['-5 kb', '-2.5 kb', 'Start', '25%', '50%', '75%', 'End', '+2.5 kb', '+5 kb'])
  })

  it('keeps Start and End when nothing else fits', () => {
    expect(words(AXIS, scaledTicks(AXIS, WHOLE, 200, measure, EM))).toEqual(['Start', 'End'])
  })

  it('keeps Start and End even where they touch', () => {
    // Two body columns between two long flanks: the edges are four pixels
    // apart, and an axis missing either has lost the thing it is for.
    const thin: ScaledAxis = { from: -0.5, start: 99.5, end: 101.5, to: 201.5, flankStep: 50 }
    const ticks = scaledTicks(thin, [thin.from, thin.to], 400, measure, EM)
    expect(words(thin, ticks)).toContain('Start')
    expect(words(thin, ticks)).toContain('End')
  })

  it('takes finer steps in a window wheeled into the body, and only what is inside it', () => {
    // The first half of the body across 800 px: 8 px a column, so a twentieth
    // of the body — ten columns — is 80 px.
    const ticks = scaledTicks(AXIS, [99.5, 199.5], 800, measure, EM)
    expect(words(AXIS, ticks)).toEqual(['Start', '5%', '10%', '15%', '20%', '25%', '30%', '35%', '40%', '45%', '50%'])
  })

  it('never steps finer than a column', () => {
    // Kilobase columns, five a flank and five in the body, across a very wide
    // plot: every kilobase and every quarter, and not 500 bp or a tenth, which
    // would name places inside a column the data has one number for.
    const coarse: ScaledAxis = { from: -0.5, start: 4.5, end: 9.5, to: 14.5, flankStep: 1000 }
    const ticks = scaledTicks(coarse, [coarse.from, coarse.to], 4000, measure, EM)
    expect(words(coarse, ticks)).toEqual([
      '-5 kb', '-4 kb', '-3 kb', '-2 kb', '-1 kb', 'Start', '25%', '50%', '75%', 'End',
      '+1 kb', '+2 kb', '+3 kb', '+4 kb', '+5 kb',
    ])
  })

  it('names a flank of no round length by its end', () => {
    // 5.1 kb, seventeen columns of 300 bp — what a 5 kb flank becomes at that
    // resolution. Nothing finer than 5 kb fits, and 5 kb would sit a hair
    // inside the end; the end itself is the better of the two single ticks.
    const odd: ScaledAxis = { from: -0.5, start: 16.5, end: 116.5, to: 133.5, flankStep: 300 }
    const ticks = scaledTicks(odd, [odd.from, odd.to], 1000, measure, EM)
    expect(words(odd, ticks)[0]).toBe('-5.1 kb')
    expect(ticks[0]).toBe(odd.from)
  })

  it('has no flank ticks where there are no flanks', () => {
    // 2 px a column: a quarter of the body is 100 px, a tenth 40.
    const bare: ScaledAxis = { from: -0.5, start: -0.5, end: 199.5, to: 199.5, flankStep: 50 }
    const ticks = scaledTicks(bare, [bare.from, bare.to], 400, measure, EM)
    expect(words(bare, ticks)).toEqual(['Start', '25%', '50%', '75%', 'End'])
  })

  it('is empty for a window with no width', () => {
    expect(scaledTicks(AXIS, [10, 10], 800, measure, EM)).toEqual([])
    expect(scaledTicks(AXIS, WHOLE, 0, measure, EM)).toEqual([])
  })
})
