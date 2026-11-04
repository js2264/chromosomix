// @vitest-environment jsdom
/**
 * What the card beside the pointer, and the readout line under the map, say a
 * cell holds (`ui/MapReadout.ts`).
 *
 * A derived cell is two numbers: the reading — `O/E 1.95×` — and the count it
 * was read from, which says whether to believe it. The readout is handed the
 * cell as it was *drawn*, and under O/E that is the ratio, so one file's line
 * read `O/E 1.95× · balanced 1.95` over a cell whose balanced count was
 * 0.000537, and its card `balanced 1.95` alone.
 * What is pinned here is that the count beside a reading is the file's own,
 * read from the block; that the card carries the reading too, which it never
 * did; and that with nothing derived the card still says what is drawn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Cell } from '@/render/heatmap'
import { MapReadout, type ReadoutHost } from '@/ui/MapReadout'
import type { MatrixPanelOptions } from '@/ui/MatrixPanel'
import { subscribeReadout } from '@/ui/readout'
import type { MatrixResult } from '@/worker/protocol'

import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let line = ''
let unsubscribe: () => void = () => {}

beforeEach(() => {
  teardown = setUpDom()
  unsubscribe = subscribeReadout((text) => {
    line = text
  })
})

afterEach(() => {
  unsubscribe()
  teardown()
})

/** A 2 × 2 block of IV at 1 kb, its balanced counts as the worker sends them. */
function block(values: number[]): MatrixResult {
  const group = { label: 'IV', start: 0, end: 2, unitStart: 0, unitBin: 0, unitLength: 2000 }
  return {
    nrows: 2,
    ncols: 2,
    values: Float32Array.from(values),
    rowExtent: [0, 2],
    colExtent: [0, 2],
    rowGroups: [group],
    colGroups: [group],
    level: 'bin',
  } as unknown as MatrixResult
}

/** A readout over one file's block, drawn as `drawn` and read, where it is derived, as `reading`. */
function readoutOf(data: MatrixResult, reading: ((row: number, col: number) => string) | null): MapReadout {
  const host: ReadoutHost = {
    options: { binsize: 1000 } as unknown as MatrixPanelOptions,
    data: () => data,
    turned: () => null,
    second: () => null,
    squareCell: (cell) => cell,
    scoreWord: () => 'balanced',
    derivedReading: (row, col) => (reading === null ? null : reading(row, col)),
  }
  const readout = new MapReadout(host)
  document.body.appendChild(readout.tooltip)
  return readout
}

/** The cell at row 0, column 1, carrying the value it was drawn with. */
const cellDrawn = (value: number): Cell => ({ row: 0, col: 1, rowBin: 0, colBin: 1, value })

const countOn = (readout: MapReadout): string => readout.tooltip.querySelector('.cell-tip-count')?.textContent ?? ''

/** The card's line for the derived value, or `null` while it is hidden. */
const readingOn = (readout: MapReadout): string | null => {
  const node = readout.tooltip.querySelector('.cell-tip-reading')
  return node === null || node.classList.contains('hidden') ? null : (node.textContent ?? '')
}

describe('the count beside a derived reading', () => {
  it('is the cell’s own count under O/E, not the ratio drawn', () => {
    const readout = readoutOf(block([0.002, 0.000537, 0.000537, 0.002]), () => 'O/E 1.95×')
    readout.describe(cellDrawn(1.95))
    expect(readingOn(readout)).toBe('O/E 1.95×')
    expect(countOn(readout)).toBe('balanced 0.000537')
    expect(line).toContain('O/E 1.95×')
    expect(line).toContain('balanced 0.000537')
    expect(line).not.toContain('balanced 1.95')
  })

  it('says a cell the balancer left out is one, under O/E too', () => {
    const readout = readoutOf(block([0.002, Number.NaN, Number.NaN, 0.002]), () => 'O/E —')
    readout.describe(cellDrawn(Number.NaN))
    expect(countOn(readout)).toBe('balanced NaN (unbalanced)')
  })
})

describe('a cell with nothing derived', () => {
  it('says the value it was drawn with: the count, or the count as smoothed', () => {
    // The block holds 0.000537; the picture, smoothed, drew 0.0006 there.
    const readout = readoutOf(block([0.002, 0.000537, 0.000537, 0.002]), null)
    readout.describe(cellDrawn(0.0006))
    expect(readingOn(readout)).toBeNull()
    expect(countOn(readout)).toBe('balanced 0.0006')
    expect(line).toContain('balanced 0.0006')
  })
})
