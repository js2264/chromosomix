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
  TableOutput,
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
    normalise: null,
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

  it('writes the names of an abscissa that is a list, not the indices', () => {
    // The matrix writer's own argument, one axis down: a column of `0, 1, 2`
    // beside a column of fractions asks the reader to count bars on the picture
    // to find out which sequence the third row is about.
    const named: CurveOutput = {
      ...curve,
      xLabel: 'Sequence',
      xTicks: ['I', 'II', 'III'],
      series: [
        { name: 'cis', x: Float64Array.from([0, 1, 2]), y: Float64Array.from([1, 0.5, 0]) },
      ],
    }
    expect(body(outputToTsv(named, PROVENANCE))).toEqual([
      ['Sequence', 'cis'],
      ['I', '1'],
      ['II', '0.5'],
      ['III', '0'],
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

  it('writes the edge profiles as a block of their own under the matrix', () => {
    // The lines drawn along a pileup's edges were the one thing in the figure
    // with no numbers behind it. They go *under* the rectangle rather than into
    // it: contacts and signal are two units, and a spreadsheet reading them as
    // one block would average them together.
    const withEdges: MatrixOutput = {
      ...matrix,
      margins: {
        top: [{ name: 'ATAC', values: Float64Array.from([1, 2, 3]) }],
        right: [{ name: 'ATAC', values: Float64Array.from([4, Number.NaN]) }],
      },
    }
    const text = outputToTsv(withEdges, PROVENANCE)
    expect(text).toContain('# aggregate profiles along the edges')
    // Split without trimming: the last row ends in the tab of a gap, and a
    // trim would take it off and make the assertion below a lie about the file.
    const lines = text.split('\n')
    expect(lines).toContain('edge\ttrack\t0\t1\t2')
    expect(lines).toContain('top\tATAC\t1\t2\t3')
    // A gap stays a gap, which is what every other number in this writer does.
    expect(lines).toContain('right\tATAC\t4\t')
    // …and the matrix above it is untouched.
    expect(body(text)[0]).toEqual(['offset', '-10 kb', '0', '+10 kb'])
  })

  it('writes no such block where the pileup has no profiles', () => {
    expect(outputToTsv(matrix, PROVENANCE)).not.toContain('aggregate profiles')
  })

  it('does not put a positional tick list over the first few columns', () => {
    // A scaled pileup's ticks are *positions* on a continuous axis, drawn evenly
    // spaced across the picture — five of them describing forty-one columns.
    // Written into the header they would sit over the first five columns with
    // indices after them, which is a table saying something untrue about where
    // the axis is. They go in a `#` line and the columns keep their indices.
    const scaled: MatrixOutput = {
      ...matrix,
      xTicks: ['-0.5', '1.5'],
      yTicks: ['-0.5', '0.5', '1.5'],
    }
    const text = outputToTsv(scaled, PROVENANCE)
    expect(text).toContain('# x ticks, evenly spaced across the axis: -0.5, 1.5')
    expect(text).toContain('# y ticks, evenly spaced across the axis: -0.5, 0.5, 1.5')
    expect(body(text)).toEqual([
      ['offset', '0', '1', '2'],
      ['0', '1', '2', '3'],
      ['1', '4', '', '6'],
    ])
  })
})

/**
 * A column that says its values may be very small (a P, a q) keeps them: the
 * drawer writes `6.53e-23`, and so must the file, where a `0` would be a claim
 * the test never made and a script could not tell from a P that really was.
 */
describe('outputToTsv, table', () => {
  const tests: TableOutput = {
    kind: 'table',
    id: 'groupsignal-tests',
    label: 'Between groups',
    columns: [
      { key: 'test', label: 'Test', kind: 'text' },
      { key: 'effect', label: 'Effect', kind: 'number', digits: 3 },
      { key: 'p', label: 'P', kind: 'number', digits: 4, scientific: true },
    ],
    rows: [
      { test: 'Mann–Whitney U', effect: 0.4449, p: 6.5312345e-23 },
      { test: 'Mann–Whitney U', effect: 0.1, p: 0.0123 },
      { test: 'Mann–Whitney U', effect: 0.00001, p: 0 },
    ],
  }

  it('writes a value too small for its digits with an exponent, where the column allows it', () => {
    const rows = body(outputToTsv(tests, PROVENANCE))
    expect(rows[0]).toEqual(['test', 'effect', 'p'])
    expect(rows[1]).toEqual(['Mann–Whitney U', '0.445', '6.53123e-23'])
    expect(Number(rows[1][2])).toBeCloseTo(6.53123e-23, 28)
    // A value its digits can hold is written as they say.
    expect(rows[2][2]).toBe('0.0123')
    // Zero is zero, and a column that did not ask keeps its places.
    expect(rows[3]).toEqual(['Mann–Whitney U', '0', '0'])
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
