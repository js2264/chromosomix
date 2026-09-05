/**
 * chromosight's presets: what each pattern is, and the thresholds tuned for it.
 *
 * **Generated — do not edit by hand.** `scripts/make_chromosight_kernels.py`
 * writes this file and `chromosightKernels.ts` beside it from the installed
 * `chromosight` package; the same package produces
 * `test/golden/analysis/chromosight.json`, and
 * `test/unit/analysis-chromosight.test.ts` compares the two.
 *
 * **The matrices are next door, and the split is a bundle decision.** The panel,
 * the form and the registry all import this module on the main thread — the
 * picker needs the names, the estimate needs the template sizes, the runner
 * needs the thresholds — and none of them needs the ten thousand numbers those
 * sizes describe. Keeping them apart is the same rule `analysis/job.ts` states
 * for descriptors and runners, applied to data: what the worker alone uses, only
 * the worker's bundle carries.
 *
 * The parameters travel with the pattern because chromosight tuned them
 * together: `pearson` is the score floor for *this* template, `maxDist` the
 * separations it is meaningful over, `minSeparation` how far apart two calls
 * must be before they are two calls rather than one smear. A port that shipped
 * the matrices and invented its own thresholds would report a different number
 * of loops from the same file and have no way to say why.
 *
 * Upstream: https://github.com/koszullab/chromosight — Matthey-Doret et al.,
 * *Computer vision for pattern detection in chromosome contact maps*,
 * Nat. Commun. 11, 5795 (2020).
 */

/** One preset: a name, the shape of its templates, and its thresholds. */
export interface ChromosightPreset {
  name: string
  blurb: string
  /** Base pairs. Patterns closer to the diagonal than this are dropped. */
  minDist: number
  /** Base pairs, and `0` means the pattern lives *on* the diagonal. */
  maxDist: number
  maxIterations: number
  /** Percent of zero pixels a window may hold and still be scored. */
  maxPercZero: number
  /** Percent of undetectable pixels a window may hold and still be scored. */
  maxPercUndetected: number
  /** Base pairs between two calls, below which the weaker one is dropped. */
  minSeparation: number
  /** Score floor: the Pearson correlation a candidate pixel must reach. */
  pearson: number
  /** The bin size the templates were drawn at, in base pairs. */
  resolution: number
  /** Whether this pattern sits on the diagonal (`maxDist === 0` upstream). */
  onDiagonal: boolean
  /** Side of each template, in bins. Several where the pattern has variants. */
  sizes: readonly number[]
}

export const CHROMOSIGHT_PRESETS: readonly ChromosightPreset[] = [
  {
    name: "loops",
    blurb: "Focal contacts between two anchors \u2014 the classic dot off the diagonal.",
    minDist: 20000,
    maxDist: 2000000,
    maxIterations: 1,
    maxPercZero: 10.0,
    maxPercUndetected: 50.0,
    minSeparation: 5000,
    pearson: 0.3,
    resolution: 2000,
    onDiagonal: false,
    sizes: [17],
  },
  {
    name: "loops_small",
    blurb: "The same, at a tighter 7\u00d77 template, for short-range dots.",
    minDist: 20000,
    maxDist: 2000000,
    maxIterations: 1,
    maxPercZero: 10.0,
    maxPercUndetected: 50.0,
    minSeparation: 5000,
    pearson: 0.5,
    resolution: 2000,
    onDiagonal: false,
    sizes: [7],
  },
  {
    name: "borders",
    blurb: "Domain boundaries: the corner where one self-interacting block ends and the next begins.",
    minDist: 0,
    maxDist: 0,
    maxIterations: 1,
    maxPercZero: 10.0,
    maxPercUndetected: 75.0,
    minSeparation: 5000,
    pearson: 0.15,
    resolution: 5000,
    onDiagonal: true,
    sizes: [17, 17, 17],
  },
  {
    name: "hairpins",
    blurb: "The fold-back signal of a hairpin, on the diagonal.",
    minDist: 0,
    maxDist: 0,
    maxIterations: 1,
    maxPercZero: 10.0,
    maxPercUndetected: 75.0,
    minSeparation: 5000,
    pearson: 0.1,
    resolution: 10000,
    onDiagonal: true,
    sizes: [15],
  },
  {
    name: "centromeres",
    blurb: "The large-scale depletion around a centromere.",
    minDist: 0,
    maxDist: 0,
    maxIterations: 1,
    maxPercZero: 30.0,
    maxPercUndetected: 50.0,
    minSeparation: 100000,
    pearson: 0.5,
    resolution: 2000,
    onDiagonal: true,
    sizes: [81],
  },
  {
    name: "stripes_left",
    blurb: "An architectural stripe running left from an anchor.",
    minDist: 60000,
    maxDist: 2000000,
    maxIterations: 1,
    maxPercZero: 80.0,
    maxPercUndetected: 50.0,
    minSeparation: 40000,
    pearson: 0.17,
    resolution: 10000,
    onDiagonal: false,
    sizes: [31],
  },
  {
    name: "stripes_right",
    blurb: "An architectural stripe running right from an anchor.",
    minDist: 60000,
    maxDist: 2000000,
    maxIterations: 1,
    maxPercZero: 80.0,
    maxPercUndetected: 50.0,
    minSeparation: 40000,
    pearson: 0.17,
    resolution: 10000,
    onDiagonal: false,
    sizes: [31],
  },
]
