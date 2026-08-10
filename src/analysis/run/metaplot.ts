/**
 * The metaplot, run — in the annotations worker, where the tracks already are.
 *
 * The whole shape of this is set by one number: a run over five thousand
 * features at fifty base pairs a column is five thousand rows of eighty columns
 * *per track*, and that matrix must not cross a thread boundary. So the feature
 * set arrives here (it is typed arrays, and cheap), the sampling happens against
 * handles that are already open, and what goes back is a line, a band and — at
 * the reader's option — the heatmap, which is the one large thing worth sending
 * because it is the one thing that shows the average is a fair summary.
 *
 * Sampling is batched **per sequence**, not per feature. The worker's own
 * `sample` picks one zoom level for a whole request and coalesces on-disk blocks
 * across region boundaries (§8.2), so a thousand promoters on one chromosome is
 * one call and a handful of range requests rather than a thousand of each.
 */

import { DETAIL_SEP, type FeatureSet, type Region } from '../../annotations/types'
import {
  aggregate,
  axisFor,
  referenceWindows,
  scaledWindows,
  windowRow,
  type Average,
  type Layout,
  type Reference,
  type Window,
} from '../metaplot'
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
import { makeRandom } from '../random'
import type { CurveSeries, MatrixOutput, TaskOutput } from '../types'

/** One feature, flattened out of the parallel arrays a `FeatureSet` keeps. */
interface Feature {
  contig: string
  start: number
  end: number
  strand: number
  rank: number
}

/**
 * The features, with the column the reader chose to rank by.
 *
 * `score` is a real column; anything else is dug out of the `detail` string,
 * which is where both parsers put the attributes worth showing, joined with
 * `DETAIL_SEP`. That is a string scan per feature and it is why the *form* caps
 * its own discovery scan — but here every feature has to be read, because a
 * ranking over a sample of them is not a ranking.
 */
function featuresOf(set: FeatureSet, rankBy: string | null, stranded: boolean): Feature[] {
  const out: Feature[] = []
  for (let i = 0; i < set.length; i++) {
    out.push({
      contig: set.contigs[set.contig[i]],
      start: set.start[i],
      end: set.end[i],
      strand: stranded ? set.strand[i] : 1,
      rank: rankBy === null ? 0 : rankValue(set, i, rankBy),
    })
  }
  return out
}

function rankValue(set: FeatureSet, index: number, column: string): number {
  if (column === 'score') return set.score[index]
  for (const part of set.detail[index].split(DETAIL_SEP)) {
    const at = part.search(/[=:]/)
    if (at < 0) continue
    if (part.slice(0, at).trim() !== column) continue
    const value = Number.parseFloat(part.slice(at + 1).trim())
    return Number.isFinite(value) ? value : Number.NaN
  }
  return Number.NaN
}

/** The feature groups one run draws, after ranking and subsetting. */
function groupsOf(
  features: Feature[],
  params: { rankBy: string | null; subset: string; count: number; groups: number },
): Array<{ name: string; features: Feature[] }> {
  if (params.rankBy === null || params.subset === 'all') {
    return [{ name: 'all', features }]
  }
  // Descending, and features whose column could not be read go last rather than
  // being dropped: they are still features, and silently losing a third of a set
  // because a GTF spells an attribute differently is the failure this avoids.
  const sorted = [...features].sort((a, b) => {
    if (Number.isNaN(a.rank)) return Number.isNaN(b.rank) ? 0 : 1
    if (Number.isNaN(b.rank)) return -1
    return b.rank - a.rank
  })
  if (params.subset === 'top') {
    return [{ name: `top ${params.count}`, features: sorted.slice(0, params.count) }]
  }
  if (params.subset === 'bottom') {
    return [{ name: `bottom ${params.count}`, features: sorted.slice(-params.count) }]
  }
  const out: Array<{ name: string; features: Feature[] }> = []
  const size = Math.ceil(sorted.length / params.groups)
  for (let g = 0; g < params.groups; g++) {
    const slice = sorted.slice(g * size, (g + 1) * size)
    if (slice.length === 0) continue
    out.push({ name: `group ${g + 1}`, features: slice })
  }
  return out
}

export const runMetaplot: TrackTaskRunner = async (job) => {
  const entries = listParam(job.params, 'tracks')
  // By the **parameter key**, `features` — see `chosenInput`.
  const found = chosenInput(job.inputs.features, job.params, 'features')
  const set = found.value
  if (entries.length === 0 || set === undefined) {
    const noSet = missingInput(found, {
      unchosen: 'No feature set was chosen. Load a BED or a GTF and pick it under Features.',
      gone: 'The feature set chosen is no longer loaded. Re-open the file, or pick another.',
    })
    job.note(
      entries.length === 0 && noSet !== null
        ? 'A metaplot needs a track to read and a set of positions to read it at, and neither is in hand.'
        : entries.length === 0
          ? 'No track was chosen. Load a bigWig and tick it under Tracks.'
          : (noSet ?? ''),
    )
    return []
  }

  const stranded = boolParam(job.params, 'stranded', true)
  const rankBy = idParam(job.params, 'rankBy')
  const features = featuresOf(set, rankBy, stranded)
  const groups = groupsOf(features, {
    rankBy,
    subset: strParam(job.params, 'subset', 'all'),
    count: Math.max(1, Math.round(numParam(job.params, 'count', 500))),
    groups: Math.max(2, Math.round(numParam(job.params, 'groups', 4))),
  })

  const step = Math.max(1, Math.round(numParam(job.params, 'step', 50)))
  const flank = Math.max(0, Math.round(numParam(job.params, 'flank', 2000)))
  const scaled = strParam(job.params, 'mode', 'reference') === 'scaled'
  const body = Math.max(10, Math.round(numParam(job.params, 'body', 100)))
  const lengthOf = (contig: string): number => job.lengthOf(contig) ?? Number.MAX_SAFE_INTEGER

  const series: CurveSeries[] = []
  const outputs: TaskOutput[] = []
  let layout: Layout | null = null
  let firstRows: { rows: Float64Array; count: number; name: string } | null = null
  let dropped = 0

  const total = entries.length * groups.length
  let done = 0

  for (const entry of entries) {
    for (const group of groups) {
      job.throwIfCancelled()
      job.progress(done, total, `${job.inputs.labels?.[entry] ?? entry} · ${group.name}`)
      done++

      const plan = scaled
        ? scaledWindows(group.features, { body, flank, step, lengthOf })
        : { ...referenceWindows(group.features, {
            at: strParam(job.params, 'at', 'start') as Reference,
            flank,
            step,
            lengthOf,
          }), dropped: 0 }
      dropped += plan.dropped
      layout ??= plan.layout
      if (plan.windows.length === 0) continue

      const rows = await rowsFor(job, entry, plan.windows, plan.layout, step)
      const summary = aggregate(rows, plan.windows.length, plan.layout.slots, {
        average: strParam(job.params, 'average', 'mean') as Average,
        trim: 0.1,
        band: strParam(job.params, 'band', 'bootstrap') as 'none' | 'bootstrap' | 'sd',
        iterations: Math.max(20, Math.round(numParam(job.params, 'iterations', 200))),
        level: 0.95,
        rng: makeRandom(Math.round(numParam(job.params, 'seed', 1))),
      })

      // The reader's name for the file, not the store's id — a legend reading
      // `a1, a2` is a legend that has to be decoded against a panel.
      const track = job.inputs.labels?.[entry] ?? entry
      series.push({
        name: groups.length === 1 ? track : `${track} · ${group.name}`,
        x: axisFor(plan.layout).x,
        y: summary.mean,
        low: summary.low,
        high: summary.high,
        n: summary.n,
      })
      firstRows ??= { rows, count: plan.windows.length, name: series[series.length - 1].name }
    }
  }
  job.progress(total, total, 'Done')

  if (layout === null || series.length === 0) {
    job.note('No feature produced a usable window. Check that the track and the set share an assembly.')
    return []
  }
  if (dropped > 0) {
    job.note(`${dropped.toLocaleString()} features were shorter than the body width and were dropped.`)
  }

  const axis = axisFor(layout)
  outputs.push({
    kind: 'curve',
    id: 'metaplot',
    label: 'Metaplot',
    series,
    xLabel: axis.label,
    yLabel: 'Mean signal',
    xScale: 'linear',
    yScale: 'linear',
  })

  if (boolParam(job.params, 'heatmap', true) && firstRows !== null) {
    outputs.push(heatmapOf(firstRows, layout, axis.label))
  }
  return outputs
}

/**
 * Every window's row, for one track.
 *
 * Grouped by sequence before sampling, which is the whole performance story:
 * `sample` picks one zoom level per request and coalesces adjacent blocks, so a
 * thousand features on one chromosome cost one call. Regions are matched back to
 * their windows by index, since the worker drops the ones its file cannot
 * answer.
 */
async function rowsFor(
  job: TrackJobContext,
  entry: string,
  windows: Window[],
  layout: Layout,
  step: number,
): Promise<Float64Array> {
  const rows = new Float64Array(windows.length * layout.slots).fill(Number.NaN)
  const byContig = new Map<string, number[]>()
  for (let i = 0; i < windows.length; i++) {
    const held = byContig.get(windows[i].contig)
    if (held === undefined) byContig.set(windows[i].contig, [i])
    else held.push(i)
  }

  for (const [, indices] of byContig) {
    job.throwIfCancelled()
    const regions: Region[] = indices.map((i) => ({
      contig: windows[i].contig,
      start: windows[i].start,
      end: windows[i].end,
    }))
    const set = await job.sample(entry, regions, step)
    // `sample` answers in the order it was asked, having dropped what it could
    // not answer — so the reply is matched by its echoed coordinates rather than
    // by position, which would silently shift every row after the first drop.
    const byKey = new Map<string, (typeof set.regions)[number]>()
    for (const region of set.regions) byKey.set(`${region.contig}:${region.start}-${region.end}`, region)
    for (const i of indices) {
      const window = windows[i]
      const samples = byKey.get(`${window.contig}:${window.start}-${window.end}`)
      if (samples === undefined) continue
      rows.set(windowRow(samples, window, layout.slots), i * layout.slots)
    }
  }
  return rows
}

/**
 * The per-feature heatmap, sorted by its own mean.
 *
 * One track's worth — the first — rather than all of them, because a heatmap per
 * track is a wall of pictures and the reader can run the task again for another.
 * Sorted, because an unsorted heatmap of five thousand rows is a texture and a
 * sorted one is a shape: it is the picture that says whether the line above it
 * is a summary or an artefact of averaging two populations.
 */
function heatmapOf(
  held: { rows: Float64Array; count: number; name: string },
  layout: Layout,
  xLabel: string,
): MatrixOutput {
  const { rows, count } = held
  const order = Array.from({ length: count }, (_, i) => i)
  const strength = new Float64Array(count)
  for (let row = 0; row < count; row++) {
    let total = 0
    let seen = 0
    for (let slot = 0; slot < layout.slots; slot++) {
      const value = rows[row * layout.slots + slot]
      if (!Number.isFinite(value)) continue
      total += value
      seen++
    }
    strength[row] = seen === 0 ? Number.NaN : total / seen
  }
  order.sort((a, b) => {
    if (Number.isNaN(strength[a])) return Number.isNaN(strength[b]) ? 0 : 1
    if (Number.isNaN(strength[b])) return -1
    return strength[b] - strength[a]
  })

  const values = new Float32Array(count * layout.slots)
  for (let row = 0; row < count; row++) {
    for (let slot = 0; slot < layout.slots; slot++) {
      values[row * layout.slots + slot] = rows[order[row] * layout.slots + slot]
    }
  }
  return {
    kind: 'matrix',
    id: 'metaplot-heatmap',
    label: `${held.name} · per feature`,
    nrows: count,
    ncols: layout.slots,
    values,
    xLabel,
    yLabel: `Features, strongest first (${count.toLocaleString()})`,
    xTicks: [],
    yTicks: [],
    colormap: 'viridis',
  }
}
