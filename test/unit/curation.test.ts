// @dev-feature curate
/**
 * A curation of a metagenome's binning, and the curated binning it folds into
 * (SPECS §33.2): every step on a binning small enough to read by hand, the
 * history's cursor, the fingerprints, and what a kept record is refused for.
 */

import { describe, expect, it } from 'vitest'
import {
  acceptableName,
  CuratedBinning,
  curationFingerprint,
  curationMismatch,
  curationRedone,
  curationUndone,
  emptyCuration,
  fileBinning,
  readCuration,
  withCurationStep,
  type BaseBinning,
  type Curation,
  type CurationStep,
} from '../../src/genome/curation'

/**
 * Seven contigs: c0–c2 in MAG A, c3–c4 in MAG B, c5 the element E, c6 in the
 * pool; E hosted by A.
 */
const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
  lengths: [5000, 4000, 3000, 2000, 1000, 800, 500],
  genomeOf: Int32Array.from([0, 0, 0, 1, 1, 2, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
    { name: 'E', kind: 'element' },
  ],
  links: [{ element: 'E', mag: 'A' }],
}

function curated(...steps: CurationStep[]): CuratedBinning {
  const curation = steps.reduce((held: Curation, step, i) => withCurationStep(held, step, 'reader', i), emptyCuration(fileBinning(BASE)))
  return CuratedBinning.of(BASE, curation)
}

/** Each contig's genome by name, `-` for the pool. */
function where(binning: CuratedBinning): string {
  return [...binning.genomeOf].map((g) => (g < 0 ? '-' : binning.genomes[g].name)).join(' ')
}

describe('the file’s binning, through no curation', () => {
  it('is the file’s, every genome as in the file', () => {
    const binning = CuratedBinning.of(BASE, null)
    expect(where(binning)).toBe('A A A B B E -')
    expect(binning.genomes.map((genome) => [genome.id, genome.kind, genome.asInFile])).toEqual([
      ['A', 'mag', true],
      ['B', 'mag', true],
      ['E', 'element', true],
    ])
    expect(binning.links).toEqual([{ element: 'E', mag: 'A', fromFile: true }])
    expect(binning.isIdentity).toBe(true)
  })
})

describe('a step', () => {
  it('moves contigs to a genome, or to the pool, and marks both genomes changed', () => {
    const binning = curated({ op: 'move', contigs: ['c2'], to: 'B' }, { op: 'move', contigs: ['c6'], to: 'A' }, { op: 'move', contigs: ['c4'], to: null })
    expect(where(binning)).toBe('A A B B - E A')
    expect(binning.genomes.find((genome) => genome.id === 'A')?.asInFile).toBe(false)
    expect(binning.genomes.find((genome) => genome.id === 'B')?.asInFile).toBe(false)
    expect(binning.genomes.find((genome) => genome.id === 'E')?.asInFile).toBe(true)
  })

  it('creates a genome of contigs taken from wherever they were, after the file’s of its kind', () => {
    const binning = curated({ op: 'create', id: 'n1', name: 'MAG_new', kind: 'mag', contigs: ['c1', 'c6'] })
    expect(where(binning)).toBe('A MAG_new A B B E MAG_new')
    // MAGs, then elements: every MAG × element block one rectangle off the diagonal.
    expect(binning.genomes.map((genome) => genome.id)).toEqual(['A', 'B', 'n1', 'E'])
    expect(binning.genomes[2].file).toBe(-1)
  })

  it('makes contigs a mobile element, out of the MAG they were in', () => {
    const binning = curated({ op: 'create', id: 'e1', name: 'plasmid', kind: 'element', contigs: ['c4'] })
    expect(binning.genomes.find((genome) => genome.id === 'e1')?.kind).toBe('element')
    expect(where(binning)).toBe('A A A B plasmid E -')
  })

  it('merges genomes of one kind under the first, which keeps its place', () => {
    const binning = curated({ op: 'merge', into: 'B', genomes: ['A'] })
    expect(where(binning)).toBe('B B B B B E -')
    expect(binning.genomes.map((genome) => genome.id)).toEqual(['B', 'E'])
  })

  it('moves the links of a merged MAG onto the genome it was merged into', () => {
    const binning = curated({ op: 'merge', into: 'B', genomes: ['A'] })
    expect(binning.links).toEqual([{ element: 'E', mag: 'B', fromFile: false }])
  })

  it('does not merge a MAG with an element', () => {
    expect(where(curated({ op: 'merge', into: 'A', genomes: ['E'] }))).toBe('A A A B B E -')
  })

  it('dissolves a genome into the pool, and its links with it', () => {
    const binning = curated({ op: 'dissolve', genome: 'A' })
    expect(where(binning)).toBe('- - - B B E -')
    expect(binning.links).toEqual([])
  })

  it('renames a genome, whose id stays what steps name it by', () => {
    const binning = curated({ op: 'rename', genome: 'A', name: 'K_pneumoniae' }, { op: 'move', contigs: ['c6'], to: 'A' })
    expect(where(binning)).toBe('K_pneumoniae K_pneumoniae K_pneumoniae B B E K_pneumoniae')
    expect(binning.indexOfId('A')).toBe(binning.indexOfName('K_pneumoniae'))
  })

  it('refuses a name another genome has, or the pool’s', () => {
    expect(curated({ op: 'rename', genome: 'A', name: 'B' }).genomes[0].name).toBe('A')
    expect(curated({ op: 'rename', genome: 'A', name: '__unbinned__' }).genomes[0].name).toBe('A')
  })

  it('retypes a genome, which joins the genomes of its new kind, and drops the links it no longer can have', () => {
    const binning = curated({ op: 'retype', genome: 'A', kind: 'element' })
    const a = binning.genomes[binning.indexOfId('A') ?? -1]
    expect(a.kind).toBe('element')
    expect(a.asInFile).toBe(false)
    expect(binning.genomes.map((genome) => genome.id)).toEqual(['B', 'A', 'E'])
    expect(binning.links).toEqual([])
  })

  it('links an element to a MAG, and unlinks it', () => {
    expect(curated({ op: 'link', element: 'E', mag: 'B' }).links.map((link) => link.mag)).toEqual(['A', 'B'])
    expect(curated({ op: 'unlink', element: 'E', mag: 'A' }).links).toEqual([])
    // Links join an element to a MAG, never two MAGs.
    expect(curated({ op: 'link', element: 'A', mag: 'B' }).links).toHaveLength(1)
  })

  it('that no longer applies changes nothing: a genome merged away, a contig the file lacks, an unknown op', () => {
    const binning = curated(
      { op: 'merge', into: 'B', genomes: ['A'] },
      { op: 'move', contigs: ['c6'], to: 'A' },
      { op: 'move', contigs: ['nope'], to: 'B' },
      { op: 'braid', genome: 'B' } as unknown as CurationStep,
    )
    expect(where(binning)).toBe('B B B B B E -')
  })

  it('drops a genome left with no contig, and a link to it', () => {
    const binning = curated({ op: 'move', contigs: ['c5'], to: 'B' })
    expect(binning.genomes.map((genome) => genome.id)).toEqual(['A', 'B'])
    expect(binning.links).toEqual([])
  })

  it('keeps every contig in one genome or the pool, whatever the steps', () => {
    const binning = curated(
      { op: 'create', id: 'n1', name: 'new', kind: 'mag', contigs: ['c0', 'c3'] },
      { op: 'merge', into: 'n1', genomes: ['B'] },
      { op: 'move', contigs: ['c0'], to: 'E' },
    )
    expect(binning.genomeOf).toHaveLength(7)
    const counted = binning.genomes.reduce((sum, genome) => sum + genome.contigs.length, 0) + [...binning.genomeOf].filter((g) => g < 0).length
    expect(counted).toBe(7)
  })
})

describe('the history', () => {
  it('undoes and redoes by moving the cursor, and a new step drops what was undone', () => {
    let curation = withCurationStep(emptyCuration(fileBinning(BASE)), { op: 'move', contigs: ['c6'], to: 'A' }, 'reader', 0)
    curation = withCurationStep(curation, { op: 'dissolve', genome: 'B' }, 'suggestion', 1, 'merge · 92%')
    curation = curationUndone(curation)
    expect(where(CuratedBinning.of(BASE, curation))).toBe('A A A B B E A')
    curation = curationRedone(curation)
    expect(where(CuratedBinning.of(BASE, curation))).toBe('A A A - - E A')
    curation = curationUndone(curation)
    curation = withCurationStep(curation, { op: 'rename', genome: 'B', name: 'Bee' }, 'reader', 2)
    expect(curation.history.map((entry) => entry.step.op)).toEqual(['move', 'rename'])
  })

  it('fingerprints the binning, which two histories reaching it share', () => {
    const there = curated({ op: 'move', contigs: ['c6'], to: 'A' })
    const andBack = curated({ op: 'move', contigs: ['c6'], to: 'A' }, { op: 'move', contigs: ['c6'], to: null })
    expect(andBack.fingerprint()).toBe(CuratedBinning.of(BASE, null).fingerprint())
    expect(there.fingerprint()).not.toBe(andBack.fingerprint())
    // A link moves no contact, but the map's metaTOR columns are written from
    // the links: a binning linked otherwise is another map.
    expect(curated({ op: 'unlink', element: 'E', mag: 'A' }).fingerprint()).not.toBe(CuratedBinning.of(BASE, null).fingerprint())
    const one = withCurationStep(emptyCuration(fileBinning(BASE)), { op: 'dissolve', genome: 'B' }, 'reader', 0)
    expect(curationFingerprint(curationUndone(withCurationStep(one, { op: 'dissolve', genome: 'A' }, 'reader', 1)))).toBe(curationFingerprint(one))
  })
})

describe('a kept curation', () => {
  const file = fileBinning(BASE)

  it('applies to the binning it was made on', () => {
    expect(curationMismatch(emptyCuration(file), file)).toBeNull()
  })

  it('is refused on another, naming what differs first', () => {
    const kept = emptyCuration(file)
    const moved = fileBinning({ ...BASE, genomeOf: Int32Array.from([0, 0, 1, 1, 1, 2, -1]) })
    expect(curationMismatch(kept, moved)).toBe('A held 3 contigs when the curation was made and holds 2 here')
    const relinked = fileBinning({ ...BASE, links: [] })
    expect(curationMismatch(kept, relinked)).toBe('the same genomes hold other contigs, or other host links, in this file')
    const renamed = fileBinning({ ...BASE, names: ['x0', ...BASE.names.slice(1)] })
    expect(curationMismatch(kept, renamed)).toMatch(/names or lengths differ/)
    const fewer = fileBinning({ ...BASE, names: BASE.names.slice(0, 6), lengths: BASE.lengths.slice(0, 6), genomeOf: BASE.genomeOf.slice(0, 6) })
    expect(curationMismatch(kept, fewer)).toBe('the curation was made on 7 contigs and this file has 6')
  })

  it('is read back from storage checked field by field, an unknown op kept', () => {
    const curation = withCurationStep(emptyCuration(file), { op: 'braid' } as unknown as CurationStep, 'auto', 5)
    const back = readCuration(JSON.parse(JSON.stringify(curation)))
    expect(back).toEqual(curation)
    expect(readCuration({ ...curation, version: 2 })).toBeNull()
    expect(readCuration({ ...curation, original: { ...curation.original, genomes: [{ name: 'A', contigs: 3, kind: 'plasmid' }] } })).toBeNull()
    expect(readCuration({ ...curation, cursor: 99 })?.cursor).toBe(1)
  })
})

describe('a curation from outside', () => {
  const BASE_OUT = {
    names: ['c0', 'c1', 'c2'],
    lengths: [3000, 2000, 1000],
    genomeOf: Int32Array.from([0, 0, 1]),
    genomes: [
      { name: 'A', kind: 'mag' as const },
      { name: 'E', kind: 'element' as const },
    ],
    links: [],
  }

  it('skips a step of a known op and the wrong shape, as it skips an op it does not know', () => {
    const steps = [
      { op: 'move', contigs: null, to: 'A' },
      { op: 'merge', into: 'A', genomes: 7 },
      { op: 'create', id: 'x' },
      { op: 'rename', genome: 'A', name: 'Alpha' },
    ] as unknown as CurationStep[]
    let curation = emptyCuration(fileBinning(BASE_OUT))
    for (const step of steps) curation = withCurationStep(curation, step, 'reader', 0)
    const binning = CuratedBinning.of(BASE_OUT, curation)
    expect(binning.genomes.map((genome) => genome.name)).toEqual(['Alpha', 'E'])
  })

  it('takes no name metacooler would read as no genome, nor a contig’s, and names a created genome otherwise', () => {
    let curation = emptyCuration(fileBinning(BASE_OUT))
    for (const step of [
      { op: 'rename', genome: 'A', name: 'NA' },
      { op: 'rename', genome: 'A', name: 'c1' },
      { op: 'rename', genome: 'A', name: 'two words' },
      { op: 'create', id: 'n1', name: 'n/a', kind: 'mag', contigs: ['c1'] },
    ] as CurationStep[])
      curation = withCurationStep(curation, step, 'reader', 0)
    const binning = CuratedBinning.of(BASE_OUT, curation)
    expect(binning.genomes.map((genome) => genome.name)).toEqual(['A', 'genome', 'E'])
    expect(acceptableName('MM133_curated_1')).toBe(true)
    expect(['', 'nan', '-1', '__UNBINNED__', 'a,b', 'chr:1', 'é'].map(acceptableName)).toEqual([false, false, false, false, false, false, false])
  })

  it('names a binning linked otherwise by another fingerprint', () => {
    const plain = CuratedBinning.of(BASE_OUT, null)
    const linked = CuratedBinning.of(BASE_OUT, withCurationStep(emptyCuration(fileBinning(BASE_OUT)), { op: 'link', element: 'E', mag: 'A' }, 'reader', 0))
    expect(linked.links.length).toBe(1)
    expect(linked.fingerprint()).not.toBe(plain.fingerprint())
  })
})
