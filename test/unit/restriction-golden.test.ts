/**
 * The restriction digest and its pair statistics, held to bioframe and to
 * pairtools (`scripts/make_restriction_golden.py`).
 *
 * Three references, each for the part it is the authority on:
 *
 * - **`bioframe.digest`** (Biopython's `Bio.Restriction`) for the cuts, over the
 *   repository's yeast genome, for every preset, the Arima kit, a degenerate
 *   typed site and one that is not a palindrome. bioframe's boundaries are two
 *   bases late at every site — Biopython already reports the first base after
 *   the cut, and bioframe adds one — so they are held to the app's top-strand
 *   cuts plus two, exactly, and the script's docstring says why.
 * - **`pairtools restrict`** for the fragment each end of a `.pairs` lies in,
 *   over the thirty thousand records of the pairs-stats fixture, run once on
 *   the top-strand fragments for the `+` ends and once on the bottom-strand
 *   ones for the `-` ends.
 * - **An independent computation of the shared definitions** in the script,
 *   from restrict's columns, for the classes, the distances and the fragments
 *   seen; the app's counter is held to it in full.
 *
 * All three are committed, so this runs on every push with nothing to build.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  RestrictionCounter,
  boundaries,
  contigCuts,
  cutsIn,
  enzymeByName,
  enzymesFor,
  fragmentOf,
  type CutSites,
  type Enzyme,
} from '@/genome/restriction'

const ROOT = resolve(__dirname, '../..')
const GOLDEN = resolve(ROOT, 'test/golden/restriction')

interface Digest {
  reference: string
  lengths: Record<string, number>
  table: Record<string, { site: string; cut: number }>
  typed: Record<string, string>
  kits: Record<string, string[]>
  /** Per digest, per sequence: bioframe's boundaries as the gaps between them. */
  boundaries: Record<string, Record<string, string>>
}

const digest = JSON.parse(gunzipSync(readFileSync(resolve(GOLDEN, 'digest.json.gz'))).toString('utf8')) as Digest

/** The reference, one byte per residue, by sequence, in its own order. */
const reference = ((): Map<string, Uint8Array> => {
  const out = new Map<string, Uint8Array>()
  let name = ''
  let parts: string[] = []
  const flush = (): void => {
    if (name !== '') out.set(name, new Uint8Array(Buffer.from(parts.join(''), 'latin1')))
  }
  for (const raw of readFileSync(resolve(ROOT, digest.reference), 'latin1').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('>')) {
      flush()
      name = line.slice(1).trim().split(/\s+/)[0]
      parts = []
    } else if (line !== '') {
      parts.push(line)
    }
  }
  flush()
  return out
})()

/** bioframe's boundaries for one digest and sequence, `[0, …, length]`. */
function bioframe(key: string, contig: string): number[] {
  const out = [0]
  for (const gap of digest.boundaries[key][contig].split(',')) out.push(out[out.length - 1] + Number(gap))
  return out
}

/** The app's top-strand boundaries, from a scan of the whole sequence. */
function cutsOf(contig: string, list: readonly Enzyme[]): CutSites {
  const bases = reference.get(contig)
  if (bases === undefined) throw new Error(`no ${contig}`)
  return contigCuts([cutsIn(bases, list)], bases.length)
}

function list(choice: string, sites = ''): Enzyme[] {
  const out = enzymesFor(choice, sites)
  if (!Array.isArray(out)) throw new Error(out.refusal)
  return out
}

/** bioframe's boundaries, two bases earlier at every cut: what the app's must be. */
function expected(bounds: readonly number[]): number[] {
  return bounds.map((value, at) => (at === 0 || at === bounds.length - 1 ? value : value - 2))
}

describe('the reference', () => {
  it('is the one the golden was digested from, sequence for sequence', () => {
    expect([...reference.keys()]).toEqual(Object.keys(digest.lengths))
    for (const [name, length] of Object.entries(digest.lengths)) expect(reference.get(name)?.length, name).toBe(length)
  })
})

describe('the enzyme table, against Biopython', () => {
  it('has each preset and alias at Biopython’s site and cut', () => {
    for (const [name, { site, cut }] of Object.entries(digest.table)) {
      const enzyme = enzymeByName(name)
      expect(enzyme, name).toBeDefined()
      expect({ site: enzyme?.site, cut: enzyme?.cut }, name).toEqual({ site, cut })
    }
  })
})

describe('cutsIn, against bioframe.digest', () => {
  const presets = Object.keys(digest.boundaries).filter((key) => enzymeByName(key) !== undefined)

  it('covers every preset', () => {
    expect(new Set(presets)).toEqual(new Set(Object.keys(digest.table).filter((name) => enzymeByName(name)?.name === name)))
  })

  for (const name of presets) {
    it(`cuts ${name} where bioframe does, less two, at every site`, () => {
      for (const contig of reference.keys()) {
        const length = digest.lengths[contig]
        const ours = cutsOf(contig, list(name))
        expect(Array.from(boundaries(ours.top, length)), `${name} on ${contig}`).toEqual(
          expected(bioframe(name, contig)),
        )
      }
    })
  }

  it('cuts the Arima kit where DpnII and HinfI do, both sets of boundaries merged', () => {
    for (const contig of reference.keys()) {
      const length = digest.lengths[contig]
      const merged = [
        ...new Set([...expected(bioframe('DpnII', contig)), ...expected(bioframe('HinfI', contig))]),
      ].sort((a, b) => a - b)
      expect(Array.from(boundaries(cutsOf(contig, list('Arima')).top, length)), contig).toEqual(merged)
    }
  })

  for (const [site, enzyme] of Object.entries(digest.typed)) {
    it(`cuts a typed ${site} where Biopython's ${enzyme} does`, () => {
      for (const contig of reference.keys()) {
        const length = digest.lengths[contig]
        const ours = cutsOf(contig, list('custom', site))
        expect(Array.from(boundaries(ours.top, length)), `${site} on ${contig}`).toEqual(
          expected(bioframe(site, contig)),
        )
      }
    })
  }

  it('finds the first DpnII site of chromosome I at the G of its GATC', () => {
    // The validation notebook's own spot check on R64, which shares chrI: GATC
    // at 0-based 336, bioframe's boundary at 338.
    expect(cutsOf('I', list('DpnII')).top[0]).toBe(336)
    expect(bioframe('DpnII', 'I')[1]).toBe(338)
  })

  it('finds every site once when the sequence is read in overlapping pieces', () => {
    const enzymes = list('Arima')
    for (const contig of ['I', 'III']) {
      const bases = reference.get(contig) as Uint8Array
      const pieces: CutSites[] = []
      const step = 9_973
      for (let from = 0; from < bases.length; from += step) {
        pieces.push(cutsIn(bases.subarray(from, Math.min(bases.length, from + step + 4)), enzymes, from))
      }
      const whole = cutsOf(contig, enzymes)
      const pieced = contigCuts(pieces, bases.length)
      expect(Array.from(pieced.top), contig).toEqual(Array.from(whole.top))
      expect(Array.from(pieced.bottom), contig).toEqual(Array.from(whole.bottom))
    }
  })
})

// ---------------------------------------------------------------------------
// The pairs
// ---------------------------------------------------------------------------

interface PairRecord {
  chrom1: string
  pos1: number
  chrom2: string
  pos2: number
  strand1: string
  strand2: string
  type: string
}

const records = ((): PairRecord[] => {
  const text = gunzipSync(readFileSync(resolve(ROOT, 'test/golden/pairs_stats/sample.pairs.gz'))).toString('utf8')
  const out: PairRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const [, chrom1, pos1, chrom2, pos2, strand1, strand2, type] = line.split('\t')
    out.push({ chrom1, pos1: Number(pos1), chrom2, pos2: Number(pos2), strand1, strand2, type })
  }
  return out
})()

/** restrict's rows: per record the reference holds, each end's fragment and its 1-based ends as distances from `pos`. */
const restricted = ((): number[][] => {
  const lines = gunzipSync(readFileSync(resolve(GOLDEN, 'restrict.tsv.gz'))).toString('utf8').split('\n')
  expect(lines[0]).toBe('rfrag1\tback1\tahead1\trfrag2\tback2\tahead2')
  return lines.slice(1).filter((line) => line !== '').map((line) => line.split('\t').map(Number))
})()

const dpnii = new Map([...reference.keys()].map((contig) => [contig, cutsOf(contig, list('DpnII'))]))

describe('fragmentOf, against pairtools restrict', () => {
  it('places every end where restrict does, by the boundaries of the strand it was read on', () => {
    // restrict was given the records on sequences the reference holds, in order.
    const given = records.filter(
      (record) =>
        (record.chrom1 === '!' || reference.has(record.chrom1)) &&
        (record.chrom2 === '!' || reference.has(record.chrom2)),
    )
    expect(given.length).toBe(restricted.length)
    let checked = 0
    given.forEach((record, row) => {
      const columns = restricted[row]
      for (const side of [1, 2] as const) {
        const chrom = side === 1 ? record.chrom1 : record.chrom2
        const pos = side === 1 ? record.pos1 : record.pos2
        const strand = side === 1 ? record.strand1 : record.strand2
        const [rfrag, back, ahead] = columns.slice((side - 1) * 3, side * 3)
        if (chrom === '!') {
          expect([rfrag, back, ahead]).toEqual([-1, pos, 0 - pos])
          continue
        }
        const sites = dpnii.get(chrom) as CutSites
        const length = digest.lengths[chrom]
        const bounds = boundaries(strand === '-' ? sites.bottom : sites.top, length)
        const fragment = fragmentOf(bounds, pos - 1)
        const start = fragment === 0 ? 0 : bounds[fragment] + 1
        const end = bounds[fragment + 1] + 1
        expect([fragment, pos - start, end - pos], `record ${row}, end ${side}`).toEqual([rfrag, back, ahead])
        checked++
      }
    })
    expect(checked).toBeGreaterThan(40_000)
  })
})

describe('RestrictionCounter, against the definitions computed from restrict’s columns', () => {
  it('counts every class, orientation, distance and fragment as the script does', () => {
    const golden = JSON.parse(readFileSync(resolve(GOLDEN, 'stats.json'), 'utf8')) as unknown
    const counter = new RestrictionCounter(dpnii, new Map(Object.entries(digest.lengths)), 'DpnII')
    for (const r of records) counter.add(r.chrom1, r.pos1, r.strand1, r.chrom2, r.pos2, r.strand2, r.type === 'DD')
    expect(counter.result()).toEqual(golden)
  })
})
