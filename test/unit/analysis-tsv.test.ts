/**
 * The TSV a reader checks a figure against.
 *
 * These are the four properties that make the file worth offering at all
 * (§18.7), and each of them is a thing a careless writer gets wrong in a way
 * nobody notices until a number is already in print: a missing value that comes
 * back as zero, a short series that truncates a long one, a grid with no way to
 * say which row is which, and a provenance line that a parser reads as data.
 */

import { describe, expect, it } from 'vitest'

import { outputToTsv, provenanceLines, tsvName } from '@/analysis/write/tsv'
import type {
  CurveOutput,
  MatrixOutput,
  ProfileOutput,
  Provenance,
  TaskOutput,
} from '@/analysis/types'

const PROVENANCE: Provenance = {
  task: 'insulation',
  taskVersion: 3,
  params: { window: 10, unit: 'bins', balance: true, tracks: ['a', 'b'], phase: null },
  framing: {
    uri: 'demo/yeast/micro-c.cool',
    rows: [0, 1531],
    cols: [0, 1531],
    binsize: 1000,
    binsPerCell: 1,
    balance: true,
    value: 'count',
    level: 'bin',
    label: 'chrIV:1–1,531,933 at 1 kb, balanced, count',
  },
  app: 'metacooler 0.9.0 (abc1234)',
  createdAt: '2026-08-08T14:52:33',
}

/** The rows of the table, with the provenance and the per-output notes dropped. */
function body(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'))
}

describe('provenanceLines', () => {
  it('comments every line, so a parser downstream skips the lot', () => {
    const lines = provenanceLines(PROVENANCE)
    expect(lines.length).toBeGreaterThan(5)
    for (const line of lines) expect(line.startsWith('#')).toBe(true)
  })

  it('names the build, the file, the task version, the framing and each parameter', () => {
    const text = provenanceLines(PROVENANCE).join('\n')
    expect(text).toContain('metacooler 0.9.0 (abc1234)')
    expect(text).toContain('demo/yeast/micro-c.cool')
    expect(text).toContain('insulation v3')
    expect(text).toContain('chrIV:1–1,531,933 at 1 kb, balanced, count')
    expect(text).toContain('# param window: 10')
    expect(text).toContain('# param balance: true')
    expect(text).toContain('# param tracks: a,b')
    expect(text).toContain('# param phase: ')
  })

  it('keeps every provenance line in one line, whatever the label contains', () => {
    const awkward: Provenance = {
      ...PROVENANCE,
      framing: { ...PROVENANCE.framing, label: 'chrIV\tsplit\nover two' },
    }
    expect(provenanceLines(awkward).every((line) => !line.includes('\n'))).toBe(true)
  })
})

const PROFILE: ProfileOutput = {
  kind: 'profile',
  id: 'insulation_w10',
  label: 'Insulation, 10 kb',
  values: Float32Array.from([0.5, Number.NaN, 2]),
  extent: [40, 43],
  binsize: 1000,
  unit: '',
}

describe('outputToTsv, profile', () => {
  it('writes a missing bin as an empty cell and never as the text NaN', () => {
    const text = outputToTsv(PROFILE, PROVENANCE)
    expect(text).not.toContain('NaN')
    expect(body(text)).toEqual([
      ['bin', 'start', 'end', 'value'],
      ['40', '40000', '41000', '0.5'],
      ['41', '41000', '42000', ''],
      ['42', '42000', '43000', '2'],
    ])
  })

  it('ends in exactly one newline', () => {
    const text = outputToTsv(PROFILE, PROVENANCE)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})

describe('outputToTsv, curve', () => {
  const curve: CurveOutput = {
    kind: 'curve',
    id: 'ps',
    label: 'Contact probability',
    xLabel: 'distance',
    yLabel: 'P(s)',
    xScale: 'log',
    yScale: 'log',
    series: [
      {
        name: 'short',
        x: Float64Array.from([1000, 2000]),
        y: Float64Array.from([0.1, 0.05]),
        low: Float64Array.from([0.08, 0.04]),
        high: Float64Array.from([0.12, 0.06]),
      },
      {
        name: 'long',
        x: Float64Array.from([1000, 2000, 4000]),
        y: Float64Array.from([0.2, 0.1, 0.02]),
      },
    ],
  }

  it('pads the shorter series rather than truncating the longer one', () => {
    expect(body(outputToTsv(curve, PROVENANCE))).toEqual([
      ['distance', 'short', 'short_low', 'short_high', 'long'],
      ['1000', '0.1', '0.08', '0.12', '0.2'],
      ['2000', '0.05', '0.04', '0.06', '0.1'],
      ['4000', '', '', '', '0.02'],
    ])
  })
})

describe('outputToTsv, matrix', () => {
  const matrix: MatrixOutput = {
    kind: 'matrix',
    id: 'apa',
    label: 'Aggregate peak analysis',
    nrows: 2,
    ncols: 3,
    values: Float32Array.from([1, 2, 3, 4, Number.NaN, 6]),
    xLabel: 'offset',
    yLabel: 'offset',
    xTicks: ['-10 kb', '0', '+10 kb'],
    yTicks: ['-10 kb', '+10 kb'],
    colormap: 'fall',
    stats: [{ label: 'P2LL', value: 1.8342, digits: 2 }],
  }

  it('puts the ticks on both edges and the statistics above the table', () => {
    const text = outputToTsv(matrix, PROVENANCE)
    expect(text).toContain('# P2LL: 1.83')
    expect(body(text)).toEqual([
      ['offset', '-10 kb', '0', '+10 kb'],
      ['-10 kb', '1', '2', '3'],
      ['+10 kb', '4', '', '6'],
    ])
  })

  it('falls back to indices where an axis carries no ticks', () => {
    const bare: MatrixOutput = { ...matrix, xTicks: [], yTicks: [] }
    expect(body(outputToTsv(bare, PROVENANCE))[0]).toEqual(['offset', '0', '1', '2'])
  })
})

describe('tsvName', () => {
  const named = (id: string): TaskOutput => ({ ...PROFILE, id })

  it('names the task, the output and the moment', () => {
    expect(tsvName('insulation_w10', named('chrIV'), '20260808-145233')).toBe(
      'insulation_w10-chrIV-20260808-145233.tsv',
    )
  })

  it('says the same name once', () => {
    expect(tsvName('mag qc', named('mag_qc'), '20260808-145233')).toBe('mag_qc-20260808-145233.tsv')
  })
})
