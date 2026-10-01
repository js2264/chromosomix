/**
 * When a sideways scroll slides a map along its diagonal (SPECS §7.2): wherever
 * the block is cis and square. Cis is the diagonal in the picture — its rows and
 * columns share a stretch of bins — or two stretches of one sequence, whose
 * diagonal is off the picture but whose bands of one separation run parallel to
 * it. Not over a turned band, whose diagonal runs across the screen already, nor
 * over a trans block — two sequences, two genomes — which has no separation to
 * keep, nor, above bin level, over cells that share nothing.
 */

import { describe, expect, it } from 'vitest'

import type { RotatedBlock } from '@/render/rotate'
import { slidesAlongDiagonal } from '@/ui/MatrixPanel'
import type { AxisGroup, MatrixResult } from '@/worker/protocol'

type Block = Parameters<typeof slidesAlongDiagonal>[0]

/** One run of a sequence across a whole axis of `cells`, at bin level. */
function run(label: string, unitBin: number, cells: number, extra: Partial<AxisGroup> = {}): AxisGroup {
  return { label, start: 0, end: cells, unitBin, unitLength: 1_000_000, ...extra }
}

function block(
  rowExtent: [number, number],
  colExtent: [number, number],
  rowGroups: AxisGroup[],
  colGroups: AxisGroup[],
  level: MatrixResult['level'] = 'bin',
): Block {
  return { rowExtent, colExtent, rowGroups, colGroups, level }
}

describe('a sideways scroll along the diagonal', () => {
  it('slides along it where the rows and columns share bins', () => {
    const chrI = [run('I', 0, 500)]
    expect(slidesAlongDiagonal(block([0, 500], [0, 500], chrI, chrI), null)).toBe(true)
    // A cis window panned off the diagonal, still crossing it.
    expect(slidesAlongDiagonal(block([100, 300], [250, 450], chrI, chrI), null)).toBe(true)
  })

  it('slides along it on two stretches of one sequence, whose diagonal is off the picture', () => {
    // `I:1-100,000 × I:400,001-600,000`: rows and columns share no bin, and both
    // are chromosome I. Moving both keeps a band of one separation under the
    // pointer; moving the columns alone walked the reader across separations.
    const rows = [run('I', 0, 100)]
    const cols = [run('I', 0, 200)]
    expect(slidesAlongDiagonal(block([0, 100], [400, 600], rows, cols), null)).toBe(true)
  })

  it('slides the columns alone over a trans block, two sequences or two genomes', () => {
    expect(
      slidesAlongDiagonal(block([0, 100], [400, 600], [run('I', 0, 100)], [run('II', 230, 200)]), null),
    ).toBe(false)
    // Two MAGs may each have a `contig_1`: the identity is the bin the sequence
    // begins at, not its name, so two of them are still trans.
    expect(
      slidesAlongDiagonal(
        block([0, 50], [900, 950], [run('contig_1', 0, 50)], [run('contig_1', 900, 50)]),
        null,
      ),
    ).toBe(false)
  })

  it('slides the columns alone where an axis holds more than one sequence', () => {
    const rows = [run('I', 0, 100)]
    const cols = [
      { ...run('I', 0, 60), end: 60 },
      { ...run('II', 230, 40), start: 60, end: 100 },
    ]
    expect(slidesAlongDiagonal(block([0, 100], [180, 280], rows, cols), null)).toBe(false)
    // …and where one cell holds several small sequences, which is none of them.
    const pooled = [run('I', 0, 100, { merged: [{ label: 'I', unitLength: 10 }, { label: 'II', unitLength: 10 }] })]
    expect(slidesAlongDiagonal(block([0, 100], [400, 500], pooled, pooled), null)).toBe(false)
  })

  it('keeps a picture above bin level as it was: along the diagonal only where its cells are shared', () => {
    // A genome-pair view: one genome against another, cells that are contigs.
    const genome = [{ label: 'MAG_1', start: 0, end: 40 }]
    expect(slidesAlongDiagonal(block([0, 40], [40, 90], genome, genome, 'contig'), null)).toBe(false)
    // The whole overview, which shares every cell.
    expect(slidesAlongDiagonal(block([0, 90], [0, 90], genome, genome, 'genome'), null)).toBe(true)
  })

  it('never slides along a turned band, whose diagonal runs across the screen already', () => {
    const chrI = [run('I', 0, 500)]
    expect(slidesAlongDiagonal(block([0, 500], [0, 500], chrI, chrI), {} as RotatedBlock)).toBe(false)
    expect(
      slidesAlongDiagonal(block([0, 100], [400, 600], [run('I', 0, 100)], [run('I', 0, 200)]), {} as RotatedBlock),
    ).toBe(false)
  })
})
