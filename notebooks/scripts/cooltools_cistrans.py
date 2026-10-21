"""Contacts within each sequence and between every pair with cooltools (validation.qmd § 20).

Within a sequence, `expected_cis` summed over every one of its diagonals, the main one included
(`ignore_diags=0`); between two, `expected_trans`. Raw counts, or balanced by the weight column
named. One row per pair of sequences, each sequence with itself among them: its two names and the
contacts.

usage: python cooltools_cistrans.py MAP_URI OUT_TSV NPROC [WEIGHT]
"""
import sys

import cooler
import cooltools
import pandas as pd

uri, out, nproc = sys.argv[1], sys.argv[2], int(sys.argv[3])
weight = sys.argv[4] if len(sys.argv) > 4 else None
column = 'count.sum' if weight is None else 'balanced.sum'
clr = cooler.Cooler(uri)
cis = cooltools.expected_cis(clr, ignore_diags=0, smooth=False, aggregate_smoothed=False, clr_weight_name=weight,
                             nproc=nproc)
within = cis.groupby(['region1', 'region2'], observed=True, sort=False)[column].sum().reset_index()
between = cooltools.expected_trans(clr, clr_weight_name=weight, nproc=nproc)[['region1', 'region2', column]]
table = pd.concat([within, between], ignore_index=True).rename(columns={column: 'contacts'})
table.to_csv(out, sep='\t', index=False)
