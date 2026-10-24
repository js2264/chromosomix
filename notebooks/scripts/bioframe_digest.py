"""A reference's restriction sites with bioframe and Biopython (validation.qmd § 26).

`bioframe.digest` cuts each sequence of the FASTA where Biopython's `Bio.Restriction` finds the
enzyme. Its boundaries are 2 bp past the cut: Biopython's `search` gives the 1-based position of the
first base after the cut, and bioframe adds 1 to it rather than taking 1 away. SHIFT (-2 by default)
brings them back to c = s + k, the 0-based index of the first base after the top strand's cut, for a
site whose first base is s and which is cut k bases in: the cut as chromosomix writes it.

Each cut has a place on the bottom strand too, c' = s + L - k for a site of L bases, L - 2k past c:
where a read on the - strand starts, its 5' end being the bottom strand's, once the overhang the
enzyme leaves is filled in (for DpnII, ^GATC, c = s and c' = s + 4). A + end is placed among the
fragments by the top strand's cuts and a - end by the bottom strand's; fragment i is the same
fragment on both.

Writes, beside OUT_PREFIX:
  .bioframe.bed     the fragments as bioframe.digest gives them (chrom, start, end), untouched;
  .frags.bed        the fragments between the top strand's cuts, for `pairtools restrict --frags`;
  .frags-bottom.bed the same fragments between the bottom strand's;
  .cuts.tsv         every cut, a row each (chrom, cut, bottom): c and c', the cuts whose c is at 0 or at
                    the sequence's end dropped;
  .sites.tsv        the cuts in each bin of BINSIZE along each sequence, the last bin short
                    (chrom, start, end, sites): a cut is in the bin start <= c < end.

usage: python bioframe_digest.py FASTA ENZYME BINSIZE OUT_PREFIX [SHIFT]
"""
import sys

import bioframe
import numpy as np
import pandas as pd
from Bio import Restriction

fasta, enzyme, binsize, prefix = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
shift = int(sys.argv[5]) if len(sys.argv) > 5 else -2
# The site's length and where in it the top strand is cut: c' is L - 2k past c.
site = getattr(Restriction, enzyme)
apart = site.size - 2 * site.fst5
genome = bioframe.load_fasta(fasta, engine='pyfaidx')

raw = bioframe.digest(genome, enzyme)
raw.to_csv(f'{prefix}.bioframe.bed', sep='\t', header=False, index=False)

cuts, top, bottom, sites = [], [], [], []
for chrom in genome:
    length = len(genome[chrom])
    # bioframe's boundaries are [0, every site, the length]: the sites are the ones in between.
    ends = raw.loc[raw['chrom'] == chrom, 'end'].to_numpy(np.int64)[:-1] + shift
    at = np.unique(ends[(ends > 0) & (ends < length)])
    cuts.append(pd.DataFrame({'chrom': chrom, 'cut': at, 'bottom': at + apart}))
    for frags, bounds in ((top, np.r_[0, at, length]), (bottom, np.r_[0, at + apart, length])):
        frags.append(pd.DataFrame({'chrom': chrom, 'start': bounds[:-1], 'end': bounds[1:]}))
    starts = np.arange(0, length, binsize)
    sites.append(pd.DataFrame({'chrom': chrom, 'start': starts, 'end': np.minimum(starts + binsize, length),
                               'sites': np.bincount(at // binsize, minlength=len(starts))}))
pd.concat(cuts).to_csv(f'{prefix}.cuts.tsv', sep='\t', index=False)
pd.concat(top).to_csv(f'{prefix}.frags.bed', sep='\t', header=False, index=False)
pd.concat(bottom).to_csv(f'{prefix}.frags-bottom.bed', sep='\t', header=False, index=False)
pd.concat(sites).to_csv(f'{prefix}.sites.tsv', sep='\t', index=False)
