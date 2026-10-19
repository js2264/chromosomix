/**
 * Loop calling, as a descriptor: HiCCUPS, as `cooltools.dots` computes it.
 *
 * The task that answers one question — *where are the loops* — where *Pattern
 * detection* answers a wider one: chromosight matches a template, and a loop is
 * one of the five shapes it can be handed, while HiCCUPS is a test of each pixel
 * against what its own neighbourhood says it should hold, built for dots and
 * nothing else (Rao et al., Cell 159:1665, 2014). The two read the same map and
 * call different things, so they are two rows, this one first.
 *
 * It is the second caller §18.9 admits, on that section's terms: a port of a
 * published implementation, `cooltools.dots` 0.7.1 with its Python defaults,
 * and a golden that is that package's own output at every stage
 * (`test/golden/analysis/hiccups.json`). Nothing in it is this app's own: where
 * a setting is offered it is one `dots()` takes, under the name its docstring
 * gives it, and every default is `dots()`'s.
 *
 * **The kernel is the one setting with no default.** cooltools recommends the
 * HiCCUPS kernels Rao et al. used for bins of 4 to 28 kb — `w = 7, p = 4` at
 * 5 kb, `5, 2` at 10 kb, `3, 1` at 25 kb — and refuses any other resolution
 * unless it is handed kernels; its Python API takes them. So the two
 * half-widths are seeded from that table where it has an answer, and where it
 * has none — a 1 kb yeast map, a 50 kb map — the boxes are empty and the run is
 * refused until the reader fills them, rather than guessed at.
 */

import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  ParamSpec,
  Params,
  TaskAvailability,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { MAX_LAMBDA_BINS, MIN_LAMBDA_BINS, footprintOf, HICCUPS_KERNELS, recommendedKernel } from '../hiccupsShape'
import { bandTiles } from '../tiles'
import { fmt } from '../../units'
import { BALANCE_PARAM } from './shared'

/** `dots()`' `max_loci_separation`, in base pairs. */
export const DOTS_MAX_SEPARATION_BP = 10_000_000
/** `dots()`' `clustering_radius`, in base pairs. */
export const DOTS_CLUSTERING_RADIUS_BP = 20_000
/** `dots()`' `lambda_bin_fdr`. */
export const DOTS_FDR = 0.1
/** `dots()`' `n_lambda_bins`. */
export const DOTS_LAMBDA_BINS = 40

/**
 * The largest band a sequence may be read as, in cells.
 *
 * What a run holds is the raw band — `Float32`, `(reach + 1) × n` — and a ring
 * of `2w + 1` balanced rows beside it, so the band is the whole of what scales.
 * 96 million cells is 384 MB, the size Pattern detection allows its three
 * banded arrays together: mouse chr1 at 5 kb read 10 Mb deep is 79 million, and
 * a chromosome a scan cannot hold is named, with the two ways out.
 */
export const MAX_BAND_CELLS = 96_000_000

/** `bp_to_bins`: `int(bp / binsize)`, rounding toward zero as cooltools does. */
function bpToBins(bp: number, binsize: number): number {
  return binsize > 0 ? Math.trunc(bp / binsize) : 0
}

/** The kernel's two half-widths a parameter set names, or `null` where it names none. */
export function kernelShapeOf(params: Params, binsize: number): { w: number; p: number } | null {
  const recommended = recommendedKernel(binsize)
  const asked = (key: 'outer' | 'inner', fallback: number | undefined): number | null => {
    const value = params[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
    return fallback ?? null
  }
  const w = asked('outer', recommended?.w)
  const p = asked('inner', recommended?.p)
  return w === null || p === null ? null : { w, p }
}

/** `max_loci_separation` in bins: the reader's, or `dots()`' 10 Mb in this file's bins. */
export function maxSeparationOf(params: Params, binsize: number): number {
  const value = params.maxSeparation
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.round(value))
  return Math.max(1, bpToBins(DOTS_MAX_SEPARATION_BP, binsize))
}

/**
 * `clustering_radius` in base pairs: the reader's bins times the bin size, or
 * `dots()`' 20 kb.
 *
 * Asked in bins, as every distance on the matrix is (§18.2), and handed to
 * BIRCH in base pairs, which is what `dots` clusters the pixels' starts in. A
 * radius typed in bins is a length to the base pair, so the product is rounded
 * to it where it is within a millionth of one — `20,000 / 3,000 × 3,000` is not
 * quite 20,000 in floating point, and the radius decides ties.
 */
export function clusteringRadiusOf(params: Params, binsize: number): number {
  const value = params.clusteringRadius
  if (!(typeof value === 'number' && Number.isFinite(value))) return DOTS_CLUSTERING_RADIUS_BP
  const bp = Math.max(0, value) * binsize
  const whole = Math.round(bp)
  return Math.abs(bp - whole) < 1e-6 ? whole : bp
}

/** How far from the diagonal a sequence of `n` bins is read for a scan `separation` deep. */
export function readReachOf(n: number, separation: number, w: number): number {
  return Math.max(0, Math.min(separation - 1 + 2 * w, n - 1))
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  {
    kind: 'number',
    key: 'outer',
    label: 'outer half-width',
    hint: 'w: how far the donut and the other three neighbourhoods reach from a pixel.',
    default: 5,
    min: 1,
    max: 50,
    integer: true,
    unit: 'bins',
    seed: (context) => recommendedKernel(context.binsize)?.w ?? Number.NaN,
  },
  {
    kind: 'number',
    key: 'inner',
    label: 'inner half-width',
    hint: 'p: the square about a pixel none of the four counts, a loop’s own size.',
    default: 2,
    min: 0,
    max: 49,
    integer: true,
    unit: 'bins',
    seed: (context) => recommendedKernel(context.binsize)?.p ?? Number.NaN,
  },
  {
    kind: 'number',
    key: 'maxSeparation',
    label: 'furthest from the diagonal',
    hint: 'Loops whose anchors are farther apart are not looked for; 10 Mb unless changed.',
    default: 1_000,
    min: 1,
    integer: true,
    unit: 'bins',
    seed: (context) => Math.max(1, bpToBins(DOTS_MAX_SEPARATION_BP, context.binsize)),
  },
  {
    kind: 'number',
    key: 'fdr',
    label: 'false discovery rate',
    hint: 'Benjamini–Hochberg, within each λ-chunk of pixels of a like local expected.',
    default: DOTS_FDR,
    min: 0.001,
    max: 0.5,
    step: 0.001,
    section: 'Statistics',
  },
  {
    kind: 'number',
    key: 'lambdaBins',
    label: 'λ-chunks',
    hint: 'Log-spaced chunks of local expected, each corrected on its own; 40 to 50 of them.',
    default: DOTS_LAMBDA_BINS,
    min: MIN_LAMBDA_BINS,
    max: MAX_LAMBDA_BINS,
    integer: true,
    section: 'Statistics',
  },
  {
    kind: 'number',
    key: 'clusteringRadius',
    label: 'clustering radius',
    hint: 'Enriched pixels this close are one loop, at its brightest; 0 keeps every pixel, unfiltered.',
    default: 2,
    min: 0,
    unit: 'bins',
    seed: (context) => (context.binsize > 0 ? DOTS_CLUSTERING_RADIUS_BP / context.binsize : 2),
    section: 'Clusters',
  },
  {
    kind: 'toggle',
    key: 'filter',
    label: 'enrichment filter',
    hint: '1.5–2× over the four neighbourhoods, and a lone pixel only at q ≤ 0.02 summed over them.',
    default: true,
    when: (params) => !(typeof params.clusteringRadius === 'number' && params.clusteringRadius <= 0),
    section: 'Clusters',
  },
  BALANCE_PARAM,
]

/** The sequences a run will scan, and what reading them costs. */
function chosen(
  context: AnalysisContext,
  separation: number,
  w: number,
): { scanned: number; strips: number; cells: number; pixels: number; skipped: number; whole: boolean } {
  let scanned = 0
  let strips = 0
  let cells = 0
  let pixels = 0
  let skipped = 0
  let whole = true
  for (const contig of context.contigs) {
    const n = contig.bins
    const reach = readReachOf(n, separation, w)
    const band = (reach + 1) * n
    if (band > MAX_BAND_CELLS) {
      skipped++
      continue
    }
    scanned++
    strips += bandTiles(n, reach)
    cells = Math.max(cells, band)
    if (reach < n - 1) whole = false
    // The pixels whose four footprints fit: `n − 2w − d` of them at each
    // separation `d` from 2w + 2, where the lower-left reaches the second
    // diagonal, to the scan's last. A bin with no weight takes out those
    // within w of it, so this is the most a run can score.
    const last = Math.min(separation - 1, n - 1 - 2 * w - 1)
    const first = 2 * w + 2
    if (last >= first) {
      const count = last - first + 1
      pixels += count * (n - 2 * w) - (count * (first + last)) / 2
    }
  }
  return { scanned, strips, cells, pixels, skipped, whole }
}

/** The context's sequences narrowed to the ticked ones, where any are ticked. */
function tickedOnly(context: AnalysisContext, params: Params): AnalysisContext {
  const value = params.sequences
  if (!Array.isArray(value)) return context
  const names = new Set(value.filter((name): name is string => typeof name === 'string'))
  return { ...context, contigs: context.contigs.filter((contig) => names.has(contig.name)) }
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const refused = (refusal: string): CostEstimate => ({
    class: 'free',
    requests: 0,
    bytes: 0,
    note: 'Nothing to read.',
    refusal,
  })
  const shape = kernelShapeOf(params, context.binsize)
  if (shape === null) {
    return refused(
      `There are kernels for bins of 4 to 28 kb only, and this map’s are ` +
        `${context.binsize.toLocaleString()} bp. Give the kernel’s two half-widths: w 7, p 4 is the ` +
        'kernel for 5 kb bins, and w 5, p 2 the one for 10 kb.',
    )
  }
  if (shape.p >= shape.w) {
    return refused('The inner half-width must be smaller than the outer one, or the donut is empty.')
  }
  const lambdaBins = typeof params.lambdaBins === 'number' ? params.lambdaBins : DOTS_LAMBDA_BINS
  if (!(lambdaBins >= MIN_LAMBDA_BINS && lambdaBins <= MAX_LAMBDA_BINS)) {
    return refused(`The λ-chunks run from ${MIN_LAMBDA_BINS} to ${MAX_LAMBDA_BINS}.`)
  }
  if (params.balance === false) {
    return refused('Loop calling needs a balanced map; this run would read the raw counts.')
  }
  const separation = maxSeparationOf(params, context.binsize)
  const scope = tickedOnly(context, params)
  const { scanned, strips, cells, pixels, skipped, whole } = chosen(scope, separation, shape.w)
  if (scanned === 0) {
    return refused(
      skipped > 0
        ? 'Every chosen sequence would need a band bigger than a scan can hold. Bring “furthest ' +
            'from the diagonal” down, or open the file at a coarser resolution.'
        : 'Tick at least one sequence.',
    )
  }
  const footprint = HICCUPS_KERNELS.reduce((sum, kernel) => sum + footprintOf(shape, kernel).dr.length, 0)
  return {
    class: 'scan',
    // A raw band and the weights: four requests a strip, as Pattern detection reads one.
    requests: strips * 4,
    bytes: cells * 4,
    note:
      `${scanned.toLocaleString()} ${scanned === 1 ? 'sequence' : 'sequences'} read raw ` +
      (whole
        ? `${scanned === 1 ? 'whole' : 'each whole'}`
        : `as a band ${(readReachOf(Number.MAX_SAFE_INTEGER, separation, shape.w) + 1).toLocaleString()} bins deep`) +
      ` — up to ${fmt.bytes(cells * 4)} at a time — then four neighbourhoods of ${footprint} ` +
      `cells summed about each of up to ${formatCount(pixels)} pixels.` +
      `${skipped > 0 ? ` ${skipped.toLocaleString()} past the size limit will be skipped.` : ''}`,
  }
}

function formatCount(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)} billion`
  if (count >= 1e7) return `${(count / 1e6).toFixed(0)} million`
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)} million`
  return Math.round(count).toLocaleString()
}

/**
 * Runnable wherever there is a balanced map.
 *
 * Waiting, not absent, on a map with no weights: `dots` refuses raw data because
 * its local expected is built from the balanced map and scaled back to counts
 * for the Poisson test, and a file can be balanced — which is what the sentence
 * says to do.
 */
function availability(context: AnalysisContext): TaskAvailability {
  if (!context.hasMap) return waitingFor(NEEDS_MAP)
  if (!context.hasWeights) {
    return waitingFor(
      'Loop calling needs a balanced map. This file has no balancing weights: run `cooler balance` ' +
        'on it.',
    )
  }
  return READY
}

export const HICCUPS_TASK: AnalysisTask = {
  id: 'loops',
  title: 'Loop calling',
  blurb: 'Call loops as pixels enriched over their local background.',
  keywords: ['loops', 'dots', 'call loops', 'hiccups', 'peaks', 'cooltools dots'],
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability,
  params: PARAMS,
  outputs: ['intervals', 'curve', 'table'],
  estimate,
}
