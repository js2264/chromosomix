"""The saddle of each chromosome with cooltools (validation.qmd § 21).

cooltools' `expected_cis` — `balanced.avg`, every diagonal from the third (`ignore_diags=2`), not
smoothed — and its `saddle`, a chromosome at a time, `contact_type='cis'`, over the track given: the
track cut by cooltools' `digitize` into N groups at its quantiles over the chromosome
(`qrange=(0, 1)`), the bin holding the largest value in the last, and handed to `saddle` digitized,
the first two diagonals left out (`min_diag=2`). Writes each chromosome's N × N mean
observed/expected, as CHROM, to one NPZ.

usage: python cooltools_saddle.py MAP_URI TRACK_TSV N OUT_NPZ CHROM[,CHROM...]

TRACK_TSV holds chrom, start, end and the value, one row per bin of the map, with a header.
"""
import sys

import cooler
import cooltools
import numpy as np
import pandas as pd
from cooltools.api.saddle import digitize
from cooltools.lib.common import align_track_with_cooler

uri, track_path, n, out, named = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5].split(',')
clr = cooler.Cooler(uri)
track = pd.read_csv(track_path, sep='\t')
view = pd.DataFrame({'chrom': clr.chromnames, 'start': 0, 'end': clr.chromsizes.to_numpy(), 'name': clr.chromnames})
expected = cooltools.expected_cis(clr, view_df=view, ignore_diags=2, smooth=False, aggregate_smoothed=False)
saddles = {}
for chrom in named:
    region = view[view['chrom'] == chrom].reset_index(drop=True)
    decay = expected[expected['region1'] == chrom].reset_index(drop=True)
    own = track[track['chrom'] == chrom].reset_index(drop=True)
    aligned = align_track_with_cooler(own, clr, view_df=region, clr_weight_name='weight', mask_clr_bad_bins=True)
    digitized, edges = digitize(aligned.iloc[:, :4], n, qrange=(0.0, 1.0))
    column = digitized.columns[3]
    # The bin holding the largest value in group N, where `digitize` says it puts it.
    codes = digitized[column].astype(int).to_numpy()
    codes[(aligned.iloc[:, 3] == edges[-1]).to_numpy()] = n
    digitized[column] = pd.Categorical(codes, categories=digitized[column].cat.categories, ordered=True)
    total, count = cooltools.saddle(clr, decay, digitized, 'cis', n_bins=None, view_df=region, min_diag=2)
    with np.errstate(invalid='ignore', divide='ignore'):
        saddles[chrom] = (total / count)[1:-1, 1:-1]
np.savez(out, **saddles)
