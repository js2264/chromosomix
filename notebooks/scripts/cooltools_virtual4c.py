"""A virtual 4C profile with cooltools, balanced, genome-wide (validation.qmd § 10).

One row per bin of the file; the viewpoint's own bins, and the bins it has no
stored contact with, are NaN as cooltools leaves them.

usage: python cooltools_virtual4c.py MAP_URI VIEWPOINT OUT_TSV NPROC
"""
import sys

import cooler
import cooltools

uri, viewpoint, out, nproc = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
table = cooltools.virtual4c(cooler.Cooler(uri), viewpoint, clr_weight_name='weight', nproc=nproc)
table.to_csv(out, sep='\t', index=False)
