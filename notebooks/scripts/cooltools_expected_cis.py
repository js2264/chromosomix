"""Balanced contacts per chromosome and diagonal with cooltools, unsmoothed (validation.qmd § 4).

usage: python cooltools_expected_cis.py MAP_URI OUT_TSV NPROC
"""
import sys

import cooler
import cooltools

uri, out, nproc = sys.argv[1], sys.argv[2], int(sys.argv[3])
table = cooltools.expected_cis(cooler.Cooler(uri), ignore_diags=0, smooth=False,
                               aggregate_smoothed=False, clr_weight_name='weight',
                               nproc=nproc)
table.to_csv(out, sep='\t', index=False)
