#!/usr/bin/env python
"""Export the golden oracle for the Boost-HiC port (SPECS.md §6.5).

Run with numpy, h5py, scikit-learn and scikit-image installed, and a checkout of
Boost-HiC beside this repository (or named in ``BOOSTHIC_DIR``)::

    git clone https://github.com/LeopoldC/Boost-HiC ../Boost-HiC
    pip install numpy h5py scikit-learn scikit-image scipy
    python scripts/make_boost_golden.py

It writes ``test/golden/analysis/boost_hic.json``: a map, and what Boost-HiC's
own Python makes of it, step by step, exactly as ``main.py`` runs it —
``get_outliers``, ``SCN``, ``fastFloyd`` on ``1/SCN**alpha``, ``adjustPdS`` —
so ``test/unit/resample-boost.test.ts`` can hold ``src/metacooler/boost.ts``
against every intermediate and not only the end.

The map is the first 100 kb of chromosome I from the demo cooler, thinned to
half a percent of its contacts so that it has the holes Boost-HiC exists to
fill: the demo is 179 million contacts deep, and a map with no zeros in it would
leave the shortest paths nothing to do.
"""

import json
import os
import sys

import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BOOSTHIC = os.environ.get("BOOSTHIC_DIR", os.path.join(os.path.dirname(ROOT), "Boost-HiC"))
sys.path.insert(0, BOOSTHIC)
# Boost-HiC's checkout is read, not written: no `__pycache__` left behind in it.
sys.dont_write_bytecode = True


def load_hicutils():
    """Boost-HiC's ``HiCutils``, as committed — with one line re-indented.

    The module does not import as it stands upstream: ``clean_out``, which
    ``main.py`` never calls, has its first statement at column zero (an
    ``IndentationError`` since commit a615aff). That line is put back inside its
    function here, in memory, and nothing else is touched.
    """
    import types

    path = os.path.join(BOOSTHIC, "HiCutils.py")
    with open(path) as handle:
        source = handle.read()
    source = source.replace("\ndata[pos_out] = 0\n", "\n\tdata[pos_out] = 0\n")
    module = types.ModuleType("HiCutils")
    module.__file__ = path
    exec(compile(source, path, "exec"), module.__dict__)
    return module


HiCutils = load_hicutils()

COOLER = os.path.join(ROOT, "demo", "yeast", "Yeast_microC_G2M_1kb.cool")
OUT = os.path.join(ROOT, "test", "golden", "analysis", "boost_hic.json")
BINS = 100
FRACTION = 0.005
ALPHA = 0.2  # main.py's value
SEED = 20260928


def dense_chrom_block(path, first_bins):
    """The upper-triangle pixels of the first bins of the first chromosome, mirrored."""
    with h5py.File(path, "r") as f:
        offsets = f["indexes/bin1_offset"][: first_bins + 1]
        lo, hi = int(offsets[0]), int(offsets[first_bins])
        bin1 = f["pixels/bin1_id"][lo:hi]
        bin2 = f["pixels/bin2_id"][lo:hi]
        count = f["pixels/count"][lo:hi]
    keep = bin2 < first_bins
    mat = np.zeros((first_bins, first_bins))
    mat[bin1[keep], bin2[keep]] = count[keep]
    return mat


def thin(mat, fraction, seed):
    """Keep each contact with probability `fraction`, upper triangle then mirror."""
    rng = np.random.default_rng(seed)
    upper = np.triu(mat)
    kept = rng.binomial(upper.astype(np.int64), fraction).astype(float)
    return kept + np.triu(kept, 1).T


def main():
    full = dense_chrom_block(COOLER, BINS)
    basemat = thin(full, FRACTION, SEED)

    # main.py, verbatim in substance.
    pos_out = HiCutils.get_outliers(basemat)
    filtered = np.copy(basemat[np.ix_(~pos_out, ~pos_out)])
    normmat = HiCutils.SCN(np.copy(filtered))
    with np.errstate(divide="ignore"):
        distances = 1 / np.power(normmat.copy(), ALPHA)
    shortest = HiCutils.fastFloyd(distances)
    with np.errstate(divide="ignore"):
        ffmat = np.power(shortest, -1 / ALPHA)
    boosted = HiCutils.adjustPdS(normmat, ffmat)

    rows, cols = np.nonzero(np.triu(basemat))
    golden = {
        "source": "demo/yeast/Yeast_microC_G2M_1kb.cool, chromosome I, first %d bins" % BINS,
        "fraction": FRACTION,
        "alpha": ALPHA,
        "n": BINS,
        "pixels": [[int(r), int(c), int(basemat[r, c])] for r, c in zip(rows, cols)],
        "kept": [int(i) for i in np.nonzero(~pos_out)[0]],
        # Twelve significant digits: three orders inside the tolerance, and a
        # third of the bytes of `repr`.
        "scn": [float("%.12g" % v) for v in normmat.ravel()],
        "boosted": [float("%.12g" % v) for v in boosted.ravel()],
        "tolerance": 1e-9,
        "generator": "scripts/make_boost_golden.py against LeopoldC/Boost-HiC HiCutils.py",
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as handle:
        json.dump(golden, handle, separators=(",", ":"))
    print("wrote", OUT, "kept", len(golden["kept"]), "of", BINS, "bins,",
          int(basemat[np.triu_indices(BINS)].sum()), "contacts")


if __name__ == "__main__":
    main()
