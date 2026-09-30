/**
 * Evidence beyond the map, from the sequence (SPECS §27.5): the telomeres at a
 * sequence's ends and the gaps of `N` inside it, read from the session's FASTA —
 * and what they do to the suggestions: a join that would bury a telomere is not
 * offered, and a break beside a gap is placed at it, to the base.
 */

import { describe, expect, it } from 'vitest'

import { findCorners } from '../../src/edit/corners'
import { expectedOf } from '../../src/edit/method'
import { gapsIn, readSequenceEvidence, telomereAt, type SequenceEvidence } from '../../src/edit/sequenceEvidence'
import { suggest } from '../../src/edit/suggest'
import { simulate, type TruePiece } from '../support/simulatedMap'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A pseudo-random sequence of ACGT, the same every time. */
function random(length: number, seed = 1): string {
  let x = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out += 'ACGT'[x % 4]
  }
  return out
}

describe('a telomere', () => {
  it('is the irregular TG repeat of a budding yeast at a right end, and its C-A strand at a left one', () => {
    const tg = 'TGTGGGTGTGGTGTGGGTGTGTGGTGGGTGTGG'.repeat(12)
    expect(telomereAt(bytes(random(700) + tg), 'end')).toBe('TG1-3')
    const ca = [...tg].reverse().map((b) => ({ T: 'A', G: 'C', A: 'T', C: 'G' })[b as 'T']).join('')
    expect(telomereAt(bytes(ca + random(700)), 'start')).toBe('TG1-3')
  })

  it('is a tandem TTAGGG on either strand, and a plant’s TTTAGGG', () => {
    expect(telomereAt(bytes(random(600) + 'TTAGGG'.repeat(60)), 'end')).toBe('TTAGGG')
    expect(telomereAt(bytes('CCCTAA'.repeat(60) + random(600)), 'start')).toBe('TTAGGG')
    expect(telomereAt(bytes(random(600) + 'TTTAGGG'.repeat(50)), 'end')).toBe('TTTAGGG')
  })

  it('is not an ordinary end, nor a run of T — which is poly-A read backwards', () => {
    expect(telomereAt(bytes(random(1000)), 'end')).toBeNull()
    expect(telomereAt(bytes(random(700) + 'T'.repeat(300)), 'end')).toBeNull()
  })
})

describe('gaps of N', () => {
  it('are runs of ten or more, where they lie', () => {
    expect(gapsIn(bytes(`ACGT${'N'.repeat(12)}ACG${'n'.repeat(9)}T${'N'.repeat(10)}`), 1000)).toEqual([
      [1004, 1016],
      [1029, 1039],
    ])
  })

  it('are found across the chunks a long sequence is read in, whole', async () => {
    const sequence = random(399_990) + 'N'.repeat(40) + random(100_000)
    const evidence = await readSequenceEvidence('genome.fa', ['I'], [sequence.length], async (_, start, end) => bytes(sequence.slice(start, end)))
    expect(evidence?.facts.get('I')?.gaps).toEqual([[399_990, 400_030]])
  })
})

/** Evidence for a simulated assembly: telomeres and gaps as given, every sequence `length` long. */
function evidenceOf(facts: Record<string, { start?: boolean; end?: boolean; gaps?: Array<[number, number]>; length: number }>): SequenceEvidence {
  return {
    from: 'genome.fa',
    gapsRead: true,
    facts: new Map(
      Object.entries(facts).map(([name, fact]) => [
        name,
        { length: fact.length, start: fact.start === true ? 'TTAGGG' : null, end: fact.end === true ? 'TTAGGG' : null, gaps: fact.gaps ?? [] },
      ]),
    ),
  }
}

async function suggested(sequences: TruePiece[][], evidence?: SequenceEvidence): Promise<ReturnType<typeof suggest>> {
  const { contacts, grid } = await simulate(sequences)
  const expected = expectedOf(contacts, true)
  return suggest({ contacts, expected, corners: findCorners(contacts, expected), grid, ...(evidence === undefined ? {} : { evidence }) })
}

describe('the suggestions, with the sequence', () => {
  it('do not offer a join that would bury a telomere, and say why', async () => {
    // The first chromosome left in two: s1 is its first half, s2 its second.
    const pieces: TruePiece[][] = [[[0, 0, 150, 1]], [[0, 150, 300, 1]], [[1, 0, 200, 1]]]
    const without = await suggested(pieces)
    expect(without.list[0].step).toMatchObject({ op: 'join', a: 's1', aEnd: 'end', b: 's2', bEnd: 'start' })
    expect(without.list[0].confidence).toBeGreaterThan(0.5)
    // Where the sequence says s1's end is a telomere, it is a chromosome's end.
    const withTelomere = await suggested(pieces, evidenceOf({ s1: { end: true, length: 150_000 }, s2: { length: 150_000 }, s3: { length: 200_000 } }))
    const join = withTelomere.list.find((s) => s.step.op === 'join' && s.step.a === 's1' && s.step.aEnd === 'end' && s.step.b === 's2')
    expect(join?.confidence ?? 0).toBeLessThan(0.5)
    expect(join?.evidence).toContain('a telomere')
  })

  it('do not offer at even odds a turn or a move that would carry a telomere inside its sequence', async () => {
    // s1's second half turned. Both ways to put it back — turn it, or move the
    // first half after it, turned — make a junction of s1's last base.
    const pieces: TruePiece[][] = [[[0, 0, 150, 1], [0, 150, 300, -1]], [[1, 0, 200, 1]]]
    const without = await suggested(pieces)
    expect(['turn', 'move']).toContain(without.list[0].kind)
    expect(without.list[0].confidence).toBeGreaterThan(0.5)
    // Where the sequence says that base is a telomere, the stretch it ends is
    // a chromosome's end as it is: the junction is cut, and nothing buries it.
    const withTelomere = await suggested(pieces, evidenceOf({ s1: { end: true, length: 300_000 }, s2: { length: 200_000 } }))
    expect(withTelomere.list[0].step).toEqual({ op: 'split', sequence: 's1', at: 150_000 })
    expect(withTelomere.list[0].confidence).toBeGreaterThan(0.5)
    const burying = withTelomere.list.filter((s) => s.kind === 'turn' || s.kind === 'move')
    for (const s of burying) {
      expect(s.confidence).toBeLessThan(0.5)
      expect(s.evidence).toContain('a telomere')
    }
  })

  it('place a break beside a gap of N at the gap, to the base, and say so', async () => {
    const pieces: TruePiece[][] = [[[0, 0, 100, 1], [0, 100, 160, -1], [0, 160, 300, 1]], [[1, 0, 200, 1]]]
    const found = await suggested(pieces, evidenceOf({ s1: { length: 300_000, gaps: [[100_300, 100_700]] }, s2: { length: 200_000 } }))
    const [first] = found.list
    expect(first.kind).toBe('turn')
    expect(first.step).toEqual({ op: 'invert', sequence: 's1', from: 100_500, to: 160_000 })
    expect(first.evidence).toContain('at a gap of N')
  })
})
