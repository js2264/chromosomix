/**
 * Two sequences against each other, run — in the annotations worker, beside
 * the residues of both (SPECS §28; `dotplot/dotplot.ts` for the method).
 *
 * Three outputs: the signed density of anchors, square in bases, `RdBu_r`
 * about nought — a line the same way round red, one the other way blue — with
 * the two sets' sequences marked along its axes; the streaks as a table; and
 * the streaks as pairs, which the Annotations panel takes as a row and writes
 * as BEDPE. The note says what was sampled, because a dot plot's blank is only
 * as good as its sampling.
 */

import { PairBuilder } from '../../annotations/featureset'
import { anchorsOf, densityOf, K, locate, MAX_OCCURRENCES, minimizersOf, oneToOne, sequenceSet, streaksOf, windowFor, type SequenceSet, type Streak } from '../../dotplot/dotplot'
import { idParam, numParam, strParam, type TrackTaskRunner } from '../job'
import { DOTPLOT_CELLS } from '../tasks/dotplot'
import type { DotplotStreaks, MatrixOutput, TaskOutput } from '../types'

/** The streaks kept, as the lines the figure on screen draws (§28.2), with the two axes they are measured along. */
function linesOf(streaks: readonly Streak[], a: SequenceSet, b: SequenceSet, xLabel: string, yLabel: string): DotplotStreaks {
  const n = streaks.length
  const lines: DotplotStreaks = {
    x: { label: xLabel, names: [...a.names], lengths: [...a.lengths] },
    y: { label: yLabel, names: [...b.names], lengths: [...b.lengths] },
    x0: new Float64Array(n),
    x1: new Float64Array(n),
    y0: new Float64Array(n),
    y1: new Float64Array(n),
    strand: new Int8Array(n),
    anchors: new Int32Array(n),
  }
  streaks.forEach((streak, i) => {
    lines.x0[i] = streak.x0
    lines.x1[i] = streak.x1
    lines.y0[i] = streak.y0
    lines.y1[i] = streak.y1
    lines.strand[i] = streak.strand
    lines.anchors[i] = streak.anchors
  })
  return lines
}

/** A set's sequences as marks along an axis of the figure, in its cells. */
function segmentsOf(set: SequenceSet, cellSize: number): NonNullable<MatrixOutput['xSegments']> {
  return set.names.map((name, i) => ({ label: name, from: set.offsets[i] / cellSize, to: set.offsets[i + 1] / cellSize }))
}

export const runDotplot: TrackTaskRunner = async (job) => {
  const xId = idParam(job.params, 'x')
  const yId = idParam(job.params, 'y')
  if (job.residues === undefined) {
    job.note('This session cannot read residues, so there is nothing to set against anything.')
    return []
  }
  if (xId === null || yId === null) {
    job.note('Choose the two sequence sets: one along x, one along y.')
    return []
  }
  const readerX = job.residues(xId)
  const readerY = job.residues(yId)
  if (readerX === undefined || readerY === undefined) {
    job.note('A sequence set chosen is no longer loaded. Drop the FASTA again, or pick another.')
    return []
  }
  for (const reader of [readerX, readerY]) {
    if (reader.refusal !== undefined) {
      job.note(reader.refusal)
      return []
    }
  }
  const a = sequenceSet(readerX.contigs)
  const b = sequenceSet(readerY.contigs)
  const total = a.offsets[a.offsets.length - 1]
  const w = windowFor(total)

  job.progress(0, 4, 'minimizers along x')
  const ma = minimizersOf(a, (name) => readerX.bases(name), w)
  job.throwIfCancelled()
  job.progress(1, 4, 'minimizers along y')
  const mb = minimizersOf(b, (name) => readerY.bases(name), w)
  job.throwIfCancelled()
  job.progress(2, 4, 'anchors')
  const anchors = anchorsOf(ma, mb)
  job.throwIfCancelled()
  job.progress(3, 4, 'streaks')
  // The figure counts the anchors of streaks alone: a single shared 19-mer is
  // chance as often as not, and a scatter of them is noise over the lines.
  const member = new Int32Array(anchors.count)
  const found = streaksOf(anchors, undefined, undefined, undefined, member)
  // One to one between two sets; a set against itself keeps every streak,
  // which is what it is drawn for — one to one would leave it a diagonal.
  const alone = xId === yId
  const filtered = !alone && strParam(job.params, 'streaks', 'one to one') === 'one to one'
  const keep = filtered ? oneToOne(found, a, b) : new Uint8Array(found.length).fill(1)
  const streaks = found.filter((_, i) => keep[i] === 1)
  const counted = new Uint8Array(anchors.count)
  for (let i = 0; i < anchors.count; i++) if (member[i] >= 0 && keep[member[i]] === 1) counted[i] = 1
  const cells = Math.round(numParam(job.params, 'cells', DOTPLOT_CELLS))
  const grid = densityOf(anchors, a, b, cells > 0 ? cells : DOTPLOT_CELLS, counted)
  job.progress(4, 4)

  const every = ma.count > 0 ? Math.round(total / ma.count) : 0
  const left = found.length - streaks.length
  job.note(
    `Exact ${K}-mers, one in about ${every.toLocaleString('en-US')} bases; hashes above ${MAX_OCCURRENCES} copies on either side dropped ` +
      `(${anchors.dropped.toLocaleString('en-US')} of them). ${anchors.count.toLocaleString('en-US')} anchors, ` +
      `${found.length.toLocaleString('en-US')} streaks` +
      (filtered ? `, ${streaks.length.toLocaleString('en-US')} of them one to one — ${left.toLocaleString('en-US')} a stronger streak had taken the stretch of` : '') +
      (alone ? ', every one drawn, the set against itself' : '') +
      `. Not an alignment, and it writes none: a streak is ten or more shared ${K}-mers along one diagonal.`,
  )

  // The scale clipped at the middle of the cells a line crosses — three
  // anchors or more, where chance puts one or two: a collinear stretch holds
  // thousands of anchors a cell and a short line a few dozen, and at the full
  // range the short one would be the white it is there to stand out of.
  const held: number[] = []
  for (const value of grid.values) if (Math.abs(value) >= 3) held.push(Math.abs(value))
  held.sort((p, q) => p - q)
  const clip = held.length === 0 ? 3 : Math.max(3, held[Math.floor(0.5 * (held.length - 1))])

  const matrix: MatrixOutput = {
    kind: 'matrix',
    id: 'dotplot-density',
    label: filtered ? 'Streaks one to one, the same way round (red) and the other (blue)' : 'Streaks, the same way round (red) and the other (blue)',
    nrows: grid.nrows,
    ncols: grid.ncols,
    values: grid.values,
    xLabel: 'along x',
    yLabel: 'along y',
    xTicks: [],
    yTicks: [],
    colormap: 'RdBu_r',
    centre: 0,
    range: [-clip, clip],
    xSegments: segmentsOf(a, grid.cellSize),
    ySegments: segmentsOf(b, grid.cellSize),
    stats: [
      { label: 'anchors', value: anchors.count },
      { label: filtered ? 'streaks one to one' : 'streaks', value: streaks.length },
      { label: 'bases a cell', value: grid.cellSize },
    ],
    large: true,
    streaks: linesOf(streaks, a, b, job.inputs.labels?.[xId] ?? 'along x', job.inputs.labels?.[yId] ?? 'along y'),
  }

  const rows = streaks.map((streak) => {
    const x = locate(a, streak.x0)
    const y = locate(b, streak.y0)
    return {
      xSequence: a.names[x.sequence],
      xStart: x.at,
      xEnd: x.at + (streak.x1 - streak.x0),
      ySequence: b.names[y.sequence],
      yStart: y.at,
      yEnd: y.at + (streak.y1 - streak.y0),
      strand: streak.strand === 1 ? '+' : '-',
      anchors: streak.anchors,
    }
  })
  const table: TaskOutput = {
    kind: 'table',
    id: 'dotplot-streaks',
    label: 'Streaks',
    columns: [
      { key: 'xSequence', label: 'x sequence', kind: 'text' },
      { key: 'xStart', label: 'x start', kind: 'number' },
      { key: 'xEnd', label: 'x end', kind: 'number' },
      { key: 'ySequence', label: 'y sequence', kind: 'text' },
      { key: 'yStart', label: 'y start', kind: 'number' },
      { key: 'yEnd', label: 'y end', kind: 'number' },
      { key: 'strand', label: 'strand', kind: 'text', hint: '+ the same way round, − the other' },
      { key: 'anchors', label: 'anchors', kind: 'number' },
    ],
    rows,
  }

  const pairs = new PairBuilder()
  for (const row of rows) {
    pairs.add(row.xSequence, row.xStart, row.xEnd, row.ySequence, row.yStart, row.yEnd, {
      score: row.anchors,
      name: row.strand === '+' ? 'same way round' : 'the other way round',
      detail: `${row.anchors} anchors`,
    })
  }
  const intervals: TaskOutput = {
    kind: 'intervals',
    id: 'dotplot-pairs',
    label: 'Streaks, as pairs',
    payload: { kind: 'pairs', data: pairs.finish() },
    noun: { one: 'streak', many: 'streaks' },
  }
  return [matrix, table, intervals]
}
