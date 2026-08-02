/**
 * Base-pair positions in the hover readout (spec §3.3, §5.4).
 *
 * `AxisGroup.start` is block-local, so `(offset - start) * binsize` measures
 * from the left edge of the *picture*. That is a position in the contig only
 * when the block begins on a contig boundary — true for a genome view and for a
 * whole contig, false for `contig:start-end`, where the block begins at
 * `chrom_offset[c] + floor(start / binsize)`. The readout used to report the
 * first cell of `NODE_17248_len_278011:139005-199005` as 2 kb when it is 141 kb
 * into the contig.
 *
 * `unitStart` — the absolute bin the contig itself begins at — is what fixes
 * it, and these are the cases that pin the arithmetic.
 */

import { describe, expect, it } from 'vitest'

import { bpWithin } from '@/ui/MatrixPanel'
import { idRuns } from '@/worker/groups'
import type { AxisGroup } from '@/worker/protocol'

const BIN = 1000

describe('bpWithin', () => {
  it('measures from the contig, not from the block, in a sub-contig region', () => {
    // `contig:139005-199005` at 1 kb bins is bins 139..199; the contig starts at
    // bin 0 of the file, so the block starts 139 bins into it.
    const group: AxisGroup = { label: 'NODE_1', start: 0, end: 61, unitStart: 0 }
    expect(bpWithin(group, 0, 139, BIN)).toBe(139_000)
    expect(bpWithin(group, 2, 139, BIN)).toBe(141_000)
    expect(bpWithin(group, 30, 139, BIN)).toBe(169_000)
  })

  it('is unchanged for a whole contig, which starts where its block does', () => {
    const group: AxisGroup = { label: 'NODE_1', start: 0, end: 279, unitStart: 0 }
    expect(bpWithin(group, 0, 0, BIN)).toBe(0)
    expect(bpWithin(group, 25, 0, BIN)).toBe(25_000)
    expect(bpWithin(group, 252, 0, BIN)).toBe(252_000)
  })

  it('restarts at zero for each contig of a genome view', () => {
    // A genome whose block starts at bin 4,000: two contigs, at 4,000 and 4,300.
    const first: AxisGroup = { label: 'c1', start: 0, end: 300, unitStart: 4000 }
    const second: AxisGroup = { label: 'c2', start: 300, end: 500, unitStart: 4300 }
    expect(bpWithin(first, 10, 4000, BIN)).toBe(10_000)
    expect(bpWithin(second, 300, 4000, BIN)).toBe(0)
    expect(bpWithin(second, 305, 4000, BIN)).toBe(5_000)
  })

  it('falls back to the block-local reading when no unit start is known', () => {
    // An aggregated or overview axis carries no `unitStart`; the old behaviour
    // is the right one there, because such a block starts at its own group.
    const group: AxisGroup = { label: 'g', start: 0, end: 10 }
    expect(bpWithin(group, 3, 7, BIN)).toBe(3_000)
  })
})

describe('idRuns', () => {
  const ids = Int32Array.from([5, 5, 5, 6, 6, 7])

  it('collapses runs into block-local offsets', () => {
    const runs = idRuns(ids, (id) => `c${id}`)
    expect(runs).toEqual([
      { label: 'c5', start: 0, end: 3 },
      { label: 'c6', start: 3, end: 5 },
      { label: 'c7', start: 5, end: 6 },
    ])
  })

  it('carries the absolute start of each unit when one is supplied', () => {
    // Contig 5 begins at bin 100, contig 6 at 110, contig 7 at 130 — and the
    // block starts partway through contig 5, which is the case that used to be
    // reported wrongly.
    const starts = new Map([
      [5, 100],
      [6, 110],
      [7, 130],
    ])
    const runs = idRuns(ids, (id) => `c${id}`, (id) => starts.get(id) ?? 0)
    expect(runs.map((r) => r.unitStart)).toEqual([100, 110, 130])
  })

  it('returns nothing for an empty axis', () => {
    expect(idRuns(new Int32Array(0), String)).toEqual([])
  })
})
