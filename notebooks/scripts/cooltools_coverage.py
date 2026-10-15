"""Cis and total coverage per bin with cooltools, every diagonal kept (validation.qmd § 9).

Raw counts, or balanced by the weight column named; one row per bin of the file.

usage: python cooltools_coverage.py MAP_URI OUT_TSV NPROC [WEIGHT]
"""
import sys

import cooler
import cooltools

uri, out, nproc = sys.argv[1], sys.argv[2], int(sys.argv[3])
weight = sys.argv[4] if len(sys.argv) > 4 else None
clr = cooler.Cooler(uri)
cis, total = cooltools.coverage(clr, ignore_diags=0, clr_weight_name=weight, nproc=nproc)
table = clr.bins()[['chrom', 'start', 'end']][:]
table['cis'], table['total'] = cis, total
table.to_csv(out, sep='\t', index=False)
