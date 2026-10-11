/**
 * Cis and trans per sequence, run.
 *
 * One pass, fed identically from the whole-file block or from the pixel table —
 * the same two roads `run/coverage.ts` takes, and for the same reason: a
 * marginal cannot be taken from one sequence's square, because a sequence's own
 * block knows nothing about the contacts leaving it and a cis fraction computed
 * from one comes out at exactly `1` everywhere.
 *
 * The arithmetic is `analysis/cistrans.ts`. What is here is which rows to show,
 * which normalisation to show them in, which of the two fractions the bars
 * stand for, and the three sentences a reader has to be told when the file does
 * not permit the whole answer.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { binContigMap } from '../coverage'
import { SequenceContactAccumulator, transExpectation } from '../cistrans'
import {
  boolParam,
  contigIdsFor,
  numParam,
  strParam,
  tickedSequences,
  type TaskRunner,
} from '../job'
import { MATRIX_SEQUENCE_LIMIT } from '../tasks/cistrans'
import type {
  CurveOutput,
  CurveSeries,
  MatrixOutput,
  TableOutput,
  TaskOutput,
} from '../types'
import { missingSequencesNote, validBins } from './blocks'

export const runCisTrans: TaskRunner = async (job) => {
  const mc = job.mc
  const balance = boolParam(job.params, 'balance', false)
  const weights = validBins(mc, balance)

  const contigs: Array<{ startBin: number; bins: number }> = []
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    contigs.push({ startBin: from, bins: Math.max(0, to - from) })
  }
  const contigOf = binContigMap(contigs, mc.nBins)
  const accumulator = new SequenceContactAccumulator(mc.nContigs)

  // Unanswered is every sequence and an empty list is nothing (§18.2): a run
  // that never met a form — a stored session, a `chromosomix` line with no
  // `--sequences` — is the whole file, and a reader who pressed **none** is
  // told so rather than handed a whole-file answer. The estimate refuses that
  // run before it is sent; this is what one that arrives anyway hears, and it
  // hears it before the pass over the pixel table rather than after it.
  const ticked = tickedSequences(job.params, 'sequences')
  if (ticked !== null && ticked.length === 0) {
    job.note('No sequence is ticked, so there is nothing to report.')
    return []
  }

  const block = job.inputs.block
  const wholeFileBlock =
    block !== undefined &&
    block.binsPerCell === 1 &&
    job.framing.balance === balance &&
    block.rowExtent[0] === 0 &&
    block.rowExtent[1] === mc.nBins &&
    block.colExtent[0] === 0 &&
    block.colExtent[1] === mc.nBins

  if (wholeFileBlock && block !== undefined) {
    job.progress(0, 1, 'summing the block on screen')
    // The block holds every off-diagonal pair twice, once at `(i, j)` and once
    // at `(j, i)`, so only the upper triangle is walked. Adding both would double
    // every trans total *and* every trans expectation, which cancels in the
    // enrichment and does not cancel in the table.
    for (let r = 0; r < block.nrows; r++) {
      job.throwIfCancelled()
      const row = r * block.ncols
      for (let c = r; c < block.ncols; c++) {
        const value = block.values[row + c]
        if (value === 0) continue
        accumulator.add(contigOf[r], contigOf[c], value)
      }
    }
  } else {
    if (job.framing.value !== '' && job.framing.value !== DEFAULT_COUNT_COLUMN) {
      job.note(
        `The map is drawn from the ${job.framing.value} column, but a whole-file pass reads ` +
          `${DEFAULT_COUNT_COLUMN}. These numbers are of the counts.`,
      )
    }
    job.progress(0, 1, 'reading pixels')
    await mc.scanPixels({
      onChunk: (chunk) => {
        job.throwIfCancelled()
        for (let i = 0; i < chunk.length; i++) {
          const bin1 = chunk.bin1[i]
          const bin2 = chunk.bin2[i]
          const raw = chunk.count[i]
          accumulator.add(
            contigOf[bin1],
            contigOf[bin2],
            weights === null ? raw : raw * weights[bin1] * weights[bin2],
          )
        }
        return true
      },
      onProgress: (done, total) => job.progress(done, total, 'reading pixels'),
    })
  }
  job.throwIfCancelled()

  if (accumulator.pairsOverflowed) {
    job.note(
      'This file has more sequence pairs with contact than the pair table holds, so the ranked ' +
        'list below is of the pairs seen first rather than of the strongest. The per-sequence ' +
        // Not *or read it as a metagenome*: this runs in a worker, which cannot
        // know whether the page shows that format (§29), and the advice is a
        // file the reader would have to make rather than a thing they can do.
        'rows are unaffected. Tick fewer sequences.',
    )
  }
  if (accumulator.dropped > 0) {
    job.note(
      `${Math.round(accumulator.dropped).toLocaleString()} contacts have an end outside every ` +
        'sequence and are left out. A bin belonging to no contig means the bin table and the ' +
        'contig table disagree about this file.',
    )
  }

  // Which rows are reported: every sequence where the run was never asked, and
  // the ticked ones this file has where it was — the pass above read the whole
  // file either way. A ticked name this file has not got is named and left out
  // (§5.9), and a list of nothing but those is said as that, not as nothing
  // ticked.
  let shown: number[]
  if (ticked === null) {
    shown = contigs.map((_contig, cid) => cid)
  } else {
    const found = contigIdsFor(mc, ticked)
    const said = missingSequencesNote(mc, found.missing, found.ids.length)
    if (said !== null) job.note(said)
    shown = found.ids
  }
  if (shown.length === 0) return []

  const rows = shown.map((cid) => {
    const cis = accumulator.cis[cid]
    const trans = accumulator.trans[cid]
    const total = cis + trans
    return {
      sequence: mc.chromnames[cid],
      bins: contigs[cid].bins,
      cis,
      trans,
      total,
      // Zero of zero is not zero: a sequence with no contact at all has no cis
      // fraction, and sorting it among the genuinely trans-heavy ones would be
      // the most misleading possible reading of no data.
      fraction: total > 0 ? cis / total : Number.NaN,
      ratio: cis > 0 ? trans / cis : Number.NaN,
      perBin: contigs[cid].bins > 0 ? total / contigs[cid].bins : Number.NaN,
    }
  })

  const outputs: TaskOutput[] = [
    {
      kind: 'table',
      id: 'cistrans',
      label: 'Cis and trans per sequence',
      columns: [
        { key: 'sequence', label: 'Sequence', kind: 'text' },
        { key: 'bins', label: 'Bins', kind: 'number', digits: 0 },
        { key: 'cis', label: 'Cis', kind: 'number', digits: 0 },
        { key: 'trans', label: 'Trans', kind: 'number', digits: 0 },
        { key: 'total', label: 'Total', kind: 'number', digits: 0 },
        {
          key: 'fraction',
          label: 'Cis fraction',
          kind: 'number',
          digits: 3,
          hint: 'Of the contacts touching this sequence, how many stay on it.',
        },
        { key: 'ratio', label: 'Trans / cis', kind: 'number', digits: 3 },
        { key: 'perBin', label: 'Contacts per bin', kind: 'number', digits: 2 },
      ],
      // In the file's own order rather than ranked, because the file's order is
      // the one the map is drawn in and this table is read beside it.
      rows,
    } satisfies TableOutput,
    fractionBars(rows, strParam(job.params, 'bars', 'cis')),
  ]

  const mode = strParam(job.params, 'normalise', 'enrichment')
  const minContacts = Math.max(0, numParam(job.params, 'minContacts', 10))
  const maxEdges = Math.max(10, Math.round(numParam(job.params, 'maxEdges', 500)))

  const expectedOf = transExpectation(accumulator.trans, accumulator.transTotal)
  const valueOf = (a: number, b: number, raw: number): number => {
    if (mode === 'raw') return raw
    if (mode === 'bins') {
      const cells = contigs[a].bins * contigs[b].bins
      return cells > 0 ? raw / cells : Number.NaN
    }
    const expected = expectedOf(a, b)
    return expected > 0 ? raw / expected : Number.NaN
  }

  const inShown = new Set(shown)
  const edges: Array<{ a: string; b: string; raw: number; value: number; expected: number }> = []
  for (const [a, b, raw] of accumulator.pairs()) {
    if (!inShown.has(a) || !inShown.has(b)) continue
    if (raw < minContacts) continue
    const value = valueOf(a, b, raw)
    if (!Number.isFinite(value)) continue
    edges.push({
      a: mc.chromnames[a],
      b: mc.chromnames[b],
      raw,
      value,
      expected: expectedOf(a, b),
    })
  }
  edges.sort((x, y) => y.value - x.value)

  if (edges.length > 0) {
    outputs.push({
      kind: 'table',
      id: 'cistrans-pairs',
      label:
        mode === 'enrichment'
          ? 'Sequence pairs, against indifference'
          : 'Sequence pairs, ranked',
      columns: [
        { key: 'a', label: 'Sequence', kind: 'text' },
        { key: 'b', label: 'Sequence', kind: 'text' },
        { key: 'raw', label: 'Contacts', kind: 'number', digits: 0 },
        ...(mode === 'enrichment'
          ? [
              {
                key: 'expected',
                label: 'Expected',
                kind: 'number' as const,
                digits: 1,
                hint: 'From the two sequences’ own trans coverage, under indifference.',
              },
            ]
          : []),
        {
          key: 'value',
          label:
            mode === 'raw' ? 'Contacts' : mode === 'bins' ? 'Per bin pair' : 'Observed / expected',
          kind: 'number',
          digits: mode === 'raw' ? 0 : mode === 'bins' ? 5 : 2,
        },
      ],
      rows: edges.slice(0, maxEdges),
    } satisfies TableOutput)
    if (edges.length > maxEdges) {
      job.note(
        `${edges.length.toLocaleString()} sequence pairs pass the threshold and the strongest ` +
          `${maxEdges.toLocaleString()} are listed. Raise “pairs to list” to see more.`,
      )
    }
  }

  if (boolParam(job.params, 'matrix', true)) {
    if (shown.length > MATRIX_SEQUENCE_LIMIT) {
      job.note(
        `${shown.length.toLocaleString()} sequences is past the ` +
          `${MATRIX_SEQUENCE_LIMIT.toLocaleString()} this draws a square for, so the ranked ` +
          'table above is the answer. Tick fewer sequences for the picture.',
      )
    } else {
      const m = shown.length
      const values = new Float32Array(m * m)
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) {
          const a = shown[r]
          const b = shown[c]
          // The diagonal is the sequence's own cis contact, which is a different
          // quantity from every other cell and is left out rather than drawn: on
          // any real map it is one to three orders of magnitude above the trans
          // cells, so including it sets the colour scale and turns the square
          // into a picture of its own diagonal.
          values[r * m + c] = a === b ? Number.NaN : valueOf(a, b, accumulator.pair(a, b))
        }
      }
      const ticks = m <= 40 ? shown.map((cid) => mc.chromnames[cid]) : []
      outputs.push({
        kind: 'matrix',
        id: 'cistrans-matrix',
        label:
          mode === 'enrichment'
            ? 'Between sequences, against indifference'
            : 'Between sequences',
        nrows: m,
        ncols: m,
        values,
        xLabel: 'Sequence',
        yLabel: 'Sequence',
        xTicks: ticks,
        yTicks: ticks,
        colormap: mode === 'enrichment' ? 'RdBu_r' : 'default',
        ...(mode === 'enrichment' ? { centre: 1 } : {}),
      } satisfies MatrixOutput)
    }
  }

  return outputs
}

/** What the bars read off the per-sequence table; structurally its rows. */
interface SequenceRow {
  sequence: string
  cis: number
  trans: number
  total: number
}

/** The stack the two fractions share, where the reader asked for both. */
const CONTACT_STACK = 'contacts'

/**
 * The per-sequence fractions, as one bar per sequence.
 *
 * The numbers are the table's own and the picture is the point. A column
 * reading `0.994, 0.991, 0.987, 0.612, 0.989` is a list a reader has to scan
 * and subtract; the same numbers as bars in the file's order put the one
 * sequence that is a third trans a head below its neighbours before anybody has
 * read a digit — and on a metagenome, where the table is four thousand rows
 * long, that is the difference between a record and an answer.
 *
 * **Fractions rather than counts**, and that is the whole of why this is worth
 * drawing. A bar of each sequence's cis *contacts* is a picture of how long the
 * sequences are: chromosome I gets a stub and chromosome IV a tower, on any file
 * whatever, because a longer sequence holds more of everything. Dividing by what
 * the sequence has in total takes the length back out and leaves the quantity
 * the task is named for, which is comparable from one sequence to the next and
 * from one library to the next.
 *
 * A sequence with no contact at all gets a **gap**, not a zero bar: zero of zero
 * is not zero, which is the same rule its row in the table keeps.
 *
 * And there is no ceiling on the number of bars, unlike the square
 * ({@link MATRIX_SEQUENCE_LIMIT}). A square goes from a picture to a grey band
 * because its cells shrink in both directions at once; a row of four thousand
 * bars is a silhouette of the same shape, still read the same way, and the mark
 * control turns it into the line that silhouette already is.
 */
function fractionBars(rows: readonly SequenceRow[], which: string): CurveOutput {
  // Each half against the sequence's own total rather than one of them against
  // `1 - other`: the two are the same number to within a float, and computing
  // one by subtraction would hand a sequence with no contact a fraction of 1.
  const share = (part: number, total: number): number =>
    total > 0 ? part / total : Number.NaN
  // One abscissa for both series rather than two copies of it: they are the same
  // bars, and the worker's transfer list already expects two views of one buffer
  // (`worker/protocol.analysisTransfers`, which a profile and its extent share).
  const at = Float64Array.from(rows, (_row, index) => index)
  const both = which === 'both'
  const cis: CurveSeries = {
    name: 'cis',
    x: at,
    y: Float64Array.from(rows, (row) => share(row.cis, row.total)),
    mark: 'bars',
    ...(both ? { stack: CONTACT_STACK } : {}),
  }
  const trans: CurveSeries = {
    name: 'trans',
    x: at,
    y: Float64Array.from(rows, (row) => share(row.trans, row.total)),
    mark: 'bars',
    ...(both ? { stack: CONTACT_STACK } : {}),
  }
  return {
    kind: 'curve',
    id: 'cistrans-fractions',
    label: both
      ? 'Cis and trans fraction per sequence'
      : which === 'trans'
        ? 'Trans fraction per sequence'
        : 'Cis fraction per sequence',
    series: both ? [cis, trans] : [which === 'trans' ? trans : cis],
    xLabel: 'Sequence',
    // Per cent, which is how §26.2 has a fraction said on a surface that
    // summarises it; the values behind the axis stay fractions, so the TSV holds
    // the `0.994` the table holds.
    yLabel: 'Share of the sequence’s contacts (%)',
    xScale: 'linear',
    yScale: 'linear',
    // The whole of a fraction, rather than the part these fractions happen to
    // occupy. Fitted, an axis over `0.987` to `0.994` draws seven parts in a
    // thousand as the height of the picture and two libraries that agree as two
    // that do not — and it would put each run of this task against a ceiling of
    // its own. A default like every other declared window (§18.7): the marquee
    // and the boxes still move it.
    yDomain: [0, 1],
    // The sequences, in the file's own order, from where every other output
    // takes them. One name per bar, so the axis names the bar under the pointer
    // rather than counting them.
    xTicks: rows.map((row) => row.sequence),
  }
}
