#!/usr/bin/env python
"""Oracles for the published demo maps, from the public ``cooler`` package alone.

Why this exists
---------------
The goldens in ``test/golden/`` are built over fixtures that ``make_fixtures.py``
writes with the metacooler CLI, and metacooler is not on PyPI: a runner without
access to its repository builds none of them, and the reader suites that compare
against them never run there. This script is the half of that comparison that
needs nothing private. Its inputs are the maps the app itself publishes on the
lab's bucket (``rsglab-data``, ``demo/``) — a ``.metacool`` and an ``.mmetacool``
that metacooler really wrote, a yeast ``.cool`` and an E. coli ``.mcool`` — and
its oracle is ``cooler``, which opens every one of them: a ``.metacool`` is a
cooler by construction (metacooler's own central invariant), and an entry of an
``.mmetacool`` or a resolution of an ``.mcool`` is a cooler group.

What it does not use is metacooler's Python API. The two metagenome tables are
read as stored, through ``h5py`` — ``/genomes`` and ``/indexes/genome_offset`` —
which is exactly what the JS reader reads, so what is compared is the reader's
arithmetic over them rather than a second implementation of the format.

What is recorded, per map
-------------------------
- ``binsize``, ``shape`` and ``nnz``, as cooler reports them;
- the sequence table as a count, a SHA-256 over ``name<TAB>length<LF>`` lines
  and its first and last rows — a metagenome has twenty thousand contigs and a
  golden that spelled them out would be half a megabyte of names;
- for a metagenome, every genome's name and bin extent;
- a handful of **windows** — small dense blocks, raw counts and, where the file
  carries weights, balanced — chosen to cross the places a reader goes wrong: the
  diagonal, an off-diagonal block inside one sequence, a block straddling the
  boundary between two sequences, a block between two sequences in each
  orientation (the transpose path), and for a metagenome a block between two
  genomes. Counts are compared exactly; balanced values to a relative 1e-6,
  since the reader multiplies in Float32 what cooler multiplies in Float64.

The files themselves are not committed here: ``npm run fixtures:demo``
(``scripts/fetch-demo-maps.mjs``) puts them in ``test/fixtures/demo/``, from the
bucket or from an identical copy already under ``demo/``, and
``test/unit/demo-maps.test.ts`` skips by name for any that is absent.

Usage::

    pip install cooler
    python scripts/make_demo_golden.py              # read the maps under demo/
    python scripts/make_demo_golden.py --maps test/fixtures/demo
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "test" / "golden" / "demo"
BUCKET = "https://rsglab-data.s3.eu-west-3.amazonaws.com/"

#: The published maps, by their path on the bucket — which is also their path
#: under ``demo/`` in this repository. ``groups`` names what inside a container
#: is opened: every entry of an ``.mmetacool``, two rungs of an ``.mcool``.
MAPS: list[dict] = [
    {
        "path": "demo/metagenomics/mock-community/Mock_microbial_community.metacool",
        "groups": [""],
    },
    {
        "path": "demo/metagenomics/mock-community/Mock_microbial_community.mmetacool",
        "groups": ["entries/1000", "entries/2000", "entries/4000"],
    },
    {"path": "demo/yeast/Yeast_microC_G2M_1kb.cool", "groups": [""]},
    {"path": "demo/ecoli/Ecoli.mcool", "groups": ["resolutions/5000", "resolutions/1000"]},
]

#: Side of a window, in bins. Small on purpose: what a window proves is where the
#: reader puts each cell, and sixty-four bins a side crosses every seam it is
#: placed on while keeping a golden of nine maps under a megabyte.
SIDE = 64


def md5_of(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def chrom_table(c) -> dict:
    """The sequence table as a count, a hash and its two ends."""
    names = list(c.chromnames)
    sizes = [int(s) for s in c.chromsizes]
    digest = hashlib.sha256()
    for name, size in zip(names, sizes):
        digest.update(f"{name}\t{size}\n".encode("utf-8"))
    rows = [[n, s] for n, s in zip(names, sizes)]
    return {
        "count": len(names),
        "sha256": digest.hexdigest(),
        "head": rows[:5],
        "tail": rows[-5:],
    }


def genome_table(path: Path, group: str, chrom_offset: list[int]) -> list[dict] | None:
    """Every genome's name and bin extent, as stored — or ``None`` for a cooler.

    ``/indexes/genome_offset`` indexes the contig table: genome ``g`` owns contigs
    ``[genome_offset[g], genome_offset[g + 1])``, which ``genome-then-length``
    makes contiguous, so its bins are one run from the first contig's first bin
    to the last contig's end.
    """
    import h5py

    with h5py.File(path, "r") as fh:
        root = fh[group] if group else fh
        if "genomes" not in root:
            return None
        names = [
            n.decode("utf-8") if isinstance(n, bytes) else str(n)
            for n in root["genomes"]["name"][()]
        ]
        offsets = [int(o) for o in root["indexes"]["genome_offset"][()]]
    out = []
    for g, name in enumerate(names):
        first, last = offsets[g], offsets[g + 1]
        out.append({"name": name, "extent": [chrom_offset[first], chrom_offset[last]]})
    return out


def around(centre: int, lo: int, hi: int) -> list[int]:
    """``SIDE`` bins about *centre*, slid to stay inside ``[lo, hi)``."""
    start = max(lo, min(centre - SIDE // 2, hi - SIDE))
    return [start, min(hi, start + SIDE)]


def strongest(c, owner) -> tuple[int, int] | None:
    """The bin pair with the most contacts between two different owners.

    *owner* maps a bin to whatever it belongs to — its sequence, or its genome
    with ``-1`` for a bin that should not count. A block placed blindly between
    two sequences of a metagenome is empty, and an empty block proves nothing
    about where a reader puts a cell: it is the same picture transposed or not.
    Centring the window on the strongest pixel between two owners is what gives
    it something to get wrong.
    """
    import numpy as np

    pixels = c.pixels()[:]
    bin1 = pixels["bin1_id"].to_numpy()
    bin2 = pixels["bin2_id"].to_numpy()
    counts = pixels["count"].to_numpy()
    o1, o2 = owner(bin1), owner(bin2)
    keep = (o1 != o2) & (o1 >= 0) & (o2 >= 0)
    if not keep.any():
        return None
    best = int(np.argmax(np.where(keep, counts, -1)))
    return int(bin1[best]), int(bin2[best])


def windows(c, genomes: list[dict] | None) -> list[dict]:
    """The blocks a reader is checked on: each placed across one seam."""
    import numpy as np

    offsets = [int(o) for o in c._load_dset("indexes/chrom_offset")]
    nchroms = len(offsets) - 1
    # The longest sequence, so a window inside it has room on both sides.
    longest = max(range(nchroms), key=lambda i: offsets[i + 1] - offsets[i])
    lo, hi = offsets[longest], offsets[longest + 1]

    def clamp(start: int, end: int) -> list[int]:
        return [max(0, start), min(int(c.shape[0]), end)]

    out: list[dict] = []
    out.append({"id": "diagonal", "rows": clamp(lo, lo + SIDE), "cols": clamp(lo, lo + SIDE)})
    if hi - lo >= 3 * SIDE:
        out.append(
            {
                "id": "within-sequence",
                "rows": clamp(lo, lo + SIDE),
                "cols": clamp(lo + 2 * SIDE, lo + 3 * SIDE),
            }
        )
    if nchroms < 2:
        return out

    seam = offsets[1]
    half = SIDE // 2
    out.append({"id": "seam", "rows": clamp(seam - half, seam + half), "cols": clamp(seam - half, seam + half)})

    edges = np.asarray(offsets)

    def sequence_of(bins):
        return np.searchsorted(edges, bins, side="right") - 1

    def span(bin_id: int) -> tuple[int, int]:
        i = int(sequence_of(np.asarray([bin_id]))[0])
        return offsets[i], offsets[i + 1]

    pair = strongest(c, sequence_of)
    if pair is not None:
        # Stored pixels are upper-triangular, so `a` lies in an earlier sequence
        # than `b`: rows from `a` read the stored block directly, rows from `b`
        # are the reader's transpose path.
        a, b = around(pair[0], *span(pair[0])), around(pair[1], *span(pair[1]))
        out.append({"id": "between-sequences", "rows": a, "cols": b})
        out.append({"id": "between-sequences-transposed", "rows": b, "cols": a})

    # Two genomes the reader would show: `__unbinned__` is a bin range like any
    # other to the matrix, but the block the app draws is between two real ones.
    shown = [g for g in genomes or [] if g["name"] != "__unbinned__" and g["extent"][1] > g["extent"][0]]
    if len(shown) >= 2:
        starts = np.asarray([g["extent"][0] for g in shown])
        ends = np.asarray([g["extent"][1] for g in shown])

        def genome_of(bins):
            index = np.searchsorted(starts, bins, side="right") - 1
            inside = (index >= 0) & (bins < ends[np.clip(index, 0, len(ends) - 1)])
            return np.where(inside, index, -1)

        pair = strongest(c, genome_of)
        if pair is not None:
            # The window stays inside the sequence the strongest pixel is in, as
            # the other windows do, so a seam is never crossed by accident here.
            out.append(
                {
                    "id": "between-genomes",
                    "rows": around(pair[0], *span(pair[0])),
                    "cols": around(pair[1], *span(pair[1])),
                }
            )
    return out


def dense(c, rows: list[int], cols: list[int], balance: bool) -> list[list[float | int | None]]:
    """One block as nested lists, ``NaN`` as ``null`` because JSON has no NaN."""
    block = c.matrix(balance=balance, sparse=False)[rows[0] : rows[1], cols[0] : cols[1]]
    if not balance:
        return [[int(v) for v in row] for row in block]
    # Nine significant digits: three more than the comparison's 1e-6 needs, and
    # half the bytes of a full repr.
    return [[None if math.isnan(v) else float(f"{v:.9g}") for v in row] for row in block]


def describe(path: Path, group: str) -> dict:
    import cooler

    uri = f"{path}::{group}" if group else str(path)
    c = cooler.Cooler(uri)
    offsets = [int(o) for o in c._load_dset("indexes/chrom_offset")]
    genomes = genome_table(path, group, offsets)
    weighted = "weight" in c.bins().columns
    blocks = []
    for window in windows(c, genomes):
        blocks.append({**window, "balance": False, "values": dense(c, window["rows"], window["cols"], False)})
        if weighted:
            blocks.append({**window, "balance": True, "values": dense(c, window["rows"], window["cols"], True)})
    return {
        "group": group,
        "binsize": int(c.binsize),
        "shape": [int(c.shape[0]), int(c.shape[1])],
        "nnz": int(c.info["nnz"]),
        "weights": weighted,
        "chroms": chrom_table(c),
        "genomes": genomes,
        "windows": blocks,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--maps",
        type=Path,
        default=None,
        help="directory holding the maps by basename (default: their paths under demo/)",
    )
    args = parser.parse_args(argv)

    import cooler

    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "generator": "scripts/make_demo_golden.py",
        "cooler_version": cooler.__version__,
        "bucket": BUCKET,
        "maps": [],
    }
    for entry in MAPS:
        rel = Path(entry["path"])
        path = args.maps / rel.name if args.maps is not None else REPO / rel
        if not path.exists():
            raise SystemExit(f"{path} is missing: run `npm run fixtures:demo` first, or pass --maps")
        golden = {
            "file": rel.name,
            "path": entry["path"],
            "url": BUCKET + entry["path"],
            "bytes": path.stat().st_size,
            "md5": md5_of(path),
            "maps": [describe(path, group) for group in entry["groups"]],
        }
        name = rel.name.replace(".", "_") + ".json"
        (OUT / name).write_text(json.dumps(golden, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        manifest["maps"].append(
            {
                "file": rel.name,
                "path": entry["path"],
                "url": golden["url"],
                "bytes": golden["bytes"],
                "md5": golden["md5"],
                "golden": name,
            }
        )
        print(f"  {rel.name:<42} {len(golden['maps'])} map(s)  {golden['bytes']:>10} B", file=sys.stderr)
    (OUT / "_manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
