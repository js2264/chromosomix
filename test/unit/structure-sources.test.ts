/**
 * What a model is coloured by when it is not the file (§25.5): each helper
 * over a small model, with the numbers held still.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import type { PairSet, TrackSampleSet } from '@/annotations/types'
import { buildStructure, type Structure } from '@/structure/scene'
import {
  contactsSource,
  distanceSource,
  featureSource,
  loopChords,
  marksSource,
  midpointsOf,
  structureAxis,
  trackSource,
} from '@/structure/sources'
import { parseBed } from '@/annotations/parse'

const MODEL = [
  'chrA 0 0 0 0',
  'chrA 10000 1 0 0',
  'chrA 20000 2 0 0',
  'chrA 30000 3 0 0',
  'chrB 0 0 2 0',
  'chrB 10000 1 2 0',
].join('\n')

function model(): Structure {
  const structure = buildStructure(parseG3d(MODEL))
  if (structure === null) throw new Error('no model')
  return structure
}

describe('the model as an axis', () => {
  it('lays the sequences end to end at a base pair per unit, each to its last bead', () => {
    const axis = structureAxis(model())
    expect(axis.contigs()).toEqual(['chrA', 'chrB'])
    expect(axis.segmentOf('chrA')?.unitEnd).toBe(40000)
    expect(axis.segmentOf('chrB')?.unitStart).toBe(40000)
    expect(axis.segmentOf('chrB')?.contigLength).toBe(20000)
    expect(midpointsOf(model())[1]).toEqual({ contig: 'chrA', bp: 15000 })
  })
})

describe('colouring by a track', () => {
  const samples: TrackSampleSet = {
    basesPerPixel: 10000,
    extent: { min: 0, max: 8 },
    regions: [
      {
        contig: 'chrA',
        start: 0,
        end: 40000,
        starts: Int32Array.from([0, 10000, 20000, 30000]),
        ends: Int32Array.from([10000, 20000, 30000, 40000]),
        values: Float32Array.from([1, 2, 4, 8]),
        min: null,
        max: null,
        variant: 'value',
        summary: false,
      } as unknown as TrackSampleSet['regions'][number],
    ],
  }

  it('reads the value at each bead’s middle and leaves an uncovered bead unset', () => {
    const source = trackSource(model(), samples, 'ATAC', { auto: true, min: 0, max: 1 })
    expect(Array.from(source.values ?? [])).toEqual([1, 2, 4, 8, NaN, NaN])
    expect(source.range).toBeUndefined()
  })

  it('takes the lane’s limits where they are fixed, so the colours agree with the lane', () => {
    const source = trackSource(model(), samples, 'ATAC', { auto: false, min: 0, max: 10 })
    expect(source.range).toEqual({ min: 0, max: 10 })
  })

  it('is all unset before the samples arrive', () => {
    const source = trackSource(model(), null, 'ATAC', { auto: true, min: 0, max: 1 })
    expect(Array.from(source.values ?? []).every((v) => Number.isNaN(v))).toBe(true)
  })
})

describe('colouring by a feature set', () => {
  it('gives a bead the colour of the first feature it overlaps', () => {
    const features = parseBed('chrA\t5000\t12000\tpeak1\nchrB\t0\t100\tpeak2\n')
    const source = featureSource(model(), features, 'peaks', '#c0392b')
    expect(source.colours).toEqual(['#c0392b', '#c0392b', null, null, '#c0392b', null])
    const byName = featureSource(model(), features, 'peaks', '#000', (index) => `f${index}`)
    expect(byName.colours?.[0]).toBe('f0')
    expect(byName.colours?.[4]).toBe('f1')
  })
})

describe('colouring by the reader’s marks', () => {
  it('colours a line’s bead, a rectangle’s spans, and lets a later mark win', () => {
    const source = marksSource(model(), [
      { id: 'm1', kind: 'rect', a: { contig: 'chrA', from: 0, to: 25000 }, b: { contig: 'chrB', from: 0, to: 5000 }, colour: 'red' },
      { id: 'm2', kind: 'line', axis: 'both', at: { contig: 'chrA', bp: 15000 }, colour: 'blue' },
    ])
    expect(source.colours).toEqual(['red', 'blue', 'red', null, 'red', null])
  })
})

describe('colouring from a pinned bead', () => {
  it('is the distance in the model’s own units, and says so when nothing is pinned', () => {
    const structure = model()
    const source = distanceSource(structure, 0)
    expect(source.values?.[0]).toBeCloseTo(0)
    expect(source.values?.[3]).toBeCloseTo(3)
    expect(distanceSource(structure, -1).label).toMatch(/pin one/)
  })

  it('puts the map’s row through the map’s own transform and range', () => {
    const structure = model()
    const contacts = Float32Array.from([100, 10, 1, NaN, 0.1, 5])
    const scale = { vmin: -1, vmax: 2, transform: 'log10' as const, colormap: 'fall' }
    const source = contactsSource(structure, contacts, scale)
    expect(source.values?.[0]).toBeCloseTo(2)
    expect(source.values?.[2]).toBeCloseTo(0)
    expect(Number.isNaN(source.values?.[3] ?? 0)).toBe(true)
    expect(source.range).toEqual({ min: -1, max: 2 })
    expect(source.colormap).toBe('fall')
    expect(contactsSource(structure, null, null).label).toMatch(/pin one/)
  })

  it('puts a pair the map never counted at the bottom of the ramp, not the top', () => {
    // `log10`'s clamp folds a zero to `0`, which is numpy's and right on a map
    // whose scale starts there. The scale here is the map's *transformed*
    // range, and a balanced map's runs from about −3.6 to about 0 — so the
    // clamp drew every uncounted pair at the dark end, and the beads with no
    // contact at all came out as the most contacted in the picture.
    const structure = model()
    const contacts = Float32Array.from([0, 1, 0, 0, 0, 0])
    const scale = { vmin: -3.65, vmax: 0.031, transform: 'log10' as const, colormap: 'fall' }
    const source = contactsSource(structure, contacts, scale)
    expect(source.values?.[0]).toBeCloseTo(-3.65)
    // …and a value that is really there is still on the scale.
    expect(source.values?.[1]).toBeCloseTo(0)
  })
})

describe('loops as chords', () => {
  const pairs: PairSet = {
    contigs: ['chrA', 'chrB', 'chrZ'],
    length: 4,
    contig1: Int32Array.from([0, 0, 0, 2]),
    start1: Int32Array.from([0, 0, 20000, 0]),
    end1: Int32Array.from([5000, 5000, 25000, 10]),
    contig2: Int32Array.from([0, 1, 0, 2]),
    start2: Int32Array.from([30000, 10000, 20000, 100]),
    end2: Int32Array.from([35000, 15000, 25000, 110]),
    score: Float32Array.from([1, 1, 1, 1]),
    name: ['', '', '', ''],
    detail: ['', '', '', ''],
  }

  it('joins the beads at each anchor, drops a pair on one bead or off the model, and caps', () => {
    const structure = model()
    expect(loopChords(structure, pairs, null)).toEqual([
      [0, 3],
      [0, 5],
    ])
    expect(loopChords(structure, pairs, null, 1)).toEqual([[0, 3]])
  })

  it('keeps only the loops touching the window, where there is one', () => {
    const structure = model()
    const lit = Uint8Array.from([0, 0, 0, 0, 0, 1])
    expect(loopChords(structure, pairs, lit)).toEqual([[0, 5]])
  })
})
