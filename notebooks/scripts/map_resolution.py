"""The map report's resolution ladder, from cooler's own rungs (validation.qmd § 29).

At every resolution an .mcool stores, each bin's contact ends — a pixel counted once at each of its
two bins, so a contact within one bin twice for it, as Juicer's calculate_map_resolution.sh counts —
summed from that rung's own pixel table with numpy, and what the map report says of them: how many
bins, the mean and the median, the count at least 80 % of bins reach (the order statistic at
floor(0.2 · bins)), and the share of bins that are empty and that hold under a tenth of the median.
Each rung is read as `cooler zoomify` wrote it, so a row is the file's coarsening and not a sum the
app made; every bin of every sequence counts, a sequence's short last bin included.

usage: python map_resolution.py MCOOL OUT_TSV
"""
import sys

import cooler
import numpy as np
import pandas as pd

path, out = sys.argv[1], sys.argv[2]
rows = []
for uri in cooler.fileops.list_coolers(path):
    clr = cooler.Cooler(f'{path}::{uri}')
    ends = np.zeros(clr.info['nbins'])
    for lo in range(0, clr.info['nnz'], 10_000_000):
        chunk = clr.pixels()[lo:lo + 10_000_000]
        np.add.at(ends, chunk['bin1_id'].to_numpy(), chunk['count'].to_numpy(dtype=float))
        np.add.at(ends, chunk['bin2_id'].to_numpy(), chunk['count'].to_numpy(dtype=float))
    values = np.sort(ends)
    n = len(values)
    median = float(np.median(values))
    rows.append({
        'binsize': clr.binsize,
        'bins': n,
        'mean': float(values.mean()),
        'median': median,
        'reached80': float(values[int(np.floor(0.2 * n))]),
        'empty': float((values == 0).mean()),
        'belowTenthMedian': float((values < median / 10).mean()),
    })
pd.DataFrame(rows).sort_values('binsize', ascending=False).to_csv(out, sep='\t', index=False)
