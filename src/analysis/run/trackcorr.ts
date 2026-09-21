/**
 * Track correlation, run.
 *
 * Every track sampled over the same units, then correlated pairwise. The only
 * decision with a consequence is what happens to a unit one track can answer for
 * and another cannot: it is dropped from *that pair* and not from the whole run.
 * Dropping it everywhere would make the correlation between two well-covered
 * tracks depend on a third one's gaps, which is the sort of coupling nobody
 * would look for on finding a surprising number.
 */

import type { Region } from '../../annotations/types'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import {
  chosenInput,
  listParam,
  missingInput,
  numParam,
  strParam,
  type TrackTaskRunner,
} from '../job'
import { pearson, spearman } from '../stats'
import type { MatrixOutput, TableOutput, TaskOutput } from '../types'

export const runTrackCorrelation: TrackTaskRunner = async (job) => {
  const entries = listParam(job.params, 'tracks')
  if (entries.length < 2) {
    job.note(
      entries.length === 0
        ? 'No tracks were chosen. Load two or more bigWigs and tick them under Tracks.'
        : 'Only one track was chosen, and a correlation needs two.',
    )
    return []
  }

  // The reader's names, not the store's ids. An id is `a1`, and a heatmap whose
  // axes read `a1, a2, a3` is a figure that has to be decoded against a panel —
  // which is the one thing a figure must not need. The ids stay as the keys
  // everything is looked up by; only what is *written* changes.
  const nameOf = (id: string): string => job.inputs.labels?.[id] ?? id
  const names = entries.map(nameOf)

  const regions = await unitsOf(job)
  if (regions.length === 0) {
    job.note('No unit to compare over. Check that the tracks and the assembly share contig names.')
    return []
  }

  const step = strParam(job.params, 'over', 'bins') === 'features'
    ? 0
    : Math.max(1, Math.round(numParam(job.params, 'binsize', 100)))
  const columns: Float64Array[] = []
  for (let i = 0; i < entries.length; i++) {
    job.throwIfCancelled()
    job.progress(i, entries.length, names[i])
    columns.push(await valuesFor(job, entries[i], regions, step))
  }
  job.progress(entries.length, entries.length, 'correlating')

  const method = strParam(job.params, 'method', 'spearman')
  const n = entries.length
  const values = new Float32Array(n * n)
  const rows: Array<Record<string, string | number>> = []
  for (let r = 0; r < n; r++) {
    values[r * n + r] = 1
    for (let c = r + 1; c < n; c++) {
      const value =
        method === 'pearson' ? pearson(columns[r], columns[c]) : spearman(columns[r], columns[c])
      values[r * n + c] = value
      values[c * n + r] = value
      rows.push({ a: names[r], b: names[c], r: value })
    }
  }

  const matrix: MatrixOutput = {
    kind: 'matrix',
    id: 'trackcorr',
    label: `Track correlation · ${method}`,
    nrows: n,
    ncols: n,
    values,
    xLabel: '',
    yLabel: '',
    xTicks: names,
    yTicks: names,
    colormap: DEFAULT_DIVERGING_COLORMAP,
    // Zero, not the data's midpoint: a correlation is read about no-agreement,
    // and a scale centred on whatever the data happened to average would move
    // the white point between runs.
    centre: 0,
    stats: [{ label: 'units', value: regions.length, digits: 0 }],
  }
  const table: TableOutput = {
    kind: 'table',
    id: 'trackcorr-table',
    label: 'Pairs',
    columns: [
      { key: 'a', label: 'Track', kind: 'text' },
      { key: 'b', label: 'Track', kind: 'text' },
      { key: 'r', label: method === 'pearson' ? 'Pearson r' : 'Spearman ρ', kind: 'number', digits: 3 },
    ],
    rows: rows.sort((x, y) => Number(y.r) - Number(x.r)),
  }
  const outputs: TaskOutput[] = [matrix, table]
  return outputs
}

/** The units to compare over: fixed bins across the assembly, or a feature set. */
async function unitsOf(job: Parameters<TrackTaskRunner>[0]): Promise<Region[]> {
  if (strParam(job.params, 'over', 'bins') === 'features') {
    // By the **parameter key**, `features` — see `chosenInput`.
    const found = chosenInput(job.inputs.features, job.params, 'features')
    const set = found.value
    if (set === undefined) {
      job.note(
        missingInput(found, {
          unchosen: 'Correlating over features needs a feature set, and none was chosen.',
          gone: 'The feature set chosen is no longer loaded. Re-open the file, or pick another.',
        }) ?? '',
      )
      return []
    }
    const out: Region[] = []
    for (let i = 0; i < set.length; i++) {
      out.push({ contig: set.contigs[set.contig[i]], start: set.start[i], end: set.end[i] })
    }
    return out
  }
  const size = Math.max(1, Math.round(numParam(job.params, 'binsize', 100)))
  const out: Region[] = []
  for (const [contig, length] of Object.entries(job.inputs.contigLengths ?? {})) {
    for (let start = 0; start + size <= length; start += size) {
      out.push({ contig, start, end: start + size })
    }
  }
  return out
}

/**
 * One track's mean value over each unit.
 *
 * Sampled per contig for the reason the metaplot does it: the worker picks one
 * zoom level per request and coalesces adjacent blocks, so a chromosome's worth
 * of units is one call.
 */
async function valuesFor(
  job: Parameters<TrackTaskRunner>[0],
  entry: string,
  regions: Region[],
  step: number,
): Promise<Float64Array> {
  const out = new Float64Array(regions.length).fill(Number.NaN)
  const byContig = new Map<string, number[]>()
  for (let i = 0; i < regions.length; i++) {
    const held = byContig.get(regions[i].contig)
    if (held === undefined) byContig.set(regions[i].contig, [i])
    else held.push(i)
  }

  for (const [, indices] of byContig) {
    job.throwIfCancelled()
    const wanted = indices.map((i) => regions[i])
    const resolution = step > 0 ? step : Math.max(1, Math.round(meanSpan(wanted)))
    const set = await job.sample(entry, wanted, resolution)
    const byKey = new Map<string, (typeof set.regions)[number]>()
    for (const region of set.regions) {
      byKey.set(`${region.contig}:${region.start}-${region.end}`, region)
    }
    for (const i of indices) {
      const region = regions[i]
      const samples = byKey.get(`${region.contig}:${region.start}-${region.end}`)
      if (samples === undefined) continue
      let total = 0
      let span = 0
      for (let k = 0; k < samples.values.length; k++) {
        const value = samples.values[k]
        if (!Number.isFinite(value)) continue
        const width = samples.ends[k] - samples.starts[k]
        total += value * width
        span += width
      }
      // Span-weighted, so a summary interval that covers half the unit counts
      // for half of it rather than for one sample.
      out[i] = span > 0 ? total / span : Number.NaN
    }
  }
  return out
}

function meanSpan(regions: Region[]): number {
  let total = 0
  for (const region of regions) total += region.end - region.start
  return regions.length === 0 ? 1 : total / regions.length
}
