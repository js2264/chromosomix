/**
 * The session lifted through an edit (SPECS §27.8): the edited sequence, a
 * track's features, pairs and signal, each where the edit put it. Checked on
 * sequences small enough to read by eye — a turned stretch reverse-complemented
 * base for base, a feature cut in two by an edit written twice, a pair whose
 * anchor was set aside not written at all, a signal mirrored over a turned
 * stretch.
 */

import { describe, expect, it } from 'vitest'

import { FeatureBuilder, PairBuilder } from '../../src/annotations/featureset'
import { fastaOf, liftedFeaturesBed, liftedPairsBedpe, liftedSignal, liftStretch, objectLandings } from '../../src/edit/lifted'
import { assemblyObjects } from '../../src/edit/exports'
import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'

const SEQUENCES: Record<string, string> = {
  I: 'AACCGGTTAC', // 10
  II: 'GGGGatcgCC', // 10, soft-masked in the middle
}
const ORIGINAL = { names: ['I', 'II'], lengths: [10, 10] }
const CONTEXT = { what: 'genes', file: 'test.cool', by: 'test', created: '2026-09-30' }

function assemblyOf(...steps: EditStep[]): EditedAssembly {
  let edit: ReferenceEdit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return EditedAssembly.of(edit)
}

const read = async (sequence: string, start: number, end: number): Promise<Uint8Array | null> => {
  const text = SEQUENCES[sequence]
  if (text === undefined) return null
  return new TextEncoder().encode(text.slice(start, end))
}

async function fasta(assembly: EditedAssembly, width = 60): Promise<string> {
  const out = await fastaOf(assembly, read, { width })
  if (out === null) throw new Error('cancelled')
  return new TextDecoder().decode(await new Blob(out.parts as BlobPart[]).arrayBuffer())
}

describe('the FASTA of the edited assembly', () => {
  it('is the file’s own sequence where nothing was done', async () => {
    expect(await fasta(assemblyOf())).toBe('>I\nAACCGGTTAC\n>II\nGGGGatcgCC\n')
  })

  it('reverse-complements a turned stretch base for base, case kept, and writes a join’s gap as N', async () => {
    const assembly = assemblyOf(
      { op: 'invert', sequence: 'II', from: 2, to: 8 },
      { op: 'join', a: 'I', aEnd: 'end', b: 'II_e1', bEnd: 'start', gap: 3 },
    )
    // II: GG + revcomp(GGatcg) = cgatCC + CC
    expect(await fasta(assembly, 8)).toBe('>I_e1\nAACCGGTT\nACNNNGGc\ngatCCCC\n')
  })

  it('writes an unplaced stretch as its own record, and names a sequence the file does not have', async () => {
    const assembly = assemblyOf({ op: 'aside', sequence: 'I', from: 0, to: 4, why: 'unplaced' })
    expect(await fasta(assembly)).toBe('>I_e1\nGGTTAC\n>II\nGGGGatcgCC\n>I_unplaced1\nAACC\n')
    const out = await fastaOf(assembly, async (sequence, start, end) => (sequence === 'II' ? null : read(sequence, start, end)))
    expect(out?.missing).toEqual(['II'])
  })
})

describe('a stretch lifted', () => {
  it('lands once per piece it overlaps, clipped, and mirrored in a turned piece', () => {
    const landings = objectLandings(assemblyObjects(assemblyOf({ op: 'invert', sequence: 'I', from: 2, to: 6 })))
    expect(liftStretch(landings, 'I', 1, 4)).toEqual([
      { object: 'I_e1', start: 1, end: 2, strand: 1 },
      // I:2-4 is the turned piece's last two bases: I_e1:4-6.
      { object: 'I_e1', start: 4, end: 6, strand: -1 },
    ])
    expect(liftStretch(landings, 'II', 3, 5)).toEqual([{ object: 'II', start: 3, end: 5, strand: 1 }])
  })
})

describe('features and pairs lifted', () => {
  it('writes a feature once per piece an edit cut it into, strand turned where the piece is, and drops one set aside', () => {
    const builder = new FeatureBuilder()
    builder.add('I', 1, 4, { strand: 1, name: 'crosses' })
    builder.add('II', 0, 2, { strand: -1, name: 'aside' })
    builder.add('II', 5, 7, { strand: 1, name: 'kept', score: 3 })
    const assembly = assemblyOf({ op: 'invert', sequence: 'I', from: 2, to: 6 }, { op: 'aside', sequence: 'II', from: 0, to: 3, why: 'debris' })
    const { text, count } = liftedFeaturesBed(builder.finish(), assembly, CONTEXT)
    expect(text.split('\n').slice(1, -1)).toEqual(['I_e1\t1\t2\tcrosses\t0\t+', 'I_e1\t4\t6\tcrosses\t0\t-', 'II_e1\t2\t4\tkept\t3\t+'])
    expect(count).toEqual({ written: 3, dropped: 1, split: 1 })
  })

  it('writes a pair where the middles of its anchors land, and drops one whose anchor was set aside', () => {
    const builder = new PairBuilder()
    builder.add('I', 0, 2, 'II', 6, 8, { name: 'loop' })
    builder.add('I', 8, 10, 'II', 0, 2, { name: 'gone' })
    const assembly = assemblyOf({ op: 'aside', sequence: 'II', from: 0, to: 3, why: 'contaminant' })
    const { text, count } = liftedPairsBedpe(builder.finish(), assembly, CONTEXT)
    expect(text.split('\n').slice(1, -1)).toEqual(['I\t0\t2\tII_e1\t3\t5\tloop\t.\t.\t.'])
    expect(count).toEqual({ written: 1, dropped: 1, split: 0 })
  })
})

describe('a signal lifted', () => {
  it('carries every interval to where its piece lands, mirrored over a turned one', async () => {
    const assembly = assemblyOf({ op: 'invert', sequence: 'I', from: 2, to: 8 })
    const signal = await liftedSignal(assembly, async (sequence, start, end) => {
      if (sequence !== 'I') return { starts: [start], ends: [end], values: [1], summary: false }
      const starts = [0, 2, 5, 8].filter((s) => s < end)
      return { starts, ends: starts.map((s) => Math.min(end, s + (s === 2 ? 3 : 2))), values: starts.map((s) => s), summary: false }
    })
    if (signal === null) throw new Error('cancelled')
    expect(signal.contigs).toEqual([
      { name: 'I_e1', length: 10 },
      { name: 'II', length: 10 },
    ])
    const I = signal.spans.find((span) => span.contig === 'I_e1')
    // I:2-5 (value 2) and I:5-7 (value 5) land mirrored in I_e1:2-8 — at 5-8 and 3-5.
    expect({ starts: I?.starts, ends: I?.ends, values: I?.values }).toEqual({ starts: [0, 3, 5, 8], ends: [2, 5, 8, 10], values: [0, 5, 2, 8] })
  })
})
