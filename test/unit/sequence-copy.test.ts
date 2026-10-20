/**
 * A sequence lane's letters as text (§8.8): the stretch a view or a drag names,
 * snapped to bases or to a frame's codons, read in the worker's chunks, and
 * written the way the lane draws it.
 */

import { describe, expect, it } from 'vitest'

import { locusAxisFrom, type AxisRun } from '../../src/render/locus'
import type { BaseRegion } from '../../src/annotations/types'
import type { AnnotationClient } from '../../src/annotations/worker/client'
import {
  basesText,
  codonStretch,
  proteinText,
  readStretch,
  stretchBetween,
} from '../../src/ui/sequenceCopy'

const runs: AxisRun[] = [
  { label: 'I', start: 0, end: 231, unitStart: 0, unitLength: 230_218 },
  { label: 'II', start: 231, end: 1045, unitStart: 231, unitLength: 813_184 },
]
const axis = locusAxisFrom({
  runs,
  blockStart: 0,
  level: 'bin',
  binsize: 1000,
  contigLength: (name) => ({ I: 230_218, II: 813_184 })[name],
})!

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('the stretch between two places', () => {
  it('takes every base either end touches, on one sequence', () => {
    expect(stretchBetween(axis, 10.25, 12.5)).toEqual({ contig: 'I', start: 10_250, end: 12_500, reversed: false })
  })

  it('is nothing across two sequences', () => {
    expect(stretchBetween(axis, 200, 300)).toBeNull()
  })

  it('is clamped to the axis', () => {
    expect(stretchBetween(axis, -50, 2)?.start).toBe(0)
  })
})

describe('a frame’s codons', () => {
  it('widens a stretch to whole codons of the frame, anchored at the sequence’s first base', () => {
    expect(codonStretch({ start: 10, end: 14 }, 1)).toEqual({ start: 9, end: 15 })
    expect(codonStretch({ start: 10, end: 14 }, 2)).toEqual({ start: 10, end: 16 })
    expect(codonStretch({ start: 10, end: 14 }, -3)).toEqual({ start: 8, end: 14 })
  })

  it('reads a frame’s protein as the strand runs', () => {
    const region: BaseRegion = { contig: 'I', start: 0, end: 9, bases: bytes('ATGAAATAA') }
    expect(proteinText(region, 1, 1)).toBe('MK*')
  })
})

describe('the letters', () => {
  it('keep their case, and are complemented backwards on a reversed stretch', () => {
    const region: BaseRegion = { contig: 'I', start: 0, end: 5, bases: bytes('ACgtN') }
    expect(basesText(region, false)).toBe('ACgtN')
    expect(basesText(region, true)).toBe('NacGT')
  })

  it('are read in the worker’s chunks and joined, stopping at the sequence’s end', async () => {
    const genome = 'ACGT'.repeat(250_000)
    const asked: Array<[number, number]> = []
    const client = {
      request: async (request: { regions: Array<{ contig: string; start: number; end: number }> }) => {
        const { start, end } = request.regions[0]
        asked.push([start, end])
        const stop = Math.min(end, 900_000)
        return { regions: [{ contig: 'I', start, end: stop, bases: bytes(genome.slice(start, stop)) }] }
      },
    } as unknown as AnnotationClient
    const region = await readStretch(client, 'seq', { contig: 'I', start: 100, end: 950_000 })
    expect(asked).toEqual([
      [100, 400_100],
      [400_100, 800_100],
      [800_100, 950_000],
    ])
    expect(region?.end).toBe(900_000)
    expect(new TextDecoder().decode(region!.bases)).toBe(genome.slice(100, 900_000))
  })
})
