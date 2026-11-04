"""Four analyses of one deep map in one Python process, as a reader's script chains them with cooltools
and coolpuppy (timing.qmd, *A deep human map, start to finish*).

Each step is called as the validation calls it on its own, on the map's rungs at 10 kb and 250 kb:

1. **loops**, as § 19: `cooltools.expected_cis` with two diagonals left out, then `cooltools.dots` at
   its Python API's defaults, over every chromosome of the map, whole;
2. **insulation**, as § 1: a window of 10 bins, 100 kb, its boundaries at a prominence of 0.2;
3. **compartments**, as § 3: three cis eigenvectors on the 250-kb rung, signed by GC_TSV, the GC
   content of each of its bins (`bioframe.frac_gc`);
4. **apa**, as § 11 raw with every loop: coolpuppy's pileup of balanced counts ±50 kb about every
   loop step 1 called (`mindist=0`), over no expected (`ooe=False`).

The four outputs are written beside OUT_PREFIX: `-loops.tsv`, `-insulation.tsv`, `-eigenvalues.tsv`
and `-eigenvectors.tsv`, and `-apa.tsv`, the pileup one line per row of the window. TIMES_JSON gets,
for the start of the script, the end of its imports and the end of each step, the time since the epoch
and the CPU seconds the process and every child it has waited for have used by then — cooltools' and
coolpuppy's pools are waited for when each call returns — so that the timing can tell its start-up and
each step apart.

usage: python cooltools_pipeline.py MCOOL GC_TSV OUT_PREFIX NPROC TIMES_JSON
"""
import time

# Before anything else is imported: the interpreter's own start is what comes before this line.
_STARTED = time.time()

import json  # noqa: E402
import resource  # noqa: E402
import sys  # noqa: E402


def _cpu():
    """CPU seconds, user and system, of this process and of every child it has waited for."""
    own, children = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime


MARKS = [{'step': 'started', 'time': _STARTED, 'cpu_s': _cpu()}]


def mark(step):
    MARKS.append({'step': step, 'time': time.time(), 'cpu_s': _cpu()})


import cooler  # noqa: E402
import cooltools  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from coolpuppy import coolpup  # noqa: E402

mark('imported')

mcool, gc, out, nproc, times = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]

# 1. Loops: the expected first, which dots reads.
clr = cooler.Cooler(f'{mcool}::/resolutions/10000')
view = pd.DataFrame({'chrom': clr.chromnames, 'start': 0, 'end': [int(clr.chromsizes[c]) for c in clr.chromnames],
                     'name': clr.chromnames})
expected = cooltools.expected_cis(clr, view_df=view, ignore_diags=2, clr_weight_name='weight', nproc=nproc)
dots = cooltools.dots(clr, expected, view_df=view, clr_weight_name='weight', nproc=nproc)
dots.to_csv(f'{out}-loops.tsv', sep='\t', index=False)
mark('loops')

# 2. Insulation.
insulation = cooltools.insulation(clr, [100_000], ignore_diags=2, clr_weight_name='weight',
                                  min_frac_valid_pixels=0.5, threshold=0.2, nproc=nproc)
insulation.to_csv(f'{out}-insulation.tsv', sep='\t', index=False)
mark('insulation')

# 3. Compartments, on the coarser rung.
values, vectors = cooltools.eigs_cis(
    cooler.Cooler(f'{mcool}::/resolutions/250000'), phasing_track=pd.read_csv(gc, sep='\t'), n_eigs=3,
    clr_weight_name='weight', ignore_diags=2, clip_percentile=99.9)
values.to_csv(f'{out}-eigenvalues.tsv', sep='\t', index=False)
vectors.to_csv(f'{out}-eigenvectors.tsv', sep='\t', index=False)
mark('compartments')

# 4. The pileup over every loop step 1 called, raw.
loops = dots[['chrom1', 'start1', 'end1', 'chrom2', 'start2', 'end2']]
pileup = coolpup.pileup(clr, loops, features_format='bedpe', view_df=view, ooe=False, flank=50_000, min_diag=2,
                        mindist=0, nproc=nproc)
np.savetxt(f'{out}-apa.tsv', np.asarray(pileup['data'].iloc[0], dtype=float), delimiter='\t', fmt='%.10g')
mark('apa')

with open(times, 'w') as handle:
    json.dump({'marks': MARKS, 'loops': len(dots), 'nproc': nproc}, handle, indent=1)
