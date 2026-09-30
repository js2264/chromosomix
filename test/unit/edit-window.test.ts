/**
 * The stage closer than its picture's cell (SPECS §27.9): each pixel of a side
 * mapped through the lens to the bin of the finer read under it, the read
 * painted where it reaches and the picture left where it does not, and a value
 * of it put on the picture's scale — the rung's balancing counted.
 */

import { describe, expect, it } from 'vitest'

import { windowScale } from '@/edit/EditStage'
import { LensGrid } from '@/edit/grid'
import { paintWindow, windowSide, type WindowRun } from '@/edit/paint'
import { EditedAssembly, emptyEdit, withStep } from '@/genome/edit'
import { encode } from '@/metacooler/picture'

/** One sequence of 100 kb, a picture of 10 kb cells. */
const LAYOUT = { binsize: 10_000, sequences: [{ name: 's1', length: 100_000, firstCell: 0, cells: 10 }] }
const plain = LensGrid.of(EditedAssembly.of(emptyEdit({ names: ['s1'], lengths: [100_000] })), LAYOUT)

describe('a side of the window', () => {
  // A read at 1 kb of s1:20-50 kb.
  const runs: WindowRun[] = [{ sequence: 's1', firstBin: 20, count: 30, at: 0 }]

  it('is the bin under each pixel, a pixel a kilobase', () => {
    const side = windowSide(plain, 2, 5, 30, runs, 1000)
    expect(Array.from(side)).toEqual(Array.from({ length: 30 }, (_, p) => p))
  })

  it('is nothing where the read does not reach', () => {
    const side = windowSide(plain, 0, 10, 10, runs, 1000)
    // Pixels at 5, 15, … kb: only 25 and 35 and 45 kb are read.
    expect(Array.from(side)).toEqual([-1, -1, 5, 15, 25, -1, -1, -1, -1, -1])
  })

  it('follows the edit: a turned stretch is read backwards', () => {
    const turned = LensGrid.of(EditedAssembly.of(withStep(emptyEdit({ names: ['s1'], lengths: [100_000] }), { op: 'invert', sequence: 's1', from: 0, to: 100_000 }, 'reader', 0)), LAYOUT)
    // The read is of the edited sequence, whose bins are its own.
    const side = windowSide(turned, 2, 5, 3, [{ sequence: 's1_e1', firstBin: 20, count: 30, at: 0 }], 1000)
    expect(Array.from(side)).toEqual([5, 15, 25])
  })
})

describe('the window painted', () => {
  it('over the picture where it reaches, its empty bins transparent, the picture left elsewhere', () => {
    const q = { low: -2, high: 2 }
    const colours = Uint32Array.from({ length: 256 }, (_, b) => b)
    const target = new Uint32Array(3 * 2).fill(7)
    const read = { values: Float32Array.from([1, Number.NaN, 0.1, 10]), ncols: 2 }
    paintWindow(target, 3, Int32Array.from([0, 1]), Int32Array.from([0, 1, -1]), read, 10, q, colours)
    expect(Array.from(target)).toEqual([encode(10, q), 0, 7, encode(1, q), encode(100, q), 7])
  })
})

describe('a finer value on the picture’s scale', () => {
  it('is the rung’s k² pixels raw, about k balanced, and the picture’s pooling on top', () => {
    expect(windowScale({ binsize: 10_000, stride: 1, balanced: false }, 1000)).toBe(100)
    expect(windowScale({ binsize: 10_000, stride: 1, balanced: true }, 1000)).toBe(10)
    // Cells of two 10 kb bins, read at 1 kb.
    expect(windowScale({ binsize: 20_000, stride: 2, balanced: true }, 1000)).toBe(40)
  })
})
