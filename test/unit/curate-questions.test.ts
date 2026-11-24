// @dev-feature curate
/**
 * The review's questions (SPECS §33.3): merges grouped by the genomes they join,
 * at the confidence of their weakest needed pair; moves by where from and to,
 * recruits by where to, host links by element; the less sure on their own.
 */

import { describe, expect, it } from 'vitest'
import { questions, single } from '../../src/curate/questions'
import type { Suggestion } from '../../src/curate/suggest'
import type { CurationStateResult } from '../../src/worker/curateProtocol'

/** Five MAGs: A, B, C one organism (A the most complete), D and E another. */
const answer = {
  genomes: ['A', 'B', 'C', 'D', 'E', 'P'].map((name, g) => ({
    id: name,
    name,
    kind: name === 'P' ? 'element' : 'mag',
    asInFile: true,
    contigs: 1,
    length: 1000 * (g + 1),
    within: 0,
    visibility: 0,
    quality: name === 'P' ? null : { set: 'S', present: 1, markers: 2, hits: 1, completeness: 0.5, redundancy: 1, weightedCompleteness: name === 'A' ? 0.6 : 0.3, weightedRedundancy: 1 },
  })),
} as unknown as CurationStateResult
const names = ['c0', 'c1', 'c2', 'c3', 'c4']

const merge = (a: number, b: number, confidence: number): Suggestion =>
  ({ key: `merge:${a}+${b}`, kind: 'merge', confidence, genomes: [a, b], contigs: [], contacts: 10, affinity: 0.5, features: [], evidence: [], words: '', step: { op: 'merge', into: 'x', genomes: [] } }) as Suggestion
const contig = (kind: 'recruit' | 'move', c: number, to: number, from: number | null, confidence: number): Suggestion =>
  ({ key: `${kind}:${c}>${to}`, kind, confidence, genomes: from === null ? [to] : [to, from], contigs: [c], contacts: 5, affinity: 1, features: [], evidence: [], words: '', step: { op: 'move', contigs: [names[c]], to: answer.genomes[to].id } }) as Suggestion
const link = (kind: 'link' | 'unlink', mag: number, confidence: number): Suggestion =>
  ({ key: `${kind}:P>${mag}`, kind, confidence, genomes: [5, mag], contigs: [], contacts: 3, affinity: 0.3, features: [], evidence: [], words: '', step: { op: kind, element: 'P', mag: answer.genomes[mag].id } }) as Suggestion

describe('the review’s questions', () => {
  it('make one question of one organism’s merges, into its most complete, at its weakest needed pair', () => {
    const asked = questions([merge(0, 1, 0.95), merge(1, 2, 0.7), merge(0, 2, 0.6), merge(3, 4, 0.9), merge(2, 3, 0.3)], answer, names)
    const abc = asked.find((q) => q.key === 'merge:A+B+C')
    expect(abc?.steps).toEqual([{ op: 'merge', into: 'A', genomes: ['B', 'C'] }])
    // The surest tree needs A–B (0.95) and B–C (0.7); A–C (0.6) is not needed.
    expect(abc?.confidence).toBe(0.7)
    expect(abc?.members.length).toBe(3)
    expect(abc?.words).toBe('merge 2 MAGs into A')
    // D and E: a pair is a question of its own; the unsure C–D never joins the two.
    expect(asked.find((q) => q.key === 'merge:3+4')?.members.length).toBe(1)
    expect(asked.find((q) => q.key === 'merge:2+3')?.confidence).toBe(0.3)
  })

  it('make one question of the recruits into one genome, of the moves from one to another, and of an element’s links', () => {
    const asked = questions(
      [contig('recruit', 0, 0, null, 0.9), contig('recruit', 1, 0, null, 0.6), contig('move', 2, 3, 1, 0.8), contig('move', 3, 3, 1, 0.7), link('link', 0, 0.9), link('unlink', 3, 0.8)],
      answer,
      names,
    )
    const recruit = asked.find((q) => q.kind === 'recruit')
    expect(recruit?.steps).toEqual([{ op: 'move', contigs: ['c0', 'c1'], to: 'A' }])
    expect(recruit?.words).toBe('recruit 2 contigs into A')
    expect(recruit?.confidence).toBe(0.6)
    expect(asked.find((q) => q.kind === 'move')?.words).toBe('move 2 contigs from B to D')
    const host = asked.find((q) => q.key === 'host:P')
    expect(host?.words).toBe('link P to A · unlink it from D')
    expect(host?.steps.length).toBe(2)
  })

  it('leave a suggestion of its own a question of its own', () => {
    const s = contig('recruit', 4, 1, null, 0.4)
    expect(questions([s], answer, names)).toEqual([single(s)])
  })
})
