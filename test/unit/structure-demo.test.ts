/**
 * The two demo structures, read the way the viewer reads them (§25).
 *
 * `scripts/make_structure_demo.py` writes a crumpled ring for E. coli and a
 * Rabl nucleus for yeast, and its docstring says what each is shaped like.
 * This file holds those files to that word through `parseG3d` rather than
 * through the script's own arithmetic: the sniffer accepts them, the spacing
 * comes out at the 5 kb they were written at, the ring closes on itself, and
 * every yeast centromere sits under the pole with both arms running away from
 * it. A demo that had drifted from its description would be a demo teaching
 * the wrong thing about the format, and a viewer feature nobody could try.
 *
 * Skipped, not failed, when the files are absent: they are demo data, and a
 * checkout without them is not a broken parser.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { parseG3d, sniffG3d } from '@/annotations/g3d'
import type { FeatureSet } from '@/annotations/types'

const ECOLI = resolve(__dirname, '../../demo/ecoli/Ecoli.g3d.gz')
const YEAST = resolve(__dirname, '../../demo/yeast/Yeast_structure.g3d.gz')

/** The nucleus radius the script draws with; the spindle pole body is at `(0, 0, R)`. */
const R = 100

/** S. cerevisiae S288C centromere midpoints, as the script carries them. */
const CENTROMERES: Record<string, number> = {
  I: 151465,
  II: 238207,
  III: 114385,
  IV: 449711,
  V: 151987,
  VI: 148510,
  VII: 496920,
  VIII: 105586,
  IX: 355629,
  X: 436307,
  XI: 440129,
  XII: 150828,
  XIII: 268031,
  XIV: 628758,
  XV: 326584,
  XVI: 555957,
}

function load(path: string): { text: string; set: FeatureSet } {
  const text = gunzipSync(readFileSync(path)).toString('utf8')
  return { text, set: parseG3d(text, path) }
}

function at(set: FeatureSet, index: number): [number, number, number] {
  const model = set.model
  if (model === undefined) throw new Error('no model')
  return [model.x[index], model.y[index], model.z[index]]
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** The Roman numeral in a chromosome's name — `XIII-syn40` reads as `XIII`. */
function romanOf(name: string): string {
  const match = /^(?:chr)?([IVX]+)(?![A-Za-z0-9])/i.exec(name)
  if (match === null) throw new Error(`no Roman numeral in ${name}`)
  return match[1].toUpperCase()
}

describe.skipIf(!existsSync(ECOLI))('the E. coli demo structure', () => {
  it('is a 5 kb chain over one chromosome that the sniffer accepts', () => {
    const { text, set } = load(ECOLI)
    expect(sniffG3d(text)).toBe(true)
    expect(set.model?.width).toBe(5000)
    expect(set.contigs).toHaveLength(1)
    expect(set.start[0]).toBe(0)
  })

  it('closes on itself: the last bead is a neighbour of the first', () => {
    const { set } = load(ECOLI)
    const steps: number[] = []
    for (let index = 1; index < set.length; index++) steps.push(distance(at(set, index - 1), at(set, index)))
    steps.sort((a, b) => a - b)
    const median = steps[steps.length >> 1]
    expect(median).toBeGreaterThan(0)
    expect(distance(at(set, 0), at(set, set.length - 1))).toBeLessThan(3 * median)
  })
})

describe.skipIf(!existsSync(YEAST))('the yeast demo structure', () => {
  it('is a 5 kb chain over sixteen chromosomes that the sniffer accepts', () => {
    const { text, set } = load(YEAST)
    expect(sniffG3d(text)).toBe(true)
    expect(set.model?.width).toBe(5000)
    expect(set.contigs).toHaveLength(16)
  })

  it('is in Rabl orientation: centromeres under the pole, arms running away from it', () => {
    const { set } = load(YEAST)
    const pole = [0, 0, R]
    for (let contig = 0; contig < set.contigs.length; contig++) {
      const from = set.contigAt[contig]
      const to = set.contigAt[contig + 1]
      const cen = CENTROMERES[romanOf(set.contigs[contig])]
      expect(cen).toBeDefined()
      let cenBead = from
      for (let index = from; index < to; index++) if (set.start[index] <= cen) cenBead = index
      const atCen = distance(pole, at(set, cenBead))
      expect(atCen, set.contigs[contig]).toBeLessThan(R / 3)
      expect(distance(pole, at(set, from)), `${set.contigs[contig]} left telomere`).toBeGreaterThan(atCen)
      expect(distance(pole, at(set, to - 1)), `${set.contigs[contig]} right telomere`).toBeGreaterThan(atCen)
      // Inside the nucleus, give or take the wobble: a bead far outside it
      // would be a script whose R and this test's R had parted.
      for (let index = from; index < to; index++) {
        expect(distance([0, 0, 0], at(set, index))).toBeLessThan(R * 1.1)
      }
    }
  })
})
