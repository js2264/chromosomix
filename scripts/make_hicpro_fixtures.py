#!/usr/bin/env python
"""Build the HiC-Pro test fixtures, with a cooler as their oracle.

Run it alone — like ``make_scool_fixtures.py`` it needs only ``cooler``::

    python scripts/make_hicpro_fixtures.py

``npm run fixtures`` runs it too.

**The fixture is written from a cooler, and that is the whole design.** HiC-Pro
itself cannot be driven here: it is a pipeline that starts at FASTQ, needs
bowtie2 and a reference genome, and takes hours to produce two text files whose
*format* is four lines of documentation.  So instead a small cooler is built
with ``cooler.create_cooler`` — a public API, deterministic, and already this
repo's reference for what a contact map means — and is then written out in
HiC-Pro's two-file form.

That inverts the usual fixture argument in a way worth stating, because it makes
the test *stronger* rather than weaker.  The question a HiC-Pro reader has to
answer is "does this pair of text files mean the same matrix as the cooler it
came from", and here the cooler is right there to be compared against.  The
manifest therefore carries the dense matrix as cooler computed it, and the JS
suite reads the text pair and asserts it lands on exactly those numbers — a
round trip through the format, checked against the implementation this whole
application is a port of.

What that does not check is HiC-Pro's own conventions, and those are taken from
its ``RESULTS.md``: 1-based global bin ids, ``chrom start end binID`` in the
BED, ``binA binB count`` in the matrix, and a ``MATRIX_FORMAT`` that may store
the ``upper`` triangle (the default), the ``lower`` one, the ``complete``
matrix, or the contacts ``asis``.  All four are written here, because all four
must land on the same picture and only one of them is the common case — which
is exactly how the other three come to be broken without anyone noticing.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "test" / "fixtures"

log = logging.getLogger("make_hicpro_fixtures")

#: Two sequences at 100 bp, both ending in a short bin — which every real
#: genome does, and which a naive fixed-grid check refuses.
CHROMSIZES = {"chr1": 250, "chr2": 120}
BINSIZE = 100

#: Deterministic pixels, as ``{(bin1, bin2): count}`` over the 5-bin grid.
#:
#: Chosen to put one of everything in reach of a hand check: the diagonal, a
#: neighbour, a cis pixel two bins out, a trans pixel, and the last bin against
#: itself — the one a mirroring bug counts twice.
PIXELS = {(0, 0): 10, (0, 1): 5, (1, 2): 7, (2, 2): 2, (3, 4): 9, (0, 4): 3}


def build_cooler(path: Path):
    import cooler
    import pandas as pd

    rows = []
    for name, length in CHROMSIZES.items():
        for start in range(0, length, BINSIZE):
            rows.append((name, start, min(start + BINSIZE, length)))
    bins = pd.DataFrame(rows, columns=["chrom", "start", "end"])
    ordered = sorted(PIXELS)
    pixels = pd.DataFrame(
        {
            "bin1_id": [p[0] for p in ordered],
            "bin2_id": [p[1] for p in ordered],
            "count": [PIXELS[p] for p in ordered],
        }
    )
    path.unlink(missing_ok=True)
    cooler.create_cooler(str(path), bins, pixels)
    return cooler.Cooler(str(path))


def write_pair(out: Path, stem: str, clr, fmt: str) -> tuple[Path, Path]:
    """Write one `MATRIX_FORMAT` variant of the pair, from the cooler."""
    bins = clr.bins()[:]
    bed = out / f"{stem}_{BINSIZE}_abs.bed"
    with open(bed, "w") as f:
        for i, row in enumerate(bins.itertuples(), start=1):
            # 1-based, global, and continuous across sequences — the id column
            # is the row number, which is what makes the matrix addressable.
            f.write(f"{row.chrom}\t{row.start}\t{row.end}\t{i}\n")

    suffix = "" if fmt == "upper" else f"_{fmt}"
    matrix = out / f"{stem}_{BINSIZE}{suffix}.matrix"
    triplets = clr.pixels()[:]
    lines: list[str] = []
    for row in triplets.itertuples():
        a, b, v = row.bin1_id + 1, row.bin2_id + 1, row.count
        if fmt == "upper":
            lines.append(f"{a}\t{b}\t{v}")
        elif fmt == "lower":
            lines.append(f"{b}\t{a}\t{v}")
        elif fmt == "complete":
            lines.append(f"{a}\t{b}\t{v}")
            if a != b:
                lines.append(f"{b}\t{a}\t{v}")
        elif fmt == "asis":
            # As observed: unsorted, and either way round.
            lines.append(f"{b}\t{a}\t{v}" if (a + b) % 2 else f"{a}\t{b}\t{v}")
    if fmt == "asis":
        # Shuffled deterministically, since "as observed" is not sorted and a
        # reader that assumed it was would pass every other variant. A seeded
        # `sample` rather than a hand-rolled rotation, because it is a genuine
        # permutation — the first attempt here dropped one pixel and repeated
        # another, and the fixture looked entirely plausible either way.
        import random

        lines = random.Random(0).sample(lines, len(lines))
    with open(matrix, "w") as f:
        f.write("\n".join(lines) + "\n")
    return bed, matrix


def dense(clr) -> list[list[float]]:
    """The matrix as cooler computes it — the oracle the JS suite compares to."""
    return [[float(v) for v in row] for row in clr.matrix(balance=False)[:, :]]


def build(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    import cooler  # noqa: F401  (imported for the version in the manifest)

    stem = "hicpro"
    clr = build_cooler(out / f"{stem}_oracle.cool")
    written = []
    for fmt in ("upper", "lower", "complete", "asis"):
        bed, matrix = write_pair(out, stem, clr, fmt)
        written.append(
            {
                "format": fmt,
                "matrix": matrix.name,
                "bins": bed.name,
                "matrix_bytes": matrix.stat().st_size,
            }
        )
        log.info("  %-28s %6d B  MATRIX_FORMAT=%s", matrix.name, matrix.stat().st_size, fmt)

    # A fragment-level pair: intervals of differing widths, which §3.3 excludes
    # from the whole application and which this reader must refuse by name.
    frag = out / f"{stem}_frag_abs.bed"
    edges = [0, 137, 402, 530]
    with open(frag, "w") as f:
        for i, (a, b) in enumerate(zip(edges, edges[1:]), start=1):
            f.write(f"chr1\t{a}\t{b}\t{i}\n")
    with open(out / f"{stem}_frag.matrix", "w") as f:
        f.write("1\t1\t5\n1\t2\t3\n")
    log.info("  %-28s %6d B  variable bins, must be refused", frag.name, frag.stat().st_size)

    return {
        "generator": "scripts/make_hicpro_fixtures.py",
        "cooler_version": cooler.__version__,
        "binsize": BINSIZE,
        "chromsizes": CHROMSIZES,
        "nbins": sum(-(-l // BINSIZE) for l in CHROMSIZES.values()),
        "pixels": {f"{a},{b}": v for (a, b), v in sorted(PIXELS.items())},
        # The oracle: cooler's own dense matrix over the whole grid.
        "dense": dense(clr),
        "variants": written,
        "fragment": {"matrix": f"{stem}_frag.matrix", "bins": frag.name},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )
    manifest = build(args.out)
    target = args.out / "_hicpro.json"
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log.info("wrote %s", target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
