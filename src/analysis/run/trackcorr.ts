/**
 * Track correlation, run.
 *
 * Every track sampled over the same units, then correlated pairwise. The only
 * decision with a consequence is what happens to a unit one track can answer for
 * and another cannot: it is left out of **every** pair, as deepTools'
 * `plotCorrelation` leaves out a row of its matrix with a missing value. It was
 * left out of that pair alone, and two mouse ATAC-seq replicates beside an
 * insulation score — which has no value where the map is too sparse — then read
 * ρ = 0.59 at 100 bp where deepTools reads 0.54 from the same windows. Every
 * coefficient is now over the same units, so the matrix is one sample's
 * correlations rather than each pair's own. The price is that two well-covered
 * tracks' coefficient moves with a third one's gaps, which nobody would look for
 * on finding a surprising number: so the run says how many units it left out.
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
import { MIN_PAIRS, pearson, spearman } from '../stats'
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

  const units = await unitsOf(job)
  if (units.count === 0) {
    job.note('No unit to compare over. Check that the tracks and the assembly share contig names.')
    return []
  }

  const columns: Float64Array[] = []
  for (let i = 0; i < entries.length; i++) {
    job.throwIfCancelled()
    job.progress(i, entries.length, names[i])
    columns.push(await valuesFor(job, entries[i], units))
  }
  job.progress(entries.length, entries.length, 'correlating')

  const compared = keepComplete(columns)
  const noun = units.kind === 'bins' ? 'windows' : 'features'
  if (compared < MIN_PAIRS) {
    job.note(
      `Fewer than ${MIN_PAIRS} of the ${units.count.toLocaleString()} ${noun} have a value in every ` +
        'track, so no pair has a coefficient. Check that the tracks cover the same sequences.',
    )
  } else if (compared < units.count) {
    const left = units.count - compared
    const one = left === 1
    job.note(
      `${left.toLocaleString()} of the ${units.count.toLocaleString()} ${noun} ` +
        `${one ? 'has' : 'have'} no value in at least one track, and ${one ? 'is' : 'are'} left out ` +
        `of every pair, as deepTools leaves ${one ? 'it' : 'them'} out: every coefficient is over ` +
        `the other ${compared.toLocaleString()}.`,
    )
  }

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
    stats: [
      { label: 'units', value: units.count, digits: 0 },
      {
        label: 'compared',
        value: compared,
        digits: 0,
        hint: 'Units every track has a value for: the ones every pair is correlated over.',
      },
    ],
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

/**
 * The units to compare over: fixed windows across the assembly, or a feature set.
 *
 * Windows are kept as a **tiling per sequence** — a size and a count — and never
 * as one object per window: at the default 100 bp a mouse genome is 27 million
 * of them, and an object each was gigabytes before a single value was read.
 */
type Units =
  | { kind: 'bins'; size: number; tilings: Tiling[]; count: number }
  | { kind: 'features'; regions: Region[]; count: number }

/** One sequence's windows: `count` of `size` bases from 0, units `offset …`. */
interface Tiling {
  contig: string
  count: number
  offset: number
}

async function unitsOf(job: Parameters<TrackTaskRunner>[0]): Promise<Units> {
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
      return { kind: 'features', regions: [], count: 0 }
    }
    const regions: Region[] = []
    for (let i = 0; i < set.length; i++) {
      regions.push({ contig: set.contigs[set.contig[i]], start: set.start[i], end: set.end[i] })
    }
    return { kind: 'features', regions, count: regions.length }
  }
  const size = Math.max(1, Math.round(numParam(job.params, 'binsize', 100)))
  const tilings: Tiling[] = []
  let count = 0
  for (const [contig, length] of Object.entries(job.inputs.contigLengths ?? {})) {
    // Whole windows only: a last window shorter than the rest is a different
    // quantity — a mean over fewer bases — ranked beside the others as if not.
    const whole = Math.floor(length / size)
    if (whole === 0) continue
    tilings.push({ contig, count: whole, offset: count })
    count += whole
  }
  return { kind: 'bins', size, tilings, count }
}

/**
 * How many bases one request reads, at most.
 *
 * Each track is read **at its own resolution** — a bigWig's base-level records,
 * never a zoom level — because a unit's value is the mean over the bases it
 * covers, and a zoom record is a mean over *its* span: one 17 kb record laid
 * over a 10 kb window put the neighbouring windows' signal into it, and the
 * correlation over a mouse genome came out at 0.81 where the windows' own means
 * give 0.88. Reading at base resolution makes the read the whole file, which is
 * what an exact mean costs; a megabase at a time keeps what is held to one
 * megabase's records, so a 61 Mb chromosome at 100 bp is no longer the
 * out-of-memory it was when all 614,000 of its windows were one request.
 */
const CHUNK_BASES = 1 << 20

/** Requests per batch of features, for the same reason. */
const CHUNK_FEATURES = 4096

/**
 * One track's mean value over each unit: the mean over the bases the track has
 * a value for, each record weighted by **how much of the unit it covers** —
 * pyBigWig's `stats(…, exact=True)`, and what deepTools reads where it reads
 * base-level data.
 */
async function valuesFor(
  job: Parameters<TrackTaskRunner>[0],
  entry: string,
  units: Units,
): Promise<Float64Array> {
  const total = new Float64Array(units.count)
  const covered = new Float64Array(units.count)
  // One record's share of the unit `[from, to)` it overlaps, folded in.
  const fold = (at: number, from: number, to: number, start: number, end: number, value: number): void => {
    const overlap = Math.min(end, to) - Math.max(start, from)
    if (!(overlap > 0)) return
    total[at] += value * overlap
    covered[at] += overlap
  }

  if (units.kind === 'bins') {
    const { size } = units
    const span = Math.max(1, Math.floor(CHUNK_BASES / size)) * size
    for (const tiling of units.tilings) {
      const end = tiling.count * size
      for (let from = 0; from < end; from += span) {
        job.throwIfCancelled()
        const to = Math.min(end, from + span)
        const set = await job.sample(entry, [{ contig: tiling.contig, start: from, end: to }], 1)
        for (const samples of set.regions) {
          for (let k = 0; k < samples.values.length; k++) {
            const value = samples.values[k]
            if (!Number.isFinite(value)) continue
            const start = Math.max(from, samples.starts[k])
            const stop = Math.min(to, samples.ends[k])
            // A record longer than a window — a run of one value in a coverage
            // track — is shared out over every window it crosses.
            for (let unit = Math.floor(start / size); unit * size < stop; unit++) {
              fold(tiling.offset + unit, unit * size, (unit + 1) * size, start, stop, value)
            }
          }
        }
      }
    }
  } else {
    // By sequence, and in batches, matched back by the coordinates the reply
    // echoes: `sample` drops what its file cannot answer, so matching by
    // position would shift every row after the first one dropped.
    const byContig = new Map<string, number[]>()
    units.regions.forEach((region, i) => {
      const held = byContig.get(region.contig)
      if (held === undefined) byContig.set(region.contig, [i])
      else held.push(i)
    })
    for (const [, indices] of byContig) {
      for (let first = 0; first < indices.length; first += CHUNK_FEATURES) {
        job.throwIfCancelled()
        const batch = indices.slice(first, first + CHUNK_FEATURES)
        const set = await job.sample(entry, batch.map((i) => units.regions[i]), 1)
        const byKey = new Map<string, (typeof set.regions)[number]>()
        for (const region of set.regions) byKey.set(`${region.contig}:${region.start}-${region.end}`, region)
        for (const i of batch) {
          const region = units.regions[i]
          const samples = byKey.get(`${region.contig}:${region.start}-${region.end}`)
          if (samples === undefined) continue
          for (let k = 0; k < samples.values.length; k++) {
            const value = samples.values[k]
            if (!Number.isFinite(value)) continue
            fold(i, region.start, region.end, samples.starts[k], samples.ends[k], value)
          }
        }
      }
    }
  }

  // In place: at 100 bp a mouse genome's column is 216 MB, and a third copy of
  // it per track is what a run that holds several of them can least afford.
  for (let i = 0; i < total.length; i++) total[i] = covered[i] > 0 ? total[i] / covered[i] : Number.NaN
  return total
}

/**
 * Leaves each unit any track lacks out of every track, in place, and says how
 * many units are left.
 *
 * deepTools' `plotCorrelation` reads its matrix and drops every row with a
 * missing value before it computes anything (`np.ma.compress_rows`), so all its
 * coefficients are over the rows every sample has. A unit missing from one
 * column is made missing in all of them here, and the pairwise measures, which
 * skip a pair either side of which is missing, are then over the same units.
 */
function keepComplete(columns: readonly Float64Array[]): number {
  const count = columns.length === 0 ? 0 : columns[0].length
  let kept = 0
  for (let i = 0; i < count; i++) {
    if (columns.every((column) => !Number.isNaN(column[i]))) kept++
    else for (const column of columns) column[i] = Number.NaN
  }
  return kept
}
