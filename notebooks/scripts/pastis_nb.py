"""A pastis-NB structure with pastis' own functions, from one MDS seed (validation.qmd § 8).

The beads are the bins with a balancing weight and a contact, as metacooler-run models them; the
biases are the inverse weights. Writes the coordinates, one row per bead, as a .npy.

usage: python pastis_nb.py MAP_URI OUT_NPY SEED
"""
import sys

import cooler
import numpy as np
import pandas as pd
from pastis import dispersion
from pastis.optimization import mds, negative_binomial_structure as nbs

uri, out, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
clr = cooler.Cooler(uri)
raw = clr.matrix(balance=False)[:].astype(float)
w = clr.bins()['weight'][:].to_numpy(float)
keep = np.isfinite(w) & (raw.sum(axis=0) > 0)
chroms = clr.bins()['chrom'][:].to_numpy()[keep]
lengths = np.array([np.sum(chroms == c) for c in pd.unique(chroms)])
counts, bias = raw[np.ix_(keep, keep)], 1 / w[keep]
bias /= bias.mean()
_, mean, variance, weights = dispersion.compute_mean_variance(counts, lengths, bias=bias)
fitted = dispersion.ExponentialDispersion(degree=1)
fitted.fit(mean, variance, sample_weights=weights ** 0.5)
start = mds.estimate_X(counts / np.outer(bias, bias), alpha=-3., beta=1.,
                       random_state=np.random.RandomState(seed))
model = nbs.estimate_X(counts, alpha=-3., beta=1., ini=start.flatten(),
                       dispersion=fitted, bias=bias, lengths=lengths,
                       use_zero_entries=True,
                       random_state=np.random.RandomState(seed))
np.save(out, model.reshape(-1, 3))
