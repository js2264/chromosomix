"""Dixon et al.'s directionality index with domaincaller, 2 Mb window (validation.qmd § 2).

Each chromosome balanced and sparse, as domaincaller's own script builds it; one value per bin of the
file, NaN where domaincaller gives none.

usage: python domaincaller_di.py MAP_URI OUT_NPY
"""
import sys

import cooler
import numpy as np
from domaincaller.chromLev import Chrom

uri, out = sys.argv[1:]
clr = cooler.Cooler(uri)
di = np.full(clr.info['nbins'], np.nan)
for chrom in clr.chromnames:
    matrix = clr.matrix(balance='weight', sparse=True).fetch(chrom).tocsr()
    work = Chrom(chrom, clr.binsize, matrix)
    work.calDI(window=2_000_000)
    lo = clr.extent(chrom)[0]
    di[lo:lo + len(work.DIs)] = work.DIs
np.save(out, di)
