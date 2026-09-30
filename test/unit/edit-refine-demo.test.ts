/**
 * The refinement on real contacts (SPECS §27.5, §27.11): the yeast demo's
 * `.hic` scrambled through the lens at breakpoints no 16 kb cell has an edge
 * at — a stretch turned, one moved into another chromosome turned, and two
 * chromosomes joined — the method run on its 16 kb picture, and each point of
 * what it suggests placed again at the 1 kb rung through the same scramble.
 * The truth is the scramble's own breakpoints: the picture puts each within a
 * cell of it, the refinement to the kilobase.
 */

import { describe, expect, it } from 'vitest'

import { findCorners } from '../../src/edit/corners'
import { LensGrid } from '../../src/edit/grid'
import { METHOD_GATHER, expectedOf } from '../../src/edit/method'
import { pointsOf, refineChain, refinePoint, type ReadSquare, type RefinePoint } from '../../src/edit/refine'
import { suggest, type Suggestion } from '../../src/edit/suggest'
import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { pictureLayout, pictureStride } from '../../src/metacooler/picture'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname

async function rung(size: number): Promise<MetaCooler> {
  const source = await LocalFileSource.fromPath(HIC)
  await source.mount()
  return MetaCooler.fromHic(`${HIC}::/resolutions/${size}`, source)
}

const SCRAMBLE: EditStep[] = [
  { op: 'invert', sequence: 'IV', from: 403_000, to: 797_000 },
  { op: 'move', sequence: 'XI', from: 101_000, to: 297_000, into: 'II', at: 303_000, strand: -1 },
  { op: 'join', a: 'IX', aEnd: 'end', b: 'III', bEnd: 'start', gap: 0 },
]

describe('the refinement on the scrambled demo', () => {
  it('places every point the 16 kb picture suggests to the kilobase at the 1 kb rung', async () => {
    const coarse = await rung(16_000)
    const fine = await rung(1000)
    try {
      let scramble: ReferenceEdit = emptyEdit({ names: [...coarse.chromnames], lengths: Array.from(coarse.coords.contigLengths) })
      SCRAMBLE.forEach((step, i) => {
        scramble = withStep(scramble, step, 'reader', i)
      })
      const picture = MetaCooler.withLens(coarse, scramble).map
      const reads = MetaCooler.withLens(fine, scramble).map

      // The method on the scramble's 16 kb picture, as the stage runs it.
      const stride = pictureStride(picture.coords) as number
      const layout = pictureLayout(picture.coords, stride)
      const read = await picture.picture(layout, { balance: picture.hasWeights, gather: METHOD_GATHER })
      const contacts = read?.contacts
      if (contacts === undefined) throw new Error('no contacts')
      const expected = expectedOf(contacts, picture.hasWeights)
      const names = [...picture.chromnames]
      const lengths = Array.from(picture.coords.contigLengths)
      const assembly = EditedAssembly.of(emptyEdit({ names, lengths }))
      const cell = picture.binsize * stride
      const grid = LensGrid.of(assembly, {
        binsize: cell,
        sequences: names.map((name, c) => ({ name, length: lengths[c], firstCell: layout.offsets[c], cells: layout.offsets[c + 1] - layout.offsets[c] })),
      })
      const list = suggest({ contacts, expected, corners: findCorners(contacts, expected), grid }).list.filter((s) => s.confidence >= 0.5)

      const square: ReadSquare = async (sequence, lo, hi) => {
        const c = reads.chromnames.indexOf(sequence)
        const offset = reads.coords.chromOffset[c]
        const dense = await reads.matrix({ rows: [offset + lo, offset + hi], cols: [offset + lo, offset + hi], balance: reads.hasWeights })
        return dense.nrows === hi - lo && dense.ncols === hi - lo ? { n: hi - lo, values: dense.values } : null
      }
      const chain = refineChain([1000, 2000, 4000, 8000, 16000], cell, 0)
      expect(chain).toEqual([1000])
      const placed = async (point: RefinePoint): Promise<number> =>
        (await refinePoint(point, assembly.lengthOf(point.sequence) ?? 0, cell, chain, square))?.bp ?? Number.NaN
      const find = (test: (step: EditStep) => boolean): Suggestion => {
        const found = list.find((s) => test(s.step))
        if (found === undefined) throw new Error(`not suggested: ${list.map((s) => s.words).join('; ')}`)
        return found
      }

      // The stretch turned back: its two ends, a cell out at 16 kb, to the base at 1 kb.
      const turn = find((s) => s.op === 'invert' && s.sequence === 'IV_e1')
      const turnPoints = pointsOf(turn, assembly, cell)
      expect(turnPoints).toHaveLength(2)
      const turnStep = turn.step as Extract<EditStep, { op: 'invert' }>
      expect(Math.abs(turnStep.from - 403_000)).toBeGreaterThan(1000)
      expect(await Promise.all(turnPoints.map(placed))).toEqual([403_000, 797_000])

      // The stretch moved back, turned, into the chromosome it came from.
      const move = find((s) => s.op === 'move' && s.sequence === 'II_e1' && s.into === 'XI_e1')
      const movePoints = pointsOf(move, assembly, cell)
      expect(movePoints.map((point) => point.sequence)).toEqual(['II_e1', 'II_e1', 'XI_e1'])
      const moved = await Promise.all(movePoints.map(placed))
      expect(moved).toEqual([303_000, 499_000, 101_000])

      // The two chromosomes joined, split again within a kilobase of IX's end.
      const split = find((s) => s.op === 'split' && s.sequence === 'IX_e1')
      const [splitAt] = await Promise.all(pointsOf(split, assembly, cell).map(placed))
      expect(Math.abs(splitAt - 439_888)).toBeLessThanOrEqual(1000)
    } finally {
      coarse.close()
      fine.close()
    }
  }, 60_000)
})
