/**
 * The method on a real reassembly (SPECS §27.11): a long-read assembly of a
 * yeast whose chromosome XVI carries the *Mycoplasma mycoides* genome — 32
 * contigs: fifteen whole yeast chromosomes but two, XII broken at its rDNA and
 * XV missing its first 25 kb, and the fused chromosome in thirteen pieces, two
 * of yeast and the rest myco — with a Hi-C map of the strain on it.
 *
 * The truth is two sources that mostly agree: the theoretical genome the
 * strain was built to be, to which each contig was aligned, and the map itself,
 * whose clustering centromeres say where chromosome XVI's working centromere
 * is — at the first myco stretch's end, where the theoretical genome has none.
 * What the method must do: offer, at even odds or better, only joins both
 * sources support or the map shows beyond doubt; join no two chromosomes'
 * telomeres, however their clustering lights them; and, run in auto mode,
 * rebuild XII across its rDNA, XV whole, and the fused chromosome in the
 * theoretical order.
 *
 * With the assembly's own sequence beside the map — the telomeres at contig
 * ends — auto mode goes on to the fused chromosome's last two contigs, and
 * stops with it whole from telomere to telomere.
 *
 * The files are gitignored (70 MB, `data/README.md` says where they are), so
 * the suite is skipped without them.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseFasta } from '../../src/annotations/fasta'
import { findCorners } from '../../src/edit/corners'
import { LensGrid } from '../../src/edit/grid'
import { METHOD_GATHER, expectedOf, fociOf } from '../../src/edit/method'
import { readSequenceEvidence, type SequenceEvidence } from '../../src/edit/sequenceEvidence'
import { suggest } from '../../src/edit/suggest'
import { EditedAssembly, emptyEdit, isGap, withStep, type ReferenceEdit } from '../../src/genome/edit'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { pictureLayout, pictureStride } from '../../src/metacooler/picture'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const MCOOL = new URL('../../data/SGPMJH_1_MP366_1_Hi-C.mcool', import.meta.url).pathname
const FASTA = new URL('../../data/SGPMJH_1_MP366_1_reference.fa', import.meta.url).pathname
const present = existsSync(MCOOL)

async function opened(): Promise<{
  contacts: NonNullable<Awaited<ReturnType<MetaCooler['picture']>>>['contacts'] & object
  expected: ReturnType<typeof expectedOf>
  corners: ReturnType<typeof findCorners>
  gridOf: (edit: ReferenceEdit) => LensGrid
  names: string[]
  lengths: number[]
  close: () => void
}> {
  const source = await LocalFileSource.fromPath(MCOOL)
  await source.mount()
  const map = await MetaCooler.open(`${MCOOL}::/resolutions/1000`, source)
  const stride = pictureStride(map.coords) as number
  const layout = pictureLayout(map.coords, stride)
  const read = await map.picture(layout, { balance: map.hasWeights, gather: METHOD_GATHER })
  const contacts = read?.contacts
  if (contacts === undefined) throw new Error('no contacts')
  const expected = expectedOf(contacts, map.hasWeights)
  const names = [...map.chromnames]
  const lengths = Array.from(map.coords.contigLengths)
  return {
    contacts,
    expected,
    corners: findCorners(contacts, expected),
    gridOf: (edit) =>
      LensGrid.of(EditedAssembly.of(edit), {
        binsize: map.binsize * stride,
        sequences: names.map((name, c) => ({ name, length: lengths[c], firstCell: layout.offsets[c], cells: layout.offsets[c + 1] - layout.offsets[c] })),
      }),
    names,
    lengths,
    close: () => map.close(),
  }
}

/** Auto mode: the best suggestion at even odds or better, taken, until there is none. */
function auto(file: Awaited<ReturnType<typeof opened>>, evidence?: SequenceEvidence): EditedAssembly {
  let edit: ReferenceEdit = emptyEdit({ names: file.names, lengths: file.lengths })
  for (let round = 0; round < 40; round++) {
    const found = suggest({ contacts: file.contacts, expected: file.expected, corners: file.corners, grid: file.gridOf(edit), ...(evidence === undefined ? {} : { evidence }) })
    const next = found.list.find((s) => s.confidence >= 0.5)
    if (next === undefined) break
    edit = withStep(edit, next.step, 'auto', round)
  }
  return EditedAssembly.of(edit)
}

/** A sequence as its pieces, `39+ 34+ 61-`. */
function pieces(assembly: EditedAssembly, name: string): string {
  const sequence = assembly.sequence(name)
  if (sequence === null) return ''
  return sequence.parts
    .filter((part) => !isGap(part))
    .map((part) => ('gap' in part ? '' : `${part.sequence.replace('contig_', '')}${part.strand === 1 ? '+' : '-'}`))
    .join(' ')
}

describe.skipIf(!present)('the chrXVI–mycoides reassembly', () => {
  it('finds the working centromere of the fused chromosome at the first myco stretch’s end', async () => {
    const file = await opened()
    try {
      const foci = fociOf(file.contacts, file.expected)
      const at = (name: string): number[] =>
        foci.filter((focus) => file.names[focus.sequence] === name).map((focus) => focus.from - (file.gridOf(emptyEdit({ names: file.names, lengths: file.lengths })).sequence(name)?.from ?? 0))
      // contig_34 begins where contig_39 — the first yeast and first myco
      // stretches — ends; its focus is within its first 30 kb.
      expect(at('contig_34')).toHaveLength(1)
      expect(at('contig_34')[0]).toBeLessThan(30)
      // The myco contigs have none.
      for (const name of ['contig_61', 'contig_5', 'contig_6', 'contig_59', 'contig_46', 'contig_54']) expect(at(name)).toEqual([])
    } finally {
      file.close()
    }
  }, 60_000)

  it('offers at even odds only joins the map and the theoretical genome support, and none between two centromeres', async () => {
    const file = await opened()
    try {
      const found = suggest({ contacts: file.contacts, expected: file.expected, corners: file.corners, grid: file.gridOf(emptyEdit({ names: file.names, lengths: file.lengths })) })
      const confident = found.list.filter((s) => s.confidence >= 0.5).map((s) => s.words)
      expect(confident).toEqual(
        expect.arrayContaining([
          'join contig_33’s end to contig_56’s start, 100 N between',
          'join contig_2’s start to contig_3’s start, 100 N between',
          'join contig_39’s end to contig_34’s start, 100 N between',
          'join contig_34’s end to contig_61’s end, 100 N between',
          'join contig_59’s end to contig_6’s end, 100 N between',
          'join contig_46’s end to contig_54’s end, 100 N between',
        ]),
      )
      // contig_4's end meets contig_5's start at the full law, with no gap:
      // the map's word against the theoretical genome's, and the only other.
      expect(confident).toHaveLength(7)
      for (const s of found.list) if (s.confidence >= 0.5) expect(s.evidence).not.toContain('two centromeres')
    } finally {
      file.close()
    }
  }, 60_000)

  it('rebuilds XII across its rDNA, XV whole and the fused chromosome in auto mode', async () => {
    const file = await opened()
    try {
      const assembly = auto(file)
      const all = assembly.sequences.map((sequence) => pieces(assembly, sequence.name))
      expect(all).toContain('2- 3+')
      expect(all).toContain('33+ 56+')
      // The fused chromosome: the first yeast and myco stretches, the second
      // yeast stretch, and the second myco stretch in the theoretical order and
      // orientation — contig_49, fifteen kilobases most of which the balancer
      // emptied, either way round.
      const fused = all.find((line) => line.startsWith('39+ 34+'))
      expect(fused?.replace(/49[+-]/, '49')).toBe('39+ 34+ 61- 6+ 59- 45- 53- 50- 49 46+ 54-')
      // The thirteen yeast chromosomes that were whole are still one contig of
      // their own, and so are the mitochondrion (contig_62) and contig_8.
      expect(all.filter((line) => /^\d+\+$/.test(line))).toHaveLength(15)
    } finally {
      file.close()
    }
  }, 180_000)

  it.skipIf(!existsSync(FASTA))('completes the fused chromosome from telomere to telomere with the sequence beside the map', async () => {
    const file = await opened()
    try {
      const fasta = parseFasta(new Uint8Array(readFileSync(FASTA)))
      const evidence = await readSequenceEvidence('SGPMJH_1_MP366_1_reference.fa', file.names, file.lengths, async (name, start, end) => fasta.bases.get(name)?.subarray(start, end) ?? null)
      if (evidence === null) throw new Error('no evidence')
      // The fused chromosome's two ends are telomeres: contig_39's start and contig_4's.
      expect(evidence.facts.get('contig_39')?.start).not.toBeNull()
      expect(evidence.facts.get('contig_4')?.start).not.toBeNull()
      const assembly = auto(file, evidence)
      const all = assembly.sequences.map((sequence) => pieces(assembly, sequence.name))
      expect(all).toContain('2- 3+')
      expect(all).toContain('33+ 56+')
      // contig_5 and contig_4, the second myco stretch's last kilobases, turned
      // and at its end — contig_4's telomere outermost — where the theoretical
      // genome puts contig_5 between contig_61 and contig_6: the map and the
      // telomere against it.
      const fused = all.find((line) => line.startsWith('39+ 34+'))
      expect(fused?.replace(/49[+-]/, '49')).toBe('39+ 34+ 61- 6+ 59- 45- 53- 50- 49 46+ 54- 5- 4-')
      // And the fifteen single contigs as they were.
      expect(all.filter((line) => /^\d+\+$/.test(line))).toHaveLength(15)
    } finally {
      file.close()
    }
  }, 240_000)
})
