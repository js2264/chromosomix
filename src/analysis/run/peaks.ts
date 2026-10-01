/**
 * Calling peaks, run — in the annotations worker, beside the tracks.
 *
 * yapc's pipeline for one condition (`analysis/yapc.ts`, `analysis/idr.ts`), in
 * its order: the mean of the chosen tracks, its smoothed second derivative, the
 * stretches where that is negative, each track's score for every one of them,
 * the narrow ones dropped, the strongest kept, and — with a replicate — IDR over
 * the two rankings and the peaks under the threshold.
 *
 * ## Read a window at a time
 *
 * Every base of every ticked sequence is read, at the file's own resolution,
 * which on a mammalian genome is gigabytes of bigWig. So nothing is held whole:
 * each sequence is read in windows of {@link WINDOW} bases plus the 228 each
 * side the convolution reaches, each window is convolved and scanned and let
 * go, and the thread is handed back before the next — which is what keeps the
 * lanes this worker also draws moving, and what lets a Stop be read at all.
 * `ConcaveScan` carries what crosses a seam. The answer is bit for bit the one a
 * whole sequence in memory gives; the golden checks it both ways.
 *
 * ## What comes out
 *
 * The peaks as an interval set — each with its summit as the thick part, which
 * is where yapc's own `_peaksall.bed` puts it — and a figure of the curvature
 * of every candidate, split by whether it made the set. On a real ATAC track
 * that figure is two populations, and with one track and no test it is how a
 * reader chooses a cut. A table per sequence is always there; one per peak is a
 * toggle, as FRiP's is, since on a mammalian genome it is a hundred thousand rows.
 */

import { yieldToEventLoop } from '../../async'
import { FeatureBuilder } from '../../annotations/featureset'
import { DETAIL_SEP } from '../../annotations/types'
import { IDR_BOX, IdrError, fitIdr, globalIdr, idrRanks, localIdr, scaledIdr, type IdrFit } from '../idr'
import {
  boolParam,
  idParam,
  numParam,
  strParam,
  tickedSequences,
  type TrackJobContext,
  type TrackTaskRunner,
} from '../job'
import { DEFAULT_IDR_THRESHOLD, hasReplicate } from '../tasks/peaks'
import type { CurveOutput, CurveSeries, IntervalsOutput, TableOutput, TaskOutput } from '../types'
import {
  ConcaveScan,
  YAPC_DEFAULTS,
  YAPC_IDR_THRESHOLDS,
  convolutionReach,
  convolveSame,
  peakBounds,
  pooledRuns,
  runsOver,
  scaledThreshold,
  strongestRegions,
  yapcKernel,
  zeroRuns,
  type ConcaveRegions,
  type Runs,
  type YapcKernel,
} from '../yapc'

/**
 * Bases computed per read.
 *
 * A quarter of a megabase: small enough that one window's arithmetic is a few
 * tens of milliseconds, so the worker is never away from its lanes for longer,
 * and large enough that the 456-base halo read twice is under half a per cent.
 */
const WINDOW = 1 << 18

/** IDR's own floor: its command refuses to fit fewer peaks than this. */
const IDR_MIN_PEAKS = 20

/** The most values a violin is drawn from; beyond it they are thinned evenly by rank. */
const DRAWN = 20_000

/** Called and not: the colours a candidate is drawn in, by what became of it. */
const KEPT_COLOURS = ['#0072b2', '#009e73']
const CUT_COLOUR = '#999999'

export const runPeaks: TrackTaskRunner = async (job) => {
  const signal = idParam(job.params, 'signal')
  if (signal === null) {
    job.note('No track was chosen. Load a bigWig and pick it under Track.')
    return []
  }
  const replicate = hasReplicate(job.params) ? idParam(job.params, 'replicate') : null
  if (replicate === signal) {
    // Refused rather than run: IDR on a track and itself is two identical
    // rankings, which the model reads as perfect reproducibility — every peak
    // would pass, and the table would say so with a straight face.
    job.note(
      'The replicate chosen is the track being called, and a track cannot test itself. ' +
        'Choose a second track, or none.',
    )
    return []
  }
  const entries = replicate === null ? [signal] : [signal, replicate]
  const nameOf = (id: string): string => job.inputs.labels?.[id] ?? id

  const width = clampInt(numParam(job.params, 'width', YAPC_DEFAULTS.width), 1, 2000)
  const times = clampInt(numParam(job.params, 'times', YAPC_DEFAULTS.times), 0, 10)
  const minWidth = clampInt(numParam(job.params, 'minWidth', YAPC_DEFAULTS.minWidth), 1, 1e9)
  const halfWidth = clampInt(numParam(job.params, 'halfWidth', 0), 0, 1e9)
  const truncate = clampInt(numParam(job.params, 'truncate', YAPC_DEFAULTS.truncate), 1, 1e9)
  const threshold = thresholdOf(job)

  const lengths = job.inputs.contigLengths ?? {}
  const ticked = tickedSequences(job.params, 'sequences')
  const names = Object.keys(lengths).filter(
    (name) => lengths[name] > 0 && (ticked === null || ticked.includes(name)),
  )
  if (names.length === 0) {
    job.note(
      ticked !== null && ticked.length === 0
        ? 'No sequence is ticked, so there is nothing to call peaks on.'
        : 'This session knows no sequence lengths, so there is nothing to scan. Load a ' +
            'chrom.sizes, or the map itself.',
    )
    return []
  }

  // ---- the scan --------------------------------------------------------------
  const kernel = yapcKernel(width, times)
  const totalBases = names.reduce((sum, name) => sum + lengths[name], 0)
  let doneBases = 0
  const scanned: ConcaveRegions[] = []
  const absentOn: string[][] = entries.map(() => [])
  for (const name of names) {
    const found = await scanSequence(job, entries, name, lengths[name], kernel, (bases) => {
      doneBases += bases
      job.progress(doneBases, totalBases, name)
    })
    if (typeof found === 'string') {
      job.note(found)
      return []
    }
    scanned.push(found.regions)
    found.absent.forEach((gone, t) => {
      if (gone) absentOn[t].push(name)
    })
  }
  for (let t = 0; t < entries.length; t++) {
    if (absentOn[t].length === names.length) {
      job.note(
        `${nameOf(entries[t])} has none of the ${names.length === 1 ? 'sequence' : 'sequences'} ` +
          'ticked. Check that it and the assembly name their sequences the same way.',
      )
      return []
    }
    if (absentOn[t].length > 0) {
      job.note(
        `${nameOf(entries[t])} has no ${listOf(absentOn[t])}. yapc reads a track that lacks a ` +
          'sequence as zeros there, so it lowers the mean the regions are called on, and ranks ' +
          'every region there last by it.',
      )
    }
  }

  // ---- regions to candidates --------------------------------------------------
  const contig: string[] = []
  const startList: number[] = []
  const endList: number[] = []
  const modeList: number[] = []
  const flatList: number[] = []
  const scoreLists: number[][] = entries.map(() => [])
  const perSequence = new Map<string, { regions: number; wide: number }>()
  let found = 0
  for (const regions of scanned) {
    found += regions.starts.length
    let wide = 0
    for (let i = 0; i < regions.starts.length; i++) {
      if (regions.ends[i] - regions.starts[i] < minWidth) continue
      wide++
      contig.push(regions.contig)
      startList.push(regions.starts[i])
      endList.push(regions.ends[i])
      modeList.push(regions.modes[i])
      flatList.push(regions.flat[i])
      for (let t = 0; t < entries.length; t++) scoreLists[t].push(regions.scores[t][i])
    }
    perSequence.set(regions.contig, { regions: regions.starts.length, wide })
  }
  const n = startList.length
  const readAs =
    `${kernel.values.length}-tap kernel: a ${width.toLocaleString()} bp window, ` +
    `${times} ${times === 1 ? 'pass' : 'passes'}`
  if (n === 0) {
    job.note(
      `No concave region at least ${minWidth.toLocaleString()} bp wide on ` +
        `${names.length === 1 ? names[0] : `${names.length} sequences`} (${readAs}). A wider ` +
        'smoothing window finds broader shapes; a narrower minimum keeps smaller ones.',
    )
    return []
  }
  const starts = Int32Array.from(startList)
  const ends = Int32Array.from(endList)
  const modes = Int32Array.from(modeList)
  const flats = Uint8Array.from(flatList)
  const scores = scoreLists.map((list) => Float64Array.from(list))
  // In yapc's IDR order: by sequence name, then position. Everything below is
  // indexed through this.
  const tested = strongestRegions(contig, starts, ends, scores, truncate)
  job.note(
    `${found.toLocaleString()} concave ${found === 1 ? 'region' : 'regions'} on ` +
      `${names.length.toLocaleString()} ${names.length === 1 ? 'sequence' : 'sequences'} ` +
      `(${readAs}), ${n.toLocaleString()} at least ${minWidth.toLocaleString()} bp wide` +
      (tested.length < n
        ? `, of which the ${tested.length.toLocaleString()} strongest by each track’s curvature ` +
          'rank were kept.'
        : '.'),
  )

  // ---- IDR ----------------------------------------------------------------
  let fit: IdrFit | null = null
  let local: Float64Array | null = null
  let global: Float64Array | null = null
  const passes = new Uint8Array(tested.length).fill(1)
  if (replicate !== null) {
    if (tested.length < IDR_MIN_PEAKS) {
      job.note(
        `IDR needs at least ${IDR_MIN_PEAKS} peaks to fit — its own command refuses fewer — and ` +
          `there ${tested.length === 1 ? 'is 1' : `are ${tested.length}`}. They are reported ` +
          'untested, ranked by curvature.',
      )
    } else {
      const r1 = idrRanks(pick(scores[0], tested))
      const r2 = idrRanks(pick(scores[1], tested))
      const ties = tiesIn(pick(scores[0], tested)) + tiesIn(pick(scores[1], tested))
      if (ties > 0) {
        job.note(
          `${ties.toLocaleString()} ${ties === 1 ? 'score ties' : 'scores tie'} with another: ` +
            'ranked by position, where yapc breaks a tie at random.',
        )
      }
      try {
        fit = await fitIdr(r1, r2, {
          between: async (rounds) => {
            // No total, because IDR's fit has none: it ends when it converges.
            // A bar filling towards a limit of three thousand rounds that it
            // reaches a tenth of would be a picture of nothing.
            job.progress(0, 0, `IDR, round ${rounds}`)
            await yieldToEventLoop()
            job.throwIfCancelled()
          },
        })
      } catch (error) {
        if (error instanceof IdrError) {
          throw new Error(`IDR could not fit these two tracks, as idr itself could not: ${error.message}`)
        }
        throw error
      }
      local = localIdr(fit.theta, r1, r2)
      global = globalIdr(local)
      const cut = scaledThreshold(threshold)
      for (let k = 0; k < tested.length; k++) passes[k] = scaledIdr(global[k]) >= cut ? 1 : 0
      job.note(fitNote(fit, tested.length, countOf(passes), threshold))
    }
  } else {
    // A stretch of constant signal is concave by yapc's test — `d2 < 10⁻¹⁰`, and
    // flat is 0 or −10⁻¹¹ — and scores next to nothing. yapc never reports one:
    // IDR ranks it last in both replicates and drops it. With no IDR that cut
    // has to be made here, and the region's own shape makes it — `ConcaveScan`'s
    // `flat` — rather than a threshold on a score.
    let flat = 0
    for (let k = 0; k < tested.length; k++) {
      if (flats[tested[k]] === 0) continue
      passes[k] = 0
      flat++
    }
    if (flat > 0) {
      job.note(
        `${flat.toLocaleString()} of the candidates ${flat === 1 ? 'is' : 'are'} flat — the ` +
          'signal constant across a whole kernel’s width inside, which yapc’s test counts as ' +
          `concave — and ${flat === 1 ? 'is' : 'are'} left out, as IDR would leave ` +
          `${flat === 1 ? 'it' : 'them'} out of two replicates.`,
      )
    }
    job.note(
      'One track, so no test of significance: yapc’s cut is IDR between two replicates. These ' +
        'are the strongest concave regions by curvature — choose a replicate to test them, or ' +
        'lower “keep the strongest” to the upper of the two populations in the figure.',
    )
  }

  // ---- outputs ------------------------------------------------------------
  const order = new Map(names.map((name, i) => [name, i]))
  const called: number[] = []
  for (let k = 0; k < tested.length; k++) if (passes[k] === 1) called.push(k)
  // The lane in the assembly's own order, which is the order a BED of it is
  // written in; `tested` is in yapc's, by name.
  called.sort(
    (a, b) =>
      (order.get(contig[tested[a]]) ?? 0) - (order.get(contig[tested[b]]) ?? 0) ||
      starts[tested[a]] - starts[tested[b]],
  )

  const build = new FeatureBuilder()
  let clamped = 0
  for (const k of called) {
    const i = tested[k]
    const [from, to] = peakBounds(starts[i], ends[i], modes[i], halfWidth, lengths[contig[i]])
    if (halfWidth > 0 && (from !== modes[i] - halfWidth || to !== modes[i] + halfWidth + 1)) clamped++
    const detail = [`summit ${(modes[i] + 1).toLocaleString('en-US')}`]
    detail.push(
      `curvature ${entries.map((_, t) => significant(scores[t][i])).join(' / ')}`,
    )
    if (global !== null) detail.push(`IDR ${significant(global[k])}`)
    build.add(contig[i], from, to, {
      // What a peak's strength *is* in each mode: its IDR where there was a
      // test, as yapc's BEDs carry it, and its curvature where there was not.
      score: global !== null ? scaledIdr(global[k]) : scores[0][i],
      cds: [modes[i], modes[i] + 1],
      detail: detail.join(DETAIL_SEP),
    })
  }
  if (clamped > 0) {
    job.note(
      `${clamped.toLocaleString()} ${clamped === 1 ? 'peak reaches' : 'peaks reach'} past a ` +
        'sequence end at this half-width and ' +
        `${clamped === 1 ? 'is' : 'are'} cut at it; yapc writes the coordinate past the end.`,
    )
  }
  if (called.length === 0) {
    job.note(
      `No peak passes IDR ≤ ${threshold}. A looser threshold keeps more; two tracks that are not ` +
        'replicates of one experiment will pass few at any.',
    )
  }

  const outputs: TaskOutput[] = []
  if (called.length > 0) {
    outputs.push({
      kind: 'intervals',
      // Per track, so a call on another track is another row rather than this
      // one replaced — the workspace keeps one row per output id — and spelled
      // safely, since the shell names its files after it and there an entry is a
      // path.
      id: `peaks-${entries.map((entry) => entry.replace(/[^A-Za-z0-9_]+/g, '_')).join('-')}`,
      label:
        replicate === null
          ? `Peaks · ${nameOf(signal)} · no IDR`
          : `Peaks · ${nameOf(signal)} + ${nameOf(replicate)} · IDR ≤ ${threshold}`,
      payload: { kind: 'features', data: build.finish() },
      noun: { one: 'peak', many: 'peaks' },
    } satisfies IntervalsOutput)
  }
  const figure = curvatureFigure(entries.map(nameOf), scores, tested, passes, replicate !== null, n, flats)
  if (figure !== null) outputs.push(figure)
  outputs.push(sequenceTable(names, lengths, perSequence, called.map((k) => contig[tested[k]])))
  if (fit !== null && global !== null) outputs.push(thresholdTable(global, threshold))
  if (boolParam(job.params, 'perPeak', false)) {
    outputs.push(
      peakTable({
        names: entries.map(nameOf),
        contig,
        starts,
        ends,
        modes,
        scores,
        tested,
        passes,
        local,
        global,
        replicate: replicate !== null,
      }),
    )
  }
  job.progress(1, 1, 'done')
  return outputs
}

/**
 * One sequence, read and scanned a window at a time.
 *
 * Returns the sequence's concave regions and which tracks do not have it at
 * all, or a sentence where a track refused to be read here — which only a
 * track kind with a limit on what it will answer can do, and which is then the
 * whole run's answer rather than a hole in it.
 */
async function scanSequence(
  job: TrackJobContext,
  entries: readonly string[],
  name: string,
  length: number,
  kernel: YapcKernel,
  report: (bases: number) => void,
): Promise<{ regions: ConcaveRegions; absent: boolean[] } | string> {
  const { left, right } = convolutionReach(kernel, length)
  const absent = entries.map(() => false)
  let scan: ConcaveScan | null = null
  for (let from = 0; from < length; from += WINDOW) {
    const to = Math.min(length, from + WINDOW)
    const lo = Math.max(0, from - left)
    const hi = Math.min(length, to + right)
    const runs: Runs[] = []
    for (let t = 0; t < entries.length; t++) {
      if (absent[t]) {
        runs.push(zeroRuns(lo, hi))
        continue
      }
      // Base resolution: one base per pixel is what selects the file's own
      // intervals rather than a zoom level's means (§8.2).
      const set = await job.sample(entries[t], [{ contig: name, start: lo, end: hi }], 1)
      if (set.note !== undefined) return set.note
      const answer = set.regions[0]
      if (answer === undefined) {
        // Asked about a sequence the track does not name: it has none of it,
        // which yapc reads as zeros (`zeroRuns`).
        absent[t] = true
        runs.push(zeroRuns(lo, hi))
        continue
      }
      runs.push(runsOver(answer.starts, answer.ends, answer.values, lo, hi))
    }
    scan ??= new ConcaveScan(name, length, absent)
    const flat = new Uint8Array(to - from)
    const pooled = convolveSame(pooledRuns(runs, lo, hi), kernel, length, from, to, flat)
    const own = entries.length === 1 ? [pooled] : runs.map((r) => convolveSame(r, kernel, length, from, to))
    scan.feed(from, pooled, own, flat)
    report(to - from)
    await yieldToEventLoop()
    job.throwIfCancelled()
  }
  return { regions: (scan ?? new ConcaveScan(name, length, absent)).finish(), absent }
}

/** The IDR threshold asked for, as one of yapc's six; the default otherwise, and said. */
function thresholdOf(job: TrackJobContext): number {
  const asked = Number(strParam(job.params, 'idr', DEFAULT_IDR_THRESHOLD))
  if (YAPC_IDR_THRESHOLDS.includes(asked)) return asked
  if (hasReplicate(job.params)) {
    job.note(
      `An IDR threshold of ${strParam(job.params, 'idr', '')} is not one yapc writes; ` +
        `${DEFAULT_IDR_THRESHOLD} was used.`,
    )
  }
  return Number(DEFAULT_IDR_THRESHOLD)
}

/** IDR's four parameters, in its order, as a note names them. */
const PARAMETERS = ['mean', 'spread', 'correlation', 'reproducible share'] as const

/**
 * What the fit found, in a sentence — and, where it ran into the edge of the
 * box IDR keeps its parameters in, what that means.
 *
 * Two tracks that are not replicates of one experiment drive the EM out of the
 * box, and the coordinate ascent it falls back on then parks one parameter or
 * more against it — the correlation at its floor, the reproducible share at its
 * ceiling, the mean at zero — and every edge reached is named. The IDRs that
 * come out are IDR's answer and are reported, but they are not a statement
 * about reproducibility, and a reader who chose an ATAC track and a ChIP track
 * has to be told so rather than handed a peak set.
 */
export function fitNote(fit: IdrFit, tested: number, passed: number, threshold: number): string {
  const [mu, sigma, rho, p] = fit.theta
  const said =
    `IDR fitted over ${tested.toLocaleString()} peaks in ${fit.rounds.toLocaleString()} rounds: ` +
    `μ ${mu.toFixed(2)}, σ ${sigma.toFixed(2)}, ρ ${rho.toFixed(2)}, reproducible share ` +
    `${p.toFixed(2)}; ${passed.toLocaleString()} pass IDR ≤ ${threshold}.`
  const edges: string[] = []
  const bound = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2))
  fit.theta.forEach((value, j) => {
    // Within what the coordinate ascent's line search resolves, scaled to the
    // bound, since a σ of 19.9999 has hit a ceiling of 20.
    const [low, high] = [IDR_BOX.min[j], IDR_BOX.max[j]]
    if (value <= low + 1e-4 * Math.max(1, low)) {
      edges.push(`the ${PARAMETERS[j]} at its floor of ${bound(low)}`)
    } else if (value >= high - 1e-4 * Math.max(1, high)) {
      edges.push(`the ${PARAMETERS[j]} at its ceiling of ${bound(high)}`)
    }
  })
  if (edges.length === 0) return said
  return (
    `${said} The fit ended at the edge of IDR’s parameter box — ${edges.join(', ')} — ` +
    'which is where two tracks that do not rank their peaks like replicates of one ' +
    'experiment put it. Read these IDRs as that, not as reproducibility.'
  )
}

/**
 * The curvature of every candidate, as violins split by what became of it.
 *
 * On a log axis, because the score spans six decades and the question — are
 * there two populations, and where does the cut fall between them — is a
 * question about its logarithm. A candidate whose score is not positive (a flat
 * stretch scores about 10⁻¹¹, and a track missing the sequence −∞) cannot sit on
 * that axis and is left out of the picture, not the peak set.
 */
function curvatureFigure(
  names: readonly string[],
  scores: readonly Float64Array[],
  tested: Int32Array,
  passes: Uint8Array,
  withIdr: boolean,
  candidates: number,
  flats: Uint8Array,
): CurveOutput | null {
  const series: CurveSeries[] = []
  const inTest = new Uint8Array(candidates)
  for (const i of tested) inTest[i] = 1
  for (let t = 0; t < scores.length; t++) {
    const kept: number[] = []
    const cut: number[] = []
    tested.forEach((i, k) => {
      const value = scores[t][i]
      // A flat region is not a candidate where there is no IDR to drop it, and
      // its score of 10⁻⁷ would give the axis five decades of nothing.
      if (!(value > 0) || (!withIdr && flats[i] === 1)) return
      if (passes[k] === 1) kept.push(value)
      else cut.push(value)
    })
    // Below the truncation: candidates that never reached a test.
    if (!withIdr) {
      for (let i = 0; i < candidates; i++) {
        if (inTest[i] === 0 && scores[t][i] > 0 && flats[i] === 0) cut.push(scores[t][i])
      }
    }
    const prefix = scores.length === 1 ? '' : `${names[t]} · `
    const keptName = withIdr ? `${prefix}passes IDR` : `${prefix}peaks`
    const cutName = withIdr ? `${prefix}fails IDR` : `${prefix}below the cut`
    if (kept.length > 0) series.push(violin(keptName, kept, KEPT_COLOURS[t] ?? KEPT_COLOURS[0]))
    if (cut.length > 0) series.push(violin(cutName, cut, CUT_COLOUR))
  }
  if (series.length === 0) return null
  const all = series.flatMap((entry) => Array.from(entry.y))
  const low = quantile(all, 0.01)
  let high = Number.NEGATIVE_INFINITY
  for (const value of all) if (value > high) high = value
  return {
    kind: 'curve',
    id: 'peaks-curvature',
    label: 'Curvature of every candidate',
    series,
    xLabel: '',
    yLabel: 'Curvature (yapc score)',
    xScale: 'linear',
    yScale: 'log',
    // Opened on the candidates, from the decade below their first percentile to
    // the decade above the strongest — whole decades, since a log axis whose
    // end reads 8.25623 is an axis labelled by accident — rather than on the odd
    // score far below the rest; zoomed out, those are there.
    ...(Number.isFinite(low) && low > 0 && high > low
      ? { yDomain: [10 ** Math.floor(Math.log10(low)), 10 ** Math.ceil(Math.log10(high))] as [number, number] }
      : {}),
  }
}

/** One violin, thinned evenly by rank past {@link DRAWN}. */
function violin(name: string, values: number[], colour: string): CurveSeries {
  const sorted = Float64Array.from(values).sort()
  let drawn = sorted
  if (sorted.length > DRAWN) {
    drawn = new Float64Array(DRAWN)
    for (let i = 0; i < DRAWN; i++) drawn[i] = sorted[Math.round((i * (sorted.length - 1)) / (DRAWN - 1))]
  }
  return {
    name,
    x: Float64Array.from(drawn, (_, i) => i),
    y: drawn,
    colour,
    n: values.length,
    mark: 'violin',
  }
}

/** Per sequence: how much it had in it, and how many peaks came out. */
function sequenceTable(
  names: readonly string[],
  lengths: Readonly<Record<string, number>>,
  perSequence: ReadonlyMap<string, { regions: number; wide: number }>,
  calledOn: readonly string[],
): TableOutput {
  const peaks = new Map<string, number>()
  for (const name of calledOn) peaks.set(name, (peaks.get(name) ?? 0) + 1)
  return {
    kind: 'table',
    id: 'peaks-sequences',
    label: 'Per sequence',
    columns: [
      { key: 'sequence', label: 'Sequence', kind: 'text' },
      { key: 'length', label: 'Length', kind: 'number' },
      { key: 'regions', label: 'Concave regions', kind: 'number' },
      { key: 'wide', label: 'Wide enough', kind: 'number' },
      { key: 'peaks', label: 'Peaks', kind: 'number' },
      { key: 'density', label: 'Peaks per Mb', kind: 'number', digits: 1 },
    ],
    rows: names.map((name) => {
      const counted = perSequence.get(name) ?? { regions: 0, wide: 0 }
      const called = peaks.get(name) ?? 0
      return {
        sequence: name,
        length: lengths[name],
        regions: counted.regions,
        wide: counted.wide,
        peaks: called,
        density: (called / lengths[name]) * 1e6,
      }
    }),
  }
}

/** How many peaks each of yapc's six thresholds keeps — its six BED files, as rows. */
function thresholdTable(global: Float64Array, drawn: number): TableOutput {
  const tested = global.length
  return {
    kind: 'table',
    id: 'peaks-idr',
    label: 'IDR thresholds',
    columns: [
      { key: 'threshold', label: 'IDR ≤', kind: 'text' },
      { key: 'peaks', label: 'Peaks', kind: 'number' },
      { key: 'share', label: 'Share of tested', kind: 'number', digits: 3 },
      { key: 'drawn', label: 'Drawn', kind: 'text' },
    ],
    rows: YAPC_IDR_THRESHOLDS.map((threshold) => {
      const cut = scaledThreshold(threshold)
      let passing = 0
      for (let k = 0; k < tested; k++) if (scaledIdr(global[k]) >= cut) passing++
      return {
        threshold: String(threshold),
        peaks: passing,
        share: passing / tested,
        drawn: threshold === drawn ? 'yes' : '',
      }
    }),
  }
}

/**
 * One row per peak tested: yapc's `.tsv`.
 *
 * Starts and summits are held **0-based**, as yapc writes them and as the lane
 * and a BED saved from it keep them, and printed 1-based like every coordinate
 * a reader reads (`TableColumn.coordinate`, §26.1). They used to be held
 * 1-based, which printed right and saved a TSV whose sequence, start and end
 * this app's own reader takes as BED's (§8.3) — every peak dropped back on a
 * map a base to the right of where it was called.
 */
function peakTable(options: {
  names: readonly string[]
  contig: readonly string[]
  starts: Int32Array
  ends: Int32Array
  modes: Int32Array
  scores: readonly Float64Array[]
  tested: Int32Array
  passes: Uint8Array
  local: Float64Array | null
  global: Float64Array | null
  replicate: boolean
}): TableOutput {
  const { names, contig, starts, ends, modes, scores, tested, passes, local, global } = options
  const rows: Array<Record<string, string | number>> = []
  tested.forEach((i, k) => {
    const row: Record<string, string | number> = {
      sequence: contig[i],
      start: starts[i],
      end: ends[i],
      summit: modes[i],
      width: ends[i] - starts[i],
    }
    scores.forEach((column, t) => {
      row[`curvature${t}`] = column[i]
    })
    if (local !== null && global !== null) {
      row.local = local[k]
      row.idr = global[k]
      row.passes = passes[k] === 1 ? 'yes' : 'no'
    }
    rows.push(row)
  })
  // Strongest first: by IDR where there was a test, by curvature where not.
  if (global !== null) rows.sort((a, b) => Number(a.idr) - Number(b.idr))
  else rows.sort((a, b) => Number(b.curvature0) - Number(a.curvature0))
  return {
    kind: 'table',
    id: 'peaks-list',
    label: options.replicate ? 'Every peak tested' : 'Every peak',
    columns: [
      { key: 'sequence', label: 'Sequence', kind: 'text' },
      { key: 'start', label: 'Start', kind: 'number', coordinate: 'start' },
      { key: 'end', label: 'End', kind: 'number', coordinate: 'end' },
      { key: 'summit', label: 'Summit', kind: 'number', coordinate: 'start', hint: 'The most concave base.' },
      { key: 'width', label: 'Width', kind: 'number' },
      ...names.map((name, t) => ({
        key: `curvature${t}`,
        label: names.length === 1 ? 'Curvature' : `Curvature · ${name}`,
        kind: 'number' as const,
        digits: 2,
      })),
      ...(local !== null
        ? [
            { key: 'local', label: 'Local IDR', kind: 'number' as const, digits: 4, scientific: true },
            { key: 'idr', label: 'IDR', kind: 'number' as const, digits: 4, scientific: true },
            { key: 'passes', label: 'Passes', kind: 'text' as const },
          ]
        : []),
    ],
    rows,
  }
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function pick(values: Float64Array, at: Int32Array): Float64Array {
  const out = new Float64Array(at.length)
  for (let k = 0; k < at.length; k++) out[k] = values[at[k]]
  return out
}

function countOf(flags: Uint8Array): number {
  let total = 0
  for (const flag of flags) total += flag
  return total
}

/** How many values equal another one, which IDR's ranking has to order somehow. */
function tiesIn(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort()
  let ties = 0
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) ties++
  return ties
}

/** The `p`-quantile of some values, linearly interpolated; `NaN` for none. */
function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = Float64Array.from(values).sort()
  const at = p * (sorted.length - 1)
  const lower = Math.floor(at)
  const upper = Math.min(sorted.length - 1, lower + 1)
  return sorted[lower] + (at - lower) * (sorted[upper] - sorted[lower])
}

/** Four significant figures, grouped: `1,235`, `0.001234`. */
function significant(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '−∞' : '—'
  return Number(value.toPrecision(4)).toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

/** `I, II and III`, or the first three and a count. */
function listOf(names: readonly string[]): string {
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 3).join(', ')} and ${(names.length - 3).toLocaleString()} more`
}
