/**
 * The writers made cheaper, held to the files they wrote before.
 *
 * Three changes, each of which must not move a byte: a profile's rows joined a
 * block at a time (`RowBlocks`) rather than held one by one to the end; the
 * trailing zeros of a number trimmed by hand rather than by a regular
 * expression; and a bigWig's blocks deflated by Node's own zlib, which the
 * command line hands the writer, rather than through `CompressionStream`. And
 * one accumulation made cheaper: coverage's pixels added a chunk at a time.
 * Each is compared with a reference written the old way, on inputs large and
 * awkward enough to cross every boundary the new code has.
 */

import { deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { CoverageAccumulator, binContigMap } from '@/analysis/coverage'
import type { ProfileOutput, Provenance } from '@/analysis/types'
import { profileToBedGraph, type BedGraphContig } from '@/analysis/write/bedgraph'
import { writeBigWig } from '@/analysis/write/bigwig'
import { outputToTsv, provenanceLines, tsvNumber } from '@/analysis/write/tsv'

const PROVENANCE: Provenance = {
  task: 'coverage',
  taskVersion: 1,
  params: { cis: true },
  framing: {
    uri: 'mouse.mcool::/resolutions/10000',
    rows: [0, 9000],
    cols: [0, 9000],
    binsize: 10_000,
    binsPerCell: 1,
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
    label: 'whole file at 10 kb · counts',
  },
  app: 'chromosomix 0.13.0 (test)',
  createdAt: '2026-10-16T12:00:00',
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** Three sequences, the last ending part-way through a bin, over 9,000 bins: two blocks and a remainder. */
const BINSIZE = 10_000
const CONTIGS: BedGraphContig[] = [
  { name: 'chr1', length: 40_000_000, startBin: 0, bins: 4000 },
  { name: 'chr2', length: 30_000_000, startBin: 4000, bins: 3000 },
  { name: 'chrX', length: 19_995_001, startBin: 7000, bins: 2000 },
]

/** Integers, fractions of every size, gaps and infinities, as a profile can hold. */
function values(seed: number): Float32Array {
  const rng = random(seed)
  const out = new Float32Array(9000)
  for (let i = 0; i < out.length; i++) {
    const kind = rng()
    out[i] =
      kind < 0.05 ? Number.NaN
      : kind < 0.06 ? Number.POSITIVE_INFINITY
      : kind < 0.4 ? Math.floor(rng() * 5000)
      : (rng() - 0.3) * 10 ** Math.floor(rng() * 12 - 6)
  }
  return out
}

function profile(seed: number): ProfileOutput {
  return {
    kind: 'profile',
    id: 'coverage-total',
    label: 'Coverage · total',
    values: values(seed),
    extent: [0, 9000],
    binsize: BINSIZE,
    unit: 'contacts',
  }
}

/** `tsvNumber` as it was, with the regular expression. */
function tsvNumberBefore(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Number.isInteger(value)) return Math.abs(value) < 1e21 ? String(value) : value.toFixed(0)
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const decimals = Math.min(100, Math.max(0, 5 - magnitude))
  const text = value.toFixed(decimals)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

describe('tsvNumber', () => {
  it('writes every number as it did with the regular expression', () => {
    const rng = random(7)
    const cases = [0.5, -0.5, 1e-7, 123456.5, 999999.5, 0.0009999996, 100.00001, -0.000001, 5e-324, 1e21, 1.5e22]
    for (let i = 0; i < 200_000; i++) cases.push((rng() - 0.5) * 10 ** (rng() * 30 - 15))
    for (const value of [...cases, ...Float32Array.from(cases)]) expect(tsvNumber(value), `${value}`).toBe(tsvNumberBefore(value))
  })
})

describe('a profile, a block of rows at a time', () => {
  it('is the TSV it was, one row a line', () => {
    const output = profile(1)
    const lines = [...provenanceLines(PROVENANCE), `# output: ${output.label} (contacts)`, `# binsize: ${BINSIZE}`, 'bin\tstart\tend\tvalue']
    for (let i = 0; i < output.values.length; i++) {
      lines.push([String(i), String(i * BINSIZE), String((i + 1) * BINSIZE), tsvNumberBefore(output.values[i])].join('\t'))
    }
    expect(outputToTsv(output, PROVENANCE)).toBe(`${lines.join('\n')}\n`)
  })

  it('is the bedGraph it was, one row a line', () => {
    const output = profile(2)
    const format = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(7))))
    const rows = provenanceLines(PROVENANCE)
    for (const contig of CONTIGS) {
      for (let local = 0; local < contig.bins; local++) {
        const value = output.values[contig.startBin + local]
        if (!Number.isFinite(value)) continue
        const start = local * BINSIZE
        const end = Math.min(contig.length, start + BINSIZE)
        if (end > start) rows.push(`${contig.name}\t${start}\t${end}\t${format(value)}`)
      }
    }
    rows.push('')
    expect(profileToBedGraph(output, CONTIGS, PROVENANCE)).toBe(rows.join('\n'))
  })
})

describe('a bigWig deflated by the caller', () => {
  it('is the same file, byte for byte, as one deflated through CompressionStream', async () => {
    const input = {
      contigs: CONTIGS.map((contig) => ({ name: contig.name, length: contig.length })),
      values: profile(3).values,
      firstBin: 0,
      binsize: BINSIZE,
    }
    const streamed = new Uint8Array(await (await writeBigWig(input)).arrayBuffer())
    const synchronous = new Uint8Array(await (await writeBigWig(input, { deflate: (bytes) => deflateSync(bytes) })).arrayBuffer())
    expect(synchronous.length).toBe(streamed.length)
    expect(Buffer.compare(Buffer.from(synchronous), Buffer.from(streamed))).toBe(0)
  })
})

describe('CoverageAccumulator.addPixels', () => {
  it('adds a chunk as add() adds its pixels one by one, raw and balanced', () => {
    const nBins = 500
    const contigOf = binContigMap(
      [
        { startBin: 0, bins: 200 },
        { startBin: 200, bins: 300 },
      ],
      nBins,
    )
    const rng = random(4)
    const length = 20_000
    const bin1 = new Int32Array(length + 3)
    const bin2 = new Int32Array(length + 3)
    const count = new Float64Array(length + 3)
    for (let i = 0; i < length; i++) {
      const a = Math.floor(rng() * nBins)
      bin1[i] = rng() < 0.01 ? nBins + 5 : a
      bin2[i] = rng() < 0.01 ? -1 : a + Math.floor(rng() * (nBins - a))
      count[i] = rng() < 0.02 ? Number.NaN : 1 + Math.floor(rng() * 9)
    }
    // Past `length`, which a chunk's arrays may hold: never read.
    bin1.fill(3, length)
    bin2.fill(3, length)
    count.fill(1e9, length)
    const weights = Float64Array.from({ length: nBins }, () => (rng() < 0.1 ? Number.NaN : 0.5 + rng()))
    for (const w of [null, weights]) {
      const one = new CoverageAccumulator(nBins, contigOf)
      for (let i = 0; i < length; i++) one.add(bin1[i], bin2[i], w === null ? count[i] : count[i] * w[bin1[i]] * w[bin2[i]])
      const many = new CoverageAccumulator(nBins, contigOf)
      many.addPixels(bin1, bin2, count, length, w)
      expect(Array.from(many.cis)).toEqual(Array.from(one.cis))
      expect(Array.from(many.trans)).toEqual(Array.from(one.trans))
    }
  })
})
