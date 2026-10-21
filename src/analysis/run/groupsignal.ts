/**
 * Signal by group, run — in the annotations worker, beside the tracks and sets.
 *
 * Three steps. The **groups** are made: from a feature set, its intervals under
 * each label merged and cut into stretches of at most a bin, and what the set
 * does not cover as a group of its own; from a track, the bins of the assembly
 * cut by the track's sign or its quantiles. Every **track** is then read over
 * every stretch, as its exact mean over the bases it has a value for, at its
 * own resolution rather than a zoom level's. And the groups
 * are **compared**: summarised, drawn as violins, and tested by ranks pairwise
 * and together (`analysis/groupstats.ts`), every test's q-value adjusted with
 * every other's in the run (Benjamini–Hochberg).
 *
 * The assembly is `inputs.contigLengths`, which is what the tracks and the sets
 * are laid out against in this venue; a set's sequence that the assembly does
 * not have is named in a note rather than read.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import type { FeatureSet, Region, TrackSamples } from '../../annotations/types'
import { fdrCorrection } from '../chromosight'
import { coversNoMatrix } from '../cliCommand'
import { kruskalWallis, mannWhitney, quantileOf, sortedFinite, summarise } from '../groupstats'
import {
  boolParam,
  chosenInput,
  idParam,
  listParam,
  missingInput,
  numParam,
  strParam,
  type TrackJobContext,
  type TrackTaskRunner,
} from '../job'
import { quantileEdges } from '../stats'
import { GROUP_BINSIZE } from '../tasks/groupsignal'
import type { CurveOutput, IntervalsOutput, TableOutput, TaskOutput } from '../types'

/** One stretch compared: where it is, and the group it is in. */
interface Stretch {
  contig: string
  start: number
  end: number
  group: number
}

/** The groups a run compares, and the stretches that make them up. */
interface Grouping {
  names: string[]
  colours: string[]
  stretches: Stretch[]
  /** What the groups are of, for a figure's title: `A/B compartments, by name`. */
  of: string
  /** The grouping written out, for a grouping made from a track. */
  segments?: FeatureSet
}

/** A colour per group: Okabe–Ito, and the rest of the genome grey. */
const PALETTE = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9', '#f0e442', '#000000']
const REST_COLOUR = '#999999'
const REST = 'rest of the genome'

/** The most values a violin is drawn from; beyond it they are thinned evenly by rank. */
const DRAWN = 20_000

export const runGroupSignal: TrackTaskRunner = async (job) => {
  const tracks = listParam(job.params, 'tracks')
  if (tracks.length === 0) {
    job.note('No track was chosen. Load a bigWig, or run a task that makes one, and tick it under Tracks.')
    return []
  }
  const contigs: Array<{ name: string; length: number }> = []
  for (const [name, length] of Object.entries(job.inputs.contigLengths ?? {})) {
    if (length > 0) contigs.push({ name, length })
  }
  if (contigs.length === 0) {
    job.note('This session knows no sequence lengths, so there is no genome to cut into stretches. Load a chrom.sizes, or the map itself.')
    return []
  }
  // The bin size asked for; unanswered, the map's resolution where there is a
  // map, and 10 kb where there is not — as base composition reads its own.
  const asked = numParam(job.params, 'resolution', 0)
  const binsize =
    asked > 0
      ? Math.round(asked)
      : job.framing.binsize > 0 && !coversNoMatrix(job.framing)
        ? job.framing.binsize
        : GROUP_BINSIZE

  let grouping =
    strParam(job.params, 'groupBy', 'features') === 'track'
      ? await fromTrack(job, contigs, binsize)
      : fromFeatures(job, contigs, binsize)
  if (grouping === null) return []
  grouping = withoutEmpty(grouping, job)
  if (grouping.stretches.length === 0) {
    job.note('No stretch of the genome fell in any group, so there is nothing to compare.')
    return []
  }

  const labelOf = (id: string): string => job.inputs.labels?.[id] ?? id
  const k = grouping.names.length
  const summaryRows: Array<Record<string, string | number>> = []
  const testRows: Array<Record<string, string | number>> = []
  const figures: CurveOutput[] = []

  for (let t = 0; t < tracks.length; t++) {
    job.throwIfCancelled()
    const name = labelOf(tracks[t])
    job.progress(t, tracks.length, name)
    const values = await meansOver(job, tracks[t], grouping.stretches)
    const byGroup: number[][] = grouping.names.map(() => [])
    for (let i = 0; i < grouping.stretches.length; i++) {
      if (Number.isFinite(values[i])) byGroup[grouping.stretches[i].group].push(values[i])
    }
    if (byGroup.every((group) => group.length === 0)) {
      job.note(`${name} has no value over any stretch — its sequence names may not be the assembly's.`)
      continue
    }

    let all = 0
    let allSum = 0
    for (const group of byGroup) {
      for (const value of group) allSum += value
      all += group.length
    }
    for (let g = 0; g < k; g++) {
      const summary = summarise(byGroup[g])
      const others = all - summary.n
      const restMean = others > 0 ? (allSum - summary.mean * summary.n) / others : Number.NaN
      let bases = 0
      for (const stretch of grouping.stretches) {
        if (stretch.group === g) bases += stretch.end - stretch.start
      }
      summaryRows.push({
        track: name,
        group: grouping.names[g],
        n: summary.n,
        bases,
        mean: summary.mean,
        sd: summary.sd,
        median: summary.median,
        q1: summary.q1,
        q3: summary.q3,
        vsRest: summary.n > 0 ? summary.mean - restMean : Number.NaN,
      })
    }

    const kept = byGroup.map((group, g) => ({ group, g })).filter((entry) => entry.group.length > 0)
    if (kept.length > 2) {
      const test = kruskalWallis(kept.map((entry) => entry.group))
      testRows.push({
        track: name,
        test: 'Kruskal–Wallis H',
        a: `all ${kept.length} groups`,
        b: '',
        statistic: test.h,
        effect: Number.NaN,
        difference: Number.NaN,
        p: test.p,
      })
    }
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const a = kept[i]
        const b = kept[j]
        const test = mannWhitney(a.group, b.group)
        testRows.push({
          track: name,
          test: 'Mann–Whitney U',
          a: grouping.names[a.g],
          b: grouping.names[b.g],
          statistic: test.u,
          effect: test.effect,
          difference:
            quantileOf(sortedFinite(a.group), 0.5) - quantileOf(sortedFinite(b.group), 0.5),
          p: test.p,
        })
      }
    }

    figures.push({
      kind: 'curve',
      id: `groupsignal-${t + 1}`,
      label: `${name} by ${grouping.of}`,
      series: byGroup.map((group, g) => {
        const drawn = thinned(group)
        return {
          name: grouping.names[g],
          x: Float64Array.from(drawn, (_, i) => i),
          y: drawn,
          colour: grouping.colours[g],
          n: group.length,
          mark: 'violin' as const,
        }
      }),
      xLabel: grouping.of,
      yLabel: name,
      xScale: 'linear',
      yScale: 'linear',
    })
  }
  job.progress(tracks.length, tracks.length, 'done')
  if (figures.length === 0) return []

  const q = fdrCorrection(testRows.map((row) => Number(row.p)))
  testRows.forEach((row, i) => {
    row.q = q[i]
  })
  const drawnFrom = figures.some((figure) => figure.series.some((series) => (series.n ?? 0) > DRAWN))
  job.note(
    `Compared over ${grouping.stretches.length.toLocaleString()} stretches of at most ` +
      `${binsize.toLocaleString()} bp in ${k} groups, each the track's mean over the bases it has a ` +
      `value for.${drawnFrom ? ` A violin of more than ${DRAWN.toLocaleString()} is drawn from that many, evenly by rank; the tests use every one.` : ''}`,
  )

  const outputs: TaskOutput[] = [...figures]
  outputs.push({
    kind: 'table',
    id: 'groupsignal-groups',
    label: `Groups · ${grouping.of}`,
    columns: [
      { key: 'track', label: 'Track', kind: 'text' },
      { key: 'group', label: 'Group', kind: 'text' },
      { key: 'n', label: 'Stretches', kind: 'number' },
      { key: 'bases', label: 'Bases', kind: 'number' },
      { key: 'mean', label: 'Mean', kind: 'number', digits: 4 },
      { key: 'sd', label: 'SD', kind: 'number', digits: 4 },
      { key: 'median', label: 'Median', kind: 'number', digits: 4 },
      { key: 'q1', label: 'Q1', kind: 'number', digits: 4 },
      { key: 'q3', label: 'Q3', kind: 'number', digits: 4 },
      {
        key: 'vsRest',
        label: 'Mean − rest',
        kind: 'number',
        digits: 4,
        hint: 'This group’s mean less that of every other stretch.',
      },
    ],
    rows: summaryRows,
  } satisfies TableOutput)
  outputs.push({
    kind: 'table',
    id: 'groupsignal-tests',
    label: 'Between groups',
    columns: [
      { key: 'track', label: 'Track', kind: 'text' },
      { key: 'test', label: 'Test', kind: 'text' },
      { key: 'a', label: 'Group', kind: 'text' },
      { key: 'b', label: 'Against', kind: 'text' },
      { key: 'difference', label: 'Median difference', kind: 'number', digits: 4 },
      {
        key: 'effect',
        label: 'Effect',
        kind: 'number',
        digits: 3,
        hint: 'Rank-biserial r: +1 where every value of the group is above every value against it.',
      },
      { key: 'statistic', label: 'U or H', kind: 'number', digits: 2 },
      { key: 'p', label: 'P', kind: 'number', digits: 4, scientific: true },
      {
        key: 'q',
        label: 'q',
        kind: 'number',
        digits: 4,
        scientific: true,
        hint: 'Benjamini–Hochberg, over every test of the run.',
      },
    ],
    rows: testRows,
  } satisfies TableOutput)

  if (grouping.segments !== undefined) {
    outputs.push({
      kind: 'intervals',
      id: 'groupsignal-segments',
      label: `Groups · ${grouping.of}`,
      payload: { kind: 'features', data: grouping.segments },
      noun: { one: 'segment', many: 'segments' },
      display: 'lane',
      look: 'corner',
    } satisfies IntervalsOutput)
  }

  if (strParam(job.params, 'groupBy', 'features') !== 'track' && boolParam(job.params, 'perFeature', false)) {
    const perFeature = await perFeatureTable(job, tracks, labelOf)
    if (perFeature !== null) outputs.push(perFeature)
  }
  return outputs
}

// ---------------------------------------------------------------------------
// The groups
// ---------------------------------------------------------------------------

/** Groups from a feature set: what is written on each feature, and the rest. */
function fromFeatures(
  job: TrackJobContext,
  contigs: ReadonlyArray<{ name: string; length: number }>,
  binsize: number,
): Grouping | null {
  const offered = chosenInput(job.inputs.features, job.params, 'features')
  // Only a set the form chose: an input nobody picked is not one to group by.
  const found = { chosen: offered.chosen, value: offered.chosen ? offered.value : undefined }
  const set = found.value
  if (set === undefined) {
    job.note(
      missingInput(found, {
        unchosen: 'No feature set was chosen to make the groups from.',
        gone: 'The feature set chosen is no longer loaded. Re-open the file, or pick another.',
      }) ?? '',
    )
    return null
  }
  const split = strParam(job.params, 'split', 'name')
  const setName = job.inputs.labels?.[idParam(job.params, 'features') ?? ''] ?? 'the set'

  // A label per feature, and the order the groups are listed in.
  const labels: Array<string | null> = new Array(set.length).fill(null)
  let order: string[]
  if (split === 'score') {
    const k = quantileCount(job)
    const edges = quantileEdges(set.score, k)
    if (edges.length === 0) {
      job.note(`${setName} carries no scores, so it cannot be cut into quantiles of them.`)
      return null
    }
    order = Array.from({ length: k }, (_, i) => quantileName(i, edges))
    for (let i = 0; i < set.length; i++) {
      const at = bucketOf(set.score[i], edges)
      if (at >= 0) labels[i] = order[at]
    }
  } else if (split === 'strand') {
    order = ['+ strand', '− strand', 'no strand']
    for (let i = 0; i < set.length; i++) {
      labels[i] = set.strand[i] > 0 ? order[0] : set.strand[i] < 0 ? order[1] : order[2]
    }
  } else if (split === 'none') {
    order = [setName]
    labels.fill(setName)
  } else {
    for (let i = 0; i < set.length; i++) labels[i] = set.name[i] === '' ? '(no name)' : set.name[i]
    order = [...new Set(labels.filter((label): label is string => label !== null))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )
  }
  const present = order.filter((label) => labels.includes(label))
  const withRest = boolParam(job.params, 'outside', true)
  const names = withRest ? [...present, REST] : present
  const index = new Map(names.map((name, i) => [name, i]))

  // Each group's intervals per sequence, merged, and every feature's run for the rest.
  const lengthOf = (contig: string): number | undefined =>
    contigs.find((entry) => entry.name === contig)?.length ?? job.lengthOf(contig)
  const runs = new Map<string, Array<Array<[number, number]>>>()
  const unknown = new Set<string>()
  for (let cid = 0; cid < set.contigs.length; cid++) {
    const contig = set.contigs[cid]
    const length = lengthOf(contig)
    if (length === undefined) {
      if (set.contigAt[cid + 1] > set.contigAt[cid]) unknown.add(contig)
      continue
    }
    const perGroup: Array<Array<[number, number]>> = names.map(() => [])
    for (let i = set.contigAt[cid]; i < set.contigAt[cid + 1]; i++) {
      const label = labels[i]
      if (label === null) continue
      const start = Math.max(0, set.start[i])
      const end = Math.min(length, set.end[i])
      if (end > start) perGroup[index.get(label) ?? 0].push([start, end])
    }
    runs.set(contig, perGroup.map(merged))
  }
  if (unknown.size > 0) {
    job.note(
      `${[...unknown].slice(0, 6).join(', ')}${unknown.size > 6 ? ', …' : ''} ` +
        `${unknown.size === 1 ? 'is' : 'are'} not a sequence of this assembly, so ${unknown.size === 1 ? 'its' : 'their'} features were left out.`,
    )
  }

  const stretches: Stretch[] = []
  const covered = new Map<string, Array<[number, number]>>()
  for (const [contig, perGroup] of runs) {
    perGroup.forEach((intervals, g) => {
      for (const [start, end] of intervals) {
        for (const [from, to] of cut(start, end, binsize)) stretches.push({ contig, start: from, end: to, group: g })
      }
    })
    covered.set(contig, merged(perGroup.flat()))
  }
  if (withRest) {
    const rest = names.length - 1
    for (const { name, length } of contigs) {
      let from = 0
      for (const [start, end] of covered.get(name) ?? []) {
        for (const [a, b] of cut(from, start, binsize)) stretches.push({ contig: name, start: a, end: b, group: rest })
        from = Math.max(from, end)
      }
      for (const [a, b] of cut(from, length, binsize)) stretches.push({ contig: name, start: a, end: b, group: rest })
    }
  }
  const splitWord = split === 'score' ? 'score' : split === 'strand' ? 'strand' : split === 'none' ? '' : 'name'
  return {
    names,
    colours: names.map((name, i) => (name === REST ? REST_COLOUR : PALETTE[i % PALETTE.length])),
    stretches,
    of: splitWord === '' ? setName : `${setName}, by ${splitWord}`,
  }
}

/** Groups from a track: the assembly's bins, by the track's sign or its quantiles. */
async function fromTrack(
  job: TrackJobContext,
  contigs: ReadonlyArray<{ name: string; length: number }>,
  binsize: number,
): Promise<Grouping | null> {
  const entry = idParam(job.params, 'groupTrack')
  if (entry === null) {
    job.note('No track was chosen to group the bins by.')
    return null
  }
  const name = job.inputs.labels?.[entry] ?? entry
  const bins: Stretch[] = []
  for (const contig of contigs) {
    for (let start = 0; start < contig.length; start += binsize) {
      bins.push({ contig: contig.name, start, end: Math.min(contig.length, start + binsize), group: -1 })
    }
  }
  const values = await meansOver(job, entry, bins)
  const cutBy = strParam(job.params, 'cut', 'sign') === 'quantiles' ? 'quantiles' : 'sign'
  let names: string[]
  if (cutBy === 'sign') {
    names = ['above 0', 'below 0']
    for (let i = 0; i < bins.length; i++) {
      bins[i].group = values[i] > 0 ? 0 : values[i] < 0 ? 1 : -1
    }
  } else {
    const k = quantileCount(job)
    const edges = quantileEdges(values, k)
    if (edges.length === 0) {
      job.note(`${name} has no value over any bin, so there is nothing to cut into quantiles.`)
      return null
    }
    names = Array.from({ length: k }, (_, i) => quantileName(i, edges))
    for (let i = 0; i < bins.length; i++) bins[i].group = bucketOf(values[i], edges)
  }
  const stretches = bins.filter((bin) => bin.group >= 0)
  if (stretches.length < bins.length) {
    job.note(
      `${(bins.length - stretches.length).toLocaleString()} of ${bins.length.toLocaleString()} bins ` +
        `had no reading of ${name}${cutBy === 'sign' ? ', or read exactly 0,' : ''} and are in no group.`,
    )
  }

  // The grouping as intervals: consecutive bins of one group on one sequence, joined.
  const segments = new FeatureBuilder()
  let open: Stretch | null = null
  const close = (): void => {
    if (open !== null) segments.add(open.contig, open.start, open.end, { name: names[open.group] })
    open = null
  }
  for (const bin of stretches) {
    if (open !== null && open.contig === bin.contig && open.group === bin.group && open.end === bin.start) {
      open.end = bin.end
      continue
    }
    close()
    open = { ...bin }
  }
  close()
  return {
    names,
    colours: names.map((_, i) => PALETTE[i % PALETTE.length]),
    stretches,
    of: `${name}, ${cutBy === 'sign' ? 'by sign' : 'in quantiles'}`,
    segments: segments.finish(),
  }
}

/**
 * The groups that have a stretch in them, and a note naming those that do not:
 * the rest of the genome, where a compartment call covers every base, or a
 * quantile that ties left empty. A violin of nothing and a row of dashes say
 * less than the sentence does.
 */
function withoutEmpty(grouping: Grouping, job: TrackJobContext): Grouping {
  const counts = new Array<number>(grouping.names.length).fill(0)
  for (const stretch of grouping.stretches) counts[stretch.group]++
  if (counts.every((count) => count > 0)) return grouping
  const empty = grouping.names.filter((_, g) => counts[g] === 0)
  job.note(`${empty.join(', ')} had no stretch in ${empty.length === 1 ? 'it' : 'them'}, and ${empty.length === 1 ? 'is' : 'are'} left out.`)
  const kept = grouping.names.map((_, g) => g).filter((g) => counts[g] > 0)
  const renumbered = new Map(kept.map((g, i) => [g, i]))
  return {
    ...grouping,
    names: kept.map((g) => grouping.names[g]),
    colours: kept.map((g) => grouping.colours[g]),
    stretches: grouping.stretches.map((stretch) => ({ ...stretch, group: renumbered.get(stretch.group) ?? 0 })),
  }
}

function quantileCount(job: TrackJobContext): number {
  return Math.max(2, Math.min(10, Math.round(numParam(job.params, 'quantiles', 4))))
}

/** `Q2 (0.412 to 0.587)`: which quantile, and the values it spans. */
function quantileName(i: number, edges: Float64Array): string {
  const format = (value: number): string => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3))
  return `Q${i + 1} (${format(edges[i])} to ${format(edges[i + 1])})`
}

/** Which quantile a value falls in, the last edge inclusive; −1 for none. */
function bucketOf(value: number, edges: Float64Array): number {
  if (!Number.isFinite(value) || edges.length < 2) return -1
  const k = edges.length - 1
  if (value < edges[0] || value > edges[k]) return -1
  for (let i = 0; i < k; i++) if (value < edges[i + 1]) return i
  return k - 1
}

/** Intervals merged where they overlap or touch, in order. */
function merged(intervals: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

/**
 * A run cut into stretches of at most a bin, on the genome's bin grid.
 *
 * A run no longer than a bin is one stretch, whatever grid line it crosses — a
 * peak is one observation. A longer one is cut where the grid falls, and a piece
 * shorter than half a bin at either end is joined to its neighbour rather than
 * kept as a sliver whose mean is a handful of bases.
 */
export function cut(start: number, end: number, binsize: number): Array<[number, number]> {
  if (!(end > start)) return []
  if (end - start <= binsize) return [[start, end]]
  const pieces: Array<[number, number]> = []
  let from = start
  while (from < end) {
    const to = Math.min(end, (Math.floor(from / binsize) + 1) * binsize)
    pieces.push([from, to])
    from = to
  }
  if (pieces.length > 1 && pieces[0][1] - pieces[0][0] < binsize / 2) {
    pieces[1][0] = pieces[0][0]
    pieces.shift()
  }
  const last = pieces.length - 1
  if (last > 0 && pieces[last][1] - pieces[last][0] < binsize / 2) {
    pieces[last - 1][1] = pieces[last][1]
    pieces.pop()
  }
  return pieces
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * How many bases one request asks for, at most, and how many stretches.
 *
 * Every track is read **at its own resolution** — a bigWig's base-level records,
 * never a zoom level — because a stretch's value is the mean over the bases it
 * covers, and a zoom record is a mean over *its* span: read at a twentieth of a
 * stretch, a mouse ATAC-seq track's 896 bp records put the next stretch's signal
 * into this one's ends, and chr19's 10 kb stretches came out a median 0.2 % from
 * their own means, one in thirteen more than 1 %. Reading at base resolution
 * makes the read the whole file, which is what an exact mean costs; a megabase at
 * a time keeps what is held to one megabase's records, as track correlation
 * reads its own (`run/trackcorr.ts`).
 */
const CHUNK_BASES = 1 << 20
const CHUNK_STRETCHES = 4096

/**
 * A track's mean over each stretch — over the bases it has a value for, so a
 * stretch half of which the track does not cover reports the half it does —
 * each record weighted by how much of the stretch it covers: pyBigWig's
 * `stats(…, exact=True)`.
 *
 * By sequence, the stretches in order along it and read a batch at a time, and
 * matched back by the coordinates each reply echoes: `sample` drops what its
 * file cannot answer, so matching by position would shift every one after it.
 */
async function meansOver(job: TrackJobContext, entry: string, stretches: readonly Stretch[]): Promise<Float64Array> {
  const out = new Float64Array(stretches.length).fill(Number.NaN)
  const byContig = new Map<string, number[]>()
  stretches.forEach((stretch, i) => {
    const held = byContig.get(stretch.contig)
    if (held === undefined) byContig.set(stretch.contig, [i])
    else held.push(i)
  })
  for (const [contig, indices] of byContig) {
    // Each stretch once, however many groups or features share it.
    const keyed = new Map<string, Region>()
    for (const i of indices) {
      const { start, end } = stretches[i]
      keyed.set(`${start}-${end}`, { contig, start, end })
    }
    const regions = [...keyed.values()].sort((a, b) => a.start - b.start || a.end - b.end)
    const means = new Map<string, number>()
    for (let first = 0; first < regions.length; ) {
      job.throwIfCancelled()
      let last = first + 1
      let bases = regions[first].end - regions[first].start
      while (last < regions.length && last - first < CHUNK_STRETCHES) {
        bases += regions[last].end - regions[last].start
        if (bases > CHUNK_BASES) break
        last++
      }
      const sampled = await job.sample(entry, regions.slice(first, last), 1)
      for (const answer of sampled.regions) {
        means.set(`${answer.start}-${answer.end}`, clippedMean(answer, answer.start, answer.end))
      }
      first = last
    }
    for (const i of indices) {
      const mean = means.get(`${stretches[i].start}-${stretches[i].end}`)
      if (mean !== undefined) out[i] = mean
    }
  }
  return out
}

function clippedMean(answer: TrackSamples, start: number, end: number): number {
  let sum = 0
  let covered = 0
  for (let k = 0; k < answer.values.length; k++) {
    const value = answer.values[k]
    if (!Number.isFinite(value)) continue
    const from = Math.max(start, answer.starts[k])
    const to = Math.min(end, answer.ends[k])
    if (to <= from) continue
    sum += value * (to - from)
    covered += to - from
  }
  return covered > 0 ? sum / covered : Number.NaN
}

/** Every feature of the set, unmerged, with its mean on every track. */
async function perFeatureTable(
  job: TrackJobContext,
  tracks: readonly string[],
  labelOf: (id: string) => string,
): Promise<TableOutput | null> {
  const set = chosenInput(job.inputs.features, job.params, 'features').value
  if (set === undefined) return null
  const features: Stretch[] = []
  for (let i = 0; i < set.length; i++) {
    features.push({ contig: set.contigs[set.contig[i]], start: set.start[i], end: set.end[i], group: i })
  }
  const columns = tracks.map((_, t) => `track${t + 1}`)
  const rows = features.map((feature) => ({
    contig: feature.contig,
    start: feature.start,
    end: feature.end,
    name: set.name[feature.group] ?? '',
  })) as Array<Record<string, string | number>>
  for (let t = 0; t < tracks.length; t++) {
    const values = await meansOver(job, tracks[t], features)
    values.forEach((value, i) => {
      rows[i][columns[t]] = value
    })
  }
  return {
    kind: 'table',
    id: 'groupsignal-features',
    label: 'Per feature',
    columns: [
      { key: 'contig', label: 'Sequence', kind: 'text' },
      { key: 'start', label: 'Start', kind: 'number', coordinate: 'start' },
      { key: 'end', label: 'End', kind: 'number', coordinate: 'end' },
      { key: 'name', label: 'Name', kind: 'text' },
      ...tracks.map((id, t) => ({ key: columns[t], label: labelOf(id), kind: 'number' as const, digits: 4 })),
    ],
    rows,
  }
}

/** At most {@link DRAWN} of a group's values, evenly spaced by rank. */
function thinned(values: readonly number[]): Float64Array {
  const sorted = sortedFinite(values)
  if (sorted.length <= DRAWN) return sorted
  const out = new Float64Array(DRAWN)
  for (let i = 0; i < DRAWN; i++) out[i] = sorted[Math.round((i * (sorted.length - 1)) / (DRAWN - 1))]
  return out
}
