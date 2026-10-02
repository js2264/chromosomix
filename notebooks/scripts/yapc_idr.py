"""yapc 0.1's command line, with NumPy's random state seeded (validation.qmd § 5).

yapc breaks score ties at random, through IDR's ranks; the seed makes a run repeatable. Everything
after SEED is yapc's own arguments. Run with yapc's interpreter, its `yapc` on the PATH.

usage: python yapc_idr.py SEED OUTPUT_PREFIX CONDITION REP1.bw REP2.bw [yapc options]
"""
import runpy
import shutil
import sys

import numpy as np

np.random.seed(int(sys.argv[1]))
sys.argv = ['yapc', *sys.argv[2:]]
runpy.run_path(shutil.which('yapc'), run_name='__main__')
