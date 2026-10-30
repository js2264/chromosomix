"""Signal by group from pyBigWig's exact means and SciPy's rank tests (validation.qmd § 23).

The groups are the names a BED writes, in their natural order, and the rest of the sequences the
tracks' headers declare: each name's intervals merged where they overlap or touch, what none of them
covers a group of its own, and every run cut into stretches on the bin grid as chromosomix cuts them
(§18.8) — one stretch where it is a bin long or shorter, else at each multiple of the bin, a piece of
less than half a bin at either end joined to the one beside it. A BINSIZE of 0 cuts nothing, as
chromosomix's default does not: each merged run of a name, and each stretch of the rest between two,
is one entry. A track's value on a stretch is
pyBigWig's exact mean over the bases it has a value for, `stats(..., exact=True)`. Each group is
summarised by NumPy (the SD over n − 1, the quartiles interpolated), and the groups are compared by
`scipy.stats.kruskal` over all of them and `scipy.stats.mannwhitneyu` pair by pair — two-sided,
asymptotic, with the continuity correction — every P adjusted with every other of the run by
`scipy.stats.false_discovery_control` (Benjamini–Hochberg). Writes OUT_PREFIX-stretches.tsv, a row a
stretch with its group and each track's mean; OUT_PREFIX-groups.tsv; and OUT_PREFIX-tests.tsv.

usage: python pybigwig_groupsignal.py FEATURES_BED BINSIZE OUT_PREFIX TRACK [TRACK ...]
"""
import os
import re
import sys

import numpy as np
import pandas as pd
import pyBigWig
from scipy import stats

features_path, binsize, prefix, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
REST = 'rest of the genome'
handles = [pyBigWig.open(path) for path in paths]
lengths = {}
for handle in handles:
    for chrom, length in handle.chroms().items():
        lengths.setdefault(chrom, length)
features = pd.read_csv(features_path, sep='\t', header=None, comment='#', usecols=[0, 1, 2, 3],
                       names=['chrom', 'start', 'end', 'name'], keep_default_na=False, dtype={'name': str})
features['name'] = features['name'].replace('', '(no name)')


def natural(text):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r'(\d+)', text)]


def merged(intervals):
    out = []
    for start, end in sorted(intervals):
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out


def cut(start, end):
    if not end > start:
        return []
    if binsize <= 0 or end - start <= binsize:
        return [[start, end]]
    pieces, at = [], start
    while at < end:
        to = min(end, (at // binsize + 1) * binsize)
        pieces.append([at, to])
        at = to
    if len(pieces) > 1 and pieces[0][1] - pieces[0][0] < binsize / 2:
        pieces[1][0] = pieces[0][0]
        pieces.pop(0)
    if len(pieces) > 1 and pieces[-1][1] - pieces[-1][0] < binsize / 2:
        pieces[-2][1] = pieces[-1][1]
        pieces.pop()
    return pieces


held = features[features['chrom'].isin(lengths)].copy()
held['start'] = held['start'].clip(lower=0)
held['end'] = np.minimum(held['end'], held['chrom'].map(lengths))
held = held[held['end'] > held['start']]
names = sorted(held['name'].unique(), key=natural) + [REST]
stretches = []
for chrom, length in lengths.items():
    here = held[held['chrom'] == chrom]
    for group, name in enumerate(names[:-1]):
        rows = here[here['name'] == name]
        for start, end in merged(zip(rows['start'], rows['end'])):
            stretches += [(chrom, a, b, group) for a, b in cut(start, end)]
    at = 0
    for start, end in merged(zip(here['start'], here['end'])):
        stretches += [(chrom, a, b, len(names) - 1) for a, b in cut(at, start)]
        at = max(at, end)
    stretches += [(chrom, a, b, len(names) - 1) for a, b in cut(at, length)]
table = pd.DataFrame(stretches, columns=['chrom', 'start', 'end', 'group'])
# A group no stretch fell in is left out, as chromosomix leaves it out.
present = [g for g in range(len(names)) if (table['group'] == g).any()]
table['group'] = table['group'].map({g: names[g] for g in present})
names = [names[g] for g in present]

summaries, tests = [], []
for path, handle in zip(paths, handles):
    track = os.path.basename(path)
    means = [handle.stats(chrom, int(start), int(end), type='mean', exact=True)[0]
             for chrom, start, end in table[['chrom', 'start', 'end']].itertuples(index=False)]
    table[track] = np.array([np.nan if value is None else value for value in means], dtype=float)
    groups = [table.loc[(table['group'] == name) & table[track].notna(), track].to_numpy() for name in names]
    every = np.concatenate(groups)
    for name, values in zip(names, groups):
        others = len(every) - len(values)
        rest = (every.sum() - values.sum()) / others if others else np.nan
        q1, median, q3 = np.quantile(values, [0.25, 0.5, 0.75]) if len(values) else (np.nan,) * 3
        summaries.append({'track': track, 'group': name, 'n': len(values),
                          'bases': int((table.loc[table['group'] == name, 'end'] - table.loc[table['group'] == name, 'start']).sum()),
                          'mean': values.mean() if len(values) else np.nan,
                          'sd': values.std(ddof=1) if len(values) > 1 else np.nan,
                          'median': median, 'q1': q1, 'q3': q3,
                          'vsRest': values.mean() - rest if len(values) else np.nan})
    kept = [(name, values) for name, values in zip(names, groups) if len(values)]
    if len(kept) > 2:
        h = stats.kruskal(*[values for _, values in kept])
        tests.append({'track': track, 'test': 'Kruskal–Wallis H', 'a': f'all {len(kept)} groups', 'b': '',
                      'difference': np.nan, 'effect': np.nan, 'statistic': h.statistic, 'p': h.pvalue})
    for i in range(len(kept)):
        for j in range(i + 1, len(kept)):
            (a, x), (b, y) = kept[i], kept[j]
            u = stats.mannwhitneyu(x, y, alternative='two-sided', method='asymptotic', use_continuity=True)
            tests.append({'track': track, 'test': 'Mann–Whitney U', 'a': a, 'b': b,
                          'difference': np.median(x) - np.median(y), 'effect': 2 * u.statistic / (len(x) * len(y)) - 1,
                          'statistic': u.statistic, 'p': u.pvalue})
tests = pd.DataFrame(tests)
tests['q'] = stats.false_discovery_control(tests['p'].to_numpy(), method='bh')
table.to_csv(f'{prefix}-stretches.tsv', sep='\t', index=False, float_format='%.10g')
pd.DataFrame(summaries).to_csv(f'{prefix}-groups.tsv', sep='\t', index=False, float_format='%.10g')
tests.to_csv(f'{prefix}-tests.tsv', sep='\t', index=False, float_format='%.10g')
