"""Fraction of signal in features from pyBigWig's exact sums (validation.qmd § 22).

A track's signal over an interval is the sum, base by base, of the value it has there —
pyBigWig's `stats(..., type='sum', exact=True)` — and its whole signal is that sum over every
sequence its header declares. The features are merged where they overlap or touch, as `bedtools
merge` merges them, before the FRiP is taken: the signal inside them over the whole, beside the share
of the sequences' bases they cover and the share of their own bases the track has a value for. Writes
one row a track to OUT_PREFIX-frip.tsv, and one a feature, unmerged as the BED gives them, with its
signal and its mean over the bases the track has a value for, to OUT_PREFIX-features.tsv.

usage: python pybigwig_frip.py FEATURES_BED OUT_PREFIX TRACK [TRACK ...]
"""
import os
import sys

import numpy as np
import pandas as pd
import pyBigWig

features_path, prefix, paths = sys.argv[1], sys.argv[2], sys.argv[3:]
features = pd.read_csv(features_path, sep='\t', header=None, comment='#', usecols=[0, 1, 2],
                       names=['chrom', 'start', 'end'])


def merged(frame):
    """The intervals merged where they overlap or touch, sequence by sequence."""
    runs = []
    for chrom, rows in frame[frame['end'] > frame['start']].sort_values(['chrom', 'start']).groupby('chrom', sort=False):
        start, end = None, None
        for a, b in zip(rows['start'], rows['end']):
            if start is not None and a <= end:
                end = max(end, b)
                continue
            if start is not None:
                runs.append((chrom, start, end))
            start, end = a, b
        runs.append((chrom, start, end))
    return pd.DataFrame(runs, columns=['chrom', 'start', 'end'])


runs = merged(features)
totals, each = [], []
for path in paths:
    handle = pyBigWig.open(path)
    sizes = handle.chroms()

    def stat(chrom, start, end, kind):
        value = handle.stats(chrom, int(start), int(end), type=kind, exact=True)[0]
        return np.nan if value is None else value

    total = sum(stat(chrom, 0, length, 'sum') for chrom, length in sizes.items())
    held = runs[runs['chrom'].isin(sizes)]
    widths = (held['end'] - held['start']).to_numpy()
    inside = sum(stat(*run, 'sum') for run in held.itertuples(index=False))
    with_data = sum(stat(*run, 'coverage') * width for run, width in zip(held.itertuples(index=False), widths))
    covered = widths.sum() / sum(sizes.values())
    name = os.path.basename(path)
    totals.append({'track': name, 'frip': inside / total, 'covered': covered, 'enrichment': inside / total / covered,
                   'signal': inside, 'totalSignal': total, 'inFeature': with_data / widths.sum()})
    for chrom, start, end in features.itertuples(index=False):
        if chrom not in sizes:
            continue
        signal = stat(chrom, start, end, 'sum')
        each.append({'track': name, 'contig': chrom, 'start': start, 'end': end,
                     'signal': 0.0 if np.isnan(signal) else signal, 'mean': stat(chrom, start, end, 'mean'),
                     'share': (0.0 if np.isnan(signal) else signal) / total})
    handle.close()
pd.DataFrame(totals).to_csv(f'{prefix}-frip.tsv', sep='\t', index=False, float_format='%.10g')
pd.DataFrame(each).to_csv(f'{prefix}-features.tsv', sep='\t', index=False, float_format='%.10g')
