"""Which of cooltools' diagonals a P(s) point of chromosomix's pools (validation.qmd § 4, and the laptop's
deep human map).

chromosomix writes P(s) one point per band of consecutive diagonals, at the band's mean separation
weighted by its valid bin pairs; cooltools.expected_cis writes every diagonal. `bands` finds the run of
diagonals behind each point, so cooltools' sums can be pooled over the same run and the two compared.
"""
import numpy as np


def bands(n_valid, separations, binsize, first):
    """The run of consecutive diagonals behind each separation the app wrote: from `first`, then from
    where the last ended, the longest run whose valid-pixel-weighted mean matches it to its six written
    digits."""
    k = np.arange(len(n_valid), dtype=float)
    cn = np.concatenate([[0.0], np.cumsum(n_valid)])
    ck = np.concatenate([[0.0], np.cumsum(n_valid * k)])
    runs, lo = [], first
    for x in separations:
        tolerance = max(0.5, abs(x) * 5e-6)
        match = None
        for hi in range(lo + 1, len(n_valid) + 1):
            w = cn[hi] - cn[lo]
            if w <= 0:
                continue
            mean = (ck[hi] - ck[lo]) / w * binsize
            if abs(mean - x) <= tolerance:
                match = hi
            elif mean > x + tolerance:
                break
        if match is None:
            raise ValueError(f'no run of diagonals from {lo} has its mean at {x}')
        runs.append((lo, match))
        lo = match
    return runs


def kept_from(path):
    """The first diagonal the app kept: its minimum separation, as the table's header records it, and
    never the diagonal itself, which the expected leaves out whatever it says."""
    for line in open(path):
        if line.startswith('# param minSeparation:'):
            return max(1, int(float(line.split(':', 1)[1])))
    raise ValueError(f'{path} does not say its minimum separation')
