// @dev-feature curate
/**
 * The file's binning as the curation reads it (SPECS §33.2), on a stand-in map:
 * a genome flagged `mge` is the whole word on what is an element — a reassigned
 * map's stale round `mge` brings back no element the curation merged away —,
 * the links come from the MAGs' `mges` where the column is there, and a marker
 * set no contig has, stored as an empty number column, reads as none.
 */

import { describe, expect, it } from 'vitest'
import { readFileBinning } from '../../src/curate/base'
import { makeTable } from '../../src/h5/readTable'
import type { MetaCooler } from '../../src/metacooler/MetaCooler'

/** Contigs c0–c3; genomes A (MAG), E (element), and the pool. */
function map(options: { flags: boolean; mges: boolean; markerColumn: 'text' | 'empty' }): MetaCooler {
  const names = ['c0', 'c1', 'c2', 'c3']
  const genomeNames = ['__unbinned__', 'A', 'E']
  const genomeColumns = ['name', ...(options.flags ? ['mge'] : []), ...(options.mges ? ['mges'] : [])]
  const genomes = makeTable(3, genomeColumns, {
    name: genomeNames,
    ...(options.flags ? { mge: ['', 'False', 'True'] } : {}),
    ...(options.mges ? { mges: ['', 'E', ''] } : {}),
  })
  const contigs = makeTable(4, ['name', 'length', 'markers_S'], {
    name: names,
    length: Float64Array.from([4000, 3000, 2000, 1000]),
    markers_S: options.markerColumn === 'text' ? ['a', '', 'b*2', ''] : Float64Array.from([Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
  })
  // A stale round `mge`: E and a cluster G that the curation merged away, holding c3.
  const clusterTable = makeTable(2, ['round', 'name', 'hosts'], { round: Int32Array.from([0, 0]), name: ['E', 'G'], hosts: ['', 'A'] })
  const handle = {
    has: (path: string) => path === 'clusters/table' || path === 'clusters/members',
    attrsAt: () => ({ rounds: JSON.stringify([{ name: 'mge' }]) }),
    readTable: () => clusterTable,
    readInt32: (path: string) => (path.endsWith('cluster_id') ? Int32Array.from([0, 1]) : Int32Array.from([2, 3])),
  }
  return {
    chromnames: names,
    contigs: { numbers: () => [4000, 3000, 2000, 1000] },
    contigGenomeIds: Int32Array.from([1, 1, 2, 1]),
    genomeNames,
    fullGenomes: () => genomes,
    fullContigs: () => contigs,
    handle,
    metadata: { metator: { markers: { sets: { S: { column: 'markers_S', markers: ['a', 'b'], weights: [0.5, 0.5] } } } } },
  } as unknown as MetaCooler
}

describe('the file’s binning', () => {
  it('takes the genomes’ mge flag as the whole word on what is an element, and their mges as the links', () => {
    const read = readFileBinning(map({ flags: true, mges: true, markerColumn: 'text' }))
    expect(read.base.genomes).toEqual([
      { name: 'A', kind: 'mag' },
      { name: 'E', kind: 'element' },
    ])
    // c3 stays in A: the stale cluster G is not brought back.
    expect([...read.base.genomeOf]).toEqual([0, 0, 1, 0])
    expect(read.elements).toEqual({ count: 1, fromRoundOnly: 0 })
    expect(read.base.links).toEqual([{ element: 'E', mag: 'A' }])
  })

  it('reads round mge’s clusters as elements where the genomes flag none', () => {
    const read = readFileBinning(map({ flags: false, mges: false, markerColumn: 'text' }))
    expect(read.base.genomes.map((genome) => `${genome.name}:${genome.kind}`)).toEqual(['A:mag', 'E:element', 'G:element'])
    expect([...read.base.genomeOf]).toEqual([0, 0, 1, 2])
    expect(read.base.links).toEqual([{ element: 'G', mag: 'A' }])
  })

  it('reads a marker set from the column its entry names, and a set no contig has as none', () => {
    const texts = readFileBinning(map({ flags: true, mges: true, markerColumn: 'text' })).markers
    expect(texts.length).toBe(1)
    expect([...texts[0].offsets]).toEqual([0, 1, 1, 2, 2])
    const empty = readFileBinning(map({ flags: true, mges: true, markerColumn: 'empty' })).markers
    expect(empty.length).toBe(1)
    expect(empty[0].ids.length).toBe(0)
  })
})
