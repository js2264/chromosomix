"""Three cis eigenvectors with cooltools, signed by a GC-content track (validation.qmd § 3).

Writes OUT_PREFIX-eigenvalues.tsv and OUT_PREFIX-eigenvectors.tsv.

usage: python cooltools_eigs_cis.py MAP_URI GC_TSV OUT_PREFIX
"""
import sys

import cooler
import cooltools
import pandas as pd

uri, gc, out = sys.argv[1:]
values, vectors = cooltools.eigs_cis(
    cooler.Cooler(uri), phasing_track=pd.read_csv(gc, sep='\t'), n_eigs=3,
    clr_weight_name='weight', ignore_diags=2, clip_percentile=99.9)
values.to_csv(f'{out}-eigenvalues.tsv', sep='\t', index=False)
vectors.to_csv(f'{out}-eigenvectors.tsv', sep='\t', index=False)
