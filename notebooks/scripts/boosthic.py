"""Boost-HiC on one sequence of a cooler, as its main.py runs it (validation.qmd § 12).

The sequence's own block of raw counts, dense and symmetric as main.py loads a
HiC-Pro matrix; `get_outliers`, then main.py's `BoostHiC` — `SCN`, `fastFloyd` on
`1/SCN**alpha`, `adjustPdS` — at main.py's alpha of 0.2, through Boost-HiC's own
`HiCutils`. Writes OUT_PREFIX-kept.npy, the bins the outlier filter kept (indices
into the sequence), and OUT_PREFIX-boosted.npy, `boostedmat` over those bins in
SCN units, which is what main.py writes.

`HiCutils` is read from a checkout of LeopoldC/Boost-HiC, at BOOSTHIC_DIR or
`../Boost-HiC` beside the repository. It does not import as committed: the first
statement of `clean_out`, which main.py never calls, sits at column zero. That
line is put back inside its function, in memory, and nothing else is touched.

usage: python boosthic.py MAP_URI SEQUENCE OUT_PREFIX [ALPHA]
"""
import os
import sys
import types
from pathlib import Path

import cooler
import numpy as np

REPO = Path(__file__).resolve().parents[2]
BOOSTHIC = Path(os.environ.get('BOOSTHIC_DIR', REPO.parent / 'Boost-HiC'))
sys.path.insert(0, str(BOOSTHIC))
sys.dont_write_bytecode = True


def hicutils():
    path = BOOSTHIC / 'HiCutils.py'
    source = path.read_text().replace('\ndata[pos_out] = 0\n', '\n\tdata[pos_out] = 0\n')
    module = types.ModuleType('HiCutils')
    module.__file__ = str(path)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


HiCutils = hicutils()
uri, sequence, out = sys.argv[1:4]
alpha = float(sys.argv[4]) if len(sys.argv) > 4 else 0.2

basemat = np.asarray(cooler.Cooler(uri).matrix(balance=False).fetch(sequence), dtype=float)
pos_out = HiCutils.get_outliers(basemat)
basematfilter = np.copy(basemat[np.ix_(~pos_out, ~pos_out)])
with np.errstate(divide='ignore'):
    normmat = HiCutils.SCN(np.copy(basematfilter))
    FFmat = np.power(HiCutils.fastFloyd(1 / np.power(normmat.copy(), alpha)), -1 / alpha)
boostedmat = HiCutils.adjustPdS(normmat, FFmat)
np.save(f'{out}-kept.npy', np.flatnonzero(~pos_out))
np.save(f'{out}-boosted.npy', boostedmat)
