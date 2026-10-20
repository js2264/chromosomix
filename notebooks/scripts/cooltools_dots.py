"""Loops with cooltools.dots, as its Python API calls them by default (validation.qmd § 19).

The kernel is the one cooltools recommends for the map's bins, the expected `expected_cis` with its
default two diagonals left out, and every other setting `dots()`'s own: 10 Mb from the diagonal, 40
λ-chunks, an FDR of 0.1, a 20 kb clustering radius and the HiCCUPS filter. The view is the
chromosomes named, whole, in the cooler's own order, or every one of them.

usage: python cooltools_dots.py MAP_URI OUT_TSV NPROC [CHROM ...]
"""
import sys

import cooler
import cooltools
import pandas as pd

uri, out, nproc, wanted = sys.argv[1], sys.argv[2], int(sys.argv[3]), set(sys.argv[4:])
clr = cooler.Cooler(uri)
chroms = [name for name in clr.chromnames if not wanted or name in wanted]
view = pd.DataFrame({'chrom': chroms, 'start': 0, 'end': [int(clr.chromsizes[c]) for c in chroms], 'name': chroms})
expected = cooltools.expected_cis(clr, view_df=view, ignore_diags=2, clr_weight_name='weight', nproc=nproc)
dots = cooltools.dots(clr, expected, view_df=view, clr_weight_name='weight', nproc=nproc)
dots.to_csv(out, sep='\t', index=False)
