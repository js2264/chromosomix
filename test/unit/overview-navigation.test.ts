/**
 * Where a click in the whole-metagenome overview leads (§5.5, §7.3).
 *
 * The overview is read by genome at either level — its blocks are the genomes
 * and its dividers mark them — so a cell means "these two bins touch" and the
 * view to open is the pair, or the genome itself when both axes are inside one
 * block. The contig under the pointer decides only which genome that is.
 *
 * `Overview` needs a document and this suite runs in Node, so the rule is
 * asserted through the pure function the class dispatches on.
 */

import { describe, expect, it } from 'vitest'

import { overviewTarget } from '@/ui/Overview'

describe('overviewTarget at contig level', () => {
  it('opens the genome pair for two contigs of different genomes', () => {
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: 'NODE_7229',
        colLabel: 'NODE_3543',
        rowGenome: 'MAG_1',
        colGenome: 'MAG_2',
      }),
    ).toEqual({ kind: 'pair', rowGenome: 'MAG_1', colGenome: 'MAG_2' })
  })

  it('opens the genome for two different contigs of the *same* genome', () => {
    // The off-diagonal cell inside one block: it used to open contig × contig,
    // which skips the level the click was asking about.
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: 'NODE_7229',
        colLabel: 'NODE_3543',
        rowGenome: 'MAG_1',
        colGenome: 'MAG_1',
      }),
    ).toEqual({ kind: 'genome', genome: 'MAG_1' })
  })

  it('opens the genome for a contig with itself', () => {
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: 'NODE_7229',
        colLabel: 'NODE_7229',
        rowGenome: 'MAG_1',
        colGenome: 'MAG_1',
      }),
    ).toEqual({ kind: 'genome', genome: 'MAG_1' })
  })

  it('falls back to the contigs when neither carries a genome', () => {
    expect(overviewTarget({ level: 'contig', rowLabel: 'NODE_1', colLabel: 'NODE_2' })).toEqual({
      kind: 'contig',
      rowContig: 'NODE_1',
      colContig: 'NODE_2',
    })
    expect(overviewTarget({ level: 'contig', rowLabel: 'NODE_1', colLabel: 'NODE_1' })).toEqual({
      kind: 'contig',
      rowContig: 'NODE_1',
    })
  })

  it('falls back when only one axis can be named', () => {
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: 'NODE_1',
        colLabel: 'NODE_2',
        rowGenome: 'MAG_1',
      }),
    ).toEqual({ kind: 'contig', rowContig: 'NODE_1', colContig: 'NODE_2' })
  })
})

describe('overviewTarget at genome level', () => {
  it('is unchanged: the pair off the diagonal, the genome on it', () => {
    expect(overviewTarget({ level: 'genome', rowLabel: 'MAG_1', colLabel: 'MAG_2' })).toEqual({
      kind: 'pair',
      rowGenome: 'MAG_1',
      colGenome: 'MAG_2',
    })
    expect(overviewTarget({ level: 'genome', rowLabel: 'MAG_1', colLabel: 'MAG_1' })).toEqual({
      kind: 'genome',
      genome: 'MAG_1',
    })
  })
})
