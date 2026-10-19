#!/usr/bin/env python
"""Transcribe the two tables *Loop calling* takes verbatim into `src/analysis/hiccupsTables.ts`.

    pip install numpy==2.5.4
    python scripts/make_hiccups_tables.py [SCIPY_SOURCE]

Why a generator and not numbers typed in
----------------------------------------
Both tables decide comparisons, and a comparison decided one bit differently is
a different answer rather than a rounding error.

**The λ-chunk edges** are what `cooltools.dots` sorts every pixel by before it
tests it: ``np.logspace(0, n - 1, num=n, base=2 ** (1 / 3))``, which numpy
computes as glibc's ``pow``. V8's ``Math.pow`` is not glibc's, and for eight of
the first fifty powers it lands one bit away — ``2^(13/3 · 3)`` is
``8192.000000000007`` here and ``8192`` there — so a pixel whose locally adjusted
expected falls between the two would be tested against the wrong chunk's
threshold. The edges are therefore numpy's own numbers, written out with the
shortest representation that reads back to the same double.

**The coefficients of the asymptotic series** are cephes' ``igam_asymp_coeff_d``,
the 25 × 25 table SciPy's ``poisson.sf`` evaluates the incomplete gamma function
with wherever the count is within a few standard deviations of the λ — which is
exactly where every threshold `dots` draws is decided. They live in a C header
that no installed SciPy carries, so the script reads them from a SciPy source
tree: the directory given, or the sdist of the installed version, fetched from
PyPI into a temporary directory.

`test/unit/analysis-hiccups.test.ts` holds both tables to
`test/golden/analysis/hiccups.json`, which `scripts/make_analysis_golden.py`
writes from the same numpy and SciPy.
"""

from __future__ import annotations

import io
import json
import re
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "analysis" / "hiccupsTables.ts"
HEADER = "subprojects/xsf/include/xsf/cephes/igam_asymp_coeff.h"
#: `cooltools.dots` refuses fewer than 40 λ-chunks and more than 50.
MOST_CHUNKS = 50


def scipy_header(source: Path | None) -> tuple[str, str]:
    """The text of `igam_asymp_coeff.h`, and where it was read from."""
    import scipy

    version = scipy.__version__
    if source is not None:
        return (source / HEADER).read_text(), f"scipy-{version}/{HEADER}"
    meta = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/scipy/{version}/json"))
    url = next(u["url"] for u in meta["urls"] if u["packagetype"] == "sdist")
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / "scipy.tar.gz"
        archive.write_bytes(urllib.request.urlopen(url).read())
        with tarfile.open(archive) as tar:
            member = next(m for m in tar.getmembers() if m.name.endswith(HEADER))
            text = tar.extractfile(member).read().decode()
    return text, f"scipy-{version}/{HEADER}"


def coefficients(text: str) -> list[list[float]]:
    """The `d[K][N]` table, row by row, as C wrote each number."""
    body = text[text.index("igam_asymp_coeff_d[") :]
    body = body[body.index("{") + 1 : body.index("};")]
    rows = re.findall(r"\{([^{}]*)\}", body)
    table = [[float(v) for v in row.replace("\n", " ").split(",") if v.strip()] for row in rows]
    if len(table) != 25 or any(len(row) != 25 for row in table):
        raise SystemExit(f"expected a 25 x 25 table, read {len(table)} rows")
    return table


def main(argv: list[str]) -> int:
    source = Path(argv[1]) if len(argv) > 1 else None
    text, where = scipy_header(source)
    table = coefficients(text)
    edges = np.logspace(0, MOST_CHUNKS - 1, num=MOST_CHUNKS, base=2 ** (1 / 3), dtype=np.float64)

    def number(value: float) -> str:
        return repr(float(value))

    rows = ",\n".join("  [" + ", ".join(number(v) for v in row) + "]" for row in table)
    OUT.write_text(
        f"""/**
 * The two tables *Loop calling* takes verbatim (§18.8, §18.10).
 *
 * **Generated — do not edit by hand.** `scripts/make_hiccups_tables.py` writes
 * this file; `test/unit/analysis-hiccups.test.ts` holds it to the golden that
 * `scripts/make_analysis_golden.py` builds from the same numpy and SciPy.
 *
 * - {{@link LAMBDA_EDGES}}: `np.logspace(0, 49, num=50, base=2 ** (1 / 3))` from
 *   numpy {np.__version__} — the upper edges of `cooltools.dots`' λ-chunks, the
 *   first `n` of them for `n` chunks. numpy's `pow` and V8's disagree in the
 *   last bit for eight of the fifty, so they are numbers here, not a formula.
 * - {{@link IGAM_ASYMPTOTIC}}: cephes' `igam_asymp_coeff_d`, the coefficients of
 *   the Temme series SciPy's incomplete gamma uses where `a` is close to `x`
 *   (`analysis/poisson.ts`), from `{where}`.
 */

/** The λ-chunk edges `cooltools.dots` bins a locally adjusted expected by. */
export const LAMBDA_EDGES: readonly number[] = [
  {", ".join(number(v) for v in edges)},
]

/** cephes' `igam_asymp_coeff_d[25][25]`. */
export const IGAM_ASYMPTOTIC: readonly (readonly number[])[] = [
{rows},
]
"""
    )
    print(f"wrote {OUT.relative_to(ROOT)}: {len(edges)} edges, {len(table)} x {len(table[0])} coefficients")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
