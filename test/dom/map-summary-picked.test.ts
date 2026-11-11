// @vitest-environment jsdom
/**
 * The line under a map, where the picked resolution is not what is drawn (§3.4).
 *
 * With *Refine on zoom* off the picked resolution is the picture — unless the
 * window is too wide for a block at it, when it is drawn as fine as fits. The
 * line then says which resolution it is not, and how to get it, rather than
 * leaving the bar's number under a picture at another.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { blockSummary } from '@/ui/mapSummary'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => teardown())

/** Chicken chr1, read from the `rung` named, `binsPerCell` to a cell. */
function block(rung: number | undefined, binsPerCell = 1): MatrixResult {
  return {
    nrows: 100,
    ncols: 100,
    values: new Float32Array(1),
    rowExtent: [0, 100],
    colExtent: [0, 100],
    rowGroups: [],
    colGroups: [],
    level: 'bin',
    binsPerCell,
    ...(rung === undefined ? {} : { binsize: rung }),
  } as unknown as MatrixResult
}

/** The line as a reader reads it. */
function line(parts: Array<string | HTMLElement>): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.textContent)).join('')
}

describe('the picked resolution on the line', () => {
  it('is named, with what to do, where the window is drawn coarser', () => {
    // 10 kb picked, the whole chromosome too wide for it: drawn at 25 kb.
    const text = line(blockSummary(10_000, block(25_000), 'sequence', 10_000))
    expect(text).toContain('effective resolution: 25 kb')
    expect(text).toContain('10 kb is too fine for this window: zoom in')
  })

  it('says nothing where it is what is drawn', () => {
    expect(line(blockSummary(10_000, block(undefined), 'sequence', 10_000))).not.toContain('too fine')
  })

  it('says nothing while the zoom picks the resolution', () => {
    // *Refine on zoom* on: no resolution is picked, whatever is drawn.
    expect(line(blockSummary(10_000, block(250_000), 'sequence'))).not.toContain('too fine')
  })

  it('counts a declared grid as the resolution picked', () => {
    // A 30 kb grid declared over the 10 kb map, drawn three bins to a cell.
    expect(line(blockSummary(10_000, block(undefined, 3), 'sequence', 30_000))).not.toContain('too fine')
  })
})
