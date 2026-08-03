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

import { overviewTarget, unitAt } from '@/ui/Overview'
import type { AxisGroup } from '@/worker/protocol'

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

describe('unitAt, which is what a pooled axis is clicked through', () => {
  const group = (label: string, start: number): AxisGroup => ({ label, start, end: start + 1 })

  it('resolves a pooled slot to the unit it starts at, not to its label', () => {
    // What the reader sends once an axis is pooled: the label is a summary, and
    // the name behind it is a real contig. Opening the label would hand
    // "NODE_7431 +15" to a range parser.
    const names = ['NODE_1', 'NODE_18', 'NODE_7431']
    expect(unitAt(names, group('NODE_7431 +15', 2))).toBe('NODE_7431')
  })

  it('agrees with the label when nothing is pooled', () => {
    const names = ['NODE_1', 'NODE_2', 'NODE_3']
    for (let i = 0; i < names.length; i++) expect(unitAt(names, group(names[i], i))).toBe(names[i])
  })

  it('falls back to the label when the reader sent no unit names', () => {
    expect(unitAt(null, group('MAG_1', 0))).toBe('MAG_1')
    expect(unitAt(undefined, group('MAG_1', 0))).toBe('MAG_1')
    // Short array — a slot past the end is the label's, not `undefined`.
    expect(unitAt(['MAG_1'], group('MAG_2', 1))).toBe('MAG_2')
  })

  it('feeds overviewTarget the unit, so a pooled diagonal opens one genome', () => {
    const names = ['NODE_1', 'NODE_7431']
    const row = group('NODE_7431 +15', 1)
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: unitAt(names, row),
        colLabel: unitAt(names, row),
        rowGenome: 'MAG_1',
        colGenome: 'MAG_1',
      }),
    ).toEqual({ kind: 'genome', genome: 'MAG_1' })
  })

  it('still names the contigs from a pooled axis when no genome backs them', () => {
    const names = ['NODE_1', 'NODE_7431']
    expect(
      overviewTarget({
        level: 'contig',
        rowLabel: unitAt(names, group('NODE_1 +3', 0)),
        colLabel: unitAt(names, group('NODE_7431 +15', 1)),
      }),
    ).toEqual({ kind: 'contig', rowContig: 'NODE_1', colContig: 'NODE_7431' })
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
