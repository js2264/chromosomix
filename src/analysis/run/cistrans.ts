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
 * which normalisation to show them in, and the three sentences a reader has to
 * be told when the file does not permit the whole answer.
 */

import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { binContigMap } from '../coverage'
import { SequenceContactAccumulator, transExpectation } from '../cistrans'
import { boolParam, contigIdsFor, listParam, numParam, strParam, type TaskRunner } from '../job'
import { MATRIX_SEQUENCE_LIMIT } from '../tasks/cistrans'
import type { MatrixOutput, TableOutput, TaskOutput } from '../types'
import { validBins } from './blocks'

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
    job.progress(0, 1, 'Summing the block on screen')
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
    job.progress(0, 1, 'Reading pixels')
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
      onProgress: (done, total) => job.progress(done, total, 'Reading pixels'),
    })
  }
  job.throwIfCancelled()

  if (accumulator.pairsOverflowed) {
    job.note(
      'This file has more sequence pairs with contact than the pair table holds, so the ranked ' +
        'list below is of the pairs seen first rather than of the strongest. The per-sequence ' +
        'rows are unaffected. Tick fewer sequences, or read this one as a metagenome.',
    )
  }
  if (accumulator.dropped > 0) {
    job.note(
      `${Math.round(accumulator.dropped).toLocaleString()} contacts have an end outside every ` +
        'sequence and are left out. A bin belonging to no contig means the bin table and the ' +
        'contig table disagree about this file.',
    )
  }

  // Empty is every sequence, which is what the form resolves an unanswered
  // picker to (§18.8's *a whole-sequence picker is left empty rather than seeded
  // from the framing*). A reader who pressed **None** gets the note rather than a
  // silent whole-file answer.
  const names = listParam(job.params, 'sequences')
  let shown: number[]
  if (names.length === 0) {
    shown = contigs.map((_contig, cid) => cid)
  } else {
    const found = contigIdsFor(mc, names)
    if (found.missing.length > 0 && found.missing.length < names.length) {
      job.note(
        `${found.missing.length.toLocaleString()} ticked sequence` +
          `${found.missing.length === 1 ? ' is' : 's are'} not in this file and ` +
          `${found.missing.length === 1 ? 'is' : 'are'} left out: ` +
          `${found.missing.slice(0, 6).join(', ')}${found.missing.length > 6 ? ', …' : ''}.`,
      )
    }
    shown = found.ids
  }
  if (shown.length === 0) {
    job.note('No sequence is ticked, so there is nothing to report.')
    return []
  }

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
          `${maxEdges.toLocaleString()} are listed. Raise *Pairs to list* to see more.`,
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
