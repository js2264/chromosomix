// @dev-feature curate
/**
 * A curation's steps in words (SPECS §33.2): each step as the history lists
 * it, a gesture's steps as one row, the names the genomes had when each was
 * made, a recruit told from a move, and a suggestion's words — its own, short,
 * or read back from the key of one turned down.
 */

import { describe, expect, it } from 'vitest'

import { emptyCuration, fileBinning, withCurationStep, type BaseBinning, type Curation, type CurationStep } from '../../src/genome/curation'
import { contigWords, curationStepText, declinedWords, gestureText, historyRows, listWords, shortWords } from '../../src/curate/words'

const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'p0', 'p1', 'u0', 'u1'],
  lengths: [5000, 4000, 3000, 800, 700, 500, 400],
  genomeOf: Int32Array.from([0, 0, 1, 2, 2, -1, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
    { name: 'P', kind: 'element' },
  ],
  links: [{ element: 'P', mag: 'A' }],
}

function history(...steps: Array<CurationStep | { step: CurationStep; gesture: string; by?: 'reader' | 'suggestion' | 'auto' }>): Curation {
  return steps.reduce(
    (held: Curation, item, i) =>
      'op' in item ? withCurationStep(held, item, 'reader', i) : withCurationStep(held, item.step, item.by ?? 'reader', i, item.by === 'reader' || item.by === undefined ? undefined : 'its words', item.gesture),
    emptyCuration(fileBinning(BASE)),
  )
}

describe('a step in words', () => {
  it('says every op as the history lists it', () => {
    const cases: Array<[CurationStep, string]> = [
      [{ op: 'merge', into: 'C', genomes: ['A', 'B'] }, 'merge A, B into C'],
      [{ op: 'move', contigs: ['x'], to: 'C' }, 'move x to C'],
      [{ op: 'move', contigs: ['x', 'y', 'z'], to: 'C' }, 'move 3 contigs to C'],
      [{ op: 'move', contigs: ['x'], to: null }, 'unbin x'],
      [{ op: 'move', contigs: ['x', 'y'], to: null }, 'unbin 2 contigs'],
      [{ op: 'dissolve', genome: 'C' }, 'dissolve C'],
      [{ op: 'create', id: 'curated:1', name: 'N', kind: 'mag', contigs: Array.from({ length: 12 }, (_, k) => `c${k}`) }, 'new MAG N of 12 contigs'],
      [{ op: 'create', id: 'curated:2', name: 'E', kind: 'element', contigs: ['p9'] }, 'new element E of p9'],
      [{ op: 'retype', genome: 'X', kind: 'mag' }, 'make X a MAG'],
      [{ op: 'retype', genome: 'X', kind: 'element' }, 'make X an element'],
      [{ op: 'link', element: 'E', mag: 'M' }, 'link E to M'],
      [{ op: 'unlink', element: 'E', mag: 'M' }, 'unlink E from M'],
      [{ op: 'rename', genome: 'C', name: 'D' }, 'rename C to D'],
    ]
    for (const [step, words] of cases) expect(curationStepText(step)).toBe(words)
  })

  it('says a move from the pool as a recruit, and a step it does not know as such', () => {
    expect(curationStepText({ op: 'move', contigs: Array.from({ length: 27 }, (_, k) => `u${k}`), to: 'C' }, (id) => id, true)).toBe('recruit 27 contigs into C')
    expect(curationStepText({ op: 'fold', genome: 'C' } as unknown as CurationStep)).toBe('a step this version does not know')
    // A step of the wrong shape, from a link or a workspace, still says something.
    expect(curationStepText({ op: 'move', to: 'C' } as unknown as CurationStep)).toBe('move no contig to C')
  })

  it('names genomes as it is told, and counts long lists', () => {
    expect(curationStepText({ op: 'link', element: 'curated:1', mag: 'A' }, (id) => (id === 'curated:1' ? 'plasmid' : id))).toBe('link plasmid to A')
    expect(listWords(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
    expect(contigWords([])).toBe('no contig')
    expect(curationStepText({ op: 'merge', into: 'Z', genomes: Array.from({ length: 25 }, (_, k) => `e${k}`) })).toBe('merge e0, e1, e2 and 22 more into Z')
  })
})

describe('a gesture in words', () => {
  it('says steps of one kind once', () => {
    expect(gestureText([{ op: 'dissolve', genome: 'A' }, { op: 'dissolve', genome: 'B' }, { op: 'dissolve', genome: 'C' }])).toBe('dissolve A, B, C')
    expect(gestureText([{ op: 'retype', genome: 'A', kind: 'element' }, { op: 'retype', genome: 'B', kind: 'element' }])).toBe('make A, B elements')
    expect(gestureText([{ op: 'link', element: 'E', mag: 'M' }, { op: 'link', element: 'F', mag: 'M' }])).toBe('link E, F to M')
    expect(gestureText([{ op: 'unlink', element: 'E', mag: 'M' }, { op: 'unlink', element: 'E', mag: 'N' }])).toBe('unlink E from M, N')
    expect(gestureText([{ op: 'move', contigs: ['a'], to: 'G' }, { op: 'move', contigs: ['b', 'c'], to: 'G' }], (id) => id, [true, true])).toBe('recruit 3 contigs into G')
  })

  it('says steps of several kinds one after the other', () => {
    expect(gestureText([{ op: 'unlink', element: 'P', mag: 'Z' }, { op: 'link', element: 'P', mag: 'Y' }])).toBe('unlink P from Z; link P to Y')
    expect(gestureText([])).toBe('')
  })
})

describe('the history’s rows', () => {
  it('uses the names a genome had when each step was made, and tells a recruit from a move', () => {
    const held = history(
      { op: 'move', contigs: ['u0'], to: 'A' },
      { op: 'rename', genome: 'A', name: 'K_pneumoniae' },
      { op: 'move', contigs: ['c2'], to: 'A' },
      { op: 'merge', into: 'A', genomes: ['B'] },
      { op: 'move', contigs: ['u0', 'u1'], to: null },
      { op: 'move', contigs: ['u0'], to: 'A' },
    )
    expect(historyRows(BASE, held.history).map((row) => row.text)).toEqual([
      'recruit u0 into A',
      'rename A to K_pneumoniae',
      'move c2 to K_pneumoniae',
      'merge B into K_pneumoniae',
      'unbin 2 contigs',
      'recruit u0 into K_pneumoniae',
    ])
  })

  it('looks a moved contig up in the file once, for every history after', () => {
    const homes = new Map<string, string | null>()
    const held = history({ op: 'move', contigs: ['u0'], to: 'A' }, { op: 'move', contigs: ['c2'], to: 'A' })
    expect(historyRows(BASE, held.history, homes).map((row) => row.text)).toEqual(['recruit u0 into A', 'move c2 to A'])
    expect([...homes]).toEqual([
      ['c2', 'B'],
      ['u0', null],
    ])
    // Read from what was kept: a file that says otherwise is not read again.
    homes.set('c2', null)
    expect(historyRows(BASE, held.history, homes)[1].text).toBe('recruit c2 into A')
  })

  it('follows a genome merged away or dissolved: its contigs are where it went', () => {
    const held = history(
      { op: 'create', id: 'curated:1', name: 'new_one', kind: 'mag', contigs: ['u1'] },
      { op: 'merge', into: 'A', genomes: ['curated:1'] },
      { op: 'dissolve', genome: 'B' },
      { op: 'move', contigs: ['c2'], to: 'A' },
      { op: 'move', contigs: ['u1'], to: 'A' },
    )
    expect(historyRows(BASE, held.history).map((row) => row.text)).toEqual([
      'new MAG new_one of u1',
      'merge new_one into A',
      'dissolve B',
      // c2 was B's, and B went to the pool.
      'recruit c2 into A',
      // u1 is in A already, by the merge.
      'move u1 to A',
    ])
  })

  it('makes a gesture’s steps one row, with who made it and the suggestion it was', () => {
    const held = history(
      { step: { op: 'unlink', element: 'P', mag: 'A' }, gesture: 'g1', by: 'suggestion' },
      { step: { op: 'link', element: 'P', mag: 'B' }, gesture: 'g1', by: 'suggestion' },
      { step: { op: 'dissolve', genome: 'B' }, gesture: 'g2', by: 'auto' },
      { op: 'rename', genome: 'P', name: 'plasmid' },
    )
    const rows = historyRows(BASE, held.history)
    expect(rows.map((row) => [row.from, row.to, row.text, row.by])).toEqual([
      [0, 2, 'unlink P from A; link P to B', 'suggestion'],
      [2, 3, 'dissolve B', 'auto'],
      [3, 4, 'rename P to plasmid', 'reader'],
    ])
    expect(rows[0].steps).toEqual(['unlink P from A', 'link P to B'])
    expect(rows[0].suggestion).toBe('its words')
    expect(rows[2].suggestion).toBeUndefined()
  })
})

describe('a suggestion’s words', () => {
  it('prints the genomes it names short, word by word', () => {
    const short = new Map([
      ['MM133_metator_00700_00002', '00700_00002'],
      ['MM133_metator_00700_00001', '00700_00001'],
    ])
    expect(shortWords('merge MM133_metator_00700_00002 into MM133_metator_00700_00001', short)).toBe('merge 00700_00002 into 00700_00001')
    // A name inside another is not cut.
    expect(shortWords('link X1 to X12, X1', new Map([['X1', 'x']]))).toBe('link x to X12, x')
  })

  it('reads one turned down back from its key', () => {
    const nameOf = (id: string): string => (id === 'curated:1' ? 'new_one' : id)
    expect(declinedWords('merge:A+B', nameOf)).toBe('merge A and B')
    expect(declinedWords('merge:A+B+C', nameOf)).toBe('merge A, B and C')
    expect(declinedWords('recruit:u0>curated:1', nameOf)).toBe('recruit u0 into new_one')
    expect(declinedWords('recruit:curated:1:u0,u1,u2', nameOf)).toBe('recruit 3 contigs into new_one')
    expect(declinedWords('move:c2>A', nameOf)).toBe('move c2 to A')
    expect(declinedWords('link:P>A', nameOf)).toBe('link P to A')
    expect(declinedWords('unlink:P>A', nameOf)).toBe('unlink P from A')
    expect(declinedWords('something', nameOf)).toBe('something')
  })
})
