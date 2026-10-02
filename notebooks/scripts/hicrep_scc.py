"""HiCRep's stratum-adjusted correlation with hicrep, every pair of maps (validation.qmd § 7).

Raw counts, h = 1, diagonals to 5 Mb, no subsampling; one row per pair and sequence.

usage: python hicrep_scc.py OUT_TSV SEQ1,SEQ2,... LABEL=MAP_URI LABEL=MAP_URI [...]
"""
import sys

import cooler
import pandas as pd
from hicrep import hicrepSCC

out, seqs = sys.argv[1], sys.argv[2].split(',')
maps = dict(m.split('=', 1) for m in sys.argv[3:])
labels, rows = list(maps), []
for i, a in enumerate(labels):
    for b in labels[i + 1:]:
        scc = hicrepSCC(cooler.Cooler(maps[a]), cooler.Cooler(maps[b]), h=1,
                        dBPMax=5_000_000, bDownSample=False, chrNames=seqs)
        rows += [dict(a=a, b=b, sequence=s, hicrep=v) for s, v in zip(seqs, scc)]
pd.DataFrame(rows).to_csv(out, sep='\t', index=False)
