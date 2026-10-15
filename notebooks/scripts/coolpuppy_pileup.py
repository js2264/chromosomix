"""A pileup with coolpuppy (validation.qmd § 11).

Balanced counts, each window ±FLANK bp about each loop, cut as coolpuppy cuts one by default:
from the upper triangle, the first MIN_DIAG diagonals left out, and every loop nearer the
diagonal than coolpuppy's `mindist='auto'` — twice the flank and two bins — left out, unless
--mindist says otherwise (0 keeps every loop). With --expected, every window is divided by
the expected — cooltools' `expected_cis`, read as `balanced.avg` — before the mean
(`ooe=True`). With --local, FEATURES is a BED and the windows sit on the diagonal. With
--nshifts, the pileup is divided by that of NSHIFTS controls per loop, each moved along the
diagonal by MINSHIFT to MAXSHIFT bp either way, with coolpuppy's seed. Writes the pileup as a
TSV, one line per row of the window.

usage: python coolpuppy_pileup.py MAP_URI FEATURES FLANK OUT_TSV NPROC [--min-diag N]
           [--mindist BP] [--expected TSV] [--local]
           [--nshifts N --minshift BP --maxshift BP --seed S]
"""
import argparse

import cooler
import numpy as np
import pandas as pd
from coolpuppy import coolpup

parser = argparse.ArgumentParser()
for name in ('uri', 'features'):
    parser.add_argument(name)
parser.add_argument('flank', type=int)
parser.add_argument('out')
parser.add_argument('nproc', type=int)
parser.add_argument('--min-diag', type=int, default=2)
parser.add_argument('--mindist', type=int)
parser.add_argument('--expected')
parser.add_argument('--local', action='store_true')
for name in ('nshifts', 'minshift', 'maxshift', 'seed'):
    parser.add_argument(f'--{name}', type=int)
args = parser.parse_args()

if args.local:
    features = pd.read_csv(args.features, sep='\t', header=None, usecols=range(3), names=['chrom', 'start', 'end'])
    options = dict(features_format='bed', local=True)
else:
    features = pd.read_csv(args.features, sep='\t', header=None, usecols=range(6),
                           names=['chrom1', 'start1', 'end1', 'chrom2', 'start2', 'end2'])
    options = dict(features_format='bedpe')
    if args.mindist is not None:
        options.update(mindist=args.mindist)
if args.expected is not None:
    options.update(expected_df=pd.read_csv(args.expected, sep='\t'), ooe=True)
else:
    options.update(ooe=False)
if args.nshifts:
    options.update(nshifts=args.nshifts, minshift=args.minshift, maxshift=args.maxshift, seed=args.seed)
pileup = coolpup.pileup(cooler.Cooler(args.uri), features, flank=args.flank, min_diag=args.min_diag,
                        nproc=args.nproc, **options)
np.savetxt(args.out, np.asarray(pileup['data'].iloc[0], dtype=float), delimiter='\t', fmt='%.10g')
