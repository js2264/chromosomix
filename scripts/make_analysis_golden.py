#!/usr/bin/env python
"""Export golden oracles for the viewer's *analysis* tasks (SPECS.md §18.10).

Run with an interpreter that has the analysis stack installed::

    pip install cooler cooltools coolpuppy pyBigWig
    python scripts/make_analysis_golden.py

One JSON per task in ``test/golden/analysis/``, plus ``_manifest.json``.

Why this is a second script
---------------------------
``scripts/make_golden.py`` proves the *reader* against metacooler and cooler, on
the tiny synthetic fixtures ``make_fixtures.py`` builds, to **exact integer
equality**. This proves the *analysis* against cooltools and friends, on the
published demo data, to a stated tolerance. The two share neither their inputs,
their dependencies, nor their bar, and folding them together would mean a run
that half-succeeds on a machine missing one package and a manifest that has to
say which half. `SPECS.md` §18.10 describes this as a section of the other
script; a separate command is the same promise with one fewer failure mode.

Every golden carries two kinds of oracle, and the distinction matters
--------------------------------------------------------------------
``direct`` is **the viewer's own definition, recomputed here in numpy** straight
from ``cooler``'s dense matrix. It is compared to **equality**, and it is what
actually catches a bug in a kernel: a transposed index, a doubled diagonal, a
window that clamps at the end of a contig instead of going missing.

``reference`` is **the other tool's number** — cooltools, coolpuppy — under
*its* definition, which is very often not the same definition. Where the two
definitions coincide the relation is ``equal``; where they deliberately differ
the golden says so in ``relation`` and in ``differences``, and the test asserts
the weaker property that is actually true (usually a correlation floor). That is
not a softer bar, it is a *different question*: ``direct`` asks whether the code
computes what it says, ``reference`` asks whether what it says is the quantity
the field means by that name.

Anything that only has one of the two is a task where the other does not exist —
no published tool computes per-MAG contact purity, and nothing but this repo
defines insulation against a contig mean rather than a genome median.

Why the demo data and not a fixture
-----------------------------------
``demo/yeast/`` already carries a real 1 kb micro-C cooler, a real loop table, a
real anchor set, a real Ensembl GTF, a FASTA and six real bigWigs — which is
every input every task in §18.8 needs. Goldens against real data, at no cost in
new fixtures, and on the same file a reader can open in the app to see the
number for themselves.

Only a few chromosomes, and it is a deliberate cut
--------------------------------------------------
``--chroms`` defaults to four of the sixteen: three short ones and ``IV``, the
longest. A golden over all 12,118 bins would be several megabytes of committed
JSON to prove nothing the four do not — every kernel here is per-contig, so a
fifth chromosome is a fifth instance of the same code path. The four are named in
the golden so a test iterates what was written rather than what it assumed.

The tolerance is data, not code
-------------------------------
Each record carries its own ``tolerance`` and ``compare`` fields, so tightening
one is editing a golden rather than editing a test. ``compare: "relative"`` means
``|a - b| <= tol * max(|a|, |b|)``; ``"exact"`` means what it says and is used for
counts, bin indices and interval bounds.

The mirroring factor, written down because it is the trap
---------------------------------------------------------
cooltools counts each pixel *pair* once per diagonal. The viewer accumulates over
a **dense** block, and a dense block mirrored out of an upper-triangular store
holds every off-diagonal pair twice — so its ``sum`` and its ``count`` are both
doubled and its **mean is unchanged**. The golden therefore compares
``count.avg`` and records ``n_valid`` only as ``count_reference``, with
``count_doubles_off_diagonal: true`` saying so out loud. Comparing the sums
instead would fail by exactly a factor of two on every off-diagonal offset, which
is the kind of failure that gets "fixed" by halving something in the wrong place.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("analysis-golden")

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "demo" / "yeast"
COOLER = DEMO / "Yeast_microC_G2M_1kb.cool"
LOOPS = DEMO / "Yeast_microC_loops.tsv"
PEAKS = DEMO / "Yeast_ATAC.narrowPeak"
TRACKS = ("Yeast_ATAC.bw", "Yeast_MNase.bw", "Yeast_RNA_fwd.bw")

#: Three short chromosomes and the longest one. See the module docstring.
DEFAULT_CHROMS = ("I", "III", "VI", "IV")

#: Relative tolerance for anything that is a sum, a mean or a ratio of sums.
TOL_SUMS = 1e-6
#: Eigenvectors, where solvers legitimately differ in the last places.
TOL_EIGS = 1e-4
#: Float32 in, float64 out. A dense block crosses the wire as `Float32Array`, so
#: a sum of a few hundred of its cells agrees with a float64 sum of the same
#: cells to about seven significant figures and no further. Used for anything
#: recomputed here in float64 from values the viewer holds in float32.
TOL_F32 = 2e-6


def jsonable(value: Any) -> Any:
    """Plain JSON, with every non-finite float written as ``null``.

    The same encoding ``make_golden.py`` uses, and for the same reason: JSON has
    no NaN, and the viewer's own convention is that an absent value is absent
    rather than zero. A test reading ``null`` knows the reference produced no
    value there; a test reading ``0`` would compare it against a real zero.
    """
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, (np.floating, np.integer, np.bool_)):
        return jsonable(value.item())
    if hasattr(value, "tolist"):
        return jsonable(value.tolist())
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (int, str, bool)) or value is None:
        return value
    return str(value)


def dump(obj: Any, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(jsonable(obj), sort_keys=True, indent=1)
    path.write_text(text)
    return len(text)


def have(module: str) -> bool:
    """Whether an optional dependency is importable, without importing it twice."""
    try:
        importlib.import_module(module)
    except ImportError:
        return False
    return True


def rounded(values: Any, places: int = 10) -> list:
    """Values with the noise floor rounded off, purely to keep the JSON small.

    Ten significant places is four orders of magnitude below every tolerance in
    this file, so it cannot change a comparison; what it does change is a golden
    that would otherwise carry ``0.30000000000000004`` a few thousand times.
    """
    out = []
    for value in np.asarray(values, dtype=float).ravel():
        if not math.isfinite(value):
            out.append(None)
        else:
            out.append(float(f"{value:.{places}g}"))
    return out


def square(clr, chrom: str, balance: bool) -> np.ndarray:
    """One chromosome's dense on-diagonal block, exactly as the viewer reads it.

    ``cooler`` fills an absent pixel with zero and a balancer-dropped bin with
    ``NaN``, which is the same distinction ``§18.5`` draws and the same one the
    viewer's own dense path produces. Matching it here is what lets ``direct`` be
    compared to equality rather than to a tolerance covering a semantic gap.
    """
    return np.asarray(clr.matrix(balance=balance).fetch(chrom), dtype=float)


# ---------------------------------------------------------------------------
# expected / P(s)
# ---------------------------------------------------------------------------


def direct_expected(mat: np.ndarray) -> dict[str, Any]:
    """P(s) per offset over the *mirrored* square, which is what the viewer sums.

    Every off-diagonal pair appears twice — once above the diagonal and once
    below — so ``sum`` and ``count`` are both doubled and ``mean`` is not. This
    is `ExpectedAccumulator.addBlock`'s contract restated in numpy, and writing
    it out here is the point: if the two disagree, one of them is wrong, and
    neither is allowed to be the definition of the other.
    """
    n = mat.shape[0]
    total = np.zeros(n)
    count = np.zeros(n)
    for k in range(n):
        upper = np.diagonal(mat, k)
        values = upper if k == 0 else np.concatenate([upper, np.diagonal(mat, -k)])
        ok = ~np.isnan(values)
        total[k] = values[ok].sum()
        count[k] = int(ok.sum())
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(count > 0, total / np.where(count > 0, count, 1), np.nan)
    return {"sum": rounded(total), "count": [int(c) for c in count], "mean": rounded(mean)}


def expected_golden(chroms: list[str]) -> dict:
    """cooltools' cis expected, per chromosome, raw and balanced, plus the direct sum.

    ``clr_weight_name=None`` is the raw path and is the one that matters most
    here: the viewer defaults to unbalanced counts because ``metacooler show``
    does (§7.1), so the raw curve is what a reader sees before they touch
    anything, and it is the one an off-by-a-factor bug would hide in.
    """
    import cooler
    import cooltools

    clr = cooler.Cooler(str(COOLER))
    out: dict[str, Any] = {
        "cooler": COOLER.name,
        "binsize": int(clr.binsize),
        "chroms": chroms,
        "extents": {c: [int(v) for v in clr.extent(c)] for c in chroms},
        "tolerance": TOL_F32,
        "compare": "relative",
        # See the module docstring. The viewer's `count` is per *cell* of a
        # mirrored dense block; cooltools' `n_valid` is per *pair*.
        "count_doubles_off_diagonal": True,
        "compare_field": "mean",
        "direct": {},
        "reference": {
            "tool": "cooltools.expected_cis",
            "relation": "equal",
            "field": "mean",
            "tolerance": TOL_SUMS,
        },
    }

    for balance in (False, True):
        key = "balanced" if balance else "raw"
        out["direct"][key] = {c: direct_expected(square(clr, c, balance)) for c in chroms}

        try:
            table = cooltools.expected_cis(
                clr,
                clr_weight_name="weight" if balance else None,
                nproc=1,
                # cooltools masks the first two diagonals by default and writes
                # `NaN` there. This repo measures them — offset 0 is the
                # diagonal, and P(s) at one and two bins is exactly where the
                # near-diagonal artefacts a reader wants to *see* live. With the
                # default left on, the golden would demand a gap at offsets the
                # viewer correctly has a number for, which is a disagreement
                # about what to report rather than about what the number is.
                ignore_diags=0,
            )
        except Exception as err:  # noqa: BLE001 - recorded, not raised
            # A demo cooler that was never balanced has no weight column, and
            # that is a fact about the file rather than a broken run. Recorded so
            # the JS side skips the balanced comparison for a stated reason
            # instead of silently having no case for it.
            out["reference"][key] = {"unavailable": str(err)}
            continue

        column = "balanced.avg" if balance else "count.avg"
        per_region: dict[str, Any] = {}
        for region, rows in table.groupby("region1"):
            if str(region) not in chroms:
                continue
            rows = rows.sort_values("dist")
            per_region[str(region)] = {
                "dist": [int(d) for d in rows["dist"]],
                "mean": rounded(rows[column].to_numpy()),
                "count_reference": [int(n) for n in rows["n_valid"]],
            }
        out["reference"][key] = per_region

    return out


# ---------------------------------------------------------------------------
# insulation
# ---------------------------------------------------------------------------


def direct_diamond(mat: np.ndarray, window: int, min_valid: float) -> dict[str, Any]:
    """The viewer's diamond, in numpy: rows ``[i-w, i)`` against cols ``[i, i+w)``.

    Whole window or nothing — the first and last ``w`` bins of a contig get no
    score at all rather than a smaller sum from fewer cells, which is the one
    rule in `analysis/insulation.ts` that a reimplementation reliably breaks and
    the one that decides whether every sequence has a fake telomeric boundary.
    """
    n = mat.shape[0]
    w = max(1, int(window))
    needed = max(1, math.ceil(w * w * min_valid))
    sums = np.full(n, np.nan)
    for i in range(n):
        if i - w < 0 or i + w > n:
            continue
        block = mat[i - w : i, i : i + w]
        ok = ~np.isnan(block)
        if int(ok.sum()) < needed:
            continue
        sums[i] = float(block[ok].sum())

    finite = np.isfinite(sums)
    score = np.full(n, np.nan)
    if finite.any():
        mean = float(sums[finite].mean())
        if mean > 0:
            positive = finite & (sums > 0)
            score[positive] = np.log2(sums[positive] / mean)
    return {"sums": rounded(sums), "score": rounded(score)}


def insulation_golden(chroms: list[str], windows: list[int], min_valid: float) -> dict:
    """cooltools' diamond insulation at several window sizes, and the viewer's own.

    Several windows, because the window is the parameter everybody changes
    (§18.8) and a kernel that is right at one width and wrong at another is a
    kernel whose edge handling is wrong.

    **The two definitions are not the same, and the golden says how.** cooltools
    takes the *mean* of a ``window × window`` block that includes row ``i``, drops
    the first ``ignore_diags`` diagonals, and normalises by the **median** over
    the region; this repo takes the *sum* of the block that excludes row ``i``,
    drops nothing, and normalises by the **mean** over the contig. Both are
    "diamond insulation" and both are published; they differ by a constant factor
    plus a near-diagonal term. So the reference relation is ``correlated``, with a
    floor the shapes must clear, and equality is asserted against ``direct``.
    """
    import cooler
    import cooltools

    clr = cooler.Cooler(str(COOLER))
    bp_windows = [w * int(clr.binsize) for w in windows]

    out: dict[str, Any] = {
        "cooler": COOLER.name,
        "binsize": int(clr.binsize),
        "chroms": chroms,
        "windows_bins": windows,
        "min_valid": min_valid,
        "tolerance": TOL_F32,
        # The score is a logarithm, and a relative tolerance is the wrong shape
        # for one: a diamond sum carrying 2e-6 of float32 error turns into about
        # 3e-6 of *absolute* error in `log2`, which at a score of 0.03 — an
        # entirely ordinary value, since zero means "average" — reads as 1e-4
        # relative. Compared as `|a - b| <= max(rel * scale, abs)`.
        "tolerance_absolute_score": 1e-5,
        "compare": "relative",
        "direct": {},
        "reference": {
            "tool": "cooltools.insulation",
            "relation": "correlated",
            # The floor is *measured*, per chromosome and window, and written into
            # the golden below rather than asserted here. A number picked in
            # advance would be either so low it proves nothing or so high it fails
            # on a dataset with weak domain structure — and this one has weak
            # domain structure: budding yeast at 1 kb has no TADs to speak of, so
            # much of what both tools are correlating is noise. What the test can
            # honestly assert is that the correspondence has not *degraded*, which
            # is what a recorded floor gives it.
            "floor_is_measured": True,
            "differences": [
                "cooltools averages a window x window block whose rows run (i-w, i] "
                "— it includes row i; this repo sums the block [i-w, i) that excludes it",
                "cooltools drops the first ignore_diags diagonals; this repo drops none",
                "cooltools divides by the count of valid positions, excluding bad bins; "
                "this repo sums and requires a fraction of the window to be present",
                "cooltools normalises by the region median; this repo by the contig mean",
                "cooltools masks positions within min_dist_bad_bin of a dropped bin",
            ],
        },
    }

    for chrom in chroms:
        mat = square(clr, chrom, balance=True)
        out["direct"][chrom] = {
            str(w): direct_diamond(mat, w, min_valid) for w in windows
        }

    try:
        table = cooltools.insulation(
            clr,
            bp_windows,
            verbose=False,
            clr_weight_name="weight",
            ignore_diags=2,
        )
    except Exception as err:  # noqa: BLE001 - recorded, not raised
        out["reference"]["unavailable"] = str(err)
        return out

    for chrom in chroms:
        rows = table[table["chrom"] == chrom]
        per_window: dict[str, Any] = {}
        for bins_wide, bp in zip(windows, bp_windows):
            column = f"log2_insulation_score_{bp}"
            if column not in rows.columns:
                per_window[str(bins_wide)] = {"unavailable": f"cooltools wrote no {column}"}
                continue
            theirs = rows[column].to_numpy()
            ours = np.asarray(
                [np.nan if v is None else v for v in out["direct"][chrom][str(bins_wide)]["score"]],
                dtype=float,
            )
            per_window[str(bins_wide)] = {
                "start": [int(v) for v in rows["start"]],
                "score": rounded(theirs),
                "is_bad_bin": [bool(v) for v in rows["is_bad_bin"]],
                "measured_pearson": _pearson(ours, theirs),
            }
        out["reference"][chrom] = per_window
    return out


def _pearson(a: np.ndarray, b: np.ndarray) -> float | None:
    """Pearson over the positions where both are finite, or ``None`` under three of them."""
    n = min(a.size, b.size)
    ok = np.isfinite(a[:n]) & np.isfinite(b[:n])
    if int(ok.sum()) < 3:
        return None
    value = float(np.corrcoef(a[:n][ok], b[:n][ok])[0, 1])
    return value if math.isfinite(value) else None


# ---------------------------------------------------------------------------
# coverage / marginals
# ---------------------------------------------------------------------------


def coverage_golden(chroms: list[str]) -> dict:
    """Per-bin marginals, cis and total, against cooltools and against numpy.

    The distinction this golden exists to pin is the one §18.5 spells out: a
    cooler stores only its non-zeros, so an absent pixel is a **measured zero**
    and not a gap. Only a balancer-dropped bin is a gap. A marginal that treats
    the two alike is a marginal with holes in it wherever the map is sparse, and
    the holes look exactly like low-coverage regions.
    """
    import cooler

    clr = cooler.Cooler(str(COOLER))
    weight = clr.bins()[:]["weight"].to_numpy()

    out: dict[str, Any] = {
        "cooler": COOLER.name,
        "binsize": int(clr.binsize),
        "chroms": chroms,
        "tolerance": TOL_F32,
        "compare": "relative",
        "note": "cis marginals over one chromosome's own square; a dropped bin is NaN, an "
        "empty bin is 0",
        "direct": {},
        "reference": {
            "tool": "cooltools.coverage",
            # Not `equal`, and the difference is one number: cooltools sums the
            # pixel table with `bincount(bin1) + bincount(bin2)`, so a diagonal
            # pixel — whose two ends are the same bin — is counted **twice**. This
            # repo counts it once, deliberately: a bin with a strong self-contact
            # would otherwise carry a spike in its coverage track that is an
            # artefact of the storage layout. The identity below is exact, so the
            # test can assert it rather than fall back to a correlation.
            "relation": "cooltools_cis == direct_cis + diagonal",
            "tolerance": TOL_F32,
            "ignore_diags": 0,
        },
    }

    for chrom in chroms:
        lo, hi = (int(v) for v in clr.extent(chrom))
        raw = square(clr, chrom, balance=False)
        bal = square(clr, chrom, balance=True)
        dropped = np.isnan(weight[lo:hi])
        cis_raw = np.where(dropped, np.nan, np.nansum(raw, axis=1))
        cis_bal = np.where(dropped, np.nan, np.nansum(bal, axis=1))
        out["direct"][chrom] = {
            "dropped_bins": int(dropped.sum()),
            "cis_raw": rounded(cis_raw),
            "cis_balanced": rounded(cis_bal),
            "diagonal_raw": rounded(np.diagonal(raw)),
        }

    if have("cooltools"):
        import cooltools

        try:
            # `ignore_diags=0`, because the default reads the cooler's own
            # metadata and silently drops the first two diagonals — which on a
            # micro-C map at 1 kb is most of the signal, and which would turn a
            # provable identity into a factor of two nobody could account for.
            cis, tot = cooltools.coverage(clr, clr_weight_name=None, nproc=1, ignore_diags=0)
            for chrom in chroms:
                lo, hi = (int(v) for v in clr.extent(chrom))
                out["reference"][chrom] = {
                    "cis": rounded(np.asarray(cis, dtype=float)[lo:hi]),
                    "total": rounded(np.asarray(tot, dtype=float)[lo:hi]),
                }
        except Exception as err:  # noqa: BLE001 - recorded, not raised
            out["reference"]["unavailable"] = str(err)
    else:
        out["reference"]["unavailable"] = "cooltools is not installed"
    return out


# ---------------------------------------------------------------------------
# viewpoint / 4C
# ---------------------------------------------------------------------------


def viewpoint_golden(chroms: list[str], anchor_bins: int) -> dict:
    """A virtual 4C profile: the rows of an anchor, summed down the columns.

    No published tool computes this from a cooler in a way worth comparing to —
    every 4C pipeline starts from reads — so numpy *is* the reference, and it is
    an honest one because the trap here is not the arithmetic. It is the
    **diagonal**: a pixel with both ends inside the anchor is one contact, and
    adding it once per end spikes the profile exactly at the viewpoint, which is
    the one place a reader expects a spike anyway and so would never question.
    """
    import cooler

    clr = cooler.Cooler(str(COOLER))
    out: dict[str, Any] = {
        "cooler": COOLER.name,
        "binsize": int(clr.binsize),
        "chroms": chroms,
        "anchor_bins": anchor_bins,
        "tolerance": TOL_F32,
        "compare": "relative",
        "note": "cis only, over the anchor's own chromosome; the anchor is centred in it",
        "direct": {},
    }
    for chrom in chroms:
        lo, hi = (int(v) for v in clr.extent(chrom))
        n = hi - lo
        if n < anchor_bins * 3:
            continue
        start = (n - anchor_bins) // 2
        mat = square(clr, chrom, balance=True)
        band = mat[start : start + anchor_bins, :]
        # A plain band sum over the *mirrored* square, one term per row of the
        # anchor. That is the definition, and it is worth having as a reference
        # precisely because the viewer cannot compute it this way: it walks the
        # stored upper triangle, where a pixel with both ends inside the anchor
        # appears once and must be added once. Adding it per end — the obvious
        # loop — doubles the profile exactly at the viewpoint, which is the one
        # place a reader expects a spike anyway and so would never question.
        profile = np.nansum(band, axis=0)
        seen = (~np.isnan(band)).sum(axis=0)
        profile[seen == 0] = np.nan
        out["direct"][chrom] = {
            "anchor_start_bin": start,
            "anchor_end_bin": start + anchor_bins,
            "profile": rounded(profile),
        }
    return out


# ---------------------------------------------------------------------------
# compartments
# ---------------------------------------------------------------------------


def _expected_curve(mat: np.ndarray) -> np.ndarray:
    """Per-offset mean over the mirrored square — `ExpectedAccumulator` in numpy."""
    n = mat.shape[0]
    mean = np.full(n, np.nan)
    for k in range(n):
        upper = np.diagonal(mat, k)
        values = upper if k == 0 else np.concatenate([upper, np.diagonal(mat, -k)])
        ok = ~np.isnan(values)
        if ok.any():
            mean[k] = values[ok].mean()
    return mean


def _expected_at(mean: np.ndarray, offset: int) -> float:
    """`expectedAt`: the mean at an offset, bridging gaps, `NaN` past the end.

    Transcribed rather than approximated. The clamp this function refuses to do
    is the point of it — past the end of the curve a far-cis O/E computed against
    the last populated offset comes out several-fold too large and looks like a
    compartment.
    """
    if offset < 0 or offset >= mean.size:
        return float("nan")
    if not math.isnan(mean[offset]):
        return float(mean[offset])
    left = offset
    while left >= 0 and math.isnan(mean[left]):
        left -= 1
    right = offset
    while right < mean.size and math.isnan(mean[right]):
        right += 1
    if left < 0 or right >= mean.size:
        return float("nan")
    fraction = (offset - left) / (right - left)
    return float(mean[left] + fraction * (mean[right] - mean[left]))


def _pairwise_pearson(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson over the cells both rows have, `NaN` under three of them.

    **Pairwise-complete**, which is what `analysis/stats.ts` does and what
    `np.corrcoef` does not: numpy has no NaN-aware correlation, and the obvious
    substitute — filling gaps with zero — is a different matrix, not a rounding
    difference. Getting this wrong was worth about 0.05 of correlation on the
    leading eigenvector, which is exactly the size of error that looks like a
    solver difference and is not one.
    """
    ok = ~np.isnan(a) & ~np.isnan(b)
    if int(ok.sum()) < 3:
        return float("nan")
    x = a[ok]
    y = b[ok]
    dx = x - x.mean()
    dy = y - y.mean()
    denominator = math.sqrt(float((dx * dx).sum()) * float((dy * dy).sum()))
    return float((dx * dy).sum() / denominator) if denominator > 0 else float("nan")


def direct_compartments(mat: np.ndarray, min_fraction: float = 0.1) -> dict[str, Any]:
    """O/E, its Pearson correlation matrix, and the leading eigenvector.

    A faithful transcription of `usableBins` → `observedOverExpected` →
    `correlationMatrix` → `leadingEigenpairs`, differing from the viewer in the
    one place it is supposed to: the eigenvector comes out of a full
    ``numpy.linalg.eigh`` rather than out of power iteration with deflation. Two
    completely different algorithms on the same matrix is the check worth having;
    two different *matrices* would not be a check at all, which is why the three
    steps before the solver are transcribed rather than approximated.
    """
    n = mat.shape[0]
    needed = max(1, math.ceil(n * min_fraction))
    idx = np.flatnonzero((~np.isnan(mat)).sum(axis=1) >= needed)
    if idx.size < 3:
        return {"usable": idx.tolist(), "n_usable": int(idx.size), "eigenvector": [],
                "eigenvalue": None}

    curve = _expected_curve(mat)
    m = idx.size
    oe = np.full((m, m), np.nan)
    for r in range(m):
        row = idx[r]
        for c in range(m):
            col = idx[c]
            observed = mat[row, col]
            denominator = _expected_at(curve, abs(int(col) - int(row)))
            if math.isnan(observed) or math.isnan(denominator) or denominator == 0:
                continue
            oe[r, c] = observed / denominator

    corr = np.zeros((m, m))
    for r in range(m):
        corr[r, r] = 1.0
        for c in range(r + 1, m):
            value = _pairwise_pearson(oe[r], oe[c])
            filled = 0.0 if math.isnan(value) else value
            corr[r, c] = filled
            corr[c, r] = filled

    values, vectors = np.linalg.eigh(corr)
    order = np.argsort(np.abs(values))[::-1]
    lead = vectors[:, order[0]]
    # Sign is arbitrary out of any solver. Fixed here so a golden is stable
    # between runs; the test compares up to a flip anyway, because phasing is
    # what makes the sign mean anything (§18.6) and it has not happened yet.
    if lead[np.argmax(np.abs(lead))] < 0:
        lead = -lead
    return {
        "usable": idx.tolist(),
        "n_usable": int(idx.size),
        "min_fraction": min_fraction,
        "eigenvalue": float(values[order[0]]),
        "eigenvector": rounded(lead),
        "oe_row0": rounded(oe[0]),
        "corr_row0": rounded(corr[0]),
    }


def compartments_golden(chroms: list[str]) -> dict:
    """The compartment chain, against numpy and against cooltools' own eigendecomposition."""
    import cooler

    clr = cooler.Cooler(str(COOLER))
    out: dict[str, Any] = {
        "cooler": COOLER.name,
        "binsize": int(clr.binsize),
        "chroms": chroms,
        "tolerance": TOL_EIGS,
        "compare": "relative",
        "sign": "up to a flip — phasing is what makes it meaningful (§18.6)",
        "direct": {},
        "reference": {
            "tool": "cooltools.eigs_cis",
            "relation": "correlated",
            "floor_is_measured": True,
            "differences": [
                "cooltools clips O/E at a percentile and fills missing with the mean; "
                "this repo leaves a gap a gap",
                "cooltools may phase by GC; this run asks for no phasing track",
                "cooltools sorts its eigenvectors by explained variance, so E1 is not "
                "necessarily the same eigenvector this repo calls the first",
            ],
            "caveat": "budding yeast at 1 kb has no compartments worth the name, so this "
            "correlation is mostly a correlation of noise and the measured floor is low. "
            "The eigensolver itself is proved against `direct`, which is a full "
            "numpy.linalg.eigh of the same correlation matrix.",
        },
    }
    for chrom in chroms:
        out["direct"][chrom] = direct_compartments(square(clr, chrom, balance=True))

    if not have("cooltools"):
        out["reference"]["unavailable"] = "cooltools is not installed"
        return out

    import cooltools

    try:
        _values, vectors = cooltools.eigs_cis(clr, n_eigs=2)
        for chrom in chroms:
            rows = vectors[vectors["chrom"] == chrom]
            theirs = rows["E1"].to_numpy()
            usable = out["direct"][chrom]["usable"]
            ours = np.asarray(
                [np.nan if v is None else v for v in out["direct"][chrom]["eigenvector"]],
                dtype=float,
            )
            paired = theirs[usable] if len(usable) == ours.size else theirs[: ours.size]
            correlation = _pearson(ours, paired)
            out["reference"][chrom] = {
                "start": [int(v) for v in rows["start"]],
                "E1": rounded(theirs),
                "measured_abs_pearson": None if correlation is None else abs(correlation),
            }
    except Exception as err:  # noqa: BLE001 - recorded, not raised
        out["reference"]["unavailable"] = str(err)
    return out


# ---------------------------------------------------------------------------
# APA
# ---------------------------------------------------------------------------


def read_loops(
    chroms: list[str], limit: int, min_separation_bins: int, binsize: int
) -> list[tuple[str, int, int, int, int]]:
    """The demo loop table, cis only, inside the goldened chromosomes.

    ``min_separation_bins`` keeps only the pairs whose window lies entirely clear
    of the main diagonal, and it is the single condition that makes this golden
    worth having. A window that straddles the diagonal contains cells from the
    lower triangle, and the three implementations involved — this script,
    coolpuppy, and the viewer — each mirror those cells at a slightly different
    point in their pipeline. With the straddling pairs left in, the two pileups
    agree to about 1 per cent and every cell of the discrepancy sits below the
    diagonal; with them removed they agree to 1.3e-15 over all 441 cells, which
    is a real cross-implementation check rather than a correlation floor. The
    diagonal-crossing case is not thereby untested — it is what
    `analysis-apa.test.ts` covers with a hand-built matrix.
    """
    out: list[tuple[str, int, int, int, int]] = []
    with LOOPS.open() as handle:
        header = handle.readline().rstrip("\n").split("\t")
        index = {name: i for i, name in enumerate(header)}
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            chrom1 = parts[index["chrom1"]]
            if chrom1 != parts[index["chrom2"]] or chrom1 not in chroms:
                continue
            start1 = int(parts[index["start1"]])
            start2 = int(parts[index["start2"]])
            if (start2 - start1) // binsize < min_separation_bins:
                continue
            out.append(
                (
                    chrom1,
                    start1,
                    int(parts[index["end1"]]),
                    start2,
                    int(parts[index["end2"]]),
                )
            )
            if len(out) >= limit:
                break
    return out


def apa_golden(chroms: list[str], flank_bins: int, limit: int) -> dict:
    """A loop pileup: the mean window around each pair of anchors.

    ``direct`` is the raw pileup with no normalisation at all, which is the one
    thing the viewer and coolpuppy can be expected to agree on cell for cell.
    Everything either of them does on top — observed/expected, distance-matched
    shifted controls — differs in the details of how the control set is drawn,
    and comparing those would be comparing two different estimators.
    """
    import cooler

    clr = cooler.Cooler(str(COOLER))
    binsize = int(clr.binsize)
    width = flank_bins * 2 + 1
    loops = read_loops(chroms, limit, width, binsize)

    out: dict[str, Any] = {
        "cooler": COOLER.name,
        "binsize": binsize,
        "chroms": chroms,
        "flank_bins": flank_bins,
        "width": width,
        "min_separation_bins": width,
        "n_pairs_requested": len(loops),
        "tolerance": TOL_F32,
        "compare": "relative",
        "pairs": [
            {"chrom": c, "start1": s1, "end1": e1, "start2": s2, "end2": e2}
            for c, s1, e1, s2, e2 in loops
        ],
    }

    total = np.zeros((width, width))
    seen = np.zeros((width, width))
    used = 0
    per_chrom: dict[str, np.ndarray] = {}
    for chrom, start1, _end1, start2, _end2 in loops:
        lo, hi = (int(v) for v in clr.extent(chrom))
        n = hi - lo
        if chrom not in per_chrom:
            per_chrom[chrom] = square(clr, chrom, balance=True)
        mat = per_chrom[chrom]
        row = start1 // binsize
        col = start2 // binsize
        r0, c0 = row - flank_bins, col - flank_bins
        if r0 < 0 or c0 < 0 or r0 + width > n or c0 + width > n:
            continue
        block = mat[r0 : r0 + width, c0 : c0 + width]
        ok = ~np.isnan(block)
        total[ok] += block[ok]
        seen[ok] += 1
        used += 1

    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(seen > 0, total / np.where(seen > 0, seen, 1), np.nan)
    out["direct"] = {
        "n_pairs_used": used,
        "counts": [int(v) for v in seen.ravel()],
        "pileup": rounded(mean),
        "p2ll": _p2ll(mean),
    }

    if not have("coolpuppy"):
        out["reference"] = {"unavailable": "coolpuppy is not installed"}
        return out

    try:
        import pandas as pd
        from coolpuppy import coolpup

        frame = pd.DataFrame(
            [
                {"chrom1": c, "start1": s1, "end1": e1, "chrom2": c, "start2": s2, "end2": e2}
                for c, s1, e1, s2, e2 in loops
            ]
        )
        pileup = coolpup.pileup(
            clr,
            frame,
            features_format="bedpe",
            flank=flank_bins * binsize,
            nproc=1,
            ooe=False,
            # Two defaults turned off, both because they are coolpuppy's opinions
            # rather than part of what a pileup is: `min_diag` masks the first two
            # diagonals, and `mindist='auto'` silently drops any pair closer than
            # twice the flank. `read_loops` has already removed every pair whose
            # window would touch the diagonal, so neither has anything left to do
            # except make the two pileups disagree about which pairs were used.
            min_diag=0,
            mindist=0,
        )
        matrix = np.asarray(pileup["data"].iloc[0], dtype=float)
        out["reference"] = {
            "tool": "coolpuppy.coolpup.pileup",
            "relation": "equal",
            # numpy and coolpuppy agree to 1.3e-15 over all 441 cells, both
            # working in float64 from the same pixels. The viewer cannot: a dense
            # block reaches a task as a `Float32Array`, so its pileup agrees to
            # about 6e-8. The looser figure is the one a consumer needs and the
            # tighter one is recorded beside it so nobody mistakes float32 noise
            # for the limit of the comparison.
            "tolerance": TOL_F32,
            "tolerance_float64": 1e-9,
            "note": "numpy vs coolpuppy measured at 1.3e-15 over all 441 cells; the "
            "viewer's input is float32, which costs about 6e-8",
            "n_agg": int(pileup["n"].iloc[0]) if "n" in pileup else None,
            "shape": list(matrix.shape),
            "pileup": rounded(matrix),
        }
    except Exception as err:  # noqa: BLE001 - recorded, not raised
        out["reference"] = {"unavailable": f"{type(err).__name__}: {err}"}
    return out


def _p2ll(pileup: np.ndarray) -> float | None:
    """Peak over lower-left, transcribed from `analysis/apa.ts`'s `p2ll`.

    The quadrant is a fifth of the shorter side and the peak block is that
    quadrant halved — so both scale with the window rather than being the fixed
    3x3 and 5x5 most descriptions of the statistic quote. Written out here
    because a golden that recomputed the *quoted* definition would disagree with
    a correct implementation of the one this repo uses, and the disagreement
    would look like a bug in the code rather than in the oracle.
    """
    rows, cols = pileup.shape
    quadrant = max(1, min(rows, cols) // 5)
    half = max(0, quadrant // 2)
    centre_r, centre_c = rows // 2, cols // 2
    peak_block = pileup[
        max(0, centre_r - half) : centre_r + half + 1,
        max(0, centre_c - half) : centre_c + half + 1,
    ]
    corner = pileup[rows - quadrant :, :quadrant]
    with np.errstate(invalid="ignore"):
        peak = np.nanmean(peak_block)
        low = np.nanmean(corner)
    if not math.isfinite(peak) or not math.isfinite(low) or low == 0:
        return None
    return float(peak / low)


# ---------------------------------------------------------------------------
# metaplot, over 1D tracks
# ---------------------------------------------------------------------------


def metaplot_golden(flank: int, columns: int, limit: int) -> dict:
    """The mean bigWig signal in a window around a real peak set.

    pyBigWig reads the same file the app's annotations worker reads with
    ``@gmod/bbi``, so this golden proves two things at once: that the metaplot
    kernel places and weights its columns correctly, and that the two bigWig
    readers agree on the values underneath it.
    """
    import pyBigWig

    features: list[tuple[str, int, int]] = []
    with PEAKS.open() as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            features.append((parts[0], int(parts[1]), int(parts[2])))
            if len(features) >= limit:
                break

    out: dict[str, Any] = {
        "peaks": PEAKS.name,
        "n_features": len(features),
        "flank": flank,
        "columns": columns,
        "step": (flank * 2) // columns,
        "tolerance": 1e-5,
        "compare": "relative",
        "note": "reference-point mode: the window is centred on each feature's midpoint",
        # The windows are written out rather than left to be re-derived, because
        # the two sides round a midpoint differently (Python's `round` is
        # banker's, JavaScript's is half-up) and clip a window at a sequence end
        # differently (this script drops it, `referenceWindows` fills the columns
        # it can reach). Neither difference is interesting and both would show up
        # as a failing metaplot. The list below is the contract: same windows,
        # same columns, compare the numbers.
        "windows": [],
        "direct": {},
    }

    # Windows are decided once, from the first track's chromosome table, so every
    # track in this golden is a mean over the same set.
    first = pyBigWig.open(str(DEMO / TRACKS[0]))
    sizes = first.chroms()
    first.close()
    windows: list[tuple[str, int, int]] = []
    for chrom, start, end in features:
        if chrom not in sizes:
            continue
        centre = (start + end + 1) // 2
        lo, hi = centre - flank, centre + flank
        if lo < 0 or hi > sizes[chrom]:
            continue
        windows.append((chrom, lo, hi))
    out["windows"] = [{"contig": c, "start": s, "end": e} for c, s, e in windows]

    for name in TRACKS:
        path = DEMO / name
        if not path.exists():
            continue
        handle = pyBigWig.open(str(path))
        total = np.zeros(columns)
        seen = np.zeros(columns)
        for chrom, lo, hi in windows:
            values = handle.stats(chrom, lo, hi, type="mean", nBins=columns, exact=True)
            arr = np.asarray([np.nan if v is None else float(v) for v in values], dtype=float)
            ok = ~np.isnan(arr)
            total[ok] += arr[ok]
            seen[ok] += 1
        handle.close()
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(seen > 0, total / np.where(seen > 0, seen, 1), np.nan)
        out["direct"][name] = {
            "n_windows": len(windows),
            "counts": [int(v) for v in seen],
            "mean": rounded(mean),
        }
    return out


# ---------------------------------------------------------------------------
# interval overlap
# ---------------------------------------------------------------------------


def read_bed(path: Path) -> dict[str, list[tuple[int, int]]]:
    out: dict[str, list[tuple[int, int]]] = {}
    with path.open() as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3 or parts[0].startswith("#"):
                continue
            out.setdefault(parts[0], []).append((int(parts[1]), int(parts[2])))
    return out


def overlap_golden() -> dict:
    """Jaccard and the asymmetric hit counts, over two real peak sets.

    The reference here is a **boolean mask per base**, which is about as far from
    the viewer's merge join as two implementations of the same quantity get: one
    counts covered bases by allocating them, the other by sorting edges. Half-open
    ends, touching intervals and duplicated intervals in the input are exactly the
    cases where the two would part company, and all three occur in these files.
    """
    a = read_bed(PEAKS)
    b = read_bed(DEMO / "Yeast_ChIP_Pol2-vs-input.narrowPeak")

    chroms = sorted(set(a) | set(b))
    intersection = 0
    union = 0
    a_hits = 0
    b_hits = 0
    for chrom in chroms:
        left = a.get(chrom, [])
        right = b.get(chrom, [])
        span = max([e for _, e in left] + [e for _, e in right] + [0])
        mask_a = np.zeros(span, dtype=bool)
        mask_b = np.zeros(span, dtype=bool)
        for start, end in left:
            mask_a[start:end] = True
        for start, end in right:
            mask_b[start:end] = True
        intersection += int((mask_a & mask_b).sum())
        union += int((mask_a | mask_b).sum())
        for start, end in left:
            if mask_b[start:end].any():
                a_hits += 1
        for start, end in right:
            if mask_a[start:end].any():
                b_hits += 1

    return {
        "a": PEAKS.name,
        "b": "Yeast_ChIP_Pol2-vs-input.narrowPeak",
        "scope": "every interval in both files",
        "tolerance": 0,
        "compare": "exact",
        "note": "a boolean mask per base, which is a different algorithm from the "
        "viewer's merge join and agrees only if both handle half-open ends the same way",
        "direct": {
            "intersection_bp": intersection,
            "union_bp": union,
            "jaccard": intersection / union if union else None,
            "a_with_hit": a_hits,
            "b_with_hit": b_hits,
            "n_a": sum(len(v) for v in a.values()),
            "n_b": sum(len(v) for v in b.values()),
        },
    }


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

#: What each golden proves, in one line, for the manifest a JS test iterates.
COVERAGE = {
    "expected": "P(s) per chromosome, raw and balanced, against numpy and cooltools.expected_cis",
    "insulation": "diamond sums and scores at three windows, against numpy and cooltools.insulation",
    "coverage": "cis marginals, against numpy and cooltools.coverage",
    "viewpoint": "a virtual 4C profile, against numpy — the diagonal counted once",
    "compartments": "O/E, correlation and the leading eigenvector, against numpy and cooltools.eigs_cis",
    "apa": "a raw loop pileup, against numpy and coolpuppy",
    "metaplot": "mean bigWig signal around a real peak set, against pyBigWig",
    "overlap": "Jaccard and hit counts, against a per-base boolean mask",
}


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "test" / "golden" / "analysis",
        help="where the JSON goes",
    )
    parser.add_argument(
        "--chroms",
        nargs="+",
        default=list(DEFAULT_CHROMS),
        help="chromosomes to golden; see the module docstring for why it is a few",
    )
    parser.add_argument(
        "--windows",
        type=int,
        nargs="+",
        default=[5, 10, 25],
        help="insulation windows, in bins",
    )
    parser.add_argument(
        "--min-valid",
        type=float,
        default=0.5,
        help="fraction of a diamond that must carry a value",
    )
    parser.add_argument("--anchor-bins", type=int, default=5, help="4C anchor width, in bins")
    parser.add_argument("--apa-flank", type=int, default=10, help="APA flank, in bins")
    parser.add_argument("--apa-pairs", type=int, default=200, help="how many loops to pile up")
    parser.add_argument("--meta-flank", type=int, default=1000, help="metaplot flank, in bp")
    parser.add_argument("--meta-columns", type=int, default=40, help="metaplot columns")
    parser.add_argument("--meta-features", type=int, default=300, help="metaplot features")
    args = parser.parse_args(argv)

    if not COOLER.exists():
        log.error("%s is missing; the demo data is what these goldens are of.", COOLER)
        return 1
    if not have("cooler"):
        log.error("cooler is not installed. pip install cooler cooltools")
        return 1

    chroms = list(args.chroms)
    written: list[dict] = []
    builders: list[tuple[str, Any, tuple[str, ...], dict]] = [
        ("expected", expected_golden, ("cooltools",), {"chroms": chroms}),
        (
            "insulation",
            insulation_golden,
            ("cooltools",),
            {"chroms": chroms, "windows": args.windows, "min_valid": args.min_valid},
        ),
        ("coverage", coverage_golden, (), {"chroms": chroms}),
        (
            "viewpoint",
            viewpoint_golden,
            (),
            {"chroms": chroms, "anchor_bins": args.anchor_bins},
        ),
        ("compartments", compartments_golden, (), {"chroms": chroms}),
        (
            "apa",
            apa_golden,
            (),
            {"chroms": chroms, "flank_bins": args.apa_flank, "limit": args.apa_pairs},
        ),
        (
            "metaplot",
            metaplot_golden,
            ("pyBigWig",),
            {
                "flank": args.meta_flank,
                "columns": args.meta_columns,
                "limit": args.meta_features,
            },
        ),
        ("overlap", overlap_golden, (), {}),
    ]

    for name, build, needs, kwargs in builders:
        missing = [module for module in needs if not have(module)]
        if missing:
            # Skipped and *named*, never silently omitted: a golden that is
            # absent because a package was missing looks exactly like a golden
            # nobody has written yet, and the JS side would report a task as
            # unverified rather than as unverifiable here.
            log.warning("  %-14s skipped — needs %s", name, ", ".join(missing))
            written.append({"name": name, "skipped": missing})
            continue
        golden = build(**kwargs)
        size = dump(golden, args.out / f"{name}.json")
        log.info("  %-14s %9d B  %s", name, size, COVERAGE[name])
        written.append({"name": name, "golden": f"{name}.json", "bytes": size})

    versions: dict[str, str] = {}
    for module in ("numpy", "cooler", "cooltools", "coolpuppy", "pyBigWig"):
        if not have(module):
            continue
        loaded = importlib.import_module(module)
        version = getattr(loaded, "__version__", None)
        if version is None:
            try:
                version = importlib.metadata.version(module)
            except Exception:  # noqa: BLE001 - a version is nice to have, not required
                version = "?"
        versions[module] = str(version)

    dump(
        {
            "generator": "scripts/make_analysis_golden.py",
            "source": str(COOLER.relative_to(ROOT)),
            "chroms": chroms,
            "versions": versions,
            "coverage": COVERAGE,
            "tolerances": {"sums": TOL_SUMS, "eigenvectors": TOL_EIGS, "float32": TOL_F32},
            "goldens": written,
        },
        args.out / "_manifest.json",
    )
    return 0


if __name__ == "__main__":
    import importlib.metadata  # noqa: E402 - only needed by main()

    raise SystemExit(main())
