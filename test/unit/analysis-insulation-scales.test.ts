/**
 * What a **multi-scale** insulation run asks the Annotations panel for (§18.11).
 *
 * A run with several windows produces the same score at several smoothings, and
 * that is one reading rather than several: drawn the obvious way it is four
 * lanes, four autoscaled axes and four curves crossing each other, and a reader
 * comparing scales is holding four pictures against each other by eye. A score
 * per bin *per window* is a matrix, so the set asks to be drawn as one: one
 * group, in overlay, as stacked heatmaps sharing an axis.
 *
 * Three things have to hold, and each of them is a way for the picture to be
 * quietly wrong rather than to fail:
 *
 * - **widest first**, because the lanes are laid out in the order they are
 *   adopted and every published version of this figure sharpens downwards;
 * - **a single-scale run is untouched**, because a heatmap of one row is a worse
 *   picture of one track than the track is;
 * - **the hints are suggestions.** They are written into the row's style once,
 *   where the reader can change them — and the group's mode is left alone if
 *   anybody has already decided about it.
 */

import { describe, expect, it } from 'vitest'

import { GroupSettings } from '@/annotations/groups'
import { runInsulation } from '@/analysis/run/insulation'
import type { JobContext } from '@/analysis/job'
import type { AnalysisFraming, Params, ProfileOutput } from '@/analysis/types'

const BINSIZE = 1000
const BINS = 400

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'whole file',
  binsize: BINSIZE,
  binsPerCell: 1,
  rows: [0, BINS],
  cols: [0, BINS],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/** Contact falling with distance, with one boundary in the middle. */
function valueAt(row: number, col: number): number {
  const distance = Math.abs(col - row)
  const across = (row < 200 && col >= 200) || (col < 200 && row >= 200)
  return (100 / (1 + distance)) * (across ? 0.05 : 1)
}

function job(params: Params): JobContext {
  const mc = {
    nBins: BINS,
    nContigs: 1,
    binsize: BINSIZE,
    hasGenomes: false,
    contigGenomeIds: new Int32Array(1),
    chromnames: ['I'],
    chromsizes: new Map([['I', BINS * BINSIZE]]),
    contigExtent: () => [0, BINS] as [number, number],
    names: { find: () => null },
    matrix: async (query: { rows: [number, number]; cols: [number, number] }) => {
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          values[r * ncols + c] = valueAt(query.rows[0] + r, query.cols[0] + c)
        }
      }
      return {
        values,
        nrows,
        ncols,
        rowExtent: [...query.rows] as [number, number],
        colExtent: [...query.cols] as [number, number],
      }
    },
  }
  return {
    mc: mc as never,
    params,
    framing: FRAMING,
    inputs: {} as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
  }
}

function settings(scales: number): Params {
  return {
    window: 5,
    scales,
    region: '',
    ignoreDiags: 2,
    minValid: 0.5,
    balance: false,
    call: false,
    prominence: 0.2,
    spacing: 0,
    domains: false,
  }
}

async function profiles(scales: number): Promise<ProfileOutput[]> {
  const outputs = await runInsulation(job(settings(scales)))
  return outputs.filter((output): output is ProfileOutput => output.kind === 'profile')
}

describe('a multi-scale insulation run', () => {
  it('emits the widest window first, so the stack sharpens downwards', async () => {
    const out = await profiles(3)
    // 5, 10 and 20 bins at 1 kb — the ladder doubles — arriving widest first.
    expect(out.map((profile) => profile.id)).toEqual([
      'insulation-w20',
      'insulation-w10',
      'insulation-w5',
    ])
    expect(out.map((profile) => profile.label)).toEqual([
      'Insulation · 20 kb',
      'Insulation · 10 kb',
      'Insulation · 5 kb',
    ])
  })

  it('asks for one group, overlaid, drawn as heatmaps', async () => {
    const out = await profiles(3)
    for (const profile of out) {
      expect(profile.group).toBe('Insulation')
      expect(profile.mode).toBe('heatmap')
      expect(profile.groupMode).toBe('overlay')
    }
  })

  it('still gives every scale its own values', async () => {
    const [widest, , narrowest] = await profiles(3)
    expect(widest.values).toHaveLength(BINS)
    expect(narrowest.values).toHaveLength(BINS)
    // The boundary is scored at every width; the wider window is the smoother
    // track, so the two vectors are not copies of each other.
    let differing = 0
    for (let bin = 0; bin < BINS; bin++) {
      if (Number.isFinite(widest.values[bin]) && Number.isFinite(narrowest.values[bin])) {
        if (widest.values[bin] !== narrowest.values[bin]) differing++
      }
    }
    expect(differing).toBeGreaterThan(BINS / 2)
  })

  it('leaves a single-scale run an ordinary ungrouped line', async () => {
    const out = await profiles(1)
    expect(out).toHaveLength(1)
    expect(out[0].group).toBeUndefined()
    expect(out[0].mode).toBeUndefined()
    expect(out[0].groupMode).toBeUndefined()
  })
})

/**
 * A suggestion applies to a group nobody has decided about.
 *
 * `modeOf` answers `stacked` for an untouched group and for one a reader
 * deliberately stacked, which is the right answer to *how do I draw this* and
 * the wrong one to *may I suggest something* — so the mode a task suggests goes
 * through `knowsMode`, and a reader who pulled the stack apart and ran the task
 * again gets it back the way they left it.
 */
describe('a group that has been decided about', () => {
  it('is not one the task may suggest a mode for', () => {
    const groups = new GroupSettings('test:insulation')
    expect(groups.knowsMode('Insulation')).toBe(false)
    expect(groups.modeOf('Insulation')).toBe('stacked')

    groups.setMode('Insulation', 'overlay')
    expect(groups.knowsMode('Insulation')).toBe(true)

    // The reader pulls it apart: still known, and still theirs.
    groups.setMode('Insulation', 'stacked')
    expect(groups.knowsMode('Insulation')).toBe(true)
    expect(groups.modeOf('Insulation')).toBe('stacked')
  })
})
