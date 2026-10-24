#!/usr/bin/env python
"""Build the `pairtools stats` oracle for the counts the .pairs importer makes (SPECS §3.7).

Run with an interpreter that has pairtools 1.1.2 and h5py installed::

    METACOOLER_PYTHON=.venv-pairtools/bin/python npm run fixtures:pairstats

pairtools 1.1.2 imports the standard library's ``pipes``, which Python 3.13
removed, so it runs under 3.12 or older — the same reason yapc has an
environment of its own (``notebooks/requirements-yapc.txt``)::

    uv venv -p 3.12 .venv-pairtools && uv pip install -p .venv-pairtools pairtools==1.1.2 h5py

Writes ``test/golden/pairs_stats/sample.pairs.gz`` and, beside it,
``sample.stats`` — what ``pairtools stats`` itself writes for that file — which
``test/unit/pairs-stats.test.ts`` holds ``src/pairs/stats.ts`` to, key for key.
Both are committed, so the test runs on every push with nothing to build; this
script is how they were made, and how to make them again.

The fixture
-----------
Contacts drawn from the yeast Micro-C cooler in ``demo/yeast/``, so the
separations are a real library's, with a seeded generator, so the file is the
same every time. Every pair type ``pairtools parse`` and ``dedup`` write is in
it — ``UU`` most, then ``RU``/``UR``, the one-sided ``NU``/``UN``/``MU``/``UM``,
the unmapped ``NN``/``MM``/``NM``, walks ``WW``, ``XX``, and duplicates ``DD`` —
with ``!`` where pairtools writes it; and a few hundred records on a sequence the
header does not declare, which the importer leaves unbinned and pairtools still
counts. gzipped with no timestamp, so the bytes do not change between runs.
"""

from __future__ import annotations

import gzip
import random
import subprocess
import sys
from pathlib import Path

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
COOL = ROOT / "demo" / "yeast" / "Yeast_microC_G2M_1kb.cool"
OUT = ROOT / "test" / "golden" / "pairs_stats"
RECORDS = 30_000
UNDECLARED = 300

TYPES = ["UU"] * 60 + ["RU", "UR", "NU", "UN", "MU", "UM", "NN", "MM", "NM", "WW", "XX"] + ["DD"] * 6


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20261022)
    pick = random.Random(20261022)
    with h5py.File(COOL, "r") as f:
        names = [x.decode() for x in f["chroms/name"][:]]
        lengths = f["chroms/length"][:]
        chrom = f["bins/chrom"][:]
        start = f["bins/start"][:]
        end = f["bins/end"][:]
        b1 = f["pixels/bin1_id"][:]
        b2 = f["pixels/bin2_id"][:]
        count = f["pixels/count"][:].astype(float)
    chosen = rng.choice(len(count), size=RECORDS, p=count / count.sum())
    rows = []
    for i in chosen:
        kind = pick.choice(TYPES)
        c1, c2 = names[chrom[b1[i]]], names[chrom[b2[i]]]
        p1 = int(rng.integers(start[b1[i]], end[b1[i]])) + 1
        p2 = int(rng.integers(start[b2[i]], end[b2[i]])) + 1
        s1, s2 = pick.choice("+-"), pick.choice("+-")
        if kind[0] in "NMXW" and kind != "DD":
            c1, p1, s1 = "!", 0, "-"
        if kind[1] in "NMXW" and kind != "DD":
            c2, p2, s2 = "!", 0, "-"
        rows.append([c1, p1, c2, p2, s1, s2, kind])
    # A sequence the header does not declare: its own diagonal, and against chrI.
    for k in range(UNDECLARED):
        at = int(rng.integers(1, 85_000))
        if k % 3 == 0:
            rows.append(["mito", at, "I", int(rng.integers(1, 230_000)), pick.choice("+-"), pick.choice("+-"), "UU"])
        else:
            rows.append(["mito", at, "mito", at + int(rng.integers(0, 20_000)), pick.choice("+-"), pick.choice("+-"), "UU"])
    order = {name: i for i, name in enumerate(names)}
    order["!"] = -2
    order["mito"] = len(names)
    rows.sort(key=lambda r: (order[r[0]], order[r[2]], r[1], r[3]))

    lines = [
        "## pairs format v1.0",
        "#sorted: chr1-chr2-pos1-pos2",
        "#shape: upper triangle",
        "#genome_assembly: sacCer3-syn",
        *[f"#chromsize: {name} {length}" for name, length in zip(names, lengths)],
        "#columns: readID chrom1 pos1 chrom2 pos2 strand1 strand2 pair_type",
    ]
    lines += [f"r{k}\t" + "\t".join(str(field) for field in row) for k, row in enumerate(rows)]
    fixture = OUT / "sample.pairs.gz"
    with open(fixture, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        gz.write(("\n".join(lines) + "\n").encode())

    subprocess.run(
        [str(Path(sys.executable).with_name("pairtools")), "stats", str(fixture), "-o", str(OUT / "sample.stats")],
        check=True,
    )
    print(f"wrote {fixture} and {OUT / 'sample.stats'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
