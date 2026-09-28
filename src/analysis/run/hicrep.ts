/**
 * Reproducibility between the maps on screen, run.
 *
 * The arithmetic is `analysis/hicrep.ts`. What is here is the read, and the read
 * is the whole of why this is affordable: a stratified correlation needs the
 * cells within `maxDistance` of the diagonal and **nothing else**, which is a
 * band rather than a square — the same shape insulation and the pattern detector
 * already read, and the reason a mammalian chromosome is a few dozen bounded
 * reads instead of a refusal on size.
 *
 * ## The order of the loops, and what it costs
 *
 * Sequences outermost, maps innermost. Every map's strata for **one** sequence
 * are held at once, because an N×N coefficient matrix needs all of them
 * together; nothing holds a second sequence. So the memory is
 * `maps × strata × bins` and not `maps × strata × genome`, which is the
 * difference between forty megabytes and a gigabyte on a human assembly.
 *
 * The peers are opened once for the whole run rather than once per sequence —
 * mounting a remote cooler is a metadata walk §12 budgets at twenty requests,
 * and paying that per chromosome would be most of the run. They are closed in a
 * `finally`, because a cancelled job must not leave three files mounted in a
 * worker that goes on living.
 */

import { contigIdFor, listParam, numParam, boolParam, type JobContext, type TaskRunner } from '../job'
import { emptyStrata, smoothTileInto, stratumAdjusted, type Strata } from '../hicrep'
import { strataOf } from '../tasks/hicrep'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import type { MetaCooler } from '../../metacooler/MetaCooler'
import type { CurveOutput, MatrixOutput, TableOutput, TaskOutput } from '../types'
import { forEachDiagonalTile, usableBlock, type Span } from './blocks'

/** One map in the comparison, with the name the figure calls it. */
interface Compared {
  label: string
  mc: MetaCooler
  /** Whether this one is the mounted map, which is never closed here. */
  lead: boolean
  close?: () => void
}

export const runHicrep: TaskRunner = async (job) => {
  const peers = job.inputs.peers ?? []
  if (peers.length === 0) {
    job.note(
      'No second map is open. Press + along the edge of the map to open a cell beside it, and ' +
        'drop another file in.',
    )
    return []
  }
  if (job.peer === undefined) {
    throw new Error(
      'Reproducibility reads a second file, and this venue cannot open one. Run it in the app, ' +
        'or with `metacooler-run hicrep <file> --against <other>`.',
    )
  }

  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const h = Math.max(0, Math.round(numParam(job.params, 'smooth', 1)))
  const maxK = strataOf(job.params)

  // Named as the reader names it (§16.10), like the peers beside it: a batch
  // runs this once per map, and a table that called each run's own map *This
  // map* named a different map by the same words in every run.
  const maps: Compared[] = [{ label: job.inputs.mapLabel ?? 'This map', mc: job.mc, lead: true }]
  try {
    for (let i = 0; i < peers.length; i++) {
      job.progress(i, peers.length, `opening ${peers[i].label}`)
      const opened = await job.peer(peers[i])
      // **Refused by name, not compared anyway.** A stratum is a diagonal offset
      // in bins, so the k-th diagonal of a 1 kb map and a 5 kb map are two
      // different separations — and §16's lock is in base pairs precisely so a
      // deck may hold both. Comparing them would report a low coefficient that
      // reads as a biological difference.
      if (opened.mc.binsize !== job.mc.binsize) {
        job.note(
          `${peers[i].label} is at ${opened.mc.binsize?.toLocaleString() ?? '?'} bp and this map ` +
            `is at ${job.mc.binsize.toLocaleString()} bp, so their strata are different ` +
            'separations and they are left out. Open them at one resolution.',
        )
        opened.close()
        continue
      }
      maps.push({ label: peers[i].label, mc: opened.mc, lead: false, close: opened.close })
    }
    if (maps.length < 2) {
      job.note('No map beside this one could be compared with it, so there is nothing to report.')
      return []
    }
    return await compare(job, maps, { balance, value, h, maxK })
  } finally {
    for (const map of maps) map.close?.()
  }
}

async function compare(
  job: JobContext,
  maps: Compared[],
  options: { balance: boolean; value: string; h: number; maxK: number },
): Promise<TaskOutput[]> {
  const { balance, value, h, maxK } = options

  const wanted = listParam(job.params, 'sequences')
  const chosen: number[] = []
  if (wanted.length === 0) {
    for (let cid = 0; cid < job.mc.nContigs; cid++) chosen.push(cid)
  } else {
    for (const name of wanted) {
      const cid = contigIdFor(job.mc, name)
      if (cid >= 0) chosen.push(cid)
    }
  }
  if (chosen.length === 0) {
    job.note('No sequence is ticked, so there is nothing to compare over.')
    return []
  }

  const n = maps.length
  // Pooled across sequences by the same weights the strata are pooled by, which
  // is what makes the genome-wide number a weighted mean of the per-sequence
  // ones rather than an unweighted average over chromosomes of wildly different
  // length. A mean of per-chromosome coefficients gives a 200 kb contig the same
  // say as chromosome 1, which on a metagenome is every contig.
  const pooledWeighted = new Float64Array(n * n)
  const pooledWeights = new Float64Array(n * n)
  const perSequence: Array<Record<string, string | number>> = []
  // Summed across sequences so the curve is one line per pair rather than one
  // per pair per chromosome.
  const strataWeighted: Float64Array[] = []
  const strataWeights: Float64Array[] = []
  for (let p = 0; p < (n * (n - 1)) / 2; p++) {
    strataWeighted.push(new Float64Array(maxK + 1))
    strataWeights.push(new Float64Array(maxK + 1))
  }

  // The view's block, where it honestly covers what is being read — and for the
  // **lead only**, because the block on screen is one panel's pixels and the
  // peers are other files (`AnalysisRunner`'s own note about a deck sharing one
  // block makes the same point one layer up).
  const leadBlock = usableBlock(
    job,
    chosen.map((cid) => spanOf(job.mc, cid)),
    balance,
  )

  for (let at = 0; at < chosen.length; at++) {
    await job.breathe()
    const cid = chosen[at]
    const name = job.mc.chromnames[cid]
    job.progress(at, chosen.length, name)
    const span = spanOf(job.mc, cid)
    const bins = span.to - span.from
    if (bins < 3) continue

    // One sequence, every map. Held together because the coefficient matrix
    // needs them together, and freed before the next sequence is read.
    const strata: Strata[] = []
    let missing = false
    for (const map of maps) {
      const theirs = map.lead ? span : spanIn(map.mc, name)
      if (theirs === null) {
        missing = true
        break
      }
      if (theirs.to - theirs.from !== bins) {
        // Same name, different length: two assemblies that share a chromosome's
        // name and not its sequence. Left out with a sentence rather than
        // compared over whichever is shorter.
        job.note(
          `${name} is ${bins.toLocaleString()} bins here and ` +
            `${(theirs.to - theirs.from).toLocaleString()} in ${map.label}, so it is left out.`,
        )
        missing = true
        break
      }
      strata.push(
        await stratifyOne(job, map, theirs, {
          balance,
          value,
          h,
          maxK: Math.min(maxK, bins - 1),
          bins,
          block: map.lead ? leadBlock : null,
        }),
      )
    }
    if (missing) continue

    let pair = 0
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const result = stratumAdjusted(strata[a], strata[b])
        const key = a * n + b
        for (const stratum of result.strata) {
          // Pooled as each sequence's own number is: a stratum with no
          // correlation counts as zero, with its weight.
          pooledWeighted[key] += stratum.weight * (Number.isFinite(stratum.r) ? stratum.r : 0)
          pooledWeights[key] += stratum.weight
          // The curve is the correlation *at* each separation, so a stratum that
          // has none is left out of it rather than drawn as a zero.
          if (!Number.isFinite(stratum.r)) continue
          strataWeighted[pair][stratum.k] += stratum.weight * stratum.r
          strataWeights[pair][stratum.k] += stratum.weight
        }
        perSequence.push({
          sequence: name,
          a: maps[a].label,
          b: maps[b].label,
          scc: result.scc,
          strata: result.strata.length,
        })
        pair++
      }
    }
  }
  job.progress(chosen.length, chosen.length, 'done')
  job.throwIfCancelled()

  const values = new Float32Array(n * n)
  for (let a = 0; a < n; a++) {
    values[a * n + a] = 1
    for (let b = a + 1; b < n; b++) {
      const key = a * n + b
      const scc = pooledWeights[key] > 0 ? pooledWeighted[key] / pooledWeights[key] : Number.NaN
      values[a * n + b] = scc
      values[b * n + a] = scc
    }
  }

  const labels = maps.map((map) => map.label)
  const outputs: TaskOutput[] = [
    {
      kind: 'matrix',
      id: 'hicrep',
      label: 'Stratum-adjusted correlation',
      nrows: n,
      ncols: n,
      values,
      xLabel: '',
      yLabel: '',
      xTicks: labels,
      yTicks: labels,
      colormap: 'RdBu_r',
      // A correlation is read about no-agreement, and `[0, 1]` is fixed rather
      // than fitted so that two runs on two pairs of files are the same picture
      // where they are the same result.
      range: [0, 1],
      stats: [{ label: 'sequences', value: chosen.length, digits: 0 }],
      // Every map against every other, whichever map this run was about — so
      // the all-maps tab shows it once rather than once per map (§18.7).
      acrossMaps: true,
    } satisfies MatrixOutput,
  ]

  const pooledRows: Array<Record<string, string | number>> = []
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      pooledRows.push({
        a: labels[a],
        b: labels[b],
        scc: values[a * n + b],
      })
    }
  }
  outputs.push({
    kind: 'table',
    id: 'hicrep-pairs',
    label: 'Pooled over every sequence',
    columns: [
      { key: 'a', label: 'Map', kind: 'text' },
      { key: 'b', label: 'Map', kind: 'text' },
      {
        key: 'scc',
        label: 'SCC',
        kind: 'number',
        digits: 4,
        hint: 'Every stratum of every sequence, each weighted by the positions it compares.',
      },
    ],
    rows: pooledRows.sort((x, y) => Number(y.scc) - Number(x.scc)),
    acrossMaps: true,
  } satisfies TableOutput)

  if (perSequence.length > 0) {
    outputs.push({
      kind: 'table',
      id: 'hicrep-sequences',
      label: 'Per sequence',
      columns: [
        { key: 'sequence', label: 'Sequence', kind: 'text' },
        { key: 'a', label: 'Map', kind: 'text' },
        { key: 'b', label: 'Map', kind: 'text' },
        { key: 'scc', label: 'SCC', kind: 'number', digits: 4 },
        { key: 'strata', label: 'Strata', kind: 'number', digits: 0 },
      ],
      rows: perSequence,
      acrossMaps: true,
    } satisfies TableOutput)
  }

  // The figure that says more than the scalar does: *where* two maps stop
  // agreeing. Short-range agreement with long-range disagreement is a depth
  // difference; disagreement everywhere is two different experiments.
  const series = []
  let pair = 0
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const x = new Float64Array(maxK + 1)
      const y = new Float64Array(maxK + 1)
      for (let k = 0; k <= maxK; k++) {
        x[k] = job.toBp(k)
        y[k] =
          strataWeights[pair][k] > 0
            ? strataWeighted[pair][k] / strataWeights[pair][k]
            : Number.NaN
      }
      series.push({ name: `${labels[a]} vs ${labels[b]}`, x, y })
      pair++
    }
  }
  if (series.length > 0) {
    outputs.push({
      kind: 'curve',
      id: 'hicrep-strata',
      label: 'Correlation by separation',
      series,
      xLabel: 'Genomic separation (bp)',
      yLabel: 'Pearson r on that stratum',
      xScale: 'log',
      yScale: 'linear',
      yDomain: [-0.2, 1],
      acrossMaps: true,
    } satisfies CurveOutput)
  }

  return outputs
}

/** One map's smoothed strata for one sequence. */
async function stratifyOne(
  job: JobContext,
  map: Compared,
  span: Span,
  options: {
    balance: boolean
    value: string
    h: number
    maxK: number
    bins: number
    block: Parameters<typeof forEachDiagonalTile>[2]['block']
  },
): Promise<Strata> {
  const into = emptyStrata(options.bins, options.maxK)
  // **The kernel's whole reach**, which is the band plus the filter: a cell on
  // the `maxK`-th diagonal is smoothed from cells `h` further out still, so a
  // halo of `maxK` alone would smooth the outermost stratum from a window that
  // is half outside the tile.
  const halo = options.maxK + options.h
  // A shim rather than a second reader: `forEachDiagonalTile` needs a job only
  // for its `mc` and its cancellation, and handing it one pointing at the peer
  // is what lets the two maps be read by one piece of code.
  const shim: JobContext = map.lead ? job : { ...job, mc: map.mc }
  await forEachDiagonalTile(
    shim,
    span,
    { halo, block: options.block, balance: options.balance, value: options.value },
    (tile) => {
      job.throwIfCancelled()
      smoothTileInto(tile, options.h, options.maxK, into)
    },
  )
  return into
}

function spanOf(mc: MetaCooler, cid: number): Span {
  const [from, to] = mc.contigExtent(cid)
  return { from, to }
}

/** The same sequence in another file, resolved by name (§5.9), or `null`. */
function spanIn(mc: MetaCooler, name: string): Span | null {
  const cid = contigIdFor(mc, name)
  return cid < 0 ? null : spanOf(mc, cid)
}
