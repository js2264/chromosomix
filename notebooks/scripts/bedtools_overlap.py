"""Overlap of two interval sets with bedtools, and its shuffled null (validation.qmd § 15).

`bedtools jaccard` for the bases the two share and the bases either covers, and
`bedtools intersect -u` both ways for the intervals of each that touch the other.
Then ITERATIONS times `bedtools shuffle -chrom` of the first set — each interval
moved within its own sequence, its length kept, `-seed` the iteration — and the
same numbers for each shuffle. Writes OUT_PREFIX-observed.tsv and OUT_PREFIX-null.tsv.

usage: python bedtools_overlap.py A_BED B_BED GENOME ITERATIONS OUT_PREFIX
"""
import subprocess
import sys

import pandas as pd

a, b, genome, iterations, out = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]


def bedtools(*argv, given=None):
    return subprocess.run(['bedtools', *argv], input=given, capture_output=True, text=True, check=True).stdout


def measured(first):
    """The numbers for one version of the first set, handed over sorted, as BED text."""
    intersection, union, jaccard, _ = bedtools('jaccard', '-a', 'stdin', '-b', b, given=first).splitlines()[1].split('\t')
    return {'intersection': int(intersection), 'union': int(union), 'jaccard': float(jaccard),
            'a_hit': len(bedtools('intersect', '-u', '-a', 'stdin', '-b', b, given=first).splitlines()),
            'b_hit': len(bedtools('intersect', '-u', '-a', b, '-b', 'stdin', given=first).splitlines())}


observed = bedtools('sort', '-i', a)
pd.DataFrame([measured(observed)]).to_csv(f'{out}-observed.tsv', sep='\t', index=False)
null = [measured(bedtools('sort', '-i', 'stdin', given=bedtools('shuffle', '-chrom', '-seed', str(seed), '-i', a,
                                                                 '-g', genome)))
        for seed in range(1, iterations + 1)]
pd.DataFrame(null).to_csv(f'{out}-null.tsv', sep='\t', index=False)
