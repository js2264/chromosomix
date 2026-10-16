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
  standardiseTrack,
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

  // Off unless asked for, and read forgivingly like every other parameter: a
  // session stored before this option existed has no `zscore` key at all, and
  // must come back as the figure it was rather than as an error (`analysis/job.ts`).
  const zscore = boolParam(job.params, 'zscore', false)

  const step = Math.max(1, Math.round(numParam(job.params, 'step', 50)))
  const flank = Math.max(0, Math.round(numParam(job.params, 'flank', 2000)))
  const scaled = strParam(job.params, 'mode', 'reference') === 'scaled'
  const body = Math.max(10, Math.round(numParam(job.params, 'body', 100)))
  const lengthOf = (contig: string): number => job.lengthOf(contig) ?? Number.MAX_SAFE_INTEGER

  // **Planned once, and read by every track.** A plan depends on the group's
  // features and on the window shape and on nothing whatever about the file
  // being read, so building one inside the track loop re-did the same work —
  // and, worse, added the same `dropped` count once per ticked track. Three
  // bigWigs over a set of a thousand with forty features under the body width
  // reported a hundred and twenty dropped: a number the reader cannot arrive at
  // from the set in front of them, out of a note whose whole job
  // (`analysis/job.ts`) is to be arrived at.
  const plans = groups.map((group) =>
    scaled
      ? scaledWindows(group.features, { body, flank, step, lengthOf })
      : {
          ...referenceWindows(group.features, {
            at: strParam(job.params, 'at', 'start') as Reference,
            flank,
            step,
            lengthOf,
          }),
          dropped: 0,
        },
  )
  const dropped = plans.reduce((count, plan) => count + plan.dropped, 0)

  const series: CurveSeries[] = []
  const outputs: TaskOutput[] = []
  const layout: Layout | null = plans.length === 0 ? null : plans[0].layout
  const heatmap = boolParam(job.params, 'heatmap', true)
  // Every curve's rows, for its heatmap, and each group's features' strength
  // summed over every track: the heatmaps share one order (`orderOf`).
  const held: HeldRows[] = []
  const strength = plans.map((plan) => ({
    total: new Float64Array(plan.windows.length),
    seen: new Float64Array(plan.windows.length),
  }))

  const total = entries.length * groups.length
  let done = 0

  for (const entry of entries) {
    // **Every group of this track is read before any of them is summarised**,
    // which is a shape the z-score forces. Standardising is per *track* and over
    // the union of its groups (see `standardiseTrack`), so the mean and the SD
    // are not known until the last group has been sampled — and a loop that
    // aggregated each group as it read it could only have standardised each
    // group against itself, which is the one thing the option must not do.
    //
    // The cost is that one track's group rows are held at once rather than one
    // at a time. They partition a single feature set between them, so that is
    // one feature set's worth of rows for one track — the same thing each
    // heatmap keeps, in single precision, for the rest of the run — and the
    // tracks are still read one after another rather than all together.
    const built: Array<{ group: number; rows: Float64Array; count: number; layout: Layout }> = []
    for (const [index, group] of groups.entries()) {
      job.throwIfCancelled()
      job.progress(done, total, `${job.inputs.labels?.[entry] ?? entry} · ${group.name}`)
      done++

      const plan = plans[index]
      if (plan.windows.length === 0) continue

      built.push({
        group: index,
        rows: await rowsFor(job, entry, plan.windows, plan.layout, step),
        count: plan.windows.length,
        layout: plan.layout,
      })
    }

    // In place, and on purpose. The heatmap below is copied from the very array
    // handed to `aggregate`, after this — so standardising a copy would put a
    // heatmap of raw values under a curve of z-scores, two pictures of one run
    // disagreeing about what was measured. The heatmap shows what the curve
    // shows. With the option off nothing here runs at all.
    //
    // Before `aggregate`, which is also before the bootstrap it draws from: the
    // band has to be an interval on the standardised values, not a raw interval
    // rescaled afterwards.
    if (zscore) standardiseTrack(built.map((one) => one.rows))

    for (const one of built) {
      const summary = aggregate(one.rows, one.count, one.layout.slots, {
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
      const name = groups.length === 1 ? track : `${track} · ${groups[one.group].name}`
      series.push({
        name,
        x: axisFor(one.layout).x,
        y: summary.mean,
        low: summary.low,
        high: summary.high,
        n: summary.n,
      })
      if (heatmap) {
        addStrength(strength[one.group], one.rows, one.count, one.layout.slots)
        // Single precision, which is what the heatmap is drawn and written in,
        // and half of what holding every track's rows to the end would cost.
        held.push({ group: one.group, rows: Float32Array.from(one.rows), count: one.count, name })
      }
    }
  }
  job.progress(total, total, 'done')

  if (layout === null || series.length === 0) {
    job.note('No feature produced a usable window. Check that the track and the set share an assembly.')
    return []
  }
  if (dropped > 0) {
    // Both of the reasons `scaledWindows` drops one, because a reader counting
    // the short features in their own set has to be able to arrive at this
    // number: most are under the body width, but a feature whose flanks leave
    // it no columns at the edge of a sequence is dropped here too.
    job.note(
      `${dropped.toLocaleString()} features were dropped: shorter than the body width, or with no window left after clipping to the sequence.`,
    )
  }

  const axis = axisFor(layout)
  outputs.push({
    kind: 'curve',
    id: 'metaplot',
    label: 'Metaplot',
    series,
    xLabel: axis.label,
    // A y axis still reading *Mean signal* over standardised rows would name a
    // unit the numbers are no longer in — the one lie a relabelled axis is for.
    yLabel: zscore ? 'Signal (z-score, per track)' : 'Mean signal',
    xScale: 'linear',
    yScale: 'linear',
  })

  const orders = held.length === 0 ? [] : strength.map(orderOf)
  const run = { zscore, tracks: entries.length }
  held.forEach((one, index) => {
    outputs.push(heatmapOf(one, orders[one.group], index, layout, axis.label, run))
  })
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
    // **Each stretch asked for once.** Features that share an anchor share a
    // window — the transcripts of a gene that start at one TSS, a fifth of the
    // RefSeq set — and a stretch asked for twice is read, parsed and handed back
    // twice for the same numbers. The reply is matched by coordinates below, so
    // every feature finds its stretch whichever of them asked.
    const asked = new Set<string>()
    const regions: Region[] = []
    for (const i of indices) {
      const window = windows[i]
      const key = `${window.start}-${window.end}`
      if (asked.has(key)) continue
      asked.add(key)
      regions.push({ contig: window.contig, start: window.start, end: window.end })
    }
    const set = await job.sample(entry, regions, step)
    // `sample` answers in the order it was asked, having dropped what it could
    // not answer — so the reply is matched by its echoed coordinates rather than
    // by position, which would silently shift every row after the first drop.
    const byKey = new Map<string, (typeof set.regions)[number]>()
    for (const region of set.regions) byKey.set(`${region.contig}:${region.start}-${region.end}`, region)
    // And each row made once: a window the same as one already done — same
    // stretch, strand and columns, and same body where it has one — is that
    // row again, copied.
    const done = new Map<string, number>()
    for (const i of indices) {
      const window = windows[i]
      const samples = byKey.get(`${window.contig}:${window.start}-${window.end}`)
      if (samples === undefined) continue
      const { body } = window
      const key =
        `${window.start}-${window.end}:${window.strand}:${window.slotFrom}-${window.slotTo}` +
        (body === undefined ? '' : `:${body.start}-${body.end}:${body.slotFrom}-${body.slotTo}`)
      const same = done.get(key)
      if (same !== undefined) {
        rows.copyWithin(i * layout.slots, same * layout.slots, (same + 1) * layout.slots)
        continue
      }
      done.set(key, i)
      rows.set(windowRow(samples, window, layout.slots), i * layout.slots)
    }
  }
  return rows
}

/**
 * The colour range the per-feature heatmap is drawn between.
 *
 * **Clipped at the 99th percentile**, not fitted to the extremes. A coverage
 * track's distribution over a few thousand features is the usual long tail: one
 * feature under a copy-number amplification, or a single bin of pile-up
 * artefact, is a hundred times the median, and a scale fitted to it draws every
 * other row at the bottom colour. That is the picture this figure had — a flat
 * purple block with a colour bar running to thirteen hundred — and it is not a
 * statement about the data, it is the outlier deciding the scale. matplotlib's
 * `set_over` is the convention for what is above it: the cells clamp to the end
 * colour, so an extreme row is still visibly extreme.
 *
 * Read off a **subsample** where the matrix is large. A metaplot's heatmap is
 * five thousand features by four hundred bins, and sorting two million numbers
 * to find one percentile is a second of the reader's time for three significant
 * figures nobody reads; every 20th value is the same percentile to well within
 * the width of a colour step.
 *
 * The reader's own `scale`/`to` boxes still win over this, which is what
 * `figures/matrixOption.matrixScale` puts above everything.
 */
export function clipOf(values: Float32Array): [number, number] | null {
  const stride = Math.max(1, Math.floor(values.length / 100_000))
  const sample: number[] = []
  for (let i = 0; i < values.length; i += stride) {
    const value = values[i]
    if (Number.isFinite(value)) sample.push(value)
  }
  if (sample.length === 0) return null
  sample.sort((a, b) => a - b)
  const at = (p: number): number => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))]
  // A track that never goes negative is read from zero — that is what a
  // coverage heatmap means, and a floor at the 1st percentile of one would be
  // a claim that its empty bins are its baseline. A signed one (a z-score, a
  // log ratio) keeps a symmetric clip about its own centre instead.
  const hi = at(0.99)
  const lo = sample[0] >= 0 ? 0 : -Math.max(Math.abs(at(0.01)), Math.abs(hi))
  const top = sample[0] >= 0 ? hi : Math.max(Math.abs(at(0.01)), Math.abs(hi))
  return top > lo ? [lo, top] : null
}

/**
 * Five labels along the abscissa, in the units the curve above it is drawn in.
 *
 * The heatmap and the profile are one figure read together — *is that line a
 * summary or two populations averaged* — and a heatmap with no numbers under it
 * cannot be lined up against the curve at all. The ends are the axis's own ends
 * (`figures/matrixOption.spreadTicks`), so the two pictures agree column for
 * column.
 */
function heatmapTicks(layout: Layout): string[] {
  const { x } = axisFor(layout)
  if (x.length === 0) return []
  const scaled = layout.bodyTo > layout.bodyFrom
  // In the scaled layout the abscissa is a slot number, which is not a unit
  // anybody reads; the three parts are named in the axis label instead.
  if (scaled) return ['', '', '', '', '']
  // **The axis's own ends, not the bins' centres.** `axisFor` answers with the
  // centre of each column, so the middle column of a 50 bp grid is at +25 and
  // the first at −1,975: true to the half bin, and an axis nobody can read,
  // when what a reader looks for first is the zero under the anchor. The
  // labels are positions *along the axis*, which runs from the left edge of
  // the first column to the right edge of the last — the same numbers the
  // curve above it is drawn against.
  const step = layout.flankStep > 0 ? layout.flankStep : 1
  const lo = x[0] - step / 2
  const hi = x[x.length - 1] + step / 2
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = lo + fraction * (hi - lo)
    const kb = Math.abs(value) >= 10_000
    return kb ? `${Number((value / 1000).toFixed(1))} kb` : String(Math.round(value))
  })
}

/** One curve's rows, kept for its heatmap: its group's features, one row each. */
interface HeldRows {
  /** Which group of the run, by index — the heatmaps of one group share an order. */
  group: number
  rows: Float32Array
  count: number
  /** The curve's name in the legend. */
  name: string
}

/** One track's rows added into its group's per-feature sums of what it covers. */
function addStrength(
  into: { total: Float64Array; seen: Float64Array },
  rows: Float64Array,
  count: number,
  slots: number,
): void {
  for (let row = 0; row < count; row++) {
    let total = 0
    let seen = 0
    for (let slot = 0; slot < slots; slot++) {
      const value = rows[row * slots + slot]
      if (!Number.isFinite(value)) continue
      total += value
      seen++
    }
    into.total[row] += total
    into.seen[row] += seen
  }
}

/**
 * A group's features, strongest first: by the mean of every value the tracks
 * have for it, every track's columns together, and a feature none of them
 * covers last.
 *
 * **One order for every track's heatmap**, which is deepTools' (`plotHeatmap`
 * sorts by the mean over every sample, descending, by default): a row is the
 * same feature in each picture, so the features strong in one track can be
 * read off in the others — two heatmaps each sorted by its own track would put
 * two different features side by side on every row and invite exactly that
 * comparison. Over one track it is that track's own mean, as it always was.
 */
function orderOf(strength: { total: Float64Array; seen: Float64Array }): number[] {
  const count = strength.total.length
  const mean = new Float64Array(count)
  for (let row = 0; row < count; row++) {
    mean[row] = strength.seen[row] === 0 ? Number.NaN : strength.total[row] / strength.seen[row]
  }
  return Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    if (Number.isNaN(mean[a])) return Number.isNaN(mean[b]) ? 0 : 1
    if (Number.isNaN(mean[b])) return -1
    return mean[b] - mean[a]
  })
}

/**
 * One curve's per-feature heatmap, in its group's order (`orderOf`).
 *
 * **One for every curve**, every track's and every group's: it was the first
 * curve's alone, which over two tracks left the second's rows unseen however
 * the line above them looked. Sorted, because an unsorted heatmap of five
 * thousand rows is a texture and a sorted one is a shape: it is the picture that
 * says whether the line above it is a summary or an artefact of averaging two
 * populations. The first keeps the id it has always had, which is the name of
 * the file the command line writes it to.
 */
function heatmapOf(
  held: HeldRows,
  order: number[],
  index: number,
  layout: Layout,
  xLabel: string,
  run: { zscore: boolean; tracks: number },
): MatrixOutput {
  const { rows, count } = held
  const values = new Float32Array(count * layout.slots)
  for (let row = 0; row < count; row++) {
    values.set(rows.subarray(order[row] * layout.slots, (order[row] + 1) * layout.slots), row * layout.slots)
  }
  const clip = clipOf(values)
  return {
    kind: 'matrix',
    id: index === 0 ? 'metaplot-heatmap' : `metaplot-heatmap-${index + 1}`,
    // The colour scale carries no unit of its own, so the label is the only
    // place this picture can say that its cells are standard deviations from the
    // track's mean rather than the track's own values.
    label: `${held.name} · per feature${run.zscore ? ', z-scored' : ''}`,
    nrows: count,
    ncols: layout.slots,
    values,
    xLabel,
    yLabel:
      run.tracks === 1
        ? `Features, strongest first (${count.toLocaleString()})`
        : `Features, strongest first across ${run.tracks} tracks (${count.toLocaleString()})`,
    xTicks: heatmapTicks(layout),
    yTicks: [],
    colormap: 'viridis',
    ...(clip === null ? {} : { range: clip }),
    // Rows are a *list* — one per feature, strongest first — so there is no
    // diagonal to keep square and nothing is compared across one. The picture
    // takes the width of the card, under the profile it shares an abscissa
    // with, which is the figure every metaplot tool draws.
    aspect: 'fill',
  }
}
