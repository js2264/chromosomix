/**
 * The method on real contacts (SPECS §27.11): the yeast demo's `.hic` at 16 kb,
 * as it is and scrambled by a known edit through the lens — which is exactly
 * what a map of reads aligned to the scrambled reference would look like, bins
 * moved whole — and the method asked to put it back. The harness uses the lens
 * against itself: the right answer is the scramble's inverse, and nothing a
 * curator would take may be offered on the file as it is.
 */

import { describe, expect, it } from 'vitest'

import { findCorners } from '../../src/edit/corners'
import { LensGrid } from '../../src/edit/grid'
import { BAND_WIDTH, COARSE_CELLS, expectedOf } from '../../src/edit/method'
import { suggest, type Suggestion } from '../../src/edit/suggest'
import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { pictureLayout, pictureStride } from '../../src/metacooler/picture'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname

async function suggestionsOf(map: MetaCooler, steps: EditStep[] = []): Promise<Suggestion[]> {
  const stride = pictureStride(map.coords) as number
  const layout = pictureLayout(map.coords, stride)
  const read = await map.picture(layout, { balance: map.hasWeights, gather: { width: BAND_WIDTH, coarseCells: COARSE_CELLS } })
  const contacts = read?.contacts
  if (contacts === undefined) throw new Error('no contacts')
  const expected = expectedOf(contacts, map.hasWeights)
  const names = [...map.chromnames]
  const lengths = Array.from(map.coords.contigLengths)
  let edit: ReferenceEdit = emptyEdit({ names, lengths })
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  const grid = LensGrid.of(EditedAssembly.of(edit), {
    binsize: map.binsize * stride,
    sequences: names.map((name, c) => ({ name, length: lengths[c], firstCell: layout.offsets[c], cells: layout.offsets[c + 1] - layout.offsets[c] })),
  })
  return suggest({ contacts, expected, corners: findCorners(contacts, expected), grid }).list
}

const near = (a: number, b: number, within = 16_000): boolean => Math.abs(a - b) <= within

describe('the demo .hic', () => {
  it('draws no suggestion a curator would take as it is', async () => {
    const source = await LocalFileSource.fromPath(HIC)
    await source.mount()
    const hic = MetaCooler.fromHic(`${HIC}::/resolutions/16000`, source)
    try {
      const list = await suggestionsOf(hic)
      expect(list.filter((s) => s.confidence >= 0.5).map((s) => s.words)).toEqual([])
      // What it does offer, below even odds, it says why: the telomeres' shared elements.
      for (const s of list) if (s.kind === 'join') expect(s.evidence).toContain('brighter than an adjacency')
    } finally {
      hic.close()
    }
  })

  it('offers to turn a stretch the reader turned back, once', async () => {
    const source = await LocalFileSource.fromPath(HIC)
    await source.mount()
    const hic = MetaCooler.fromHic(`${HIC}::/resolutions/16000`, source)
    try {
      const list = (await suggestionsOf(hic, [{ op: 'invert', sequence: 'IV', from: 1_104_000, to: 1_296_000 }])).filter(
        (s) => s.confidence >= 0.5,
      )
      expect(list.map((s) => s.step)).toEqual([{ op: 'invert', sequence: 'IV_e1', from: 1_104_000, to: 1_296_000 }])
    } finally {
      hic.close()
    }
  })

  it('puts a scramble back: the turn, the move, the join and the split undone', async () => {
    const source = await LocalFileSource.fromPath(HIC)
    await source.mount()
    const hic = MetaCooler.fromHic(`${HIC}::/resolutions/16000`, source)
    try {
      const scramble: EditStep[] = [
        { op: 'invert', sequence: 'IV', from: 400_000, to: 800_000 },
        { op: 'move', sequence: 'XI', from: 100_000, to: 300_000, into: 'II', at: 300_000, strand: -1 },
        { op: 'split', sequence: 'VII', at: 500_000 },
        { op: 'join', a: 'IX', aEnd: 'end', b: 'III', bEnd: 'start', gap: 0 },
      ]
      let edit: ReferenceEdit = emptyEdit({ names: [...hic.chromnames], lengths: Array.from(hic.coords.contigLengths) })
      scramble.forEach((step, i) => {
        edit = withStep(edit, step, 'reader', i)
      })
      const scrambled = MetaCooler.withLens(hic, edit).map
      const list = (await suggestionsOf(scrambled)).filter((s) => s.confidence >= 0.5)
      const found = (test: (step: EditStep) => boolean): Suggestion | undefined => list.find((s) => test(s.step))

      const turn = found((s) => s.op === 'invert' && s.sequence === 'IV_e1' && near(s.from, 400_000) && near(s.to, 800_000))
      const move = found(
        (s) => s.op === 'move' && s.sequence === 'II_e1' && near(s.from, 300_000) && near(s.to, 500_000) && s.into === 'XI_e1' && near(s.at, 100_000) && s.strand === -1,
      )
      const join = found((s) => s.op === 'join' && s.a === 'VII_e1' && s.aEnd === 'end' && s.b === 'VII_e2' && s.bEnd === 'start')
      const split = found((s) => s.op === 'split' && s.sequence === 'IX_e1' && near(s.at, 439_888))
      expect({ turn: turn?.words, move: move?.words, join: join?.words, split: split?.words }).toEqual({
        turn: expect.any(String),
        move: expect.any(String),
        join: expect.any(String),
        split: expect.any(String),
      })
      // And nothing else above even odds.
      expect(list).toHaveLength(4)
    } finally {
      hic.close()
    }
  })
})
