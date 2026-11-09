#!/usr/bin/env python
"""Build the single-cell (`.scool`) test fixtures.

Separate from ``make_fixtures.py`` for one reason: it needs **only** ``cooler``.
That script drives the private ``metacooler`` CLI over a test-data directory
that only a metacooler checkout has, so a contributor without one cannot run it
at all — and none of the scool fixtures need it.  Run either alone::

    python scripts/make_scool_fixtures.py

``npm run fixtures`` runs both.

The same rule as its sibling holds for the file that matters: **the standard
container is written by cooler's own public API**, ``cooler.create_scool``, so a
fixture the viewer is tested against is a file a user could actually produce.
Its shape was checked against cooler's own ``tests/data/scool_test_file.scool``.

``flat.scool`` is the one exception, and it is a deliberate one.  The layout
predates cooler 0.8.11 — cells at the file root, each a complete self-contained
cooler, no ``/cells`` and no shared tables — and **no maintained tool writes it
any more**, so there is no public command to drive.  It is therefore restructured
here from cooler's own output with h5py, which keeps the pixels, the indexes and
the attributes exactly as cooler wrote them and moves only the groups.  The
shape it produces was verified against a real HiCMatrix file (the Nagano 2017
1 Mb scool, 3,882 cells): same root provenance attributes with no ``ncells`` and
no geometry, same per-cell attribute set, same self-contained tables.  It is
still a file users have by the thousand — every `.scool` published before 2021
is one — which is the test the rule exists to apply.

The pixels are written by hand rather than sampled, and they are tiny, because
their whole job is to make the cross-cell sum checkable without a second
implementation: five bins, four cells, and a total that can be read off the
table in ``CELLS`` below.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "test" / "fixtures"

log = logging.getLogger("make_scool_fixtures")

# --------------------------------------------------------------------------
# The data
# --------------------------------------------------------------------------

#: Two chromosomes, 10 bp bins: chr1 -> bins 0,1,2 and chr2 -> bins 3,4.
CHROMSIZES = {"chr1": 30, "chr2": 20}
BINSIZE = 10
NBINS = 5

#: One cell per entry, as ``{(bin1, bin2): count}``.
#:
#: Chosen so that every case a summing reader can get wrong appears once: a
#: pixel two cells share (0,0), a pixel one cell dominates (0,1), a pixel only
#: one cell has (1,2), an off-diagonal trans pixel (3,4), and a diagonal pixel
#: in the last bin (4,4) — the one a mirroring bug counts twice.
#:
#: Summed over all four cells:
#:     (0,0) = 11,  (0,1) = 102,  (1,2) = 7,  (3,4) = 5,  (4,4) = 3
CELLS: dict[str, dict[tuple[int, int], int]] = {
    "cell_a": {(0, 0): 1, (0, 1): 2, (3, 4): 5},
    "cell_b": {(0, 0): 10, (1, 2): 7},
    "cell_c": {(0, 1): 100},
    "cell_d": {(4, 4): 3},
}

#: The sum over every cell, which the reader must reproduce exactly.
EXPECTED_SUM: dict[tuple[int, int], int] = {}
for _pixels in CELLS.values():
    for _key, _value in _pixels.items():
        EXPECTED_SUM[_key] = EXPECTED_SUM.get(_key, 0) + _value


def _binnify():
    """The shared bin table, as `cooler.binnify` would produce it."""
    import pandas as pd

    rows = []
    for name, length in CHROMSIZES.items():
        for start in range(0, length, BINSIZE):
            rows.append((name, start, min(start + BINSIZE, length)))
    return pd.DataFrame(rows, columns=["chrom", "start", "end"])


def _pixels_frame(pixels: dict[tuple[int, int], int]):
    import pandas as pd

    ordered = sorted(pixels)
    return pd.DataFrame(
        {
            "bin1_id": [p[0] for p in ordered],
            "bin2_id": [p[1] for p in ordered],
            "count": [pixels[p] for p in ordered],
        }
    )


# --------------------------------------------------------------------------
# Writers
# --------------------------------------------------------------------------


def write_standard(path: Path, *, weights: bool = False) -> None:
    """The container `cooler.create_scool` writes: `/cells/<name>`, shared tables."""
    import cooler

    bins = _binnify()
    if weights:
        # A shared balancing column, which is the only kind a cell set can be
        # balanced by: one weight per bin of the space every cell indexes.
        # Values are arbitrary but distinct, so a reader that applies the wrong
        # axis' weight produces a different number rather than the same one.
        bins["weight"] = [1.0, 0.5, 2.0, 0.25, 4.0]
    path.unlink(missing_ok=True)
    cooler.create_scool(
        str(path),
        bins,
        {name: _pixels_frame(pixels) for name, pixels in CELLS.items()},
    )
    if weights:
        _share_weight(path, bins["weight"].to_numpy(dtype="float64"))


def _share_weight(path: Path, weight) -> None:
    """Put the balancing column in the shared `/bins`, and in each cell's, where cooler did not.

    cooler up to 0.11 carried every column of the bin table into a `.scool`; 0.12 keeps
    `chrom`, `start` and `end` only. A `.scool` balanced by a shared column is still a file
    readers meet — every one the 0.11 writer made — so the fixture writes the column itself
    rather than depending on which cooler built it.
    """
    import h5py

    with h5py.File(path, "r+") as handle:
        groups = [handle["bins"], *(handle["cells"][name]["bins"] for name in handle["cells"])]
        for group in groups:
            if "weight" not in group:
                group.create_dataset("weight", data=weight, compression="gzip", compression_opts=6)


def write_flat(path: Path, source: Path) -> None:
    """Restructure a standard container into the pre-0.8.11 flat layout.

    Cells become the root's own children and each gets its own copy of the two
    tables, because that is what the writers of the day produced — see the
    module docstring for why this one is not driven by a public command.
    """
    import h5py

    path.unlink(missing_ok=True)
    with h5py.File(source, "r") as src, h5py.File(path, "w") as dst:
        # Provenance only, exactly as HiCMatrix leaves it: no `ncells`, no
        # `bin-size`, no `nbins`. The reader has to find all three inside a
        # cell, and this fixture is what proves it does.
        dst.attrs.update(
            {
                "format": "HDF5::Cooler",
                "format-url": "https://github.com/mirnylab/cooler",
                "generated-by": "make_scool_fixtures.py",
            }
        )
        for name in src["cells"]:
            cell = src["cells"][name]
            group = dst.create_group(name)
            # Copied rather than linked: the flat layout has no shared tables to
            # link to, and a fixture that quietly shared them would not exercise
            # the path that reads a cell's own.
            for member in ("chroms", "bins", "pixels", "indexes"):
                src.copy(cell[member], group, name=member)
            group.attrs.update(cell.attrs)


def verify(path: Path, *, standard: bool) -> dict:
    """Re-read what was written and assert the shape the reader is promised."""
    import h5py

    with h5py.File(path, "r") as h:
        root = dict(h.attrs)
        cells_group = h["cells"] if standard else h
        names = sorted(k for k in cells_group if isinstance(cells_group[k], h5py.Group))
        assert names == sorted(CELLS), f"{path.name}: cells are {names}"
        if standard:
            assert root.get("format") == "HDF5::SCOOL", root.get("format")
            assert int(root["ncells"]) == len(CELLS)
            assert "bins" in h and "chroms" in h
        else:
            assert root.get("format") == "HDF5::Cooler", root.get("format")
            assert "ncells" not in root and "bin-size" not in root
            assert "bins" not in h and "chroms" not in h
        total = 0
        for name in names:
            cell = cells_group[name]
            for member in ("bins", "chroms", "pixels", "indexes"):
                assert member in cell, f"{path.name}/{name} has no {member}"
            assert int(cell.attrs["nbins"]) == NBINS
            total += int(cell["pixels"]["bin1_id"].shape[0])
        return {"cells": names, "stored_pixels": total}


def build(out: Path) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    descriptors: list[dict] = []

    def note(name: str, kind: str, description: str, **extra) -> None:
        path = out / name
        descriptors.append(
            {
                "name": name,
                "kind": kind,
                "expect": "accept",
                "description": description,
                "bytes": path.stat().st_size,
                **extra,
            }
        )

    standard = out / "cells.scool"
    write_standard(standard)
    note(
        "cells.scool",
        "scool",
        "cooler.create_scool output: /cells/<name>, shared /chroms and /bins, raw counts",
        cell_group="cells",
        **verify(standard, standard=True),
    )

    balanced = out / "balanced.scool"
    write_standard(balanced, weights=True)
    note(
        "balanced.scool",
        "scool",
        "the same container with a shared /bins/weight — the only column a cell set may be balanced by",
        cell_group="cells",
        **verify(balanced, standard=True),
    )

    flat = out / "flat.scool"
    write_flat(flat, standard)
    note(
        "flat.scool",
        "scool",
        "the pre-0.8.11 layout HiCMatrix and scHiCExplorer write: cells at the root, no shared tables",
        cell_group="",
        **verify(flat, standard=False),
    )

    return descriptors


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

    descriptors = build(args.out)

    import cooler

    manifest = {
        "generator": "scripts/make_scool_fixtures.py",
        "cooler_version": cooler.__version__,
        "binsize": BINSIZE,
        "nbins": NBINS,
        "chromsizes": CHROMSIZES,
        "cells": {name: {f"{a},{b}": v for (a, b), v in px.items()} for name, px in CELLS.items()},
        "expected_sum": {f"{a},{b}": v for (a, b), v in sorted(EXPECTED_SUM.items())},
        "fixtures": descriptors,
    }
    target = args.out / "_scool.json"
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    for d in descriptors:
        log.info("  %-20s %8d B  %s", d["name"], d["bytes"], d["description"])
    log.info("wrote %s", target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
