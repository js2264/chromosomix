"""Coverage against restriction sites, bin by bin (validation.qmd § 27).

Each bin's raw total coverage, cis and trans with every diagonal kept, as `cooltools.coverage` gives
it, beside the cuts in the bin, as bioframe_digest.py counts them (a cut c in the bin
start <= c < end). cooltools adds a pixel at both its ends, so a bin's own pixel on the diagonal is
counted twice; chromosomix counts it once (validation.qmd § 9), and the coverage set against the
cuts here is cooltools' total less that pixel. A bin with neither coverage nor a cut is left out of
the correlation and of the means.

Writes, beside OUT_PREFIX:
  .coverage.tsv  chrom, start, end, total, diagonal, coverage, sites: every bin of the map, `total`
                 cooltools' as it gives it, `diagonal` the bin's own pixel, `coverage` the one less
                 the other;
  .means.tsv     sites, bins, coverage: the mean coverage of the bins kept with that many cuts;
  .summary.tsv   measure, value: the bins, those kept, and Spearman's rho over them (SciPy).

usage: python cooltools_coverage_sites.py MAP_URI SITES_TSV OUT_PREFIX NPROC
"""
import sys

import cooler
import cooltools
import numpy as np
import pandas as pd
from scipy import stats

uri, sites_tsv, prefix, nproc = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
clr = cooler.Cooler(uri)
_, total = cooltools.coverage(clr, ignore_diags=0, nproc=nproc)
table = clr.bins()[['chrom', 'start', 'end']][:]
table['chrom'] = table['chrom'].astype(str)
table['total'] = total
pixels = clr.pixels()[:]
own = pixels[pixels['bin1_id'] == pixels['bin2_id']]
table['diagonal'] = np.bincount(own['bin1_id'], weights=own['count'], minlength=len(table)).astype(np.int64)
table['coverage'] = table['total'] - table['diagonal']
sites = pd.read_csv(sites_tsv, sep='\t', dtype={'chrom': str})
table = table.merge(sites[['chrom', 'start', 'end', 'sites']], on=['chrom', 'start', 'end'], how='left',
                    validate='one_to_one')
if table['sites'].isna().any():
    raise ValueError(f'{sites_tsv} has no count for {int(table["sites"].isna().sum())} bins of {uri}')
table['sites'] = table['sites'].astype(int)
table.to_csv(f'{prefix}.coverage.tsv', sep='\t', index=False)

kept = table[(table['coverage'] > 0) | (table['sites'] > 0)]
(kept.groupby('sites').agg(bins=('coverage', 'size'), coverage=('coverage', 'mean')).reset_index()
 .to_csv(f'{prefix}.means.tsv', sep='\t', index=False))
rho = stats.spearmanr(kept['sites'], kept['coverage']).statistic
pd.DataFrame([('bins', len(table)), ('kept', len(kept)), ('spearman', float(rho))], columns=['measure', 'value'],
             dtype=object).to_csv(f'{prefix}.summary.tsv', sep='\t', index=False)
