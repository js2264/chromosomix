"""Track correlation from pyBigWig's exact window means and SciPy (validation.qmd § 18).

Every sequence the tracks share is cut into whole windows of BINSIZE bases from its start, each
track's value in a window is pyBigWig's `stats(..., exact=True)` mean — the mean over the bases
it has a value for — and every pair of tracks is correlated over the windows where both have one,
by `scipy.stats.pearsonr` or `scipy.stats.spearmanr`. Writes the square matrix as a TSV, the
tracks named by their file names.

usage: python pybigwig_correlation.py OUT_TSV BINSIZE METHOD TRACK [TRACK ...]
"""
import os
import sys

import numpy as np
import pyBigWig
from scipy import stats

out, size, method, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
handles = [pyBigWig.open(path) for path in paths]
shared = [name for name in handles[0].chroms() if all(name in h.chroms() for h in handles[1:])]
columns = []
for handle in handles:
    parts = []
    for name in shared:
        whole = handle.chroms()[name] // size
        if whole > 0:
            parts.append(np.array(handle.stats(name, 0, whole * size, nBins=whole, exact=True), dtype=float))
    columns.append(np.concatenate(parts))
measure = {'pearson': stats.pearsonr, 'spearman': stats.spearmanr}[method]
n = len(paths)
matrix = np.eye(n)
for a in range(n):
    for b in range(a + 1, n):
        both = np.isfinite(columns[a]) & np.isfinite(columns[b])
        matrix[a, b] = matrix[b, a] = measure(columns[a][both], columns[b][both])[0]
names = [os.path.basename(path) for path in paths]
with open(out, 'w') as handle:
    handle.write('\t' + '\t'.join(names) + '\n')
    for name, row in zip(names, matrix):
        handle.write(name + '\t' + '\t'.join(f'{v:.10g}' for v in row) + '\n')
