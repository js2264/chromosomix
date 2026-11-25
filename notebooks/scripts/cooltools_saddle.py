"""The saddle of each chromosome named, and the one over all of them, with cooltools (validation.qmd § 21).

cooltools' `expected_cis` — `balanced.avg`, every diagonal from the third (`ignore_diags=2`), not
smoothed — and its `saddle`, `contact_type='cis'`, over the track given: the track cut by cooltools'
`digitize` into N groups at its quantiles over each chromosome (`qrange=(0, 1)`), the bin holding the
largest value in the last, and handed to `saddle` digitized, the first two diagonals left out
(`min_diag=2`). Writes each named chromosome's N × N mean observed/expected, as CHROM, to one NPZ;
and, as `pooled`, one `saddle` over a view of every chromosome named, each still cut at its own
quantiles — the sums and counts of every chromosome's cells pooled before the mean is taken, as
cooltools pools the regions of its view.

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


def digitized_over(chrom):
    """The chromosome's track cut into N groups at its own quantiles, as cooltools' `digitize` cuts it."""
    region = view[view['chrom'] == chrom].reset_index(drop=True)
    own = track[track['chrom'] == chrom].reset_index(drop=True)
    aligned = align_track_with_cooler(own, clr, view_df=region, clr_weight_name='weight', mask_clr_bad_bins=True)
    digitized, edges = digitize(aligned.iloc[:, :4], n, qrange=(0.0, 1.0))
    column = digitized.columns[3]
    # The bin holding the largest value in group N, where `digitize` says it puts it.
    codes = digitized[column].astype(int).to_numpy()
    codes[(aligned.iloc[:, 3] == edges[-1]).to_numpy()] = n
    digitized[column] = pd.Categorical(codes, categories=digitized[column].cat.categories, ordered=True)
    return region, digitized


def mean(total, count):
    with np.errstate(invalid='ignore', divide='ignore'):
        return (total / count)[1:-1, 1:-1]


def decay_over(chroms):
    """The expected of these chromosomes alone: `saddle` checks it region for region against its view."""
    return expected[expected['region1'].isin(chroms)].reset_index(drop=True)


saddles = {}
for chrom in named:
    region, digitized = digitized_over(chrom)
    total, count = cooltools.saddle(clr, decay_over([chrom]), digitized, 'cis', n_bins=None, view_df=region,
                                    min_diag=2)
    saddles[chrom] = mean(total, count)

# The chromosomes named, in the map's order, as the app lays out the sequences it is given.
pooled = [chrom for chrom in clr.chromnames if chrom in set(named)]
parts = [digitized_over(chrom) for chrom in pooled]
regions = pd.concat([region for region, _ in parts], ignore_index=True)
# One categorical column over them all: each chromosome's codes are its own groups, 0 to N + 1. Each
# chromosome's rows of its own digitized track, which is the whole genome's bins, blank but for them.
column = parts[0][1].columns[3]
categories = parts[0][1][column].cat.categories
whole = pd.concat([digitized[digitized['chrom'] == chrom].assign(**{column: digitized[column].astype(int)})
                   for chrom, (_, digitized) in zip(pooled, parts)], ignore_index=True)
whole[column] = pd.Categorical(whole[column], categories=categories, ordered=True)
total, count = cooltools.saddle(clr, decay_over(pooled), whole, 'cis', n_bins=None, view_df=regions, min_diag=2)
saddles['pooled'] = mean(total, count)
print(f'pooled over {len(pooled)} chromosomes: {", ".join(pooled)}', file=sys.stderr)
np.savez(out, **saddles)
