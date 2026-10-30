#!/usr/bin/env python
"""The demo yeast Micro-C, reprocessed by cooler and cooltools, for the suites that
hold the app's subsample (SPECS §6.5) and its normalisations (§6.4, §7.5) to them.

Not a golden
------------
Nothing this script writes is committed, and nothing in it was computed once and
kept: it goes to ``test/fixtures/reprocessed/``, which is gitignored, and CI
writes it afresh on every run, in the goldens job of ``.github/workflows/test.yml``
beside the other fixtures cooler can write and with whatever cooler and cooltools
PyPI serves that day, before the suites read it. A reference that drifts — a
cooler release that balances differently, a cooltools whose sample is not the one
§6.5 describes — is therefore found on the run that installs it, not the day
somebody remembers to rebuild a JSON file.

What it writes
--------------
Three coolers, each the demo map as one of the two packages reprocesses it:

- ``subsample.cool`` — ``cooltools random-sample --count 10000000 --exact``, the
  command §6.5 names as what the contacts box draws, run through cooltools' own
  CLI with numpy's global generator seeded so that a failure is a number and not
  a flake; then ``cooler balance`` over it with the parameters the demo map's own
  weights record (``bins/weight``'s attributes), so the suite can hold the app's
  rescaled weights (§6.5, *Balanced reads stay on the file's scale*) to the
  weights cooler finds on a map that really was drawn;
- ``normalised.cool`` — a copy of the map, its ``weight`` rebalanced by
  ``cooler balance`` with the same parameters, and a second column ``vc`` from
  ``cooler balance --cis-only --max-iters 1`` with every filter off and the
  marginals left unscaled: one round of iterative correction from flat weights
  is each bin's coverage over the mean coverage, which is vanilla coverage and
  what the app divides by for ``VC`` over one chromosome;
- ``coarse.cool`` — ``cooler coarsen -k 16``, the whole genome at 16 kb in one
  block the app can balance (12,118² cells at 1 kb is not one), balanced by
  ``cooler balance`` and given a genome-wide ``vc`` the same way.

And dense blocks of each, as ``cooler``'s ``matrix()`` reads them, little-endian
float64 in row order, listed in ``manifest.json``:

- ``balanced`` — ``matrix(balance='weight')``, what the score picker's
  *balanced* draws (§6.4);
- ``vc`` — ``matrix(balance='vc')``, the app's *VC*;
- ``vcsqrt`` — the raw block times the square root of each ``vc`` product, the
  same correction at half strength: the app's *VC √*;
- ``ice`` — cooltools' ``iterative_correction_symmetric`` over the raw block
  (``iterative_correction_asymmetric`` over a block between two sequences),
  converged to a variance of 1e-24: the app's *ICE*, which balances the block on
  screen as cooltools balances a dense matrix — every diagonal kept, the main
  one counted once, no bin filtered. ``cooler balance`` with its filters off is
  not used for this: with the main diagonal kept its undamped update all but
  oscillates on a Micro-C map, whose diagonal holds most of a bin's contacts,
  and needs thousands of passes over the whole file to get anywhere.

ICE is taken over chromosomes that have a balanced form at all. At 1 kb, II, X,
XII and XVI each have a bin whose one contact is with one other bin, and no
scaling of such a matrix has equal marginals: cooltools stalls, and so would
anything else. A reference that did not converge would be no reference, so the
script refuses one rather than writing it.

Usage::

    pip install 'cooler>=0.11' cooltools     # 0.11: the main diagonal counted once
    npm run fixtures:reprocessed            # or: python scripts/reprocess_with_cooltools.py
    npx vitest run test/unit/subsample-cooltools.test.ts test/unit/normalise-cooler.test.ts
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cooler
import cooltools
import h5py
import numpy as np
from cooltools.cli import cli as cooltools_cli
from cooltools.lib.numutils import (
    iterative_correction_asymmetric,
    iterative_correction_symmetric,
)

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "demo" / "yeast" / "Yeast_microC_G2M_1kb.cool"
OUT = REPO / "test" / "fixtures" / "reprocessed"

#: The total §6.5 uses as its example: 10M of the map's 179,175,551 contacts.
CONTACTS = 10_000_000
#: numpy's global generator, which cooltools' sample draws from.
SEED = 1
#: ``cooler coarsen``'s factor for the whole-genome block.
COARSEN = 16

#: Whole chromosomes at 1 kb: the smallest, the largest, and one between.
CIS = ["I", "IV", "VII"]
#: A block between two sequences, at 16 kb, where it is dense enough to balance.
TRANS = ("IV", "VII")
#: A window across the seam between I and II, at 1 kb.
SEAM = 32

#: cooltools' convergence test, the variance of each round's damped marginals:
#: far past where the app stops, so what is left between the two is the app's.
VARIANCE = 1e-24
#: How converged a cooltools reference must be: the spread of its row sums,
#: well inside the Float32 the app's block is held in.
SPREAD = 1e-9


def run(*args: str) -> None:
    """A cooler command, as a shell would run it, its log left on stderr."""
    print("+", " ".join(args), file=sys.stderr, flush=True)
    subprocess.run([sys.executable, "-m", *args], check=True)


def balance_args(path: Path) -> list[str]:
    """The ``cooler balance`` options the map's own weights were made with."""
    with h5py.File(path, "r") as fh:
        attrs = dict(fh["bins"]["weight"].attrs)
    args = [
        "--ignore-diags", str(int(attrs["ignore_diags"])),
        "--mad-max", str(int(attrs["mad_max"])),
        "--min-nnz", str(int(attrs["min_nnz"])),
        "--min-count", str(int(attrs["min_count"])),
        "--tol", repr(float(attrs["tol"])),
    ]
    if bool(attrs.get("cis_only", False)):
        args.append("--cis-only")
    return args


#: One round from flat weights, nothing filtered and nothing rescaled: VC. cooler
#: warns that the balance did not converge, and one round is the point.
VC = [
    "--ignore-diags", "0", "--mad-max", "0", "--min-nnz", "0", "--min-count", "0",
    "--max-iters", "1", "--no-rescale-marginals", "--convergence-policy", "store_final",
]


def write_block(out: Path, name: str, values: np.ndarray) -> str:
    np.ascontiguousarray(values, dtype="<f8").tofile(out / name)
    return name


def spread(sums: np.ndarray) -> float:
    live = sums[sums > 0]
    return float(live.max() / live.min() - 1) if len(live) else 0.0


def ice(raw: np.ndarray, symmetric: bool) -> np.ndarray:
    """cooltools' iterative correction, refused where it did not converge."""
    if symmetric:
        corrected, _, (converged, rounds) = iterative_correction_symmetric(raw, 100_000, 0, VARIANCE)
        worst = spread(corrected.sum(axis=1))
    else:
        corrected, _, _, (converged, rounds) = iterative_correction_asymmetric(raw, 100_000, VARIANCE)
        worst = max(spread(corrected.sum(axis=1)), spread(corrected.sum(axis=0)))
    if not converged or worst > SPREAD:
        raise SystemExit(
            f"cooltools' iterative correction left row sums {worst:.2g} apart after {rounds} rounds; "
            "a block with no balanced form is no reference."
        )
    return corrected


def blocks(out: Path, cool: Path, regions: list[dict]) -> list[dict]:
    """Every region of *cool*, as cooler and cooltools normalise it."""
    c = cooler.Cooler(str(cool))
    written = []
    for region in regions:
        rows, cols = region["rows"], region["cols"]
        raw = np.asarray(c.matrix(balance=False)[rows[0]:rows[1], cols[0]:cols[1]], dtype=float)
        for kind in region["kinds"]:
            if kind == "balanced":
                values = c.matrix(balance="weight")[rows[0]:rows[1], cols[0]:cols[1]]
            elif kind == "vc":
                values = c.matrix(balance="vc")[rows[0]:rows[1], cols[0]:cols[1]]
            elif kind == "vcsqrt":
                w = c.bins()["vc"][:].to_numpy()
                values = raw * np.sqrt(np.outer(w[rows[0]:rows[1]], w[cols[0]:cols[1]]))
            elif kind == "ice":
                values = ice(raw, rows == cols)
            else:
                raise ValueError(kind)
            name = f"{cool.stem}.{region['id']}.{kind}.f64"
            written.append(
                {
                    "cool": cool.name,
                    "region": region["id"],
                    "rows": rows,
                    "cols": cols,
                    "kind": kind,
                    "file": write_block(out, name, values),
                }
            )
    return written


def extent(c: cooler.Cooler, chrom: str) -> list[int]:
    lo, hi = c.extent(chrom)
    return [int(lo), int(hi)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    out: Path = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    source = cooler.Cooler(str(SOURCE))
    balance = balance_args(SOURCE)

    # -- The subsample ---------------------------------------------------------
    subsample = out / "subsample.cool"
    np.random.seed(SEED)
    cooltools_cli.main(
        ["random-sample", "--count", str(CONTACTS), "--exact", str(SOURCE), str(subsample)],
        standalone_mode=False,
    )
    # The sample keeps the source's bin table, weights and all; these are cooler's
    # for the sample itself.
    run("cooler", "balance", "--force", *balance, str(subsample))
    drawn = cooler.Cooler(str(subsample))

    # -- The map as stored, rebalanced, and its coverage -----------------------
    normalised = out / "normalised.cool"
    shutil.copyfile(SOURCE, normalised)
    run("cooler", "balance", "--force", *balance, str(normalised))
    run("cooler", "balance", "--name", "vc", "--cis-only", *VC, str(normalised))

    # -- The whole genome in one block -----------------------------------------
    coarse = out / "coarse.cool"
    run("cooler", "coarsen", "-k", str(COARSEN), "-o", str(coarse), str(SOURCE))
    run("cooler", "balance", *balance, str(coarse))
    run("cooler", "balance", "--name", "vc", *VC, str(coarse))
    whole = cooler.Cooler(str(coarse))

    # VC divides by the coverage of the block on screen, and cooler's coverage is
    # a whole chromosome's (``--cis-only``) or the whole genome's: those are the
    # blocks it is compared on. A window across a seam is a statement about the
    # window, so it is held to the file's weights alone; and a block between two
    # sequences divides each axis by its own coverage, where cooler has one
    # vector for both ends of every pixel.
    every = ["balanced", "vc", "vcsqrt", "ice"]
    seam = int(source.offset(source.chromnames[1]))
    nbins = int(whole.info["nbins"])
    matrices = blocks(
        out,
        normalised,
        [{"id": chrom, "rows": extent(source, chrom), "cols": extent(source, chrom), "kinds": every} for chrom in CIS]
        + [{"id": "I-II", "rows": [seam - SEAM, seam + SEAM], "cols": [seam - SEAM, seam + SEAM], "kinds": ["balanced"]}],
    )
    matrices += blocks(
        out,
        coarse,
        [
            {"id": "genome", "rows": [0, nbins], "cols": [0, nbins], "kinds": every},
            {"id": "-".join(TRANS), "rows": extent(whole, TRANS[0]), "cols": extent(whole, TRANS[1]), "kinds": ["balanced", "ice"]},
        ],
    )

    manifest = {
        "generator": "scripts/reprocess_with_cooltools.py",
        "versions": {"cooler": cooler.__version__, "cooltools": cooltools.__version__, "numpy": np.__version__},
        "source": {
            "path": str(SOURCE.relative_to(REPO)),
            "sum": int(source.info["sum"]),
            "nnz": int(source.info["nnz"]),
        },
        "subsample": {
            "cool": subsample.name,
            "command": f"cooltools random-sample --count {CONTACTS} --exact",
            "contacts": CONTACTS,
            "seed": SEED,
            "sum": int(drawn.info["sum"]),
            "nnz": int(drawn.info["nnz"]),
            "balance": "cooler balance " + " ".join(balance),
            "ignoreDiags": int(balance[balance.index("--ignore-diags") + 1]),
        },
        "normalised": {"cool": normalised.name, "balance": "cooler balance " + " ".join(balance)},
        "coarse": {"cool": coarse.name, "factor": COARSEN, "binsize": int(whole.binsize)},
        "matrices": matrices,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {len(matrices)} blocks and three coolers to {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
