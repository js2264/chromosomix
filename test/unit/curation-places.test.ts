// @dev-feature curate
/**
 * Where the view goes when the session is drawn through another binning
 * (SPECS §33.4): a genome followed by its id — to its new name, to the genome
 * it was merged into or whose contigs took most of it — and to the genomes
 * table where it is gone; a contig keeps its name, and the genome it was opened
 * from becomes the one it is in now.
 */

import { describe, expect, it } from 'vitest'

import { CuratedBinning, emptyCuration, fileBinning, withCurationStep, type BaseBinning, type Curation, type CurationStep } from '../../src/genome/curation'
import { carryGenomeView, followGenome } from '../../src/curate/places'
import type { ViewState } from '../../src/types'

const BASE: BaseBinning = {
  names: ['a1', 'a2', 'a3', 'b1', 'b2', 'e1', 'u1'],
  lengths: [5000, 4000, 3000, 2000, 1000, 800, 500],
  genomeOf: Int32Array.from([0, 0, 0, 1, 1, 2, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
    { name: 'E', kind: 'element' },
  ],
  links: [],
}

function curation(...steps: CurationStep[]): Curation {
  return steps.reduce((held: Curation, step, i) => withCurationStep(held, step, 'reader', i), emptyCuration(fileBinning(BASE)))
}

const file = CuratedBinning.of(BASE, null)
const of = (...steps: CurationStep[]): CuratedBinning => CuratedBinning.of(BASE, curation(...steps))
const at = (view: Partial<ViewState>): ViewState => ({ uri: 'm.metacool', view: 'genomes', ...view })

describe('a genome followed from one binning to the next', () => {
  it('by its id, through a rename and back', () => {
    const renamed = of({ op: 'rename', genome: 'A', name: 'Kleb' })
    expect(followGenome('A', file, renamed)).toBe('Kleb')
    expect(followGenome('Kleb', renamed, file)).toBe('A')
  })

  it('into the genome it was merged into, and nowhere once dissolved', () => {
    const merged = of({ op: 'merge', into: 'B', genomes: ['A'] })
    expect(followGenome('A', file, merged)).toBe('B')
    expect(followGenome('B', file, merged)).toBe('B')
    expect(followGenome('B', file, of({ op: 'dissolve', genome: 'B' }))).toBeNull()
    // A genome a curation created is not in the file's binning.
    const created = of({ op: 'create', id: 'n1', name: 'New', kind: 'mag', contigs: ['u1'] })
    expect(followGenome('New', created, file)).toBeNull()
  })
})

describe('a view carried through a curation', () => {
  it('opens a renamed genome under its new name, and a merged pair as the genome it became', () => {
    const merged = of({ op: 'merge', into: 'A', genomes: ['B'] }, { op: 'rename', genome: 'A', name: 'AB' })
    expect(carryGenomeView(at({ view: 'genome', genome: 'A' }), file, merged, BASE.names)).toMatchObject({ view: 'genome', genome: 'AB' })
    expect(carryGenomeView(at({ view: 'pair', genome: 'A', genome2: 'B' }), file, merged, BASE.names)).toMatchObject({ view: 'genome', genome: 'AB', genome2: undefined })
    expect(carryGenomeView(at({ view: 'pair', genome: 'B', genome2: 'E' }), file, merged, BASE.names)).toMatchObject({ view: 'pair', genome: 'AB', genome2: 'E' })
  })

  it('falls back to the genomes table where the genome is gone', () => {
    const dissolved = of({ op: 'dissolve', genome: 'B' })
    const view = carryGenomeView(at({ view: 'genome', genome: 'B' }), file, dissolved, BASE.names)
    expect(view.view).toBe('genomes')
    expect(view.genome).toBeUndefined()
    expect(carryGenomeView(at({ view: 'pair', genome: 'A', genome2: 'B' }), file, dissolved, BASE.names).view).toBe('genomes')
    // A selection keeps what is left of it.
    expect(carryGenomeView(at({ view: 'selection', genomes: 'A,B,E' }), file, dissolved, BASE.names)).toMatchObject({ view: 'selection', genomes: 'A,E' })
    expect(carryGenomeView(at({ view: 'selection', genomes: 'B' }), file, dissolved, BASE.names).view).toBe('genomes')
  })

  it('keeps a contig’s place and gives it the genome it is in now', () => {
    const moved = of({ op: 'move', contigs: ['a2'], to: 'B' })
    expect(carryGenomeView(at({ view: 'region', genome: 'A', region: 'a2:100-900' }), file, moved, BASE.names)).toMatchObject({ view: 'region', genome: 'B', region: 'a2:100-900' })
    // …and none where it went to the pool: the contigs table is its trail.
    const pooled = of({ op: 'move', contigs: ['a2'], to: null })
    const view = carryGenomeView(at({ view: 'region', genome: 'A', region: 'a2' }), file, pooled, BASE.names)
    expect(view).toMatchObject({ view: 'region', region: 'a2' })
    expect(view.genome).toBeUndefined()
  })

  it('back to the file’s binning, a created genome is gone and a renamed one is found again', () => {
    const curated = of({ op: 'create', id: 'n1', name: 'New', kind: 'mag', contigs: ['u1'] }, { op: 'rename', genome: 'A', name: 'Kleb' })
    expect(carryGenomeView(at({ view: 'genome', genome: 'New' }), curated, file, BASE.names).view).toBe('genomes')
    expect(carryGenomeView(at({ view: 'genome', genome: 'Kleb' }), curated, file, BASE.names)).toMatchObject({ view: 'genome', genome: 'A' })
  })
})
