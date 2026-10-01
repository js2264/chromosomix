// @vitest-environment jsdom
/**
 * *Customise this figure* on a dot plot (§28.2).
 *
 * A dot plot on screen is its streaks, red the same way round and blue the
 * other whatever a colormap says, drawn by a view of its own that zooms. Its
 * dialog offered the matrix's Colour card all the same: a pick changed nothing
 * on screen, and every change to the style rebuilt the view, so the reader lost
 * the window they had zoomed to for a setting that did nothing. The strip above
 * the figure had already left the colours off; the dialog does too, and a
 * change it does make — a title — leaves the view where it was.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DotplotStreaks, MatrixOutput } from '@/analysis/types'
import { figureBlock } from '@/figures/FigureBlock'
import type { FigureTheme } from '@/figures/option'
import { figureSettings } from '@/figures/settings'
import { specOf } from '@/figures/spec'
import { defaultStyle } from '@/figures/style'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  teardown()
})

/** Two sets of two sequences: one streak down I's diagonal, one the other way round in II. */
function streaks(): DotplotStreaks {
  return {
    x: { label: 'assembly.fa', names: ['I', 'II'], lengths: [6000, 2000] },
    y: { label: 'theory.fa', names: ['chrI', 'chrII'], lengths: [6000, 2000] },
    x0: Float64Array.from([0, 6000]),
    x1: Float64Array.from([6000, 8000]),
    y0: Float64Array.from([0, 6000]),
    y1: Float64Array.from([6000, 8000]),
    strand: Int8Array.from([1, -1]),
    anchors: Int32Array.from([410, 96]),
  }
}

function output(dotplot: boolean): MatrixOutput {
  return {
    kind: 'matrix',
    id: 'density',
    label: dotplot ? 'dot plot' : 'pileup',
    nrows: 2,
    ncols: 2,
    values: Float32Array.from([1, 0, 0, -1]),
    xLabel: 'x',
    yLabel: 'y',
    xTicks: [],
    yTicks: [],
    colormap: 'RdBu_r',
    ...(dotplot ? { streaks: streaks() } : {}),
  }
}

/** The settings column for an output, as its group headings. */
function headings(of: MatrixOutput): string[] {
  const spec = specOf(of)
  if (spec === null) throw new Error('not a figure')
  const column = figureSettings({
    spec,
    style: () => defaultStyle(spec),
    onChange: () => {},
    onReset: () => {},
    theme: () => ({}) as FigureTheme,
  })
  return textsOf(column.el, '.figure-group-head')
}

describe('the settings beside a matrix', () => {
  it('offer a matrix its colours', () => {
    expect(headings(output(false))).toEqual(['colour', 'text'])
  })

  it('offer a dot plot none, since its lines are red and blue whatever they say', () => {
    expect(headings(output(true))).toEqual(['text'])
  })
})

describe('a dot plot customised', () => {
  it('keeps the view it opened on when a title is set, so the zoom survives', () => {
    const block = figureBlock({ output: output(true), task: 'dotplot', uri: 'assembly.fa' })
    document.body.append(block.el)
    const canvas = block.el.querySelector('.dotplot-canvas')
    expect(canvas).not.toBeNull()
    ;(block.el.querySelector('.figure-enlarge') as HTMLButtonElement).click()
    const title = document.querySelector<HTMLInputElement>('.figure-settings input[type="text"]')
    if (title === null) throw new Error('no title box')
    title.value = 'Two yeasts'
    title.dispatchEvent(new Event('change'))
    // The same view, not a new one at the whole: a rebuild would be a new canvas.
    expect(document.querySelector('.dotplot-canvas')).toBe(canvas)
    expect(textsOf(block.el, '.analysis-figure-title')).toEqual(['Two yeasts'])
    block.destroy()
  })
})
