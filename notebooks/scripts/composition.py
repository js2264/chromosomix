"""GC content per bin with bioframe, and GC skew with Biopython (validation.qmd § 16).

Bins of BINSIZE along each sequence of the FASTA's index, the last one short:
`bioframe.frac_gc` counts G and C over the bases that are not N, and Biopython's
`GC_skew` is (G − C)/(G + C) over consecutive windows of the same width.

usage: python composition.py FASTA BINSIZE OUT_TSV
"""
import sys

import bioframe
import pandas as pd
from Bio.SeqUtils import GC_skew

fasta, binsize, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
genome = bioframe.load_fasta(fasta, engine='pyfaidx')
sizes = pd.read_csv(f'{fasta}.fai', sep='\t', header=None, usecols=[0, 1], index_col=0).iloc[:, 0]
table = bioframe.frac_gc(bioframe.binnify(sizes, binsize), genome)
table['skew'] = [skew for chrom in sizes.index for skew in GC_skew(str(genome[chrom][:]), window=binsize)]
table.to_csv(out, sep='\t', index=False)
