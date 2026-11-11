"""Diamond insulation and boundaries with cooltools at several windows at once (validation.qmd § 24).

usage: python cooltools_insulation_scales.py MAP_URI OUT_TSV NPROC WINDOW_BP [WINDOW_BP ...]
"""
import sys

import cooler
import cooltools

uri, out, nproc = sys.argv[1], sys.argv[2], int(sys.argv[3])
windows = [int(w) for w in sys.argv[4:]]
table = cooltools.insulation(cooler.Cooler(uri), windows, ignore_diags=2,
                             clr_weight_name='weight', min_frac_valid_pixels=0.5,
                             threshold=0.2, nproc=nproc)
table.to_csv(out, sep='\t', index=False)
