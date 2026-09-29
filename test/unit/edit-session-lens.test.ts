/**
 * The session through the lens, on the main thread (SPECS §27.7): an axis of
 * the edited assembly turned into the file's coordinates for the tracks, a
 * place on screen carried across a change of edit, and a mark drawn on the
 * edited map kept where it is in the file.
 */

import { describe, expect, it } from 'vitest'

import { axisThroughEdit } from '../../src/edit/axis'
import { carryRegion, stretchInFile } from '../../src/edit/places'
import { EditedAssembly, emptyEdit, withStep, type EditStep } from '../../src/genome/edit'
import { locusAxisFrom } from '../../src/render/locus'

const ORIGINAL = { names: ['IV', 'V'], lengths: [1_500_000, 600_000] }

function assembly(...steps: EditStep[]): EditedAssembly {
  let edit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return EditedAssembly.of(edit)
}

describe('an axis through the edit', () => {
  const turned = assembly({ op: 'invert', sequence: 'IV', from: 1_100_000, to: 1_300_000 })
  // `IV_e1:1000000-1400000` at 1 kb, as the reader answers for the edited map.
  const own = locusAxisFrom({
    runs: [{ label: 'IV_e1', start: 0, end: 400, unitStart: 0, unitLength: 1_500_000 }],
    blockStart: 1000,
    level: 'bin',
    binsize: 1000,
    contigLength: () => 1_500_000,
  })

  it('is the pieces, in the file’s coordinates, at the units the edited stretch had', () => {
    const axis = axisThroughEdit(own, turned)
    expect(axis?.segments.map(({ contig, unitStart, unitEnd, strand, bpFrom, bpTo }) => [contig, unitStart, unitEnd, strand ?? 1, bpFrom, bpTo])).toEqual([
      ['IV', 0, 100, 1, 1_000_000, 1_100_000],
      ['IV', 100, 300, -1, 1_100_000, 1_300_000],
      ['IV', 300, 400, 1, 1_300_000, 1_400_000],
    ])
    // A gene at IV:1,250,000 is drawn where the turn put it.
    expect(axis?.locusToUnit('IV', 1_250_000)).toBe(150)
    expect(axis?.unitToLocus(150)).toEqual({ contig: 'IV', bp: 1_250_000 })
  })

  it('leaves a sequence the edit did not touch as it was', () => {
    const v = locusAxisFrom({
      runs: [{ label: 'V', start: 0, end: 600, unitStart: 0, unitLength: 600_000 }],
      blockStart: 0,
      level: 'bin',
      binsize: 1000,
      contigLength: () => 600_000,
    })
    expect(axisThroughEdit(v, turned)).toBe(v)
    expect(axisThroughEdit(own, null)).toBe(own)
  })
})

describe('a place carried across a change of edit', () => {
  it('follows a window into the edit, the right way round, by name and by place', () => {
    const turned = assembly({ op: 'invert', sequence: 'IV', from: 1_100_000, to: 1_300_000 })
    expect(carryRegion('IV:1000000-1400000', null, turned)).toBe('IV_e1:1000000-1400000')
    // …and back out again when the edit is undone.
    expect(carryRegion('IV_e1:1000000-1400000', turned, null)).toBe('IV:1000000-1400000')
    // A whole sequence is its successor, whole.
    expect(carryRegion('IV', null, turned)).toBe('IV_e1')
    expect(carryRegion('V', null, turned)).toBe('V')
  })

  it('goes where a moved stretch went', () => {
    const moved = assembly({ op: 'move', sequence: 'IV', from: 200_000, to: 400_000, into: 'V', at: 600_000, strand: 1 })
    expect(carryRegion('IV:250000-350000', null, moved)).toBe('V_e1:650000-750000')
  })

  it('is lost with a stretch set aside', () => {
    const aside = assembly({ op: 'aside', sequence: 'V', from: 0, to: 600_000, why: 'contaminant' })
    expect(carryRegion('V:100000-200000', null, aside)).toBeNull()
  })
})

describe('a mark drawn on the edited map', () => {
  const turned = assembly({ op: 'invert', sequence: 'IV', from: 1_100_000, to: 1_300_000 })

  it('is kept as the stretch of the file it is, read the right way round', () => {
    // IV_e1:1,150,000-1,250,000 is inside the turn: the same bases, counted from its other end.
    expect(stretchInFile(turned, { contig: 'IV_e1', from: 1_150_000, to: 1_250_000 }, 1_150_000)).toEqual({
      contig: 'IV',
      from: 1_150_000,
      to: 1_250_000,
    })
    expect(stretchInFile(turned, { contig: 'IV_e1', from: 1_120_000, to: 1_140_000 }, 1_130_000)).toEqual({
      contig: 'IV',
      from: 1_260_000,
      to: 1_280_000,
    })
  })

  it('across a junction, is of the piece the drag began in', () => {
    const across = { contig: 'IV_e1', from: 1_050_000, to: 1_150_000 }
    expect(stretchInFile(turned, across, 1_060_000)).toEqual({ contig: 'IV', from: 1_050_000, to: 1_100_000 })
    // Begun at the far end, which is inside the turn: its first 50 kb, the file's last.
    expect(stretchInFile(turned, across, 1_150_000)).toEqual({ contig: 'IV', from: 1_250_000, to: 1_300_000 })
  })

  it('keeps a sequence the edit left whole, and is nowhere when begun in a gap', () => {
    expect(stretchInFile(turned, { contig: 'V', from: 10, to: 20 }, 10)).toEqual({ contig: 'V', from: 10, to: 20 })
    expect(stretchInFile(null, { contig: 'IV', from: 10, to: 20 }, 10)).toEqual({ contig: 'IV', from: 10, to: 20 })
    const joined = assembly({ op: 'join', a: 'IV', aEnd: 'end', b: 'V', bEnd: 'start', gap: 100 })
    const name = joined.sequences[0].name
    expect(stretchInFile(joined, { contig: name, from: 1_499_990, to: 1_500_200 }, 1_500_050)).toBeNull()
    expect(stretchInFile(joined, { contig: name, from: 1_499_990, to: 1_500_200 }, 1_500_150)).toEqual({ contig: 'V', from: 0, to: 100 })
  })
})
