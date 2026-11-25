// @dev-feature curate
/**
 * The rows of the curation stage's genome list (SPECS §33.3): three sections,
 * a genome's contigs under it while it is open, a filter that finds genomes
 * and contigs and says which pasted names it could not, sorts, and chips.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { listRows, passes, readFilter, rowKey, type ListInput, type ListRow } from '../../src/curate/listRows'
import { community, NAMES } from '../support/curateCommunity'

const { base, evidence } = community()
const answer = stateAnswer(evidence, CuratedBinning.of(base, null))

function input(extra: Partial<ListInput> = {}): ListInput {
  return {
    answer,
    order: answer.genomes.map((genome) => genome.id),
    names: NAMES,
    lengths: base.lengths,
    open: new Set(),
    folded: new Set(),
    genomeSort: 'order',
    poolSort: 'likeliest',
    filter: null,
    chips: new Set(),
    suggested: answer.genomes.map(() => 0),
    poolLikeliness: NAMES.map(() => 0),
    ...extra,
  }
}

/** A row as a word: `§mags`, `X1`, `·x0`. */
function word(row: ListRow): string {
  switch (row.kind) {
    case 'section':
      return `§${row.section}`
    case 'genome':
      return answer.genomes[row.genome].name
    case 'contig':
      return `·${NAMES[row.contig]}`
  }
}

describe('the genome list', () => {
  it('has three sections: the MAGs, the elements and the pool’s contigs', () => {
    expect(listRows(input()).rows.map(word)).toEqual(['§mags', 'X1', 'X2', 'Y', 'Z', '§elements', 'P', '§pool', '·u0'])
  })

  it('opens a genome on its contigs, longest first, and folds a section to its head', () => {
    const rows = listRows(input({ open: new Set(['X2']), folded: new Set(['elements']) })).rows
    expect(rows.map(word)).toEqual(['§mags', 'X1', 'X2', '·x3', '·x4', '·x5', 'Y', 'Z', '§elements', '§pool', '·u0'])
    const head = rows.find((row) => row.kind === 'section' && row.section === 'mags')
    expect(head).toMatchObject({ genomes: 4, contigs: 16, length: 800_000 })
  })

  it('finds by part of a name, by a pattern, or by a pasted list, and says what a list did not find', () => {
    expect(listRows(input({ filter: readFilter('y') })).rows.map(word)).toEqual(['§mags', 'X1', '·y5', 'Y', '§elements', '§pool'])
    expect(listRows(input({ filter: readFilter('/^z[01]$/') })).rows.map(word)).toEqual(['§mags', 'Z', '·z0', '·z1', '§elements', '§pool'])
    const pasted = listRows(input({ filter: readFilter('x4\nu0, P nowhere') }))
    expect(pasted.rows.map(word)).toEqual(['§mags', 'X2', '·x4', '§elements', 'P', '§pool', '·u0'])
    expect(pasted.missing).toEqual(['nowhere'])
    expect(pasted.found.genomes.map((g) => answer.genomes[g].name)).toEqual(['P'])
    expect(pasted.found.contigs.map((c) => NAMES[c]).sort()).toEqual(['u0', 'x4'])
  })

  it('reads a box: empty is none, a broken pattern finds nothing and says why, one name a part of a name', () => {
    expect(readFilter('  ')).toBeNull()
    const broken = readFilter('/(/')
    expect(broken?.kind).toBe('invalid')
    if (broken !== null) expect(passes(broken, 'x1')).toBe(false)
    expect(listRows(input({ filter: broken })).rows.filter((row) => row.kind !== 'section')).toEqual([])
    const one = readFilter('NODE')
    expect(one?.kind).toBe('text')
    if (one !== null) expect(passes(one, 'a_node_7')).toBe(true)
    // One name copied with its separator is the name.
    const copied = readFilter('x4,')
    expect(copied).toEqual({ kind: 'text', text: 'x4' })
  })

  it('finds a pasted list of the short names the list prints, names what the chips hide apart from what is missing, and closes a genome the filter opened', () => {
    const prefixed = { ...answer, genomes: answer.genomes.map((genome) => ({ ...genome, name: `MM_${genome.name}` })) }
    const rows = listRows(input({ answer: prefixed, prefixes: { mag: 'MM_', element: 'MM_' }, filter: readFilter('X1 Y') }))
    expect(rows.missing).toEqual([])
    // The rows are the same genomes: named here by the unprefixed answer.
    expect(rows.rows.map(word)).toEqual(['§mags', 'X1', 'Y', '§elements', '§pool'])
    const chipped = listRows(input({ filter: readFilter('X1 Y nope'), chips: new Set(['unhosted']) }))
    expect(chipped.missing).toEqual(['nope'])
    expect(chipped.hidden).toBe(2)
    // x4 opens X2 on it; closed by the reader, it stays closed under the filter.
    const opened = listRows(input({ filter: readFilter('x4') }))
    expect(opened.rows.map(word)).toContain('·x4')
    const closed = listRows(input({ filter: readFilter('x4'), closed: new Set(['X2']) }))
    expect(closed.rows.map(word)).toEqual(['§mags', 'X2', '§elements', '§pool'])
  })

  it('finds a pasted list of contigs by the short names the list prints for an assembler’s', () => {
    const spades = NAMES.map((_, c) => `NODE_${c + 1}_len_${50_000 + c}`)
    const rows = listRows(input({ names: spades, filter: readFilter('NODE_5 NODE_19') }))
    expect(rows.missing).toEqual([])
    expect(rows.found.contigs.map((c) => NAMES[c]).sort()).toEqual(['u0', 'x3'])
  })

  it('sorts a section by a column, ties in the stage’s order, and the pool by its likeliest recruits', () => {
    const suggested = answer.genomes.map((genome) => (genome.name === 'Z' ? 3 : genome.name === 'X2' ? 1 : 0))
    expect(listRows(input({ genomeSort: 'suggestions', suggested })).rows.map(word).slice(0, 5)).toEqual(['§mags', 'Z', 'X2', 'X1', 'Y'])
    expect(listRows(input({ genomeSort: 'name', reversed: true })).rows.map(word).slice(0, 5)).toEqual(['§mags', 'Z', 'Y', 'X2', 'X1'])
  })

  it('narrows to the chips lit: changed, suggested, complete, redundant, without a host', () => {
    expect(listRows(input({ chips: new Set(['complete']) })).rows.map(word)).toEqual(['§mags', 'X1', 'X2', 'Y', 'Z', '§elements', '§pool'])
    expect(listRows(input({ chips: new Set(['changed']) })).rows.map(word)).toEqual(['§mags', '§elements', '§pool'])
    expect(listRows(input({ chips: new Set(['unhosted']) })).rows.map(word)).toEqual(['§mags', '§elements', '§pool'])
    const likeliness = NAMES.map((name) => (name === 'u0' ? 0.9 : 0))
    expect(listRows(input({ chips: new Set(['suggested']), poolLikeliness: likeliness })).rows.map(word)).toEqual(['§mags', '§elements', '§pool', '·u0'])
  })

  it('keys a genome’s row by its id, which a step does not change', () => {
    const rows = listRows(input()).rows
    expect(rows.map(rowKey).slice(0, 3)).toEqual(['s:mags', 'g:X1', 'g:X2'])
  })
})
