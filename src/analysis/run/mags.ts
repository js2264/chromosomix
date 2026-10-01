/**
 * The four metagenome runners.
 *
 * Three of them are one shape — build a bin → genome (or bin → contig) map, walk
 * the pixel table once, report — and the fourth reads a contig-level square per
 * MAG. Together in one module because they share that map-building and because
 * separating four thirty-line runners across four files would put the same six
 * lines of setup in each.
 *
 * The one thing to keep in view throughout: `__unbinned__` is not a genome
 * (§7.4). Its bins map to `-1`, and a `-1` at either end of a pixel drops that
 * pixel from every accumulation rather than counting it as an inter-MAG contact.
 * Counting it would make every real MAG look leakier in proportion to how badly
 * the rest of the file was binned, which is the opposite of a per-MAG diagnostic.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { fiedlerSplit } from '../linalg'
import {
  binContigIndex,
  binGenomeMap,
  ContigPurityAccumulator,
  GenomeContactAccumulator,
} from '../mags'
import { boolParam, numParam, strParam, type JobContext, type TaskRunner } from '../job'
import type { IntervalsOutput, MatrixOutput, TableOutput, TaskOutput } from '../types'
import { validBins } from './blocks'

/** The genomes a run may report on, and their bin extents. */
interface Layout {
  contigs: Array<{ name: string; startBin: number; bins: number; genome: number; length: number }>
  genomes: Array<{ id: number; name: string; bins: number; contigs: number }>
  allowed: Set<number>
}

function layoutOf(job: JobContext): Layout {
  const mc = job.mc
  const allowed = new Set(mc.displayGenomes())
  const lengths = mc.chromsizes
  const contigs: Layout['contigs'] = []
  const perGenome = new Map<number, { bins: number; contigs: number }>()
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    const genome = mc.contigGenomeIds[cid]
    const name = mc.chromnames[cid]
    contigs.push({
      name,
      startBin: from,
      bins: Math.max(0, to - from),
      genome,
      length: lengths.get(name) ?? (to - from) * mc.binsize,
    })
    if (!allowed.has(genome)) continue
    const held = perGenome.get(genome)
    if (held === undefined) perGenome.set(genome, { bins: to - from, contigs: 1 })
    else {
      held.bins += to - from
      held.contigs++
    }
  }
  const genomes = [...perGenome.entries()]
    .map(([id, stats]) => ({ id, name: mc.genomeNames[id], bins: stats.bins, contigs: stats.contigs }))
    .sort((a, b) => a.id - b.id)
  return { contigs, genomes, allowed }
}

/** The one warning every scanning task here owes the reader. */
function noteScoreColumn(job: JobContext): void {
  if (job.framing.value !== '' && job.framing.value !== DEFAULT_COUNT_COLUMN) {
    job.note(
      `The map is drawn from the ${job.framing.value} column, but a whole-file pass reads ` +
        `${DEFAULT_COUNT_COLUMN}. These numbers are of the counts.`,
    )
  }
}

// ---------------------------------------------------------------------------
// MAG contact QC
// ---------------------------------------------------------------------------

export const runMagQc: TaskRunner = async (job) => {
  const layout = layoutOf(job)
  if (layout.genomes.length === 0) {
    job.note('This file has no displayable genome, so there is nothing to report per MAG (§7.4).')
    return []
  }
  const balance = boolParam(job.params, 'balance', false)
  const weights = validBins(job.mc, balance)
  noteScoreColumn(job)

  const genomeOf = binGenomeMap(layout.contigs, job.mc.nBins, layout.allowed)
  const accumulator = new GenomeContactAccumulator(job.mc.nGenomes, {
    pairs: boolParam(job.params, 'network', true),
  })
  const covered = new Uint8Array(job.mc.nBins)

  job.progress(0, 1, 'reading pixels')
  await job.mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      for (let i = 0; i < chunk.length; i++) {
        const bin1 = chunk.bin1[i]
        const bin2 = chunk.bin2[i]
        const raw = chunk.count[i]
        const value = weights === null ? raw : raw * weights[bin1] * weights[bin2]
        if (!Number.isFinite(value)) continue
        covered[bin1] = 1
        covered[bin2] = 1
        accumulator.add(genomeOf[bin1], genomeOf[bin2], value)
      }
      return true
    },
    onProgress: (done, total) => job.progress(done, total, 'reading pixels'),
  })
  job.throwIfCancelled()

  const coveredPerGenome = new Int32Array(job.mc.nGenomes)
  for (let bin = 0; bin < job.mc.nBins; bin++) {
    if (covered[bin] === 1 && genomeOf[bin] >= 0) coveredPerGenome[genomeOf[bin]]++
  }

  const rows = layout.genomes.map((genome) => {
    const intra = accumulator.intra[genome.id]
    const inter = accumulator.inter[genome.id]
    const total = intra + inter
    return {
      genome: genome.name,
      contigs: genome.contigs,
      bins: genome.bins,
      covered: coveredPerGenome[genome.id],
      intra,
      inter,
      // A MAG with no contact at all has no fraction: zero of zero is not zero,
      // and sorting it to the bottom beside the genuinely leaky ones would be
      // the most misleading possible reading of no data.
      fraction: total > 0 ? intra / total : Number.NaN,
      perBin: genome.bins > 0 ? total / genome.bins : Number.NaN,
    }
  })

  const outputs: TaskOutput[] = [
    {
      kind: 'table',
      id: 'magqc',
      label: 'MAG contact QC',
      columns: [
        { key: 'genome', label: 'MAG', kind: 'text' },
        { key: 'contigs', label: 'Contigs', kind: 'number', digits: 0 },
        { key: 'bins', label: 'Bins', kind: 'number', digits: 0 },
        { key: 'covered', label: 'Bins with contact', kind: 'number', digits: 0 },
        { key: 'intra', label: 'Intra', kind: 'number', digits: 0 },
        { key: 'inter', label: 'Inter', kind: 'number', digits: 0 },
        { key: 'fraction', label: 'Intra fraction', kind: 'number', digits: 3 },
        { key: 'perBin', label: 'Contacts per bin', kind: 'number', digits: 2 },
      ],
      rows: [...rows].sort((a, b) => (b.fraction || 0) - (a.fraction || 0)),
    } satisfies TableOutput,
  ]

  if (accumulator.pairs !== null) {
    outputs.push(networkMatrix(accumulator.pairs, layout, job.mc.nGenomes))
  }
  return outputs
}

/**
 * The genome-by-genome matrix, cut down to the displayable genomes.
 *
 * `nGenomes²` over every genome in the file is the accumulator's shape, but the
 * *picture* is over the ones §7.4 allows — so it is compacted here rather than
 * drawn with an `__unbinned__` row nobody may look at.
 */
function networkMatrix(pairs: Float64Array, layout: Layout, nGenomes: number): MatrixOutput {
  const ids = layout.genomes.map((genome) => genome.id)
  const m = ids.length
  const values = new Float32Array(m * m)
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) values[r * m + c] = pairs[ids[r] * nGenomes + ids[c]]
  }
  return {
    kind: 'matrix',
    id: 'magqc-network',
    label: 'Inter-MAG contacts',
    nrows: m,
    ncols: m,
    values,
    xLabel: 'MAG',
    yLabel: 'MAG',
    // Only where the axis is short enough to read; past that the labels are a
    // grey band and the picture is the information.
    xTicks: m <= 40 ? layout.genomes.map((genome) => genome.name) : [],
    yTicks: m <= 40 ? layout.genomes.map((genome) => genome.name) : [],
    colormap: 'default',
  }
}

// ---------------------------------------------------------------------------
// Inter-MAG network
// ---------------------------------------------------------------------------

export const runMagNetwork: TaskRunner = async (job) => {
  const upstream = job.inputs.upstream?.magqc
  const matrix = upstream?.outputs.find(
    (output): output is MatrixOutput => output.kind === 'matrix' && output.id === 'magqc-network',
  )
  if (matrix === undefined) {
    throw new Error(
      'The MAG QC step produced no inter-MAG matrix. Turn its "inter-MAG matrix" option on.',
    )
  }
  const names = matrix.xTicks.length === matrix.nrows ? matrix.xTicks : null
  const m = matrix.nrows
  const mode = strParam(job.params, 'normalise', 'coverage')
  const minWeight = numParam(job.params, 'minWeight', 0)
  const maxEdges = Math.max(10, Math.round(numParam(job.params, 'maxEdges', 500)))

  const own = new Float64Array(m)
  for (let r = 0; r < m; r++) own[r] = matrix.values[r * m + r]

  // *Per bin pair* needs each MAG's size, which the matrix does not carry. It
  // is the file's, so it is read again here: `layoutOf` is a pure function of
  // the file and is what the QC pass compacted its matrix to, row for row, so
  // the two orders agree by construction — and a matrix that does not match
  // the layout is refused rather than divided by another MAG's bins.
  let bins: Float64Array | null = null
  if (mode === 'bins') {
    const layout = layoutOf(job)
    if (layout.genomes.length !== m) {
      throw new Error(
        `The MAG QC step's matrix has ${m.toLocaleString()} MAGs and this file has ` +
          `${layout.genomes.length.toLocaleString()}, so its rows cannot be matched to their bin ` +
          'counts. Run MAG contact QC again.',
      )
    }
    bins = Float64Array.from(layout.genomes, (genome) => genome.bins)
  }

  /**
   * One edge's weight, by the option the reader chose.
   *
   * *Per coverage* — the default — divides by the geometric mean of the two
   * MAGs' intra-MAG contacts, the matrix's own diagonal, so that a pair of
   * deeply sequenced MAGs and a pair of shallow ones are ranked on one scale.
   * *Per bin pair* divides by the product of their bin counts, which is how
   * many cells the contacts are spread over: a large MAG touches more of
   * everything for no reason but its size. A MAG with nothing to divide by has
   * no weight rather than an infinite one.
   */
  const weightOf = (r: number, c: number, raw: number): number => {
    if (mode === 'coverage') {
      return own[r] > 0 && own[c] > 0 ? raw / Math.sqrt(own[r] * own[c]) : Number.NaN
    }
    if (mode === 'bins' && bins !== null) {
      const cells = bins[r] * bins[c]
      return cells > 0 ? raw / cells : Number.NaN
    }
    return raw
  }

  const edges: Array<{ a: string; b: string; weight: number; raw: number }> = []
  for (let r = 0; r < m; r++) {
    for (let c = r + 1; c < m; c++) {
      const raw = matrix.values[r * m + c]
      if (!Number.isFinite(raw) || raw <= 0) continue
      const weight = weightOf(r, c, raw)
      if (!Number.isFinite(weight) || weight < minWeight) continue
      edges.push({
        a: names === null ? `MAG ${r}` : names[r],
        b: names === null ? `MAG ${c}` : names[c],
        weight,
        raw,
      })
    }
  }
  edges.sort((x, y) => y.weight - x.weight)
  if (edges.length > maxEdges) {
    job.note(`${(edges.length - maxEdges).toLocaleString()} weaker edges are not listed.`)
  }

  const table: TableOutput = {
    kind: 'table',
    id: 'magnetwork',
    // The column order `metacooler network --level genome` writes, so the two
    // are interchangeable downstream (§18.8).
    label: 'Inter-MAG edges',
    columns: [
      { key: 'a', label: 'genome1', kind: 'text' },
      { key: 'b', label: 'genome2', kind: 'text' },
      { key: 'raw', label: 'contacts', kind: 'number', digits: 0 },
      { key: 'weight', label: 'weight', kind: 'number', digits: 6 },
    ],
    rows: edges.slice(0, maxEdges),
  }
  return [table]
}

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

export const runMagPurity: TaskRunner = async (job) => {
  const layout = layoutOf(job)
  if (layout.genomes.length === 0) return []
  const balance = boolParam(job.params, 'balance', false)
  const weights = validBins(job.mc, balance)
  noteScoreColumn(job)

  const contigOf = binContigIndex(layout.contigs, job.mc.nBins)
  const genomeOfContig = Int32Array.from(
    layout.contigs.map((contig) => (layout.allowed.has(contig.genome) ? contig.genome : -1)),
  )
  const accumulator = new ContigPurityAccumulator(layout.contigs.length, genomeOfContig)

  job.progress(0, 1, 'reading pixels')
  await job.mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      for (let i = 0; i < chunk.length; i++) {
        const bin1 = chunk.bin1[i]
        const bin2 = chunk.bin2[i]
        const raw = chunk.count[i]
        const value = weights === null ? raw : raw * weights[bin1] * weights[bin2]
        accumulator.add(contigOf[bin1], contigOf[bin2], value)
      }
      return true
    },
    onProgress: (done, total) => job.progress(done, total, 'reading pixels'),
  })
  job.throwIfCancelled()
  if (accumulator.droppedPartners > 0) {
    job.note(
      `${accumulator.droppedPartners.toLocaleString()} partner observations were past the ` +
        'per-contig cap, so a few "top partner" calls are from the partners seen first.',
    )
  }

  const minContacts = numParam(job.params, 'minContacts', 10)
  const flagAbove = numParam(job.params, 'flagAbove', 0.5)
  const rows: Array<Record<string, string | number>> = []
  const flagged = new FeatureBuilder()
  const purity = new Float32Array(job.mc.nBins).fill(Number.NaN)

  for (let cid = 0; cid < layout.contigs.length; cid++) {
    const contig = layout.contigs[cid]
    if (genomeOfContig[cid] < 0) continue
    const own = accumulator.own[cid]
    const other = accumulator.other[cid]
    const total = own + other
    const outside = total > 0 ? other / total : Number.NaN
    const top = accumulator.topPartner(cid)
    const judged = total >= minContacts
    if (judged && Number.isFinite(outside)) {
      for (let bin = contig.startBin; bin < contig.startBin + contig.bins; bin++) {
        purity[bin] = 1 - outside
      }
    }
    rows.push({
      contig: contig.name,
      genome: job.mc.genomeNames[genomeOfContig[cid]],
      contacts: total,
      outside: judged ? outside : Number.NaN,
      partner: top === null ? '' : job.mc.genomeNames[top.genome],
      flagged: judged && outside > flagAbove ? 'yes' : '',
    })
    if (judged && outside > flagAbove) {
      flagged.add(contig.name, 0, contig.length, {
        score: outside,
        name: top === null ? '' : job.mc.genomeNames[top.genome],
        detail: `${(outside * 100).toFixed(1)}% of contact leaves ${job.mc.genomeNames[genomeOfContig[cid]]}`,
      })
    }
  }

  const flaggedCount = rows.filter((row) => row.flagged === 'yes').length
  job.note(
    `${flaggedCount.toLocaleString()} of ${rows.length.toLocaleString()} contigs send more than ` +
      `${(flagAbove * 100).toFixed(0)}% of their contact outside their own MAG.`,
  )

  const outputs: TaskOutput[] = [
    {
      kind: 'table',
      id: 'magpurity',
      label: 'Contig purity',
      columns: [
        { key: 'contig', label: 'Contig', kind: 'text' },
        { key: 'genome', label: 'Assigned to', kind: 'text' },
        { key: 'contacts', label: 'Contacts', kind: 'number', digits: 0 },
        { key: 'outside', label: 'Outside fraction', kind: 'number', digits: 3 },
        { key: 'partner', label: 'Top partner', kind: 'text' },
        { key: 'flagged', label: 'Flagged', kind: 'text' },
      ],
      rows: rows.sort((a, b) => Number(b.outside || 0) - Number(a.outside || 0)),
    } satisfies TableOutput,
    {
      kind: 'profile',
      id: 'magpurity-track',
      label: 'Contig purity',
      values: purity,
      extent: [0, job.mc.nBins],
      binsize: job.mc.binsize,
      unit: '',
    },
  ]
  if (flaggedCount > 0) {
    outputs.push({
      kind: 'intervals',
      id: 'magpurity-flagged',
      label: 'Contigs to look at',
      payload: { kind: 'features', data: flagged.finish() },
      noun: { one: 'contig', many: 'contigs' },
    } satisfies IntervalsOutput)
  }
  return outputs
}

// ---------------------------------------------------------------------------
// Split MAGs
// ---------------------------------------------------------------------------

export const runMagSplit: TaskRunner = async (job) => {
  const layout = layoutOf(job)
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minContigs = Math.max(2, Math.round(numParam(job.params, 'minContigs', 4)))
  const flagBelow = numParam(job.params, 'flagBelow', 0.1)

  const candidates = layout.genomes.filter((genome) => genome.contigs >= minContigs)
  if (candidates.length === 0) {
    job.note(`No MAG has ${minContigs} or more contigs, so none can be split into two blocks.`)
    return []
  }

  const rows: Array<Record<string, string | number>> = []
  const flagged = new FeatureBuilder()

  for (let i = 0; i < candidates.length; i++) {
    // Once per candidate MAG: a Fiedler split is a power iteration over a dense
    // contig matrix and hands nothing back to the event loop.
    await job.breathe()
    job.progress(i, candidates.length, candidates[i].name)
    const genome = candidates[i]
    const extent = job.mc.genomeExtent(genome.id)
    // Contig level, not bin level: the question is whether the *contigs* fall
    // into two groups, and a bin-level square of a large MAG is a hundred times
    // the cells for an answer that is the same after aggregation.
    const dense = await job.mc.matrix({
      rows: [extent[0], extent[1]],
      cols: [extent[0], extent[1]],
      balance,
      value,
    })
    const aggregated = job.mc.aggregate(dense, 'contig')
    const n = aggregated.nrows
    if (n < minContigs) continue

    const weights = new Float64Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = aggregated.values[r * n + c]
        weights[r * n + c] = Number.isFinite(cell) ? cell : 0
      }
    }
    const split = fiedlerSplit(weights, n)
    if (split === null) continue

    let within = 0
    let across = 0
    for (let r = 0; r < n; r++) {
      for (let c = r + 1; c < n; c++) {
        const cell = weights[r * n + c]
        if (split.side[r] === split.side[c]) within += cell
        else across += cell
      }
    }
    // Cross-block against within-block, so a well-connected MAG is near one and
    // two organisms sharing a bin are near zero. `within` of zero means the MAG
    // has no internal contact at all and the ratio says nothing.
    const ratio = within > 0 ? across / within : Number.NaN
    const names = job.mc.chromnames
    const contigIds: number[] = []
    for (let cid = 0; cid < layout.contigs.length; cid++) {
      if (layout.contigs[cid].genome === genome.id) contigIds.push(cid)
    }
    const sideA = contigIds.filter((_, k) => split.side[k] === 1).map((cid) => names[cid])
    const sideB = contigIds.filter((_, k) => split.side[k] === -1).map((cid) => names[cid])

    const isFlagged = Number.isFinite(ratio) && ratio < flagBelow
    rows.push({
      genome: genome.name,
      contigs: genome.contigs,
      ratio,
      sideA: sideA.length,
      sideB: sideB.length,
      flagged: isFlagged ? 'yes' : '',
    })
    if (isFlagged) {
      for (const [side, group] of [
        ['A', sideA],
        ['B', sideB],
      ] as const) {
        for (const name of group) {
          const contig = layout.contigs.find((entry) => entry.name === name)
          if (contig === undefined) continue
          flagged.add(name, 0, contig.length, {
            name: `${genome.name} · side ${side}`,
            score: ratio,
            detail: `cross-block ratio ${ratio.toFixed(4)}`,
          })
        }
      }
    }
  }
  job.progress(candidates.length, candidates.length, 'done')

  const count = rows.filter((row) => row.flagged === 'yes').length
  job.note(
    `${count.toLocaleString()} of ${rows.length.toLocaleString()} MAGs split into two blocks with ` +
      `less than ${flagBelow} of their internal contact crossing.`,
  )

  const outputs: TaskOutput[] = [
    {
      kind: 'table',
      id: 'magsplit',
      label: 'Split MAGs',
      columns: [
        { key: 'genome', label: 'MAG', kind: 'text' },
        { key: 'contigs', label: 'Contigs', kind: 'number', digits: 0 },
        { key: 'ratio', label: 'Cross-block ratio', kind: 'number', digits: 4 },
        { key: 'sideA', label: 'Side A', kind: 'number', digits: 0 },
        { key: 'sideB', label: 'Side B', kind: 'number', digits: 0 },
        { key: 'flagged', label: 'Flagged', kind: 'text' },
      ],
      rows: rows.sort((a, b) => Number(a.ratio || 1) - Number(b.ratio || 1)),
    } satisfies TableOutput,
  ]
  if (count > 0) {
    outputs.push({
      kind: 'intervals',
      id: 'magsplit-flagged',
      label: 'MAGs that look like two things',
      payload: { kind: 'features', data: flagged.finish() },
      noun: { one: 'MAG', many: 'MAGs' },
    } satisfies IntervalsOutput)
  }
  return outputs
}
