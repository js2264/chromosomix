"""Diamond insulation and boundaries with cooltools, 100 kb window (validation.qmd § 1).

usage: python cooltools_insulation.py MAP_URI OUT_TSV NPROC
"""
import sys

import cooler
import cooltools

uri, out, nproc = sys.argv[1], sys.argv[2], int(sys.argv[3])
table = cooltools.insulation(cooler.Cooler(uri), [100_000], ignore_diags=2,
                             clr_weight_name='weight', min_frac_valid_pixels=0.5,
                             threshold=0.2, nproc=nproc)
table.to_csv(out, sep='\t', index=False)
