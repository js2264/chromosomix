#!/usr/bin/env python
"""Transcribe chromosight's presets into `src/analysis/chromosight{Presets,Kernels}.ts`.

    pip install chromosight
    python scripts/make_chromosight_kernels.py

Why a generator and not a hand-written table
--------------------------------------------
The kernels *are* the algorithm. A loop is whatever
``artificial_template_loops_type1.txt`` says a loop looks like, and every score
this repo reports for one is a Pearson correlation against those 289 numbers —
so a typo in a transcription is not a bug that shows up as a crash, it is a
detector that quietly answers a slightly different question than the tool it
claims to agree with. Generating the module from the installed package, and
committing what comes out, is what lets the agreement be checked rather than
asserted: `test/golden/analysis/chromosight.json` is built from the same
package, and `test/unit/analysis-chromosight.test.ts` compares the two.

Two files, because two bundles
------------------------------
``chromosightPresets.ts`` is the names, the thresholds and the template *sizes*,
and the panel imports it on the main thread. ``chromosightKernels.ts`` is the
ten thousand numbers, and only the analysis worker ever reads them. Emitting one
module would put 88 kB of matrices into the bundle that draws the form.

The parameters travel with the pattern, and that is deliberate too. chromosight's
``pearson``, ``max_dist``, ``min_separation`` and the two window-quality
percentages are per pattern and were tuned per pattern; a port that shipped the
matrices and invented its own thresholds would produce a different number of
loops from the same file and have no way to say why.

Precision: eight significant digits, which is about 5e-9 relative — four orders
below the tightest tolerance anything downstream compares at, and about half the
bytes of the shortest round-trip form. The whole table is ~10,000 numbers.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import chromosight.kernels as ck

ROOT = Path(__file__).resolve().parent.parent
PRESETS_OUT = ROOT / "src" / "analysis" / "chromosightPresets.ts"
KERNELS_OUT = ROOT / "src" / "analysis" / "chromosightKernels.ts"

#: The order the picker offers them in: the two everybody runs first, then the
#: 1D patterns, then the two that are a different shape of question.
PATTERNS = (
    "loops",
    "loops_small",
    "borders",
    "hairpins",
    "centromeres",
    "stripes_left",
    "stripes_right",
)

#: What each preset is for, in one line, shown under the pattern picker.
BLURBS = {
    "loops": "Focal contacts between two anchors — the classic dot off the diagonal.",
    "loops_small": "The same, at a tighter 7×7 template, for short-range dots.",
    "borders": "Domain boundaries: the corner where one self-interacting block ends and the next begins.",
    "hairpins": "The fold-back signal of a hairpin, on the diagonal.",
    "centromeres": "The large-scale depletion around a centromere.",
    "stripes_left": "An architectural stripe running left from an anchor.",
    "stripes_right": "An architectural stripe running right from an anchor.",
}

#: Which of the presets are patterns *on* the diagonal. Derived rather than
#: listed: chromosight's own test is `max_dist == 0` in the config, and it is
#: what decides whether coordinates are forced onto the diagonal and whether the
#: pileup is symmetrised.
def on_diagonal(cfg: dict) -> bool:
    return int(cfg["max_dist"]) == 0


def number(value: float) -> str:
    """Eight significant digits, without a trailing `.0` on a whole number."""
    text = f"{float(value):.8g}"
    return text


def matrix_literal(mat: np.ndarray, indent: str) -> str:
    rows = []
    for row in mat:
        rows.append(indent + "  " + ", ".join(number(v) for v in row) + ",")
    return "\n".join(rows)


def main() -> None:
    presets: list[str] = [PRESETS_HEADER, "export const CHROMOSIGHT_PRESETS: readonly ChromosightPreset[] = ["]
    kernels: list[str] = [KERNELS_HEADER, "export const CHROMOSIGHT_KERNELS: Record<string, readonly Template[]> = {"]
    total = 0
    for name in PATTERNS:
        cfg = getattr(ck, name)
        mats = [np.asarray(k, dtype=float) for k in cfg["kernels"]]
        for mat in mats:
            if mat.shape[0] != mat.shape[1] or mat.shape[0] % 2 == 0:
                raise SystemExit(f"{name}: kernels must be square and odd, got {mat.shape}")
            total += mat.size
        presets.append("  {")
        presets.append(f"    name: {json.dumps(name)},")
        presets.append(f"    blurb: {json.dumps(BLURBS[name])},")
        presets.append(f"    minDist: {int(cfg['min_dist'])},")
        presets.append(f"    maxDist: {int(cfg['max_dist'])},")
        presets.append(f"    maxIterations: {int(cfg['max_iterations'])},")
        presets.append(f"    maxPercZero: {float(cfg['max_perc_zero'])},")
        presets.append(f"    maxPercUndetected: {float(cfg['max_perc_undetected'])},")
        presets.append(f"    minSeparation: {int(cfg['min_separation'])},")
        presets.append(f"    pearson: {float(cfg['pearson'])},")
        presets.append(f"    resolution: {int(cfg['resolution'])},")
        presets.append(f"    onDiagonal: {'true' if on_diagonal(cfg) else 'false'},")
        presets.append(f"    sizes: [{', '.join(str(m.shape[0]) for m in mats)}],")
        presets.append("  },")

        kernels.append(f"  {json.dumps(name)}: [")
        for mat in mats:
            kernels.append(f"    {{ size: {mat.shape[0]}, values: [")
            kernels.append(matrix_literal(mat, "    "))
            kernels.append("    ] },")
        kernels.append("  ],")
    presets.append("]")
    presets.append("")
    kernels.append("}")
    kernels.append("")

    written = 0
    for parts, path in ((presets, PRESETS_OUT), (kernels, KERNELS_OUT)):
        text = "\n".join(parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        written += len(text)
        print(f"wrote {path.relative_to(ROOT)}: {len(text) / 1024:.1f} kB")
    print(f"{total} kernel values in {written / 1024:.1f} kB")


PRESETS_HEADER = '''/**
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
'''

KERNELS_HEADER = '''/**
 * chromosight's preset kernel matrices.
 *
 * **Generated — do not edit by hand.** See `chromosightPresets.ts` beside this
 * file for what each pattern is and where both come from — and for why the
 * numbers live here rather than there.
 *
 * The kernels *are* the algorithm. A loop is whatever
 * `artificial_template_loops_type1.txt` says a loop looks like, and every score
 * this repo reports for one is a Pearson correlation against those 289 numbers,
 * so a typo here is not a bug that crashes: it is a detector that quietly
 * answers a slightly different question than the tool it claims to agree with.
 * Eight significant digits, which is about 5e-9 relative — four orders below the
 * tightest tolerance anything downstream compares at.
 */

/** One template: odd-sided, square, row-major. */
export interface Template {
  size: number
  values: readonly number[]
}
'''



if __name__ == "__main__":
    main()
